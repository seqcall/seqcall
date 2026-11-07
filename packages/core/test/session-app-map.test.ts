import { describe, expect, it } from 'vitest';
import type { ClassRef, EntryPoint, MethodRef } from '@seqcall/protocol';
import type { ClassInfo } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { call, cls, fakeSession, info, meth, type World } from './fake-world';

// FR-26 the codebase map from entry-point flows written per test: what a class and relation carry into the map, flows
// that stop at interfaces (followed into their implementations), and flows that cannot be opened.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const iCheck = cls('src/App/ICheck.cs', 'ICheck', 'interface');
const get = meth(ctl, 'Get');
const list = meth(ctl, 'List');
const save = meth(repo, 'Save');
const check = meth(iCheck, 'Check', { hasBody: false });
const impl = (i: number) => meth(cls(`src/App/Check${i}.cs`, `Check${i}`), 'Check');
const field = (name: string, type: ClassRef, collection = false) => ({ name, type, collection, isStatic: false, injected: true }) as ClassInfo['fields'][number];
const ep = (label: string, method: MethodRef): EntryPoint => ({ kind: 'http', label, method });
const all = async (s: ReturnType<typeof fakeSession>) => (await s.getAppMap('src', { open: ['src/Api', 'src/App', 'src/Infra'] }))!;

