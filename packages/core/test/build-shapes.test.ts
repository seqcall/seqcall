import { describe, expect, it } from 'vitest';
import type { ClassRef, EntryPoint, MethodRef, SequenceDiagram, SourceRange } from '@seqcall/protocol';
import type { CallSite, ClassInfo, ContainerBinding, EarlyExit, LanguageAdapter, ReturnFact } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { calleeText, targetNames } from '../src/session/build';

// The diagram build (session/build.ts) on adapter results written per test — the shapes the C#, PHP and TS adapters
// report that the sample projects do not have: the DI container's object graph, generic creations, typed calls on
// `any` parameters, passed functions and lambdas, returned objects, early exits.
const at = (file: string, line: number, character = 0): SourceRange => ({ file: `/p/${file}`, start: { line, character }, end: { line, character: character + 5 } });
const cls = (file: string, name: string, kind: ClassRef['kind'] = 'class', declaration?: SourceRange): ClassRef => ({ key: `${file}#${name}`, name, kind, ...(declaration ? { declaration } : {}) });
const meth = (owner: ClassRef, name: string, extra: Partial<MethodRef> = {}): MethodRef => ({ key: `${owner.key}.${name}`, name, owner, isStatic: false, hasBody: true, ...extra }) as MethodRef;
let line = 0;
const call = (ordinal: number, target: MethodRef | undefined, extra: Partial<CallSite> = {}): CallSite => {
  line++;
  return { ordinal, kind: 'call', range: at('x.cs', line), methodName: target?.name ?? 'x', expressionText: `${target?.name ?? 'x'}()`, args: [], receiver: { kind: 'field', name: 'f' }, target, isAsync: false, isLibrary: false, ...extra } as CallSite;
};
const info = (ref: ClassRef, extra: Partial<ClassInfo> = {}): ClassInfo =>
  ({ ref, decorators: [], implements: [], fields: [], constructorParams: [], hasPrivateConstructor: false, hasStaticInstance: false, allMembersStatic: false, isExportedInstance: false, methods: [], ...extra }) as ClassInfo;

interface World {
  methods: MethodRef[];
  calls?: Record<string, CallSite[]>;
  impls?: Record<string, MethodRef[]>;
  infos?: ClassInfo[];
  bindings?: ContainerBinding[];
  entryPoints?: EntryPoint[];
  exits?: Record<string, EarlyExit[]>;
  returns?: Record<string, ReturnFact[]>;
  params?: Record<string, string[]>;
}
function session(w: World, options: Record<string, unknown> = {}): DiagramSession {
  const methods = new Map(w.methods.map((m) => [m.key, m]));
  const infos = new Map((w.infos ?? []).map((i) => [i.ref.key, i]));
  const adapter = {
    projectRoot: '/p',
    findEnclosingCallable: async () => undefined,
    getMethod: async (k: string) => methods.get(k),
    getOutgoingCalls: async (m: MethodRef) => w.calls?.[m.key] ?? [],
    getImplementations: async (m: MethodRef) => w.impls?.[m.key] ?? [],
    getCallers: async () => [],
    getClassInfo: async (k: string) => infos.get(k),
    getParameterNames: async (m: MethodRef) => w.params?.[m.key] ?? [],
    getEarlyExits: async (m: MethodRef) => w.exits?.[m.key] ?? [],
    getReturns: async (m: MethodRef) => w.returns?.[m.key] ?? [],
    ...(w.bindings ? { getBindings: async () => w.bindings! } : {}),
    ...(w.entryPoints ? { getEntryPoints: async () => w.entryPoints! } : {}),
    updateFile: async () => undefined,
    dispose: async () => undefined,
  } as unknown as LanguageAdapter;
  return new DiagramSession({
    adapter,
    classifier: new DefaultClassifier('/nowhere', {}),
    // FR-3.12 the frames and catches as the code has them: ↯ Fold errors off
    initialState: { options: { showArguments: true, maxArgumentLength: 30, showLibraryCalls: false, followCursor: false, showResults: true, foldErrors: false, ...options } as never },
  });
}
const show = (d: SequenceDiagram) => d.messages.map((m) => `${m.id} ${m.kind} ${m.from ?? '-'}→${m.to}`);

describe('FR-8.7 the DI container builds the entry point\'s object graph', () => {
  // OrdersController(IOrders orders, ILogger log, Dup dup) — IOrders bound to Orders(Repo repo) — Repo(Db db) — Db(Pool pool)
  const ctl = cls('src/Api/OrdersController.cs', 'OrdersController');
  const iOrders = cls('src/Core/IOrders.cs', 'IOrders', 'interface');
  const orders = cls('src/Core/Orders.cs', 'Orders', 'class', at('Orders.cs', 1));
  const repo = cls('src/Infra/Repo.cs', 'Repo');
  const db = cls('src/Infra/Db.cs', 'Db');
  const pool = cls('src/Infra/Pool.cs', 'Pool');
  const mailer = cls('src/Infra/Mailer.cs', 'Mailer');
  const get = meth(ctl, 'Get');
  const binding: ContainerBinding = { abstract: iOrders.key, concrete: orders.key, range: at('Program.cs', 9) };
  const infos = [
    info(ctl, {
      constructorParams: [
        { name: 'orders', type: iOrders },
        { name: 'log', type: { key: 'lib:Logging#ILogger', name: 'ILogger', kind: 'interface' } },
        { name: 'raw', type: { key: 'Raw', name: 'Raw', kind: 'class' } },
        { name: 'nothing' },
        { name: 'cache', type: cls('src/Core/ICache.cs', 'ICache', 'interface') },
        { name: 'mailer', type: mailer },
      ],
      // the injected field named like the parameter (`_orders`); two injected fields of a type, neither named like it
      fields: [{ name: '_orders', type: iOrders, isStatic: false, injected: true }, { name: '_m1', type: mailer, isStatic: false, injected: true }, { name: '_m2', type: mailer, isStatic: false, injected: true }],
    }),
    // the parameter is the field (a primary constructor), though an injected `_repo` exists too
    info(orders, { constructorParams: [{ name: 'repo', type: repo }], fields: [{ name: 'repo', type: repo, isStatic: false, injected: false }, { name: '_repo', type: repo, isStatic: false, injected: true }] }),
    // the only injected field of its type
    info(repo, { constructorParams: [{ name: 'db', type: db }, { name: 'again', type: db }], fields: [{ name: '_connections', type: db, isStatic: false, injected: true }] }),
    info(db, { constructorParams: [{ name: 'pool', type: pool }] }),
    info(pool, { constructorParams: [{ name: 'deeper', type: cls('src/Infra/Deeper.cs', 'Deeper') }] }),
  ];
  const world: World = { methods: [get], infos, bindings: [binding], entryPoints: [{ kind: 'http', label: 'GET /orders', method: get } as EntryPoint] };

  it('FR-8.7 a C# entry point: GetRequiredService(typeof(…)), dependencies before their consumers, three levels deep, each class once', async () => {
    const s = session(world);
    let d = (await s.openMethodByKey(get.key, world.entryPoints![0]))!;
    expect(d.messages[0]).toMatchObject({ id: 'container', methodName: 'GetRequiredService', args: ['typeof(OrdersController)'], expandable: true, expanded: false });
    // the controller has no declaration: the container call has no site
    expect(d.messages[0]).not.toHaveProperty('callSite');
    d = (await s.expand('container'))!;
    const creates = d.messages.filter((m) => m.parentId === 'container');
    // Db is built (a third level), its own dependencies are not followed; Repo is not built twice for `again`
    expect(creates.map((m) => `${m.className}${m.result?.kind === 'assign' ? ` → ${m.result.target}` : ''}${m.callSite ? ` @${m.callSite.file}:${m.callSite.start.line}` : ''}`)).toEqual([
      'Db → _connections',
      'Db → _connections',
      'Repo → repo',
      'Orders → _orders @/p/Program.cs:9',
      'Mailer → mailer',
      'OrdersController',
    ]);
  });

  it('FR-8.7 / FR-11 hiding the container\'s call hides the step; a filter on another class does not', async () => {
    const s = session(world);
    await s.openMethodByKey(get.key, world.entryPoints![0]);
    const hidden = (await s.hide({ kind: 'classMethod', classKey: 'lib:Microsoft.Extensions.DependencyInjection#IServiceProvider', className: 'ServiceProvider', methodName: 'GetRequiredService' }))!;
    expect(hidden.messages[0].id).toBe('root');
    expect(hidden.hiddenFilters[0].hiddenCount).toBe(1);
    const other = session(world);
    await other.openMethodByKey(get.key, world.entryPoints![0]);
    const kept = (await other.hide({ kind: 'classMethod', classKey: 'src/Core/Other.cs#Other', className: 'Other', methodName: 'GetRequiredService' }))!;
    expect(kept.messages[0].id).toBe('container');
  });

  it('FR-8.7 / FR-11.8 a category rule hides the step too: classes named *Provider; *Repository does not', async () => {
    const s = session(world);
    await s.openMethodByKey(get.key, world.entryPoints![0]);
    expect((await s.hide({ kind: 'classPattern', pattern: '*Repository' }))!.messages[0].id).toBe('container');
    const hidden = (await s.hide({ kind: 'classPattern', pattern: '*Provider' }))!;
    expect(hidden.messages[0].id).toBe('root');
    expect(hidden.hiddenFilters.find((f) => f.filter.id === 'classPattern:*Provider')!.hiddenCount).toBe(1);
  });

  it('FR-8.7 a class without dependencies: no container step, and a filter for it counts nothing', async () => {
    const lone = cls('src/Api/Lone.cs', 'Lone');
    const run = meth(lone, 'Run');
    const entry = { kind: 'http', label: 'GET /lone', method: run } as EntryPoint;
    const s = session({ methods: [run], infos: [info(lone)], bindings: [], entryPoints: [entry] });
    await s.openMethodByKey(run.key, entry);
    const d = (await s.hide({ kind: 'class', classKey: 'lib:Microsoft.Extensions.DependencyInjection#IServiceProvider', className: 'ServiceProvider' }))!;
    expect(d.messages.map((m) => m.id)).toEqual(['root']);
    expect(d.hiddenFilters[0].hiddenCount).toBe(0);
  });

  it('FR-8.7 at most 25 dependencies, then the entry point\'s own object', async () => {
    const big = cls('src/Api/Big.cs', 'Big');
    const run = meth(big, 'Run');
    const deps = Array.from({ length: 30 }, (_, i) => cls(`src/Core/D${i}.cs`, `D${i}`));
    const entry = { kind: 'http', label: 'GET /big', method: run } as EntryPoint;
    const s = session({ methods: [run], infos: [info(big, { constructorParams: deps.map((t, i) => ({ name: `d${i}`, type: t })) }), ...deps.map((t) => info(t))], bindings: [], entryPoints: [entry] });
    await s.openMethodByKey(run.key, entry);
    const d = (await s.expand('container'))!;
    const made = d.messages.filter((m) => m.parentId === 'container');
    expect(made).toHaveLength(26);
    expect(made.at(-1)!.className).toBe('Big');
  });
});

