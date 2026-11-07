import { describe, expect, it } from 'vitest';
import type { EntryPoint, MethodRef } from '@seqcall/protocol';
import type { CallSite } from '../src/adapter';
import { call, cls, fakeSession, meth, type World } from './fake-world';

// FR-17.5 / the background step after a render (I/O below collapsed calls, entry-point tags, the issues
// of the fully expanded flow) while the developer keeps clicking: any render meanwhile makes the step's result stale.
// ShopController.Get → Orders.Place → Repo.Save → Orders.Back: a dependency cycle only the expanded flow shows.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const svc = cls('src/App/Orders.cs', 'Orders');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const place = meth(svc, 'Place');
const back = meth(svc, 'Back');
const save = meth(repo, 'Save');
const other = meth(ctl, 'List');
const CYCLE = 'Dependency cycle: Orders → Repo → Orders';
const calls = { [get.key]: [call(0, place)], [place.key]: [call(0, save)], [save.key]: [call(0, back)] };

/** A gate an adapter answer waits for (opened by the test); `reached` resolves when an answer starts waiting. */
function gate() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (arrive = r));
  return { opened, open, reached, arrive };
}
/** The adapter answers of `kind` wait for the gate from their `nth` request on (1-based). */
function gated(nth: number, g: { opened: Promise<void>; arrive(): void }, answer: (...a: never[]) => Promise<unknown>) {
  let n = 0;
  return async (...a: never[]) => {
    if (++n >= nth) {
      g.arrive();
      await g.opened;
    }
    return answer(...a);
  };
}
const methods = new Map([get, place, back, save, other].map((m) => [m.key, m]));
const world = (adapter: World['adapter'] = {}, extra: Partial<World> = {}): World => ({ methods: [...methods.values()], calls, ...extra, adapter });
const OFF = { options: { scanSideEffects: false } };

describe('issues below collapsed calls', () => {
  it('FR-19.7 before a diagram is open there is nothing to scan', async () => {
    expect(await fakeSession(world()).scanSideEffects()).toBeUndefined();
  });

  it('FR-19.7 the issues of the expanded flow arrive with the background step', async () => {
    const s = fakeSession(world(), OFF);
    await s.openMethodByKey(get.key);
    expect((await s.scanSideEffects())!.issuesBelow).toEqual({ count: 1, titles: [CYCLE] });
  });

  it('FR-19.7 with I/O on: the I/O step re-renders without a visible change (bodies read, no I/O in them) — the issues below still arrive', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(get.key);
    expect((await s.scanSideEffects())!.issuesBelow).toEqual({ count: 1, titles: [CYCLE] });
  });

  it('FR-19.7 a render while the flow is opened in the background: no result, the flow is not expanded; the next scan asks again', async () => {
    const g = gate();
    const asked: string[] = [];
    // the second request for the root method is the background session's
    const s = fakeSession(world({ getMethod: gated(2, g, async (k: string) => methods.get(k)), getOutgoingCalls: async (m: MethodRef) => (asked.push(m.name), calls[m.key] ?? []) }), OFF);
    await s.openMethodByKey(get.key);
    const scan = s.scanSideEffects();
    await g.reached;
    await s.expand('root/0:Place');
    asked.length = 0;
    g.open();
    expect(await scan).toBeUndefined();
    expect(s.current()!.issuesBelow).toBeUndefined();
    // the background session opened the root (its body, its calls' bodies) and stopped there
    expect(asked).toEqual(['Get', 'Place']);
    // asked again: computed now (the render's flow; the cycle is drawn up to Save)
    expect((await s.scanSideEffects())!.issuesBelow).toEqual({ count: 1, titles: [CYCLE] });
  });

  it('FR-19.7 a render while the background flow expands, or while its own I/O step runs: no result', async () => {
    const expanding = gate();
    let lists = 0;
    // Save's body is first read when the background session expands Place
    const s = fakeSession(world({ getOutgoingCalls: async (m: MethodRef) => (m.key === save.key && (expanding.arrive(), await expanding.opened), calls[m.key] ?? []), getEntryPoints: async () => (lists++, [] as EntryPoint[]) }), OFF);
    await s.openMethodByKey(get.key);
    const scan = s.scanSideEffects();
    await expanding.reached;
    await s.collapseAll();
    expanding.open();
    expect(await scan).toBeUndefined();

    // the background session's own I/O step did not run (it would ask for the entry-point list)
    expect(lists).toBe(1);

    const scanning = gate();
    let opened = 0;
    // the entry-point list: asked by this session's step first, by the background session's I/O step second
    const t = fakeSession(world({ getEntryPoints: gated(2, scanning, async () => [] as EntryPoint[]), getMethod: async (k: string) => (opened++, methods.get(k)) }), OFF);
    await t.openMethodByKey(get.key);
    const scan2 = t.scanSideEffects();
    await scanning.reached;
    await t.collapseAll();
    scanning.open();
    expect(await scan2).toBeUndefined();
    expect(t.current()!.issuesBelow).toBeUndefined();
    // nothing kept from the stale walk: the next step opens the flow in the background again
    const before = opened;
    expect((await t.scanSideEffects())!.issuesBelow).toEqual({ count: 1, titles: [CYCLE] });
    expect(opened).toBe(before + 1);
  });

  it('FR-19.7 the background flow fails (the adapter breaks): no result, the diagram stays', async () => {
    let broken = false;
    const s = fakeSession(world({ getOutgoingCalls: async (m: MethodRef) => (broken && m.key === save.key ? Promise.reject(new Error('sidecar gone')) : calls[m.key] ?? []) }), OFF);
    const d = (await s.openMethodByKey(get.key))!;
    broken = true;
    expect(await s.scanSideEffects()).toBeUndefined();
    expect(s.current()).toEqual(d);
  });
});

