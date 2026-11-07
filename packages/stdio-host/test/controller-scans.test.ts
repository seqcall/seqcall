import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToClassView, HostToSequenceView } from '@seqcall/protocol';
import { DiagramSession } from '@seqcall/core';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, SAMPLE_APP, sampleAppCopy, shopProject, tempProject, TSCONFIG, type Recorded } from './controller-helpers';

// Project-wide work of the HeadlessController (entry points FR-16, design issues FR-19.9, the codebase map FR-26, paths
// to here FR-22, find FR-23): progress while it runs, the result, cancelling, a failure. The clock is
// frozen where progress is counted: then only the first report and the last (done = total) pass the 250 ms throttle.

const CONTROLLER = `${SAMPLE_APP}/src/controllers/user-controller.ts`;
const REPOSITORY = `${SAMPLE_APP}/src/adapters/sql-user-repository.ts`;
const NO_METHOD_REASON = 'Place the caret inside a method, constructor, getter/setter or function body and run "Show Sequence Diagram".';

/** Three HTTP endpoints, one layer violation (read only here). */
const shop = shopProject();
const SHOP = path.basename(shop.root);
afterAll(() => shop.rm());

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of cleanups) await f();
  cleanups = [];
});

function controller(workspace: string | undefined = SAMPLE_APP): { c: HeadlessController; r: Recorded } {
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace });
  cleanups.push(() => c.dispose());
  return { c, r };
}

const freezeClock = () => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-05T10:00:00Z') });
const of = <T extends HostToSequenceView['type']>(msgs: HostToSequenceView[], type: T) => msgs.filter((m): m is Extract<HostToSequenceView, { type: T }> => m.type === type);
const ofClass = <T extends HostToClassView['type']>(msgs: HostToClassView[], type: T) => msgs.filter((m): m is Extract<HostToClassView, { type: T }> => m.type === type);

describe('HeadlessController: unreachable code (FR-31)', () => {
  it('FR-31 the scan: throttled progress per phase, then the result (without the probe\'s list); cached, a rescan cancelled, a failure', async () => {
    const { c, r } = controller(shop.root);
    freezeClock();
    await c.onSequenceMessage({ type: 'requestUnreachable' });
    const msgs = of(r.seq, 'unreachable');
    expect(msgs[0]).toEqual({ type: 'unreachable', state: 'running', phase: 'reach', done: 0, project: SHOP, show: false });
    // the clock is frozen: one progress report passes the throttle
    expect(msgs.filter((m) => m.state === 'running')).toHaveLength(2);
    const done = msgs.at(-1)!;
    expect(done).toMatchObject({ type: 'unreachable', state: 'done', project: SHOP });
    expect(done.result!.entryPoints).toBeGreaterThan(2);
    expect(done.result).not.toHaveProperty('missedMethods');
    const before = r.seq.length;
    await c.onSequenceMessage({ type: 'requestUnreachable' });
    expect(r.seq.slice(before).map((m) => m.type === 'unreachable' && m.state)).toEqual(['running', 'done']);
    vi.useRealTimers();

    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'unreachable' && m.state === 'running' && m.phase === 'reach' && m.done === 0) void c.onSequenceMessage({ type: 'cancelUnreachable' });
    };
    await c.onSequenceMessage({ type: 'requestUnreachable', rescan: true });
    expect(r.seq.at(-1)).toEqual({ type: 'unreachable', state: 'cancelled', project: SHOP });
    r.sink.postSequence = (m) => void r.seq.push(m);

    vi.spyOn(DiagramSession.prototype, 'findUnreachableCode').mockRejectedValueOnce(new Error('out of memory'));
    await c.onSequenceMessage({ type: 'requestUnreachable', rescan: true });
    expect(r.seq.at(-1)).toEqual({ type: 'unreachable', state: 'error', error: 'out of memory', project: SHOP });
    expect(r.logs('error')).toEqual(['unreachable code: out of memory']);
  });
});

