import * as fs from 'node:fs';
import * as path from 'node:path';
import { composerOwnerRoot, isAnalysedFile, languageOfFile, trimEndChar, type ProjectLanguage } from '@seqcall/core';

/**
 * Project location without an editor API (same rules as packages/vscode/src/paths.ts, with the
 * IDE's project directory in place of the VS Code workspace folder).
 */
export type { ProjectLanguage };

export interface ProjectLocation {
  root: string;
  language: ProjectLanguage;
}

/** Normalised form for comparisons (case-insensitive drive letter, forward slashes). */
export function pathKey(file: string): string {
  const p = file.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

/** True when `file` is `dir` or lies inside it (both protocol paths). */
export function isInside(file: string, dir: string): boolean {
  const f = pathKey(file);
  const d = trimEndChar(pathKey(dir), '/');
  return f === d || f.startsWith(d + '/');
}

export function languageOf(file: string): ProjectLanguage {
  return languageOfFile(file);
}

/** Files the analysis understands (JS/TS outside node_modules and .d.ts, C# outside bin/obj, PHP outside vendor). */
export function isSourceFile(file: string): boolean {
  return isAnalysedFile(pathKey(file));
}

function nearestDir(file: string, test: (dir: string) => boolean, limit?: string): string | undefined {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (test(dir)) return dir;
    if (limit && pathKey(dir) === pathKey(limit)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const hasFile = (markers: string[]) => (dir: string) => markers.some((m) => fs.existsSync(path.join(dir, m)));
const hasEntry = (re: RegExp) => (dir: string): boolean => {
  try {
    return fs.readdirSync(dir).some((n) => re.test(n));
  } catch {
    return false;
  }
};

/** `workspace`: the IDE's project directory when the file lies inside it. */
export function locateProject(file: string, workspace?: string): ProjectLocation {
  const stop = workspace && isInside(file, workspace) ? path.resolve(workspace) : undefined;
  const fallback = path.dirname(path.resolve(file));
  const norm = (d: string) => d.replace(/\\/g, '/');
  if (languageOf(file) === 'php') {
    // a file of a Composer dependency: the project that installed it, not the package (FR-18.9)
    const root = composerOwnerRoot(path.resolve(file), hasFile(['composer.json'])) ?? nearestDir(file, hasFile(['composer.json'])) ?? stop ?? fallback;
    return { root: norm(root), language: 'php' };
  }
  if (languageOf(file) === 'csharp') {
    const root = nearestDir(file, hasEntry(/\.slnx?$/i)) ?? nearestDir(file, hasEntry(/\.csproj$/i)) ?? stop ?? fallback;
    return { root: norm(root), language: 'csharp' };
  }
  const root =
    nearestDir(file, hasFile(['tsconfig.json', 'jsconfig.json']), stop) ?? stop ?? nearestDir(file, hasFile(['package.json'])) ?? fallback;
  return { root: norm(root), language: 'typescript' };
}

/** FR-16: the project of a workspace directory itself (C# when it holds a solution / project). */
export function locateWorkspace(dir: string): ProjectLocation {
  const root = path.resolve(dir).replace(/\\/g, '/');
  if (hasEntry(/\.slnx?$/i)(root) || hasEntry(/\.csproj$/i)(root)) return { root, language: 'csharp' };
  if (hasFile(['composer.json'])(root) && !hasFile(['tsconfig.json', 'jsconfig.json'])(root)) return { root, language: 'php' };
  return locateProject(`${root}/__root__.ts`, root);
}
