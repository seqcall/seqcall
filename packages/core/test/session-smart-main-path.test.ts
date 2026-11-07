import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import type { EarlyExit, FragmentScope } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';

// FR-3.9 / FR-3.10 Smart expand follows the main path and stops when nothing worth opening is left: ShopController
// (Presentation) → Orders / Refunds (Application) → Repo (Infrastructure); crossing calls score up.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const orders = cls('src/App/Orders.cs', 'Orders');
const refunds = cls('src/App/Refunds.cs', 'Refunds');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const place = meth(orders, 'Place');
const ship = meth(orders, 'Ship');
const undo = meth(refunds, 'Undo');
const save = meth(repo, 'Save');
const load = meth(repo, 'Load');
const audit = meth(repo, 'Audit');
const LAYERS = [{ name: 'Presentation', match: ['src/Api/**'] }, { name: 'Application', match: ['src/App/**'] }, { name: 'Infrastructure', match: ['src/Infra/**'] }];
const smart = (w: World, smartExpand: Record<string, unknown> = {}) => fakeSession(w, { classifier: new DefaultClassifier('/p', { layers: LAYERS, smartExpand } as never) });
const open = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.expanded).map((m) => m.id);
const tryBlock: FragmentScope = { id: 'try@1', kind: 'try', operand: 0 };
const catchClause: FragmentScope = { id: 'try@1', kind: 'try', operand: 1, guard: 'catch DbException' };
const invalid: FragmentScope = { id: 'if@5', kind: 'opt', operand: 0, guard: '!order.isValid' };