describe('HeadlessController: entry points and design issues (FR-16, FR-19.9)', () => {
  it('FR-16.2 a failed entry-point scan: an empty list with the reason, the progress closed', async () => {
    const { c, r } = controller(shop.root);
    vi.spyOn(DiagramSession.prototype, 'getEntryPoints').mockRejectedValueOnce(new Error('tsconfig broken'));
    await c.onSequenceMessage({ type: 'requestEntryPoints' });
    expect(r.seq).toEqual([{ type: 'entryPoints', entryPoints: [], project: SHOP, error: 'tsconfig broken', show: false }]);
    expect(r.other).toEqual([
      { kind: 'progress', arg: `Finding entry points in ${SHOP}…` },
      { kind: 'log:error', arg: 'entry points: tsconfig broken' },
      { kind: 'progress', arg: null },
    ]);
  });

  it('FR-19.9 design issues of the project: throttled progress, the result with the counts; asked again: the cached list', async () => {
    const { c, r } = controller(shop.root);
    freezeClock();
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    const msgs = of(r.seq, 'projectFindings');
    const running = msgs.filter((m) => m.state === 'running');
    const done = msgs.at(-1)!;
    if (done.state !== 'done') throw new Error(JSON.stringify(done));
    expect(done.total).toBeGreaterThan(2);
    expect(running.map((m) => m.done).slice(0, 3)).toEqual([0, 1, done.total]);
    expect(running[0]).toEqual({ type: 'projectFindings', state: 'running', done: 0, project: SHOP, show: false });
    expect(running[2]).toEqual({ type: 'projectFindings', state: 'running', done: done.total, total: done.total, project: SHOP });
    // FR-19.23 the entry points' findings while the methods none reaches are looked for (FR-31), then those methods,
    // counted on after the entry points
    const walking = running.findIndex((m) => m.walking);
    expect(walking).toBeGreaterThan(2);
    expect(running[walking]).toMatchObject({ type: 'projectFindings', state: 'running', walking: true, project: SHOP });
    expect(running[walking].findings).toEqual(expect.any(Array));
    expect(running.slice(walking + 1).every((m) => m.done! > done.total! && m.total! > done.total!)).toBe(true);
    expect(running.slice(3, walking)).toEqual([]);
    expect(done).toMatchObject({ project: SHOP, truncated: 0 });
    expect(done.unreached!.scanned).toBeGreaterThan(0);
    expect(done.findings!.map((f) => f.finding.kind)).toContain('layer-violation');
    expect(done.changed).toBeUndefined();
    // FR-32.4 every scanned flow's outcome, for the lists' I/O pills and `has:`
    expect(Object.keys(done.outcomes!)).toHaveLength(done.total!);
    expect(Object.values(done.outcomes!).every((o) => Array.isArray(o.kinds))).toBe(true);
    // cached: no scan, the same list
    const before = r.seq.length;
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    expect(r.seq.slice(before).map((m) => m.type === 'projectFindings' && m.state)).toEqual(['running', 'done']);
    // the code changed while the session scanned: the answer says so
    vi.spyOn(DiagramSession.prototype, 'projectFindingsChanged', 'get').mockReturnValueOnce(true);
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    expect(r.seq.at(-1)).toMatchObject({ type: 'projectFindings', state: 'done', changed: true });
  });

  it('FR-19.9 a rescan cancelled from the view ends as cancelled; a failed scan says why', async () => {
    const { c, r } = controller(shop.root);
    // the view's cancel arrives while the scan runs (its first progress report)
    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'projectFindings' && m.state === 'running' && m.done === 1) void c.onSequenceMessage({ type: 'cancelProjectFindings' });
    };
    await c.onSequenceMessage({ type: 'requestProjectFindings', rescan: true });
    expect(r.seq.at(-1)).toEqual({ type: 'projectFindings', state: 'cancelled', project: SHOP });
    r.sink.postSequence = (m) => void r.seq.push(m);
    // the next request runs again (the cancel was for that scan only)
    await c.onSequenceMessage({ type: 'requestProjectFindings', rescan: true });
    expect(r.seq.at(-1)).toMatchObject({ type: 'projectFindings', state: 'done' });

    vi.spyOn(DiagramSession.prototype, 'findProjectIssues').mockRejectedValueOnce(new Error('out of memory'));
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    expect(r.seq.at(-1)).toEqual({ type: 'projectFindings', state: 'error', error: 'out of memory' });
    expect(r.logs('error')).toEqual(['design issues: out of memory']);
  });

  it('FR-19.9 a finding opens its flow with the evidence highlighted (also without message ids); a gone entry point says so', async () => {
    const { c, r } = controller(shop.root);
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    const done = r.seq.at(-1)!;
    if (done.type !== 'projectFindings' || done.state !== 'done') throw new Error(JSON.stringify(done));
    const pf = done.findings!.find((f) => f.finding.messageIds?.length)!;
    await c.onSequenceMessage({ type: 'openFinding', entryPoint: pf.entryPoint, finding: pf.finding });
    expect(lastRender(r.seq).root.key).toBe(pf.entryPoint.method.key);
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: pf.finding.messageIds![0], messageIds: pf.finding.messageIds, finding: pf.finding });
    const { messageIds: _ids, ...bare } = pf.finding;
    await c.onClassMessage({ type: 'openFinding', entryPoint: pf.entryPoint, finding: bare }); // from the codebase map
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: null, messageIds: [], finding: bare });

    const gone = { ...pf.entryPoint, method: { ...pf.entryPoint.method, key: 'src/presentation/gone.ts#Gone.run' } };
    await c.onSequenceMessage({ type: 'openFinding', entryPoint: gone, finding: pf.finding });
    expect(r.seq.at(-1)).toEqual({ type: 'empty', reason: 'That entry point no longer exists. ' + NO_METHOD_REASON });
    vi.spyOn(DiagramSession.prototype, 'openFinding').mockRejectedValueOnce(new Error('sidecar gone'));
    await c.onSequenceMessage({ type: 'openFinding', entryPoint: pf.entryPoint, finding: pf.finding });
    expect(r.seq.at(-1)).toEqual({ type: 'error', message: 'sidecar gone' });
  });

  it('FR-16.2 an entry point that is gone, or fails to open, says so in the view', async () => {
    const { c, r } = controller(shop.root);
    await c.onSequenceMessage({ type: 'requestEntryPoints' });
    await c.onSequenceMessage({ type: 'openMethod', methodKey: 'src/presentation/gone.ts#Gone.run' });
    expect(r.seq.at(-1)).toEqual({ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON });
    vi.spyOn(DiagramSession.prototype, 'openMethodByKey').mockRejectedValueOnce(new Error('sidecar gone'));
    await c.onSequenceMessage({ type: 'openMethod', methodKey: 'src/presentation/orders.controller.ts#OrdersController.show' });
    expect(r.seq.at(-1)).toEqual({ type: 'error', message: 'sidecar gone' });
    expect(r.logs('error')).toEqual(['open entry point: sidecar gone']);
  });

  it('FR-16.2 the entry points of the diagram\'s project, not of the IDE\'s project folder', async () => {
    const { c, r } = controller(SAMPLE_APP);
    const file = shop.file('src/presentation/orders.controller.ts');
    await c.openAt(file, positionOf(file, 'return new OrderService().place()'));
    await c.onSequenceMessage({ type: 'requestEntryPoints' });
    const list = r.seq.at(-1);
    expect(list?.type === 'entryPoints' && [list.project, list.entryPoints.map((e) => e.label)]).toEqual([SHOP, ['GET /orders', 'GET /orders/:id', 'GET /orders/count']]);
  });

  it('FR-16.2 / FR-19.9 an entry point or a finding opens in the diagram\'s project when no list was asked for', async () => {
    const { c, r } = controller(undefined);
    const file = shop.file('src/presentation/orders.controller.ts');
    await c.openAt(file, positionOf(file, 'return new OrderService().place()'));
    await c.onSequenceMessage({ type: 'openMethod', methodKey: 'src/presentation/orders.controller.ts#OrdersController.list' });
    expect(lastRender(r.seq).root.name).toBe('list');
    const show = { key: 'src/presentation/orders.controller.ts#OrdersController.show', name: 'show', owner: { key: 'src/presentation/orders.controller.ts#OrdersController', name: 'OrdersController', kind: 'class' as const }, isStatic: false, hasBody: true };
    await c.onSequenceMessage({ type: 'openFinding', entryPoint: { kind: 'http', label: 'GET /orders/:id', method: show }, finding: { id: 'f', kind: 'god-class', title: 'God class: OrdersController' } });
    expect(lastRender(r.seq).root.name).toBe('show');
  });
});

