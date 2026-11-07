import { describe, expect, it } from 'vitest';
import type { ClassNode, ClassRelation, Message, Participant } from '@seqcall/protocol';
import * as path from 'node:path';
import { classFindings, flowFindings, GOD_CLASS_DEFAULTS, layerViolationFindings, mergeCycles, withClassEvidence, withMessageEvidence, withoutTypeUses, stronglyConnected, type ClassSize } from '../src/findings';
import { createClassifier } from '../src/classifier-impl';
import { PhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';
import { ioKindOfCall } from '../src/side-effects';
import { isLoadOnceGuard } from '../src/session';
import { file, newSession, positionOf } from './helpers';
import type { CallSite } from '../src/adapter';

const part = (id: string, layer?: string, extra: Partial<Participant> = {}): Participant =>
  ({ id, classKey: `src/${id}.ts#${id}`, className: id, label: `:${id}`, kind: 'class', stereotypes: [], namespace: 'src', groupId: 'g', ...(layer ? { layer } : {}), ...extra }) as Participant;
let n = 0;
const msg = (id: string, parentId: string | null, from: string | null, to: string, extra: Partial<Message> = {}): Message =>
  ({ id, parentId, depth: id.split('/').length - 1, kind: parentId ? 'call' : 'found', from, to, methodName: `m${n++}`, className: to, args: [], isAsync: false, isLibrary: false, expandable: true, expanded: false, recursive: false, ...extra }) as Message;

describe('FR-19 design findings (flow)', () => {
  it('FR-19.1 I/O in a loop: a call in a collection loop with remote I/O, grouped; I/O only further down is "possible"', () => {
    const P = [part('Svc', 'Application'), part('Repo', 'Infrastructure'), part('Cfg', 'Application')];
    const M = [
      msg('root', null, null, 'Svc', { expanded: true }),
      msg('root/0:find', 'root', 'Svc', 'Repo', { methodName: 'find', className: 'Repo', sideEffects: { kinds: ['db'], evidence: [] } }),
      msg('root/1:find', 'root', 'Svc', 'Repo', { methodName: 'find', className: 'Repo', sideEffects: { kinds: ['db'], evidence: [] } }),
      msg('root/2:get', 'root', 'Svc', 'Cfg', { methodName: 'get', className: 'Cfg', sideEffects: { kinds: ['http'], evidence: [], below: true } }),
      msg('root/3:log', 'root', 'Svc', 'Repo', { methodName: 'log', className: 'Repo', sideEffects: { kinds: ['file'], evidence: [] } }), // local I/O: no N+1
    ];
    const f = flowFindings({ messages: M, participants: P, inLoop: new Set(['root/0:find', 'root/1:find', 'root/2:get', 'root/3:log']) });
    expect(f.map((x) => [x.title, x.messageIds])).toEqual([
      ['I/O in a loop: Repo.find (DB)', ['root/0:find', 'root/1:find']],
      ['Possible I/O in a loop: Cfg.get (HTTP)', ['root/2:get']],
    ]);
    // FR-17.8 a cache round trip per element is remote I/O too
    const cached = flowFindings({ messages: [M[0], { ...M[1], sideEffects: { kinds: ['cache'], evidence: [] } }], participants: P, inLoop: new Set(['root/0:find']) });
    expect(cached.map((x) => x.title)).toEqual(['I/O in a loop: Repo.find (CACHE)']);
    // the possible one says what is missing: the calls below the drawn call
    expect(f[1].detail).toMatch(/^The I\/O is inside this call, in calls not opened yet — /);
    expect(f.map((x) => x.ignoreKey)).toEqual(['Repo.find', 'Cfg.get']); // FR-19.10 what "Ignore" adds
    // ignore globs on Class.method
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set(['root/2:get']), ignored: (n) => n === 'Cfg.get' })).toEqual([]);
  });

  it('FR-19.1 I/O behind a load-once branch (a cache filled on first use) is not I/O in a loop', () => {
    // a Laravel app: Codes.byCode per country → Lang.current → setting() → Setting.get →
    // `if (!self::$loaded) load()` → … → curl_exec — fetched once per request
    const P = [part('Codes', 'Application'), part('Setting', 'Application'), part('Api', 'Infrastructure')];
    const L = 'root/0:byCode';
    const M = [
      msg('root', null, null, 'Codes', { expanded: true }),
      msg(L, 'root', 'Codes', 'Codes', { methodName: 'byCode', className: 'Codes', expanded: true }),
      msg(`${L}/0:get`, L, 'Codes', 'Setting', { expanded: true }),
      msg(`${L}/0:get/0:fetch`, `${L}/0:get`, 'Setting', 'Api', { methodName: 'fetch', className: 'Api', sideEffects: { kinds: ['http'], evidence: [] } }),
    ];
    const inLoop = new Set([L]);
    expect(flowFindings({ messages: M, participants: P, inLoop }).map((x) => x.title)).toEqual(['I/O in a loop: Codes.byCode (HTTP)']);
    expect(flowFindings({ messages: M, participants: P, inLoop, loadOnce: new Set([`${L}/0:get/0:fetch`]) })).toEqual([]);
    // other I/O in the same call still counts
    const more = [...M, msg(`${L}/1:save`, L, 'Codes', 'Api', { methodName: 'save', className: 'Api', sideEffects: { kinds: ['db'], evidence: [] } })];
    const f = flowFindings({ messages: more, participants: P, inLoop, loadOnce: new Set([`${L}/0:get/0:fetch`]) });
    expect(f.map((x) => x.messageIds)).toEqual([[L, `${L}/1:save`]]);
    // FR-1.20 I/O in a JSX handler inside the loop runs on a user action, not per element
    expect(flowFindings({ messages: M, participants: P, inLoop, onAction: new Set([`${L}/0:get`]) })).toEqual([]);
  });

  it('FR-19.1 load-once guards: a field tested for "not set yet"', () => {
    const yes = ['!self::$settingsLoaded', '!isset(static::$cache[$key])', 'empty($this->rates)', '$this->client === null', 'is_null(self::$x)', '!this.cache', 'this.cache == undefined', '_client is null', '!_loaded', 'this._map[key] === undefined', 'Config.instance == null'];
    const no = ['$this->debug', 'user', '!user', 'count($items) > 0', '$x === null', 'customer.isActive', 'else', 'each $item of $list', "!$request->has('x')", undefined];
    expect(yes.filter((g) => !isLoadOnceGuard(g))).toEqual([]);
    expect(no.filter((g) => isLoadOnceGuard(g))).toEqual([]);
  });

  it('FR-19.2 I/O in Domain, except Active Record models', () => {
    const P = [part('Svc', 'Application'), part('Order', 'Domain', { sideEffects: { kinds: ['db'], evidence: ['DB: uses PDO'] } })];
    const M = [msg('root', null, null, 'Svc', { expanded: true }), msg('root/0:save', 'root', 'Svc', 'Order', { className: 'Order', methodName: 'save' })];
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set() }).map((x) => [x.title, x.ignoreKey])).toEqual([['I/O in Domain: Order (DB)', 'Order']]);
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set(), activeRecord: () => true })).toEqual([]);
  });

  it('FR-19.3 layer ping-pong along one path (A → B → A → B)', () => {
    const P = [part('Ctl', 'Presentation'), part('Svc', 'Application'), part('Repo', 'Infrastructure'), part('Policy', 'Application'), part('Cache', 'Infrastructure')];
    const M = [
      msg('root', null, null, 'Ctl', { expanded: true }),
      msg('root/0:a', 'root', 'Ctl', 'Svc', { expanded: true }),
      msg('root/0:a/0:b', 'root/0:a', 'Svc', 'Repo', { expanded: true }),
      msg('root/0:a/0:b/0:c', 'root/0:a/0:b', 'Repo', 'Policy', { expanded: true }),
      msg('root/0:a/0:b/0:c/0:d', 'root/0:a/0:b/0:c', 'Policy', 'Cache'),
    ];
    const f = flowFindings({ messages: M, participants: P, inLoop: new Set() });
    expect(f.map((x) => x.title)).toEqual(['Layer ping-pong: Application ↔ Infrastructure']);
    expect(f[0].messageIds).toEqual(['root/0:a/0:b', 'root/0:a/0:b/0:c', 'root/0:a/0:b/0:c/0:d']);
    // FR-19.14 its classes and the three crossings, by name
    const named = M.map((m) => ({ ...m, methodName: m.id.split(':').pop()!, ...(m.id === 'root/0:a/0:b' ? { callSite: { file: 'src/Svc.ts', start: { line: 6, character: 0 }, end: { line: 6, character: 1 } } } : {}) }));
    const [g] = flowFindings({ messages: named, participants: P, inLoop: new Set() });
    expect(g.classKeys).toEqual(['src/Svc.ts#Svc', 'src/Repo.ts#Repo', 'src/Policy.ts#Policy', 'src/Cache.ts#Cache']);
    expect(g.evidence).toEqual(['Application → Infrastructure: Svc.a calls Repo.b (Svc.ts:7)', 'Infrastructure → Application: Repo.b calls Policy.c', 'Application → Infrastructure: Policy.c calls Cache.d']);
     // FR-19.16 a step back through a callback is no crossing: a delegate / lambda parameter, or a handed-out inner function
    const back = 'root/0:a/0:b/0:c';
    expect(flowFindings({ messages: named.map((m) => (m.id === back ? { ...m, viaParameter: 'onDone' } : m)), participants: P, inLoop: new Set() })).toEqual([]);
    expect(flowFindings({ messages: named, participants: P, inLoop: new Set(), localFunctions: (k) => k === 'src/Policy.ts#Policy' })).toEqual([]);
    // FR-19.19 a creation closes no ping-pong: job → use case → adapter (through its port) → `new MappingError()` of Application
    const J = [part('Job', 'Infrastructure'), part('Handler', 'Application'), part('Repo', 'Infrastructure'), part('MappingError', 'Application')];
    const created = [
      msg('root', null, null, 'Job', { expanded: true }),
      msg('root/0:execute', 'root', 'Job', 'Handler', { expanded: true }),
      msg('root/0:execute/0:update', 'root/0:execute', 'Handler', 'Repo', { expanded: true }),
      msg('root/0:execute/0:update/0:MappingError', 'root/0:execute/0:update', 'Repo', 'MappingError', { kind: 'create' }),
    ];
    expect(flowFindings({ messages: created, participants: J, inLoop: new Set() })).toEqual([]);
    // the adapter calling the use case's logic back is one
    const callsBack = [...created.slice(0, 3), msg('root/0:execute/0:update/0:priceOf', 'root/0:execute/0:update', 'Repo', 'Handler')];
    expect(flowFindings({ messages: callsBack, participants: J, inLoop: new Set() }).map((f) => f.title)).toEqual(['Layer ping-pong: Infrastructure ↔ Application', 'Cyclic collaboration: Handler → Repo → Handler']);
    // FR-19.15 on the class diagram: the drawn classes, the cross-layer relations its calls made
    const cls = (key: string, layer: string): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], namespace: '', methods: [], layer });
    const classes = [cls('src/Svc.ts#Svc', 'Application'), cls('src/Repo.ts#Repo', 'Infrastructure'), cls('src/Policy.ts#Policy', 'Application')];
    const via = (from: string, to: string, messageId: string): ClassRelation => ({ id: `${from}->${to}`, kind: 'dependency', from, to, calls: [{ messageId, label: '' }] });
    const relations = [via('src/Svc.ts#Svc', 'src/Repo.ts#Repo', 'root/0:a/0:b'), via('src/Repo.ts#Repo', 'src/Policy.ts#Policy', 'root/0:a/0:b/0:c'), via('src/Policy.ts#Policy', 'src/Svc.ts#Svc', 'root/0:a/0:b/0:c'), via('src/Svc.ts#Svc', 'src/Repo.ts#Repo', 'root/9:z')];
    const c = withClassEvidence(g, classes, relations);
    expect(c.classKeys).toEqual(['src/Svc.ts#Svc', 'src/Repo.ts#Repo', 'src/Policy.ts#Policy']);
    // not the same-layer relation, not a relation of other calls
    expect(c.relationIds).toEqual(['src/Svc.ts#Svc->src/Repo.ts#Repo', 'src/Repo.ts#Repo->src/Policy.ts#Policy']);
  });

  it('FR-19.4 cyclic collaboration A → B → A; callbacks through parameters and lambdas are no dependency', () => {
    const P = [part('A'), part('B')];
    const M = [msg('root', null, null, 'A', { expanded: true }), msg('root/0:x', 'root', 'A', 'B', { expanded: true }), msg('root/0:x/0:y', 'root/0:x', 'B', 'A')];
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set() }).map((x) => x.title)).toEqual(['Cyclic collaboration: A → B → A']);
    const viaCallback = M.map((m) => (m.id === 'root/0:x/0:y' ? { ...m, viaParameter: 'onDone' } : m));
    expect(flowFindings({ messages: viaCallback, participants: P, inLoop: new Set() })).toEqual([]);
    // FR-19.16 the lambda's own calls are the writer's: A → B, B calls back A's lambda, the lambda calls A again — no cycle
    // (a functional-style TS app: host.allRefs → pages.everything(fetch) → fetch ⇒ host's lambda → host.pageOf)
    const back = [
      msg('root', null, null, 'A', { expanded: true }),
      msg('root/0:x', 'root', 'A', 'B', { expanded: true }),
      msg('root/0:x/0:fetch', 'root/0:x', 'B', 'A', { expanded: true, viaParameter: 'fetch', viaLambda: true }),
      msg('root/0:x/0:fetch/0:pageOf', 'root/0:x/0:fetch', 'A', 'A'),
    ];
    expect(flowFindings({ messages: back, participants: P, inLoop: new Set() })).toEqual([]);
    // … but a real call back from B's code after the callback still closes the cycle
    const real = [...back, msg('root/0:x/1:y', 'root/0:x', 'B', 'A')];
    expect(flowFindings({ messages: real, participants: P, inLoop: new Set() }).map((f) => f.title)).toEqual(['Cyclic collaboration: A → B → A']);
  });

  it('FR-19.14 a function calling its own inner functions («locals», same file) is no cyclic collaboration; a real one names its calls', () => {
    const mod = part('mod', undefined, { classKey: 'src/picker.tsx#<module>', className: 'picker', kind: 'module' });
    const locals = part('loc', undefined, { classKey: 'src/picker.tsx#Picker', className: 'Picker()' });
    const M = [
      msg('root', null, null, 'mod', { expanded: true, methodName: 'Picker' }),
      msg('root/0:onChange', 'root', 'mod', 'loc', { expanded: true, methodName: 'onChange' }),
      msg('root/0:onChange/0:toIso', 'root/0:onChange', 'loc', 'mod', { methodName: 'toIso' }),
    ];
    const run = (localFunctions?: (k: string) => boolean) => flowFindings({ messages: M, participants: [mod, locals], inLoop: new Set(), localFunctions });
    expect(run().map((f) => f.title)).toEqual(['Cyclic collaboration: picker → Picker() → picker']);
    expect(run((k) => k === 'src/picker.tsx#Picker')).toEqual([]);
    const A = [part('A'), part('B')];
    const site = (line: number) => ({ file: 'src/A.ts', start: { line, character: 0 }, end: { line, character: 1 } });
    const C = [
      msg('root', null, null, 'A', { expanded: true, methodName: 'run' }),
      msg('root/0:x', 'root', 'A', 'B', { expanded: true, methodName: 'load', callSite: site(9) }),
      msg('root/0:x/0:y', 'root/0:x', 'B', 'A', { methodName: 'notify' }),
    ];
    expect(flowFindings({ messages: C, participants: A, inLoop: new Set() })[0].evidence).toEqual(['A → B: run calls load (A.ts:10)', 'B → A: load calls notify']);
  });

  it('FR-19.4 a cyclic collaboration carries the whole call chain of the cooperation, inner calls included', () => {
    const P = [part('A'), part('B')];
    const M = [
      msg('root', null, null, 'A', { expanded: true }),
      msg('root/0:x', 'root', 'A', 'B', { expanded: true }),
      msg('root/0:x/0:inner', 'root/0:x', 'B', 'B', { expanded: true }),
      msg('root/0:x/0:inner/0:y', 'root/0:x/0:inner', 'B', 'A'),
    ];
    const [f] = flowFindings({ messages: M, participants: P, inLoop: new Set() });
    expect(f.messageIds).toEqual(['root/0:x', 'root/0:x/0:inner', 'root/0:x/0:inner/0:y']);
    expect(f.classKeys).toEqual(['src/A.ts#A', 'src/B.ts#B']);
  });
});

