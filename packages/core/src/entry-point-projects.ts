/**
 * FR-16.8 which project of a multi-project root an entry point belongs to — a solution's .csproj, a monorepo's
 * package (package.json), a Composer package (composer.json): the nearest such file above the entry point's file,
 * up to the root. One directory listing per folder, cached per call.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EntryPoint } from '@seqcall/protocol';

/** Sets `project` on every entry point when they come from more than one project (else leaves them as they are). */
export function withProjects(root: string, list: EntryPoint[]): EntryPoint[] {
  const names = new Map<string, string>();
  const dirProject = new Map<string, string | null>();
  const rootDir = root.replace(/\\/g, '/').replace(/\/$/, '');
  const markerName = (dir: string): string | null => {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const csproj = files.find((f) => /\.csproj$/i.test(f));
    if (csproj) return csproj.replace(/\.csproj$/i, '');
    for (const f of ['package.json', 'composer.json']) {
      if (!files.includes(f)) continue;
      try {
        const name = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string' && name) return name;
      } catch {
        /* unreadable: the folder's name */
      }
      return path.basename(dir);
    }
    return null;
  };
  const projectOfDir = (dir: string): string => {
    const hit = dirProject.get(dir);
    if (hit) return hit;
    const own = dir.length <= rootDir.length ? path.basename(rootDir) : markerName(dir);
    const name = own ?? projectOfDir(path.dirname(dir).replace(/\\/g, '/'));
    dirProject.set(dir, name);
    return name;
  };
  for (const e of list) {
    const rel = e.method.key.slice(0, e.method.key.indexOf('#'));
    if (!rel || names.has(rel)) continue;
    names.set(rel, projectOfDir(path.dirname(`${rootDir}/${rel}`).replace(/\\/g, '/')));
  }
  if (new Set(names.values()).size < 2) return list;
  return list.map((e) => {
    const project = names.get(e.method.key.slice(0, e.method.key.indexOf('#')));
    return project ? { ...e, project } : e;
  });
}