describe('HeadlessController: the codebase map (FR-26)', () => {
  it('FR-26.5 throttled progress, then the level; a rescan with packages open; cancelled from the view; a failure', async () => {
    const { c, r } = controller(shop.root);
    freezeClock();
    await c.onClassMessage({ type: 'requestAppMap', path: '' });
    const maps = ofClass(r.cls, 'appMap');
    const running = maps.filter((m) => m.state === 'running');
    const done = maps.at(-1)!;
    if (done.state !== 'done') throw new Error(JSON.stringify(done));
    const total = running.at(-1)!.total!;
    expect(running.map((m) => m.done)).toEqual([0, 1, total]);
    expect(running[0]).toEqual({ type: 'appMap', state: 'running', done: 0, project: SHOP });
    expect(done.level!.entryPoints).toBe(total);

    const spy = vi.spyOn(DiagramSession.prototype, 'getAppMap');
    await c.onClassMessage({ type: 'requestAppMap', path: 'src', rescan: true, open: ['src/application'] });
    expect(spy).toHaveBeenCalledWith('src', expect.objectContaining({ rescan: true, open: ['src/application'], entryPoints: undefined }));
    expect(ofClass(r.cls, 'appMap').at(-1)).toMatchObject({ state: 'done', project: SHOP });

    r.sink.postClass = (m) => {
      r.cls.push(m);
      if (m.type === 'appMap' && m.state === 'running' && m.done === 1) void c.onClassMessage({ type: 'cancelAppMap' });
    };
    await c.onClassMessage({ type: 'requestAppMap', rescan: true });
    expect(r.cls.at(-1)).toEqual({ type: 'appMap', state: 'cancelled', project: SHOP });
    r.sink.postClass = (m) => void r.cls.push(m);
    await c.onClassMessage({ type: 'requestAppMap' }); // the cancel was for that map only
    expect(r.cls.at(-1)).toMatchObject({ type: 'appMap', state: 'done' });

    spy.mockRejectedValueOnce(new Error('too big'));
    await c.onClassMessage({ type: 'requestAppMap' });
    expect(r.cls.at(-1)).toEqual({ type: 'appMap', state: 'error', error: 'too big', project: SHOP });
    expect(r.logs('error')).toEqual(['codebase map: too big']);
  });
});

