/**
 * A counter per project root, bumped when its `.seqcall.json` is re-read (the classifier's `reloadConfig`), so
 * readers that cache the file (the adapters' TestFileMatcher) re-read it at once instead of after their own interval.
 */
import * as path from 'node:path';

const generations = new Map<string, number>();
// (asked on every test-file check: resolving the path each time is slow in long scans; a relative root depends on
// the working directory, so only absolute ones are kept)
const keys = new Map<string, string>();
const rootKey = (root: string) => {
  let k = keys.get(root);
  if (k === undefined) {
    k = path.resolve(root).replace(/\\/g, '/');
    if (path.isAbsolute(root)) keys.set(root, k);
  }
  return k;
};

/** The project's config was reloaded (saved). */
export function noteConfigChanged(projectRoot: string): void {
  const k = rootKey(projectRoot);
  generations.set(k, (generations.get(k) ?? 0) + 1);
}

export function configGeneration(projectRoot: string): number {
  return generations.get(rootKey(projectRoot)) ?? 0;
}
