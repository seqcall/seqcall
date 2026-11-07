import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { DefaultClassifier } from '../src/classifier-impl';
import { call, cls, fakeSession, meth } from './fake-world';

// the diagram keeps up with what the reader just did.

const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const svc = cls('src/App/Orders.cs', 'Orders');
const iPolicy = cls('src/App/IPolicy.cs', 'IPolicy', 'interface');
const strict = cls('src/App/StrictPolicy.cs', 'StrictPolicy');
const loose = cls('src/App/LoosePolicy.cs', 'LoosePolicy');
const rules = cls('src/App/Rules.cs', 'Rules');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const run = meth(svc, 'Run');
const check = meth(iPolicy, 'Check', { hasBody: false });
const strictCheck = meth(strict, 'Check');
const looseCheck = meth(loose, 'Check');
const limit = meth(rules, 'Limit');
const audit = meth(rules, 'Audit');
const save = meth(repo, 'Save');
const classifier = () =>
  new DefaultClassifier('/p', { layers: [{ name: 'Presentation', match: ['src/Api/**'] }, { name: 'Application', match: ['src/App/**'] }, { name: 'Infrastructure', match: ['src/Infra/**'] }] } as never);
const ids = (d: SequenceDiagram | undefined) => d!.messages.map((m) => `${m.id}${m.expanded ? ' open' : ''}`);

describe('FR-8.8 another implementation opens as deep as the last one was open', () => {
  // Get → Check (IPolicy: Strict → Limit → Save, Loose → Audit → Save)
  const world = () => ({
    methods: [get, check, strictCheck, looseCheck, limit, audit, save],
    calls: { [get.key]: [call(0, check)], [strictCheck.key]: [call(0, limit)], [looseCheck.key]: [call(0, audit)], [limit.key]: [call(0, save)], [audit.key]: [call(0, save)] },
    impls: { [check.key]: [strictCheck, looseCheck] },
  });

  it('two levels open under Strict: Loose opens two levels; back to the interface: nothing to open; closed: stays closed', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(get.key);
    await s.selectImplementation('root/0:Check', strict.key);
    await s.expand('root/0:Check');
    expect(ids(await s.expand('root/0:Check/0:Limit'))).toEqual(['root open', 'root/0:Check open', 'root/0:Check/0:Limit open', 'root/0:Check/0:Limit/0:Save']);
    expect(ids(await s.selectImplementation('root/0:Check', loose.key))).toEqual(['root open', 'root/0:Check open', 'root/0:Check/0:Audit open', 'root/0:Check/0:Audit/0:Save']);
    // the interface has no body: nothing opens
    expect(ids(await s.revertImplementation('root/0:Check'))).toEqual(['root open', 'root/0:Check']);
    // nothing was open: nothing opens
    expect(ids(await s.selectImplementation('root/0:Check', strict.key))).toEqual(['root open', 'root/0:Check']);
  });
});

describe('FR-28.12 Focus with Fold layers on', () => {
  it('a method whose calls all stay in its layer: its object comes out, so its calls are drawn', async () => {
    const s = fakeSession({ methods: [get, run, strictCheck, save], calls: { [get.key]: [call(0, run)], [run.key]: [call(0, strictCheck)] } }, { classifier: classifier() });
    await s.openMethodByKey(get.key);
    await s.setOption('layerZoom', true);
    await s.expand('root/0:Run');
    const d = (await s.focus('root/0:Run'))!;
    expect(d.messages.map((m) => `${m.id} ${m.from ?? '-'}→${m.to}`)).toEqual(['root -→src/App/Orders.cs#Orders|root', 'root/0:Check src/App/Orders.cs#Orders|root→layer:Application']);
    expect(s.getPersistentState().options.openObjects).toEqual(['src/App/Orders.cs#Orders|root']);
  });

  it('Fold layers restored with the session (no object list yet): the object is the first one out', async () => {
    const s = fakeSession({ methods: [get, run, strictCheck], calls: { [get.key]: [call(0, run)], [run.key]: [call(0, strictCheck)] } }, { classifier: classifier(), options: { layerZoom: true } });
    await s.openMethodByKey(get.key);
    await s.focus('root/0:Run');
    expect(s.getPersistentState().options.openObjects).toEqual(['src/App/Orders.cs#Orders|root']);
  });

  it('an object pulled out before stays out beside it', async () => {
    const s = fakeSession({ methods: [get, run, strictCheck, save], calls: { [get.key]: [call(0, run)], [run.key]: [call(0, strictCheck)] } }, { classifier: classifier() });
    await s.openMethodByKey(get.key);
    await s.setOption('layerZoom', true);
    await s.setLayerOpen('src/Api/ShopController.cs#ShopController|root', true);
    const before = s.getPersistentState().options.openObjects!;
    await s.focus('root/0:Run');
    expect(s.getPersistentState().options.openObjects).toEqual([...before, 'src/App/Orders.cs#Orders|root']);
  });

  it('a method with a call out of its layer is drawn as it is (nothing pulled out)', async () => {
    const s = fakeSession({ methods: [get, run, save], calls: { [get.key]: [call(0, run)], [run.key]: [call(0, save)] } }, { classifier: classifier() });
    await s.openMethodByKey(get.key);
    await s.setOption('layerZoom', true);
    const d = (await s.focus('root/0:Run'))!;
    expect(d.messages.length).toBeGreaterThan(1);
    expect(s.getPersistentState().options.openObjects ?? []).toEqual([]);
  });
});