describe('FR-5.9 / FR-1.19 / FR-8 calls the caller decides', () => {
  const svc = cls('src/Core/Svc.cs', 'Svc');
  const resp = cls('src/Core/Response.cs', 'Response');
  const fallback = cls('src/Core/Base.cs', 'BaseResponse');

  it('FR-5.9 `new TResponse` creates the class the caller named, passed on through the caller\'s own type parameter; else its constraint', async () => {
    const run = meth(svc, 'Run');
    const outer = meth(svc, 'Outer');
    const make = meth(svc, 'Make');
    const s = session({
      methods: [run, outer, make],
      calls: {
        // Run: Outer<Response>(); Outer<T>: Make<T>(); Make<TResponse>: new TResponse()
        [run.key]: [call(0, outer, { receiver: { kind: 'self' }, typeArguments: [{ name: 'T', type: resp }] })],
        [outer.key]: [call(0, make, { receiver: { kind: 'self' }, typeArguments: [{ name: 'TResponse', parameter: 'T' }, { name: 'TOther', parameter: 'Unknown' }, { name: 'TNone' }] }), call(1, make, { receiver: { kind: 'self' } })],
        [make.key]: [call(0, undefined, { kind: 'create', methodName: 'constructor', typeParameter: 'TResponse', receiverType: fallback, receiver: { kind: 'none' } })],
      },
    });
    await s.openMethodByKey(run.key);
    await s.expand('root/0:Outer');
    await s.expand('root/0:Outer/0:Make');
    const d = (await s.expand('root/0:Outer/1:Make'))!;
    const made = d.messages.filter((m) => m.kind === 'create').map((m) => d.participants.find((p) => p.id === m.to)!.className);
    expect(made).toEqual(['Response', 'BaseResponse']);
  });

  it('FR-1.19 a call on a parameter typed any goes to the type the caller passed (a library type: a library call)', async () => {
    const run = meth(svc, 'Run');
    const respond = meth(svc, 'Respond');
    const s = session(
      {
        methods: [run, respond],
        params: { [respond.key]: ['store'] },
        calls: {
          [run.key]: [call(0, respond, { receiver: { kind: 'self' }, argTypes: [{ type: { key: 'lib:pg#Pool', name: 'Pool', kind: 'external' }, isLibrary: true, libraryName: 'pg' }] })],
          [respond.key]: [call(0, undefined, { methodName: 'query', receiver: { kind: 'parameter', name: 'store' }, untypedReceiver: 'store' })],
        },
      },
      { showLibraryCalls: true },
    );
    await s.openMethodByKey(run.key);
    const d = (await s.expand('root/0:Respond'))!;
    expect(d.messages.find((m) => m.id === 'root/0:Respond/0:query')).toMatchObject({ isLibrary: true, className: 'Pool', methodKey: 'lib:pg#Pool.query' });
  });

  it('FR-8 a call on an object the flow created runs that class\'s implementation; keyed registrations are listed', async () => {
    const iRepo = cls('src/Core/IRepo.cs', 'IRepo', 'interface');
    const sql = cls('src/Infra/SqlRepo.cs', 'SqlRepo');
    const mem = cls('src/Infra/MemRepo.cs', 'MemRepo');
    const find = meth(iRepo, 'Find', { hasBody: false });
    const run = meth(svc, 'Run');
    const s = session({
      methods: [run, find],
      impls: { [find.key]: [meth(sql, 'Find'), meth(mem, 'Find')] },
      calls: {
        [run.key]: [
          call(0, meth(mem, 'constructor', { hasBody: false }), { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, assignedTo: { kind: 'local', name: 'repo' } }),
          call(1, find, { receiver: { kind: 'local', name: 'repo' } }),
          call(2, find, { receiver: { kind: 'field', name: '_repo' }, typeArguments: [{ name: 'T', type: sql }, { name: 'U' }] }),
        ],
      },
      bindings: [{ abstract: iRepo.key, concrete: sql.key, key: 'primary', keyKind: 'key', range: at('Program.cs', 3) }],
    });
    const d = (await s.openMethodByKey(run.key))!;
    expect(d.messages.find((m) => m.id === 'root/1:Find')!.polymorphic).toMatchObject({ selectedKey: mem.key });
    expect(d.messages.find((m) => m.id === 'root/2:Find')!.polymorphic).toMatchObject({ selectedKey: undefined, keyed: [{ classKey: sql.key, key: 'primary', kind: 'key' }] });
  });
});

describe('FR-1.13 / FR-1.11 functions and lambdas passed along', () => {
  const svc = cls('src/app/svc.ts', 'Svc');
  const util = cls('src/app/util.ts', 'Util');

  it('FR-1.11 a lambda without parameters written by the caller is drawn back to it; an invoked parameter nobody bound is a call on the sender', async () => {
    const run = meth(svc, 'run');
    const each = meth(util, 'each');
    const log = meth(svc, 'log');
    const lambda = { kind: 'lambda' as const, range: at('svc.ts', 40), calls: [call(0, log, { receiver: { kind: 'self' } })] };
    const s = session({
      methods: [run, each, log],
      params: { [each.key]: ['fn', 'other'] },
      calls: {
        [run.key]: [call(0, each, { receiver: { kind: 'field', name: 'util' }, argFunctions: [lambda] })],
        [each.key]: [call(0, undefined, { methodName: 'fn', invokedParameter: 'fn', receiver: { kind: 'none' } }), call(1, undefined, { methodName: 'other', invokedParameter: 'other', receiver: { kind: 'none' } })],
        [log.key]: [],
      },
    });
    await s.openMethodByKey(run.key);
    await s.expand('root/0:each');
    const d = (await s.expand('root/0:each/0:fn'))!;
    const by = (id: string) => d.messages.find((m) => m.id === id)!;
    expect(by('root/0:each/0:fn')).toMatchObject({ viaLambda: true, to: by('root').to });
    expect(by('root/0:each/0:fn/0:log').kind).toBe('self');
    // `other` was not given: a call on the sender itself
    expect(by('root/0:each/1:other')).toMatchObject({ kind: 'self', viaParameter: 'other', className: 'Util' });
  });
});

