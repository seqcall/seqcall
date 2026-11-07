import { describe, expect, it } from 'vitest';
import type { SearchHit, SourceRange } from '@seqcall/protocol';
import { at, call, cls, fakeSession, meth } from './fake-world';
import { C, K, method, newSession } from './helpers';

// FR-23 the find bar below collapsed calls: searching before a diagram exists, deeper searches, and revealing hits
// whose path no longer matches the code.
const shop = cls('src/Shop.cs', 'Shop');
const step = (i: number) => meth(shop, `Step${i}`);
const chain = Array.from({ length: 7 }, (_, i) => step(i));
const target = meth(cls('src/Repo.cs', 'Repo'), 'Target');
const site = (i: number): SourceRange => at('src/Shop.cs', 10 + i);
// Step0 → Step1 → … → Step6 → Target
const world = () => ({
  methods: [...chain, target],
  calls: Object.fromEntries(chain.map((m, i) => [m.key, [call(0, i + 1 < chain.length ? chain[i + 1] : target, { range: site(i) })]])),
});

describe('FR-23.2 searching below collapsed calls', () => {
  it('FR-23.2 before a diagram is open there is nothing to search', async () => {
    expect(await fakeSession(world()).searchCollapsed('Target')).toEqual({ hits: [], methods: 0, truncated: false });
  });

  it('FR-23.2 a diagram of a method without a body (an interface method opened by hand) has nothing below to search', async () => {
    const port = meth(cls('src/IShop.cs', 'IShop', 'interface'), 'Run', { hasBody: false });
    const s = fakeSession({ methods: [port] });
    expect((await s.openMethodByKey(port.key))!.messages.map((m) => m.id)).toEqual(['root']);
    expect(await s.searchCollapsed('Run')).toEqual({ hits: [], methods: 0, truncated: false });
  });

  it('FR-23.2 a call six levels below: past the normal depth, found by the deeper search', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(chain[0].key);
    const normal = (await s.searchCollapsed('Target'))!;
    expect([normal.hits.length, normal.truncated]).toEqual([0, true]);
    const deeper = (await s.searchCollapsed('Target', { deeper: true }))!;
    expect(deeper.hits.map((h) => [h.anchorId, h.labels.join(' → '), h.hit.label])).toEqual([['root/0:Step1', 'Shop.Step1 → Shop.Step2 → Shop.Step3 → Shop.Step4 → Shop.Step5 → Shop.Step6', 'Repo.Target']]);
  });
});

