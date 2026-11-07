import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { isInNodeModules, isUnder, normalizePath, SOURCE_FILE_RE } from './paths';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.vscode-test']);

export interface ProjectConfig {
  options: ts.CompilerOptions;
  fileNames: string[];
  /** The tsconfig/jsconfig used, if any. */
  configFile?: string;
}

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  experimentalDecorators: true,
  skipLibCheck: true,
  noEmit: true,
};

/** tsconfig.json → jsconfig.json → all JS/TS sources under the root (allowJs). */
export function discoverProject(projectRoot: string): ProjectConfig {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const configFile = path.join(projectRoot, name);
    if (!fs.existsSync(configFile)) continue;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configFile,
      name === 'jsconfig.json' ? { allowJs: true } : {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    if (parsed && parsed.fileNames.length > 0) {
      return {
        options: { ...parsed.options, noEmit: true },
        fileNames: parsed.fileNames.map(normalizePath),
        configFile: normalizePath(configFile),
      };
    }
  }
  return { options: { ...FALLBACK_OPTIONS }, fileNames: scanSources(projectRoot) };
}

function scanSources(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) scanSources(path.join(dir, e.name), out);
    } else if (SOURCE_FILE_RE.test(e.name)) {
      out.push(normalizePath(path.join(dir, e.name)));
    }
  }
  return out;
}

/**
 * JSDoc is parsed only where it gives types (JavaScript files): the analysis never reads doc comments, and parsing
 * them in TS files and the libraries' `.d.ts` is a noticeable share of a project load. Host and registry must agree.
 */
export const JSDOC_PARSING = ts.JSDocParsingMode.ParseForTypeInfo;

/** Versioned in-memory LanguageServiceHost supporting incremental updates. */
export class ProjectHost implements ts.LanguageServiceHost {
  private readonly files = new Set<string>();
  private readonly versions = new Map<string, number>();
  private readonly overrides = new Map<string, string>();
  /** Per file until its next update (updateFile drops it with the version change). */
  private readonly snapshots = new Map<string, ts.IScriptSnapshot>();
  private projectVersion = 0;
  /**
   * fileExists / directoryExists answers while a program is built (module resolution asks the same paths again and
   * again); cleared with every update, as the program is rebuilt only then.
   */
  private readonly exists = new Map<string, boolean>();
  /** (the document registry gets the same: ts-adapter) */
  readonly jsDocParsingMode = JSDOC_PARSING;

  constructor(
    private readonly projectRoot: string,
    private readonly config: ProjectConfig,
  ) {
    for (const f of config.fileNames) this.files.add(f);
  }

  /** Content given → in-memory override; no content → re-read from disk (removed if deleted). */
  updateFile(file: string, content?: string): void {
    const f = normalizePath(file);
    if (content !== undefined) {
      this.overrides.set(f, content);
      if (this.accepts(f)) this.files.add(f);
    } else {
      this.overrides.delete(f);
      if (fs.existsSync(f)) {
        if (this.accepts(f)) this.files.add(f);
      } else {
        this.files.delete(f);
      }
    }
    this.versions.set(f, (this.versions.get(f) ?? 0) + 1);
    this.snapshots.delete(f);
    this.projectVersion++;
    this.exists.clear();
  }

  private accepts(f: string): boolean {
    if (!SOURCE_FILE_RE.test(f) || isInNodeModules(f) || !isUnder(this.projectRoot, f)) return false;
    if (/\.[cm]?jsx?$/.test(f) && !this.config.options.allowJs) return false;
    return true;
  }

  getProjectVersion(): string {
    return String(this.projectVersion);
  }
  getCompilationSettings(): ts.CompilerOptions {
    return this.config.options;
  }
  getScriptFileNames(): string[] {
    return [...this.files];
  }
  getScriptVersion(fileName: string): string {
    return String(this.versions.get(normalizePath(fileName)) ?? 0);
  }
  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    const f = normalizePath(fileName);
    const cached = this.snapshots.get(f);
    if (cached) return cached;
    const text = this.overrides.get(f) ?? ts.sys.readFile(f);
    if (text === undefined) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(text);
    this.snapshots.set(f, snapshot);
    return snapshot;
  }
  getCurrentDirectory(): string {
    return this.projectRoot;
  }
  getDefaultLibFileName(options: ts.CompilerOptions): string {
    const own = ts.getDefaultLibFilePath(options);
    if (ts.sys.fileExists(own)) return own;
    // a bundle without the lib files beside it (a probe script built to /tmp): the project's TypeScript, else nothing
    // resolves `Promise`, `Pick<…>`, `setInterval` … and calls through them stay unknown
    const project = `${this.projectRoot}/node_modules/typescript/lib/${own.split(/[\\/]/).pop()}`;
    return ts.sys.fileExists(project) ? project : own;
  }
  fileExists(fileName: string): boolean {
    if (this.overrides.size && this.overrides.has(normalizePath(fileName))) return true;
    return this.cachedExists(`f${fileName}`, () => ts.sys.fileExists(fileName));
  }
  readFile(fileName: string): string | undefined {
    return (this.overrides.size ? this.overrides.get(normalizePath(fileName)) : undefined) ?? ts.sys.readFile(fileName);
  }
  readDirectory = ts.sys.readDirectory;
  directoryExists(directoryName: string): boolean {
    return this.cachedExists(`d${directoryName}`, () => ts.sys.directoryExists(directoryName));
  }
  private cachedExists(key: string, ask: () => boolean): boolean {
    let known = this.exists.get(key);
    if (known === undefined) this.exists.set(key, (known = ask()));
    return known;
  }
  getDirectories = ts.sys.getDirectories;
  realpath = ts.sys.realpath;
  useCaseSensitiveFileNames(): boolean {
    return ts.sys.useCaseSensitiveFileNames;
  }
}
