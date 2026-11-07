import { describe, expect, it } from 'vitest';
import type { MethodRef } from '@seqcall/protocol';
import { at, call, cls, fakeSession, meth } from './fake-world';

// FR-1.1 / FR-1.3 / FR-3 / FR-4.3 opening, history and expanding in odd orders, on an adapter answering from tables.
const shop = cls('src/Shop.cs', 'Shop');
const repo = cls('src/Repo.cs', 'Repo');
const order = meth(shop, 'Order');
const load = meth(repo, 'Load');
const save = meth(repo, 'Save');
const leaf = meth(repo, 'Leaf');
const world = () => ({ methods: [order, load, save, leaf], calls: { [order.key]: [call(0, load), call(1, save)], [load.key]: [call(0, leaf)] } });
const ids = (d: { messages: { id: string }[] } | undefined) => d?.messages.map((m) => m.id);

describe('FR-1.1 / FR-1.3 opening', () => {
  it('FR-1.1 no method around the cursor: no diagram, the session stays empty', async () => {
    const s = fakeSession(world());
    expect(await s.openAt('/p/src/Readme.md', { line: 0, character: 0 })).toBeUndefined();
    expect(s.current()).toBeUndefined();
  });

  it('FR-1.3 a default depth deeper than the flow: opening stops at the last level', async () => {
    const s = fakeSession(world(), { deps: { defaultDepth: 5 } });
    expect(ids(await s.openMethodByKey(order.key))).toEqual(['root', 'root/0:Load', 'root/0:Load/0:Leaf', 'root/1:Save']);
  });

  it('FR-19.9 opening a project finding whose method is gone: no diagram, the current one stays', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(order.key);
    const gone = meth(shop, 'Removed');
    expect(await s.openFinding({ kind: 'http', label: 'GET /gone', method: gone })).toBeUndefined();
    expect(s.current()!.root.key).toBe(order.key);
  });

  it('FR-3.1 / FR-3.2 / FR-3.3 / FR-1.12 / FR-8 before anything is open: no operation draws anything', async () => {
    const s = fakeSession(world());
    expect(await s.collapse('root/0:Load')).toBeUndefined();
    expect(await s.expandEverything()).toBeUndefined();
    expect(await s.expandAll()).toBeUndefined();
    expect(await s.collapseAll()).toBeUndefined();
    expect(await s.collapseFragment('root#opt0@0')).toBeUndefined();
    expect(await s.selectImplementation('root/0:Load', repo.key)).toBeUndefined();
    expect(await s.revertImplementation('root/0:Load')).toBeUndefined();
    expect(await s.getCallers('root')).toEqual([]);
    expect(s.current()).toBeUndefined();
  });

  it('FR-3.7 / FR-1.12 / FR-8 / FR-4.1 ids that name nothing, and choices for calls that are no interface calls, change nothing', async () => {
    const lib = { key: 'lib:Logging#Logger.Info', name: 'Info', owner: { key: 'lib:Logging#Logger', name: 'Logger', kind: 'external' as const }, isStatic: false, hasBody: false };
    const s = fakeSession(
      // the adapter would list callers of the library method too: the session does not ask
      { ...world(), calls: { ...world().calls, [order.key]: [call(0, load), call(1, save), call(2, lib, { isLibrary: true })] }, callers: { [lib.key]: [{ id: 'c', enclosing: order, range: at('src/Shop.cs', 3), preview: 'log.Info()' }] } },
      { options: { showLibraryCalls: true } },
    );
    const d = (await s.openMethodByKey(order.key))!;
    const before = ids(d);
    expect(ids(await s.expandEverything('root/9:Nope'))).toEqual(before);
    expect(ids(await s.collapseFragment('root#nope'))).toEqual(before);
    // Load is a plain call: no implementation to choose or revert
    expect(ids(await s.selectImplementation('root/0:Load', repo.key))).toEqual(before);
    expect(ids(await s.revertImplementation('root/0:Load'))).toEqual(before);
    // callers of a library method or of nothing: none asked
    expect(await s.getCallers('root/2:Info')).toEqual([]);
    expect(await s.getCallers('root/9:Nope')).toEqual([]);
    // nothing of it is kept in the state a share would carry (FR-25.2)
    const snap = (await s.exportState({ language: 'csharp' }))!;
    expect([snap.expanded, snap.choices, snap.interfaceChoices, snap.collapsedFragments]).toEqual([[], {}, {}, undefined]);
  });

  it('FR-3.7 Expand all below a call stops at the diagram\'s render limit (2000 messages), also when the call\'s own budget has room', async () => {
    const wide = meth(repo, 'Wide');
    const s = fakeSession({ methods: [order, wide, leaf], calls: { [order.key]: [...Array.from({ length: 1990 }, (_, i) => call(i, leaf)), call(1990, wide)], [wide.key]: Array.from({ length: 30 }, (_, i) => call(i, leaf)), [leaf.key]: [] } });
    await s.openMethodByKey(order.key);
    const d = (await s.expandEverything('root/1990:Wide'))!;
    expect(d.messages.length).toBe(1992);
    expect(d.expandNotice).toMatchObject({ reason: 'messages', folded: 1 });
  });

  it('FR-3.3 Expand all stopped by the message budget says so: the messages drawn, the calls still folded', async () => {
    const wide = meth(repo, 'Wide');
    const s = fakeSession({ methods: [order, wide, leaf], calls: { [order.key]: Array.from({ length: 30 }, (_, i) => call(i, wide)), [wide.key]: Array.from({ length: 30 }, (_, i) => call(i, leaf)), [leaf.key]: [call(0, load)] } });
    await s.openMethodByKey(order.key);
    const d = (await s.expandEverything())!;
    expect(d.expandNotice).toMatchObject({ reason: 'messages', limit: 500 });
    expect(d.expandNotice!.folded).toBeGreaterThan(0);
    expect(d.messages.length).toBe(d.expandNotice!.messages);
  });
});