describe('FR-1.12 / FR-1.15 frames and exits', () => {
  const svc = cls('src/app/svc.ts', 'Svc');
  const dep = cls('src/app/dep.ts', 'Dep');

  it('FR-1.15 the guard an exit states: a catch\'s (or "catch"), an else\'s negated condition; none in a try block; folded with its frame', async () => {
    const run = meth(svc, 'run');
    const work = meth(dep, 'work');
    const scope = (id: string, kind: 'try' | 'alt' | 'opt', operand: number, guard?: string, extra = {}) => ({ id, kind, operand, ...(guard !== undefined ? { guard } : {}), ...extra });
    const exit = (l: number, fragments: object[]): EarlyExit => ({ kind: 'return', range: at('svc.ts', l), fragments } as EarlyExit);
    const s = session({
      methods: [run, work],
      calls: { [run.key]: [call(0, work, { range: at('svc.ts', 100), fragments: [scope('if@1', 'opt', 0, 'ready')] })] },
      exits: {
        [run.key]: [
          exit(1, [scope('try@1', 'try', 0)]),
          exit(2, [scope('try@1', 'try', 1)]),
          exit(3, [scope('try@1', 'try', 2, 'catch IOException')]),
          exit(4, [scope('if@2', 'alt', 1, 'else', { negatedGuard: '!ok' })]),
          exit(5, [scope('if@3', 'alt', 0, 'ok')]),
          exit(200, [scope('if@1', 'opt', 0, 'ready')]),
          { kind: 'throw', range: at('svc.ts', 300) } as EarlyExit,
        ],
      },
    });
    const d = (await s.openMethodByKey(run.key))!;
    expect(d.exits!.map((e) => e.guard ?? '-')).toEqual(['-', 'catch', 'catch IOException', '!ok', 'ok', '-', '-']);
    // the frame around `work` minimized: its exit is folded with it
    const folded = (await s.collapseFragment(d.fragments![0].id))!;
    expect(folded.exits!.map((e) => e.range.start.line)).toEqual([1, 2, 3, 4, 5, 300]);
  });

  it('FR-1.3 a root without a body is drawn alone; at most 2000 messages are drawn', async () => {
    const decl = meth(svc, 'abstractRun', { hasBody: false });
    const s = session({ methods: [decl] });
    expect((await s.openMethodByKey(decl.key))!.messages.map((m) => m.id)).toEqual(['root']);
    const run = meth(svc, 'run');
    const target = meth(dep, 'work');
    const many = session({ methods: [run, target], calls: { [run.key]: Array.from({ length: 2100 }, (_, i) => call(i, target, { range: at('svc.ts', i) })) } });
    expect((await many.openMethodByKey(run.key))!.messages).toHaveLength(2000);
  });
});

describe('FR-6.5 / FR-5.11 / FR-8.6 which object a call goes to', () => {
  const svc = cls('src/app/Svc.cs', 'Svc');
  const base = cls('src/app/Base.cs', 'Base', 'abstract');
  const mid = cls('src/app/Mid.cs', 'Mid');
  const leaf = cls('src/app/Leaf.cs', 'Leaf');
  const iJob = cls('src/app/IJob.cs', 'IJob', 'interface');

  it('FR-6.5 a call with no receiver on an object method: one object of the class; a passed method of a new object too', async () => {
    const run = meth(svc, 'Run');
    const each = meth(svc, 'Each');
    const handle = meth(leaf, 'Handle');
    const s = session({
      methods: [run, each, handle],
      params: { [each.key]: ['fn'] },
      calls: {
        [run.key]: [
          call(0, handle, { receiver: { kind: 'none' } }),
          call(1, each, { receiver: { kind: 'self' }, argFunctions: [{ kind: 'method', target: handle, receiver: { kind: 'created', ordinal: 9 }, isLibrary: false }] }),
        ],
        [each.key]: [call(0, undefined, { methodName: 'fn', invokedParameter: 'fn', receiver: { kind: 'none' } })],
      },
    });
    await s.openMethodByKey(run.key);
    const d = (await s.expand('root/1:Each'))!;
    expect(d.messages.find((m) => m.id === 'root/0:Handle')!.to).toBe(`${leaf.key}|instance`);
    expect(d.messages.find((m) => m.id === 'root/1:Each/0:fn')!.to).toBe(`${leaf.key}|instance`);
  });

  it('FR-5.11 a subclass object calling a method its grandparent declares: drawn as the subclass, the row in the grandparent; through an interface no base is looked for', async () => {
    const run = meth(svc, 'Run');
    const save = meth(base, 'Save');
    const s = session({
      methods: [run, save],
      infos: [info(leaf, { extends: mid }), info(mid, { extends: base }), info(base)],
      calls: { [run.key]: [call(0, save, { receiver: { kind: 'field', name: 'leaf' }, receiverType: leaf }), call(1, meth(iJob, 'Save'), { receiver: { kind: 'field', name: 'job' }, receiverType: iJob })] },
    });
    const d = (await s.openMethodByKey(run.key))!;
    const m = d.messages.find((x) => x.id === 'root/0:Save')!;
    expect(d.participants.find((p) => p.id === m.to)!.className).toBe('Leaf');
    expect(m.inheritedFrom).toEqual({ key: base.key, name: 'Base' });
    expect(d.messages.find((x) => x.id === 'root/1:Save')!.inheritedFrom).toBeUndefined();
  });

  it('FR-5.11 an object typed by an abstract class running a method its base declares: the row in that base', async () => {
    const part = cls('src/app/Part.cs', 'Part', 'abstract');
    const run = meth(svc, 'Run');
    const save = meth(base, 'Save');
    const s = session({ methods: [run, save], infos: [info(part, { extends: base }), info(base)], calls: { [run.key]: [call(0, save, { receiver: { kind: 'field', name: 'part' }, receiverType: part })] } });
    const d = (await s.openMethodByKey(run.key))!;
    const m = d.messages.find((x) => x.id === 'root/0:Save')!;
    expect([d.participants.find((p) => p.id === m.to)!.className, m.inheritedFrom]).toEqual(['Part', { key: base.key, name: 'Base' }]);
  });

  it('FR-8.6 the container binds a class that inherits the implementation from its grandparent: that object, the ancestor\'s method', async () => {
    const run = meth(svc, 'Run');
    const exec = meth(iJob, 'Exec', { hasBody: false });
    const baseExec = meth(base, 'Exec');
    const other = cls('src/app/Other.cs', 'Other');
    const s = session({
      methods: [run, exec],
      impls: { [exec.key]: [baseExec, meth(other, 'Exec')] },
      infos: [info(leaf, { extends: mid }), info(mid, { extends: base }), info(base), info(svc, { fields: [{ name: '_job', type: iJob, isStatic: false, injected: true }] })],
      calls: { [run.key]: [call(0, exec, { receiver: { kind: 'field', name: '_job' } })] },
      bindings: [{ abstract: iJob.key, concrete: leaf.key, range: at('Program.cs', 1) }],
    });
    const d = (await s.openMethodByKey(run.key))!;
    const m = d.messages.find((x) => x.id === 'root/0:Exec')!;
    expect(m.polymorphic).toMatchObject({ selectedKey: leaf.key, implementations: [{ key: base.key }, { key: other.key }, { key: leaf.key }] });
    expect(m.methodKey).toBe(baseExec.key);
    // bound to a class without class info: no inherited implementation, offered as a choice
    const unknown = session({
      methods: [run, exec],
      impls: { [exec.key]: [baseExec] },
      calls: { [run.key]: [call(0, exec, { receiver: { kind: 'field', name: '_job' } })] },
      bindings: [{ abstract: iJob.key, concrete: 'src/app/Gone.cs#Gone', range: at('Program.cs', 1) }],
    });
    expect((await unknown.openMethodByKey(run.key))!.messages[1].polymorphic).toMatchObject({ implementations: [{ key: base.key }] });
  });

  it('FR-6.5 objects of a class drawn more than once are named by their variables; one without a variable by its class', async () => {
    const run = meth(svc, 'Run');
    const find = meth(leaf, 'Find');
    const s = session({ methods: [run, find], calls: { [run.key]: [call(0, find, { receiver: { kind: 'field', name: 'primary' } }), call(1, find, { receiver: { kind: 'field', name: 'replica' } }), call(2, find, { receiver: { kind: 'expression', text: 'pick()' } })] } });
    const d = (await s.openMethodByKey(run.key))!;
    expect(d.participants.map((p) => p.label)).toEqual([':Svc', 'primary:Leaf', 'replica:Leaf', ':Leaf']);
  });

  it('FR-5.8 a single target that is skipped is no destructuring', () => {
    expect(targetNames('[_]')).toBeUndefined();
    expect(targetNames('[, b]')).toEqual(['', 'b']);
  });
});