describe('FR-17.5 / FR-16.3 the I/O step', () => {
  it('FR-16.3 with I/O off the step still tags a root that is an entry point, unless a render came first', async () => {
    const entry: EntryPoint = { kind: 'http', label: 'GET /shop', method: get };
    // a flow without issues below: only the tag can change
    const s = fakeSession(world({}, { entryPoints: [entry], calls: { [get.key]: [call(0, place)] } }), { options: { showSideEffects: false } });
    expect((await s.openMethodByKey(get.key))!.entryPoints).toBeUndefined();
    expect((await s.scanSideEffects())!.entryPoints!.map((e) => e.label)).toEqual(['GET /shop']);

    const g = gate();
    const t = fakeSession(world({ getEntryPoints: gated(1, g, async () => [entry]) }), { options: { showSideEffects: false } });
    await t.openMethodByKey(get.key);
    const scan = t.scanSideEffects();
    await g.reached;
    await t.expand('root/0:Place');
    g.open();
    expect(await scan).toBeUndefined();
  });

  it('FR-17.5 a render queued before the re-render of the I/O step: the step\'s re-render is dropped', async () => {
    const g = gate();
    // the I/O step's last read: Back's body (below Save)
    const lastRead = gate();
    const s = fakeSession(
      world({ getMethod: async (k: string) => (k === other.key && (await g.opened), methods.get(k)), getOutgoingCalls: async (m: MethodRef) => (m.key === back.key && lastRead.arrive(), calls[m.key] ?? []) }),
      { options: { scanSideEffects: true } },
    );
    await s.openMethodByKey(get.key);
    // a user step waiting for the adapter holds the queue; the I/O step reads the bodies below and queues its re-render
    const opening = s.openMethodByKey(other.key);
    const scan = s.scanSideEffects();
    await lastRead.reached;
    // its answer and the queueing that follows: no more waiting on the adapter
    await new Promise((r) => setImmediate(r));
    g.open();
    expect((await opening)!.root.key).toBe(other.key);
    expect(await scan).toBeUndefined();
  });

  const pool = { key: 'lib:pg#Pool', name: 'Pool', kind: 'external' as const };
  const query = { key: 'lib:pg#Pool.query', name: 'query', owner: pool, isStatic: false, hasBody: false };
  const db = (o = 0): CallSite => call(o, query, { isLibrary: true, libraryName: 'pg', methodName: 'query' });
  const iCheck = cls('src/App/ICheck.cs', 'ICheck', 'interface');
  const check = meth(iCheck, 'Check', { hasBody: false });
  const impl = (i: number) => meth(cls(`src/Infra/Check${i}.cs`, `Check${i}`), 'Check');
  /** Bodies the adapter was asked for. */
  let read: string[] = [];
  /** Methods whose implementations the adapter was asked for. */
  let implsAsked: string[] = [];
  const badge = async (w: World, open: (s: ReturnType<typeof fakeSession>) => Promise<unknown> = async () => undefined, id = 'root/0:Place') => {
    read = [];
    implsAsked = [];
    const s = fakeSession({
      ...w,
      adapter: {
        getOutgoingCalls: async (m: MethodRef) => (read.push(m.owner.name), w.calls?.[m.key] ?? []),
        getImplementations: async (m: MethodRef) => (implsAsked.push(m.key), w.impls?.[m.key] ?? []),
      },
    });
    await s.openMethodByKey(get.key);
    await open(s);
    const d = (await s.scanSideEffects()) ?? s.current()!;
    return d.messages.find((m) => m.id === id)!.sideEffects?.kinds;
  };

  it('FR-17.5 / FR-17.6 an interface call with up to four implementations shows the I/O they do; with more it is too open to judge', async () => {
    const w = (n: number): World => {
      // one of them abstract (no body to look into)
      const impls = [...Array.from({ length: n - 1 }, (_, i) => impl(i)), meth(cls('src/Infra/BaseCheck.cs', 'BaseCheck', 'abstract'), 'Check', { hasBody: false })];
      return { methods: [get, check, ...impls], calls: { [get.key]: [call(0, check)], ...Object.fromEntries(impls.map((m) => [m.key, [db()]])) }, impls: { [check.key]: impls } };
    };
    expect(await badge(w(4), undefined, 'root/0:Check')).toEqual(['db']);
    // the abstract one has no body to read
    // (the background session opening the flow reads them too)
    expect([...new Set(read)].sort()).toEqual(['Check0', 'Check1', 'Check2', 'ShopController']);
    expect(await badge(w(5), undefined, 'root/0:Check')).toBeUndefined();
    // too open: their bodies are not read either
    expect([...new Set(read)]).toEqual(['ShopController']);
  });

  it('FR-17 / FR-11 an expanded call keeps the I/O of an interface call hidden under it', async () => {
    const one = impl(1);
    // (and a library call, hidden while library calls are off: its own I/O is the call's, not looked into)
    const w: World = { methods: [get, place, check, one], calls: { [get.key]: [call(0, place)], [place.key]: [call(0, check), call(1, save), db(2)], [one.key]: [db()] }, impls: { [check.key]: [one] } };
    expect(await badge(w, async (s) => {
      await s.expand('root/0:Place');
      await s.hide({ kind: 'methodName', methodName: 'Check' });
    })).toEqual(['db']);
    expect(implsAsked.some((k) => k.startsWith('lib:'))).toBe(false);
  });

  it('FR-17.5 I/O more than four calls below a collapsed call is not looked for', async () => {
    const chain = Array.from({ length: 6 }, (_, i) => meth(svc, `Step${i}`));
    const w = (depth: number): World => ({
      methods: [get, ...chain],
      calls: { [get.key]: [call(0, chain[0])], ...Object.fromEntries(chain.map((m, i) => [m.key, i === depth ? [db()] : i < chain.length - 1 ? [call(0, chain[i + 1])] : []])) },
    });
    expect(await badge(w(4), undefined, 'root/0:Step0')).toEqual(['db']);
    expect(await badge(w(5), undefined, 'root/0:Step0')).toBeUndefined();
  });

  it('FR-3.3 the notice of an Expand all stopped by its limit stays when the step re-renders', async () => {
    const wide = meth(repo, 'Wide');
    const w: World = { methods: [get, wide, save], calls: { [get.key]: Array.from({ length: 30 }, (_, i) => call(i, wide)), [wide.key]: Array.from({ length: 30 }, (_, i) => call(i, save)), [save.key]: [call(0, back)], [back.key]: [db()] } };
    const s = fakeSession(w);
    await s.openMethodByKey(get.key);
    const notice = (await s.expandEverything())!.expandNotice;
    expect(notice).toMatchObject({ reason: 'messages' });
    const after = (await s.scanSideEffects())!;
    expect(after.messages.some((m) => m.sideEffects)).toBe(true);
    expect(after.expandNotice).toEqual(notice);
  });

  it('FR-17.5 below a collapsed call, an interface call\'s implementations are looked up and their I/O shown', async () => {
    const one = impl(1);
    expect(await badge({ methods: [get, place, check, one], calls: { [get.key]: [call(0, place)], [place.key]: [call(0, check)], [one.key]: [db()] }, impls: { [check.key]: [one] } })).toEqual(['db']);
  });

  it('FR-17.5 an expanded call whose last calls are past the render limit keeps their I/O, an interface call\'s too', async () => {
    const one = impl(1);
    const leaf = meth(repo, 'Leaf');
    const w: World = { methods: [get, leaf, check, one], calls: { [get.key]: [...Array.from({ length: 2000 }, (_, i) => call(i, leaf)), call(2000, check)], [one.key]: [db()] }, impls: { [check.key]: [one] } };
    const s = fakeSession(w);
    const d = (await s.openMethodByKey(get.key))!;
    expect(d.messages.length).toBe(2000);
    expect(((await s.scanSideEffects()) ?? s.current()!).messages[0].sideEffects?.kinds).toEqual(['db']);
  });

  it('FR-17.5 a render while the step walks down: the walk stops', async () => {
    const g = gate();
    const asked: string[] = [];
    const s = fakeSession(world({ getOutgoingCalls: async (m: MethodRef) => (asked.push(m.name), m.key === save.key && (g.arrive(), await g.opened), calls[m.key] ?? []) }));
    await s.openMethodByKey(get.key);
    const scan = s.scanSideEffects();
    await g.reached;
    await s.collapseAll();
    asked.length = 0;
    g.open();
    expect(await scan).toBeUndefined();
    // Back's body (one level further) is not read
    expect(asked).toEqual([]);
  });

  it('FR-17.5 / FR-1.11 an opened closure (no method of its own) adds nothing hidden to its badge', async () => {
    const each = meth(svc, 'Each');
    const lambda = { kind: 'lambda' as const, range: { file: '/p/src/Api/ShopController.cs', start: { line: 7, character: 0 }, end: { line: 7, character: 5 } }, params: ['x'], calls: [call(0, save), db(1)] };
    const s = fakeSession({
      methods: [get, each, save],
      calls: { [get.key]: [call(0, each, { args: ['xs', 'x => …'], argFunctions: [undefined, lambda] })], [each.key]: [call(0, undefined, { methodName: 'f', invokedParameter: 'f', receiver: { kind: 'none' } } as Partial<CallSite>)] },
      adapter: { getParameterNames: async () => ['xs', 'f'] },
    });
    await s.openMethodByKey(get.key);
    await s.expand('root/0:Each');
    const d = (await s.expand('root/0:Each/0:f'))!;
    expect(d.messages.find((m) => m.id === 'root/0:Each/0:f')).toMatchObject({ expanded: true });
    // the step goes through: a closure gets no badge of its calls hidden below it (it has no body of its own)
    const after = (await s.scanSideEffects()) ?? s.current()!;
    expect(after.messages.find((m) => m.id === 'root/0:Each/0:f')!.sideEffects).toBeUndefined();
  });
});
