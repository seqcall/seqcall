import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchChanges } from '../src/review/git-changes';
import { gitRefs } from '../src/review/git-refs';

// a repository whose project is the folder app/; develop moves on (outside app/) after the feature branched
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-compare-')).replace(/\\/g, '/');
const app = `${repo}/app`;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' }).toString();

beforeAll(() => {
  write('app/src/a.ts', 'export function a() {\n  return check();\n}\nfunction check() {\n  return 1;\n}\n');
  write('ops/deploy.sh', 'echo 1\n');
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('tag', 'v1');
  git('checkout', '-q', '-b', 'feature/x');
  write('app/src/a.ts', 'export function a() {\n  return 2;\n}\n');
  git('commit', '-q', '-am', 'feature: no check');
  git('checkout', '-q', 'develop');
  write('ops/deploy.sh', 'echo 2\n');
  git('commit', '-q', '-am', 'deploy only');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('FR-24.13 what a review compares with', () => {
  it('FR-24.13 since the split, on develop against the feature: no changes in the project — the summary says why (a commit outside it)', async () => {
    const c = await branchChanges(app, 'feature/x', 'split');
    expect(c.files).toEqual([]);
    expect(c).toMatchObject({ mode: 'split', commits: 1, behind: 0, outside: ['ops/deploy.sh'] });
  });

  it('FR-24.13 tip against tip: what only the feature has shows as changes of develop (removed in a review), with the counts', async () => {
    const c = await branchChanges(app, 'feature/x', 'direct');
    expect(c.files.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(c.files[0].removedCount).toBe(1); // `return 2` is not on develop
    expect(c.files[0].addedCount).toBe(4); // develop still has the check
    expect(c).toMatchObject({ mode: 'direct', commits: 1, behind: 1 });
    expect(c.mergeBase).toBe(git('rev-parse', 'feature/x').trim()); // the base itself is the compare point
    // another mode is another review (FR-24.8 reuse): the fingerprints differ
    expect(c.fingerprint).not.toBe((await branchChanges(app, 'feature/x', 'split')).fingerprint);
  });

  it('FR-24.13 any ref: a tag, a hash, HEAD~1', async () => {
    expect((await branchChanges(app, 'v1')).commits).toBe(1);
    const hash = git('rev-parse', '--short', 'HEAD~1').trim();
    expect((await branchChanges(app, hash)).resolvedBase).toBe(hash);
    expect((await branchChanges(app, 'HEAD~1')).outside).toEqual(['ops/deploy.sh']);
    await expect(branchChanges(app, 'nope')).rejects.toThrow('No branch, tag or commit "nope"');
  });

  it('FR-24.13 the lists: the other branches (not the current one), tags, the last commits, the usual target', async () => {
    const r = await gitRefs(app);
    expect(r.current).toBe('develop');
    expect(r.target).toBe('develop');
    expect(r.branches.map((b) => b.name)).toEqual(['feature/x']);
    expect(r.branches[0]).toMatchObject({ remote: false, subject: 'feature: no check' });
    expect(r.tags.map((t) => t.name)).toEqual(['v1']);
    expect(r.commits.map((c) => c.subject)).toEqual(['deploy only', 'base']);
    expect(r.upstream).toBeUndefined();
  });
});

describe('FR-24.13 what a review compares with, in other repository states', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-refs-')).replace(/\\/g, '/');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('FR-24.13 a clone: remote branches (not origin/HEAD), the upstream; detached, there is no current branch', async () => {
    run(tmp, 'clone', '-q', repo, 'clone');
    const clone = `${tmp}/clone`;
    const r = await gitRefs(clone);
    expect(r).toMatchObject({ current: 'develop', upstream: 'origin/develop', target: 'develop' });
    expect(r.branches.map((b) => `${b.name}${b.remote ? ' (remote)' : ''}`).sort()).toEqual(['origin/develop (remote)', 'origin/feature/x (remote)']);
    run(clone, 'checkout', '-q', '--detach');
    const detached = await gitRefs(clone);
    expect(detached.current).toBeUndefined();
    expect(detached.upstream).toBeUndefined();
    // the local branch is one to compare with now
    expect(detached.branches.map((b) => b.name)).toContain('develop');
    // only remote targets: the usual one among them
    run(clone, 'checkout', '-q', '-b', 'trunk');
    run(clone, 'branch', '-q', '-D', 'develop');
    expect((await gitRefs(clone)).target).toBe('origin/develop');
  });

  it('FR-24.13 a repository without commits: nothing to compare with; a subject with a tab is kept whole', async () => {
    const empty = `${tmp}/empty`;
    fs.mkdirSync(empty);
    run(empty, 'init', '-q', '-b', 'trunk');
    expect(await gitRefs(empty)).toStrictEqual({ branches: [], tags: [], commits: [] });
    run(empty, 'commit', '-q', '--allow-empty', '-m', 'fix:\tthe total');
    run(empty, 'branch', 'other');
    const r = await gitRefs(empty);
    expect(r.commits.map((c) => c.subject)).toEqual(['fix:\tthe total']);
    expect(r.branches.map((b) => `${b.name}: ${b.subject}`)).toEqual(['other: fix:\tthe total']);
    expect(r.target).toBeUndefined();
  });
});