describe('FR-5.7 / FR-5.8 the object a call returns is the caller\'s', () => {
  const svc = cls('src/app/Svc.cs', 'Svc');
  const order = cls('src/app/Order.cs', 'Order');
  const iOrder = cls('src/app/IOrder.cs', 'IOrder', 'interface');
  const other = cls('src/app/Other.cs', 'Other');
  const run = meth(svc, 'Run');
  const make = meth(svc, 'Make');
  const inner = meth(svc, 'Inner');
  const send = meth(order, 'Send');
  const ctor = meth(order, 'constructor', { hasBody: false });
  const site = (l: number, c = 4, len = 10): SourceRange => ({ file: '/p/Svc.cs', start: { line: l, character: c }, end: { line: l, character: c + len } });
  const assign = (target: string, operator = '=') => ({ result: { kind: 'assign' as const, target, operator } });
  /** Run: `var o = Make(); o.Send();` (the variable typed `varType`); Make's body and return facts as given. Where does Send go? */
  async function sendGoesTo(body: CallSite[], facts: ReturnFact[] | undefined, extra: Partial<World> = {}, varType: ClassRef = order, target = 'o') {
    const s = session({
      methods: [run, make, inner],
      calls: {
        [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), ...assign(target) }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: varType, range: site(2) })],
        [make.key]: body,
        ...extra.calls,
      },
      returns: facts ? { [make.key]: facts } : {},
      ...extra,
      ...(extra.calls ? { calls: { [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), ...assign(target) }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: varType, range: site(2) })], [make.key]: body, ...extra.calls } } : {}),
    });
    await s.openMethodByKey(run.key);
    const d = (await s.expand('root/0:Make'))!;
    const m = d.messages.find((x) => x.id === 'root/1:Send')!;
    return m.to.includes('|new:') ? 'created' : m.to.replace(/^.*\|/, '');
  }
  const create = (o: number, l: number, extra: Partial<CallSite> = {}) => call(o, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(l), ...extra });

  it('FR-5.8 a returned variable: what the body assigned to it (with = or ??=), not a compound assignment; a tuple the caller does not take apart is no object', async () => {
    const ret = (l: number, v: object, tuple = false): ReturnFact => ({ range: site(l, 0, 40), ...(tuple ? { tuple } : {}), values: [{ range: site(l, 7, 1), ...v } as never] });
    expect(await sendGoesTo([create(0, 10, assign('p'))], [ret(11, { variable: 'p' })])).toBe('created');
    expect(await sendGoesTo([create(0, 10, assign('$p', '??='))], [ret(11, { variable: 'p' })])).toBe('created');
    expect(await sendGoesTo([create(0, 10, assign('p', '+='))], [ret(11, { variable: 'p' })])).toBe('var:o');
    // assignments to other variables are no evidence; a null return is none
    expect(await sendGoesTo([create(0, 10, assign('q')), create(1, 12, assign('p'))], [ret(13, { variable: 'p' }), ret(14, { empty: true })])).toBe('created');
    // a tuple: the caller takes it as one value — no element is meant
    expect(await sendGoesTo([create(0, 10)], [{ range: site(11, 0, 40), tuple: true, values: [{ range: site(10) }] }])).toBe('var:o');
    // a return statement without a value
    expect(await sendGoesTo([create(0, 10, assign('p'))], [{ range: site(11, 0, 7), values: [] }])).toBe('var:o');
  });

  it('FR-5.8 a variable taken apart from a call: its element; a created object is no tuple; a name not among the targets is no evidence', async () => {
    const tupleFacts: ReturnFact[] = [{ range: site(30, 0, 40), tuple: true, values: [{ range: site(30, 8, 12) }, { range: site(30, 22, 6), empty: true }] }];
    const innerBody = [create(0, 30, { range: site(30, 8, 12), result: { kind: 'return' } })];
    const facts: ReturnFact[] = [{ range: site(21, 0, 9), values: [{ range: site(21, 7, 1), variable: 'p' }] }];
    const world = { calls: { [inner.key]: innerBody }, returns: { [make.key]: facts, [inner.key]: tupleFacts } };
    const takeApart = (target: string) => [call(0, inner, { receiver: { kind: 'self' }, range: site(20), ...assign(target) })];
    // Make: `(var p, var s) = Inner(); return p;` — Inner returns (new Order(), null)
    const go = async (target: string) => {
      const s = session({ methods: [run, make, inner], calls: { [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), ...assign('o') }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })], [make.key]: takeApart(target), ...world.calls }, returns: world.returns });
      await s.openMethodByKey(run.key);
      await s.expand('root/0:Make');
      const d = (await s.expand('root/0:Make/0:Inner'))!;
      return d.messages.find((x) => x.id === 'root/1:Send')!.to.includes('|new:');
    };
    expect(await go('(p, s)')).toBe(true);
    expect(await go('(a, s)')).toBe(false);
    // a destructuring that does not name `p`, then `p` assigned a new object: that object
    const later = session({
      methods: [run, make, inner],
      calls: {
        [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), ...assign('o') }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })],
        [make.key]: [...takeApart('(a, s)'), create(1, 20, { range: site(20, 30), ...assign('p') })],
        ...world.calls,
      },
      returns: world.returns,
    });
    await later.openMethodByKey(run.key);
    expect((await later.expand('root/0:Make'))!.messages.find((x) => x.id === 'root/1:Send')!.to).toContain('|new:');
    // a creation assigned to a destructuring target is no tuple
    const s = session({ methods: [run, make], calls: { [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), ...assign('o') }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })], [make.key]: [create(0, 20, assign('(p, s)'))] }, returns: { [make.key]: facts } });
    await s.openMethodByKey(run.key);
    expect((await s.expand('root/0:Make'))!.messages.find((x) => x.id === 'root/1:Send')!.to).toBe(`${order.key}|var:o`);
  });

  it('FR-5.7 without return facts: the last call returned; unknown when a return is no call we see; an interface-typed variable takes any object, another class none', async () => {
    const lastReturns = [create(0, 10, { result: { kind: 'return' } })];
    expect(await sendGoesTo(lastReturns, undefined)).toBe('created');
    expect(await sendGoesTo(lastReturns, undefined, {}, iOrder)).toBe('created');
    expect(await sendGoesTo(lastReturns, undefined, {}, other)).toBe('var:o');
    // the variable is `this.o`: not a variable the caller binds
    expect(await sendGoesTo(lastReturns, undefined, {}, order, 'this.o')).toBe('var:o');
    // an early `return` with no call of ours in it: unknown
    const early: EarlyExit = { kind: 'return', range: site(5, 0, 20) } as EarlyExit;
    expect(await sendGoesTo(lastReturns, undefined, { exits: { [make.key]: [early] } })).toBe('var:o');
    // the last call returned sits inside an early return
    expect(await sendGoesTo([create(0, 5, { result: { kind: 'return' } })], undefined, { exits: { [make.key]: [early] } })).toBe('var:o');
    // nothing returned at all
    expect(await sendGoesTo([create(0, 10)], undefined)).toBe('var:o');
  });
});