describe('HeadlessController: paths to here and find (FR-22, FR-23)', () => {
  it('FR-22.2 throttled progress; cancelled from the view; a failure says why', async () => {
    const { c, r } = controller();
    await c.openAt(REPOSITORY, positionOf(REPOSITORY, 'const rows'));
    freezeClock();
    await c.onSequenceMessage({ type: 'requestPaths', messageId: 'root' });
    const paths = of(r.seq, 'paths');
    expect(paths.map((m) => m.state)).toEqual(['running', 'running', 'done']);
    expect(paths[1]).toEqual({ type: 'paths', messageId: 'root', state: 'running', methods: 1 });

    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'paths' && m.state === 'running' && m.methods === 1) void c.onSequenceMessage({ type: 'cancelPaths' });
    };
    await c.onSequenceMessage({ type: 'requestPaths', messageId: 'root' });
    expect(r.seq.at(-1)).toEqual({ type: 'paths', messageId: 'root', state: 'cancelled' });
    r.sink.postSequence = (m) => void r.seq.push(m);
    await c.onSequenceMessage({ type: 'requestPaths', messageId: 'root' }); // the cancel was for that walk only
    expect(r.seq.at(-1)).toMatchObject({ type: 'paths', messageId: 'root', state: 'done' });

    vi.spyOn(DiagramSession.prototype, 'findPathsToHere').mockRejectedValueOnce(new Error('references failed'));
    await c.onSequenceMessage({ type: 'requestPaths', messageId: 'root' });
    expect(r.seq.at(-1)).toEqual({ type: 'paths', messageId: 'root', state: 'error', error: 'references failed' });
    expect(r.logs('error')).toEqual(['paths to here: references failed']);
  });

  it('FR-23.2 find: throttled progress, the hits (deeper when asked); a newer query or closing the bar drops the older result', async () => {
    const { c, r } = controller();
    await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
    freezeClock();
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'query' });
    const results = of(r.seq, 'searchResults');
    expect(results.map((m) => m.state)).toEqual(['running', 'done']);
    expect(results[0]).toEqual({ type: 'searchResults', query: 'query', state: 'running', methods: 1 });
    expect(results[1]).toMatchObject({ query: 'query', state: 'done', truncated: false });
    expect(results[1]).not.toHaveProperty('deeper');
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'query', deeper: true });
    expect(r.seq.at(-1)).toMatchObject({ type: 'searchResults', query: 'query', state: 'done', deeper: true });
    // FR-23.3 a hit below a call that is no longer drawn, a path to a method that is gone
    const hit = results[1].hits![0];
    const n = r.seq.length;
    await c.onSequenceMessage({ type: 'revealSearchHit', hit: { ...hit!, anchorId: 'root/9:gone' } });
    expect(r.seq.length).toBe(n);
    await c.onSequenceMessage({ type: 'openPath', steps: [{ methodKey: 'src/controllers/gone.ts#Gone.run' }] });
    expect(r.seq.slice(n)).toEqual([{ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON }]);

    // a newer query while the first one runs: only the newer one is answered
    const before = r.seq.length;
    const first = c.onSequenceMessage({ type: 'searchCollapsed', query: 'save' });
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'query' });
    await first;
    expect(of(r.seq.slice(before), 'searchResults').filter((m) => m.state !== 'running').map((m) => [m.query, m.state])).toEqual([['query', 'done']]);
  });

  it('FR-23.2 a search closed while it runs stops searching (no more progress of it)', async () => {
    const { c, r } = controller();
    await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
    let now = Date.parse('2026-01-05T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000)); // every progress report passes the throttle
    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'searchResults' && m.state === 'running' && m.methods === 1) void c.onSequenceMessage({ type: 'cancelSearch' });
    };
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'nothing-matches', deeper: true });
    expect(of(r.seq, 'searchResults')).toEqual([{ type: 'searchResults', query: 'nothing-matches', state: 'running', methods: 1 }]);
    // not closed: it searches on (more methods, more reports)
    r.sink.postSequence = (m) => void r.seq.push(m);
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'nothing-matches', deeper: true });
    expect(of(r.seq, 'searchResults').filter((m) => m.state === 'running').length).toBeGreaterThan(2);
  });

  it('FR-23.2 a search closed after its last method: its result is dropped; a failed search reports only while it is current', async () => {
    const { c, r } = controller();
    // one collapsed call with a body and nothing below it: the search ends after its first (and only) progress report
    const q = tempProject('find', { 'tsconfig.json': TSCONFIG, 'src/invoice.ts': 'export class Invoice {\n  total(): number {\n    return this.sum();\n  }\n  sum(): number {\n    return 1;\n  }\n}\n' });
    cleanups.push(() => q.rm());
    await c.openAt(q.file('src/invoice.ts'), positionOf(q.file('src/invoice.ts'), 'return this.sum()'));
    freezeClock();
    r.sink.postSequence = (m) => {
      r.seq.push(m);
      if (m.type === 'searchResults' && m.state === 'running') void c.onSequenceMessage({ type: 'cancelSearch' });
    };
    const before = r.seq.length;
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'sum' });
    expect(r.seq.slice(before)).toEqual([{ type: 'searchResults', query: 'sum', state: 'running', methods: 1 }]);
    r.sink.postSequence = (m) => void r.seq.push(m);

    const spy = vi.spyOn(DiagramSession.prototype, 'searchCollapsed').mockRejectedValueOnce(new Error('index broken'));
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'sum' });
    expect(r.seq.at(-1)).toEqual({ type: 'searchResults', query: 'sum', state: 'error', error: 'index broken' });
    spy.mockImplementationOnce(async () => {
      await c.onSequenceMessage({ type: 'cancelSearch' }); // closed while it ran
      throw new Error('index broken');
    });
    const n = r.seq.length;
    await c.onSequenceMessage({ type: 'searchCollapsed', query: 'sum' });
    expect(r.seq.length).toBe(n);
    expect(r.logs('error')).toEqual(['find: index broken', 'find: index broken']);
  });
});

