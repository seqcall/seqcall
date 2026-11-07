import { describe, expect, it } from 'vitest';
import type { CallerInfo, EntryPoint, MethodRef } from '@seqcall/protocol';
import type { FileType } from '../src/adapter';
import { findUnreachable, throttled, unreachableGroup, unreachableScan, type UnreachableWalk } from '../src/unreachable';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { at, call, cls, fakeAdapter, fakeSession, info, meth, type World } from './fake-world';

// FR-31 the project's methods no entry point reaches: a forward walk over an adapter answering from tables.
const ctl = cls('src/ShopController.ts', 'ShopController');
const svc = cls('src/Orders.ts', 'Orders');
const port = cls('src/Store.ts', 'Store', 'interface');
const sql = cls('src/SqlStore.ts', 'SqlStore');
const mem = cls('src/MemStore.ts', 'MemStore');
const util = cls('src/Util.ts', 'Util');
const get = meth(ctl, 'get');
const place = meth(svc, 'place');
const ctor = meth(svc, 'constructor');
const save = meth(port, 'save', { hasBody: false });
const sqlSave = meth(sql, 'save');
const memSave = meth(mem, 'save');
const format = meth(util, 'format');
const legacy = meth(util, 'legacy');
const helper = meth(util, 'helper');
const ep: EntryPoint = { kind: 'http', label: 'GET /shop', method: get };
const types = (...methods: MethodRef[]): FileType[] => {
  const by = new Map<string, MethodRef[]>();
  for (const m of methods) by.set(m.owner.key, [...(by.get(m.owner.key) ?? []), m]);
  return [...by.values()].map((ms) => ({ type: ms[0].owner, methods: ms }));
};
const ref = (enclosing: MethodRef, extra: Partial<CallerInfo> = {}): CallerInfo => ({ id: enclosing.key, enclosing, range: at('x.ts', 1), preview: '', ...extra });

function walk(w: World & { project: MethodRef[] }, extra: Partial<UnreachableWalk> = {}): UnreachableWalk {
  const adapter = fakeAdapter({ ...w, adapter: { getProjectTypes: async () => types(...w.project), ...w.adapter } });
  return { adapter, entryPoints: w.entryPoints ?? [ep], isTest: (f) => f.includes('/test/'), callers: async (m) => w.callers?.[m.key] ?? [], ...extra };
}
const gone = async () => Promise.reject(new Error('gone'));
const listed = (r: Awaited<ReturnType<typeof findUnreachable>>) => r!.methods.map((u) => `${u.method.owner.name}.${u.method.name} ${u.reason}${u.framework ? ` [${u.framework}]` : ''}`);