describe('FR-5.6 / FR-5.7 / FR-1.4 more shapes', () => {
  const svc = cls('src/app/Svc.cs', 'Svc');
  const order = cls('src/app/Order.cs', 'Order');
  const site = (l: number, c = 4, len = 10): SourceRange => ({ file: '/p/Svc.cs', start: { line: l, character: c }, end: { line: l, character: c + len } });

  it('FR-1.4 the text of a call without a target: its expression without the argument list', () => {
    const t = (expressionText: string) => calleeText({ expressionText } as CallSite);
    expect([t('a.b'), t('this.x?.run(1, f(2))'), t('this.cb?.(1)'), t('new Foo()'), t('(x)'), t('f)('), t('g())')]).toEqual(['a.b', 'this.x?.run', 'this.cb', 'Foo', '(x)', 'f)(', 'g())']);
  });

  it('FR-5.7 a function whose methods are an object literal: one object for the root', async () => {
    const lit = cls('src/app/handlers.ts', 'handlers');
    const run = meth(lit, 'run');
    const s = session({ methods: [run], infos: [info(lit, { synthetic: true } as Partial<ClassInfo>)] });
    expect((await s.openMethodByKey(run.key))!.messages[0].to).toBe(`${lit.key}|object`);
  });

  it('FR-5.7 a returned call\'s object, followed down; a skipped element of a destructuring is no variable', async () => {
    const run = meth(svc, 'Run');
    const make = meth(svc, 'Make');
    const inner = meth(svc, 'Inner');
    const send = meth(order, 'Send');
    const ctor = meth(order, 'constructor', { hasBody: false });
    const s = session({
      methods: [run, make, inner],
      calls: {
        [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), result: { kind: 'assign', target: 'o', operator: '=' } }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })],
        [make.key]: [call(0, inner, { receiver: { kind: 'self' }, range: site(10), result: { kind: 'return' } })],
        [inner.key]: [call(0, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(20), result: { kind: 'return' } })],
      },
    });
    await s.openMethodByKey(run.key);
    await s.expand('root/0:Make');
    const d = (await s.expand('root/0:Make/0:Inner'))!;
    expect(d.messages.find((m) => m.id === 'root/1:Send')!.to).toContain('|new:');
    // `(_, o) = Make()`: the first element is skipped
    const tuple = session({
      methods: [run, make],
      calls: {
        [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), result: { kind: 'assign', target: '(_, o)', operator: '=' } }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })],
        [make.key]: [call(0, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(10, 12, 11) })],
      },
      returns: { [make.key]: [{ range: site(10, 0, 40), tuple: true, values: [{ range: site(10, 8, 2), empty: true }, { range: site(10, 12, 11) }] }] },
    });
    await tuple.openMethodByKey(run.key);
    expect((await tuple.expand('root/0:Make'))!.messages.find((m) => m.id === 'root/1:Send')!.to).toContain('|new:');
    // `(o, s) = Make()` where Make returns one new object (no tuple): no element of it is that object
    const single = session({
      methods: [run, make],
      calls: {
        [run.key]: [call(0, make, { receiver: { kind: 'self' }, range: site(1), result: { kind: 'assign', target: '(o, s)', operator: '=' } }), call(1, send, { receiver: { kind: 'local', name: 'o' }, receiverType: order, range: site(2) })],
        [make.key]: [call(0, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(10, 11, 11) })],
      },
      returns: { [make.key]: [{ range: site(10, 4, 20), values: [{ range: site(10, 11, 11) }] }] },
    });
    await single.openMethodByKey(run.key);
    expect((await single.expand('root/0:Make'))!.messages.find((m) => m.id === 'root/1:Send')!.to).toBe(`${order.key}|var:o`);
  });

  it('FR-5.6 creations in different branches of one alt share a lifeline, also with the calls their constructors make; in one branch they do not', async () => {
    const run = meth(svc, 'Run');
    const ctor = meth(order, 'constructor');
    const init = meth(order, 'Init');
    const scope = (operand: number, guard: string) => ({ id: 'if@1', kind: 'alt' as const, operand, guard });
    const make = (o: number, l: number, fragments: object[]) => call(o, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(l), fragments: fragments as never });
    const world = (a: object[], b: object[]): World => ({ methods: [run, ctor], calls: { [run.key]: [make(0, 1, a), make(1, 2, b)], [ctor.key]: [call(0, init, { receiver: { kind: 'self' }, range: site(30) })] } });
    const branches = session(world([scope(0, 'x')], [scope(1, 'else')]));
    await branches.openMethodByKey(run.key);
    await branches.expand('root/0:constructor');
    const d = (await branches.expand('root/1:constructor'))!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    expect(creates[0].to).toBe(creates[1].to);
    expect(creates.map((c) => c.alternative)).toEqual([{ index: 1, count: 2, why: 'branch' }, { index: 2, count: 2, why: 'branch' }]);
    // the second object's constructor call comes from the shared lifeline
    expect(d.messages.find((m) => m.id === 'root/1:constructor/0:Init')!.from).toBe(creates[0].to);
    // a third creation after the alt (in no branch of it): its own object
    const after = session({ ...world([scope(0, 'x')], [scope(1, 'else')]), calls: { [run.key]: [make(0, 1, [scope(0, 'x')]), make(1, 2, [scope(1, 'else')]), make(2, 3, [])], [ctor.key]: [] } });
    const three = (await after.openMethodByKey(run.key))!.messages.filter((m) => m.kind === 'create');
    expect([three[0].to === three[1].to, three[2].to === three[0].to]).toEqual([true, false]);
    const same = session(world([scope(0, 'x')], [scope(0, 'x')]));
    const both = (await same.openMethodByKey(run.key))!.messages.filter((m) => m.kind === 'create');
    expect(both[0].to).not.toBe(both[1].to);
  });

  it('FR-5.6 in a try: two catch clauses exclude each other; the try block\'s last creation against a catch too; a creation outside the try frame does not', async () => {
    const run = meth(svc, 'Run');
    const ctor = meth(order, 'constructor', { hasBody: false });
    const t = (operand: number, guard?: string) => ({ id: 'try@1', kind: 'try' as const, operand, ...(guard ? { guard } : {}) });
    const make = (o: number, fragments: object[]) => call(o, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(o + 1), fragments: fragments as never });
    const handlers = [{ operand: 1, guard: 'catch A', outcome: 'swallow', logged: false }, { operand: 2, guard: 'catch B', outcome: 'swallow', logged: false }];
    const tryScope = (operand: number, guard?: string) => ({ ...t(operand, guard), handlers });
    const s = session({ methods: [run, ctor], calls: { [run.key]: [make(0, [tryScope(0)]), make(1, [tryScope(1, 'catch A')]), make(2, [tryScope(2, 'catch B')]), make(3, [])] } });
    const d = (await s.openMethodByKey(run.key))!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    expect(new Set(creates.slice(0, 3).map((c) => c.to)).size).toBe(1);
    expect(creates[3].to).not.toBe(creates[0].to);
  });
});

describe('FR-5.10 objects React keeps', () => {
  const hook = cls('src/hooks.ts', '<module>', 'module');
  const view = cls('src/view.ts', 'View');
  const site = (l: number, c: number, len: number): SourceRange => ({ file: '/p/hooks.ts', start: { line: l, character: c }, end: { line: l, character: c + len } });
  const run = meth(hook, 'Page');
  const useView = meth(hook, 'useView');
  const render = meth(view, 'render');
  const ctor = meth(view, 'constructor', { hasBody: false });
  const memo = { key: 'lib:react#useMemo', name: 'useMemo', owner: { key: 'lib:react', name: 'react', kind: 'external' }, isStatic: true, hasBody: false } as MethodRef;
  const state = { ...memo, key: 'lib:react#useState', name: 'useState' } as MethodRef;
  const page = (target: string, method = useView) => [
    call(0, method, { receiver: { kind: 'module', name: method.name }, range: site(1, 0, 10), result: { kind: 'assign', target, operator: '=' } }),
    call(1, render, { receiver: { kind: 'local', name: 'v' }, receiverType: view, range: site(2, 0, 10) }),
  ];
  const drawnTo = async (calls: CallSite[], facts: ReturnFact[], target = 'v') => {
    const s = session({ methods: [run, useView], calls: { [run.key]: page(target), [useView.key]: calls }, returns: { [useView.key]: facts } }, { showLibraryCalls: true });
    await s.openMethodByKey(run.key);
    const d = (await s.expand('root/0:useView'))!;
    return d.messages.find((m) => m.id === 'root/1:render')!.to.includes('|new:') ? 'the created View' : 'a variable';
  };
  // `return useMemo(() => new View(), [])`: the library call spans 10:11-41, the creation inside it
  const lib = (m: MethodRef) => call(0, m, { isLibrary: true, receiver: { kind: 'module', name: m.name }, range: site(10, 11, 30) });
  const made = call(1, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(10, 25, 10), result: { kind: 'return' } });
  const returnsCall: ReturnFact[] = [{ range: site(10, 4, 40), values: [{ range: site(10, 11, 30) }] }];

  it('FR-5.10 useMemo returns what its initialiser creates; useState too (its first element); another library call does not', async () => {
    expect(await drawnTo([lib(memo), made], returnsCall)).toBe('the created View');
    // `const [v] = useState(() => new View()); return v;`
    const returnsV: ReturnFact[] = [{ range: site(11, 0, 9), values: [{ range: site(11, 7, 1), variable: 'v' }] }];
    expect(await drawnTo([{ ...lib(state), result: { kind: 'assign', target: '[v]', operator: '=' } }, made], returnsV)).toBe('the created View');
    // its second element (the setter) is no object
    expect(await drawnTo([{ ...lib(state), result: { kind: 'assign', target: '[s, v]', operator: '=' } }, made], returnsV)).toBe('a variable');
    expect(await drawnTo([lib({ ...memo, key: 'lib:react#useCallback', name: 'useCallback' } as MethodRef), made], returnsCall)).toBe('a variable');
    // useMemo whose initialiser creates two objects: none is meant
    expect(await drawnTo([lib(memo), made, { ...made, ordinal: 2 }], returnsCall)).toBe('a variable');
  });

  it('FR-5.10 the fields of a returned object: only a field its constructor stored exactly once', async () => {
    const handler = cls('src/handler.ts', 'Handler');
    const hctor = meth(handler, 'constructor');
    const s = session(
      {
        methods: [run, useView, hctor],
        calls: {
          [run.key]: page('{ view: v }'),
          [useView.key]: [call(0, hctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(10, 11, 13), result: { kind: 'return' } })],
          // the constructor stores something else in `view` twice
          [hctor.key]: [call(0, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(20, 0, 9), result: { kind: 'assign', target: 'view', operator: '=' } }), call(1, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, range: site(21, 0, 9), result: { kind: 'assign', target: 'view', operator: '=' } })],
        },
      },
      {},
    );
    await s.openMethodByKey(run.key);
    await s.expand('root/0:useView');
    const d = (await s.expand('root/0:useView/0:constructor'))!;
    expect(d.messages.find((m) => m.id === 'root/1:render')!.to).toBe(`${view.key}|var:v`);
  });
});


