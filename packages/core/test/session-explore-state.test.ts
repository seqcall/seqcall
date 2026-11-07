import { describe, expect, it } from 'vitest';
import type { CallerInfo, SequenceDiagram } from '@seqcall/protocol';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';
import { C, K, method, newSession } from './helpers';

// FR-3 / FR-4 / FR-8 the exploration state of a session (expanded calls, implementation choices, minimized frames)
// through re-rooting, focus and choices, in orders a developer may click them.
const ids = (d: SequenceDiagram | undefined) => d!.messages.map((m) => `${m.id}${m.expanded ? '+' : ''}`);
const collapsedFrames = (d: SequenceDiagram | undefined) => (d!.fragments ?? []).filter((f) => f.collapsed).map((f) => f.id);

describe('FR-4.2 re-rooting carries the exploration below the call', () => {
  it('FR-4.2 from the root: the chosen implementation, its expansion and its minimized frame move below the call', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await s.selectImplementation('root/0:findById', C.SqlUserRepository);
    await s.expand('root/0:findById');
    await s.collapseFragment('root/0:findById#alt0@2');
    const caller = (await s.getCallers('root')).find((c) => c.enclosing.key === K.getUser)!;
    const d = await s.reroot('root', caller.id);
    expect(d!.root.key).toBe(K.getUser);
    expect(ids(d)).toContain('root/2:findUser/0:findById+');
    expect(ids(d)).toContain('root/2:findUser/0:findById/1:query');
    expect(collapsedFrames(d)).toEqual(['root/2:findUser/0:findById#alt0@2']);
  });

  const EXPORT_USER = 'src/services/export-service.ts#ExportService.exportUser';
  const nestedReroot = async (setup: (s: ReturnType<typeof newSession>) => Promise<unknown>) => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await setup(s);
    const caller = (await s.getCallers('root/0:findById')).find((c) => c.enclosing.key === EXPORT_USER)!;
    return (await s.reroot('root/0:findById', caller.id))!;
  };

  it('FR-4.2 from a nested call: the call\'s own minimized frame goes with it; the choice made for another call stays behind', async () => {
    const d = await nestedReroot(async (s) => {
      await s.selectImplementation('root/0:findById', C.SqlUserRepository);
      await s.expand('root/0:findById');
      await s.collapseFragment('root/0:findById#alt0@2');
      // the second lookup (`primary`) in another implementation
      await s.selectImplementation('root/1:findById', C.InMemoryUserRepository);
    });
    expect(d.root.key).toBe(EXPORT_USER);
    expect(ids(d)).toContain('root/3:findById+');
    expect(d.messages.find((m) => m.id === 'root/3:findById')!.polymorphic?.selectedKey).toBe(C.SqlUserRepository);
    expect(collapsedFrames(d)).toEqual(['root/3:findById#alt0@2']);
  });

  it('FR-4.2 from a nested call: a minimized frame of another call stays behind', async () => {
    const d = await nestedReroot(async (s) => {
      await s.selectImplementation('root/0:findById', C.SqlUserRepository);
      await s.selectImplementation('root/1:findById', C.SqlUserRepository);
      await s.expand('root/1:findById');
      await s.collapseFragment('root/1:findById#alt0@2');
    });
    expect(collapsedFrames(d)).toEqual([]);
  });
});

