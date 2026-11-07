import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { composerOwnerRoot, isAnalysedFile, languageOfFile, trimEndChar, type ProjectLanguage } from '@seqcall/core';

/**
 * Protocol convention: absolute file paths with forward slashes.
 * `uri.fsPath` gives native separators (and a lower-case drive letter on Windows).
 */
export function toProtocolPath(uri: vscode.Uri): string {
  return uri.fsPath.replace(/\\/g, '/');
}

export function fromProtocolPath(file: string): vscode.Uri {
  return vscode.Uri.file(file);
}

/** Normalised form for comparisons (case-insensitive drive letter, forward slashes). */
export function pathKey(file: string): string {
  const p = file.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `file` is `dir` or lies inside it (both protocol paths). */
export function isInside(file: string, dir: string): boolean {
  const f = pathKey(file);
  const d = trimEndChar(pathKey(dir), '/');
  return f === d || f.startsWith(d + '/');
}

export const SUPPORTED_LANGUAGES = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'csharp', 'php'];

export type { ProjectLanguage };

/** Language of a source file by extension (JS/TS for anything that is not C# or PHP). */
export function languageOf(file: string): ProjectLanguage {
  return languageOfFile(file);
}

export function isSourceFile(file: string): boolean {
  return isAnalysedFile(pathKey(file));
}

export function isSupportedDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && SUPPORTED_LANGUAGES.includes(doc.languageId);
}

const PROJECT_MARKERS = ['tsconfig.json', 'jsconfig.json'];

/** Analysed project: its root and the language (adapter) it is analysed with. */
export interface ProjectLocation {
  root: string;
  language: ProjectLanguage;
}

/** Project root and language for a source file (see findProjectRoot / findCSharpRoot). */
export function locateProject(file: string, language: ProjectLanguage = languageOf(file)): ProjectLocation {
  if (language === 'csharp') return { root: findCSharpRoot(file), language };
  if (language === 'php') return { root: findPhpRoot(file), language };
  return { root: findProjectRoot(file), language: 'typescript' };
}

/** Nearest directory (starting at the file's directory) for which `test` holds, up to `limit`. */
function nearestDir(file: string, test: (dir: string) => boolean, limit?: string): string | undefined {
  let dir = path.dirname(path.resolve(fromProtocolPath(file).fsPath));
  for (;;) {
    if (test(dir)) return dir;
    if (limit && pathKey(dir) === pathKey(limit)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function workspaceFolderOf(file: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(fromProtocolPath(file));
  return folder ? path.resolve(folder.uri.fsPath) : undefined;
}

/**
 * Project root for a file: nearest directory with tsconfig.json / jsconfig.json
 * (not above the workspace folder), else the workspace folder, else the nearest
 * directory with package.json, else the file's directory.
 */
export function findProjectRoot(file: string): string {
  const stop = workspaceFolderOf(file);
  const has = (markers: string[]) => (dir: string) => markers.some((m) => fs.existsSync(path.join(dir, m)));
  const found =
    nearestDir(file, has(PROJECT_MARKERS), stop) ??
    stop ??
    nearestDir(file, has(['package.json'])) ??
    path.dirname(fromProtocolPath(file).fsPath);
  return found.replace(/\\/g, '/');
}

const hasEntry = (re: RegExp) => (dir: string): boolean => {
  try {
    return fs.readdirSync(dir).some((n) => re.test(n));
  } catch {
    return false;
  }
};

/**
 * C# project root: the nearest directory upwards containing a solution (.sln / .slnx), else the
 * nearest one with a .csproj, else the workspace folder, else the file's directory.
 */
export function findCSharpRoot(file: string): string {
  const found =
    nearestDir(file, hasEntry(/\.slnx?$/i)) ??
    nearestDir(file, hasEntry(/\.csproj$/i)) ??
    workspaceFolderOf(file) ??
    path.dirname(fromProtocolPath(file).fsPath);
  return found.replace(/\\/g, '/');
}

/**
 * PHP project root (FR-18): the nearest directory upwards with a composer.json, else the
 * workspace folder, else the file's directory.
 */
export function findPhpRoot(file: string): string {
  const found =
    // a file of a Composer dependency: the project that installed it, not the package (FR-18.9)
    composerOwnerRoot(fromProtocolPath(file).fsPath, (dir) => fs.existsSync(path.join(dir, 'composer.json'))) ??
    nearestDir(file, (dir) => fs.existsSync(path.join(dir, 'composer.json'))) ??
    workspaceFolderOf(file) ??
    path.dirname(fromProtocolPath(file).fsPath);
  return found.replace(/\\/g, '/');
}
