import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import type { FragmentScope } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { call, cls, fakeSession, meth, type World } from './fake-world';

// FR-3.12 the views of ✦ start from closed, ↯ Fold errors: ShopController.Get → Orders.Place (try Save, catch: Audit) / Refunds.Undo
// in Get's catch; Ship after them. Presentation → Application → Infrastructure.
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
const tryAt = (line: number, operand: number): FragmentScope => ({ id: `try@${line}`, kind: 'try', operand, ...(operand ? { guard: 'catch DbException' } : {}) });
const w: World = {
  methods: [get, place, ship, undo, save, load, audit],
  calls: {
    [get.key]: [call(0, place, { fragments: [tryAt(1, 0)] }), call(1, undo, { fragments: [tryAt(1, 1)] }), call(2, ship)],
    [place.key]: [call(0, save, { fragments: [tryAt(3, 0)] }), call(1, audit, { fragments: [tryAt(3, 1)] })],
    [undo.key]: [call(0, load)],
    [ship.key]: [call(0, save)],
  },
};
const session = () => fakeSession(w, { classifier: new DefaultClassifier('/p', { layers: LAYERS } as never) });
const open = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.expanded).map((m) => m.id);
const drawn = (d: SequenceDiagram | undefined) => d!.messages.map((m) => m.id);
const folds = (d: SequenceDiagram | undefined) => (d!.exits ?? []).flatMap((e) => (e.errorPath ? [e.errorPath.key] : []));

describe('FR-3.12 the views of ✦ start from closed; ↯ Fold errors', () => {
  it('FR-3.12 Overview gives the same diagram whatever was open before (also after Everything, an error branch shown, a call opened by hand)', async () => {
    const fresh = session();
    await fresh.openMethodByKey(get.key);
    const main = (await fresh.smartExpand())!;
    expect(folds(main).length).toBeGreaterThan(0);
    const after = session();
    await after.openMethodByKey(get.key);
    await after.expandEverything();
    for (const k of folds(main)) await after.showErrorPath(k);
    await after.expand('root/1:Undo');
    const again = (await after.smartExpand())!;
    expect([open(again), drawn(again), folds(again)]).toEqual([open(main), drawn(main), folds(main)]);
  });

  it('FR-3.12 ↯ Fold errors folds the error branches at every depth, also after Expand all; off draws them; toggling never collapses', async () => {
    const s = session();
    await s.openMethodByKey(get.key);
    const folded = (await s.expandEverything())!;
    expect(drawn(folded)).not.toContain('root/1:Undo');
    expect(drawn(folded)).not.toContain('root/0:Place/1:Audit');
    expect(folds(folded).length).toBeGreaterThan(0);
    const all = (await s.setOption('foldErrors', false))!;
    expect(folds(all)).toEqual([]);
    // the branches come with their calls collapsed (Expand all did not open what it did not draw)
    expect(drawn(all)).toEqual(expect.arrayContaining(['root/1:Undo', 'root/0:Place/1:Audit']));
    expect(drawn(all)).not.toContain('root/1:Undo/0:Load');
    // hidden, not collapsed: Undo opened by hand comes back open
    await s.expand('root/1:Undo');
    expect(drawn(await s.setOption('foldErrors', true))).not.toContain('root/1:Undo/0:Load');
    expect(drawn(await s.setOption('foldErrors', false))).toContain('root/1:Undo/0:Load');
    // ⊕ on a marker shows one branch; toggling forgets it
    await s.setOption('foldErrors', true);
    const shown = (await s.showErrorPath(folds(folded)[0]))!;
    expect(folds(shown)).not.toContain(folds(folded)[0]);
    await s.setOption('foldErrors', false);
    expect(folds(await s.setOption('foldErrors', true))).toContain(folds(folded)[0]);
  });

  it('FR-3.12 Overview ranks the success path only: with ↯ off the error branches are drawn, dimmed, not opened', async () => {
    const s = session();
    await s.setOption('foldErrors', false);
    await s.openMethodByKey(get.key);
    const d = (await s.smartExpand())!;
    expect(d.messages.find((m) => m.id === 'root/1:Undo')).toMatchObject({ expanded: false, importance: { low: true } });
    expect(open(d)).toContain('root/0:Place');
  });

  it('FR-3.12 from here: only that call\'s subtree starts from closed; the rest stays as it was', async () => {
    const s = session();
    await s.openMethodByKey(get.key);
    await s.expand('root/2:Ship');
    await s.expand('root/0:Place');
    await s.setOption('foldErrors', false);
    await s.expand('root/0:Place/1:Audit');
    const d = (await s.smartExpand('root/0:Place'))!;
    expect(open(d)).toEqual(expect.arrayContaining(['root/2:Ship', 'root/0:Place']));
    expect(open(d)).not.toContain('root/0:Place/1:Audit');
    // an error branch shown below Place goes too; one outside stays
    await s.setOption('foldErrors', true);
    const keys = folds(s.current());
    for (const k of keys) await s.showErrorPath(k);
    const again = (await s.smartExpand('root/0:Place'))!;
    expect(folds(again).filter((k) => k.startsWith('root/0:Place'))).toEqual(keys.filter((k) => k.startsWith('root/0:Place')));
    expect(folds(again).filter((k) => !k.startsWith('root/0:Place'))).toEqual([]);
    // the whole diagram: all of them fold again
    expect(folds(await s.smartExpand())).toEqual(expect.arrayContaining(keys));
  });

  it('FR-3.12 a found call inside a folded error branch: the branch is shown', async () => {
    const s = session();
    await s.openMethodByKey(get.key);
    const auditCall = w.calls![place.key][1];
    const r = (await s.revealSearchHit({ anchorId: 'root/0:Place', steps: [{ methodKey: place.key, call: { range: auditCall.range } }], labels: [], hit: { label: 'Audit', range: auditCall.range } }))!;
    expect(r.messageId).toBe('root/0:Place/1:Audit');
    expect(drawn(r.diagram)).toContain('root/0:Place/1:Audit');
  });

  it('FR-3.12 Changes without a review, or from a call that is not drawn: nothing opens', async () => {
    const s = session();
    await s.openMethodByKey(get.key);
    expect(open(await s.smartExpand(undefined, false, 'changes'))).toEqual(['root']);
    expect(open(await s.smartExpand('root/9:Gone', false, 'changes'))).toEqual(['root']);
  });
});
