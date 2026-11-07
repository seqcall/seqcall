import type { LanguageAdapter } from './adapter';
import { createPhpAdapter } from './php/php-adapter';
import { createCSharpAdapter, type CSharpAdapterOptions } from './rpc/csharp';
import { createTsAdapter } from './ts/ts-adapter';

/** Analysis language of a project: one adapter kind per language. */
export type ProjectLanguage = 'typescript' | 'csharp' | 'php';

const CS_EXT = /\.cs$/i;
const PHP_EXT = /\.php$/i;
const TS_EXT = /\.(?:[cm]?[jt]sx?)$/i;

/** Language of a source file by extension (JS/TS for anything that is not C# or PHP). */
export function languageOfFile(file: string): ProjectLanguage {
  if (CS_EXT.test(file)) return 'csharp';
  if (PHP_EXT.test(file)) return 'php';
  return 'typescript';
}

/** Files the analysis understands (not dependencies, build output or declaration files). */
export function isAnalysedFile(file: string): boolean {
  const key = file.replace(/\\/g, '/');
  if (CS_EXT.test(file)) return !/\/(?:bin|obj)\//i.test(key);
  if (PHP_EXT.test(file)) return !/\/vendor\//.test(key) && !/\.blade\.php$/i.test(file) && !/\/(?:_ide_helper[^/]*|\.phpstorm\.meta)\.php$/i.test(key);
  return TS_EXT.test(file) && !/\/node_modules\//.test(key) && !/\.d\.[cm]?ts$/i.test(file);
}

/** Project markers per language, nearest first (the hosts walk up from the file). */
export const PROJECT_MARKERS: Record<ProjectLanguage, RegExp[]> = {
  typescript: [/^(tsconfig|jsconfig)\.json$/],
  csharp: [/\.slnx?$/i, /\.csproj$/i],
  php: [/^composer\.json$/],
};

export interface AdapterOptions {
  csharp?: CSharpAdapterOptions;
}

/** The single place that maps a language to its adapter (hosts call this, never the factories). */
export function createAdapter(language: ProjectLanguage, root: string, opts: AdapterOptions = {}): LanguageAdapter {
  switch (language) {
    case 'csharp':
      return createCSharpAdapter(root, opts.csharp);
    case 'php':
      return createPhpAdapter(root);
    default:
      return createTsAdapter(root);
  }
}

/**
 * FR-18.9 a PHP file inside a Composer dependency (`<project>/vendor/acme/pkg/src/X.php`) belongs to the
 * project that installed it — its callers, entry points and the other packages are there; the package's
 * own composer.json is not a project root. The project directory (with forward slashes), or undefined
 * when the file is not under a `vendor/` folder of a Composer project.
 */
export function composerOwnerRoot(file: string, hasComposerJson: (dir: string) => boolean): string | undefined {
  const key = file.replace(/\\/g, '/');
  const i = key.indexOf('/vendor/');
  if (i <= 0) return undefined;
  const dir = key.slice(0, i);
  return hasComposerJson(dir) ? dir : undefined;
}

