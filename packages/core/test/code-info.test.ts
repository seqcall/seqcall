import { describe, expect, it } from 'vitest';
import type { CallPathNode, CodeInfo, EntryPoint, MethodRef, Position } from '@seqcall/protocol';
import type { CallSite, ContainerBinding, FileType } from '../src/adapter';
import { callAt, codeInfoLines, codeInfoPlain, reachOf, whatRuns } from '../src/code-info';
import { bindingLookup } from '../src/session/bindings';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';
import { file, FIXTURE_ROOT, newSession, positionOf } from './helpers';

const range = (line: number, from: number, to: number, endLine = line) => ({ file: '/p/x.ts', start: { line, character: from }, end: { line: endLine, character: to } });
const pos = (line: number, character: number): Position => ({ line, character });

// a service calling a repository port; two implementations, one of them doing DB I/O through a library
const Service = cls('src/service.ts', 'Service');
const Port = cls('src/port.ts', 'Repo', 'interface');
const Sql = cls('src/sql.ts', 'SqlRepo');
const Mem = cls('src/mem.ts', 'MemRepo');
const Pool = cls('lib:pg', 'Pool');
const save = meth(Port, 'save', { hasBody: false });
const sqlSave = meth(Sql, 'save');
const memSave = meth(Mem, 'save');
const query = meth(Pool, 'query');
const run = meth(Service, 'run', { declaration: range(3, 8, 11) });
const reg = (concrete: string, line: number, extra: Partial<ContainerBinding> = {}): ContainerBinding => ({ abstract: Port.key, concrete, range: at('Program.cs', line), ...extra });

describe('FR-33 the call under the cursor', () => {
  const outer = call(0, meth(Service, 'outer'), { range: range(5, 4, 30), methodName: 'outer' });
  const inner = call(1, meth(Service, 'inner'), { range: range(5, 15, 25), methodName: 'inner' });
  const made = call(2, meth(Sql, 'constructor'), { kind: 'create', range: range(7, 10, 25), methodName: 'constructor', receiverType: Sql });

  it('FR-33.1 the innermost call holding the position; with the word under the cursor only a call of that name', () => {
    expect(callAt([outer, inner], pos(5, 18))).toBe(inner);
    expect(callAt([outer, inner], pos(5, 6))).toBe(outer);
    expect(callAt([outer, inner], pos(5, 18), 'outer')).toBe(outer);
    // on an argument / a variable: no call of that name
    expect(callAt([outer, inner], pos(5, 18), 'id')).toBeUndefined();
    expect(callAt([outer, inner], pos(6, 0))).toBeUndefined();
    // a creation by its class name; a multi-line call holds every line between
    expect(callAt([made], pos(7, 14), 'SqlRepo')).toBe(made);
    expect(callAt([call(3, run, { range: range(9, 4, 2, 11) })], pos(10, 0))?.ordinal).toBe(3);
    // a call spanning lines around a one-line call: the one-line call is the inner one
    const wrapping = call(6, meth(Service, 'wrap'), { range: range(9, 4, 2, 11), methodName: 'wrap' });
    const oneLine = call(7, meth(Service, 'one'), { range: range(10, 2, 9), methodName: 'one' });
    expect(callAt([wrapping, oneLine], pos(10, 4))).toBe(oneLine);
    expect(callAt([oneLine, call(8, meth(Service, 'two'), { range: range(10, 0, 4, 12), methodName: 'two' })], pos(10, 3))).toBe(oneLine);
  });

  it('FR-33.1 calls inside a lambda passed as an argument count too', () => {
    const lambdaCall = call(4, meth(Service, 'each'), { range: range(12, 20, 28), methodName: 'each' });
    const host = call(5, meth(Service, 'map'), { range: range(12, 4, 40), methodName: 'map', argFunctions: [{ kind: 'lambda', range: range(12, 10, 39), calls: [lambdaCall] }] });
    expect(callAt([host], pos(12, 22))).toBe(lambdaCall);
  });
});

