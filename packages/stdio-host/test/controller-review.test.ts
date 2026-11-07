import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '@seqcall/protocol';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, shopProject, trackScans, type Recorded } from './controller-helpers';

// Review of a branch (FR-24) and the git lists (FR-24.13) through the HeadlessController, on a temp
// git repository (made-up shop): Order and OrderService change together three times on develop; the branch
// feature/total makes Order.total save through Infrastructure (a layer violation on a changed line).

const order = (v: number, db: boolean) =>
  `${db ? "import { Db } from '../infrastructure/db';\n" : ''}export class Order {\n  total() {\n${db ? "    new Db().save('total');\n" : ''}    return ${v};\n  }\n}\n`;
const service = (v: number) =>
  `import { Order } from '../domain/order';\nexport class OrderService {\n  place() {\n    return new Order().total() + ${v};\n  }\n  list() {\n    return [this.place()];\n  }\n}\n`;
const repo = shopProject('review', { 'src/domain/order.ts': order(0, false), 'src/application/order-service.ts': service(0) });
const NAME = path.basename(repo.root);
/** Every git call runs in the temp repository. */
const git = (args: string[], weeksAgo = 0) => {
  const date = new Date(Date.now() - weeksAgo * 7 * 86_400_000).toISOString();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo.root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};
git(['init', '-q', '-b', 'develop']);
git(['add', '.']);
git(['commit', '-q', '-m', 'base'], 10);
for (let i = 1; i <= 3; i++) {
  fs.writeFileSync(repo.file('src/domain/order.ts'), order(i, false));
  fs.writeFileSync(repo.file('src/application/order-service.ts'), service(i));
  git(['commit', '-q', '-am', `v${i}`], 10 - 3 * i);
  if (i === 1) git(['tag', 'v1']);
}
git(['checkout', '-q', '-b', 'feature/total']);
fs.writeFileSync(repo.file('src/domain/order.ts'), order(3, true));
git(['commit', '-q', '-am', 'db']);
afterAll(() => repo.rm());

const CONTROLLER = repo.file('src/presentation/orders.controller.ts');
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of cleanups) await f();
  cleanups = [];
});

/** show() open (GET /orders/:id); `diff`: the host has a diff viewer. */
async function opened(opts: { diff?: boolean; open?: boolean } = {}): Promise<{ c: HeadlessController; r: Recorded }> {
  const r = recordingSink({ diff: opts.diff });
  const c = new HeadlessController(r.sink, { workspace: repo.root });
  cleanups.push(() => c.dispose());
  if (opts.open !== false) await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'return new OrderService().place()'));
  return { c, r };
}

async function reviewed(r: Recorded, c: HeadlessController, msg: { base?: string; mode?: 'split' | 'direct'; force?: boolean } = {}): Promise<ReviewResult> {
  const from = r.seq.length;
  await c.onSequenceMessage({ type: 'requestReview', ...msg });
  const done = r.seq.slice(from).find((m) => m.type === 'review' && m.state !== 'running');
  if (done?.type !== 'review' || done.state !== 'done') throw new Error(`no review: ${JSON.stringify(done)}`);
  return done.result!;
}


describe('HeadlessController: git (FR-24.13)', () => {
  it('FR-24.13 the review picker\'s lists: the current branch, its target, branches, tags, commits', async () => {
    const { c, r } = await opened({ open: false });
    await c.onSequenceMessage({ type: 'requestGitRefs' });
    const refs = r.seq.at(-1);
    if (refs?.type !== 'gitRefs' || !refs.refs) throw new Error(JSON.stringify(refs));
    expect(refs.refs).toMatchObject({ current: 'feature/total', target: 'develop' });
    expect(refs.refs.branches.map((b) => b.name)).toEqual(['develop']);
    expect(refs.refs.tags.map((t) => t.name)).toEqual(['v1']);
    expect(refs.refs.commits.map((x) => x.subject)).toEqual(['db', 'v3', 'v2', 'v1', 'base']);
  });
});

