import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/** FR-24.1 how a file changed on the branch (project-relative path, forward slashes). */
export interface FileChange {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** The path before a rename (project-relative). */
  from?: string;
  /** 1-based lines of the new version that were added or changed. */
  added: Set<number>;
  /** 1-based lines of the new version next to which lines were removed. */
  removedAt: number[];
  addedCount: number;
  removedCount: number;
}

export interface BranchChanges {
  /** The base as given (`develop`) and as resolved (`origin/develop` when there is no local branch). */
  base: string;
  resolvedBase: string;
  /** The compare point: the merge base (`split`), or the base itself (`direct`). Its content is the base version. */
  mergeBase: string;
  /** FR-24.13 `split`: since the branch split off the base (a pull request); `direct`: tip against tip. */
  mode: CompareMode;
  /** FR-24.13 commits of HEAD after the compare point; commits only the base has (`direct`); changed files outside the project folder. */
  commits: number;
  behind: number;
  outside: string[];
  /** The project folder inside the repository (`git rev-parse --show-prefix`, '' at the top). */
  prefix: string;
  branch?: string;
  files: FileChange[];
  /** FR-24.7 the diff with 3 lines of context, by the file's current path (for the hover hunks and "open diff"). */
  hunks: Map<string, Hunk[]>;
  /** FR-24.8 the state reviewed: base, merge base, HEAD, the diff and the untracked files' content (equal = nothing changed). */
  fingerprint: string;
}

/** FR-24.7 one hunk of a unified diff: where it starts in the old and the new version, its lines. */
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: { kind: '+' | '-' | ' '; text: string }[];
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    // core.quotePath=false: paths with non-ASCII characters as they are (by default `"Bestell\303\274bersicht.ts"`)
    // git's messages in English (LANGUAGE wins over the locale for them): a reason the views can show and match
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: { ...process.env, LANGUAGE: 'en' }, maxBuffer: 256 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout),
    ),
  );
}

/**
 * FR-24.1 the changes of the current branch against `base` (default `develop`, else `origin/<base>`): the
 * diff from the merge base to the working tree (uncommitted edits included) plus untracked files, limited
 * to the project folder. Throws with a readable reason (no git, unknown base).
 */
export type CompareMode = 'split' | 'direct';

/** why a review cannot run here, in words, not git's message. */
export const REVIEW_NEEDS_GIT = 'This project is not in a git repository (or git is not installed) — a review compares this branch with another, so it needs git.';

export async function branchChanges(root: string, base = 'develop', mode: CompareMode = 'split'): Promise<BranchChanges> {
  const prefix = (
    await git(root, ['rev-parse', '--show-prefix']).catch((e: Error) => {
      throw /not a git repository|ENOENT/i.test(e.message) ? new Error(REVIEW_NEEDS_GIT) : e;
    })
  ).trim();
  let resolvedBase: string | undefined;
  for (const candidate of [base, `origin/${base}`]) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      resolvedBase = candidate;
      break;
    } catch {
      // try the next
    }
  }
  if (!resolvedBase) throw new Error(`No branch, tag or commit "${base}" (nor "origin/${base}") in this repository — choose another base.`);
  // FR-24.13 tip against tip: the base itself is the compare point (what only the base has shows as removed)
  const mergeBase = mode === 'direct' ? (await git(root, ['rev-parse', `${resolvedBase}^{commit}`])).trim() : (await git(root, ['merge-base', resolvedBase, 'HEAD'])).trim();
  const count = async (range: string) => Number((await git(root, ['rev-list', '--count', range]).catch(() => '0')).trim());
  const commits = await count(`${mergeBase}..HEAD`);
  const behind = mode === 'direct' ? await count(`HEAD..${mergeBase}`) : 0;
  // changed files outside the project folder (they explain an empty review)
  const everywhere = (await git(root, ['diff', '--name-only', '--no-color', mergeBase, '--', ':/']).catch(() => '')).split('\n').filter(Boolean);
  const outside = everywhere.filter((f) => !prefix || !f.startsWith(prefix));
  // '' when HEAD has no commit yet (an orphan branch), `HEAD` when detached: no branch either way
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const diff = await git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', mergeBase, '--', '.']);
  const files = parseUnifiedDiff(diff, prefix);
  // untracked files are new code too
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '--', '.'])).split('\n').filter(Boolean);
  const untrackedText = new Map<string, string>();
  for (const f of untracked) {
    if (files.some((x) => x.file === f)) continue;
    const text = await fs.readFile(`${root}/${f}`, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    untrackedText.set(f, text);
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    files.push({ file: f, status: 'added', added: new Set(Array.from({ length: n }, (_, i) => i + 1)), removedAt: [], addedCount: n, removedCount: 0 });
  }
  const context = await git(root, ['diff', '--unified=3', '--no-color', '--no-ext-diff', '-M', mergeBase, '--', '.']).catch(() => '');
  const hunks = parseHunks(context, prefix);
  const head = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  const fp = createHash('sha1').update(`${resolvedBase}\0${mode}\0${mergeBase}\0${head}\0${diff}`);
  for (const f of untracked) fp.update(`\0${f}\0`).update(untrackedText.get(f) ?? '');
  return { base, resolvedBase, mergeBase, mode, commits, behind, outside, prefix, hunks, fingerprint: fp.digest('hex'), ...(branch && branch !== 'HEAD' ? { branch } : {}), files };
}

/**
 * Parses `git diff --unified=0` output; paths are made relative to the project folder (`prefix`, from
 * `git rev-parse --show-prefix`) and files outside it are dropped.
 */