describe('FR-19 design findings (class diagram)', () => {
  const cls = (key: string): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], namespace: '', methods: [] });
  const rel = (from: string, to: string, kind: ClassRelation['kind'] = 'dependency'): ClassRelation => ({ id: `${kind}:${from}->${to}`, kind, from, to });

  it('FR-19.5 dependency cycles among the visible classes (not through inheritance or callbacks)', () => {
    const classes = ['A', 'B', 'C', 'D'].map(cls);
    const relations = [rel('A', 'B'), rel('B', 'C'), rel('C', 'A', 'association'), rel('C', 'D'), rel('D', 'C', 'realization')];
    const f = classFindings({ classes, relations, injected: () => [] });
    expect(f.map((x) => x.title)).toEqual(['Dependency cycle: A → B → C → A']);
    expect(f[0].relationIds!.sort()).toEqual(['association:C->A', 'dependency:A->B', 'dependency:B->C']);
    expect(classFindings({ classes, relations, injected: () => [], callbackOnly: (r) => r.from === 'C' && r.to === 'A' })).toEqual([]);
    expect(stronglyConnected(['x', 'y'], [{ from: 'x', to: 'y' }]).map((s) => s.length)).toEqual([1, 1]);
  });

  it('FR-19.14 a function and its inner functions («locals», same file) form no cycle; a cycle card names the classes and what closes it', () => {
    const mod: ClassNode = { ...cls('src/picker.tsx#<module>'), name: 'picker', kind: 'module' };
    const loc: ClassNode = { ...cls('src/picker.tsx#Picker'), name: 'Picker()' };
    const relations = [rel(mod.key, loc.key), rel(loc.key, mod.key)];
    expect(classFindings({ classes: [mod, loc], relations, injected: () => [] })).toHaveLength(1);
    expect(classFindings({ classes: [mod, loc], relations, injected: () => [], localFunctions: (k) => k === loc.key })).toEqual([]);
    // FR-19.16 an inner function called from another file was handed out (a callback prop): no dependency either
    const page: ClassNode = { ...cls('src/page.tsx#<module>'), name: 'page', kind: 'module' };
    const handedOut = [rel(page.key, mod.key), rel(loc.key, page.key), rel(page.key, loc.key)];
    expect(classFindings({ classes: [page, mod, loc], relations: handedOut, injected: () => [] })).toHaveLength(1);
    expect(classFindings({ classes: [page, mod, loc], relations: handedOut, injected: () => [], localFunctions: (k) => k === loc.key })).toEqual([]);
    const a: ClassNode = { ...cls('src/a.ts#A'), name: 'A' };
    const b: ClassNode = { ...cls('src/b.ts#B'), name: 'B', kind: 'interface' };
    const site = (line: number) => ({ file: 'src/a.ts', start: { line, character: 0 }, end: { line, character: 1 } });
    const ab: ClassRelation = { ...rel(a.key, b.key), calls: [{ messageId: 'root/0:x', label: 'run → load', callSite: site(4) }, { messageId: 'root/1:x', label: 'save → load' }] };
    const ba: ClassRelation = { ...rel(b.key, a.key, 'association'), label: 'owner' };
    const [f] = classFindings({ classes: [a, b], relations: [ab, ba], injected: () => [] });
    expect(f.evidence).toEqual([
      'A: class in src/a.ts',
      'B: interface in src/b.ts',
      'A → B: run calls load (a.ts:5); save calls load',
      'B → A: holds it in the field owner',
    ]);
  });

  it('FR-19.6 too many injected dependencies (default more than 6, configurable)', () => {
    const deps = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(classFindings({ classes: [cls('Svc')], relations: [], injected: () => deps }).map((x) => x.title)).toEqual(['Too many dependencies: Svc (7 injected)']);
    expect(classFindings({ classes: [cls('Svc')], relations: [], injected: () => deps, maxDependencies: 7 })).toEqual([]);
  });

  it('FR-19.11 god class: many methods, a long file and much state or many collaborators — all three; models exempt; thresholds and ignore', () => {
    const size = (extra: Partial<ClassSize> = {}): ClassSize => ({ methods: 28, lines: 1021, fields: 13, dependencies: 3, ...extra });
    const run = (s: ClassSize, extra: Partial<Parameters<typeof classFindings>[0]> = {}) => classFindings({ classes: [cls('TransfersManager')], relations: [], injected: () => [], size: () => s, ...extra });
    expect(run(size()).map((f) => [f.kind, f.title])).toEqual([['god-class', 'God class: TransfersManager (28 methods, 1021 lines)']]);
    expect(run(size())[0].detail).toContain('13 fields');
    expect(run(size({ fields: 4, dependencies: 8 }))[0].detail).toContain('8 injected dependencies');
    // each signal is needed
    expect(run(size({ methods: 19 }))).toEqual([]);
    expect(run(size({ lines: 499 }))).toEqual([]);
    expect(run(size({ lines: undefined }))).toEqual([]);
    expect(run(size({ fields: 9, dependencies: 6 }))).toEqual([]);
    // an Active Record model, an ignored name, a disabled kind, higher thresholds
    expect(run(size({ exempt: true }))).toEqual([]);
    expect(run(size(), { ignored: (n) => n === 'TransfersManager' })).toEqual([]);
    expect(run(size(), { disabled: new Set(['god-class']) })).toEqual([]);
    expect(run(size(), { godClass: { lines: 1100 } })).toEqual([]);
    expect(GOD_CLASS_DEFAULTS).toEqual({ methods: 20, lines: 500, fields: 10, dependencies: 7 });
  });

  it('FR-19.11 god classes in a project (PHP fixture, low thresholds): sizes from the class and its file, thresholds from .seqcall.json', async () => {
    const PHP = path.resolve(__dirname, '../../../fixtures/php-app').replace(/\\/g, '/');
    const adapter = new PhpAdapter(PHP);
    try {
      const withConfig = (godClass: Record<string, unknown>) => {
        const base = createClassifier(PHP);
        return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { findingsConfig: () => ({ godClass }) });
      };
      const gods = async (godClass: Record<string, unknown>) =>
        ((await new DiagramSession({ adapter, classifier: withConfig(godClass) }).findProjectIssues()) ?? []).filter((f) => f.finding.kind === 'god-class').map((f) => f.finding.title.replace(/ \(.*$/, '').replace('God class: ', ''));
      const low = { methods: 1, lines: 1, fields: 1, dependencies: 1 };
      expect(await gods(low)).toContain('OrderService');
      expect(await gods({ ...low, methods: 50 })).toEqual([]); // every threshold counts
      expect(await gods({})).toEqual([]); // the defaults: a small fixture has none
    } finally {
      await adapter.dispose();
    }
  });

  it('FR-17 refinement: .NET data access counts only calls that reach the database', () => {
    const lib = (key: string, methodName: string): CallSite => ({ ordinal: 0, kind: 'call', range: { file: '/f', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, methodName, expressionText: 'x', args: [], receiver: { kind: 'none' }, target: { key, name: methodName, owner: { key: 'lib:Npgsql', name: 'Npgsql', kind: 'external' }, isStatic: false, hasBody: false }, isAsync: false, isLibrary: true });
    expect(ioKindOfCall(lib('lib:Npgsql#Npgsql.NpgsqlParameterCollection.AddWithValue(…)', 'AddWithValue'))).toBeUndefined();
    expect(ioKindOfCall(lib('lib:Npgsql#Npgsql.NpgsqlDataSource.CreateCommand(…)', 'CreateCommand'))).toBeUndefined();
    expect(ioKindOfCall(lib('lib:Npgsql#Npgsql.NpgsqlCommand.ExecuteReaderAsync(…)', 'ExecuteReaderAsync'))).toBe('db');
    expect(ioKindOfCall(lib('lib:Microsoft.EntityFrameworkCore#Microsoft.EntityFrameworkCore.DbContext.SaveChangesAsync(…)', 'SaveChangesAsync'))).toBe('db');
  });
});