describe('HeadlessController: review of a branch (FR-24)', () => {
  it('FR-24.1 / FR-24.2 throttled progress, the result, then the diagram re-drawn with the change marks', async () => {
    const scans = trackScans();
    const { c, r } = await opened();
    await scans.settled();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const from = r.seq.length;
    const result = await reviewed(r, c, { base: 'develop' });
    expect(r.seq.slice(from).map((m) => (m.type === 'review' ? `${m.type}:${m.state}` : m.type))).toEqual(['review:running', 'review:running', 'review:done', 'render']);
    expect(r.seq[from]).toEqual({ type: 'review', state: 'running', phase: 'Reading the changes (git)', show: false });
    expect(r.seq[from + 1]).toEqual({ type: 'review', state: 'running', phase: 'Reading the changes (git)', done: 0, total: 1 });
    expect(result).toMatchObject({ base: 'develop', branch: 'feature/total' });
    expect(result.issues.map((i) => i.finding.title)).toEqual(['Layer violation: Order → Db']);
    expect(lastRender(r.seq).messages.find((m) => m.id === 'root/1:place')?.diff).toMatchObject({ count: 3 });
  });

  it('FR-24.13 / FR-24.8 the base and the mode stay for the next review; the same review again is reused unless forced', async () => {
    const { c, r } = await opened();
    expect(await reviewed(r, c, { base: 'v1', mode: 'direct' })).toMatchObject({ base: 'v1', compare: { mode: 'direct' } });
    const again = await reviewed(r, c);
    expect(again).toMatchObject({ base: 'v1', compare: { mode: 'direct' }, reused: true });
    expect((await reviewed(r, c, { force: true })).reused).toBeUndefined();
    expect(await reviewed(r, c, { mode: 'split' })).toMatchObject({ base: 'v1', compare: { mode: 'split' } });
  });

  it('FR-24.1 / FR-24.3 a review of the workspace with no diagram open draws nothing; cancelled from the view; outside git it says why', async () => {
    const { c, r } = await opened({ open: false });
    await reviewed(r, c, { base: 'develop' });
    expect(r.seq.some((m) => m.type === 'render')).toBe(false);

    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'review' && m.state === 'running' && m.done === 0) void c.onSequenceMessage({ type: 'cancelReview' });
    };
    await c.onSequenceMessage({ type: 'requestReview', force: true });
    expect(r.seq.at(-1)).toEqual({ type: 'review', state: 'cancelled' });
    // the cancel was for that review: the next one runs
    r.sink.postSequence = (m) => void r.seq.push(m);
    await reviewed(r, c, { force: true });

    const plain = shopProject('nogit');
    cleanups.push(() => plain.rm());
    const other = recordingSink();
    const d = new HeadlessController(other.sink, { workspace: plain.root });
    cleanups.push(() => d.dispose());
    await d.onSequenceMessage({ type: 'requestReview', base: 'develop' });
    const err = other.seq.at(-1);
    expect(err?.type === 'review' && err.state === 'error' && err.error).toBeTruthy();
    expect(other.logs('error')).toEqual([`review: ${err?.type === 'review' ? err.error : ''}`]);
  });

  it('FR-24.3 / FR-29.3 / FR-29.4 an issue and a structure row open their flow with the evidence highlighted', async () => {
    const { c, r } = await opened();
    const result = await reviewed(r, c, { base: 'develop' });
    const issue = result.issues[0];
    await c.onSequenceMessage({ type: 'openReviewIssue', issue });
    expect(lastRender(r.seq).root.key).toBe(issue.entryPoint!.method.key);
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: issue.finding.messageIds![0], messageIds: issue.finding.messageIds, finding: issue.finding });
    const { messageIds: _ids, ...bare } = issue.finding;
    await c.onSequenceMessage({ type: 'openReviewIssue', issue: { ...issue, finding: bare } });
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: null, messageIds: [], finding: bare });

    const row = result.structure!.rows.find((x) => x.kind === 'violation-added')!;
    await c.onSequenceMessage({ type: 'openReviewStructure', row });
    const hl = r.seq.at(-1);
    if (hl?.type !== 'highlight') throw new Error(JSON.stringify(hl));
    expect(lastRender(r.seq).messages.find((m) => m.id === hl.messageId)?.methodName).toBe('save');
    // a row of the base version (no entry point on the branch): nothing opens
    const n = r.seq.length;
    const { entryPoint: _ep, ...removed } = row;
    await c.onSequenceMessage({ type: 'openReviewStructure', row: { ...removed, kind: 'violation-removed' } });
    expect(r.seq.length).toBe(n);
    // a row without class pairs (a new endpoint): its flow opens, nothing to highlight
    await c.onSequenceMessage({ type: 'openReviewStructure', row: { kind: 'entry-added', title: 'GET /orders', entryPoint: row.entryPoint } });
    expect(lastRender(r.seq).root.key).toBe(row.entryPoint!.method.key);
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: null });
  });

  it('FR-24.9 / FR-24.10 stepping through the changes: by number, a folded change revealed, a change\'s flow; a step that is gone does nothing', async () => {
    const { c, r } = await opened();
    const result = await reviewed(r, c, { base: 'develop' });
    await c.onSequenceMessage({ type: 'showChange', n: 1 });
    const first = r.seq.at(-1);
    if (first?.type !== 'highlight') throw new Error(JSON.stringify(first));
    expect(lastRender(r.seq).messages.find((m) => m.id === first.messageId)?.diff).toBeTruthy();

    await c.onSequenceMessage({ type: 'collapseAll' });
    await c.onSequenceMessage({ type: 'revealChange', messageId: 'root/1:place' });
    const revealed = r.seq.at(-1);
    if (revealed?.type !== 'highlight') throw new Error(JSON.stringify(revealed));
    expect(revealed.messageId).toMatch(/^root\/1:place\//);

    const total = result.methods.find((m) => m.method.name === 'total')!;
    await c.onSequenceMessage({ type: 'openChangeFlow', paths: [total.reachedFrom[0].steps], entryPoint: total.reachedFrom[0].entryPoint });
    expect(lastRender(r.seq).root.key).toBe(total.reachedFrom[0].steps[0].methodKey);
    expect(r.seq.at(-1)).toMatchObject({ type: 'highlight' });
    // FR-16.3 the flow is the entry point's: a shared state says so
    await c.onSequenceMessage({ type: 'copyState' });
    const state = r.seq.at(-1);
    expect(state?.type === 'diagramState' && JSON.parse(state.text!).entry).toEqual({ kind: 'http', label: total.reachedFrom[0].entryPoint.label });

    const n = r.seq.length;
    await c.onSequenceMessage({ type: 'showChange', n: 99 });
    await c.onSequenceMessage({ type: 'revealChange', messageId: 'root/7:gone' });
    await c.onSequenceMessage({ type: 'openChangeFlow', paths: [[{ methodKey: 'src/domain/gone.ts#Gone.run' }]] });
    expect(r.seq.slice(n)).toEqual([]);
  });

  it('FR-24.7 / FR-24.11 a changed call or class side by side in the host\'s diff viewer; a host without one opens the file at the line', async () => {
    const { c, r } = await opened({ diff: true });
    await reviewed(r, c, { base: 'develop' });
    await c.onSequenceMessage({ type: 'expandAll', messageId: 'root' });
    const save = lastRender(r.seq).messages.find((m) => m.methodName === 'save')!;
    await c.onSequenceMessage({ type: 'openDiff', messageId: save.id, keepFocus: true });
    await c.onClassMessage({ type: 'openDiff', classKey: 'src/domain/order.ts#Order' });
    const diffs = r.other.filter((o) => o.kind === 'openDiff').map((o) => o.arg as { target: { file: string; line: number; baseText: string; title: string }; keepFocus?: boolean });
    await c.onSequenceMessage({ type: 'openDiff' }); // neither a call nor a class: nothing
    expect(r.other.filter((o) => o.kind === 'openDiff')).toHaveLength(2);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toMatchObject({ target: { file: repo.file('src/domain/order.ts'), line: 3, baseText: order(3, false) }, keepFocus: true });
    expect(diffs[1]).toMatchObject({ target: { file: repo.file('src/domain/order.ts'), baseText: order(3, false) }, keepFocus: undefined });

    const plain = await opened();
    await reviewed(plain.r, plain.c, { base: 'develop' });
    await plain.c.onSequenceMessage({ type: 'expandAll', messageId: 'root' });
    const call = lastRender(plain.r.seq).messages.find((m) => m.methodName === 'save')!;
    await plain.c.onSequenceMessage({ type: 'openDiff', messageId: call.id, method: true });
    // method: the change of the method the call reaches (its declaration), not of the call
    const at = { line: 1, character: 0 };
    expect(plain.r.other.filter((o) => o.kind === 'navigate')).toEqual([{ kind: 'navigate', arg: { file: repo.file('src/infrastructure/db.ts'), start: at, end: at } }]);
  });

  it('FR-24.4 ending the review re-draws the diagram without the marks', async () => {
    const { c, r } = await opened();
    await reviewed(r, c, { base: 'develop' });
    await c.onSequenceMessage({ type: 'endReview' });
    expect(lastRender(r.seq).messages.some((m) => m.diff)).toBe(false);
  });
});
