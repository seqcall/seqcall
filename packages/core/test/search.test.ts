import { describe, expect, it } from 'vitest';
import type { MethodRef } from '@seqcall/protocol';
import type { ArgumentFunction, CallSite } from '../src/adapter';
import { nameMatches, searchBelow, type SearchDeps } from '../src/search';
import { K, byId, ids, method, newSession } from './helpers';

describe('Find: name matching (FR-23.1)', () => {
  it('FR-23.1 substring, case-insensitive', () => {
    expect(nameMatches('user', 'findUser')).toBe(true);
    expect(nameMatches('USER', 'findUser')).toBe(true);
    expect(nameMatches('xyz', 'findUser')).toBe(false);
    expect(nameMatches('  ', 'findUser')).toBe(false);
  });

  it('FR-23.1 camelCase and snake_case word starts, in order', () => {
    expect(nameMatches('fU', 'findUser')).toBe(true);
    expect(nameMatches('fiUse', 'findUser')).toBe(true);
    expect(nameMatches('uf', 'findUser')).toBe(false);
    expect(nameMatches('pcv', 'PayCartViaVoucherAsync')).toBe(true); // words may be skipped
    expect(nameMatches('gub', 'get_user_by_id')).toBe(true);
    expect(nameMatches('htmlP', 'HTMLParser')).toBe(true);
  });

  it('FR-23.1 a dotted query matches Class.method', () => {
    expect(nameMatches('Service.find', 'findUser', 'UserService.findUser')).toBe(true);
    expect(nameMatches('Repo.find', 'findUser', 'UserService.findUser')).toBe(false);
  });
});

describe('Find below collapsed calls (FR-23.2, FR-23.3)', () => {
  it('FR-23.2 finds calls below collapsed messages, through every implementation, with their path', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const r = (await s.searchCollapsed('query'))!;
    const hit = r.hits.find((h) => h.labels.includes('SqlUserRepository.findById'))!;
    expect(hit).toMatchObject({ anchorId: 'root/2:findUser', labels: ['UserService.findUser', 'SqlUserRepository.findById'], hit: { label: 'Database.query' } });
    expect(hit.steps.map((x) => x.methodKey)).toEqual([K.findUser, K.sqlFindById]);
    expect(r.truncated).toBe(false);
    expect(r.methods).toBeGreaterThan(1);
  });

  it('FR-23.2 / FR-1.13 the search follows function parameters to what the caller passed (a function reference, a lambda)', async () => {
    const s = newSession();
    await s.openMethod(await method('src/controllers/scan-command.ts#<module>.runScan'));
    // runScan → scanAll(repos, host.listBranches) (collapsed); scanAll invokes listBranches(repo): the adapter's function,
    // whose body calls Logger.info — found through the binding, as Expand all would draw it
    const r = (await s.searchCollapsed('info'))!;
    const hit = r.hits.find((h) => h.hit.label === 'Logger.info')!;
    expect(hit).toBeDefined();
    expect(hit.labels[0]).toBe('scanAll');
    expect(hit.anchorId).toMatch(/scanAll$/);
  });

  it('FR-23.2 nothing is searched below expanded messages (their calls are visible) and visible calls are not hits', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    const r = (await s.searchCollapsed('findById'))!;
    expect(r.hits).toEqual([]);
  });

  it('FR-23.3 revealing a hit expands only its path, chooses the implementation and returns the call', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const before = ids(s.current()!).length;
    const hit = (await s.searchCollapsed('query'))!.hits.find((h) => h.labels.includes('SqlUserRepository.findById'))!;
    const { diagram, messageId } = (await s.revealSearchHit(hit))!;
    const m = byId(diagram!, messageId);
    expect(m.methodName).toBe('query');
    const findById = byId(diagram!, m.parentId!);
    expect(findById).toMatchObject({ methodName: 'findById', expanded: true });
    expect(findById.polymorphic?.selectedKey).toBe('src/adapters/sql-user-repository.ts#SqlUserRepository');
    // other collapsed calls stay collapsed
    expect(diagram!.messages.filter((x) => x.expanded).map((x) => x.id)).toEqual(['root', 'root/2:findUser', findById.id]);
    expect(ids(diagram!).length).toBeGreaterThan(before);
    expect(diagram!.canGoBack).toBe(false); // not a history step
  });

  it('FR-23.2 cancelling stops the search', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    expect(await s.searchCollapsed('query', { cancelled: () => true })).toBeUndefined();
  });
});

