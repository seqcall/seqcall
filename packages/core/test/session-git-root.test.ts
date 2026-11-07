import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { cls, fakeSession, meth } from './fake-world';

// FR-24.13 / FR-25 the git state a session reads, with a host classifier that names no project root (the adapter's root
// is the project), on a repository with a branch and then a detached HEAD.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-shop-repo-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString().trim();
fs.writeFileSync(`${root}/Shop.cs`, 'class Shop { void Run() {} }\n');
git('init', '-q', '-b', 'feature/orders');
git('add', '.');
git('commit', '-q', '-m', 'shop');
const run = meth(cls('Shop.cs', 'Shop'), 'Run');
const base = new DefaultClassifier('/nowhere', {});
const rootless: Classifier = { classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => [], reloadConfig: () => undefined };
const session = () => fakeSession({ methods: [run], adapter: { projectRoot: root } }, { classifier: rootless });

describe('FR-24.13 / FR-25.2 the adapter\'s root as the project', () => {
  it('FR-24.13 the branches to compare with are the adapter root\'s repository\'s', async () => {
    const refs = await session().gitRefs();
    expect([refs.current, refs.commits.map((c) => c.subject)]).toEqual(['feature/orders', ['shop']]);
  });

  it('FR-25.2 a shared state names the adapter root\'s folder and commit; on a detached HEAD no branch', async () => {
    const s = session();
    await s.openMethodByKey(run.key);
    const commit = git('rev-parse', 'HEAD');
    const snap = (await s.exportState({ language: 'csharp' }))!;
    expect([snap.project.name, snap.git]).toEqual([path.basename(root), { commit, branch: 'feature/orders', changed: [] }]);
    git('checkout', '-q', '--detach');
    const detached = (await s.exportState({ language: 'csharp' }))!;
    expect(detached.git).toEqual({ commit, changed: [] });
    expect(detached.git).not.toHaveProperty('branch');
  });

  it('FR-25.3 back to the project\'s own config (nothing borrowed): the config is read again', async () => {
    let reloads = 0;
    const counting: Classifier = { ...rootless, reloadConfig: () => void reloads++ };
    const s = fakeSession({ methods: [run], adapter: { projectRoot: root } }, { classifier: counting });
    await s.openMethodByKey(run.key);
    await s.useSharedConfig(false);
    expect([reloads, s.configBorrowed()]).toEqual([1, false]);
  });
});