describe('FR-26.1 what the map keeps of a flow', () => {
  it('FR-26.1 a class without a layer reason (a host\'s classifier gives none), a collection field\'s aggregation, a realization without calls', async () => {
    const base = new DefaultClassifier('/nowhere', {});
    const classifier: Classifier = { classify: (r, i, u) => ({ ...base.classify(r, i, u), layerReason: undefined }), layerOrder: () => [], reloadConfig: () => undefined };
    const one = impl(1);
    const s = fakeSession(
      {
        methods: [get, save, check, one],
        calls: { [get.key]: [call(0, save, { receiver: { kind: 'field', name: 'repos' } }), call(1, check, { receiver: { kind: 'field', name: 'check' } })] },
        impls: { [check.key]: [one] },
        infos: [info(ctl, { fields: [field('repos', repo, true), field('check', iCheck)] }), info(repo), info(iCheck)],
        entryPoints: [ep('GET /shop', get)],
      },
      { classifier },
    );
    const d = (await all(s)).diagram;
    expect(d.classes.map((c) => [c.name, 'layerReason' in c])).toEqual([['ShopController', false], ['Repo', false], ['Check1', false], ['ICheck', false]]);
    expect(d.relations.map((r) => [r.kind, r.to.replace(/^.*#/, ''), r.aggregation ?? false, r.multiplicity, r.calls?.length])).toEqual([
      ['association', 'Repo', true, '*', 1],
      ['association', 'ICheck', false, undefined, 1],
      ['realization', 'ICheck', false, undefined, 0],
    ]);
  });
});

describe('FR-26.2 flows that stop at an interface', () => {
  const stopAt = (impls: MethodRef[], extra: Partial<World> = {}): World => ({
    methods: [get, list, check, ...impls],
    calls: { [get.key]: [call(0, check)], [list.key]: [call(0, check)] },
    impls: { [check.key]: impls },
    entryPoints: [ep('GET /shop', get)],
    ...extra,
  });

  it('FR-26.2 more implementations than one flow may open (400): the rest is left out, the flow is truncated', async () => {
    const impls = Array.from({ length: 401 }, (_, i) => impl(i));
    const level = await all(fakeSession(stopAt(impls)));
    expect([level.truncated, level.diagram.classes.filter((c) => /^Check\d+$/.test(c.name)).length]).toEqual([1, 400]);
  });

  it('FR-26.2 two entry points stopping at the same interface share its implementations\' flows; one implementation is followed once', async () => {
    let opened = 0;
    const one = impl(1);
    const methods = new Map([get, list, check, one].map((m) => [m.key, m]));
    // the same implementation listed twice
    const s = fakeSession(stopAt([one, one], { entryPoints: [ep('GET /shop', get), ep('GET /list', list)], adapter: { getMethod: async (k: string) => (k === one.key && opened++, methods.get(k)) } }));
    const level = await all(s);
    expect([level.entryPoints, level.truncated, opened]).toEqual([2, 0, 1]);
    expect(level.diagram.relations.filter((r) => r.kind === 'realization').map((r) => r.from)).toEqual([one.owner.key]);
  });

  it('FR-26.2 an implementation gone from the code adds nothing; an interface method gone has no implementations to follow', async () => {
    const one = impl(1);
    const gone = impl(2);
    const methods = new Map([get, list, check, one].map((m) => [m.key, m]));
    const s = fakeSession(stopAt([one, gone], { adapter: { getMethod: async (k: string) => methods.get(k) } }));
    expect((await all(s)).diagram.classes.map((c) => c.name)).toEqual(['ShopController', 'ICheck', 'Check1']);
    const t = fakeSession(stopAt([one, gone], { adapter: { getMethod: async (k: string) => (k === check.key ? undefined : methods.get(k)) } }));
    expect((await all(t)).diagram.classes.map((c) => c.name)).toEqual(['ShopController', 'ICheck']);
  });

  it('FR-26.2 at most 4000 method flows are merged into one entry point\'s: what is left to follow then makes it truncated', async () => {
    // ten entry points call ICheck (4000 implementations, each stopping at INext with two); one walk opens at most 400
    // new method flows per entry point and shares them: the tenth reaches all 4000 (3600 shared, 400 new) with the
    // INext stops still queued
    const iNext = cls('src/App/INext.cs', 'INext', 'interface');
    const next = meth(iNext, 'Next', { hasBody: false });
    const impls = Array.from({ length: 4000 }, (_, i) => impl(i));
    const nexts = [0, 1].map((i) => meth(cls(`src/App/Next${i}.cs`, `Next${i}`), 'Next'));
    const entries = Array.from({ length: 10 }, (_, i) => meth(ctl, `Route${i}`));
    const calls = Object.fromEntries([...entries.map((m) => [m.key, [call(0, check)]]), ...impls.map((m) => [m.key, [call(0, next)]])]);
    const s = fakeSession({ methods: [...entries, check, next, ...impls, ...nexts], calls, impls: { [check.key]: impls, [next.key]: nexts }, entryPoints: entries.map((m) => ep(m.name, m)) });
    // the first nine stop at the 400 new flows; the tenth at the 4000 merged
    expect((await s.getAppMap())!.truncated).toBe(10);
  }, 120_000);

  it('FR-26.2 the implementations cannot be listed (the adapter fails): the flow is truncated', async () => {
    let calls = 0;
    const s = fakeSession(stopAt([impl(1), impl(2)], { adapter: { getImplementations: async () => (calls++ === 0 ? [impl(1), impl(2)] : Promise.reject(new Error('sidecar gone'))) } }));
    expect((await all(s)).truncated).toBe(1);
  });
});

describe('FR-26.1 flows that cannot be opened', () => {
  it('FR-26.1 an entry point whose method is gone, or whose flow fails while it is walked, is counted as failed', async () => {
    const methods = new Map([get, save].map((m) => [m.key, m]));
    const s = fakeSession({ methods: [get, save], calls: { [get.key]: [call(0, save)] }, entryPoints: [ep('GET /shop', get), ep('GET /list', list)], adapter: { getMethod: async (k: string) => methods.get(k) } });
    expect((await all(s)).failed).toBe(1);
    let broken = false;
    const t = fakeSession({ methods: [get, save], calls: { [get.key]: [call(0, save)] }, entryPoints: [ep('GET /shop', get)], adapter: { getOutgoingCalls: async (m: MethodRef) => (broken && m.key === save.key ? Promise.reject(new Error('sidecar gone')) : m.key === get.key ? [call(0, save)] : []) } });
    broken = true;
    expect((await all(t)).failed).toBe(1);
  });
});

describe('FR-19.9 the classes of a project issue\'s evidence', () => {
  it('FR-19.9 an issue with only classes, and I/O in a Domain entry point\'s own method (the found message has no sender): the files of their classes', async () => {
    const order = cls('src/Domain/Order.cs', 'Order');
    const placeOrder = meth(order, 'Place');
    const pool = { key: 'lib:pg#Pool', name: 'Pool', kind: 'external' as const };
    const query = { key: 'lib:pg#Pool.query', name: 'query', owner: pool, isStatic: false, hasBody: false };
    const classifier = new DefaultClassifier('/p', { layers: [{ name: 'Domain', match: ['src/Domain/**'] }], findings: { maxDependencies: 1 } } as never);
    const s = fakeSession(
      {
        methods: [placeOrder],
        calls: { [placeOrder.key]: [call(0, query as never, { isLibrary: true, libraryName: 'pg', methodName: 'query' })] },
        infos: [info(order, { fields: [field('a', repo), field('b', iCheck)] })],
        entryPoints: [ep('POST /orders', placeOrder)],
      },
      { classifier },
    );
    const issues = (await s.findProjectIssues())!;
    expect(issues.map((f) => [f.finding.kind, f.finding.messageIds, f.files])).toEqual([
      ['io-in-domain', ['root'], ['src/Domain/Order.cs']],
      ['too-many-dependencies', undefined, ['src/Domain/Order.cs']],
    ]);
  });

  it('FR-26.1 a flow through a library\'s interface (a project class implements it): the interface is no class of the map', async () => {
    const iLog = { key: 'lib:Logging#ILogger', name: 'ILogger', kind: 'interface' as const };
    const log = { key: 'lib:Logging#ILogger.Log', name: 'Log', owner: iLog, isStatic: false, hasBody: false };
    const fileLog = meth(cls('src/Infra/FileLogger.cs', 'FileLogger'), 'Log');
    const s = fakeSession({ methods: [get, fileLog], calls: { [get.key]: [call(0, log as never)] }, impls: { [log.key]: [fileLog] }, entryPoints: [ep('GET /shop', get)] });
    // the flow's class diagram has its box
    await s.openMethodByKey(get.key);
    expect((await s.getClassDiagram())!.classes.map((c) => c.key)).toContain(iLog.key);
    expect((await all(s)).diagram.classes.map((c) => c.name)).toEqual(['ShopController', 'FileLogger']);
  });
});
