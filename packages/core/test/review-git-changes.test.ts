import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { branchChanges, callChangeLines, REVIEW_NEEDS_GIT, hunkAround, isChangedLine, parseHunks, parseUnifiedDiff } from '../src/review/git-changes';

// FR-24.1 the changes of a branch in repository states that happen: names git quotes, untracked files of every kind,
// a file no longer tracked, a detached HEAD, an orphan branch.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-git-changes-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function repo() {
  const root = `${tmp}/r${n++}`;
  fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  git('init', '-q', '-b', 'develop');
  write('src/a.ts', 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { root, git, write };
}
const summary = (c: Awaited<ReturnType<typeof branchChanges>>) => c.files.map((f) => `${f.status} ${f.file} +${f.addedCount}`).sort();

describe('FR-24.1 the changes of a branch, in every repository state', () => {
  it('a project outside git: the review says why in words, not git\'s (localized) message; another failure keeps its reason', async () => {
    const plain = `${tmp}/plain${n++}`;
    fs.mkdirSync(plain);
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmp; // no repository above the temp folder either
    try {
      await expect(branchChanges(plain)).rejects.toThrow(REVIEW_NEEDS_GIT);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
    // a file is no folder to run git in: that reason, not "needs git"
    fs.writeFileSync(`${plain}/file.txt`, 'x');
    const err = await branchChanges(`${plain}/file.txt`).catch((e: Error) => e);
    expect((err as Error).message).not.toBe(REVIEW_NEEDS_GIT);
  });

  it('FR-24.1 a file name with non-ASCII characters is a change like any other (git quotes such names by default)', async () => {
    const { root, git, write } = repo();
    git('checkout', '-q', '-b', 'feature');
    write('src/Bestellübersicht.ts', 'export const b = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'feature');
    write('src/Größe.ts', 'export const g = 1;\nexport const h = 2;\n'); // untracked
    const c = await branchChanges(root);
    expect(summary(c)).toEqual(['added src/Bestellübersicht.ts +1', 'added src/Größe.ts +2']);
    expect([...c.hunks.keys()]).toEqual(['src/Bestellübersicht.ts']);
  });

  it('FR-24.1 untracked files: counted by their lines (also without a final line break); a dangling link or a name git escapes is left out', async () => {
    const { root, git, write } = repo();
    git('checkout', '-q', '-b', 'feature');
    write('src/no-eol.ts', 'export const x = 1;\nexport const y = 2;');
    fs.symlinkSync(`${root}/src/missing.ts`, `${root}/src/link.ts`);
    write('src/say "hi".ts', 'export const q = 1;\n');
    const c = await branchChanges(root);
    expect(summary(c)).toEqual(['added src/no-eol.ts +2']);
    expect([...c.files.find((f) => f.file === 'src/no-eol.ts')!.added]).toEqual([1, 2]);
  });

  it('FR-24.1 a committed file with a name git escapes is left out; a file no longer tracked (still on disk) is a deletion only', async () => {
    const { root, git, write } = repo();
    git('checkout', '-q', '-b', 'feature');
    write('src/say "hi".ts', 'export const q = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'quoted name');
    git('rm', '-q', '--cached', 'src/a.ts');
    const c = await branchChanges(root);
    expect(summary(c)).toEqual(['deleted src/a.ts +0']);
  });

  it('FR-24.1 / FR-24.13 detached HEAD: no branch; an orphan branch without commits, compared tip against tip: no branch, nothing counted', async () => {
    const { root, git, write } = repo();
    git('checkout', '-q', '--detach');
    write('src/a.ts', 'export const a = 2;\n');
    const detached = await branchChanges(root);
    expect(detached).not.toHaveProperty('branch');
    expect(summary(detached)).toEqual(['modified src/a.ts +1']);
    git('checkout', '-q', '--orphan', 'fresh');
    const orphan = await branchChanges(root, 'develop', 'direct');
    expect(orphan).not.toHaveProperty('branch');
    expect(orphan).toMatchObject({ commits: 0, behind: 0 });
    // the index still holds develop's files: the working tree change is the difference
    expect(summary(orphan)).toEqual(['modified src/a.ts +1']);
  });
});

describe('FR-24.1 / FR-24.7 / FR-24.15 reading a diff', () => {
  it('FR-24.1 a file moved into the project folder from outside it has no previous path; a hunk header git did not write is skipped', () => {
    const diff = [
      'diff --git a/lib/B.ts b/app/src/B.ts',
      'similarity index 100%',
      'rename from lib/B.ts',
      'rename to app/src/B.ts',
      'diff --git a/app/src/A.ts b/app/src/A.ts',
      '@@ broken @@',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const files = parseUnifiedDiff(diff, 'app/');
    expect(files.map((f) => `${f.status} ${f.file} ${f.from ?? '-'} +${f.addedCount}`)).toEqual(['renamed src/B.ts - +0', 'modified src/A.ts - +1']);
    expect(files[0]).not.toHaveProperty('from');
  });

  it('FR-24.7 a header git quoted is no file of the hunks; no hunks for a file: no lines around', () => {
    const hunks = parseHunks(['diff --git "a/say \\"hi\\".ts" "b/say \\"hi\\".ts"', '@@ -1 +1 @@', '-a', '+b', 'diff --git a/x.ts b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'));
    expect([...hunks.keys()]).toEqual(['x.ts']);
    // with a project folder: a file outside it has no hunks, its lines go nowhere
    const inApp = parseHunks(['diff --git a/app/x.ts b/app/x.ts', '@@ -1 +1 @@', '+b', 'diff --git a/lib/y.ts b/lib/y.ts', '@@ -1 +1 @@', '+c'].join('\n'), 'app/');
    expect([...inApp]).toEqual([['x.ts', [{ oldStart: 1, newStart: 1, lines: [{ kind: '+', text: 'b' }] }]]]);
    expect(hunkAround(undefined, 1, 'new')).toBeUndefined();
    expect(callChangeLines(undefined, [1, 1], [1, 1])).toBeUndefined();
    expect(isChangedLine(undefined, 'new', 1)).toBe(false);
  });

  it('FR-24.15 a call whose lines were only removed: the removed lines, none marked; old lines after added ones are counted right', () => {
    const hunks = parseHunks(['diff --git a/x.ts b/x.ts', '@@ -1,3 +1,3 @@', '+added();', ' keep();', '-gone();', ' end();'].join('\n')).get('x.ts')!;
    // old line 2 is gone(); the added line before it is no old line
    expect(isChangedLine(hunks, 'old', 2)).toBe(true);
    expect(isChangedLine(hunks, 'old', 1)).toBe(false);
    expect(callChangeLines(hunks, [2, 2], [5, 5])).toEqual([{ kind: '-', text: 'gone();' }]);
  });
});