describe('FR-5.12 values on one lifeline per class', () => {
  const svc = cls('src/app/Shop.cs', 'Shop');
  const price = cls('src/app/Price.cs', 'Price');
  const order = cls('src/app/Order.cs', 'Order');
  const run = meth(svc, 'Run');
  const priceCtor = meth(price, 'constructor');
  const add = meth(price, 'Add');
  const check = meth(price, 'Check');
  const orderCtor = meth(order, 'constructor', { hasBody: false });
  const make = (o: number, ctor: MethodRef, name?: string) => call(o, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, ...(name ? { assignedTo: { kind: 'local' as const, name } } : {}) });
  const parts = (d: SequenceDiagram) => d.participants.map((p) => `${p.label}${p.instances ? ` ×${p.instances}${p.instancesWhy ? ` (${p.instancesWhy})` : ''}` : ''}`);
  const world = (priceInfo: Partial<ClassInfo>, names: [string, string] = ['a', 'b']): World => ({
    methods: [run, priceCtor, add, check],
    infos: [info(price, priceInfo), info(order)],
    calls: {
      // var a = new Price(); var b = new Price(); b.Add(a); new Order(); new Order();
      [run.key]: [make(0, priceCtor, names[0]), make(1, priceCtor, names[1]), call(2, add, { receiver: { kind: 'local', name: names[1] } }), make(3, orderCtor), make(4, orderCtor)],
      // the constructor checks itself; Add returns a new Price
      [priceCtor.key]: [call(0, check, { receiver: { kind: 'self' } })],
      [add.key]: [make(0, priceCtor)],
    },
  });

  it('FR-5.12 created values of an immutable class share a lifeline ×n (named by the class), their calls on it; a value made by a value keeps its own; mutable objects one each', async () => {
    const s = session(world({ immutable: true }));
    await s.openMethodByKey(run.key);
    await s.expand('root/1:constructor');
    const d = (await s.expand('root/2:Add'))!;
    expect(parts(d)).toEqual([':Shop', ':Price ×2 (value)', ':Price', ':Order', ':Order']);
    const value = d.participants[1].id;
    const sent = (id: string) => d.messages.find((m) => m.id === id)!;
    // both creations and the call on b arrive on the one lifeline; b's constructor checks itself there
    expect(['root/0:constructor', 'root/1:constructor', 'root/2:Add'].map((id) => sent(id).to)).toEqual([value, value, value]);
    expect([sent('root/1:constructor/0:Check').from, sent('root/1:constructor/0:Check').to]).toEqual([value, value]);
    // Add's new Price: created by the value, its own lifeline (it would otherwise create itself)
    expect([sent('root/2:Add/0:constructor').from, sent('root/2:Add/0:constructor').to]).toEqual([value, d.participants[2].id]);
  });

  it('FR-5.12 a one-of-n lifeline of a value class (FR-5.6) joins the other values; alone it stays one of n', async () => {
    const scope = (operand: number, guard: string) => [{ id: 'if@1', kind: 'alt' as const, operand, guard }];
    const branch = (o: number, operand: number, guard: string) => call(o, priceCtor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, fragments: scope(operand, guard) as never });
    const values = (calls: CallSite[]) => session({ methods: [run, priceCtor], infos: [info(price, { immutable: true })], calls: { [run.key]: calls } });
    // if (x) new Price() else new Price(): one object, one of two
    const alone = (await values([branch(0, 0, 'x'), branch(1, 1, 'else')]).openMethodByKey(run.key))!;
    expect(alone.participants.map((p) => [p.label, p.alternatives, p.instances])).toEqual([[':Shop', undefined, undefined], [':Price', 2, undefined]]);
    // … then new Price() after the if: three values on one lifeline, no longer "one of two"
    const joined = (await values([branch(0, 0, 'x'), branch(1, 1, 'else'), make(2, priceCtor)]).openMethodByKey(run.key))!;
    expect(joined.participants.map((p) => [p.label, p.alternatives, p.instances, p.instancesWhy])).toEqual([[':Shop', undefined, undefined, undefined], [':Price', undefined, 3, 'value']]);
  });

  it('FR-5.12 the values\' common variable name stays; a single value is one object; a mutable class (or not known to be immutable) keeps one lifeline per object', async () => {
    // `var p = new Price(); p = new Price(); p.Add(…)`: next to Add's new Price the lifeline is named by its variable
    const s = session(world({ immutable: true }, ['p', 'p']));
    await s.openMethodByKey(run.key);
    expect(parts((await s.expand('root/2:Add'))!)).toEqual([':Shop', 'p:Price ×2 (value)', ':Price', ':Order', ':Order']);
    // one value of the class: nothing to share
    const one = session({ methods: [run, priceCtor], infos: [info(price, { immutable: true })], calls: { [run.key]: [make(0, priceCtor, 'a'), call(1, add, { receiver: { kind: 'local', name: 'a' } })] } });
    expect(parts((await one.openMethodByKey(run.key))!)).toEqual([':Shop', ':Price']);
    const mutable = (await session(world({})).openMethodByKey(run.key))!;
    expect(parts(mutable)).toEqual([':Shop', 'a:Price', 'b:Price', ':Order', ':Order']);
  });
});

describe('FR-5.13 one lifeline per helper type (View ▾ option, off by default)', () => {
  const svc = cls('src/app/Shop.cs', 'Shop');
  const price = cls('src/app/Price.cs', 'Price');
  const order = cls('src/app/Order.cs', 'Order');
  const run = meth(svc, 'Run');
  const priceCtor = meth(price, 'constructor', { hasBody: false });
  const add = meth(price, 'Add');
  const orderCtor = meth(order, 'constructor', { hasBody: false });
  const ship = meth(order, 'Ship');
  const log = meth(svc, 'Log', { hasBody: false });
  const make = (o: number, ctor: MethodRef, to?: { kind: 'local' | 'field'; name: string }) => call(o, ctor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, ...(to ? { assignedTo: to } : {}) });
  const parts = (d: SequenceDiagram) => d.participants.map((p) => `${p.label}${p.instances ? ` ×${p.instances} (${p.instancesWhy})` : ''}`);
  // var a = new Price(); var b = new Price(); b.Add(a); new Order(); <order>; Add makes a new Price
  const world = (names: [string, string], second: CallSite, more: CallSite[] = []): World => ({
    methods: [run, priceCtor, add, orderCtor, ship, log],
    infos: [info(price), info(order)],
    calls: {
      [run.key]: [make(0, priceCtor, { kind: 'local', name: names[0] }), make(1, priceCtor, { kind: 'local', name: names[1] }), call(2, add, { receiver: { kind: 'local', name: names[1] } }), make(3, orderCtor), second, ...more],
      [add.key]: [make(0, priceCtor)],
      // the order tells the shop
      [ship.key]: [call(0, log)],
    },
  });
  const opened = async (w: World) => {
    const s = session(w);
    await s.openMethodByKey(run.key);
    return { s, d: (await s.setOption('mergeHelpers', true))! };
  };

  it('FR-5.13 on: objects of a class created in the flow share a lifeline ×n, each «create» numbered; off again: one each (FR-5.5)', async () => {
    // … var o = new Order(); o.Ship()
    const { s, d: d0 } = await opened(world(['a', 'b'], make(4, orderCtor, { kind: 'local', name: 'o' }), [call(5, ship, { receiver: { kind: 'local', name: 'o' } })]));
    const d = (await s.expand('root/5:Ship'))!;
    expect(parts(d0)).toEqual([':Shop', ':Price ×2 (helper)', ':Order ×2 (helper)']);
    // Ship tells the shop it holds (its field f)
    expect(parts(d)).toEqual([':Shop', ':Price ×2 (helper)', ':Order ×2 (helper)', 'f:Shop']);
    const creates = d.messages.filter((m) => m.kind === 'create');
    expect(creates.map((m) => [m.to, m.instance])).toEqual([
      [d.participants[1].id, 1],
      [d.participants[1].id, 2],
      [d.participants[2].id, 1],
      [d.participants[2].id, 2],
    ]);
    expect(d.messages.find((m) => m.id === 'root/2:Add')!.to).toBe(d.participants[1].id);
    // what the second order does is sent from the one lifeline
    const sent = d.messages.find((m) => m.id === 'root/5:Ship/0:Log')!;
    expect([sent.from, sent.to]).toEqual([d.participants[2].id, d.participants[3].id]);
    const off = (await s.setOption('mergeHelpers', false))!;
    expect(parts(off)).toEqual([':Shop', 'a:Price', 'b:Price', ':Order', 'o:Order', 'f:Shop']);
    expect(off.messages.some((m) => m.instance)).toBe(false);
  });

  it('FR-5.13 objects that call or create one another stay apart; an object stored in a field is not a helper', async () => {
    const { s, d } = await opened(world(['p', 'p'], make(4, orderCtor, { kind: 'field', name: 'last' })));
    // the stored order is the shop's own: the other order has no one to share with
    // (one lifeline of the class: anonymous, FR-6.2)
    expect(parts(d)).toEqual([':Shop', ':Price ×2 (helper)', ':Order', 'last:Order']);
    // Add's new Price is made by a price: one lifeline would create itself
    expect(parts((await s.expand('root/2:Add'))!)).toEqual([':Shop', 'p:Price', 'p:Price', ':Price', ':Order', 'last:Order']);
  });
});