describe('FR-4.3 history', () => {
  it('FR-4.3 Back at the first diagram and Forward at the last stay where they are', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(order.key);
    expect((await s.back())!.root.key).toBe(order.key);
    expect((await s.forward())!.root.key).toBe(order.key);
  });

  it('FR-4.3 the history keeps the last 50 diagrams', async () => {
    const many: MethodRef[] = Array.from({ length: 51 }, (_, i) => meth(shop, `Step${i}`));
    const s = fakeSession({ methods: many });
    for (const m of many) await s.openMethodByKey(m.key);
    let d = s.current()!;
    for (let i = 0; i < 60; i++) d = (await s.back())!;
    // Step0 fell out
    expect(d.root.name).toBe('Step1');
    expect(d.canGoBack).toBe(false);
  });

  it('FR-4.3 Back to a method that no longer exists: its last known diagram', async () => {
    let gone = false;
    const methods = new Map([order, load, save, leaf, meth(shop, 'Other')].map((m) => [m.key, m]));
    const s = fakeSession({ ...world(), adapter: { getMethod: async (k: string) => (gone && k === order.key ? undefined : methods.get(k)) } });
    await s.openMethodByKey(order.key);
    await s.openMethodByKey(`${shop.key}.Other`);
    gone = true;
    const d = (await s.back())!;
    expect([d.root.key, ids(d)]).toEqual([order.key, ['root', 'root/0:Load', 'root/1:Save']]);
  });
});

describe('FR-24.3 opening a review issue\'s flow', () => {
  const finding = { id: 'f', kind: 'io-in-loop' as const, title: 'I/O in a loop' };
  it('FR-24.3 from its entry point or its changed method, expanded fully; without either the current diagram; a method gone: none', async () => {
    const s = fakeSession(world());
    expect(await s.openReviewFlow({ finding, where: 'changed-lines' })).toBeUndefined();
    const fromEntry = (await s.openReviewFlow({ finding, where: 'changed-lines', entryPoint: { kind: 'http', label: 'POST /order', method: order } }))!;
    expect([fromEntry.root.key, ids(fromEntry), fromEntry.entryPoints?.map((e) => e.label)]).toEqual([order.key, ['root', 'root/0:Load', 'root/0:Load/0:Leaf', 'root/1:Save'], ['POST /order']]);
    await s.openMethodByKey(load.key);
    const fromMethod = (await s.openReviewFlow({ finding, where: 'changed-class', methodKey: order.key }))!;
    expect([fromMethod.root.key, ids(fromMethod), fromMethod.entryPoints]).toEqual([order.key, ['root', 'root/0:Load', 'root/0:Load/0:Leaf', 'root/1:Save'], undefined]);
    expect((await s.openReviewFlow({ finding, where: 'changed-class' }))!.root.key).toBe(order.key);
    expect(await s.openReviewFlow({ finding, where: 'changed-class', methodKey: `${shop.key}.Removed` })).toBeUndefined();
  });
});