export function parseUnifiedDiff(diff: string, prefix = ''): FileChange[] {
  const out: FileChange[] = [];
  let cur: FileChange | undefined;
  let oldPath: string | undefined;
  const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? undefined : p);
  const finish = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      oldPath = m?.[1];
      const file = m ? rel(m[2]) : undefined;
      cur = file !== undefined ? { file, status: 'modified', added: new Set(), removedAt: [], addedCount: 0, removedCount: 0 } : undefined;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed';
      // the header that started `cur` set oldPath
      const from = rel(oldPath!);
      if (from !== undefined) cur.from = from;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const removed = m[2] === undefined ? 1 : Number(m[2]);
      const start = Number(m[3]);
      const count = m[4] === undefined ? 1 : Number(m[4]);
      for (let i = 0; i < count; i++) cur.added.add(start + i);
      cur.addedCount += count;
      cur.removedCount += removed;
      // a pure deletion is reported after line `start` of the new file
      if (removed > 0 && count === 0) cur.removedAt.push(Math.max(1, start));
      else if (removed > 0) cur.removedAt.push(start);
    }
  }
  finish();
  return out;
}

/** FR-24.7 the hunks of a unified diff (with context), by the file's new path relative to the project folder. */
export function parseHunks(diff: string, prefix = ''): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  const rel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : prefix ? undefined : p);
  let file: string | undefined;
  let hunk: Hunk | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = m ? rel(m[2]) : undefined;
      hunk = undefined;
      continue;
    }
    if (file === undefined) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      hunk = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
      out.set(file, [...(out.get(file) ?? []), hunk]);
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    if (kind === '+' || kind === '-' || kind === ' ') hunk.lines.push({ kind, text: line.slice(1) });
  }
  return out;
}

/**
 * FR-24.7 the lines of a hunk around a line of the new version (`side: 'new'`) or of the old one (`'old'`), the
 * line itself marked; and the matching line of the new version (for a removed line: where it was). The whole run
 * of changed (`+` / `−`) lines the line belongs to is kept, with `context` unchanged lines on each side (a guard
 * added above a call is part of its change), at most `max` lines — always with the line itself.
 */
export function hunkAround(hunks: Hunk[] | undefined, line: number, side: 'new' | 'old', context = 1, max = 16): { lines: { kind: '+' | '-' | ' '; text: string; at?: boolean }[]; newLine: number } | undefined {
  for (const h of hunks ?? []) {
    let o = h.oldStart;
    let n = h.newStart;
    for (let i = 0; i < h.lines.length; i++) {
      const l = h.lines[i];
      const hit = side === 'new' ? l.kind !== '-' && n === line : l.kind !== '+' && o === line;
      if (hit) {
        // the run of changed lines around i (an unchanged line on its own ends it)
        let from = i;
        while (from > 0 && h.lines[from - 1].kind !== ' ') from--;
        let to = i;
        while (to + 1 < h.lines.length && h.lines[to + 1].kind !== ' ') to++;
        from = Math.max(0, from - context);
        to = Math.min(h.lines.length - 1, to + context);
        // too long: keep the line, as much before it as after
        if (to - from + 1 > max) {
          const before = Math.min(i - from, Math.floor((max - 1) / 2) + Math.max(0, Math.ceil((max - 1) / 2) - (to - i)));
          from = i - before;
          to = Math.min(to, from + max - 1);
        }
        const lines = h.lines.slice(from, to + 1).map((x, k) => (from + k === i ? { ...x, at: true } : { ...x }));
        return { lines, newLine: n };
      }
      if (l.kind !== '-') n++;
      if (l.kind !== '+') o++;
    }
  }
  return undefined;
}

/**
 * FR-24.15 the change of a call both versions make: its removed lines in the base version (`oldLines`, 1-based,
 * inclusive) and its added lines now (`newLines`), with the unchanged lines of the call between — not the diff lines
 * that happen to sit around it (the tail of a removed loop above a rewritten call). Undefined when the call's own
 * lines did not change (its arguments on other lines: the caller shows the lines around it instead).
 */
export function callChangeLines(hunks: Hunk[] | undefined, oldLines: [number, number], newLines: [number, number], max = 16): { kind: '+' | '-' | ' '; text: string; at?: boolean }[] | undefined {
  const removed: { kind: '-'; text: string }[] = [];
  const added: { kind: '+' | ' '; text: string; at?: boolean }[] = [];
  for (const h of hunks ?? []) {
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.kind === '-' && o >= oldLines[0] && o <= oldLines[1]) removed.push({ kind: '-', text: l.text });
      if (l.kind !== '-' && n >= newLines[0] && n <= newLines[1]) added.push({ kind: l.kind === '+' ? '+' : ' ', text: l.text });
      if (l.kind !== '-') n++;
      if (l.kind !== '+') o++;
    }
  }
  if (!removed.length && !added.some((l) => l.kind === '+')) return undefined;
  const first = added.findIndex((l) => l.kind === '+');
  if (first >= 0) added[first] = { ...added[first], at: true };
  const half = Math.floor(max / 2);
  const r = removed.slice(0, Math.max(half, max - added.length));
  return [...r, ...added.slice(0, max - r.length)];
}

/** FR-24.15 is a 1-based line of one side changed in the diff (`+` new / `-` old); a line outside every hunk is not. */
export function isChangedLine(hunks: Hunk[] | undefined, side: 'new' | 'old', line: number): boolean {
  for (const h of hunks ?? []) {
    let o = h.oldStart;
    let n = h.newStart;
    for (const l of h.lines) {
      if (side === 'new' && l.kind !== '-' && n === line) return l.kind === '+';
      if (side === 'old' && l.kind !== '+' && o === line) return l.kind === '-';
      if (l.kind !== '-') n++;
      if (l.kind !== '+') o++;
    }
  }
  return false;
}