// ── a fake program: method name → its calls ──
const M = (name: string, o: { body?: boolean; owner?: string; module?: boolean } = {}): MethodRef =>
  ({ key: `src/x.ts#${o.owner ?? 'X'}.${name}`, name, owner: { key: `src/x.ts#${o.owner ?? 'X'}`, name: o.owner ?? 'X', kind: o.module ? 'module' : 'class' }, hasBody: o.body ?? true }) as MethodRef;
let line = 0;
const C = (methodName: string, over: Partial<CallSite> = {}): CallSite => {
  line++;
  return { ordinal: 0, kind: 'call', range: { file: 'src/x.ts', start: { line, character: 0 }, end: { line, character: 1 } }, methodName, expressionText: `${methodName}()`, args: [], receiver: { kind: 'none' }, isAsync: false, isLibrary: false, ...over };
};
const to = (m: MethodRef, over: Partial<CallSite> = {}) => C(m.name, { target: m, ...over });
function program(bodies: Record<string, CallSite[]>, extra: Partial<SearchDeps> = {}) {
  const asked: string[] = [];
  const deps: SearchDeps = {
    outgoing: async (m) => (asked.push(m.name), bodies[m.name] ?? []),
    implementations: async () => [],
    libraryCalls: false,
    ...extra,
  };
  return { deps, asked };
}
const found = (r: Awaited<ReturnType<typeof searchBelow>>) => r!.hits.map((h) => `${h.labels.join(' > ')}: ${h.hit.label}${h.hit.isLibrary ? ' (lib)' : ''}`);

