import type { LanguageAdapter } from '../adapter';
import { git, type BranchChanges } from './git-changes';

/**
 * FR-24.6 an adapter that sees the project as it was at the merge base: a fresh adapter of the same kind
 * whose changed files get their base content (read with `git show`, nothing is checked out) — files added
 * on the branch become empty, deleted ones come back, renamed ones move back. Unchanged files are read
 * from disk as usual (they are the same in both versions).
 */
export async function createBaseAdapter(create: () => LanguageAdapter, root: string, changes: BranchChanges): Promise<LanguageAdapter> {
  const adapter = create();
  const at = (file: string) => `${root.replace(/\\/g, '/')}/${file}`;
  const show = (file: string) => git(root, ['show', `${changes.mergeBase}:${changes.prefix}${file}`]).catch(() => undefined);
  for (const f of changes.files) {
    // the current path is empty at the base when the file is new there: added, or the new name of a rename
    if (f.status === 'added' || f.from !== undefined) await adapter.updateFile(at(f.file), '');
    if (f.status === 'added') continue;
    // the base content at the path it had then; none when git has no file there (a submodule: no blob at the base)
    const was = f.from ?? f.file;
    await adapter.updateFile(at(was), (await show(was)) ?? '');
  }
  return adapter;
}
