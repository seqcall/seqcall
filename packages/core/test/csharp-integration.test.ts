import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeInfoLines, createClassifier, createCSharpAdapter, DEFAULT_OPTIONS, DiagramSession, resolveCSharpSidecar, type LanguageAdapter } from '../src/index';
import type { MethodRef } from '@seqcall/protocol';

/**
 * End-to-end through the real Roslyn sidecar (packages/csharp) on fixtures/sample-cs.
 * Skipped when dotnet or the sidecar build is unavailable (build: dotnet build packages/csharp -c Release).
 */
const ROOT = path.resolve(__dirname, '../../../fixtures/sample-cs').replace(/\\/g, '/');
const dll = resolveCSharpSidecar();
const hasDotnet = (() => {
  try {
    execFileSync('dotnet', ['--version'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const available = hasDotnet && fs.existsSync(dll);

describe.skipIf(!available)('C# end to end (Roslyn sidecar, fixtures/sample-cs)', () => {
  let adapter: LanguageAdapter;
  // FR-3.12 the frames and catches as the code has them: ↯ Fold errors off
  const session = () => new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
  const controller = `${ROOT}/src/Sample.Web/Controllers/UsersController.cs`;
  const getBody = { line: 22, character: 8 }; // inside UsersController.Get

  beforeAll(() => {
    // Sample.Batch uses a NuGet package (Autofac): without a restore its registrations are not found (issue #1)
    if (!fs.existsSync(`${ROOT}/src/Sample.Batch/obj/project.assets.json`)) {
      execFileSync('dotnet', ['restore', 'Sample.sln', '-nologo'], { cwd: ROOT, stdio: 'ignore' });
    }
    adapter = createCSharpAdapter(ROOT);
  }, 120_000);
  afterAll(async () => {
    await adapter?.dispose();
  });

  it('FR-1.1 opens the enclosing C# method with a found message and its direct calls', async () => {
    const d = (await session().openAt(controller, getBody))!;
    expect(d.root.key).toBe('src/Sample.Web/Controllers/UsersController.cs#UsersController.Get(string)');
    expect(d.messages[0]).toMatchObject({ kind: 'found', methodName: 'Get' });
    const call = d.messages.find((m) => m.methodName === 'GetUserDtoAsync')!;
    expect(call).toMatchObject({ kind: 'call', isAsync: true, expandable: true });
    // ControllerBase.Ok is a library call: hidden by default (FR-1.6)
    expect(d.messages.some((m) => m.methodName === 'Ok')).toBe(false);
  }, 120_000);

  it('FR-8.6 / FR-8.7 C#: the registrations choose the implementation; a controller action starts with the service provider building it', async () => {
    // the field each object goes to is the call's result (Results is off by default)
    const s = new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { ...DEFAULT_OPTIONS, showResults: true, foldErrors: false } } });
    await s.getEntryPoints();
    let d = (await s.openAt(controller, getBody))!;
    expect(d.messages[0]).toMatchObject({ id: 'container', kind: 'found', methodName: 'GetRequiredService', args: ['typeof(UsersController)'], expandable: true });
    expect(d.participants[0].className).toBe('ServiceProvider');
    d = (await s.expand('container'))!;
    const name = (id: string) => d.participants.find((p) => p.id === id)!.className;
    const creates = d.messages.filter((m) => m.parentId === 'container');
    // dependencies before consumers, named by the field they are stored in (`_users`; a primary constructor's parameter
    // `users`); IUserRepository → SqlUserRepository (AddSingleton; the TryAdd and the keyed one do not
    // replace it), IPaymentClient → PaymentApiClient (AddHttpClient); UserService is built once per consumer
    expect(creates.map((m) => `${(m.result as { target?: string } | undefined)?.target ?? ''}=${name(m.to)}`)).toEqual([
      '_primary=SqlUserRepository',
      '_replica=SqlUserRepository',
      '_users=UserService',
      'payments=PaymentApiClient',
      'users=UserService',
      '_billing=BillingService',
      '=UsersController',
    ]);
    expect(creates[0].callSite?.file).toMatch(/Program\.cs$/); // opens the registration
    // a call through the interface goes to the bound implementation, marked bound; the keyed one is listed with its key
    d = (await s.expand(d.messages.find((m) => m.methodName === 'GetUserDtoAsync')!.id))!;
    d = (await s.expand(d.messages.find((m) => m.methodName === 'FindUserAsync')!.id))!;
    const find = d.messages.find((m) => m.polymorphic?.interfaceName === 'IUserRepository')!;
    expect(find.polymorphic).toMatchObject({ selectedKey: 'src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository', bound: { classKey: 'src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository' } });
    expect(find.polymorphic!.keyed).toEqual([expect.objectContaining({ classKey: 'src/Sample.Infrastructure/Repositories/InMemoryUserRepository.cs#InMemoryUserRepository', key: '"cache"' })]);
  }, 120_000);

  it('FR-8.6 C#: shared code run by two applications that bind differently gets no choice; their keyed / conditional registrations are listed', async () => {
    // UserService (Sample.Core) runs in Sample.Web (IUserRepository → SqlUserRepository) and Sample.Batch (Autofac:
    // SqlUserRepository when live, else InMemoryUserRepository)
    const d = (await session().openMethodByKey('src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)'))!;
    const find = d.messages.find((m) => m.polymorphic?.interfaceName === 'IUserRepository')!;
    expect(find.polymorphic!.selectedKey).toBeUndefined();
    expect(find.polymorphic!.bound).toBeUndefined();
    expect(find.polymorphic!.keyed?.map((k) => `${k.kind} ${k.key} ${k.classKey.slice(k.classKey.indexOf('#') + 1)}`)).toEqual([
      'condition live SqlUserRepository',
      'condition !live InMemoryUserRepository',
      'key "sql" SqlUserRepository',
      'key "cache" InMemoryUserRepository',
    ]);
  }, 120_000);

  it('FR-5.8 C#: an object returned in a tuple with a local variable, deconstructed by the caller and passed on, is the created object', async () => {
    const s = session();
    await s.openMethodByKey('src/Sample.Core/Services/OrderingService.cs#OrderingService.PlaceAsync(string, decimal)');
    const d = (await s.expandAll())!;
    const created = d.messages.find((m) => m.kind === 'create' && m.className === 'Order')!;
    expect(d.participants.filter((p) => p.className === 'Order')).toHaveLength(1);
    expect(d.messages.find((m) => m.methodName === 'WithVat')!.to).toBe(created.to); // in Total(order!)
  }, 120_000);

  it('FR-5.9 C#: new TEnvelope { … } in a generic method creates the class the caller named (also passed on); opened alone, its constraint', async () => {
    const created = async (method: string, rounds = 1) => {
      const s = session();
      await s.openMethodByKey(method);
      let d = s.current()!;
      for (let i = 0; i < rounds; i++) d = (await s.expandAll())!;
      const create = d.messages.find((m) => m.kind === 'create')!;
      return d.participants.find((p) => p.id === create.to)!.className;
    };
    const ordering = 'src/Sample.Core/Services/OrderingService.cs#OrderingService';
    expect(await created(`${ordering}.Envelope(Order)`)).toBe('OrderEnvelope');
    expect(await created(`${ordering}.EnvelopeVia(Order)`, 2)).toBe('OrderEnvelope');
    expect(await created('src/Sample.Core/Util/Envelopes.cs#EnvelopeExtensions.Wrap`2(TData)')).toMatch(/^Envelope/);
  }, 120_000);

  it('FR-5.4 new X().M(): the message goes to the object just created; two creations of a mutable class are two objects', async () => {
    const d = (await session().openMethodByKey('src/Sample.Core/Services/PricingService.cs#PricingService.Labels()'))!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    const calls = d.messages.filter((m) => m.kind === 'call' && m.className === 'Draft');
    expect(creates.length).toBe(2);
    // each call goes to the object its own `new` created: two objects, no third «expression» object
    expect(calls.map((c) => c.to)).toEqual(creates.map((c) => c.to));
    expect(new Set(creates.map((c) => c.to)).size).toBe(2);
    expect(d.participants.filter((p) => p.className === 'Draft').length).toBe(2);
  }, 120_000);

  it('FR-5.4 / FR-5.12 new X().M() on a value (a record): both calls go to the one value lifeline ×2', async () => {
    const d = (await session().openMethodByKey('src/Sample.Core/Services/BillingService.cs#BillingService.Quote(decimal)'))!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    const calls = d.messages.filter((m) => m.kind === 'call' && m.className === 'Order');
    expect([creates.length, calls.length]).toEqual([2, 2]);
    const order = d.participants.filter((p) => p.className === 'Order');
    expect(order.map((p) => [p.instances, p.instancesWhy])).toEqual([[2, 'value']]);
    expect([...new Set([...creates, ...calls].map((m) => m.to))]).toEqual([order[0].id]);
  }, 120_000);

  it('FR-5.12 values share one lifeline per class (static factories too); a value its own class creates keeps its lifeline; mutable objects one each', async () => {
    const s = session();
    await s.openMethodByKey('src/Sample.Core/Services/PricingService.cs#PricingService.Total(decimal, decimal)');
    const d = (await s.expandEverything())!;
    // the objects (the class's static lifeline is no object)
    const lifelines = (name: string) => d.participants.filter((p) => p.className === name && p.id.includes('|new:'));
    // new Price(a) and new Price(b) in Total: one lifeline; `new(…)` inside Price.Add, created by a Price: its own
    const prices = lifelines('Price');
    const fromTotal = prices.find((p) => p.instances === 2)!;
    expect(fromTotal.instancesWhy).toBe('value');
    expect(prices.length).toBe(2);
    const add = d.messages.find((m) => m.methodName === 'Add')!;
    expect(add.to).toBe(fromTotal.id);
    const own = d.messages.find((m) => m.kind === 'create' && m.parentId === add.id)!;
    expect(own.from).toBe(fromTotal.id);
    expect(own.to).not.toBe(fromTotal.id);
    // Outcome<Price>.Fail / .Ok build their objects in the class's static factories: one value lifeline, IsOk goes to it
    const outcomes = lifelines('Outcome<T>');
    expect(outcomes.map((p) => p.instances)).toEqual([3]);
    expect(outcomes[0].instancesWhy).toBe('value');
    expect(outcomes[0].alternatives).toBeUndefined();
  }, 120_000);

  it('FR-7.10 C#: PaymentApiClient (HttpClient) behind IPaymentClient is an adapter, the interface a port; the call through the port is no layer violation', async () => {
    const s = session();
    await s.openMethodByKey('src/Sample.Core/Services/BillingService.cs#BillingService.ChargeAsync(string, decimal)');
    const d = s.current()!;
    const charge = d.messages.find((m) => m.methodName === 'ChargeAsync' && m.parentId === 'root')!;
    const target = d.participants.find((p) => p.id === charge.to)!;
    if (target.className === 'IPaymentClient') {
      expect(target.stereotypes).toContain('port');
      expect(target.stereotypeReasons?.find((r) => r.stereotype === 'port')?.text).toBe('an adapter implements it: PaymentApiClient (HTTP)');
    } else {
      expect(target.className).toBe('PaymentApiClient'); // the single implementation, chosen automatically
      expect(target.stereotypeReasons?.find((r) => r.stereotype === 'adapter')?.text).toBe('implements `IPaymentClient` and does HTTP itself');
      const billing = d.participants.find((p) => p.className === 'BillingService')!;
      expect(billing.layerViolations ?? []).toEqual([]);
    }
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.name === 'IPaymentClient')?.stereotypes).toContain('port');
  }, 120_000);

  it('FR-6/7 stereotypes and layers from C# projects; groups follow the call flow', async () => {
    const s = session();
    await s.openAt(controller, getBody);
    await s.expandAll();
    const d = (await s.expandAll())!; // controller → service → repositories (3 levels)
    const by = (name: string) => d.participants.find((p) => p.className === name)!;
    expect(by('UsersController')).toMatchObject({ layer: 'Presentation' });
    expect(by('UsersController').stereotypes).toContain('controller');
    expect(by('UserService')).toMatchObject({ layer: 'Application' });
    expect(by('UserDto').layer).toBe('Domain');
    // FR-8.6 the registration binds IUserRepository to SqlUserRepository: both fields hold one —
    // FR-6.7 a singleton: one lifeline, its two field names in the tooltip
    expect(d.participants.filter((p) => p.className === 'SqlUserRepository').map((p) => [p.label, p.service, p.heldAs])).toEqual([[':SqlUserRepository', 'singleton', ['_replica', '_primary']]]);
    // UserService (called first) precedes the repositories it uses
    const idx = (name: string) => d.participants.findIndex((p) => p.className === name);
    expect(idx('UserService')).toBeLessThan(idx('SqlUserRepository'));
  }, 120_000);

  it('FR-8 interface calls offer the implementations; choosing one makes it expandable and adds a realization', async () => {
    const s = session();
    await s.openAt(controller, getBody);
    let d = (await s.expandAll())!;
    d = (await s.expandAll())!;
    const poly = d.messages.find((m) => m.methodName === 'FindByIdAsync' && m.polymorphic)!;
    expect(poly.polymorphic!.implementations.map((i) => i.name).sort()).toEqual(['InMemoryUserRepository', 'SqlUserRepository']);
    const sql = poly.polymorphic!.implementations.find((i) => i.name === 'SqlUserRepository')!;
    d = (await s.selectImplementation(poly.id, sql.key))!;
    expect(d.messages.find((m) => m.id === poly.id)!.expandable).toBe(true);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.some((r) => r.kind === 'realization' && r.from === sql.key && r.to.endsWith('#IUserRepository'))).toBe(true);
  }, 120_000);

  it('FR-16.8 C#: each entry point names its project (the solution has several)', async () => {
    const eps = await session().getEntryPoints();
    expect(new Set(eps.map((e) => e.project)).size).toBeGreaterThan(1);
    expect(eps.every((e) => e.project)).toBe(true);
    expect(eps.filter((e) => e.method.key.startsWith('src/Sample.Web/')).every((e) => e.project === 'Sample.Web')).toBe(true);
  }, 120_000);

  it('FR-25.2 C#: a shared state opens the same diagram in a fresh session (overload keys, the DI container step)', async () => {
    const s = session();
    await s.getEntryPoints(); // the sender had the entry points: the container step is drawn
    let d = (await s.openAt(controller, getBody))!;
    d = (await s.expand('container'))!;
    d = (await s.expand(d.messages.find((m) => m.methodName === 'GetUserDtoAsync')!.id))!;
    const sent = d.messages.map((m) => m.id);
    expect(sent).toContain('container');
    const snap = (await s.exportState({ language: 'csharp' }))!;
    expect(snap.root.key).toBe('src/Sample.Web/Controllers/UsersController.cs#UsersController.Get(string)');

    const { diagram, report } = await session().restoreState(snap, { language: 'csharp' });
    expect(diagram!.messages.map((m) => m.id)).toEqual(sent);
    expect(report.missing).toEqual([]);
    expect(report.now).toEqual(report.seen);
  }, 120_000);

  it('FR-4 callers of a service method come from the controllers', async () => {
    const s = session();
    const d = (await s.openAt(controller, getBody))!;
    const call = d.messages.find((m) => m.methodName === 'GetUserDtoAsync')!;
    const callers = await s.getCallers(call.id);
    expect(callers.map((c) => c.enclosing.key)).toContain('src/Sample.Web/Controllers/UsersController.cs#UsersController.Get(string)');
  }, 120_000);
  it('FR-1.10 combined fragments from the sidecar: loop, alt chain, opt, try/catch', async () => {
    const file = `${ROOT}/src/Sample.Core/Services/ImportService.cs`;
    const line = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes('var imported = 0;'));
    const d = (await session().openAt(file, { line, character: 8 }))!;
    expect(d.root.name).toBe('ImportAllAsync');
    expect(d.fragments!.map((f) => `${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}]`).join(' ')}`)).toEqual([
      'loop [each user in users]',
      'alt [user.Name.Length == 0] [user.ManagerId is not null] [else]',
      'opt [announce]',
      'try [] [catch InvalidOperationException when ex.Message.Length > 0]',
    ]);
    expect(d.fragments![1].parentId).toBe(d.fragments![0].id);
  }, 120_000);
  it('FR-1.13 a delegate parameter resolves to the method group the caller passed (two hops down)', async () => {
    const file = `${ROOT}/src/Sample.Core/Services/FormatService.cs`;
    const line = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes('var plain = Render('));
    const s = session();
    const d0 = (await s.openAt(file, { line, character: 8 }))!;
    expect(d0.root.name).toBe('FormatAll');
    const render = d0.messages.find((m) => m.methodName === 'Render')!;
    const d1 = (await s.expand(render.id))!;
    const each = d1.messages.find((m) => m.parentId === render.id && m.methodName === 'Each')!;
    const d2 = (await s.expand(each.id))!;
    const f = d2.messages.find((m) => m.parentId === each.id && m.viaParameter === 'f')!;
    expect(f).toMatchObject({ methodName: 'Plain', methodKey: 'src/Sample.Core/Services/FormatService.cs#UserFormat.Plain(User)', expandable: true });
    expect(d2.participants.find((p) => p.id === f.to)!.className).toBe('UserFormat');
    expect(d2.participants.some((p) => p.className === 'unknown')).toBe(false);
  }, 120_000);
  it('FR-31.1 C#: a method group stored in an options property is no dead code (a value use: reached); one only named by nameof is listed', async () => {
    const result = (await session().findUnreachableCode())!;
    const format = (list: MethodRef[]) => list.map((m) => m.key.split('#')[1]).filter((n) => /^UserFormat\.(Loud|Quiet)\(/.test(n));
    expect(format(result.methods.map((u) => u.method))).toEqual(['UserFormat.Quiet(User)']);
    expect(format(result.missedMethods)).toEqual(['UserFormat.Loud(User)']);
  }, 120_000);

  it('FR-1.11 LINQ lambdas inline in loop frames; a lambda passed to a project method expands where it is invoked', async () => {
    const file = `${ROOT}/src/Sample.Core/Services/SyncService.cs`;
    const line = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes('var names = users.Where('));
    const s = session();
    const d0 = (await s.openAt(file, { line, character: 8 }))!;
    expect(d0.root.name).toBe('SyncAllAsync');
    expect(d0.messages.filter((m) => m.parentId === 'root').map((m) => m.methodName)).toEqual(['Label', 'SaveAsync', 'RunAsync', 'FindByIdAsync', 'Title']);
    expect(d0.fragments!.map((f) => `${f.kind} [${f.operands[0].guard}]`)).toEqual([
      'loop [each u in users.Where(…)]',
      'loop [each u in users]',
      'callback [repo.FindByIdAsync(…).ContinueWith]',
    ]);
    const run = d0.messages.find((m) => m.methodName === 'RunAsync')!;
    const d1 = (await s.expand(run.id))!;
    const action = d1.messages.find((m) => m.parentId === run.id && m.viaParameter === 'action')!;
    expect(action).toMatchObject({ viaLambda: true, expandable: true, to: d0.messages[0].to });
    const d2 = (await s.expand(action.id))!;
    const inner = d2.messages.find((m) => m.parentId === action.id)!;
    expect(inner.methodName).toBe('FindByIdAsync');
    // the same repository lifeline as the direct call in SyncAllAsync
    expect(inner.to).toBe(d0.messages.find((m) => m.parentId === 'root' && m.methodName === 'FindByIdAsync')!.to);
  }, 120_000);

  it('FR-12.15 C#: List<T> and dictionary values are collections of their element', async () => {
    const sql = (await adapter.getClassInfo('src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository'))!;
    expect(sql.fields.find((f) => f.name === '_rows')).toMatchObject({ type: { name: 'User' }, collection: true });
    const mem = (await adapter.getClassInfo('src/Sample.Infrastructure/Repositories/InMemoryUserRepository.cs#InMemoryUserRepository'))!;
    expect(mem.fields.find((f) => f.name === '_users')).toMatchObject({ type: { name: 'User' }, collection: true });
  }, 120_000);

  it('FR-12.12 Uses: a Domain rule using nested enums via `using static` depends on Enums (Application) — a violation; Enums gets a Domain hint', async () => {
    const file = `${ROOT}/src/Sample.Core/Services/ShippingService.cs`;
    const line = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes('provider.ToOrderStatus()'));
    const s = session();
    await s.openAt(file, { line, character: 12 });
    await s.expandAll();
    const Enums = 'src/Sample.Core/Util/Enums.cs#Enums';
    const off = (await s.getClassDiagram())!;
    expect(off.relations.some((r) => r.kind === 'use')).toBe(false);
    // own nested types are no Domain evidence (FR-7.4 fix): no hint without uses
    expect(off.classes.find((c) => c.key === Enums)!.layerHint).toBeUndefined();

    await s.setOption('showTypeUses', true);
    const cd = (await s.getClassDiagram())!;
    const short = (k: string) => k.slice(k.indexOf('#') + 1);
    expect(cd.relations.filter((r) => r.kind === 'use').map((r) => `${short(r.from)}->${short(r.to)}${r.violation ? ' ⚠' : ''}`).sort()).toEqual([
      'OrderPolicy->Enums ⚠',
      'OrderPolicy->Order',
      'ShippingService->Order',
    ]);
    const use = cd.relations.find((r) => r.kind === 'use' && r.to === Enums)!;
    expect(use.violation).toBe('Domain → Application: an inner layer depends on an outer layer');
    expect(use.uses![0]).toMatchObject({ method: 'OrderPolicy.CanShip', range: { file: `${ROOT}/src/Sample.Core/Domain/OrderPolicy.cs` } });
    expect(cd.classes.find((c) => c.name === 'Order')).toMatchObject({ usedOnly: true, layer: 'Domain' });
    // ShippingService → Enums is a call (ToOrderStatus): no extra use
    expect(cd.relations.filter((r) => r.from.endsWith('#ShippingService') && r.to === Enums).map((r) => r.kind)).toEqual(['dependency']);
    expect(cd.classes.find((c) => c.key === Enums)!.layerHint).toEqual({
      suggested: 'Domain',
      // FR-7.7 judged over the whole type; technical code (Util folder) only once Domain uses it
      reasons: ['used by Domain: OrderPolicy', 'pure (whole file): takes no ports, no I/O', 'no project dependencies'],
    });
  }, 120_000);

  it('FR-33 C# hover: the container\'s implementation with its registration, apps that disagree, the routes reaching a method', async () => {
    const s = session();
    const at = (rel: string, needle: string, offset: number) => {
      const text = fs.readFileSync(`${ROOT}/${rel}`, 'utf8');
      const lines = text.slice(0, text.indexOf(needle) + offset).split('\n');
      return [`${ROOT}/${rel}`, { line: lines.length - 1, character: lines[lines.length - 1].length }] as const;
    };
    const opts = (word: string) => ({ word, budgetMs: 60_000 });
    // a primary-constructor parameter bound by both apps to the same class: what runs, where it is registered, its HTTP below
    const charge = (await s.describeAt(...at('src/Sample.Core/Services/BillingService.cs', 'payments.ChargeAsync', 10), opts('ChargeAsync')))!;
    expect(charge.call?.runs).toMatchObject({ method: { owner: { name: 'PaymentApiClient' } }, why: 'container' });
    expect(codeInfoLines(charge, ROOT)).toEqual([expect.stringMatching(/^→ runs PaymentApiClient\.ChargeAsync \(the DI container binds it, src\/Sample\.(Web|Batch)\/Program\.cs:\d+\)$/), '↯ HTTP below']);
    // the web app and the batch app bind IUserRepository differently (the batch app by key): no single answer
    const find = (await s.describeAt(...at('src/Sample.Core/Services/UserService.cs', '_primary.FindByIdAsync', 10), opts('FindByIdAsync')))!;
    expect(find.call?.runs).toBeUndefined();
    expect(find.call?.candidates?.map((c) => c.name).sort()).toEqual(['InMemoryUserRepository', 'SqlUserRepository']);
    expect(find.call?.keyed?.length).toBeGreaterThan(0);
    // on a method's name: the routes and programs its callers lead to
    const reach = (await s.describeAt(...at('src/Sample.Core/Services/UserService.cs', 'FindUserAsync(string', 2), opts('FindUserAsync')))!;
    expect(reach.reach?.entryPoints.map((e) => e.label)).toEqual(expect.arrayContaining(['POST /api/users/{id}/charge', 'GET /api/users/{id}']));
  }, 180_000);

  it('FR-34 C# memory: the sidecar reports its working set and heap; Free Memory stops it and the next request loads the solution again', async () => {
    const s = session();
    await s.openAt(controller, getBody);
    const { analysis } = await s.processMemory();
    expect(analysis!.workingSet).toBeGreaterThan(analysis!.managedHeap!);
    expect(analysis!.managedHeap).toBeGreaterThan(0);
    await s.freeMemory();
    expect(await s.processMemory()).toEqual({});
    expect((await s.openAt(controller, getBody))?.root.name).toBe('Get');
    expect((await s.processMemory()).analysis?.pid).not.toBe(analysis!.pid);
  }, 180_000);
});

describe.skipIf(!available)('C# sidecar: missing SDK for the solution\'s global.json', () => {
  it('initialize fails with a clear reason (file, required and installed SDKs, how to install) instead of an MSBuild load error', async () => {
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-pinned-'));
    try {
      fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[\\/](bin|obj)$/.test(src) });
      fs.writeFileSync(path.join(dir, 'global.json'), '{ "sdk": { "version": "99.0.100", "rollForward": "disable" } }\n');
      const pinned = createCSharpAdapter(dir.replace(/\\/g, '/'));
      try {
        const err = await pinned.getMethod('x#Y.z()').then(() => undefined, (e: unknown) => String(e));
        expect(err).toMatch(/global\.json requires \.NET SDK 99\.0\.100 \(rollForward: disable\), which is not installed \(installed SDKs: \d/);
        expect(err).toContain('dotnet-install.sh --version 99.0.100');
        expect(err).not.toContain('Microsoft.Build.Framework');
      } finally {
        await pinned.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