describe('FR-33.2 what runs at a call on an interface', () => {
  const portCall = (extra: Partial<CallSite> = {}) => call(1, save, { range: range(5, 4, 20), methodName: 'save', ...extra });

  it('FR-33.2 the container binding wins (for an injected field: the sender is the consumer), with its registration', () => {
    const bindings = bindingLookup([reg(Sql.key, 4), reg(Mem.key, 9, { consumer: Service.key })]);
    expect(whatRuns(portCall(), run, [], [sqlSave, memSave], { bindings }).runs).toEqual({ method: memSave, why: 'container', at: at('Program.cs', 9) });
    // a generic port registered per type argument: the call's type arguments pick the registration
    const generic = bindingLookup([reg(Sql.key, 4, { abstractArgs: ['Order#Order'] }), reg(Mem.key, 5, { abstractArgs: ['Refund#Refund'] })]);
    const typed = portCall({ typeArguments: [{ name: 'T' }, { name: 'Refund', type: cls('Refund', 'Refund') }] });
    expect(whatRuns(typed, run, [], [sqlSave, memSave], { bindings: generic }).runs?.method).toBe(memSave);
    // a parameter is no injected field: the global registration
    expect(whatRuns(portCall({ receiver: { kind: 'parameter', name: 'repo' } }), run, [], [sqlSave, memSave], { bindings }).runs?.method).toBe(sqlSave);
  });

  it('FR-33.2 an object created in the same body, the class\'s own override, the only implementation', () => {
    const create = call(0, meth(Mem, 'constructor'), { kind: 'create', range: range(4, 4, 20), receiverType: Mem, assignedTo: { kind: 'local', name: 'r' } });
    const onLocal = portCall({ receiver: { kind: 'local', name: 'r' } });
    expect(whatRuns(onLocal, run, [create, onLocal], [sqlSave, memSave]).runs).toEqual({ method: memSave, why: 'created' });
    const chained = portCall({ receiver: { kind: 'created', ordinal: 0 } });
    expect(whatRuns(chained, run, [create, chained], [sqlSave, memSave]).runs?.why).toBe('created');
    const own = meth(Service, 'save');
    expect(whatRuns(portCall({ receiver: { kind: 'self' } }), run, [], [sqlSave, own]).runs).toEqual({ method: own, why: 'self' });
    expect(whatRuns(portCall(), run, [], [sqlSave]).runs).toEqual({ method: sqlSave, why: 'only-implementation' });
    // the setting that turns auto-selection off
    expect(whatRuns(portCall(), run, [], [sqlSave], { autoSelect: false }).candidates).toEqual([Sql]);
  });

  it('FR-33.2 undecided: up to five candidates, the rest counted; a parameter says the caller decides; keyed registrations listed', () => {
    const many = Array.from({ length: 7 }, (_, i) => meth(cls(`src/r${i}.ts`, `R${i}`), 'save'));
    const r = whatRuns(portCall({ receiver: { kind: 'parameter', name: 'repo' } }), run, [], many);
    expect(r.candidates?.map((c) => c.name)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4']);
    expect(r).toMatchObject({ more: 2, fromCaller: true });
    const keyed = bindingLookup([reg(Sql.key, 4, { key: '"sql"', keyKind: 'key' }), reg('src/gone.ts#Gone', 5, { key: '"gone"' })]);
    expect(whatRuns(portCall(), run, [], [sqlSave, memSave], { bindings: keyed }).keyed).toEqual([{ className: 'SqlRepo', key: '"sql"' }]);
  });

  it('FR-33.2 nothing to decide: a call with a body, a library call, no implementations', () => {
    expect(whatRuns(call(1, sqlSave), run, [], [])).toEqual({});
    expect(whatRuns(call(1, query, { isLibrary: true }), run, [], [sqlSave])).toEqual({});
    expect(whatRuns(portCall(), run, [], [])).toEqual({});
  });
});

describe('FR-33.3 who reaches a method', () => {
  const node = (name: string, extra: Partial<CallPathNode> = {}): CallPathNode => ({ method: meth(Service, name), ...extra });
  const ep = (label: string, kind: EntryPoint['kind'] = 'http'): EntryPoint => ({ kind, label, method: meth(Service, label) });

  it('FR-33.3 entry points once each (up to five, the rest counted), test methods counted, a cut walk said', () => {
    const tree = node('target', {
      callers: [
        node('a', { entryPoints: [ep('GET /a')], end: 'entry' }),
        node('b', { callers: [node('c', { entryPoints: [ep('GET /a'), ep('GET /c'), ep('Job.run', 'job')] }), node('spec', { inTest: true, end: 'test' })] }),
        node('d', { entryPoints: [ep('GET /d'), ep('GET /e'), ep('GET /f'), ep('t', 'test')] }),
      ],
    });
    const r = reachOf(tree, true);
    expect(r.entryPoints.map((e) => e.label)).toEqual(['GET /a', 'GET /c', 'Job.run', 'GET /d', 'GET /e']);
    expect(r).toMatchObject({ more: 1, tests: 2, cut: true });
    // FR-33.7 every entry point with its shortest path down to the target (GET /a: through a, not through b and c)
    expect(r.routes!.map((x) => x.entryPoint.label)).toEqual(['GET /a', 'GET /c', 'Job.run', 'GET /d', 'GET /e', 'GET /f']);
    expect(r.routes![0].steps.map((x) => x.methodKey)).toEqual([`${Service.key}.a`, `${Service.key}.target`]);
    expect(r.routes![1].steps.map((x) => x.methodKey)).toEqual([`${Service.key}.c`, `${Service.key}.b`, `${Service.key}.target`]);
  });

  it('FR-33.7 a step carries the call towards the target (a method passed as an argument too); the target has none', () => {
    const call = { range: at('src/c.ts', 4), preview: 'svc.run()' };
    const tree = node('target', { callers: [node('a', { call: { ...call, passed: true }, callers: [node('b', { call, entryPoints: [ep('GET /b')] })] })] });
    expect(reachOf(tree, false).routes![0].steps).toEqual([
      { methodKey: `${Service.key}.b`, call: { range: call.range } },
      { methodKey: `${Service.key}.a`, call: { range: call.range, passed: true } },
      { methodKey: `${Service.key}.target` },
    ]);
  });
});

describe('FR-33.4 the hover text', () => {
  const lines = (info: Omit<CodeInfo, 'method'>) => codeInfoLines({ method: run, ...info }, '/p');

  it('FR-33.4 a call: what runs and why (the registration relative to the root), else the candidates; its I/O', () => {
    expect(lines({ call: { target: save, runs: { method: sqlSave, why: 'container', at: at('Program.cs', 41) }, io: { kinds: ['db'], evidence: [] } } })).toEqual([
      '→ runs SqlRepo.save (the DI container binds it, Program.cs:42)',
      '↯ DB below',
    ]);
    expect(lines({ call: { target: save, runs: { method: memSave, why: 'created' } } })).toEqual(['→ runs MemRepo.save (the object created here)']);
    // a registration outside the project root keeps its full path; without one (an adapter that did not say) no place
    expect(lines({ call: { target: save, runs: { method: sqlSave, why: 'container', at: { ...at('x', 0), file: 'C:\\other\\Program.cs' } } } })).toEqual(['→ runs SqlRepo.save (the DI container binds it, C:/other/Program.cs:1)']);
    expect(codeInfoLines({ method: run, call: { target: save, runs: { method: sqlSave, why: 'container' } } })).toEqual(['→ runs SqlRepo.save (the DI container binds it)']);
    expect(lines({ call: { target: save, runs: { method: memSave, why: 'self' } } })).toEqual(['→ runs MemRepo.save (its own override)']);
    expect(lines({ call: { target: save, runs: { method: memSave, why: 'only-implementation' } } })).toEqual(['→ runs MemRepo.save (the only implementation)']);
    expect(lines({ call: { target: save, candidates: [Sql, Mem], more: 3, fromCaller: true, keyed: [{ className: 'SqlRepo', key: '"sql"' }] } })).toEqual([
      '→ runs one of SqlRepo, MemRepo +3 (the caller decides)',
      '→ chosen at run time: SqlRepo ("sql")',
    ]);
    // a library call does the I/O itself; an unresolved call says nothing
    expect(lines({ call: { target: query, io: { kinds: ['db', 'http'], evidence: [] } } })).toEqual(['↯ DB, HTTP']);
    expect(lines({ call: {} })).toEqual([]);
  });

  it('FR-33.4 a method: who reaches it, only tests, the unreachable list, its I/O, a walk still running', () => {
    const e = (label: string): EntryPoint => ({ kind: 'http', label, method: run });
    expect(lines({ reach: { entryPoints: [e('GET /a'), e('POST /b')], more: 2, tests: 1, cut: true }, io: { kinds: ['http'], evidence: [] } })).toEqual([
      '⌂ reached from 4 entry points · 1 test (more paths not followed)',
      '  · GET /a',
      '  · POST /b',
      '  · +2 more',
      '↯ HTTP',
    ]);
    expect(lines({ reach: { entryPoints: [e('GET /a')], more: 0, tests: 2, cut: false } })).toEqual(['⌂ reached from 1 entry point · 2 tests', '  · GET /a']);
    expect(lines({ reach: { entryPoints: [e('GET /a')], more: 0, tests: 0, cut: false } })).toEqual(['⌂ reached from 1 entry point', '  · GET /a']);
    expect(lines({ reach: { entryPoints: [], more: 0, tests: 3, cut: false } })).toEqual(['⌂ only tests reach it (3)']);
    expect(lines({ reach: { entryPoints: [], more: 0, tests: 1, cut: true } })).toEqual(['⌂ only tests reach it (1) (more paths not followed)']);
    expect(lines({ reach: { entryPoints: [], more: 0, tests: 3, cut: false }, unreachable: 'only tests call it' })).toEqual(['∅ no entry point reaches it: only tests call it']);
    expect(lines({ reach: { entryPoints: [], more: 0, tests: 0, cut: false } })).toEqual([]);
    expect(lines({ pending: ['reach', 'io'] })).toEqual(['⌂ still looking for callers… (ask again in a moment)']);
  });
});

describe('FR-33 describeAt on a session', () => {
  const runCalls = [
    call(0, save, { range: range(5, 4, 20), methodName: 'save' }),
    call(1, query, { range: range(6, 4, 20), methodName: 'query', isLibrary: true, libraryName: 'pg' }),
  ];
  const world = (extra: Partial<World> = {}, adapter: Record<string, unknown> = {}): World => ({
    methods: [run, save, sqlSave, memSave],
    calls: { [run.key]: runCalls, [sqlSave.key]: [call(0, query, { isLibrary: true, libraryName: 'pg' })] },
    impls: { [save.key]: [sqlSave, memSave] },
    ...extra,
    adapter: { findEnclosingCallable: async () => run, ...adapter },
  });

  it('FR-33.2 on a call: the container\'s implementation and the I/O below it; on a library call its own I/O', async () => {
    const s = fakeSession(world({}, { getBindings: async () => [reg(Sql.key, 4)] }));
    const onSave = (await s.describeAt('/p/src/service.ts', pos(5, 8), { word: 'save' }))!;
    expect(onSave.call).toMatchObject({ target: save, runs: { method: sqlSave, why: 'container' }, io: { kinds: ['db'] } });
    expect(codeInfoLines(onSave, '/p')).toEqual(['→ runs SqlRepo.save (the DI container binds it, Program.cs:5)', '↯ DB below']);
    const onQuery = (await s.describeAt('/p/src/service.ts', pos(6, 8), { word: 'query' }))!;
    expect(codeInfoLines(onQuery)).toEqual(['↯ DB']);
    // on an argument: nothing
    expect(await s.describeAt('/p/src/service.ts', pos(5, 18), { word: 'user' })).toBeUndefined();
  });

  it('FR-33.2 undecided: the I/O all candidates share', async () => {
    const both = world({ calls: { [run.key]: runCalls, [sqlSave.key]: [call(0, query, { isLibrary: true, libraryName: 'pg' })], [memSave.key]: [call(0, query, { isLibrary: true, libraryName: 'pg' })] } });
    const info = (await fakeSession(both).describeAt('/p/x.ts', pos(5, 8), { word: 'save' }))!;
    expect(info.call).toMatchObject({ candidates: [Sql, Mem], io: { kinds: ['db'] } });
  });

  it('FR-33.3 on a method\'s name: the entry points its callers lead to, test callers, its I/O', async () => {
    const controller = meth(cls('src/controller.ts', 'Controller'), 'get');
    const spec = meth(cls('src/service.spec.ts', 'Spec'), 'it');
    const callers = {
      [run.key]: [
        { id: 'c1', enclosing: controller, range: at('src/controller.ts', 3), preview: 'run()' },
        { id: 'c2', enclosing: spec, range: at('src/service.spec.ts', 3), preview: 'run()', inTest: true },
      ],
    };
    const s = fakeSession(world({ callers, entryPoints: [{ kind: 'http', verb: 'GET', label: 'GET /x', method: controller }] }));
    const info = (await s.describeAt('/p/src/service.ts', pos(3, 9), { word: 'run' }))!;
    expect(info.reach).toMatchObject({ entryPoints: [{ label: 'GET /x' }], tests: 1, cut: false });
    expect(info.io?.kinds).toEqual(['db']);
    expect(info.pending).toBeUndefined();
    // without the word: the position must be on the name; another line of the body is no hover
    expect((await s.describeAt('/p/src/service.ts', pos(3, 9)))?.reach?.entryPoints).toHaveLength(1);
    expect(await s.describeAt('/p/src/service.ts', pos(3, 20))).toBeUndefined();
    expect(await s.describeAt('/p/src/service.ts', pos(4, 9), { word: 'run' })).toBeUndefined();
  });

  it('FR-33.3 a slow walk: named pending, goes on in the background, the next hover has it; a code change starts again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let asked = 0;
    const getCallers = async () => {
      asked++;
      await gate;
      return [];
    };
    const s = fakeSession(world({}, { getCallers }));
    const first = (await s.describeAt('/p/x.ts', pos(3, 9), { word: 'run', budgetMs: 10 }))!;
    expect(first.pending).toEqual(['reach']);
    expect(codeInfoLines(first)).toContain('⌂ still looking for callers… (ask again in a moment)');
    release();
    await new Promise((r) => setTimeout(r, 0));
    const second = (await s.describeAt('/p/x.ts', pos(3, 9), { word: 'run', budgetMs: 10 }))!;
    expect(second.pending).toBeUndefined();
    expect(asked).toBe(1);
    await s.refresh(['/p/src/service.ts']);
    await s.describeAt('/p/x.ts', pos(3, 9), { word: 'run', budgetMs: 10 });
    expect(asked).toBe(2);
  });

  it('FR-33.3 the unreachable-code scan lists the method: said in its words', async () => {
    const main = meth(cls('src/main.ts', 'Main'), 'main');
    const types: FileType[] = [{ type: Service, methods: [run] }, { type: main.owner, methods: [main] }];
    const spec = meth(cls('src/service.spec.ts', 'Spec'), 'it');
    const s = fakeSession(
      world(
        { callers: { [run.key]: [{ id: 'c', enclosing: spec, range: at('src/service.spec.ts', 3), preview: 'run()', inTest: true }] }, entryPoints: [{ kind: 'cli', label: 'main', method: main }] },
        { getProjectTypes: async () => types },
      ),
    );
    await s.findUnreachableCode();
    const info = (await s.describeAt('/p/src/service.ts', pos(3, 9), { word: 'run' }))!;
    expect(info.unreachable).toBe('only tests call it');
    expect(codeInfoLines(info)).toContain('∅ no entry point reaches it: only tests call it');
  });

  it('FR-33 nothing at the position: no method, no call of that name', async () => {
    const none = fakeSession({ methods: [] });
    expect(await none.describeAt('/p/x.ts', pos(0, 0))).toBeUndefined();
    const s = fakeSession(world());
    expect(await s.describeAt('/p/x.ts', pos(5, 8), { word: 'other' })).toBeUndefined();
  });
});