describe('FR-31.1 unreachable code', () => {
  it('FR-31.1 a call reaches its target, an interface call every implementation; what nothing reaches is listed by reason', async () => {
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, place, save, sqlSave, memSave, format, legacy, helper],
        calls: { [get.key]: [call(0, place)], [place.key]: [call(0, save)], [legacy.key]: [call(0, helper)] },
        impls: { [save.key]: [sqlSave, memSave] },
        callers: { [helper.key]: [ref(legacy)], [format.key]: [ref(meth(cls('test/OrdersTest.ts', 'OrdersTest'), 'it'), { inTest: true })] },
      }),
    );
    expect(listed(r)).toEqual(['Util.format tests-only', 'Util.legacy no-callers', 'Util.helper unreached-callers']);
    // the interface method has no body: not counted
    expect([r!.total, r!.reached, r!.entryPoints, r!.missed, r!.truncated]).toEqual([7, 4, 1, 0, false]);
  });

  it('FR-31.1 a method passed as an argument, and the calls of a lambda passed as one, are reached', async () => {
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, format, helper, legacy],
        calls: {
          [get.key]: [
            call(0, undefined, { argFunctions: [{ kind: 'method', target: format, receiver: { kind: 'static' }, isLibrary: false }] }),
            call(1, undefined, { argFunctions: [{ kind: 'lambda', range: at('x.ts', 3), calls: [call(0, helper)] }] }),
          ],
        },
      }),
    );
    expect(listed(r)).toEqual(['Util.legacy no-callers']);
  });

  it('FR-31.1 a route\'s middleware is reached (the framework runs it before the action)', async () => {
    const mw = meth(cls('src/Auth.php', 'Auth'), 'handle');
    const r = await findUnreachable(walk({ methods: [], project: [get, mw, legacy], entryPoints: [{ ...ep, middleware: [{ name: 'auth', method: mw, at: at('routes.php', 1), source: 'group' }, { name: 'api', at: at('routes.php', 1), source: 'group' }] }] }));
    expect(listed(r)).toEqual(['Util.legacy no-callers']);
  });

  it('FR-31.1 / FR-8.6 a call on a type the container binds runs the bound class\'s method of that name (also without implementing the type)', async () => {
    const bound = cls('src/FileStore.ts', 'FileStore');
    const fileSave = meth(bound, 'save');
    const fileLoad = meth(bound, 'load');
    const binding = { abstract: port.key, concrete: bound.key, range: at('src/Provider.ts', 1) };
    const r = await findUnreachable(
      walk({ methods: [], project: [get, place, sqlSave, fileSave, fileLoad], calls: { [get.key]: [call(0, place)], [place.key]: [call(0, save)] }, impls: { [save.key]: [sqlSave] }, adapter: { getBindings: async () => [binding, { ...binding, concrete: 'lib:cache#RedisStore' }] } }),
    );
    expect(listed(r)).toEqual(['FileStore.load no-callers']); // (a library class bound too: nothing of the project's)
    // an adapter without bindings, or failing to read them: the walk goes on without
    const failing = await findUnreachable(walk({ methods: [], project: [get, place, fileSave], calls: { [get.key]: [call(0, place)], [place.key]: [call(0, save)] }, adapter: { getBindings: gone } }));
    expect(listed(failing)).toEqual(['FileStore.save no-callers']);
  });

  it('FR-31.1 a constructor counts as reached when anything of its class is (DI creates objects without `new`), or the class is created', async () => {
    const dto = cls('src/Dto.ts', 'Dto');
    const dtoCtor = meth(dto, 'constructor');
    const lone = cls('src/Lone.ts', 'Lone');
    const loneCtor = meth(lone, 'constructor');
    const r = await findUnreachable(
      walk({ methods: [], project: [get, place, ctor, dtoCtor, loneCtor], calls: { [get.key]: [call(0, place), call(1, undefined, { kind: 'create', receiverType: dto })] } }),
    );
    expect(listed(r)).toEqual(['Lone.constructor no-callers']);
  });

  it('FR-31.1 the constructors of a reached class are walked (what they call runs with them); a static call constructs nothing', async () => {
    const helperOfCtor = meth(util, 'subscribe');
    const factory = cls('src/Factory.ts', 'Factory');
    const make = meth(factory, 'make', { isStatic: true });
    const factoryCtor = meth(factory, 'constructor');
    const r = await findUnreachable(walk({ methods: [], project: [get, place, ctor, helperOfCtor, make, factoryCtor], calls: { [get.key]: [call(0, place), call(1, make)], [ctor.key]: [call(0, helperOfCtor)] } }));
    expect(listed(r)).toEqual(['Factory.constructor no-callers']);
  });

  it('FR-31.1 a project class named as a library call\'s type argument is created (its constructors walked); UseMiddleware<T> also runs its Invoke / InvokeAsync', async () => {
    const audit = cls('src/AuditMiddleware.cs', 'AuditMiddleware');
    const auditCtor = meth(audit, 'constructor');
    const invokeAsync = meth(audit, 'InvokeAsync');
    const helperOf = meth(audit, 'Format');
    const shop = cls('src/Shop.cs', 'Shop');
    const shopCtor = meth(shop, 'constructor');
    const shopRun = meth(shop, 'Run');
    const lib = { key: 'lib:aspnet#IApplicationBuilder', name: 'IApplicationBuilder', kind: 'external' as const };
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, auditCtor, invokeAsync, helperOf, shopCtor, shopRun, legacy],
        calls: {
          [get.key]: [
            call(0, meth(lib, 'UseMiddleware'), { isLibrary: true, methodName: 'UseMiddleware', typeArguments: [{ name: 'TMiddleware', type: audit }, { name: 'TGone', type: cls('src/Gone.cs', 'Gone') }] }),
            call(1, meth(lib, 'AddScoped'), { isLibrary: true, methodName: 'AddScoped', typeArguments: [{ name: 'TService', type: port }, { name: 'TImpl', type: shop }, { name: 'TOptions', type: lib }, { name: 'T', parameter: 'T' }] }),
            call(2, undefined, { isLibrary: false, methodName: 'Map', typeArguments: [{ name: 'T', type: util }] }),
          ],
          [invokeAsync.key]: [call(0, helperOf)],
        },
      }),
    );
    expect(listed(r)).toEqual(['Shop.Run no-callers', 'Util.legacy no-callers']);
  });

  it('FR-31.1 a constructor that only stops others from creating the class (non-public, no parameters, calls nothing) is not listed', async () => {
    const program = cls('src/Program.cs', 'Program');
    const blocker = meth(program, 'constructor');
    const other = cls('src/Other.cs', 'Other');
    const otherCtor = meth(other, 'constructor');
    const ctorInfo = (visibility: 'private' | 'protected' | undefined, signature = 'constructor()') => ({ name: 'constructor', isStatic: false, signature, ...(visibility ? { visibility } : {}) });
    const run = async (programInfo: object[], calls: Record<string, ReturnType<typeof call>[]> = {}) =>
      listed(await findUnreachable(walk({ methods: [], project: [get, blocker, otherCtor], calls, infos: [info(program, { methods: programInfo as never }), info(other)] })));
    expect(await run([ctorInfo('protected')])).toEqual(['Other.constructor no-callers']);
    // public, with parameters, one of two, or calling something: a constructor like any other
    expect(await run([ctorInfo(undefined)])).toEqual(['Other.constructor no-callers', 'Program.constructor no-callers']);
    expect(await run([ctorInfo('private', 'constructor(string)')])).toEqual(['Other.constructor no-callers', 'Program.constructor no-callers']);
    expect(await run([ctorInfo('private'), ctorInfo('private', 'constructor(int)')])).toEqual(['Other.constructor no-callers', 'Program.constructor no-callers']);
    expect(await run([ctorInfo('private')], { [blocker.key]: [call(0, legacy)] })).toEqual(['Other.constructor no-callers', 'Program.constructor no-callers']);
  });

  it('FR-31.1 a method a reached method refers to is not listed (the walk missed that reference): counted as missed', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, format], callers: { [format.key]: [ref(get)] } }));
    expect([listed(r), r!.missed, r!.missedMethods.map((m) => m.key)]).toEqual([[], 1, [format.key]]);
  });

  it('FR-31.1 called from a function the method list does not hold (a closure, a local function), or used as a value: probably reached, not listed', async () => {
    const closure = meth(cls('src/Plugins.ts', 'makePlugin'), 'plugin');
    const r = await findUnreachable(
      walk({ methods: [], project: [get, format, legacy], callers: { [format.key]: [ref(closure)] }, adapter: { getValueUses: async (m: MethodRef) => (m.key === legacy.key ? 1 : 0) } }),
    );
    expect([listed(r), r!.missedMethods.map((m) => m.name)]).toEqual([[], ['format', 'legacy']]);
  });

  it('FR-31.1 the walk goes on from a method found probably reached: what it calls is reached too', async () => {
    const r = await findUnreachable(
      walk({ methods: [], project: [get, format, helper, legacy], calls: { [format.key]: [call(0, helper)] }, adapter: { getValueUses: async (m: MethodRef) => (m.key === format.key ? 1 : 0) } }),
    );
    expect([listed(r), r!.missed, r!.reached]).toEqual([['Util.legacy no-callers'], 1, 3]);
  });

  it('FR-31.1 module-level code (runs when its module loads) reaches what it calls', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, format, legacy], adapter: { getModuleCalls: async () => [call(0, format)] } }));
    expect(listed(r)).toEqual(['Util.legacy no-callers']);
  });

  it('FR-31.1 implementations are asked only for methods that can have them (not module functions, static methods, constructors)', async () => {
    const asked: string[] = [];
    const fn = meth({ key: 'src/util.ts#<module>', name: 'util', kind: 'module' }, 'slug');
    const make = meth(svc, 'make', { isStatic: true });
    await findUnreachable(
      walk({ methods: [], project: [get, fn, make, ctor], calls: { [get.key]: [call(0, fn), call(1, make), call(2, ctor)] }, adapter: { getImplementations: async (m: MethodRef) => (asked.push(m.name), []) } }),
    );
    expect(asked).toEqual(['get']);
  });

  it('FR-31.1 a recursive method calling itself still has no callers', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, legacy], callers: { [legacy.key]: [ref(legacy)] } }));
    expect(listed(r)).toEqual(['Util.legacy no-callers']);
  });

  it('FR-31.1 test code and test entry points are left out; library targets are not walked', async () => {
    const testCls = cls('test/OrdersTest.ts', 'OrdersTest');
    const t = meth(testCls, 'it');
    const lib = meth({ key: 'lib:express#Router', name: 'Router', kind: 'external' }, 'use');
    const r = await findUnreachable(
      walk({ methods: [], project: [get, t, legacy], entryPoints: [ep, { kind: 'test', label: 'OrdersTest.it', method: t }], calls: { [get.key]: [call(0, lib, { isLibrary: true }), call(1, legacy, { isLibrary: true })] } }),
    );
    expect([listed(r), r!.total, r!.entryPoints]).toEqual([['Util.legacy no-callers'], 2, 1]);
  });

  it('FR-31.1 a project without entry points (a library) lists nothing; an adapter that cannot list methods: nothing either', async () => {
    const lib = await findUnreachable(walk({ methods: [], project: [get, legacy], entryPoints: [] }));
    expect([lib!.methods, lib!.entryPoints, lib!.total]).toEqual([[], 0, 2]);
    const old = await findUnreachable(walk({ methods: [], project: [], adapter: { getProjectTypes: undefined } }));
    expect([old!.methods, old!.total]).toEqual([[], 0]);
  });

  it('FR-31.1 the walk stops at its method limit and says so', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, place, legacy], calls: { [get.key]: [call(0, place)], [place.key]: [call(0, legacy)] } }, { maxMethods: 1 }));
    expect(r!.truncated).toBe(true);
  });

  it('FR-31.1 cancelled while walking or while checking callers: undefined; progress reports both phases', async () => {
    let n = 0;
    expect(await findUnreachable(walk({ methods: [], project: [get, legacy] }, { cancelled: () => n++ > 0 }))).toBeUndefined();
    const phases: string[] = [];
    let checking = false;
    const r = await findUnreachable(
      walk({ methods: [], project: [get, legacy, helper] }, { cancelled: () => checking, onProgress: (p) => (phases.push(p), (checking = p === 'check')) }),
    );
    expect([r, phases]).toEqual([undefined, ['reach', 'check']]);
  });

  it('FR-31.1 cancelled while walking, or after the unreached methods\' own calls were read: undefined', async () => {
    expect(await findUnreachable(walk({ methods: [], project: [get, legacy] }, { cancelled: () => true }))).toBeUndefined();
    let half = false;
    const r = await findUnreachable(
      walk({ methods: [], project: [get, legacy, helper] }, { cancelled: () => half, onProgress: (p, done, total) => (half = p === 'check' && done === total! / 2) }),
    );
    expect(r).toBeUndefined();
  });

  it('FR-31.1 the reason from the references query: a non-test caller that is itself unreached; a method found only by the query and an unreached method calling itself or reached code', async () => {
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, legacy, helper, format],
        calls: { [legacy.key]: [call(0, legacy), call(1, get), call(2, undefined, { argFunctions: [undefined, { kind: 'lambda', range: at('x.ts', 2) }] })] },
        callers: { [format.key]: [ref(legacy)] },
      }),
    );
    expect(listed(r)).toEqual(['Util.legacy no-callers', 'Util.helper no-callers', 'Util.format unreached-callers']);
  });

  it('FR-31.1 methods without a declaration are listed after the others (sorted by file, then line)', async () => {
    const bare = meth(util, 'bare', { declaration: undefined });
    const bare2 = meth(util, 'bare2', { declaration: undefined });
    const r = await findUnreachable(walk({ methods: [], project: [get, legacy, bare, bare2] }));
    expect(listed(r)).toEqual(['Util.bare no-callers', 'Util.bare2 no-callers', 'Util.legacy no-callers']);
  });

  it('FR-31.1 an adapter that fails for one method: the walk goes on (its calls count as none)', async () => {
    const r = await findUnreachable(
      walk(
        { methods: [], project: [get, legacy], adapter: { getOutgoingCalls: gone, getImplementations: gone, getModuleCalls: gone, getValueUses: gone, getClassInfo: gone } },
        { callers: gone },
      ),
    );
    expect(listed(r)).toEqual(['Util.legacy no-callers']);
  });
});

