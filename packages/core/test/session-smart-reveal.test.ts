import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import type { CallSite } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';

// FR-3.6 Smart expand and FR-12.14 revealing a relation, on flows written per test: ShopController (Presentation) →
// Orders (Application) → Repo (Infrastructure); crossing calls score up, so the walk has something to choose.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const orders = cls('src/App/Orders.cs', 'Orders');
const fmt = cls('src/App/Fmt.cs', 'Fmt');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const place = meth(orders, 'Place');
const ship = meth(orders, 'Ship');
const apply = meth(orders, 'Apply');
const each = meth(orders, 'Each');
const plain = meth(fmt, 'Plain');
const save = meth(repo, 'Save');
const load = meth(repo, 'Load');
const LAYERS = [{ name: 'Presentation', match: ['src/Api/**'] }, { name: 'Application', match: ['src/App/**'] }, { name: 'Infrastructure', match: ['src/Infra/**'] }];
const smart = (w: World, budget: number) => fakeSession(w, { classifier: new DefaultClassifier('/p', { layers: LAYERS, smartExpand: { budget } } as never) });
const open = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.expanded).map((m) => m.id);

describe('FR-3.6 Smart expand', () => {
  it('FR-3.6 without a diagram, from an unknown call or from a call that cannot open: nothing changes', async () => {
    const w: World = { methods: [get, place, save], calls: { [get.key]: [call(0, place), call(1, save)], [place.key]: [call(0, save)] } };
    expect(await smart(w, 20).smartExpand()).toBeUndefined();
    const s = smart(w, 20);
    await s.openMethodByKey(get.key);
    expect(open(await s.smartExpand('root/7:Nope'))).toEqual(['root']);
    const leaf = (await s.smartExpand('root/1:Save'))!;
    expect(open(leaf)).toEqual(['root']);
    // not started: no importance marks
    expect(leaf.messages.some((m) => m.importance)).toBe(false);
  });

  it('FR-3.6 the more valuable of two calls opens first; the other no longer fits the budget', async () => {
    // Place reveals two crossing calls, Ship one
    const w: World = { methods: [get, place, ship, save, load], calls: { [get.key]: [call(0, ship), call(1, place)], [place.key]: [call(0, save), call(1, load)], [ship.key]: [call(0, save)] } };
    // 3 messages + Place's 2 fit into 5; Ship's 1 more does not
    expect(open(await (async () => { const s = smart(w, 5); await s.openMethodByKey(get.key); return s.smartExpand(); })())).toEqual(['root', 'root/1:Place']);
    // room for both
    expect(open(await (async () => { const s = smart(w, 6); await s.openMethodByKey(get.key); return s.smartExpand(); })())).toEqual(['root', 'root/0:Ship', 'root/1:Place']);
  });

  it('FR-3.6 a closure the opened method runs is opened first, unless its body exceeds the budget', async () => {
    // Get → Each(xs, x => { Save(); Load(); }): Each saves, and runs the lambda the controller wrote
    const lambda = { kind: 'lambda' as const, range: at('ShopController.cs', 7), params: ['x'], calls: [call(0, save), call(1, load)] };
    const w: World = {
      methods: [get, each, save, load],
      calls: { [get.key]: [call(0, each, { args: ['xs', 'x => …'], argFunctions: [undefined, lambda] })], [each.key]: [call(0, save), call(1, undefined, { methodName: 'f', invokedParameter: 'f', receiver: { kind: 'none' } } as Partial<CallSite>)] },
      adapter: { getParameterNames: async () => ['xs', 'f'] },
    };
    const tight = smart(w, 4);
    await tight.openMethodByKey(get.key);
    const d = (await tight.smartExpand())!;
    // Each opened (2 + 2 messages), the lambda's two calls would make 6
    expect(open(d)).toEqual(['root', 'root/0:Each']);
    expect(d.messages.find((m) => m.id === 'root/0:Each/1:f')).toMatchObject({ expandable: true, expanded: false });
    const roomy = smart(w, 6);
    await roomy.openMethodByKey(get.key);
    expect(open(await roomy.smartExpand())).toEqual(['root', 'root/0:Each', 'root/0:Each/1:f']);
  });

  it('FR-3.6 a call that draws more than its body lists (a delegate invoked as a library call, bound to a project method) is undone when it overshoots', async () => {
    // Apply(order, Fmt.Plain): its body saves, then invokes the delegate (`f.Invoke`, a library call) — Plain is drawn
    const invoke = call(1, undefined, { methodName: 'Invoke', invokedParameter: 'f', isLibrary: true, receiver: { kind: 'parameter', name: 'f' } } as Partial<CallSite>);
    const w: World = {
      methods: [get, apply, plain, save],
      calls: { [get.key]: [call(0, apply, { args: ['order', 'Fmt.Plain'], argFunctions: [undefined, { kind: 'method', target: plain, receiver: { kind: 'static' } as never, isLibrary: false }] })], [apply.key]: [call(0, save), invoke] },
      adapter: { getParameterNames: async () => ['order', 'f'] },
    };
    // the estimate (2 + Save) fits 3; drawn are Save and Plain: 4
    const s = smart(w, 3);
    await s.openMethodByKey(get.key);
    expect(open(await s.smartExpand())).toEqual(['root']);
    const roomy = smart(w, 4);
    await roomy.openMethodByKey(get.key);
    const d = (await roomy.smartExpand())!;
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/0:Apply', 'root/0:Apply/0:Save', 'root/0:Apply/1:Invoke']);
  });

  it('FR-3.6 what a call reveals: creations named by their class (from the type or the constructor), an unresolved one by its name; a library call by its I/O unless I/O is off', async () => {
    const invoice = cls('src/App/Invoice.cs', 'Invoice');
    const receipt = cls('src/App/Receipt.cs', 'Receipt');
    const pool = { key: 'lib:pg#Pool', name: 'Pool', kind: 'external' as const };
    const query = { key: 'lib:pg#Pool.query', name: 'query', owner: pool, isStatic: false, hasBody: false };
    const create = (o: number, extra: Partial<CallSite>) => call(o, undefined, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, ...extra });
    const w: World = {
      methods: [get, place, ship],
      calls: {
        [get.key]: [call(0, place), call(1, ship)],
        [place.key]: [create(0, { receiverType: invoice }), create(1, { target: meth(receipt, 'constructor', { hasBody: false }) }), create(2, { methodName: 'Mystery' })],
        // and a creation in another layer: a constructor, no crossing call
        [ship.key]: [call(0, query, { isLibrary: true, libraryName: 'pg', methodName: 'query' }), create(1, { receiverType: cls('src/Infra/Ledger.cs', 'Ledger') })],
      },
    };
    const reveals = async (options: Record<string, unknown>) => {
      const s = fakeSession(w, { options: { showLibraryCalls: true, ...options }, classifier: new DefaultClassifier('/p', { layers: LAYERS, smartExpand: { important: ['Invoice.constructor', 'Receipt.constructor', '*Mystery', 'Pool.query'] } } as never) });
      await s.openMethodByKey(get.key);
      const d = (await s.smartExpand())!;
      return ['root/0:Place', 'root/1:Ship'].map((id) => d.messages.find((m) => m.id === id)!.importance!.reasons.filter((r) => r.startsWith('↑ reveals')));
    };
    // a DB query is worth showing (configured important, does I/O)
    expect(await reveals({})).toEqual([['↑ reveals new Invoice, new Receipt, new Mystery'], ['↑ reveals query']]);
    // without I/O it is a plain library call
    expect(await reveals({ showSideEffects: false })).toEqual([['↑ reveals new Invoice, new Receipt, new Mystery'], []]);
  });
});