describe('FR-23.3 revealing a hit', () => {
  const hit = (steps: SearchHit['steps']): SearchHit => ({ anchorId: 'root/0:Step1', steps, labels: [], hit: { label: 'Repo.Target', range: site(6) } });
  const path = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => ({ methodKey: chain[from + k].key, ...(from + k < to ? { call: { range: site(from + k) } } : {}) }));

  it('FR-23.3 down to the call: every step expanded, the call\'s id returned', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(chain[0].key);
    const r = (await s.revealSearchHit(hit([...path(1, 2).map((x, i) => (i === 1 ? { ...x, call: { range: site(2) } } : x))])))!;
    expect(r.messageId).toBe('root/0:Step1/0:Step2/0:Step3');
    expect(r.diagram!.messages.filter((m) => m.expanded).map((m) => m.id)).toEqual(['root', 'root/0:Step1', 'root/0:Step1/0:Step2']);
  });

  it('FR-23.3 a hit without steps, or below a message that is gone, reveals nothing', async () => {
    const s = fakeSession(world());
    expect(await s.revealSearchHit(hit(path(1, 2)))).toBeUndefined();
    await s.openMethodByKey(chain[0].key);
    expect(await s.revealSearchHit(hit([]))).toBeUndefined();
    expect(await s.revealSearchHit({ ...hit(path(1, 2)), anchorId: 'root/5:Gone' })).toBeUndefined();
  });

  it('FR-23.3 the code changed since the search: the path is opened as far as it still goes, the last message reached is returned', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(chain[0].key);
    // a step's method no longer exists (its call's place is not looked up in the step before)
    const gone = (await s.revealSearchHit(hit([{ methodKey: chain[1].key, call: { range: site(1) } }, { methodKey: `${shop.key}.Removed`, call: { range: site(1) } }])))!;
    expect(gone.messageId).toBe('root/0:Step1');
    // a step's call moved (not at its place any more)
    const moved = (await s.revealSearchHit(hit([{ methodKey: chain[1].key, call: { range: at('src/Shop.cs', 99) } }, { methodKey: chain[2].key }])))!;
    expect(moved.messageId).toBe('root/0:Step1');
    // the found call itself moved
    const last = (await s.revealSearchHit(hit([{ methodKey: chain[1].key, call: { range: site(1) } }, { methodKey: chain[2].key, call: { range: at('src/Shop.cs', 99) } }])))!;
    expect(last.messageId).toBe('root/0:Step1/0:Step2');
    // the found call is hidden by a filter: the message above it
    await s.hide({ kind: 'methodName', methodName: 'Step3' });
    const hidden = (await s.revealSearchHit(hit([{ methodKey: chain[1].key, call: { range: site(1) } }, { methodKey: chain[2].key, call: { range: site(2) } }])))!;
    expect(hidden.messageId).toBe('root/0:Step1/0:Step2');
    // a step without its call (an old hit's format): stops there
    const noCall = (await s.revealSearchHit(hit([{ methodKey: chain[1].key }, { methodKey: chain[2].key }])))!;
    expect(noCall.messageId).toBe('root/0:Step1');
  });

  it('FR-23.3 the hit\'s implementation is chosen at its call; the interface\'s default chosen elsewhere is dropped', async () => {
    const s = newSession();
    await s.openMethod(await method(K.rename));
    await s.expand('root/0:findUser');
    await s.revertImplementation('root/0:findUser/0:findById');
    // then in memory for `primary.save`: the default of UserRepository since (not for the reverted call)
    const d = (await s.selectImplementation('root/2:save', C.InMemoryUserRepository))!;
    expect(['root/0:findUser/0:findById', 'root/0:findUser/1:findById'].map((id) => d.messages.find((m) => m.id === id)!.polymorphic?.selectedKey)).toEqual([undefined, C.InMemoryUserRepository]);
    const found = (await s.searchCollapsed('query'))!.hits.find((h) => h.anchorId === 'root/0:findUser/0:findById')!;
    const r = (await s.revealSearchHit(found))!;
    // the other lookup had no choice of its own: none chosen again
    expect(['root/0:findUser/0:findById', 'root/0:findUser/1:findById', 'root/2:save'].map((id) => r.diagram!.messages.find((m) => m.id === id)!.polymorphic?.selectedKey)).toEqual([C.SqlUserRepository, undefined, C.InMemoryUserRepository]);
  });

  it('FR-23.3 a hit below an interface call without a chosen implementation chooses the implementation of the hit', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    // the other lookup in memory (the interface's default since), this one reverted to "none chosen"
    await s.selectImplementation('root/1:findById', C.InMemoryUserRepository);
    await s.revertImplementation('root/0:findById');
    const found = (await s.searchCollapsed('query'))!.hits.find((h) => h.anchorId === 'root/0:findById')!;
    expect(found.labels).toEqual(['SqlUserRepository.findById']);
    const { diagram, messageId } = (await s.revealSearchHit(found))!;
    expect(messageId).toBe('root/0:findById/1:query');
    expect(['root/0:findById', 'root/1:findById'].map((id) => diagram!.messages.find((m) => m.id === id)!.polymorphic?.selectedKey)).toEqual([C.SqlUserRepository, C.InMemoryUserRepository]);
  });
});

describe('FR-22 paths to here', () => {
  it('FR-22.2 for an unknown message or a library call there is no walk; for an interface call without a choice, the interface method\'s callers', async () => {
    const port = meth(cls('src/IRepo.cs', 'IRepo', 'interface'), 'Load', { hasBody: false });
    const impl = meth(cls('src/SqlRepo.cs', 'SqlRepo'), 'Load');
    const lib = { key: 'lib:Logging#Logger.Info', name: 'Info', owner: { key: 'lib:Logging#Logger', name: 'Logger', kind: 'external' as const }, isStatic: false, hasBody: false };
    const other = meth(shop, 'Other');
    const s = fakeSession(
      {
        methods: [chain[0], port, impl, other],
        calls: { [chain[0].key]: [call(0, port), call(1, lib, { isLibrary: true })] },
        impls: { [port.key]: [impl, meth(cls('src/MemRepo.cs', 'MemRepo'), 'Load')] },
        callers: { [port.key]: [{ id: 'c', enclosing: other, range: at('src/Shop.cs', 40), preview: 'repo.Load()' }] },
      },
      { options: { showLibraryCalls: true } },
    );
    await s.openMethodByKey(chain[0].key);
    expect(await s.findPathsToHere('root/7:Nope')).toBeUndefined();
    expect(await s.findPathsToHere('root/1:Info')).toBeUndefined();
    const r = (await s.findPathsToHere('root/0:Load'))!;
    expect([r.tree.method.key, r.tree.callers!.map((c) => c.method.key)]).toEqual([port.key, [other.key]]);
  });

  it('FR-22.3 opening a path: none without steps or with a start that is gone; it stops where a step no longer matches', async () => {
    const s = fakeSession(world());
    expect(await s.openPath([])).toBeUndefined();
    expect(await s.openPath([{ methodKey: `${shop.key}.Removed` }])).toBeUndefined();
    const r = (await s.openPath([{ methodKey: chain[0].key, call: { range: site(0) } }, { methodKey: chain[1].key, call: { range: site(1) } }, { methodKey: `${shop.key}.Removed` }]))!;
    expect([r.diagram!.root.key, r.messageId]).toEqual([chain[0].key, 'root/0:Step1']);
    // a step without the call to the next one
    const short = (await s.openPath([{ methodKey: chain[0].key }, { methodKey: chain[1].key }]))!;
    expect(short.messageId).toBe('root');
  });
});