describe('FR-3.9 Smart expand follows the main path', () => {
  it('FR-3.9 / FR-3.11 a try whose catches all fold loses its frame: each catch is a marker after the block, with what it does with the error', async () => {
    // try { Place(); } catch (DbException) { Undo(); throw; } catch (Exception) { log; }
    const handlers = [
      { operand: 1, guard: 'catch DbException', outcome: 'rethrow' as const, logged: false, range: at('ShopController.cs', 20) },
      { operand: 2, guard: 'catch Exception', outcome: 'swallow' as const, logged: true, range: at('ShopController.cs', 24) },
    ];
    const block: FragmentScope = { ...tryBlock, handlers };
    const rethrows: FragmentScope = { ...catchClause, handlers };
    const w: World = {
      methods: [get, place, undo, save, load],
      calls: { [get.key]: [call(0, place, { range: at('ShopController.cs', 18), fragments: [block] }), call(1, undo, { range: at('ShopController.cs', 21), fragments: [rethrows] })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(open(d)).toEqual(['root', 'root/0:Place']);
    expect(d.messages.some((m) => m.id === 'root/1:Undo')).toBe(false);
    expect(d.fragments ?? []).toEqual([]);
    expect(d.exits).toEqual([
      expect.objectContaining({ kind: 'branch', guard: 'catch DbException', errorPath: { key: 'root#try0@0#1', calls: 1, reason: 'catch DbException' } }),
      expect.objectContaining({ kind: 'branch', guard: 'catch Exception', outcome: 'logged, swallowed', swallowed: true }),
    ]);
    expect(d.exits![0].outcome).toBeUndefined();
    expect(d.exits![1].errorPath).toBeUndefined();
    // shown again: the try frame is back, the other catch is its row
    const shown = (await s.showErrorPath('root#try0@0#1'))!;
    const recover = shown.messages.find((m) => m.id === 'root/1:Undo')!;
    expect(recover).toMatchObject({ expandable: true, expanded: false, importance: { low: true } });
    expect(recover.importance!.reasons).toContain('↓ error path: catch DbException');
    expect(shown.fragments).toEqual([expect.objectContaining({ kind: 'try', catches: [expect.objectContaining({ guard: 'catch Exception', outcome: 'logged, swallowed' })] })]);
    // a shown error path is drawn, not opened by Smart; by hand it opens
    expect(open(await s.smartExpand(undefined, true))).toEqual(['root', 'root/0:Place']);
    expect(open(await s.expand('root/1:Undo'))).toContain('root/1:Undo');
    // Collapse all forgets what was shown again
    await s.collapseAll();
    expect((await s.smartExpand())!.messages.some((m) => m.id === 'root/1:Undo')).toBe(false);
  });

  it('FR-3.11 three catches: markers in order with their outcomes; one shown again brings the frame back with the others as rows', async () => {
    // try { Place(); } catch (Db) { Undo(); throw; } catch (Io) { Load(); return null; } catch { log; }
    const handlers = [
      { operand: 1, guard: 'catch Db', outcome: 'rethrow' as const, logged: false, range: at('ShopController.cs', 20) },
      { operand: 2, guard: 'catch Io', outcome: 'return' as const, value: 'null', logged: false, range: at('ShopController.cs', 24) },
      { operand: 3, guard: 'catch', outcome: 'swallow' as const, logged: true, range: at('ShopController.cs', 28) },
    ];
    const op = (operand: number): FragmentScope => ({ id: 'try@1', kind: 'try', operand, handlers, ...(operand ? { guard: handlers[operand - 1].guard } : {}) });
    const w: World = {
      methods: [get, place, undo, save, load],
      calls: { [get.key]: [call(0, place, { range: at('ShopController.cs', 18), fragments: [op(0)] }), call(1, undo, { range: at('ShopController.cs', 21), fragments: [op(1)] }), call(2, load, { range: at('ShopController.cs', 25), fragments: [op(2)] })], [place.key]: [call(0, save)] },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(d.exits!.map((e) => [e.guard, e.outcome, e.swallowed, e.errorPath?.calls])).toEqual([
      ['catch Db', undefined, undefined, 1],
      ['catch Io', '↩ null', undefined, 1],
      ['catch', 'logged, swallowed', true, undefined],
    ]);
    const shown = (await s.showErrorPath('root#try0@0#2'))!;
    expect(shown.fragments).toEqual([
      expect.objectContaining({
        kind: 'try',
        catches: [
          { guard: 'catch Db', outcome: '', swallowed: false, range: handlers[0].range, errorPath: { key: 'root#try0@0#1', calls: 1, reason: 'catch Db' } },
          { guard: 'catch', outcome: 'logged, swallowed', swallowed: true, range: handlers[2].range },
        ],
      }),
    ]);
  });

  it('FR-3.11 a try without a handler list: its catch\'s marker comes with the folded call; markers stay out of minimized frames and cases not followed', async () => {
    const plain = [{ id: 'try@1', kind: 'try' as const, operand: 0 }, { id: 'try@1', kind: 'try' as const, operand: 1, guard: 'catch' }];
    const bare: World = {
      methods: [get, place, undo, save, load],
      calls: { [get.key]: [call(0, place, { fragments: [plain[0]] }), call(1, undo, { fragments: [plain[1]] })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] },
    };
    const s = smart(bare);
    await s.openMethodByKey(get.key);
    expect((await s.smartExpand())!.exits).toEqual([expect.objectContaining({ kind: 'branch', guard: 'catch', errorPath: expect.objectContaining({ calls: 1 }) })]);
    // if (a) { try { Place(); } catch (Db) { log; } } else { Ship(); }
    const handlers = [{ operand: 1, guard: 'catch Db', outcome: 'swallow' as const, logged: true, range: at('ShopController.cs', 20) }];
    const then: FragmentScope = { id: 'if@1', kind: 'alt', operand: 0, guard: 'a' };
    const other: FragmentScope = { id: 'if@1', kind: 'alt', operand: 1, guard: 'else' };
    const nested: World = {
      methods: [get, place, ship, save, audit],
      calls: { [get.key]: [call(0, place, { range: at('ShopController.cs', 18), fragments: [then, { id: 'try@2', kind: 'try', operand: 0, handlers }] }), call(1, ship, { range: at('ShopController.cs', 30), fragments: [other] })], [place.key]: [call(0, save)], [ship.key]: [call(0, audit)] },
    };
    const followed = smart(nested);
    await followed.openMethodByKey(get.key);
    await followed.followCase('root#alt0@0', 1);
    expect((await followed.smartExpand())!.exits ?? []).toEqual([]);
    const minimized = smart(nested);
    await minimized.openMethodByKey(get.key);
    await minimized.collapseFragment('root#alt0@0');
    expect((await minimized.smartExpand())!.exits ?? []).toEqual([]);
  });

  it('FR-3.11 a catch without a known range: its marker comes with its first folded call', async () => {
    const handlers = [{ operand: 1, guard: 'catch DbException', outcome: 'return' as const, value: 'null', logged: false }];
    const w: World = {
      methods: [get, place, undo, save, load],
      calls: { [get.key]: [call(0, place, { fragments: [{ ...tryBlock, handlers }] }), call(1, undo, { fragments: [{ ...catchClause, handlers }] })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    expect((await s.smartExpand())!.exits).toEqual([expect.objectContaining({ kind: 'branch', guard: 'catch DbException', errorPath: expect.objectContaining({ calls: 1 }) })]);
  });

  it('FR-3.9 a branch that throws is off the path (from the early exits); without exits the same branch opens', async () => {
    const throwing: EarlyExit = { kind: 'throw', range: at('ShopController.cs', 9), exception: 'ValidationException', fragments: [{ id: 'if@9', kind: 'opt', operand: 0, guard: 'order.lines > 10' }] };
    const w = (exits: EarlyExit[]): World => ({
      methods: [get, place, undo, save, load],
      calls: { [get.key]: [call(0, undo, { fragments: [{ id: 'if@9', kind: 'opt', operand: 0, guard: 'order.lines > 10' }] }), call(1, place)], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] },
      adapter: { getEarlyExits: async (m: { key: string }) => (m.key === get.key ? exits : []) },
    });
    const s = smart(w([throwing]));
    await s.openMethodByKey(get.key);
    expect(open(await s.smartExpand())).toEqual(['root', 'root/1:Place']);
    const plain = smart(w([]));
    await plain.openMethodByKey(get.key);
    expect(open(await plain.smartExpand())).toEqual(['root', 'root/0:Undo', 'root/1:Place']);
  });

  it('FR-3.9 what a call reveals leaves out its body\'s error paths: a method whose notable calls all handle failures stays folded', async () => {
    // Ship's crossing call is under a failure check; Place's is on its main path
    const w: World = {
      methods: [get, place, ship, save, audit],
      calls: { [get.key]: [call(0, ship), call(1, place)], [ship.key]: [call(0, audit, { fragments: [invalid] })], [place.key]: [call(0, save)] },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(open(d)).toEqual(['root', 'root/1:Place']);
    expect(d.messages.find((m) => m.id === 'root/0:Ship')!.importance!.reasons.some((r) => r.startsWith('↑ reveals'))).toBe(false);
  });
});

describe('FR-3.11 what is left of a folded error path', () => {
  it('FR-3.11 an invoked closure\'s failure check folds into a branch marker; ⊕ shows the error path', async () => {
    // Get → Each(xs, x => { if (!x.ok) Save(); }): Each runs the lambda the controller wrote
    const each = meth(orders, 'Each');
    const lambda = { kind: 'lambda' as const, range: at('ShopController.cs', 7), params: ['x'], calls: [call(0, save, { fragments: [{ id: 'if@7', kind: 'opt', operand: 0, guard: '!x.ok' }] })] };
    const w: World = {
      methods: [get, each, save, load],
      calls: { [get.key]: [call(0, each, { args: ['xs', 'x => …'], argFunctions: [undefined, lambda] })], [each.key]: [call(0, load), call(1, undefined, { methodName: 'f', invokedParameter: 'f', receiver: { kind: 'none' } } as never)] },
      adapter: { getParameterNames: async () => ['xs', 'f'] },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(open(d)).toEqual(['root', 'root/0:Each', 'root/0:Each/1:f']);
    expect(d.messages.some((m) => m.id === 'root/0:Each/1:f/0:Save')).toBe(false);
    // no frame left (its only branch folded): the marker states the guard
    expect(d.fragments ?? []).toEqual([]);
    expect(d.exits).toEqual([expect.objectContaining({ id: 'root/0:Each/1:f!branch0', kind: 'branch', guard: '!x.ok', errorPath: { key: 'root/0:Each/1:f#opt0@0#0', calls: 1, reason: '[!x.ok]' } })]);
    const shown = (await s.showErrorPath('root/0:Each/1:f#opt0@0#0'))!;
    expect(shown.messages.some((m) => m.id === 'root/0:Each/1:f/0:Save')).toBe(true);
    expect(shown.exits ?? []).toEqual([]);
  });

  it('FR-3.11 a branch that throws keeps its exit marker; the else of a success check gets a branch marker and the frame goes; Expand all shows everything', async () => {
    const throws: FragmentScope = { id: 'if@9', kind: 'opt', operand: 0, guard: 'order.lines > 10' };
    const okThen: FragmentScope = { id: 'if@20', kind: 'alt', operand: 0, guard: 'charge.IsSuccess', negatedGuard: '!charge.IsSuccess' };
    const okElse: FragmentScope = { id: 'if@20', kind: 'alt', operand: 1, guard: 'else', negatedGuard: '!charge.IsSuccess' };
    const w: World = {
      methods: [get, place, undo, ship, save, load, audit],
      calls: { [get.key]: [call(0, undo, { fragments: [throws] }), call(1, place, { fragments: [okThen] }), call(2, ship, { fragments: [okElse] })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)], [ship.key]: [call(0, audit)] },
      adapter: { getEarlyExits: async (m: { key: string }) => (m.key === get.key ? [{ kind: 'throw', range: at('ShopController.cs', 9, 40), exception: 'ValidationException', fragments: [throws] }] : []) },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/1:Place', 'root/1:Place/0:Save']);
    expect(d.exits).toEqual([
      expect.objectContaining({ kind: 'throw', guard: 'order.lines > 10', errorPath: { key: 'root#opt0@0#0', calls: 1, reason: 'throws ValidationException' } }),
      expect.objectContaining({ kind: 'branch', guard: '!charge.IsSuccess', errorPath: { key: 'root#alt0@1#1', calls: 1, reason: 'else of [charge.IsSuccess]' } }),
    ]);
    // on the main path the success check holds: no frame around Place
    expect(d.fragments ?? []).toEqual([]);
    const shown = (await s.showErrorPath('root#opt0@0#0'))!;
    expect(shown.messages.some((m) => m.id === 'root/0:Undo')).toBe(true);
    expect(shown.exits![0].errorPath).toBeUndefined();
    // the else shown again: drawn, dimmed, not opened — and the alt has its frame back
    const both = (await s.showErrorPath('root#alt0@1#1'))!;
    expect(both.messages.find((m) => m.id === 'root/2:Ship')!.importance).toMatchObject({ low: true });
    expect(both.fragments!.map((f) => f.kind)).toEqual(['opt', 'alt']);
    // FR-3.12 ↯ Fold errors off, then Expand all: every call
    await s.collapseAll();
    await s.smartExpand();
    await s.setOption('foldErrors', false);
    const all = (await s.expandEverything())!;
    expect(all.messages.map((m) => m.id)).toEqual(['root', 'root/0:Undo', 'root/0:Undo/0:Load', 'root/1:Place', 'root/1:Place/0:Save', 'root/2:Ship', 'root/2:Ship/0:Audit']);
    expect(all.messages.some((m) => m.importance)).toBe(false);
  });

  it('FR-3.11 an error branch and a frame the user minimized: the outer one takes the calls', async () => {
    const loop: FragmentScope = { id: 'for@3', kind: 'loop', operand: 0, guard: 'each o of orders' };
    const failed: FragmentScope = { id: 'if@4', kind: 'opt', operand: 0, guard: '!o.ok' };
    const run = async (scopes: FragmentScope[], minimize: string) => {
      const w: World = { methods: [get, place, undo, save, load], calls: { [get.key]: [call(0, place), call(1, undo, { fragments: scopes })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] } };
      const s = smart(w);
      // the user minimizes the frame while the error branch is drawn (↯ off), then folds the errors
      await s.setOption('foldErrors', false);
      await s.openMethodByKey(get.key);
      await s.collapseFragment(minimize);
      await s.setOption('foldErrors', true);
      return (await s.smartExpand())!.fragments!.filter((f) => f.collapsed);
    };
    // the user's loop around the error branch: the loop's stub, no error path
    expect(await run([loop, failed], 'root#loop0@1')).toEqual([expect.objectContaining({ id: 'root#loop0@1', hiddenCount: 1 })]);
    // the error branch around the user's loop: no stub, the branch's marker
    expect(await run([failed, loop], 'root#loop1@1')).toEqual([]);
  });

  it('FR-3.11 one marker per folded branch, also for its nested exits; an opt around a success check loses its frame', async () => {
    // Get: if (!o.ok) { if (late) return; Audit(); Load(); }  if (r.IsSuccess) { Place(); }
    const failed: FragmentScope = { id: 'if@4', kind: 'opt', operand: 0, guard: '!o.ok' };
    const late: FragmentScope = { id: 'if@5', kind: 'opt', operand: 0, guard: 'late' };
    const ok: FragmentScope = { id: 'if@9', kind: 'opt', operand: 0, guard: 'r.IsSuccess' };
    const w: World = {
      methods: [get, place, save, load, audit],
      calls: { [get.key]: [call(0, audit, { range: at('ShopController.cs', 6), fragments: [failed] }), call(1, load, { range: at('ShopController.cs', 7), fragments: [failed] }), call(2, place, { range: at('ShopController.cs', 10), fragments: [ok] })], [place.key]: [call(0, save)] },
      adapter: { getEarlyExits: async (m: { key: string }) => (m.key === get.key ? [{ kind: 'return', value: '', range: at('ShopController.cs', 5), fragments: [failed, late] }] : []) },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/2:Place', 'root/2:Place/0:Save']);
    expect(d.exits).toEqual([expect.objectContaining({ id: 'root!branch0', kind: 'branch', guard: '!o.ok', errorPath: { key: 'root#opt0@0#0', calls: 2, reason: '[!o.ok]' } })]);
    expect(d.fragments ?? []).toEqual([]);
  });

  it('FR-3.9 / FR-3.11 a guard clause returning a helper that only builds a failure folds once the helper is read', async () => {
    // Place: if (order is null) return Report(); Save();   Report: Failure(new MissingError())
    const report = meth(orders, 'Report');
    const missing: FragmentScope = { id: 'if@2', kind: 'opt', operand: 0, guard: 'order is null' };
    const w: World = {
      methods: [get, place, report, save],
      calls: {
        [get.key]: [call(0, place)],
        [place.key]: [call(0, report, { range: at('Orders.cs', 3, 18), receiver: { kind: 'self' }, fragments: [missing] }), call(1, save)],
        [report.key]: [call(0, undefined, { methodName: 'Result.Failure' })],
      },
      adapter: { getEarlyExits: async (m: { key: string }) => (m.key === place.key ? [{ kind: 'return', value: 'Report()', range: { file: '/p/Orders.cs', start: { line: 3, character: 4 }, end: { line: 3, character: 30 } }, fragments: [missing] }] : []) },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/0:Place', 'root/0:Place/1:Save']);
    expect(d.exits).toEqual([expect.objectContaining({ kind: 'return', guard: 'order is null', errorPath: { key: 'root/0:Place#opt0@0#0', calls: 1, reason: 'returns early [order is null]' } })]);
  });

  it('FR-3.11 an opt around a success check that returns from inside keeps its frame (what follows is the failure)', async () => {
    // Get: if (r.IsSuccess) { Place(); return; }  Ship();
    const ok: FragmentScope = { id: 'if@9', kind: 'opt', operand: 0, guard: 'r.IsSuccess' };
    const w: World = {
      methods: [get, place, ship, save, audit],
      calls: { [get.key]: [call(0, place, { range: at('ShopController.cs', 10), fragments: [ok] }), call(1, ship, { range: at('ShopController.cs', 13) })], [place.key]: [call(0, save)], [ship.key]: [call(0, audit)] },
      adapter: { getEarlyExits: async (m: { key: string }) => (m.key === get.key ? [{ kind: 'return', value: '', range: at('ShopController.cs', 11), fragments: [ok] }] : []) },
    };
    const s = smart(w);
    await s.openMethodByKey(get.key);
    expect((await s.smartExpand())!.fragments).toEqual([expect.objectContaining({ kind: 'opt', operands: [expect.objectContaining({ guard: 'r.IsSuccess' })] })]);
  });

  it('FR-3.11 with Fragments off nothing folds (there would be no trace)', async () => {
    const w: World = { methods: [get, place, undo, save, load], calls: { [get.key]: [call(0, place), call(1, undo, { fragments: [invalid] })], [place.key]: [call(0, save)], [undo.key]: [call(0, load)] } };
    const s = fakeSession(w, { options: { showFragments: false }, classifier: new DefaultClassifier('/p', { layers: LAYERS } as never) });
    await s.openMethodByKey(get.key);
    expect((await s.smartExpand())!.messages.map((m) => m.id)).toEqual(['root', 'root/0:Place', 'root/0:Place/0:Save', 'root/1:Undo']);
  });
});

describe('FR-3.10 Smart expand stops by itself; the cap says so', () => {
  const w: World = {
    methods: [get, place, ship, save, load, audit],
    calls: { [get.key]: [call(0, place), call(1, ship)], [place.key]: [call(0, save), call(1, load)], [ship.key]: [call(0, audit), call(1, save)] },
  };

  it('FR-3.10 without a configured budget everything worth opening opens, and there is no notice', async () => {
    const s = smart(w);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(open(d)).toEqual(['root', 'root/0:Place', 'root/1:Ship']);
    expect(d.expandNotice).toBeUndefined();
  });

  it('FR-3.10 a cap that stops it leaves a notice with the calls still worth opening; continuing opens them', async () => {
    const s = smart(w, { budget: 5 });
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(open(d)).toEqual(['root', 'root/0:Place']);
    expect(d.expandNotice).toEqual({ reason: 'smart', messages: 5, depth: 1, folded: 1, limit: 5 });
    const more = (await s.smartExpand(undefined, true))!;
    expect(open(more)).toEqual(['root', 'root/0:Place', 'root/1:Ship']);
    expect(more.expandNotice).toBeUndefined();
  });
});