describe('FR-31.2 probably called by the framework', () => {
  it('FR-31.2 a class whose project base class extends a library type (also further up, within six levels): through that base', async () => {
    const chain = Array.from({ length: 8 }, (_, i) => cls(`src/B${i}.ts`, `B${i}`));
    const validator = cls('src/OrderValidator.ts', 'OrderValidator');
    const check = meth(validator, 'check');
    const deep = cls('src/Deep.ts', 'Deep');
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, check, meth(deep, 'run')],
        infos: [
          info(validator, { extends: chain[0] }),
          info(chain[0], { implements: [{ key: 'lib:x#Rule', name: 'Rule', kind: 'interface' }] }),
          info(deep, { extends: chain[1] }),
          ...chain.slice(1, 7).map((c, i) => info(c, { extends: chain[i + 2] })),
          info(chain[7], { extends: { key: 'lib:x#Base', name: 'Base', kind: 'external' } }),
        ],
      }),
    );
    expect(listed(r)).toEqual(['Deep.run no-callers', 'OrderValidator.check no-callers [implements Rule, through B0]']);
  });

  it('FR-31.2 a magic / runtime method (`toJSON`), a class extending / implementing a library type: listed with the reason', async () => {
    const model = cls('src/Order.php', 'Order');
    const job = cls('src/Job.php', 'Job');
    const accessor = meth(model, 'getTotalAttribute');
    const magic = meth(job, '__invoke');
    const handle = meth(job, 'handle');
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, accessor, meth(model, 'cents'), magic, handle, legacy, meth(util, 'toJSON')],
        calls: { [legacy.key]: [call(0, handle)] },
        infos: [
          info(model, { extends: { key: 'lib:laravel#Model', name: 'Model', kind: 'external' }, methods: [{ name: 'getTotalAttribute', isStatic: false, signature: '', visibility: 'protected' }, { name: 'cents', isStatic: false, signature: '', visibility: 'private' }] }),
          info(job, { extends: { key: 'src/Base.php#Base', name: 'Base', kind: 'class' }, implements: [{ key: 'lib:laravel#ShouldQueue', name: 'ShouldQueue', kind: 'interface' }] }),
          info(cls('src/Base.php', 'Base'), { extends: { key: 'lib:laravel#Command', name: 'Command', kind: 'class' } }),
          info(util),
        ],
      }),
    );
    expect(listed(r)).toEqual(['Job.__invoke no-callers [magic method __invoke]', 'Job.handle unreached-callers [implements ShouldQueue]', 'Order.getTotalAttribute no-callers [extends Model]', 'Order.cents no-callers', 'Util.legacy no-callers', 'Util.toJSON no-callers [the runtime calls toJSON]']);
  });
});