describe('Find below collapsed calls: the walk (FR-23.2)', () => {
  const a = M('a');
  const b = M('b');
  const c = M('c');

  it('FR-23.5 an @object not drawn: the calls that reach its class (by label exactly, generics aside, or a typed name); not searched inside it', async () => {
    const send = M('send', { owner: 'Mailer' });
    const fetch = M('fetch', { owner: 'ApiClient<T>' });
    const body = { a: [to(b), to(send)], b: [to(fetch), C('query', { isLibrary: true, receiverType: { key: 'lib:pg#Database', name: 'Database', kind: 'external' } }), to(M('mailNow', { module: true }))], send: [to(M('format', { owner: 'Mailer' }))] };
    const run = program(body, { libraryCalls: true });
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@:Mailer', run.deps))).toEqual(['X.a: Mailer.send']);
    // its own calls are below the call that reaches it: the object is not searched inside
    expect(run.asked).toEqual(['a', 'b', 'fetch', 'mailNow']);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@client:ApiClient', program(body).deps))).toEqual(['X.a > X.b: ApiClient<T>.fetch']);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@:Database', program(body, { libraryCalls: true }).deps))).toEqual(['X.a > X.b: Database.query (lib)']);
    // a typed name matches like the drawn lifelines (word starts; a module function is no object); an exact label does not match a longer class
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@mail', program(body).deps))).toEqual(['X.a: Mailer.send']);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@:Mail', program(body).deps))).toEqual([]);
    // "@" alone names no object (a call named like it: none)
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], '@', program(body).deps))).toEqual([]);
  });

  it('FR-23.2 the method limit ends the search and says so', async () => {
    const { deps, asked } = program({ a: [to(b), C('save')], b: [to(c), C('save')], c: [C('save')] });
    const r = await searchBelow([{ id: 'm1', methods: [a] }], 'save', deps, { depth: 4, methods: 2 });
    expect(found(r)).toEqual(['X.a: save', 'X.a > X.b: save']);
    expect(asked).toEqual(['a', 'b']);
    expect(r).toMatchObject({ methods: 2, truncated: true });
    // the limit reached with nothing left to search (b calls back into a, already searched): complete
    const done = program({ a: [to(b), C('save')], b: [to(a)] });
    expect(await searchBelow([{ id: 'm1', methods: [a] }], 'save', done.deps, { depth: 4, methods: 2 })).toMatchObject({ methods: 2, truncated: false });
  });

  it('FR-23.2 the depth limit: a body below it is not searched (truncated); an interface method below it is nothing missed', async () => {
    const iface = M('find', { owner: 'Repo', body: false });
    const { deps, asked } = program({ a: [to(b), C('save')], b: [C('save')] });
    const deep = await searchBelow([{ id: 'm1', methods: [a] }], 'save', deps, { depth: 1, methods: 10 });
    expect(found(deep)).toEqual(['X.a: save']);
    expect(asked).toEqual(['a']);
    expect(deep!.truncated).toBe(true);
    const onlyInterface = program({ a: [to(iface), C('save')] });
    expect((await searchBelow([{ id: 'm1', methods: [a] }], 'save', onlyInterface.deps, { depth: 1, methods: 10 }))!.truncated).toBe(false);
  });

  it('FR-23.2 at most 100 hits: the method that reaches them is complete, the rest is not searched', async () => {
    const { deps, asked } = program({ a: [...Array.from({ length: 101 }, () => C('save')), to(b)], b: [C('save')] });
    const r = await searchBelow([{ id: 'm1', methods: [a] }], 'save', deps);
    expect(r!.hits).toHaveLength(101);
    expect(asked).toEqual(['a']);
    expect(r).toMatchObject({ methods: 1, truncated: true });
  });

  it('FR-23.2 library calls are hits only when drawn; labelled by owner, receiver type or package; never searched below', async () => {
    const lib = (name: string, over: Partial<CallSite>) => C(name, { isLibrary: true, ...over });
    const body = {
      a: [
        lib('query', { receiverType: { key: 'lib:pg#Database', name: 'Database', kind: 'external' } }),
        lib('queryRaw', { libraryName: 'knex' }),
        lib('queryAll', {}),
        lib('querySome', { target: M('querySome', { owner: 'Pool' }) }),
        to(M('queryHelper', { module: true })),
      ],
    };
    const shown = program(body, { libraryCalls: true });
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'query', shown.deps))).toEqual([
      'X.a: Database.query (lib)',
      'X.a: knex.queryRaw (lib)',
      'X.a: queryAll (lib)',
      'X.a: Pool.querySome (lib)',
      'X.a: queryHelper',
    ]);
    // the module function is searched below, the library method (with a body in the fake) is not
    expect(shown.asked).toEqual(['a', 'queryHelper']);
    const hidden = program(body);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'query', hidden.deps))).toEqual(['X.a: queryHelper']);
  });

  it('FR-23.2 an anchor runs only its methods with a body (an interface method without a chosen implementation runs its implementations)', async () => {
    const { deps, asked } = program({ find: [C('save')] });
    const r = await searchBelow([{ id: 'm1', methods: [M('find', { owner: 'Repo', body: false }), M('find', { owner: 'SqlRepo' })] }], 'save', deps);
    expect(found(r)).toEqual(['SqlRepo.find: save']);
    expect(asked).toEqual(['find']);
  });

  it('FR-23.2 / FR-1.13 a function passed on through a parameter is followed; parameters without a name or without names known bind nothing', async () => {
    const audit = M('audit', { owner: 'Audit' });
    const lambda: ArgumentFunction = { kind: 'lambda', range: C('x').range, calls: [to(audit)] };
    const empty: ArgumentFunction = { kind: 'lambda', range: C('x').range };
    // a passes a lambda to b(cb); b passes its cb on to c(done), an empty lambda for c's unnamed first parameter and for more; c invokes them
    const bodies = {
      a: [to(b, { argFunctions: [lambda] })],
      b: [to(c, { argOrigins: [undefined, { kind: 'parameter', name: 'cb' }, { kind: 'parameter', name: 'other' }], argFunctions: [empty, undefined, empty] })],
      c: [C('done', { invokedParameter: 'done' }), C('first', { invokedParameter: 'first' }), C('more', { invokedParameter: 'more' })],
    };
    const names: Record<string, string[]> = { b: ['cb'], c: ['', 'done', 'more'] };
    const bound = program(bodies, { parameterNames: async (m) => names[m.name] ?? [] });
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'audit', bound.deps))).toEqual(['X.a > X.b > X.c: Audit.audit']);
    // the invocation of the empty lambda (its parameter has no name) stays the parameter call
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'first', bound.deps))).toEqual(['X.a > X.b > X.c: first']);
    // more() runs the lambda passed for it, whose body calls nothing
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'more', bound.deps))).toEqual([]);
    // an adapter without parameter names: the invocation is searched as it is
    const unbound = program(bodies);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'audit', unbound.deps))).toEqual([]);
    expect(found(await searchBelow([{ id: 'm1', methods: [a] }], 'done', unbound.deps))).toEqual(['X.a > X.b > X.c: done']);
  });
});