describe('FR-12.14 revealing a relation whose calls are folded', () => {
  const big = meth(repo, 'Big');
  const big2 = meth(repo, 'Big2');
  const leaf = meth(orders, 'Leaf');
  const many = (n: number) => Array.from({ length: n }, (_, i) => call(i, leaf));
  it('FR-12.14 without a diagram nothing is revealed', async () => {
    expect(await fakeSession({ methods: [get] }).revealRelation(repo.key, orders.key)).toEqual({ diagram: undefined, messageIds: [] });
  });

  it('FR-12.14 the calls into the source class are opened only while the diagram stays under its render limit', async () => {
    const s = fakeSession({ methods: [get, big, big2, leaf], calls: { [get.key]: [call(0, big), call(1, big2)], [big.key]: many(1200), [big2.key]: many(1200) } });
    await s.openMethodByKey(get.key);
    const r = await s.revealRelation(repo.key, orders.key);
    // Big fits (3 + 1200 messages), Big2 would pass 2000: Big's calls are the relation's
    expect(open(r.diagram)).toEqual(['root', 'root/0:Big']);
    expect([r.messageIds.length, r.messageIds[0]]).toEqual([1200, 'root/0:Big/0:Leaf']);
  });

  it('FR-12.14 a body too big to open: nothing revealed, the diagram as it was', async () => {
    const s = fakeSession({ methods: [get, big, leaf], calls: { [get.key]: [call(0, big)], [big.key]: many(2100) } });
    await s.openMethodByKey(get.key);
    const r = await s.revealRelation(repo.key, orders.key);
    expect([open(r.diagram), r.messageIds]).toEqual([['root'], []]);
  });
});
