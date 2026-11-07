import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { DefaultClassifier } from '../src/classifier-impl';
import { call, cls, fakeSession, meth } from './fake-world';

// FR-28.3 ⊕ on a drawn call one level up, in the states a first ⊕ leaves behind: ShopController (Presentation) →
// Orders.Run (Application), which asks an IPolicy of its own layer (two implementations, none chosen) and saves (Infrastructure).
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const svc = cls('src/App/Orders.cs', 'Orders');
const iPolicy = cls('src/App/IPolicy.cs', 'IPolicy', 'interface');
const strict = cls('src/App/StrictPolicy.cs', 'StrictPolicy');
const loose = cls('src/App/LoosePolicy.cs', 'LoosePolicy');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const run = meth(svc, 'Run');
const check = meth(iPolicy, 'Check', { hasBody: false });
const strictCheck = meth(strict, 'Check');
const save = meth(repo, 'Save');
const classifier = () =>
  new DefaultClassifier('/p', { layers: [{ name: 'Presentation', match: ['src/Api/**'] }, { name: 'Application', match: ['src/App/**'] }, { name: 'Infrastructure', match: ['src/Infra/**'] }] } as never);
const show = (d: SequenceDiagram) => d.messages.map((m) => `${m.id} ${m.from ?? '-'}→${m.to}${m.expanded ? ' open' : m.expandable ? ' ⊕' : ''}`);

describe('FR-28.3 ⊕ on a drawn call one level up', () => {
  it('FR-28.3 ⊕ opens only folded calls that can open: an interface call without a chosen implementation stays closed once one is chosen; a call folding nothing changes nothing', async () => {
    const s = fakeSession(
      { methods: [get, run, check, strictCheck, meth(loose, 'Check'), save], calls: { [get.key]: [call(0, run), call(1, check)], [run.key]: [call(0, check), call(1, save)], [strictCheck.key]: [call(0, save)] }, impls: { [check.key]: [strictCheck, meth(loose, 'Check')] } },
      { classifier: classifier() },
    );
    await s.openMethodByKey(get.key);
    await s.setOption('layerZoom', true);
    // the first ⊕ opens Run itself; Check (folded into it) cannot open yet
    const opened = (await s.expand('root/0:Run'))!;
    expect(show(opened)).toEqual(['root -→layer:Presentation open', 'root/0:Run layer:Presentation→layer:Application open', 'root/0:Run/1:Save layer:Application→layer:Infrastructure', 'root/1:Check layer:Presentation→layer:Application']);
    expect(show((await s.expand('root/0:Run'))!)).toEqual(show(opened));
    expect(show((await s.expand('root/0:Run/1:Save'))!)).toEqual(show(opened));
    // chosen at the controller's own Check: the interface's choice holds for Run's Check too, which now offers ⊕ (through
    // Run) — not opened by the earlier ⊕
    const chosen = (await s.selectImplementation('root/1:Check', strict.key))!;
    expect(show(chosen)).toEqual(['root -→layer:Presentation open', 'root/0:Run layer:Presentation→layer:Application ⊕', 'root/0:Run/1:Save layer:Application→layer:Infrastructure', 'root/1:Check layer:Presentation→layer:Application ⊕']);
  });
});

describe('FR-28.7 / FR-28.8 opening layers and objects in odd orders', () => {
  const world = () => ({ methods: [get, run, check, strictCheck, save], calls: { [get.key]: [call(0, run)], [run.key]: [call(0, strictCheck), call(1, save)] } });
  const options = (s: ReturnType<typeof fakeSession>) => {
    const o = s.getPersistentState().options;
    return [o.openLayers, o.openObjects];
  };

  it('FR-28.7 a layer opened before any diagram, and before any object was pulled out', async () => {
    const s = fakeSession(world(), { classifier: classifier() });
    await s.setOption('layerZoom', true);
    // folding one that is not open changes nothing
    expect(await s.setLayerOpen('layer:Application', false)).toBeUndefined();
    expect(options(s)).toEqual([[], []]);
    expect(await s.setLayerOpen('layer:Application', true)).toBeUndefined();
    expect(options(s)).toEqual([['layer:Application'], []]);
  });

  it('FR-28.11 not zoomed, the same calls fold / open the layer in the object view (`foldedLayers`), before any diagram too', async () => {
    const s = fakeSession(world(), { classifier: classifier() });
    expect(await s.setLayerOpen('layer:Application', true)).toBeUndefined();
    expect(s.getPersistentState().options.foldedLayers).toEqual([]);
    await s.setLayerOpen('layer:Application', false);
    expect(options(s)).toEqual([undefined, []]);
    expect(s.getPersistentState().options.foldedLayers).toEqual(['layer:Application']);
  });

  it('FR-28.8 an object pulled out, then gone from the diagram: folding its layer keeps it out (it may come back)', async () => {
    const s = fakeSession(world(), { classifier: classifier() });
    await s.openMethodByKey(get.key);
    await s.setOption('layerZoom', true);
    const d = (await s.expand('root/0:Run'))!;
    const repo = d.participants.find((p) => p.classKey === save.owner.key);
    expect(repo).toBeUndefined(); // folded into the Infrastructure lifeline
    const plain = (await s.setOption('layerZoom', false))!;
    const repoId = plain.participants.find((p) => p.classKey === save.owner.key)!.id;
    await s.setOption('layerZoom', true);
    await s.setLayerOpen(repoId, true);
    await s.collapse('root/0:Run');
    await s.setLayerOpen('layer:Infrastructure', false);
    expect(options(s)).toEqual([[], [repoId]]);
  });
});

describe('FR-11 hiding the same call twice', () => {
  it('FR-11 one filter per rule: hiding again keeps one', async () => {
    const s = fakeSession({ methods: [get, run, save], calls: { [get.key]: [call(0, run), call(1, save)] } });
    await s.openMethodByKey(get.key);
    await s.hide({ kind: 'methodName', methodName: 'Save' });
    const d = (await s.hide({ kind: 'methodName', methodName: 'Save' }))!;
    expect(d.hiddenFilters.map((f) => [f.filter.id, f.hiddenCount])).toEqual([[d.hiddenFilters[0].filter.id, 1]]);
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/0:Run']);
  });
});