describe('FR-4.2 / FR-4.6 re-rooting and focus against an adapter answering from tables', () => {
  const ctl = cls('src/Api/ShopController.cs', 'ShopController');
  const svc = cls('src/App/Orders.cs', 'Orders');
  const repo = cls('src/Infra/Repo.cs', 'Repo');
  const get = meth(ctl, 'Get');
  const find = meth(svc, 'Find');
  const load = meth(repo, 'Load');
  const site = at('src/Api/ShopController.cs', 9, 4);
  const caller = (extra: Partial<CallerInfo> = {}): CallerInfo => ({ id: 'c1', enclosing: get, range: site, preview: 'orders.Find()', ...extra });
  const world = (extra: Partial<World> = {}): World => ({
    methods: [get, find, load],
    calls: { [get.key]: [call(0, find, { range: { ...site, end: { line: 9, character: 20 } } })], [find.key]: [call(0, load)], [load.key]: [call(0, meth(repo, 'Leaf'))] },
    callers: { [find.key]: [caller()] },
    ...extra,
  });

  it('FR-4.2 re-rooting without asking for the callers first; the call found by where it starts (its end differs)', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(find.key);
    await s.expand('root/0:Load');
    const d = await s.reroot('root', 'c1');
    expect(ids(d)).toEqual(['root+', 'root/0:Find+', 'root/0:Find/0:Load+', 'root/0:Find/0:Load/0:Leaf']);
  });

  it('FR-4.2 a caller that is not listed, or a caller method that is gone: the diagram as it was / the caller as the adapter named it', async () => {
    const s = fakeSession(world({ methods: [find, load] }));
    await s.openMethodByKey(find.key);
    expect(ids(await s.reroot('root', 'nope'))).toEqual(['root+', 'root/0:Load']);
    // Get is no longer known by key: the enclosing method of the caller list is used
    const d = await s.reroot('root', 'c1');
    expect([d!.root.key, ids(d)]).toEqual([get.key, ['root+', 'root/0:Find+', 'root/0:Find/0:Load']]);
  });

  it('FR-4.2 the call is not found at the caller\'s place (the file changed): the caller opens unexpanded', async () => {
    const s = fakeSession(world({ callers: { [find.key]: [caller({ range: at('src/Api/ShopController.cs', 30) })] } }));
    await s.openMethodByKey(find.key);
    await s.expand('root/0:Load');
    expect(ids(await s.reroot('root', 'c1'))).toEqual(['root+', 'root/0:Find']);
  });

  it('FR-4.2 re-rooting from a call collapsed meanwhile (its callers were listed before): the caller opens at that call', async () => {
    const loadSite = at('src/App/Orders.cs', 4);
    const s = fakeSession(world({ calls: { [get.key]: [call(0, find)], [find.key]: [call(0, load, { range: loadSite })], [load.key]: [call(0, meth(repo, 'Leaf'))] }, callers: { [load.key]: [{ id: 'c2', enclosing: find, range: loadSite, preview: 'repo.Load()' }] } }));
    await s.openMethodByKey(get.key);
    await s.expand('root/0:Find');
    expect((await s.getCallers('root/0:Find/0:Load')).map((c) => c.id)).toEqual(['c2']);
    await s.collapse('root/0:Find');
    const d = await s.reroot('root/0:Find/0:Load', 'c2');
    expect([d!.root.key, ids(d)]).toEqual([find.key, ['root+', 'root/0:Load+', 'root/0:Load/0:Leaf']]);
  });

  it('FR-4.5 a method passed to a call that never invokes it: the receiving call opens', async () => {
    const apply = meth(svc, 'Apply');
    const s = fakeSession({
      methods: [get, apply, load],
      calls: { [get.key]: [call(0, apply, { range: site })], [apply.key]: [call(0, meth(repo, 'Leaf'))] },
      callers: { [load.key]: [caller({ passed: true })] },
    });
    await s.openMethodByKey(load.key);
    expect(ids(await s.reroot('root', 'c1'))).toEqual(['root+', 'root/0:Apply+', 'root/0:Apply/0:Leaf']);
  });

  it('FR-4.6 focus on a chosen interface call: its implementation is the root; the choice made for it and frames elsewhere stay behind', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    // FR-3.12 Smart starts from closed: first the smart view, then the user's own changes on top of it
    await s.smartExpand();
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/0:findById', C.SqlUserRepository);
    await s.collapseFragment('root#loop0@6');
    const d = (await s.focus('root/2:findUser/0:findById'))!;
    expect([d.root.key, collapsedFrames(d)]).toEqual([K.sqlFindById, []]);
    const snap = (await s.exportState({ language: 'typescript' }))!;
    expect([snap.choices, snap.collapsedFragments]).toEqual([{}, undefined]);
  });

  it('FR-4.6 focus keeps the smart view and the choices and minimized frames below the call; a method gone by key is used as it was', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    // FR-3.12 Smart starts from closed: first the smart view, then the user's own changes on top of it
    await s.smartExpand();
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/0:findById', C.SqlUserRepository);
    await s.expand('root/2:findUser/0:findById');
    await s.collapseFragment('root/2:findUser/0:findById#alt0@2');
    // the other lookup in the other implementation (the last choice is the interface's default)
    await s.selectImplementation('root/2:findUser/1:findById', C.InMemoryUserRepository);
    const d = await s.focus('root/2:findUser');
    expect(d!.root.key).toBe(K.findUser);
    expect(ids(d)).toContain('root/0:findById+');
    expect(['root/0:findById', 'root/1:findById'].map((id) => d!.messages.find((m) => m.id === id)!.polymorphic?.selectedKey)).toEqual([C.SqlUserRepository, C.InMemoryUserRepository]);
    expect(collapsedFrames(d)).toEqual(['root/0:findById#alt0@2']);
    // still the smart view: importance marks on the messages
    expect(d!.messages.some((m) => m.importance)).toBe(true);

    const gone = fakeSession(world({ adapter: { getMethod: async (k: string) => (k === get.key ? get : undefined) } }));
    await gone.openMethodByKey(get.key);
    const f = await gone.focus('root/0:Find');
    expect([f!.root.key, ids(f)]).toEqual([find.key, ['root+', 'root/0:Load']]);
  });
});