describe('HeadlessController: the ⌂ filter\'s method search (FR-16.15)', () => {
  it('FR-16.15 answers with the project\'s methods named so', async () => {
    const p = sampleAppCopy();
    cleanups.push(() => p.rm());
    const { c, r } = controller(p.root);
    await c.onSequenceMessage({ type: 'searchMethods', query: 'audit persist' });
    const last = r.seq.at(-1)!;
    expect(last.type === 'methodResults' && [last.query, last.methods.map((m) => m.key.replace(/^.*#/, '')), last.more]).toEqual(['audit persist', ['AuditEntry.persist'], 0]);
  });
});

describe('HeadlessController: git (FR-24.13)', () => {
  it('FR-24.13 a project without git history: empty git lists; a failure says why', async () => {
    const p = sampleAppCopy();
    cleanups.push(() => p.rm());
    const { c, r } = controller(p.root);
    await c.onSequenceMessage({ type: 'requestGitRefs' });
    expect(r.seq.at(-1)).toMatchObject({ type: 'gitRefs', refs: { branches: [], tags: [], commits: [] } });
    vi.spyOn(DiagramSession.prototype, 'gitRefs').mockRejectedValueOnce(new Error('git crashed'));
    await c.onSequenceMessage({ type: 'requestGitRefs' });
    expect(r.seq.at(-1)).toEqual({ type: 'gitRefs', error: 'git crashed' });
  });
});