describe('FR-6.7 one lifeline per object the DI container makes once', () => {
  const ctl = cls('src/app/OrderController.cs', 'OrderController');
  const svc = cls('src/app/OrderService.cs', 'OrderService');
  const job = cls('src/app/RetryJob.cs', 'RetryJob');
  const iSvc = cls('src/app/IOrderService.cs', 'IOrderService', 'interface');
  const iPlace = meth(iSvc, 'Place', { hasBody: false });
  const place = meth(ctl, 'Place');
  const placeSvc = meth(svc, 'Place');
  const retry = meth(svc, 'Retry');
  const note = meth(svc, 'Note', { hasBody: false });
  const run = meth(job, 'Run');
  const svcCtor = meth(svc, 'constructor', { hasBody: false });
  const field = (name: string) => ({ receiver: { kind: 'field' as const, name } });
  const reg = (lifetime?: string, more: ContainerBinding[] = []): ContainerBinding[] => [{ abstract: iSvc.key, concrete: svc.key, range: at('Program.cs', 1), ...(lifetime ? { lifetime } : {}) }, ...more];
  // the controller places the order through _orders, then runs the job, which retries through its own _orders;
  // the service notes through _peer (the same singleton); the job also makes an OrderService of its own
  const createScope = meth(cls('lib:DI#IServiceProvider', 'IServiceProvider', 'interface'), 'CreateScope', { hasBody: false });
  const world = (bindings: ContainerBinding[], names = ['_orders', '_peer'], viaInterface = false, extra: CallSite[] = []): World => ({
    methods: [place, placeSvc, retry, note, run, svcCtor, iPlace],
    // the controller's _orders is injected: through the interface it is a seam
    infos: [info(ctl, { fields: [{ name: '_orders', type: iSvc, isStatic: false, injected: true }] }), info(svc), info(job), info(iSvc, { methods: [{ name: 'Place', isStatic: false, signature: 'Place()' }] })],
    bindings,
    impls: { [iPlace.key]: [placeSvc] },
    calls: {
      [place.key]: [call(0, viaInterface ? iPlace : placeSvc, field(names[0])), call(1, run, field('_job'))],
      [placeSvc.key]: [call(0, note, field(names[1]))],
      // the retry notes on its own object
      [retry.key]: [call(0, note, { receiver: { kind: 'self' } })],
      [run.key]: [call(0, retry, field(names[0])), call(1, svcCtor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' } }), ...extra],
    },
  });
  const opened = async (bindings: ContainerBinding[], names?: string[], viaInterface?: boolean, extra?: CallSite[]) => {
    const s = session(world(bindings, names, viaInterface, extra));
    await s.openMethodByKey(place.key);
    await s.expand('root/0:Place');
    await s.expand('root/1:Run');
    return (await s.expand('root/1:Run/0:Retry'))!;
  };
  const parts = (d: SequenceDiagram) => d.participants.map((p) => `${p.label}${p.service ? ` (${p.service})` : ''}`);

  it('FR-6.7 a singleton reached through two fields and a peer field is one lifeline; the call between its references is a self call; new makes its own', async () => {
    const d = await opened(reg('singleton'));
    expect(parts(d)).toEqual([':OrderController', ':OrderService (singleton)', ':RetryJob', ':OrderService']);
    expect(d.participants[1].heldAs).toEqual(['_orders', '_peer']);
    const one = d.participants[1].id;
    const sent = (id: string) => d.messages.find((m) => m.id === id)!;
    expect(['root/0:Place', 'root/1:Run/0:Retry'].map((id) => sent(id).to)).toEqual([one, one]);
    expect([sent('root/0:Place/0:Note').kind, sent('root/0:Place/0:Note').from, sent('root/0:Place/0:Note').to]).toEqual(['self', one, one]);
    expect(sent('root/1:Run/1:constructor').to).not.toBe(one);
    // what the job's reference sends comes from the one lifeline too
    expect([sent('root/1:Run/0:Retry/0:Note').from, sent('root/1:Run/0:Retry/0:Note').to]).toEqual([one, one]);
  });

  it('FR-6.7 a name every reference shares stays; reached once through the interface, the lifeline names no interface; the root\'s own object takes the others in', async () => {
    const same = await opened(reg('singleton'), ['_orders', '_orders']);
    expect([parts(same)[1], same.participants[1].heldAs]).toEqual(['_orders:OrderService (singleton)', undefined]);
    const via = await opened(reg('singleton'), undefined, true);
    expect([via.participants[1].label, via.participants[1].implementsInterface]).toEqual([':OrderService', undefined]);
    // opened on the service itself: its _peer is the root's object
    const s = session(world(reg('singleton')));
    const own = (await s.openMethodByKey(placeSvc.key))!;
    expect(own.participants.map((p) => p.label)).toEqual([':OrderService']);
    expect(own.messages.find((m) => m.id === 'root/0:Note')!.kind).toBe('self');
  });

  it('FR-6.7 a container singleton is «singleton» (its reason says why); merged, «seam» only when every reference is the interface', async () => {
    const via = await opened(reg('singleton'), undefined, true);
    const one = via.participants[1];
    expect(one.stereotypes).toContain('singleton');
    expect(one.stereotypeReasons?.find((r) => r.stereotype === 'singleton')?.text).toBe('the DI container makes it once (registered as a singleton)');
    // the controller reaches it through IOrderService, the job and its peer hold the class: no seam, said in the tooltip
    expect([one.stereotypes.includes('seam'), one.seamVia]).toEqual([false, ['IOrderService in OrderController']]);
    // the one the job makes with new is no container object
    expect(via.participants[3].stereotypes).not.toContain('singleton');
    // scoped and transient: no «singleton»
    expect((await opened(reg('scoped'))).participants[1].stereotypes).not.toContain('singleton');
    expect((await opened(reg('transient'))).participants.some((p) => p.stereotypes.includes('singleton'))).toBe(false);
  });

  it('FR-6.7 scoped is one object per request; transient, no lifetime, or two registrations of the class keep one lifeline per reference', async () => {
    expect(parts(await opened(reg('scoped')))[1]).toBe(':OrderService (scoped)');
    // a scoped service the job holds in a local may come from another scope: apart; the fields still one
    const local = await opened(reg('scoped'), undefined, false, [call(2, retry, { receiver: { kind: 'local', name: 'svc' } })]);
    expect(parts(local).filter((p) => p.includes('OrderService'))).toEqual([':OrderService (scoped)', ':OrderService', 'svc:OrderService']);
    // a flow that makes a scope of its own may hold two: nothing joined
    const scope = await opened(reg('scoped'), undefined, false, [call(2, createScope, { isLibrary: true })]);
    expect(scope.participants.some((p) => p.service)).toBe(false);
    // a singleton is one object in every scope
    expect(parts(await opened(reg('singleton'), undefined, false, [call(2, createScope, { isLibrary: true })]))[1]).toBe(':OrderService (singleton)');
    const apart = [':OrderController', '_orders:OrderService', '_peer:OrderService', ':RetryJob', '_orders:OrderService', ':OrderService'];
    expect(parts(await opened(reg('transient')))).toEqual(apart);
    expect(parts(await opened(reg()))).toEqual(apart);
    const twice = reg('singleton', [{ abstract: svc.key, concrete: svc.key, range: at('Program.cs', 2), lifetime: 'singleton' }]);
    expect(parts(await opened(twice))).toEqual(apart);
  });
});

describe('FR-6.7 a class that keeps its only instance is one lifeline', () => {
  const svc = cls('src/app/Svc.cs', 'Svc');
  const db = cls('src/app/Db.cs', 'Db');
  const other = cls('src/app/Other.cs', 'Other');
  const run = meth(svc, 'Run');
  const query = meth(db, 'Query', { hasBody: false, isStatic: true });
  const instance = meth(db, 'GetInstance', { isStatic: true });
  const save = meth(db, 'Save', { hasBody: false });
  const dbCtor = meth(db, 'constructor', { hasBody: false });
  const otherCtor = meth(other, 'constructor', { hasBody: false });
  // Db.Query(); Db.Instance.Save(); _db.Save(); Db.GetInstance() (which makes the Db); new Other()
  const world = (dbInfo: Partial<ClassInfo>, more: CallSite[] = []): World => ({
    methods: [run, query, instance, save, dbCtor, otherCtor],
    infos: [info(db, dbInfo), info(other, { hasStaticInstance: true, hasPrivateConstructor: false })],
    calls: {
      [run.key]: more.length ? more : [
        call(0, query, { receiver: { kind: 'static' } }),
        call(1, save, { receiver: { kind: 'expression', text: 'Db.Instance' } }),
        call(2, save, { receiver: { kind: 'field', name: '_db' } }),
        call(3, instance, { receiver: { kind: 'static' } }),
        call(4, otherCtor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' } }),
      ],
      // var i = new Db(); i.Save(): the class's own object, from its static method
      [instance.key]: [call(0, dbCtor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' }, assignedTo: { kind: 'local', name: 'i' } }), call(1, save, { receiver: { kind: 'local', name: 'i' } })],
    },
  });
  const parts = (d: SequenceDiagram) => d.participants.map((p) => `${p.label}${p.service ? ` (${p.service})` : ''}`);

  it('a private constructor and a static instance: the «static» lifeline, its instance and the object it makes itself are one', async () => {
    const s = session(world({ hasStaticInstance: true, hasPrivateConstructor: true }));
    await s.openMethodByKey(run.key);
    const d = (await s.expand('root/3:GetInstance'))!;
    expect(parts(d)).toEqual([':Svc', ':Db (own)', ':Other']);
    const one = d.participants[1].id;
    expect(d.messages.filter((m) => m.id !== 'root' && m.id !== 'root/4:constructor').map((m) => m.to)).toEqual([one, one, one, one, one, one]);
    // from its static method to its instance: the object calling itself
    expect(d.messages.find((m) => m.id === 'root/3:GetInstance/1:Save')!.kind).toBe('self');
    expect(d.participants[1].stereotypes).not.toContain('static');
  });

  it('a public constructor (others can make more) or no static instance: one lifeline per way, as before', async () => {
    const open = async (dbInfo: Partial<ClassInfo>) => {
      const s = session(world(dbInfo));
      await s.openMethodByKey(run.key);
      return parts((await s.expand('root/3:GetInstance'))!);
    };
    expect((await open({ hasStaticInstance: true, hasPrivateConstructor: false })).filter((p) => p.includes('Db')).length).toBeGreaterThan(1);
    expect((await open({ hasStaticInstance: false, hasPrivateConstructor: true })).some((p) => p.includes('(own)'))).toBe(false);
  });

  it('one way to it only: left as it is; an object of the class made elsewhere is another object', async () => {
    const own = { hasStaticInstance: true, hasPrivateConstructor: true };
    const alone = (await session(world(own, [call(0, query, { receiver: { kind: 'static' } })])).openMethodByKey(run.key))!;
    expect(parts(alone)).toEqual([':Svc', 'Db']);
    const made = (await session(world(own, [call(0, query, { receiver: { kind: 'static' } }), call(1, save, { receiver: { kind: 'field', name: '_db' } }), call(2, dbCtor, { kind: 'create', methodName: 'constructor', receiver: { kind: 'none' } })])).openMethodByKey(run.key))!;
    expect(parts(made)).toEqual([':Svc', ':Db (own)', ':Db']);
  });
});


describe('Overview scores with what a fresh open knows', () => {
  // run → s1 → … → s6 → Port.send (an interface), each step also calling the network and, in a guard, its own fail
  // method: Overview opens the chain step by step, below what the I/O scan read at the start (four levels under s1).
  // Whom the port reaches, and what the deep fail methods do, is not known there — not after Expand everything either.
  const svc = cls('src/app/svc.ts', 'Svc');
  const port = cls('src/app/port.ts', 'Port', 'interface');
  const adapter = cls('src/app/http-port.ts', 'HttpPort');
  const run = meth(svc, 'run');
  const steps = Array.from({ length: 6 }, (_, i) => meth(svc, `s${i + 1}`));
  const send = meth(port, 'send', { hasBody: false });
  const impl = meth(adapter, 'send');
  const fails = steps.map((_, i) => meth(svc, `fail${i + 1}`));
  const http = (o: number) => call(o, { key: 'lib:axios#Axios.get', name: 'get', owner: { key: 'lib:axios#Axios', name: 'Axios', kind: 'class' }, isStatic: false, hasBody: false } as MethodRef, { isLibrary: true, receiver: { kind: 'none' } });
  const guarded = (o: number, i: number) => call(o, fails[i], { receiver: { kind: 'self' }, fragments: [{ id: 'if@9', kind: 'opt', operand: 0, guard: 'bad' }] as never });
  const world: World = {
    methods: [run, ...steps, send, impl, ...fails],
    impls: { [send.key]: [impl] },
    calls: Object.fromEntries([
      [run.key, [call(0, steps[0], { receiver: { kind: 'self' } })]],
      ...steps.map((m, i) => [m.key, [i === 5 ? call(0, send, { receiver: { kind: 'field', name: 'port' } }) : call(0, steps[i + 1], { receiver: { kind: 'self' } }), http(1), guarded(2, i)]]),
      [impl.key, [http(0)]],
      ...fails.map((f) => [f.key, [http(0)]]),
    ]),
  };

  it('fresh (after the I/O scan) and after Expand everything: the same calls open', async () => {
    const run1 = async (prepare: (s: DiagramSession) => Promise<unknown>) => {
      const s = session(world);
      await s.openMethodByKey(run.key);
      await prepare(s);
      return (await s.smartExpand())!.messages.map((m) => m.id);
    };
    const fresh = await run1((s) => s.scanSideEffects());
    expect(fresh).toContain('root/0:s1/0:s2/0:s3/0:s4/0:s5'); // opened beyond the scan's four levels under s1
    expect(await run1(async (s) => (await s.expandEverything(), await s.scanSideEffects()))).toEqual(fresh);
  });

  it('what scoring may read: an unknown body or implementation list is none; an unknown failing callee is no error path', async () => {
    const s = session(world);
    await s.openMethodByKey(run.key);
    await s.expandEverything();
    type Peeks = { peek(m: MethodRef): unknown; peekImpls(m: MethodRef): unknown };
    const inner = s as unknown as { scoringPeeks(k?: (m: MethodRef, impls?: boolean) => boolean): Peeks; offPathBranches(m: MethodRef, memo: Map<string, Map<string, string>>, k?: (m: MethodRef) => boolean): Map<string, string> };
    // everything is cached after Expand everything: all of it without a limit, none of it when nothing is known
    expect([inner.scoringPeeks().peek(impl), inner.scoringPeeks().peekImpls(send)]).toEqual([[http(0)].map(() => expect.anything()), [impl]]);
    expect([inner.scoringPeeks(() => false).peek(impl), inner.scoringPeeks(() => false).peekImpls(send)]).toEqual([undefined, undefined]);
    // `if (bad) return refuse();` where refuse() only builds a failure: an error path when its body is known; unknown,
    // the return delegates (a path of the flow)
    const guard = meth(svc, 'guard');
    const refuse = meth(svc, 'refuse');
    const opt = { id: 'if@1', kind: 'opt', operand: 0, guard: 'bad' };
    const g = session({
      methods: [guard, refuse],
      calls: { [guard.key]: [call(0, refuse, { range: at('svc.ts', 5), receiver: { kind: 'self' }, fragments: [opt] as never })], [refuse.key]: [call(0, undefined, { methodName: 'Failure', isLibrary: true, receiver: { kind: 'none' } })] },
      exits: { [guard.key]: [{ kind: 'return', range: at('svc.ts', 5), fragments: [opt] } as EarlyExit] },
    });
    await g.openMethodByKey(guard.key);
    await g.expandEverything();
    const gi = g as unknown as typeof inner;
    expect([gi.offPathBranches(guard, new Map()).size, gi.offPathBranches(guard, new Map(), (m) => m.key !== refuse.key).size]).toEqual([1, 0]);
  });
});
