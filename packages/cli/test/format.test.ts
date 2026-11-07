import { describe, expect, it } from 'vitest';
import type { EntryPointsResult, Envelope, FlowResult, ImplsResult, OutcomeRow, PathsResult, ProjectIssue, ReviewOutput } from '../src/commands';
import { entryPointsText, flowText, implsText, issuesText, outcomesText, pathsText, reviewText } from '../src/format';

/** The text forms (FR-27.2) of hand-built results: every optional field shown, or left out when absent. */

const env = <R>(command: string, result: R, limits: string[] = []): Envelope<R> => ({
  schema: 'seqcall/v1',
  command,
  project: { root: '/p', language: 'typescript' },
  complete: limits.length === 0,
  limits,
  elapsedMs: 5,
  result,
});

/** The lines after the header. */
const body = (text: string) => text.split('\n').slice(1);

describe('seqcall text form (FR-27.2)', () => {
  it('FR-27.2 the header names each limit as an INCOMPLETE line', () => {
    const text = flowText(env<FlowResult>('flow', { method: { key: 'a#S.run', label: 'S.run' }, entryPoints: [], callCount: 0, io: [], issues: [] }, ['expand limit (500 calls): 3 calls left folded', '--depth 1: 2 calls folded']));
    expect(text.split('\n')).toEqual([
      '# seqcall flow · typescript · /p · 5 ms',
      '# INCOMPLETE: expand limit (500 calls): 3 calls left folded',
      '# INCOMPLETE: --depth 1: 2 calls folded',
      'S.run',
      '0 calls',
      'I/O: none found in the shown calls',
      'issues: none in this flow',
    ]);
  });

  it('FR-27.6 flow --tree: every tag of a call (I/O below / part of, async, lib, unresolved, implementations, recursive, folded); the I/O list with its tags and the full chain', () => {
    const r: FlowResult = {
      method: { key: 'a#S.run', label: 'S.run', layer: 'Application', at: 'src/s.ts:3' },
      entryPoints: ['GET /a', 'job nightly'],
      callCount: 2,
      calls: [
        { id: 'root/0:find', depth: 1, call: 'Repo.find', args: ['id', 'opts'], io: { kinds: ['db', 'http'], below: true, evidence: [] }, async: true, library: true, unresolved: 'dynamic call', implementations: { names: ['SqlRepo', 'MemRepo'] }, recursive: true, folded: true },
        { id: 'root/0:find/0:read', depth: 2, call: 'Repo.read', args: [], at: 'src/r.ts:9', layer: 'Infrastructure', io: { kinds: ['db'], partOf: 'Repo.query', evidence: [] }, implementations: { names: ['Reader', 'Cursor'], drawn: 'Reader' } },
      ],
      io: [
        { kinds: ['db'], call: 'Repo.read', id: 'x', via: ['A.a', 'B.b', 'C.c', 'D.d', 'E.e'], onceInLoop: true, later: true, below: true },
        { kinds: ['mq'], call: 'Bus.send', id: 'y', at: 'src/b.ts:4', via: [] },
      ],
      issues: [],
    };
    expect(body(flowText(env('flow', r), { tree: true }))).toEqual([
      'S.run  [Application]  src/s.ts:3  ← GET /a, job nightly',
      '  Repo.find(id, opts)  I/O below: DB,HTTP  async  lib  unresolved: dynamic call  impl: SqlRepo | MemRepo  recursive  (folded)',
      '    Repo.read()  [Infrastructure]  DB (part of Repo.query)  impl: Reader | Cursor → Reader  src/r.ts:9',
      'I/O (2; inside calls doing the same I/O not repeated):',
      '  DB  Repo.read  [in a loop, once (the loop ends after it), runs later, further down, not shown]  via A.a → B.b → C.c → D.d → E.e',
      '  MQ  Bus.send  src/b.ts:4',
      'issues: none in this flow',
    ]);
    // the short form: a call count instead of the tree, a long chain cut to its first step and last two
    expect(body(flowText(env('flow', r)))).toEqual([
      'S.run  [Application]  src/s.ts:3  ← GET /a, job nightly',
      '2 calls (the call tree: --tree)',
      'I/O (2; inside calls doing the same I/O not repeated):',
      '  DB  Repo.read  [in a loop, once (the loop ends after it), runs later, further down, not shown]  via A.a → … → D.d → E.e',
      '  MQ  Bus.send  src/b.ts:4',
      'issues: none in this flow',
    ]);
    // a chain of four is shown whole
    expect(body(flowText(env('flow', { ...r, io: [{ ...r.io[1], via: ['A.a', 'B.b', 'C.c', 'D.d'] }] })))[3]).toBe('  MQ  Bus.send  src/b.ts:4  via A.a → B.b → C.c → D.d');
    // --tree on a result without calls (the JSON of a short flow): no call lines
    expect(body(flowText(env('flow', { ...r, calls: undefined }), { tree: true }))[1]).toBe('I/O (2; inside calls doing the same I/O not repeated):');
  });

  it('FR-27.2 issues: possible ones tagged, at most four places then a count, the loop and the evidence lines under it', () => {
    const r: FlowResult = {
      method: { key: 'a#S.run', label: 'S.run' },
      entryPoints: [],
      callCount: 1,
      io: [],
      issues: [
        { id: 'io-in-loop:S', kind: 'io-in-loop', certainty: 'possible', title: 'Possible I/O in a loop: Repo.find (DB)', at: ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6'], loop: 'loop [each o of os] @ a:1', evidence: ['S.run → Repo.find', 'Repo.find → Db.query'] },
        { id: 'dependency-cycle:A,B', kind: 'dependency-cycle', certainty: 'definite', title: 'Cycle: A → B → A', at: ['a:1', 'a:2', 'a:3', 'a:4'] },
      ],
    };
    expect(body(flowText(env('flow', r)))).toEqual([
      'S.run',
      '1 call (the call tree: --tree)',
      'I/O: none found in the shown calls',
      'issues (2):',
      '  ⚠ Possible I/O in a loop: Repo.find (DB)  (io-in-loop, possible)  at a:1, a:2, a:3, a:4 +2',
      '      the loop: loop [each o of os] @ a:1',
      '      S.run → Repo.find',
      '      Repo.find → Db.query',
      '  ⚠ Cycle: A → B → A  (dependency-cycle)  at a:1, a:2, a:3, a:4',
    ]);
  });

  it('FR-27.3 paths text: both ends of the walk short of an entry point, passed / repeated calls, test callers; the code line only with --code', () => {
    const r: PathsResult = {
      target: {
        method: 'Repo.save',
        key: 'k0',
        tests: 2,
        callers: [
          { method: 'S.top', key: 'k1', call: { at: 'src/s.ts:4', code: 'this.repo.save(o)', count: 3 }, end: 'top', tests: 1 },
          { method: 'S.deep', key: 'k2', call: { code: 'run(this.repo.save)', passed: true }, end: 'limit' },
          { method: 'C.store', key: 'k4', call: { at: 'src/c.ts:9', code: 's.place()' }, entryPoints: ['POST /orders', 'PUT /orders'], end: 'entry' },
        ],
      },
      reachedFrom: { http: ['POST /orders', 'PUT /orders'], cli: ['orders:sync'] },
      tests: 0,
      methodsSearched: 7,
    };
    expect(body(pathsText(env('paths', r)))).toEqual([
      'reached from: 2 http, 1 cli',
      '  http: POST /orders, PUT /orders',
      '  cli: orders:sync',
      '7 methods searched; tree (each line is called by the lines below it; test code only counted):',
      'Repo.save  +2 test callers',
      '  ← S.top  src/s.ts:4  [no callers in the project]  ×3  +1 test caller',
      '  ← S.deep  [cut by limit]  passed as argument',
      '  ← C.store  src/c.ts:9  [entry: POST /orders, PUT /orders]',
    ]);
    expect(body(pathsText(env('paths', r), { code: true })).slice(5)).toEqual([
      '  ← S.top  src/s.ts:4  `this.repo.save(o)`  [no callers in the project]  ×3  +1 test caller',
      '  ← S.deep  `run(this.repo.save)`  [cut by limit]  passed as argument',
      '  ← C.store  src/c.ts:9  `s.place()`  [entry: POST /orders, PUT /orders]',
    ]);
  });

  it('FR-27.3 paths text: reached only by tests, or by nothing; one HTTP test call; the --tests list without file, mocks or method', () => {
    const lone = (extra: Partial<PathsResult>): PathsResult => ({ target: { method: 'Repo.save', key: 'k0' }, reachedFrom: {}, tests: 0, methodsSearched: 1, ...extra });
    expect(body(pathsText(env('paths', lone({}))))[0]).toBe('reached from: no entry point (nothing in the project calls it, or only through code the analysis cannot follow)');
    const http = [{ route: 'GET /a', at: 'tests/a.ts:3', by: 'url' as const }];
    expect(body(pathsText(env('paths', lone({ tests: 2, httpTests: http }))))).toEqual([
      'reached from: 2 tests',
      '  over HTTP from test code (found by URL / route-name text, not in the tree): 1 call in 1 file (--tests lists them)',
      '1 methods searched; tree (each line is called by the lines below it; test code only counted):',
      'Repo.save',
    ]);
    expect(body(pathsText(env('paths', lone({ tests: 2, httpTests: http, testList: [{ class: 'ATest', methods: ['one', 'two'] }] }))))).toEqual([
      'reached from: 2 tests',
      '  over HTTP from test code (found by URL / route-name text, not in the tree): 1 call in 1 file',
      '1 methods searched; tree (each line is called by the lines below it; test code only counted):',
      'Repo.save',
      'tests (2):',
      '  ATest: one, two',
      'tests over HTTP (1, by text):',
      '  GET /a  ← (no method)  tests/a.ts:3',
    ]);
    // calls in several files
    const two = [...http, { route: 'GET /a', at: 'tests/b.ts:8', by: 'name' as const, in: 'B.test' }];
    expect(body(pathsText(env('paths', lone({ tests: 2, httpTests: two }))))[1]).toBe('  over HTTP from test code (found by URL / route-name text, not in the tree): 2 calls in 2 files (--tests lists them)');
    // --tests with no HTTP test: no "tests over HTTP" block
    expect(pathsText(env('paths', lone({ tests: 1, testList: [{ class: 'ATest', methods: ['one'] }] })))).not.toContain('tests over HTTP');
  });

  it('FR-27.4 review text: HEAD when detached, added / test files, methods without entry points, with tests or cut callers, issues', () => {
    const r: ReviewOutput = {
      base: 'main',
      compared: 'abc123',
      files: [
        { path: 'src/a.ts', status: 'added', added: 10, removed: 0 },
        { path: 'test/a.test.ts', status: 'modified', added: 2, removed: 1, test: true },
      ],
      methods: [
        { method: 'A.run', key: 'k', status: 'added', lines: 'src/a.ts:1-9', reachedFrom: [], tests: 2, truncated: true },
        { method: 'A.stop', key: 'k2', status: 'changed', lines: 'src/a.ts:12', reachedFrom: ['GET /a', 'GET /b'], tests: 0 },
        { method: 'A.more', key: 'k3', status: 'added', lines: 'src/a.ts:20', reachedFrom: [], tests: 0, notWalked: true },
      ],
      issues: [{ id: 'io-in-loop:A', kind: 'io-in-loop', certainty: 'definite', title: 'I/O in a loop: Db.q (DB)', where: 'changed-lines', flow: 'GET /a', at: ['src/a.ts:4'] }],
    };
    expect(body(reviewText(env('review', r)))).toEqual([
      'HEAD compared abc123',
      'files (2): src/a.ts added +10/-0, test/a.test.ts +2/-1 (test)',
      'changed methods (3):',
      '  A.run  added  src/a.ts:1-9  ← no entry point  (+2 tests)  [callers cut by limit]',
      '  A.stop  changed  src/a.ts:12  ← GET /a, GET /b',
      '  A.more  added  src/a.ts:20  ← not walked (limit)',
      'issues in the changed flows (1):',
      '  ⚠ I/O in a loop: Db.q (DB)  (io-in-loop, changed-lines)  at src/a.ts:4  in GET /a',
    ]);
    expect(body(reviewText(env('review', { ...r, files: [], methods: [], issues: [] })))).toEqual([
      'HEAD compared abc123',
      'files (0): none',
      'changed methods: none',
      'issues in the changed flows: none',
    ]);
  });

  it('FR-27.8 entrypoints text: by kind; the label once when it is the method; route name, detail, project and file as tags', () => {
    const r: EntryPointsResult = {
      entryPoints: [
        { kind: 'http', label: 'GET /a', method: 'A.get', key: 'k1', at: 'src/a.ts:3', routeName: 'a.show', detail: 'route', project: 'Web' },
        { kind: 'cli', label: 'Main.run', method: 'Main.run', key: 'k2', file: 'src/main.ts' },
        { kind: 'http', label: 'POST /a', method: 'A.post', key: 'k3' },
      ],
      total: 9,
    };
    expect(body(entryPointsText(env('entrypoints', r)))).toEqual([
      '3 entry points',
      'http (2):',
      '  GET /a  A.get  src/a.ts:3  [name: a.show, route, project: Web]',
      '  POST /a  A.post',
      'cli (1):',
      '  Main.run  [runs in src/main.ts]',
    ]);
    expect(body(entryPointsText(env('entrypoints', { ...r, filter: 'a' })))[0]).toBe('3 of 9 entry points match "a"');
  });

  it('FR-32.5 outcomes text: a summary, one line per entry point (I/O kinds via their classes), notes; --detail: the calls with file:line', () => {
    const row = (label: string, extra: Partial<OutcomeRow> = {}): OutcomeRow => ({ kind: 'http', label, method: 'A.run', key: 'a#A.run', io: [], ...extra });
    const rows = [
      row('POST /orders', {
        at: 'src/a.ts:3',
        io: [
          { kind: 'db', via: [{ class: 'OrderRepository', calls: [{ call: 'Db.insert', at: 'src/r.ts:9' }, { call: 'Db.commit', at: 'src/r.ts:12' }] }] },
          { kind: 'http', via: [{ class: 'InvoiceClient', calls: [{ call: 'fetch' }] }, { class: 'ShippingClient', calls: [{ call: 'fetch', at: 'src/s.ts:4' }] }] },
        ],
        atLeast: true,
        folded: 3,
        wide: [{ call: 'Handler.handle', implementations: 22 }],
        unresolved: 2,
      }),
      row('A.run', { unresolved: 1, atLeast: true, folded: 1 }),
      row('B.run', { atLeast: true, wide: ['A', 'B', 'C', 'D'].map((c) => ({ call: `${c}.go`, implementations: 5 })) }),
      row('C.run', { atLeast: true, wide: ['A', 'B', 'C'].map((c) => ({ call: `${c}.go`, implementations: 5 })) }),
      row('D.run', { atLeast: true, deep: ['A.get', 'B.get', 'C.get'] }),
      row('E.run', { atLeast: true, deep: ['A.get', 'B.get'] }),
      row('GET /gone', { failed: true }),
    ];
    const r = { entryPoints: rows, total: 7 };
    expect(body(outcomesText(env('outcomes', r)))).toEqual([
      'outcomes: 7 entry points (tests excluded), 1 with I/O — db 1, http 1',
      '  POST /orders  A.run  DB via OrderRepository · HTTP via InvoiceClient, ShippingClient  (at least: 3 calls left folded, Handler.handle has 22 implementations; 2 calls not resolved)',
      '  A.run  no I/O found  (at least: 1 call left folded; 1 call not resolved)',
      '  B.run  A.run  no I/O found  (at least: A.go has 5 implementations, B.go has 5 implementations, 2 more interface calls like that)',
      '  C.run  A.run  no I/O found  (at least: A.go has 5 implementations, B.go has 5 implementations, 1 more interface call like that)',
      '  D.run  A.run  no I/O found  (at least: the I/O walk stopped at A.get, B.get and 1 more method)',
      '  E.run  A.run  no I/O found  (at least: the I/O walk stopped at A.get and B.get)',
      '  GET /gone  A.run  could not be analysed',
    ]);
    expect(body(outcomesText(env('outcomes', { entryPoints: rows.slice(0, 1), total: 5, filter: 'orders' }), { detail: true }))).toEqual([
      'outcomes: 1 of 5 entry points match "orders", 1 with I/O — db 1, http 1',
      '  POST /orders  A.run  src/a.ts:3  DB via OrderRepository · HTTP via InvoiceClient, ShippingClient  (at least: 3 calls left folded, Handler.handle has 22 implementations; 2 calls not resolved)',
      '      DB  OrderRepository: Db.insert  src/r.ts:9, Db.commit  src/r.ts:12',
      '      HTTP  InvoiceClient: fetch',
      '      HTTP  ShippingClient: fetch  src/s.ts:4',
    ]);
    expect(body(outcomesText(env('outcomes', { entryPoints: [row('A.run')], total: 1 }), { detail: true }))).toEqual(['outcomes: 1 entry points (tests excluded), 0 with I/O', '  A.run  no I/O found']);
  });

  it('FR-27.9 issues text: none, or each issue with its flow, how many more entry points reach it, its files (six, then a count)', () => {
    const issue = (extra: Partial<ProjectIssue>): ProjectIssue => ({ id: 'dependency-cycle:A,B', kind: 'dependency-cycle', certainty: 'definite', title: 'Cycle: A → B → A', flow: 'GET /a', flowKey: 'k', ...extra });
    expect(body(issuesText(env('issues', { issues: [], entryPoints: 4 })))).toEqual(['issues: none in the flows of 4 entry points (tests excluded):']);
    const files = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
    expect(body(issuesText(env('issues', { issues: [issue({ others: 2, files }), issue({ files: files.slice(0, 6) }), issue({})], entryPoints: 4 })))).toEqual([
      'issues (3) in the flows of 4 entry points (tests excluded):',
      '  ⚠ Cycle: A → B → A  (dependency-cycle)  in GET /a (+2 more entry points)',
      '      files: f1, f2, f3, f4, f5, f6 +2',
      '  ⚠ Cycle: A → B → A  (dependency-cycle)  in GET /a',
      '      files: f1, f2, f3, f4, f5, f6',
      '  ⚠ Cycle: A → B → A  (dependency-cycle)  in GET /a',
    ]);
  });

  it('FR-27.10 impls text: a method with a body, implementations without a place, keyed / consumer / generic registrations, no registrations', () => {
    const r: ImplsResult = {
      method: { label: 'Base.run', key: 'k', abstract: false },
      implementations: [{ method: 'A.run', key: 'k1', at: 'src/a.ts:3' }, { method: 'B.run', key: 'k2' }],
      registrations: [{ concrete: 'A', at: 'src/di.ts:4', key: 'fast', keyKind: 'key', consumer: 'Shop', typeArgs: ['Order', 'Id'] }],
    };
    // keyed only: nothing the container gives without a key
    expect(body(implsText(env('impls', r)))).toEqual([
      'Base.run',
      'implementations (2):',
      '  A.run  src/a.ts:3',
      '  B.run',
      'DI registrations (1):',
      '  A  src/di.ts:4  [keyed fast, only for Shop, for <Order, Id>]',
      'the container gives: chosen at run time (keyed / conditional registrations)',
    ]);
    expect(body(implsText(env('impls', { ...r, implementations: [], registrations: [] })))).toEqual(['Base.run', 'implementations: none in the project', 'DI registrations: none found']);
    // a bound class: its line only
    const bound = body(implsText(env('impls', { ...r, registrations: [{ concrete: 'A', at: 'src/di.ts:4' }], bound: [{ concrete: 'A', at: 'src/di.ts:4' }] })));
    expect(bound.slice(4)).toEqual(['DI registrations (1):', '  A  src/di.ts:4', 'the container gives: A  (src/di.ts:4)']);
    // an interface method; per application, one with no single class
    const perHost = body(implsText(env('impls', { ...r, method: { ...r.method, abstract: true, at: 'src/i.ts:2' }, implementations: [], bound: [{ concrete: 'A', at: 'src/di.ts:4', host: 'Web' }, { host: 'Batch' }] })));
    expect([perHost[0], ...perHost.slice(-2)]).toEqual([
      'Base.run  (no body: interface / abstract)  src/i.ts:2',
      'the container gives in Web: A  (src/di.ts:4)',
      'the container gives in Batch: chosen at run time (keyed / conditional registrations)',
    ]);
  });
});
