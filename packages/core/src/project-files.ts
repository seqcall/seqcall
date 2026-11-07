import * as fs from 'node:fs';
import * as path from 'node:path';

/** Folders that hold no project code: dependencies, build output, tool state. */
const SKIPPED = new Set(['node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', 'target']);

/**
 * the source files of a project with the given extensions (`.ts`, `.cs` …), project-relative with `/`,
 * sorted — for the design-issue scan of code no entry point reaches. Dot-folders and the folders above are skipped;
 * at most `max` files (a monorepo root opened by mistake must not be walked whole).
 */
export function listSourceFiles(root: string, extensions: ReadonlySet<string>, max = 20_000): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: nothing to list
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED.has(e.name)) walk(path.join(dir, e.name), r);
      } else if (e.isFile() && extensions.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) out.push(r);
    }
  };
  walk(root, '');
  return out;
}