describe('FR-31.2 / FR-31.3 / FR-31.4 what the framework, unresolved calls and the config explain', () => {
  const kernel = cls('src/Kernel.php', 'Kernel');
  const schedule = meth(kernel, 'schedule');
  const job = cls('src/Cleanup.php', 'Cleanup');
  const run = meth(job, 'run');
  const jobCtor = meth(job, 'constructor');
  const kernelInfo = info(kernel, { extends: { key: 'lib:laravel#ConsoleKernel', name: 'ConsoleKernel', kind: 'external' } });

  it('FR-31.2 the constructors of a framework-called method\'s class are walked too, and what they call', async () => {
    const invoke = meth(job, '__invoke');
    const r = await findUnreachable(walk({ methods: [], project: [get, invoke, jobCtor, legacy], calls: { [jobCtor.key]: [call(0, legacy)] } }));
    // a class whose constructor is framework-called itself (it extends a library type): not walked twice
    const both = await findUnreachable(walk({ methods: [], project: [get, schedule, meth(kernel, 'constructor')], infos: [kernelInfo] }));
    expect(both!.methods.map((u) => u.framework)).toEqual(['extends ConsoleKernel', 'extends ConsoleKernel']);
    expect(r!.methods.map((u) => `${u.method.owner.name}.${u.method.name}: ${u.framework}`)).toEqual([
      'Cleanup.__invoke: magic method __invoke',
      'Cleanup.constructor: called from Cleanup.__invoke, which the framework calls',
      'Util.legacy: called from Cleanup.__invoke, which the framework calls',
    ]);
  });

  it('FR-31.2 what a framework-called method reaches is labelled with it (a constructor through its class)', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, schedule, run, jobCtor, legacy], calls: { [schedule.key]: [call(0, run), call(1, get)] }, infos: [kernelInfo] }));
    expect(listed(r)).toEqual([
      'Cleanup.run unreached-callers [called from Kernel.schedule, which the framework calls]',
      'Cleanup.constructor no-callers [called from Kernel.schedule, which the framework calls]',
      'Kernel.schedule no-callers [extends ConsoleKernel]',
      'Util.legacy no-callers',
    ]);
  });

  it('FR-31.3 an unresolved call of the name in reached code (also in a lambda) or a template: maybe called, and what it reaches too', async () => {
    const r = await findUnreachable(
      walk({
        methods: [],
        project: [get, format, helper, legacy, place],
        calls: {
          [get.key]: [call(0, undefined, { methodName: 'Format', argFunctions: [{ kind: 'lambda', range: at('x.ts', 2), calls: [call(0, undefined, { methodName: 'nothing' })] }] }), call(1, undefined, { methodName: 'lib', isLibrary: true })],
          [format.key]: [call(0, helper)],
          [legacy.key]: [call(0, undefined, { methodName: 'place' })],
        },
        adapter: { getTemplateCallNames: async () => new Map([['legacy', 2]]) },
      }),
    );
    expect(r!.methods.map((u) => `${u.method.name} ${u.unresolved ?? '-'} ${u.via ?? '-'}`)).toEqual(['place - -', 'format 1 -', 'helper 1 Util.format', 'legacy 2 -']);
  });

  it('FR-31.2 / FR-31.3 an adapter failing while following framework-called methods or reading templates: nothing more is explained', async () => {
    const magic = meth(job, '__invoke');
    const r = await findUnreachable(walk({ methods: [], project: [get, magic, legacy], adapter: { getImplementations: gone, getTemplateCallNames: gone } }));
    expect(listed(r)).toEqual(['Cleanup.__invoke no-callers [magic method __invoke]', 'Util.legacy no-callers']);
  });

  it('FR-31.4 methods the config names are walked from like entry points, counted, not listed', async () => {
    const r = await findUnreachable(walk({ methods: [], project: [get, run, legacy, helper], calls: { [run.key]: [call(0, helper)] } }, { ignored: (m) => m.key === run.key }));
    expect([listed(r), r!.ignored]).toEqual([['Util.legacy no-callers'], 1]);
    expect((await findUnreachable(walk({ methods: [], project: [get, legacy] })))!.ignored).toBeUndefined();
  });

  it('FR-31.2 / FR-31.3 cancelled while following the framework-called or the maybe-called methods: undefined; the walk stops at its limit', async () => {
    const w = { methods: [], project: [get, schedule, run, legacy], calls: { [schedule.key]: [call(0, run)] }, infos: [kernelInfo], adapter: { getTemplateCallNames: async () => new Map([['legacy', 1]]) } };
    let checks = 0;
    const after = (n: number) => () => checks++ >= n;
    // the last checks: the framework walk (schedule, run), then the maybe walk (legacy)
    const counts: number[] = [];
    await findUnreachable(walk(w, { cancelled: () => (checks++, false) }));
    counts.push(checks);
    checks = 0;
    expect(await findUnreachable(walk(w, { cancelled: after(counts[0] - 2) }))).toBeUndefined();
    checks = 0;
    expect(await findUnreachable(walk(w, { cancelled: after(counts[0] - 1) }))).toBeUndefined();
    const capped = await findUnreachable(walk(w, { maxMethods: 0 }));
    expect(capped!.truncated).toBe(true);
  });
});