describe('FR-19.17 one list of issues for both diagrams', () => {
  const cls = (key: string, layer?: string): ClassNode => ({ key, name: key.replace(/^.*#/, ''), kind: 'class', stereotypes: [], namespace: '', methods: [], ...(layer ? { layer } : {}) });
  const site = { file: 'src/domain/order.ts', start: { line: 11, character: 0 }, end: { line: 11, character: 1 } };

  it('FR-19.17 layer violations are issues: both classes, the relation, its calls, what closes it', () => {
    const classes = [cls('src/domain/order.ts#Order', 'Domain'), cls('src/infra/db.ts#Db', 'Infrastructure'), cls('src/app/svc.ts#Svc', 'Application')];
    const relations: ClassRelation[] = [
      { id: 'dependency:Order->Db', kind: 'dependency', from: classes[0].key, to: classes[1].key, violation: 'Domain → Infrastructure: an inner layer depends on an outer layer', calls: [{ messageId: 'root/0:save/1:insert', label: 'save → insert', callSite: site }] },
      { id: 'dependency:Svc->Order', kind: 'dependency', from: classes[2].key, to: classes[0].key, calls: [{ messageId: 'root/0:save', label: 'run → save' }] },
    ];
    expect(layerViolationFindings(classes, relations)).toEqual([{
      id: 'layer-violation:dependency:Order->Db',
      kind: 'layer-violation',
      title: 'Layer violation: Order → Db',
      detail: 'Domain → Infrastructure: an inner layer depends on an outer layer',
      messageIds: ['root/0:save/1:insert'],
      classKeys: [classes[0].key, classes[1].key],
      relationIds: ['dependency:Order->Db'],
      evidence: ['Order: Domain', 'Db: Infrastructure', 'Order → Db: save calls insert (order.ts:12)'],
    }]);
    // one issue per class pair: a «create» of the same pair joins the call's issue (the map counts pairs too)
    const create: ClassRelation = { id: 'dependency:Order->Db:«create»', kind: 'dependency', label: '«create»', from: classes[0].key, to: classes[1].key, violation: relations[0].violation, calls: [{ messageId: 'root/0:save/2:new', label: 'save → Db', callSite: site }] };
    const merged = layerViolationFindings(classes, [...relations, create]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'layer-violation:dependency:Order->Db',
      messageIds: ['root/0:save/1:insert', 'root/0:save/2:new'],
      relationIds: ['dependency:Order->Db', 'dependency:Order->Db:«create»'],
    });
    expect(merged[0].evidence?.[2]).toBe('Order → Db: save calls insert (order.ts:12); save creates it (order.ts:12)');
    // a class finding gets the calls behind its relations (sequence evidence)
    expect(withMessageEvidence({ id: 'c', kind: 'dependency-cycle', title: 't', relationIds: ['dependency:Svc->Order'] }, relations).messageIds).toEqual(['root/0:save']);
  });

  it('FR-19.17 a cyclic collaboration of the same classes as a dependency cycle is one issue: the cycle, with the call chain', () => {
    const chain = { id: 'cc', kind: 'cyclic-collaboration' as const, title: 'Cyclic collaboration: A → B → A', messageIds: ['root/0:x', 'root/0:x/0:y'], classKeys: ['B', 'A'] };
    const cycle = { id: 'dc', kind: 'dependency-cycle' as const, title: 'Dependency cycle: A → B → A', classKeys: ['A', 'B'], relationIds: ['r1'] };
    expect(mergeCycles([chain], [cycle])).toEqual([{ ...cycle, messageIds: chain.messageIds }]);
    // other classes: both stay
    expect(mergeCycles([chain], [{ ...cycle, classKeys: ['A', 'C'] }])).toHaveLength(2);
  });
});

describe('FR-19 design findings: shapes at the edges', () => {
  const cls = (key: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name: key.replace(/^.*#/, ''), kind: 'class', stereotypes: [], namespace: '', methods: [], ...extra });
  const rel = (from: string, to: string, extra: Partial<ClassRelation> = {}): ClassRelation => ({ id: `${from}->${to}`, kind: 'dependency', from, to, ...extra });

  it('FR-19.1 a creation in a loop is named Class.constructor; a call to no known class ?.method', () => {
    const P = [part('Svc', 'Application')];
    const M = [
      msg('root', null, null, 'Svc', { expanded: true }),
      msg('root/0:Order', 'root', 'Svc', 'Svc', { kind: 'create', className: 'Order', methodName: 'Order', sideEffects: { kinds: ['db'], evidence: [] } }),
      msg('root/1:send', 'root', 'Svc', 'Svc', { className: undefined, methodName: 'send', sideEffects: { kinds: ['http'], evidence: [] } }),
    ];
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set(['root/0:Order', 'root/1:send']) }).map((f) => f.title)).toEqual(['I/O in a loop: Order.constructor (DB)', 'I/O in a loop: ?.send (HTTP)']);
  });

  it('FR-19.2 I/O in Domain: the calls that do it are its evidence; I/O only further down is none of its own', () => {
    const P = [part('Order', 'Domain')];
    const M = [
      msg('root', null, null, 'Order', { expanded: true }),
      msg('root/0:save', 'root', 'Order', 'Order', { sideEffects: { kinds: ['db'], evidence: [] } }),
      msg('root/1:load', 'root', 'Order', 'Order', { sideEffects: { kinds: ['http'], evidence: [], below: true } }),
    ];
    expect(flowFindings({ messages: M, participants: P, inLoop: new Set() })).toEqual([
      expect.objectContaining({ title: 'I/O in Domain: Order (DB)', messageIds: ['root/0:save'] }),
    ]);
    // I/O of its file only (no call drawn doing it): no messages
    const own = flowFindings({ messages: [M[0]], participants: [part('Order', 'Domain', { sideEffects: { kinds: ['db'], evidence: [] } })], inLoop: new Set() });
    expect(own[0]).not.toHaveProperty('messageIds');
  });

  it('FR-19 every kind can be turned off ("findings.disable"); no messages, no findings', () => {
    const P = [part('Ctl', 'Presentation'), part('Svc', 'Application'), part('Repo', 'Infrastructure'), part('Dom', 'Domain', { sideEffects: { kinds: ['db'], evidence: [] } })];
    const M = [
      msg('root', null, null, 'Ctl', { expanded: true }),
      msg('root/0:a', 'root', 'Ctl', 'Svc', { expanded: true, sideEffects: { kinds: ['db'], evidence: [] } }),
      msg('root/0:a/0:b', 'root/0:a', 'Svc', 'Repo', { expanded: true }),
      msg('root/0:a/0:b/0:c', 'root/0:a/0:b', 'Repo', 'Svc', { expanded: true }),
      msg('root/0:a/0:b/0:c/0:d', 'root/0:a/0:b/0:c', 'Svc', 'Repo'),
      msg('root/1:x', 'root', 'Ctl', 'Dom'),
    ];
    const input = { messages: M, participants: P, inLoop: new Set(['root/0:a']) };
    expect(flowFindings(input).map((f) => f.kind).sort()).toEqual(['cyclic-collaboration', 'io-in-domain', 'io-in-loop', 'layer-ping-pong']);
    expect(flowFindings({ ...input, disabled: new Set(['io-in-loop', 'io-in-domain', 'layer-ping-pong', 'cyclic-collaboration']) })).toEqual([]);
    expect(flowFindings({ messages: [], participants: [], inLoop: new Set() })).toEqual([]);
    const classes = [cls('A'), cls('B')];
    const relations = [rel('A', 'B'), rel('B', 'A')];
    expect(classFindings({ classes, relations, injected: () => Array.from({ length: 9 }, (_, i) => `D${i}`), disabled: new Set(['dependency-cycle', 'too-many-dependencies']) })).toEqual([]);
  });

  it('FR-19.3 / FR-19.4 one finding per pair of layers and per cycle, though several paths show them; a crossing from a sender not drawn', () => {
    const P = [part('Ctl', 'Presentation'), part('Svc', 'Application'), part('Repo', 'Infrastructure')];
    const path = (k: number) => [
      msg(`root/${k}:a`, 'root', 'Ctl', 'Svc', { expanded: true }),
      msg(`root/${k}:a/0:b`, `root/${k}:a`, 'Svc', 'Repo', { expanded: true }),
      msg(`root/${k}:a/0:b/0:c`, `root/${k}:a/0:b`, 'Repo', 'Svc', { expanded: true }),
      msg(`root/${k}:a/0:b/0:c/0:d`, `root/${k}:a/0:b/0:c`, k === 1 ? 'Gone' : 'Svc', 'Repo', { methodName: 'd' }),
    ];
    const M = [msg('root', null, null, 'Ctl', { expanded: true }), ...path(0), ...path(1)];
    const f = flowFindings({ messages: M, participants: P, inLoop: new Set() });
    expect(f.map((x) => x.kind)).toEqual(['layer-ping-pong', 'cyclic-collaboration']);
    // found on the first path; the second does not replace it
    expect(f.map((x) => x.messageIds![0])).toEqual(['root/0:a/0:b', 'root/0:a/0:b']);
    // the second path's crossings: its last sender is no participant (no "X calls")
    const second = flowFindings({ messages: [M[0], ...path(1)], participants: P, inLoop: new Set() })[0];
    expect(second.evidence!.at(-1)).toBe('Application → Infrastructure: Repo.d');
    expect(second.classKeys).toEqual(['src/Svc.ts#Svc', 'src/Repo.ts#Repo']);
    // a library call is no crossing (its target is the library's, whatever participant draws it)
    const lib = path(2).map((m) => (m.id === 'root/2:a/0:b' ? { ...m, isLibrary: true } : m));
    expect(flowFindings({ messages: [M[0], ...lib], participants: P, inLoop: new Set(), disabled: new Set(['cyclic-collaboration']) })).toEqual([]);
  });

  it('FR-19.5 a cycle is named along its edges', () => {
    const [f] = classFindings({ classes: [cls('A'), cls('B'), cls('C')], relations: [rel('A', 'C'), rel('C', 'B'), rel('B', 'A')], injected: () => [] });
    expect(f.title).toBe('Dependency cycle: A → C → B → A');
  });

  it('FR-19.5 a cycle whose order is not a chain of edges (A ⇄ B, A ⇄ C): the step without an edge has no reason line', () => {
    const relations = [rel('A', 'B'), rel('B', 'A'), rel('A', 'C'), rel('C', 'A')];
    const [f] = classFindings({ classes: [cls('A'), cls('B'), cls('C')], relations, injected: () => [] });
    expect(f.title).toBe('Dependency cycle: A → B → C → A');
    expect(f.evidence!.filter((e) => e.includes('→'))).toEqual(['A → B: dependency', 'C → A: dependency']);
  });

  it('FR-19.6 / FR-19.14 more than eight dependencies are cut; a cycle names abstract classes, type uses and many calls', () => {
    const many = classFindings({ classes: [cls('Svc')], relations: [], injected: () => Array.from({ length: 9 }, (_, i) => `D${i}`) });
    expect(many[0].detail).toBe('More than 6 collaborators (D0, D1, D2, D3, D4, D5, D6, D7, …): the class probably does several jobs.');
    const site = (line: number) => ({ file: 'src/a.ts', start: { line, character: 0 }, end: { line, character: 1 } });
    const a = cls('src/a.ts#A', { kind: 'abstract' });
    const b = cls('src/b.ts#B');
    const calls = [1, 2, 3, 4].map((l) => ({ messageId: `m${l}`, label: `f${l} → g`, callSite: site(l) }));
    const relations = [rel(a.key, b.key, { calls }), rel(b.key, a.key, { kind: 'use', uses: [{ method: 'run', range: site(9) }] })];
    const [f] = classFindings({ classes: [a, b], relations, injected: () => [] });
    expect(f.evidence).toEqual([
      'A: abstract class in src/a.ts',
      'B: class in src/b.ts',
      'A → B: f1 calls g (a.ts:2); f2 calls g (a.ts:3); f3 calls g (a.ts:4); … 1 more',
      'B → A: run uses the type (a.ts:10)',
    ]);
  });

  it('FR-19.17 evidence across the diagrams: findings without classes or messages, type uses without a message, relations of nothing', () => {
    expect(withClassEvidence({ id: 'x', kind: 'io-in-loop', title: 't' }, [cls('A')], [rel('A', 'B', { calls: [{ messageId: 'm', label: '' }] })])).toEqual({ id: 'x', kind: 'io-in-loop', title: 't' });
    const uses = rel('A', 'B', { id: 'u', kind: 'use', uses: [{ method: 'a', range: { file: 'f', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }, { method: 'b', range: { file: 'f', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, messageId: 'mb' }] });
    const bare = [rel('A', 'C', { id: 'n' }), rel('A', 'D', { id: 'v', kind: 'use' })];
    expect(withMessageEvidence({ id: 'c', kind: 'dependency-cycle', title: 't', relationIds: ['u', 'n', 'v'] }, [uses, ...bare]).messageIds).toEqual(['mb']);
    expect(withMessageEvidence({ id: 'c', kind: 'dependency-cycle', title: 't' }, [uses])).toEqual({ id: 'c', kind: 'dependency-cycle', title: 't' });
    // mergeCycles: findings without classes are the same (none) only for themselves
    const chain = { id: 'cc', kind: 'cyclic-collaboration' as const, title: 'c' };
    const cycle = { id: 'dc', kind: 'dependency-cycle' as const, title: 'd' };
    expect(mergeCycles([chain], [cycle])).toEqual([cycle]);
  });

  it('FR-19.17 a layer violation between classes not drawn (or without a layer), without calls', () => {
    expect(layerViolationFindings([cls('src/a.ts#A')], [rel('src/a.ts#A', 'src/b.ts#B', { violation: 'x' })])[0]).toEqual({
      id: 'layer-violation:src/a.ts#A->src/b.ts#B',
      kind: 'layer-violation',
      title: 'Layer violation: A → B',
      detail: 'x',
      classKeys: ['src/a.ts#A', 'src/b.ts#B'],
      relationIds: ['src/a.ts#A->src/b.ts#B'],
      evidence: ['A: ?', 'B: ?', 'A → B: dependency'],
    });
  });

  it('issues are judged without the type uses (used-only classes and use relations dropped); without them nothing changes', () => {
    const cd = { classes: [cls('A'), cls('B', { usedOnly: true }), cls('C')], relations: [rel('A', 'B'), rel('A', 'C', { kind: 'use' }), rel('A', 'C')] };
    expect(withoutTypeUses(cd)).toEqual({ classes: [cls('A'), cls('C')], relations: [rel('A', 'C')] });
    const plain = { classes: [cls('A')], relations: [rel('A', 'C')] };
    expect(withoutTypeUses(plain)).toBe(plain);
  });
});

describe('FR-19.4 on the sample app', () => {
  it('Order hands itself to Pricing, which calls back the same Order object: one participant, a cyclic collaboration', async () => {
    const s = newSession();
    await s.openAt(file('src/domain/order.ts'), positionOf('src/domain/order.ts', 'total(): number'));
    const d = (await s.expandEverything())!;
    const back = d.messages.find((m) => m.methodName === 'items')!;
    expect(back.to).toBe(d.messages.find((m) => m.parentId === null)!.to);
    expect(d.participants.filter((p) => p.className === 'Order')).toHaveLength(1);
    // FR-19.17 one problem, one issue: the dependency cycle of the same classes, with the collaboration's call chain
    expect(d.findings?.map((f) => [f.title, f.messageIds])).toEqual([['Dependency cycle: Order → Pricing → Order', [`root/0:price`, `root/0:price/0:items`]]]);
    const cd = (await s.getClassDiagram())!;
    expect(cd.findings?.map((f) => f.id)).toEqual(d.findings?.map((f) => f.id));
  });
});