describe('FR-33 describeAt on the TypeScript sample', () => {
  it('FR-33.2 an injected port with two implementations: both named; on an argument nothing', async () => {
    const s = newSession();
    const rel = 'src/services/user-service.ts';
    const info = (await s.describeAt(file(rel), positionOf(rel, 'primary.save', 9), { word: 'save', budgetMs: 30_000 }))!;
    expect(info.method.key).toBe('src/services/user-service.ts#UserService.rename');
    expect(codeInfoLines(info, FIXTURE_ROOT)).toEqual(['→ runs one of InMemoryUserRepository, SqlUserRepository']);
    expect(await s.describeAt(file(rel), positionOf(rel, 'primary.save(user', 13), { word: 'user' })).toBeUndefined();
  }, 60_000);
});

describe('FR-33 describeAt: calls with nothing to decide, and parts that fail or take long', () => {
  const at5 = (ordinal: number, target: MethodRef | undefined, extra: Partial<CallSite> = {}) =>
    call(ordinal, target, { range: range(5 + ordinal, 4, 20), methodName: target?.name ?? 'x', ...extra });
  const hover = async (w: World, ordinal: number, word: string) => fakeSession({ ...w, adapter: { findEnclosingCallable: async () => run, ...w.adapter } }).describeAt('/p/x.ts', pos(5 + ordinal, 8), { word, budgetMs: 2000 });

  it('FR-33.2 an unresolved call, a library call that does no I/O, a library call known only by its package', async () => {
    const lodash = meth(cls('lib:lodash', '_'), 'map');
    const calls = [at5(0, undefined, { methodName: 'mystery' }), at5(1, lodash, { isLibrary: true, libraryName: 'lodash' }), at5(2, undefined, { methodName: 'query', isLibrary: true, libraryName: 'pg' })];
    const w: World = { methods: [run], calls: { [run.key]: calls } };
    expect((await hover(w, 0, 'mystery'))!.call).toEqual({});
    expect((await hover(w, 1, 'map'))!.call).toEqual({ target: lodash });
    const lib = (await hover(w, 2, 'query'))!;
    expect(lib.call).toMatchObject({ io: { kinds: ['db'] } });
    expect(codeInfoLines(lib)).toEqual(['↯ DB']);
  });

  it('FR-33.2 a call to a method with a body: no choice to make, the I/O below it', async () => {
    const w: World = { methods: [run, sqlSave], calls: { [run.key]: [at5(0, sqlSave)], [sqlSave.key]: [call(0, query, { isLibrary: true, libraryName: 'pg' })] } };
    const info = (await hover(w, 0, 'save'))!;
    expect(info.call).toEqual({ target: sqlSave, io: expect.objectContaining({ kinds: ['db'] }) });
    expect(codeInfoLines(info)).toEqual(['↯ DB below']);
  });

  it('FR-33.2 candidates without bodies or too many to share I/O; implementations that fail to load: none', async () => {
    const abstractImpl = meth(cls('src/a.ts', 'A', 'interface'), 'save', { hasBody: false });
    const noBodies: World = { methods: [run], calls: { [run.key]: [at5(0, save)] }, impls: { [save.key]: [abstractImpl, meth(Mem, 'save', { hasBody: false })] } };
    expect((await hover(noBodies, 0, 'save'))!.call).toEqual({ target: save, candidates: [abstractImpl.owner, Mem] });
    const many = Array.from({ length: 5 }, (_, i) => meth(cls(`src/r${i}.ts`, `R${i}`), 'save'));
    const tooMany: World = { methods: [run], calls: { [run.key]: [at5(0, save)] }, impls: { [save.key]: many } };
    expect((await hover(tooMany, 0, 'save'))!.call?.io).toBeUndefined();
    const failing: World = { methods: [run], calls: { [run.key]: [at5(0, save)] }, adapter: { getImplementations: async () => { throw new Error('index broken'); } } };
    expect((await hover(failing, 0, 'save'))!.call).toEqual({ target: save });
    // a creation of a type without a body (an ambient declaration): nothing to decide
    expect((await hover({ methods: [run], calls: { [run.key]: [at5(0, save, { kind: 'create', methodName: 'save' })] } }, 0, 'save'))!.call).toEqual({ target: save });
  });

  it('FR-33.3 a body that cannot be read counts as no I/O; I/O still running when the budget ends is pending', async () => {
    const broken: World = { methods: [run], adapter: { getOutgoingCalls: async () => { throw new Error('parse error'); } } };
    const info = (await fakeSession({ ...broken, adapter: { ...broken.adapter, findEnclosingCallable: async () => run } }).describeAt('/p/x.ts', pos(3, 9), { word: 'run' }))!;
    expect(info.io).toBeUndefined();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: World = {
      methods: [run, sqlSave],
      adapter: {
        findEnclosingCallable: async () => run,
        getOutgoingCalls: async (m: MethodRef) => {
          if (m.key === sqlSave.key) await gate;
          return m.key === run.key ? [at5(0, sqlSave)] : [];
        },
      },
    };
    const s = fakeSession(slow);
    const first = (await s.describeAt('/p/x.ts', pos(3, 9), { word: 'run', budgetMs: 20 }))!;
    expect(first.pending).toEqual(['io']);
    release();
  });
});

describe('FR-33.6 the lines for a plain-text popup', () => {
  it('FR-33.6 items numbered under their heading, +n more as it is, other lines unchanged', () => {
    expect(codeInfoPlain(['⌂ reached from 7 entry points · 2 tests', '  · GET /a', '  · POST /b', '  · +5 more', '↯ DB'])).toEqual([
      '⌂ reached from 7 entry points · 2 tests',
      '   1. GET /a',
      '   2. POST /b',
      '   +5 more',
      '↯ DB',
    ]);
  });
});