describe('FR-19.23 the group of a listed method, in ∅\'s words', () => {
  it('FR-19.23 framework before maybe called before the reason', () => {
    const u = { method: legacy, reason: 'no-callers' as const, callers: 0 };
    expect(unreachableGroup({ ...u, framework: 'extends Model', unresolved: 2 })).toBe('probably called by the framework');
    expect(unreachableGroup({ ...u, unresolved: 2, reason: 'tests-only' })).toBe('maybe called');
    expect(unreachableGroup(u)).toBe('no callers');
    expect(unreachableGroup({ ...u, reason: 'tests-only' })).toBe('only tests call it');
    expect(unreachableGroup({ ...u, reason: 'unreached-callers' })).toBe('called only from unreached code');
  });
});

describe('FR-31.1 the session', () => {
  it('FR-31.1 the scan is kept: across saves marked stale (until ↻ or a changed project config); test files by the testFiles globs', async () => {
    let asked = 0;
    const testCls = cls('tests/OrdersTest.ts', 'OrdersTest');
    const w: World = { methods: [get, legacy], entryPoints: [ep], adapter: { getProjectTypes: async () => (asked++, types(get, legacy, meth(testCls, 'it'))) } };
    const s = fakeSession(w);
    const first = (await s.findUnreachableCode())!;
    expect([first.methods.map((u) => u.method.key), first.total]).toEqual([[legacy.key], 2]);
    await s.findUnreachableCode();
    expect(asked).toBe(1);
    await s.findUnreachableCode({ rescan: true });
    expect(asked).toBe(2);
    expect(first.stale).toBeUndefined();
    // a save: the walk is not repeated (it takes minutes on a large project); the list says it is older than the code
    await s.refresh(['/p/src/Util.ts']);
    const kept = (await s.findUnreachableCode())!;
    expect(asked).toBe(2);
    expect(kept.stale).toBe(true);
    expect(kept.methods).toEqual(first.methods);
    // the project config changed (`unreachable.ignore` may have): walked again
    await s.refresh(['/p/.seqcall.json']);
    const third = (await s.findUnreachableCode())!;
    expect(asked).toBe(3);
    expect(third.stale).toBeUndefined();
    // a cancelled rescan keeps the last result
    expect(await s.findUnreachableCode({ rescan: true, cancelled: () => true })).toBeUndefined();
    expect(await s.findUnreachableCode()).toBe(third);
  });

  it('FR-31.4 `unreachable.ignore` in the project config: globs on the file or on Class.method', async () => {
    const run = meth(cls('src/Jobs/Cleanup.ts', 'Cleanup'), 'run');
    const w: World = { methods: [get, legacy, run, format], entryPoints: [ep], adapter: { getProjectTypes: async () => types(get, legacy, run, format) } };
    const s = fakeSession(w, { classifier: new DefaultClassifier('/p', { unreachable: { ignore: ['src/Jobs/**', 'Util.leg*', ''] } }) });
    const r = (await s.findUnreachableCode())!;
    expect([r.methods.map((u) => u.method.name), r.ignored]).toEqual([['format'], 2]);
    // a method without a declaration is matched by its name only
    const bare = meth(util, 'legacyBare', { declaration: undefined });
    const s2 = fakeSession({ ...w, adapter: { getProjectTypes: async () => types(get, bare) } }, { classifier: new DefaultClassifier('/p', { unreachable: { ignore: ['Util.leg*'] } }) });
    expect((await s2.findUnreachableCode())!.ignored).toBe(1);
    const none = (await fakeSession(w, { classifier: new DefaultClassifier('/p', {}) }).findUnreachableCode())!;
    expect(none.methods.map((u) => u.method.name)).toEqual(['run', 'legacy', 'format']);
  });

  it('FR-31.1 a host classifier without a project root: test files relative to the adapter\'s root', async () => {
    const testCls = cls('tests/OrdersTest.ts', 'OrdersTest');
    const base = new DefaultClassifier('/nowhere', {});
    const classifier: Classifier = { classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => [], reloadConfig: () => undefined };
    const s = fakeSession({ methods: [get, legacy], entryPoints: [ep], adapter: { getProjectTypes: async () => types(get, legacy, meth(testCls, 'it')) } }, { classifier });
    expect((await s.findUnreachableCode())!.total).toBe(2);
  });
});

describe('FR-31 helpers for the hosts', () => {
  it('FR-31 the scan as sent to the view has no probe list; progress passes at most every 250 ms', async () => {
    const r = (await findUnreachable(walk({ methods: [], project: [get, legacy] })))!;
    expect(unreachableScan(r)).toEqual({ methods: r.methods, total: 2, reached: 1, entryPoints: 1, missed: 0, truncated: false });
    let t = 1000;
    const seen: number[] = [];
    const post = throttled((n: number) => seen.push(n), 250, () => t);
    post(1);
    t += 100;
    post(2);
    t += 200;
    post(3);
    expect(seen).toEqual([1, 3]);
    const fallback = throttled((n: number) => seen.push(n));
    fallback(4);
    expect(seen).toEqual([1, 3, 4]);
  });
});
