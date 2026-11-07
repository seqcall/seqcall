import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectLanguage } from './languages';

export interface ProjectLocation {
  root: string;
  language: ProjectLanguage;
}

/** Folders never searched for projects (dependencies, build output, VCS). */
const SKIP = new Set(['node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', 'target']);
const MAX_DEPTH = 5;
const MAX_DIRS = 3000;

/**
 * FR-16.4 the projects of the workspace folders the entry points can be listed for: a folder with
 * tsconfig.json / jsconfig.json (TypeScript), a .sln / .slnx (C#), a composer.json (PHP) — the markers the hosts
 * locate projects by. Breadth-first, at most MAX_DEPTH levels and MAX_DIRS folders, hidden and dependency
 * folders skipped; sorted by path.
 */
export function discoverProjects(folders: string[]): ProjectLocation[] {
  const out: ProjectLocation[] = [];
  let visited = 0;
  const queue = folders.map((dir) => ({ dir, depth: 0 }));
  while (queue.length && visited < MAX_DIRS) {
    const { dir, depth } = queue.shift()!;
    visited++;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const language of projectLanguages(names.filter((n) => n.isFile()).map((n) => n.name))) out.push({ root: dir.replace(/\\/g, '/'), language });
    if (depth >= MAX_DEPTH) continue;
    for (const n of names) {
      if (n.isDirectory() && !n.name.startsWith('.') && !SKIP.has(n.name)) queue.push({ dir: path.join(dir, n.name), depth: depth + 1 });
    }
  }
  // by path; the languages of one folder stay in projectLanguages' order (C# first; the sort is stable)
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** The languages a folder is a project root of, by its files (C# solution first). */
export function projectLanguages(files: string[]): ProjectLanguage[] {
  const out: ProjectLanguage[] = [];
  if (files.some((n) => /\.slnx?$/i.test(n))) out.push('csharp');
  if (files.some((n) => n === 'tsconfig.json' || n === 'jsconfig.json')) out.push('typescript');
  else if (files.includes('composer.json')) out.push('php');
  return out;
}

/**
 * FR-16.4 the project a workspace folder stands for when nothing is open: the folder itself when it is a project
 * root, else the project found nearest below it (`suite/` → `suite/Platform/Platform.sln`), else undefined.
 */
export function folderProject(folder: string): ProjectLocation | undefined {
  let files: string[] = [];
  try {
    files = fs.readdirSync(folder);
  } catch {
    return undefined;
  }
  const own = projectLanguages(files)[0];
  if (own) return { root: folder.replace(/\\/g, '/'), language: own };
  const depth = (p: ProjectLocation) => p.root.split('/').length;
  return discoverProjects([folder]).sort((a, b) => depth(a) - depth(b))[0];
}
