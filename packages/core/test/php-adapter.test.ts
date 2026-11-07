import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { createClassifier } from '../src/classifier-impl';
import { createAdapter, isAnalysedFile, languageOfFile } from '../src/languages';
import { PhpAdapter } from '../src/php/php-adapter';
import { DEFAULT_OPTIONS, DiagramSession } from '../src/session';

const ROOT = path.resolve(__dirname, '../../../fixtures/php-app').replace(/\\/g, '/');
const adapter = new PhpAdapter(ROOT);
afterAll(() => adapter.dispose());

const SERVICE = 'src/Services/OrderService.php#OrderService';
const method = async (key: string) => (await adapter.getMethod(key))!;
const calls = async (key: string) => adapter.getOutgoingCalls(await method(key));
// FR-3.12 the frames and catches as the code has them: ↯ Fold errors off
const session = () => new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
const msg = (d: SequenceDiagram, name: string) => d.messages.find((m) => m.methodName === name)!;

describe('FR-18 PHP adapter', () => {
  it('FR-18.1 PHP files are a language of their own; the project root is the nearest composer.json', () => {
    expect(languageOfFile('/x/src/A.php')).toBe('php');
    expect(isAnalysedFile('/x/src/A.php')).toBe(true);
    expect(isAnalysedFile('/x/vendor/laravel/framework/src/A.php')).toBe(false);
    expect(isAnalysedFile('/x/resources/views/a.blade.php')).toBe(false);
    expect(createAdapter('php', ROOT)).toBeInstanceOf(PhpAdapter);
  });

  it('FR-18.1 the method at the cursor, stable keys, constructors as "constructor"', async () => {
    const m = (await adapter.findEnclosingCallable(`${ROOT}/src/Services/OrderService.php`, { line: 29, character: 10 }))!;
    expect(m).toMatchObject({ key: `${SERVICE}.placeOrder`, name: 'placeOrder', hasBody: true, owner: { key: SERVICE, name: 'OrderService', kind: 'class' } });
    expect((await method('src/Domain/Order.php#Order.constructor')).name).toBe('constructor');
    expect((await method('src/Repositories/OrderRepositoryContract.php#OrderRepositoryContract.findUser')).hasBody).toBe(false);
    expect((await method('src/Support/helpers.php#<module>.money_format')).owner.kind).toBe('module');
  });

  it('FR-18.2 calls in evaluation order: receivers, targets, results, return types, library calls', async () => {
    const cs = await calls(`${SERVICE}.placeOrder`);
    const find = (name: string) => cs.find((c) => c.methodName === name)!;
    expect(find('findUser')).toMatchObject({
      receiver: { kind: 'field', name: 'repository' },
      target: { key: 'src/Repositories/OrderRepositoryContract.php#OrderRepositoryContract.findUser', hasBody: false },
      result: { kind: 'assign', target: '$user', operator: '=' },
      returnType: '?array',
      isLibrary: false,
    });
    expect(find('priceOf')).toMatchObject({ receiver: { kind: 'static' }, target: { key: 'src/Domain/Pricing.php#Pricing.priceOf', isStatic: true } });
    // facades and built-ins are library calls, by fully qualified name (no vendor/ needed)
    expect(find('info')).toMatchObject({ isLibrary: true, libraryName: 'Illuminate\\Support', target: { key: 'lib:Illuminate\\Support\\Facades\\Log#Log.info' } });
    expect(find('getMessage')).toMatchObject({ receiver: { kind: 'local', name: 'e' }, isLibrary: true }); // catch (PaymentFailed $e) → RuntimeException
    const create = cs.find((c) => c.kind === 'create' && c.receiverType?.name === 'Order')!;
    expect(create).toMatchObject({ methodName: 'constructor', assignedTo: { kind: 'local', name: 'order' }, target: { key: 'src/Domain/Order.php#Order.constructor' } });
    expect(find('save').result).toEqual({ kind: 'return' });
    // receiver and arguments before the call
    expect(cs.findIndex((c) => c.methodName === 'withStatus')).toBeLessThan(cs.findIndex((c) => c.methodName === 'save'));
    expect(find('charge').argOrigins).toEqual([{ kind: 'parameter', name: 'userId' }, { kind: 'local', name: 'total' }]);
  });

  it('FR-18.2 PHP enum built-ins and calls on library results are library calls, not unknown', async () => {
    const cs = await calls(`${SERVICE}.placeOrder`);
    expect(cs.find((c) => c.methodName === 'from')).toMatchObject({ isLibrary: true, receiverType: { name: 'OrderStatus' } });
    const stripe = await calls('src/Payments/StripeGateway.php#StripeGateway.charge');
    // Http::withToken(…)->post(…): post on the facade's result
    expect(stripe.find((c) => c.methodName === 'post')).toMatchObject({ isLibrary: true, target: { key: 'lib:Illuminate\\Support\\Facades\\Http#Http.post' } });
    expect(stripe.find((c) => c.methodName === 'failed')?.isLibrary).toBe(true);
  });

  it('FR-18.3 implementations of interface and abstract methods (tests excluded); class info', async () => {
    const impls = await adapter.getImplementations(await method('src/Repositories/OrderRepositoryContract.php#OrderRepositoryContract.findUser'));
    expect(impls.map((i) => i.owner.name)).toEqual(['EloquentOrderRepository', 'InMemoryOrderRepository']);
    const channel = await adapter.getImplementations(await method('src/Notifications/BaseNotifier.php#BaseNotifier.channel'));
    expect(channel.map((i) => i.key)).toEqual(['src/Notifications/EmailNotifier.php#EmailNotifier.channel']);
    const info = (await adapter.getClassInfo(SERVICE))!;
    expect(info.fields.map((f) => [f.name, f.type?.name, f.injected])).toEqual([
      ['repository', 'OrderRepositoryContract', true],
      ['payments', 'PaymentGateway', true],
      ['notifier', 'EmailNotifier', true],
    ]);
    expect(info.methods.map((m) => m.name)).toEqual(['constructor', 'placeOrder', 'retryCharge']);
    expect((await adapter.getClassInfo('src/Domain/Pricing.php#Pricing'))!.allMembersStatic).toBe(true);
  });

  it('FR-12.18 private and protected methods are marked (hidden in the class box until shown)', async () => {
    const pricing = (await adapter.getClassInfo('src/Domain/Pricing.php#Pricing'))!;
    expect(pricing.methods.find((m) => m.name === 'unitPrice')?.visibility).toBe('private');
    const client = (await adapter.getClassInfo('src/Clients/RequestClient.php#RequestClient'))!;
    expect(client.methods.find((m) => m.name === 'handle')?.visibility).toBe('protected');
    expect((await adapter.getClassInfo(SERVICE))!.methods.find((m) => m.name === 'placeOrder')?.visibility).toBeUndefined();
  });

  it('FR-18.4 fragments (if/elseif/else, foreach, try/catch, closures passed to library calls) and early exits', async () => {
    const cs = await calls(`${SERVICE}.placeOrder`);
    const scopes = (name: string) => cs.find((c) => c.methodName === name)!.fragments?.map((f) => `${f.kind}:${f.operand}:${f.guard ?? ''}`);
    expect(scopes('priceOf')).toEqual(['loop:0:each $item of $items']);
    expect(scopes('notify')).toEqual(['alt:0:$total > 100']);
    expect(scopes('empty')).toEqual(['alt:1:$total === 0']);
    expect(scopes('info')).toEqual(['alt:2:else']);
    expect(scopes('charge')).toEqual(['try:0:']);
    expect(scopes('error')).toEqual(['try:1:catch PaymentFailed']);
    // FR-1.17 the clause logs and rethrows
    expect(cs.find((c) => c.methodName === 'charge')!.fragments![0].handlers).toEqual([expect.objectContaining({ operand: 1, guard: 'catch PaymentFailed', outcome: 'rethrow', logged: true })]);
    // collect($items)->each(fn ($item) => …): the arrow function's call runs per element
    expect(scopes('reserve')).toEqual(['loop:0:each $item of collect(…)']);
    const exits = await adapter.getEarlyExits!(await method(`${SERVICE}.placeOrder`));
    expect(exits.map((e) => `${e.kind}:${e.exception ?? ''}`)).toEqual(['throw:InvalidArgumentException', 'return:', 'throw:$e']);
    // FR-3.9 a return says what it returns, a throw has no value
    expect(exits.map((e) => e.value)).toEqual([undefined, 'Order::empty()', undefined]);
  });

  it('FR-1.17 a catch that only logs: the try is drawn with a "logged, swallowed" row', async () => {
    const d = (await session().openMethodByKey(`${SERVICE}.retryCharge`))!;
    const t = d.fragments!.find((f) => f.kind === 'try')!;
    expect(t.operands).toHaveLength(1);
    expect(t.catches).toEqual([expect.objectContaining({ guard: 'catch PaymentFailed', outcome: 'logged, swallowed', swallowed: true })]);
  });

  it('FR-18.5 callers: through the interface too, test callers marked', async () => {
    const callers = await adapter.getCallers(await method(`${SERVICE}.placeOrder`));
    expect(callers.map((c) => [c.enclosing.key, !!c.inTest])).toEqual([
      ['src/Http/Controllers/OrderController.php#OrderController.store', false],
      ['tests/OrderServiceTest.php#OrderServiceTest.test_places_an_order', true],
    ]);
    const viaInterface = await adapter.getCallers(await method('src/Repositories/InMemoryOrderRepository.php#InMemoryOrderRepository.findUser'));
    expect(viaInterface.map((c) => c.enclosing.name).sort()).toEqual(['placeOrder', 'test_places_an_order']);
  });

  it('FR-18.6 in the diagram: implementation choice, the sender\'s own implementation for $this->abstract(), I/O badges', async () => {
    const s = session();
    let d = (await s.openMethodByKey(`${SERVICE}.placeOrder`))!;
    expect(msg(d, 'findUser').polymorphic?.implementations.map((i) => i.name)).toEqual(['EloquentOrderRepository', 'InMemoryOrderRepository']);
    expect(msg(d, 'charge')).toMatchObject({ polymorphic: { selectedKey: 'src/Payments/StripeGateway.php#StripeGateway' }, sideEffects: { kinds: ['http'] } });
    d = (await s.expand(msg(d, 'notify').id))!;
    // $this->channel() in BaseNotifier, the object is an EmailNotifier: its implementation, no choice to make
    expect(msg(d, 'channel').polymorphic?.selectedKey).toBe('src/Notifications/EmailNotifier.php#EmailNotifier');
    d = (await s.selectImplementation(msg(d, 'findUser').id, 'src/Repositories/EloquentOrderRepository.php#EloquentOrderRepository'))!;
    expect(msg(d, 'findUser').sideEffects?.kinds).toEqual(['db']);
    expect(d.participants.find((p) => p.className === 'EloquentOrderRepository')?.sideEffects?.kinds).toEqual(['db']);
  });

  it('FR-18.7 entry points: routes with provider mounts and nested groups, commands, jobs, listeners, PHPUnit tests', async () => {
    const eps = await adapter.getEntryPoints!();
    const of = (kind: string) => eps.filter((e) => e.kind === kind).map((e) => `${e.label} → ${e.method.owner.name}.${e.method.name}`).sort();
    expect(of('http')).toEqual([
      'GET /api/admin/refresh → StatsController.refresh', // Route::match(['get', 'post'], …)
      'GET /api/admin/stats/{day} → StatsController.show', // group prefix + namespace, mounted under /api with App\Http\Controllers
      'GET /api/billing/status → WebhookController.status', // FR-18.11 a package registering its own routes
      'GET /api/products → ProductController.index', // apiResource: only the actions the controller has
      'GET /api/products/{id} → ProductController.show',
      'GET /api/refunds/{id} → RefundController.show', // ['uses' => '\\App\\…@show']
      'POST /api/admin/refresh → StatsController.refresh',
      'POST /api/billing/webhook → WebhookController.receive',
      'POST /api/orders → OrderController.store', // [Controller::class, 'method']
      'POST /api/promo/v3/codes/{code}/apply → CodesController.apply', // FR-18.11 a package mounted by the project
      'POST /api/refunds → RefundController.store', // registered in a provider method
      'POST /api/refunds/{id}/retry → RefundController.retry',
    ]);
    expect(of('cli')).toEqual(['orders:expire → ExpireOrders.handle']);
    expect(of('job')).toEqual(['SendReceipt.handle → SendReceipt.handle']);
    expect(of('handler')).toEqual(['LogPlacedOrder.handle → LogPlacedOrder.handle']);
    expect(of('test')).toEqual(['OrderServiceTest.it_rejects_unknown_users → OrderServiceTest.it_rejects_unknown_users', 'OrderServiceTest.test_places_an_order → OrderServiceTest.test_places_an_order']);
    // closures and name-only routes have no method; a route to a missing controller is reported as missing
    const { PhpModel } = await import('../src/php/model');
    const { PhpProject } = await import('../src/php/project');
    const { phpEntryPoints } = await import('../src/php/entry-points');
    const missing: string[] = [];
    await phpEntryPoints(new PhpModel(new PhpProject(ROOT)), () => false, (m) => missing.push(`${m.route} ${m.controller}@${m.method}`));
    expect(missing).toEqual(['GET /api/gone App\\Http\\Controllers\\MissingController@index']);
  });

  it('FR-18.8 Eloquent: relation properties give the related model; a model without its own constructor is still created', async () => {
    const cs = await calls('src/Models/Customer.php#Customer.reward');
    // $account = $this->account (hasOne(Account::class)); $account->credit(…) is the project method
    expect(cs.find((c) => c.methodName === 'credit')).toMatchObject({ isLibrary: false, target: { key: 'src/Models/Account.php#Account.credit' } });
    expect(cs.find((c) => c.kind === 'create')).toMatchObject({ target: { key: 'src/Models/Note.php#Note.constructor', hasBody: false }, receiverType: { name: 'Note' } });
    expect(cs.find((c) => c.methodName === 'save')).toMatchObject({ isLibrary: true, target: { key: 'lib:Illuminate\\Database\\Eloquent\\Model#Model.save' } });
    const d = (await session().openMethodByKey('src/Models/Customer.php#Customer.reward'))!;
    expect(d.participants.map((p) => p.className)).toEqual(expect.arrayContaining(['Customer', 'Account', 'Note']));
    expect(d.participants.some((p) => p.kind === 'unknown')).toBe(false);
  });

  it('FR-18.9 first-party packages (the project\'s own Composer vendor) are project code, loaded on demand from vendor/', async () => {
    const cs = await calls('src/Services/BillingService.php#BillingService.bill');
    const find = (name: string) => cs.find((c) => c.methodName === name)!;
    // seqcall/billing is first-party (the project is seqcall/php-app): analysed, expandable
    expect(find('invoice')).toMatchObject({ isLibrary: false, target: { key: 'vendor/seqcall/billing/src/BillingClient.php#BillingClient.invoice', hasBody: true }, receiverType: { name: 'BillingClient' } });
    // acme/mailer is third-party: a library call
    expect(find('send')).toMatchObject({ isLibrary: true, target: { key: 'lib:Acme\\Mailer\\Mailer#Mailer.send' } });
    // the package's interface: implementations are searched in the whole package
    const record = find('record').target!;
    expect((await adapter.getImplementations(record)).map((i) => i.key)).toEqual(['vendor/seqcall/billing/src/DbLedger.php#DbLedger.record']);
    // a package method is analysed like project code (its own I/O, its creations)
    const inner = await adapter.getOutgoingCalls(find('invoice').target!);
    expect(inner.map((c) => `${c.methodName}:${c.isLibrary}`)).toEqual(['post:true', 'constructor:false']);
    // callers of a package method: the project's and the package's own (FR-4.1)
    const callers = await adapter.getCallers(find('invoice').target!);
    expect(callers.map((c) => c.enclosing.key).sort()).toEqual(['src/Services/BillingService.php#BillingService.bill', 'vendor/seqcall/billing/src/Http/WebhookController.php#WebhookController.receive']);
    // entry points stay within the project's own files — except the routes packages register (FR-18.11)
    expect((await adapter.getEntryPoints!()).filter((e) => e.method.key.startsWith('vendor/')).every((e) => e.kind === 'http')).toBe(true);
  });

  it('FR-5.4 (new X())->m(): the message goes to the object just created; two creations are two objects', async () => {
    const d = (await session().openMethodByKey('src/Services/BillingService.php#BillingService.quote'))!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    const calls = d.messages.filter((m) => m.kind === 'call' && m.className === 'Order');
    expect(creates.length).toBe(2);
    // each call goes to the object its own `new` created: two objects, no third «expression» object
    expect(calls.map((c) => c.to)).toEqual(creates.map((c) => c.to));
    expect(new Set(creates.map((c) => c.to)).size).toBe(2);
    expect(d.participants.filter((p) => p.className === 'Order').length).toBe(2);
  });

  it('FR-5.4 also one level down: each call goes to the object created next to it, not to the other one', async () => {
    const s = session();
    await s.openMethodByKey('src/Services/BillingService.php#BillingService.quoteAll');
    const d = (await s.expandAll())!;
    const creates = d.messages.filter((m) => m.kind === 'create');
    const calls = d.messages.filter((m) => m.kind === 'call' && m.className === 'Order');
    expect(creates.length).toBe(2);
    expect(creates[0].parentId).not.toBe('root');
    expect(calls.map((c) => c.to)).toEqual(creates.map((c) => c.to));
    expect(new Set(creates.map((c) => c.to)).size).toBe(2);
  });

  it('FR-8.6 Laravel container bindings decide the implementation: contextual for the consumer, else global; a bound subclass runs its own override', async () => {
    const bindings = await adapter.getBindings!();
    const short = (k?: string) => k?.replace(/^.*#/, '');
    expect(bindings.map((b) => `${short(b.consumer) ?? '*'} ${short(b.abstract)} → ${short(b.concrete)}`)).toEqual([
      '* RequestClientContract → RequestClient',
      '* PaymentGateway → StripeGateway',
      'QuoteService RequestClientContract → RetryingRequestClient',
    ]);
    expect(bindings[2].range.start.line).toBe(19); // 0-based: line 20 of the provider
    // FR-6.7 bind makes a new object each time, singleton one; a contextual give says nothing
    expect(bindings.map((b) => b.lifetime)).toEqual(['transient', 'singleton', undefined]);
    // QuoteService gets the retrying client (it inherits send(), overrides handle())
    const s = session();
    await s.openMethodByKey('src/Services/QuoteService.php#QuoteService.quote');
    let d = (await s.expandAll())!;
    const send = d.messages.find((m) => m.methodName === 'send')!;
    expect(d.participants.find((p) => p.id === send.to)?.className).toBe('RetryingRequestClient');
    expect(send.polymorphic).toMatchObject({ selectedKey: 'src/Clients/RetryingRequestClient.php#RetryingRequestClient', bound: { classKey: 'src/Clients/RetryingRequestClient.php#RetryingRequestClient', contextual: true } });
    d = (await s.expandAll())!;
    // the bound subclass uses its parent's injected field: still reached through an abstraction («seam»)
    const token = d.messages.find((m) => m.parentId === send.id && m.methodName === 'token')!;
    expect(d.participants.find((p) => p.id === token.to)?.stereotypes).toContain('seam');
    const handle = d.messages.find((m) => m.parentId === send.id && m.methodName === 'handle')!;
    expect(d.messages.filter((m) => m.parentId === handle.id).map((m) => `${m.methodName}:${m.kind}`)).toEqual(['handle:self']); // parent::handle()
    // ReportService: the global binding
    const r = session();
    await r.openMethodByKey('src/Services/ReportService.php#ReportService.report');
    const rd = (await r.expandAll())!;
    const rsend = rd.messages.find((m) => m.methodName === 'send')!;
    expect(rd.participants.find((p) => p.id === rsend.to)?.className).toBe('RequestClient');
    expect(rsend.polymorphic?.bound).toMatchObject({ contextual: false });
  });

  it('FR-8.7 an entry point starts with the container building its object graph: collapsed, then dependencies before consumers, bound implementations, the same objects the flow uses', async () => {
    // the field each object goes to is the call's result (Results is off by default)
    const s = new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { ...DEFAULT_OPTIONS, showResults: true, foldErrors: false } } });
    await s.getEntryPoints();
    let d = (await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store'))!;
    expect(d.messages[0]).toMatchObject({ id: 'container', kind: 'found', methodName: 'resolve', args: ['OrderController::class'], expandable: true, expanded: false });
    expect(d.messages[1].id).toBe('middleware'); // FR-18.14 then the route's middleware (the `api` group of routes/api.php)
    expect(d.messages[2].id).toBe('root');
    expect(d.participants[0].className).toBe('Container'); // first, left of the controller
    // FR-3.3 Expand all leaves the container step alone and does not count it as "still folded" (no strip)
    const every = (await s.expandEverything())!;
    expect(every.messages.find((m) => m.id === 'container')).toMatchObject({ expanded: false });
    expect(every.expandNotice).toBeUndefined();
    // FR-11 the step hides like any call (by its method name), and comes back with the filter
    const hidden = (await s.hide({ kind: 'methodName', methodName: 'resolve' }))!;
    expect(hidden.messages.some((m) => m.id === 'container')).toBe(false);
    expect(hidden.hiddenFilters.map((h) => [h.filter.id, h.hiddenCount])).toEqual([['methodName:resolve', 1]]);
    d = (await s.unhide('methodName:resolve'))!;
    expect(d.messages[0].id).toBe('container');
    d = (await s.expand('container'))!;
    const name = (id: string) => d.participants.find((p) => p.id === id)!.className;
    const creates = d.messages.filter((m) => m.parentId === 'container');
    // EmailNotifier (a class), PaymentGateway → StripeGateway (bound), OrderRepositoryContract (unbound: skipped)
    expect(creates.map((m) => `${(m.result as { target?: string } | undefined)?.target ?? ''}=${name(m.to)}`)).toEqual(['payments=StripeGateway', 'notifier=EmailNotifier', 'orders=OrderService', '=OrderController']);
    expect(creates[0].callSite?.file).toMatch(/AppServiceProvider\.php$/); // opens the binding
    expect(creates.at(-1)!.to).toBe(d.messages.find((m) => m.id === 'root')!.to); // the controller is the root object
    // the flow's OrderService is the object the container built
    d = s.current()!;
    const place = d.messages.find((m) => m.parentId === 'root' && m.methodName === 'placeOrder')!;
    expect(d.participants.find((p) => p.id === place.to)?.createdByMessageId).toBe(creates[2].id);
    // not an entry point: no container step
    const plain = (await session().openMethodByKey(`${SERVICE}.placeOrder`))!;
    expect(plain.messages[0].id).toBe('root');
  });

  it('FR-8.7 / FR-11 hiding the container (its class or its method) hides the container step', async () => {
    for (const spec of [
      { kind: 'class' as const, classKey: 'lib:Illuminate\\Container\\Container', className: 'Container' },
      { kind: 'methodName' as const, methodName: 'resolve' },
    ]) {
      const s = session();
      await s.getEntryPoints();
      await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store');
      const d = (await s.hide(spec))!;
      expect(d.messages.filter((m) => m.depth === 0).map((m) => m.id)).toEqual(['middleware', 'root']); // FR-18.14 the route's pipeline stays
      expect(d.participants.map((p) => p.className)).not.toContain('Container');
      expect(d.hiddenFilters?.[0].hiddenCount).toBe(1);
    }
  });

  it('FR-18.14 / FR-11 hiding the pipeline (its class or its method) hides the pipeline step', async () => {
    for (const spec of [
      { kind: 'class' as const, classKey: 'lib:Illuminate\\Pipeline\\Pipeline', className: 'Pipeline' },
      { kind: 'methodName' as const, methodName: 'through' },
    ]) {
      const s = session();
      await s.getEntryPoints();
      await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store');
      const d = (await s.hide(spec))!;
      expect(d.messages.filter((m) => m.depth === 0).map((m) => m.id)).toEqual(['container', 'root']);
      expect(d.participants.map((p) => p.className)).not.toContain('Pipeline');
      expect(d.hiddenFilters?.[0].hiddenCount).toBe(1);
    }
  });

  const REFUNDS = 'src/Http/Controllers/RefundController.php#RefundController';
  const MW = 'App\\Http\\Middleware';

  it('FR-18.14 a route carries its middleware in execution order: groups first, then its own (after and before the verb, the action key); helpers and Class:params evaluated; withoutMiddleware and duplicates dropped', async () => {
    const eps = await adapter.getEntryPoints!();
    const mw = (label: string) => eps.find((e) => e.label === label)!.middleware?.map((m) => `${m.name} [${m.source}]${m.method ? ` → ${m.method.key}` : ''}`);
    // ->middleware([self::feature('403'), VerifySignature::class, 'auth', 'auth'])->withoutMiddleware('auth') in a group with 'api'
    expect(mw('POST /api/refunds')).toEqual([
      'api [group]',
      `${MW}\\RequireFeature:refunds,403 [route] → src/Http/Middleware/RequireFeature.php#RequireFeature.handle`,
      `${MW}\\VerifySignature [route] → src/Http/Middleware/VerifySignature.php#VerifySignature.handle`,
    ]);
    expect(eps.find((e) => e.label === 'POST /api/refunds')!.middleware![1]).toMatchObject({ className: `${MW}\\RequireFeature`, params: ['refunds', '403'], at: { file: expect.stringMatching(/RouteServiceProvider\.php$/) } });
    expect(mw('POST /api/refunds/{id}/retry')).toEqual(['api [group]', 'throttle:10,1 [route]']); // Route::middleware(…)->post(…)
    expect(eps.find((e) => e.label === 'POST /api/refunds/{id}/retry')!.middleware![1]).toMatchObject({ params: ['10', '1'] });
    expect(eps.find((e) => e.label === 'POST /api/refunds/{id}/retry')!.middleware![1].className).toBeUndefined(); // an alias (Kernel aliases are not resolved yet)
    expect(mw('GET /api/refunds/{id}')).toEqual(['api [group]', 'cache.headers:max_age=60 [route]']); // ['middleware' => …]
    expect(mw('GET /api/admin/stats/{day}')).toEqual(['api [group]', 'auth [route]']); // the route file's mount, then the route
    expect(mw('POST /api/billing/webhook')).toBeUndefined(); // a package's own route without middleware
  });

  it('FR-18.14 before the action, one collapsed row through the middleware; opened: a handle per middleware, its body, `next ⇒` the next step (not expandable), early returns', async () => {
    const s = session();
    const entry = (await s.getEntryPoints()).find((e) => e.label === 'POST /api/refunds')!;
    let d = (await s.openMethodByKey(`${REFUNDS}.store`, entry))!;
    expect(d.messages.map((m) => m.id).slice(0, 2)).toEqual(['middleware', 'root']); // RefundController has no dependencies: no container step
    expect(d.messages[0]).toMatchObject({ kind: 'found', from: null, methodName: 'through', className: 'Pipeline', args: ['api', 'RequireFeature', 'VerifySignature'], expandable: true, expanded: false });
    expect(d.participants[0].className).toBe('Pipeline');
    d = (await s.expand('middleware'))!;
    const handles = d.messages.filter((m) => m.parentId === 'middleware');
    expect(handles.map((m) => `${m.id} ${m.methodName}(${m.args.join(', ')}) ${m.expandable ? '+' : '-'}`)).toEqual([
      'middleware/0:handle handle($request, $next) -', // an alias: a name, nothing to open
      'middleware/1:handle handle($request, $next, refunds, 403) +',
      'middleware/2:handle handle($request, $next) +',
    ]);
    // left to right in the order the request passes them, before the controller
    const order = d.participants.map((p) => p.className);
    expect(order.slice(0, 4)).toEqual(['Pipeline', 'api', 'RequireFeature', 'VerifySignature']);
    expect(order.indexOf('RefundController')).toBeGreaterThan(3);
    d = (await s.expand('middleware/1:handle'))!;
    d = (await s.expand('middleware/2:handle'))!;
    const next = d.messages.filter((m) => m.viaParameter === 'next');
    const pid = (name: string) => d.participants.find((p) => p.className === name)!.id;
    expect(next.map((m) => `${m.parentId} → ${d.participants.find((p) => p.id === m.to)!.className}.${m.methodName}`)).toEqual([
      'middleware/1:handle → VerifySignature.handle', // the next middleware
      'middleware/2:handle → RefundController.store', // after the last one: the action
    ]);
    expect(next.every((m) => m.continuesPipeline && !m.expandable)).toBe(true);
    expect(next[0].to).toBe(pid('VerifySignature'));
    expect(next[1].to).toBe(d.messages.find((m) => m.id === 'root')!.to);
    expect(d.messages.find((m) => m.parentId === 'middleware/1:handle' && m.methodName === 'enabled')).toBeDefined(); // its own body
    expect(d.exits?.map((x) => x.ownerMessageId)).toEqual(expect.arrayContaining(['middleware/1:handle', 'middleware/2:handle'])); // FR-1.15 the early returns
  });

  it('FR-18.14 Expand all / Smart leave the step as it is, a scoped expand opens it; ids survive refresh; off by View option or config; none for a plain method', async () => {
    const s = session();
    const entry = (await s.getEntryPoints()).find((e) => e.label === 'POST /api/refunds')!;
    await s.openMethodByKey(`${REFUNDS}.store`, entry);
    let d = (await s.expandAll())!;
    expect(d.messages.find((m) => m.id === 'middleware')!.expanded).toBe(false);
    d = (await s.smartExpand())!;
    expect(d.messages.find((m) => m.id === 'middleware')!.expanded).toBe(false);
    await s.expand('middleware');
    d = (await s.expandEverything())!;
    expect(d.messages.find((m) => m.id === 'middleware/1:handle')!.expanded).toBe(false); // the flow only
    d = (await s.expandEverything('middleware/1:handle'))!;
    expect(d.messages.find((m) => m.id === 'middleware/1:handle')!.expanded).toBe(true);
    d = (await s.refresh())!;
    expect(d.messages.find((m) => m.id === 'middleware/1:handle')!.expanded).toBe(true);
    d = (await s.setOption('showPipeline', false))!; // View ▾ → Pipeline off
    expect(d.messages.some((m) => m.id.startsWith('middleware'))).toBe(false);
    const classifier = createClassifier(ROOT);
    classifier.pipelineConfig = () => ({ route: false });
    expect((await new DiagramSession({ adapter, classifier }).openMethodByKey(`${REFUNDS}.store`, entry))!.messages[0].id).toBe('root'); // pipeline.route: false
    // each source its switch: global off unless asked for, controller on unless turned off
    const steps = async (config: { route?: boolean; controller?: boolean; global?: boolean }) => {
      classifier.pipelineConfig = () => config;
      const mixed = { ...entry, middleware: [{ ...entry.middleware![0], source: 'global' as const }, { ...entry.middleware![0], source: 'controller' as const }] };
      const s2 = new DiagramSession({ adapter, classifier });
      await s2.openMethodByKey(`${REFUNDS}.store`, mixed);
      return (await s2.expand('middleware'))?.messages.filter((m) => m.parentId === 'middleware').length ?? 0;
    };
    expect([await steps({}), await steps({ global: true }), await steps({ controller: false }), await steps({ global: true, controller: false })]).toEqual([1, 2, 0, 1]);
    expect((await session().openMethodByKey('src/Http/Middleware/RequireFeature.php#RequireFeature.handle'))!.messages[0].id).toBe('root'); // a handle opened by itself
  });

  it('FR-5.6 objects created in mutually exclusive places share a lifeline (early returns, branches); objects that coexist do not', async () => {
    const orders = (d: SequenceDiagram) => d.participants.filter((p) => p.className === 'Order');
    let d = (await session().openMethodByKey('src/Services/QuoteService.php#QuoteService.draft'))!;
    // the two early returns and $order (after both) never coexist; $copy lives next to $order
    expect(orders(d).map((p) => p.alternatives ?? 1)).toEqual([3, 1]);
    const creates = d.messages.filter((m) => m.kind === 'create');
    expect(creates.map((m) => m.alternative ? `${m.alternative.index}/${m.alternative.count} ${m.alternative.why}` : '-')).toEqual(['1/3 return', '2/3 return', '3/3 return', '-']);
    expect(new Set(creates.slice(0, 3).map((m) => m.to)).size).toBe(1);
    expect(creates[3].to).not.toBe(creates[0].to);
    d = (await session().openMethodByKey('src/Services/QuoteService.php#QuoteService.pick'))!;
    expect(orders(d)).toHaveLength(1);
    expect(orders(d)[0].alternatives).toBe(2);
    expect(d.messages.filter((m) => m.kind === 'create').map((m) => m.alternative?.why)).toEqual(['branch', 'branch']);
  });

  it('FR-5.6 the try block\'s last creation and the catches\' share a lifeline; not when the try block goes on after it', async () => {
    const orders = (d: SequenceDiagram) => d.participants.filter((p) => p.className === 'Order');
    let d = (await session().openMethodByKey('src/Services/QuoteService.php#QuoteService.load'))!;
    expect(d.fragments?.find((f) => f.kind === 'try')?.operands).toHaveLength(3);
    expect(orders(d).map((p) => p.alternatives ?? 1)).toEqual([3]);
    expect(d.messages.filter((m) => m.kind === 'create').map((m) => `${m.alternative?.index}/${m.alternative?.count}`)).toEqual(['1/3', '2/3', '3/3']);
    d = (await session().openMethodByKey('src/Services/QuoteService.php#QuoteService.loadAndQuote'))!;
    expect(orders(d).map((p) => p.alternatives ?? 1)).toEqual([1, 1]);
  });

  it('FR-5.7 the object a call returns is the caller\'s object; not when a return is invisible (a variable)', async () => {
    const s = session();
    await s.openMethodByKey('src/Services/QuoteService.php#QuoteService.confirm');
    let d = (await s.expandAll())!;
    const make = d.messages.find((m) => m.methodName === 'make')!;
    const created = d.messages.filter((m) => m.parentId === make.id && m.kind === 'create');
    expect(new Set(created.map((m) => m.to)).size).toBe(1); // FR-5.6: one lifeline for both returns
    const toArray = d.messages.find((m) => m.methodName === 'toArray')!;
    expect(toArray.to).toBe(created[0].to);
    expect(d.participants.filter((p) => p.className === 'Order')).toHaveLength(1);
    // makeOrReuse may return $existing: $order stays its own participant
    const r = session();
    await r.openMethodByKey('src/Services/QuoteService.php#QuoteService.confirmReuse');
    d = (await r.expandAll())!;
    const fresh = d.messages.find((m) => m.parentId?.endsWith('makeOrReuse') && m.kind === 'create')!;
    expect(d.messages.find((m) => m.methodName === 'toArray')!.to).not.toBe(fresh.to);
  });

  it('FR-5.8 an array returned with a local variable, destructured by the caller and passed on, is the created object', async () => {
    const s = session();
    await s.openMethodByKey('src/Services/QuoteService.php#QuoteService.join');
    const d = (await s.expandAll())!;
    const created = d.messages.find((m) => m.kind === 'create' && m.className === 'Order')!;
    expect(d.participants.filter((p) => p.className === 'Order')).toHaveLength(1);
    expect(d.messages.filter((m) => m.methodName === 'toArray').map((m) => m.to)).toEqual([created.to]); // in audit(Order $order)
  });

  it('FR-18.10 calls on library classes keep the type their declarations give (static / $this through traits and bases, not @template); a variable keeps the type of its last typed assignment', async () => {
    const cs = await calls('src/Services/BillingService.php#BillingService.notify');
    const find = (name: string) => cs.find((c) => c.methodName === name)!;
    // `->to()` (`@return static` on the base class) and `->cc()` (`@return $this` in a trait) stay Envelope
    expect(find('cc')).toMatchObject({ isLibrary: true, target: { key: 'lib:Acme\\Mailer\\Envelope#Envelope.cc' } });
    // else-branch `->first()` returns `TValue|null` (a template, not a class): `$envelope` keeps the if-branch type
    expect(find('build')).toMatchObject({ isLibrary: true, target: { key: 'lib:Acme\\Mailer\\Envelope#Envelope.build' }, receiver: { kind: 'local', name: 'envelope' } });
    // the declared return type of a library method types the next call
    expect(find('deliver')).toMatchObject({ isLibrary: true, target: { key: 'lib:Acme\\Mailer\\Message#Message.deliver' } });
    // library declarations are read for types only: never project classes, never expanded
    const d = (await session().openMethodByKey('src/Services/BillingService.php#BillingService.notify'))!;
    expect(d.participants.some((p) => p.kind === 'unknown')).toBe(false);
    expect(d.participants.filter((p) => !p.classKey.startsWith('lib:')).map((p) => p.className)).toEqual(['BillingService']);
  });

  it('FR-18.11 routes of first-party packages: mounted by the project (its prefix + the arguments passed), or registered by the package itself', async () => {
    const eps = (await adapter.getEntryPoints!()).filter((e) => e.method.key.startsWith('vendor/'));
    const label = (l: string) => eps.find((e) => e.label === l);
    // B: routes/api.php (/api) → group 'promo' → PromoRegistrar → ShopRouteBuilder::register(Constants::VERSION_V3)
    // → group $version → group 'codes' → `[$this->codes_controller, 'apply']` (class-string default)
    expect(label('POST /api/promo/v3/codes/{code}/apply')).toMatchObject({ detail: 'route · promo', method: { key: 'vendor/seqcall/promo/src/Http/CodesController.php#CodesController.apply' } });
    // a mounted package contributes only what the project mounts: its staff routes are not this project's
    expect(eps.some((e) => e.label.includes('staff'))).toBe(false);
    // A: a package registering its own routes (its service provider), with the prefix and namespace it gives
    expect(label('POST /api/billing/webhook')).toMatchObject({ detail: 'route · billing', method: { name: 'receive' } });
    expect(eps.map((e) => e.label).sort()).toEqual(['GET /api/billing/status', 'POST /api/billing/webhook', 'POST /api/promo/v3/codes/{code}/apply']);
  });

  it('FR-18.9 "packages" in .seqcall.json replaces the default ([] = only the project)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-pkg-')).replace(/\\/g, '/');
    try {
      fs.cpSync(ROOT, tmp, { recursive: true });
      fs.writeFileSync(`${tmp}/.seqcall.json`, '{ "packages": [] } // no first-party packages');
      const a = new PhpAdapter(tmp);
      const invoice = (await a.getOutgoingCalls((await a.getMethod('src/Services/BillingService.php#BillingService.bill'))!)).find((c) => c.methodName === 'invoice')!;
      expect(invoice).toMatchObject({ isLibrary: true, target: { key: 'lib:Seqcall\\Billing\\BillingClient#BillingClient.invoice' } });
      fs.writeFileSync(`${tmp}/.seqcall.json`, '{ "packages": ["acme/*"] }');
      const b = new PhpAdapter(tmp);
      const send = (await b.getOutgoingCalls((await b.getMethod('src/Services/BillingService.php#BillingService.bill'))!)).find((c) => c.methodName === 'send')!;
      expect(send).toMatchObject({ isLibrary: false, target: { key: 'vendor/acme/mailer/src/Mailer.php#Mailer.send' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-16.3 a diagram opened from an entry point knows it (chosen one first, others of the scan); Focus drops it, Back restores it', async () => {
    const s = session();
    const eps = await s.getEntryPoints();
    const post = eps.find((e) => e.label === 'POST /api/admin/refresh')!;
    let d = (await s.openMethodByKey(post.method.key, post))!;
    expect(d.entryPoints?.map((e) => e.label)).toEqual(['POST /api/admin/refresh', 'GET /api/admin/refresh']);
    // opened at the cursor (no chosen entry): the scanned list still names it
    d = (await s.openMethodByKey('src/Services/OrderService.php#OrderService.placeOrder'))!;
    expect(d.entryPoints).toBeUndefined(); // placeOrder is not an entry point
    d = (await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store'))!;
    expect(d.entryPoints?.map((e) => e.label)).toEqual(['POST /api/orders']);
    // focus on a call: the new root is not the entry point
    d = (await s.focus(d.messages.find((m) => m.methodName === 'placeOrder')!.id))!;
    expect(d.entryPoints).toBeUndefined();
    d = (await s.back())!;
    expect(d.entryPoints?.[0].label).toBe('POST /api/orders');
  });

  it('FR-16.3 without a scan, only the chosen entry point is known (opening starts no scan)', async () => {
    const s = session();
    const chosen = { kind: 'cli' as const, label: 'orders:expire', detail: 'Artisan command', method: (await method('src/Console/Commands/ExpireOrders.php#ExpireOrders.handle')) };
    const d = (await s.openMethodByKey(chosen.method.key, chosen))!;
    expect(d.entryPoints).toEqual([chosen]);
    // a stale entry point for another method is ignored
    const other = (await s.openMethodByKey(`${SERVICE}.placeOrder`, chosen))!;
    expect(other.entryPoints).toBeUndefined();
  });

  it('FR-16.3 opened at the cursor before any scan: the background step after the render scans the list once and tags the root', async () => {
    const s = session();
    let d = (await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store'))!;
    expect(d.entryPoints).toBeUndefined(); // the open itself does not wait for a scan
    d = (await s.scanSideEffects())!; // what hosts run after showing a diagram (I/O badges)
    expect(d.entryPoints?.map((e) => e.label)).toEqual(['POST /api/orders']);
    // a later diagram is tagged at once; a file change keeps the last list for tagging
    await s.refresh([`${ROOT}/src/Services/OrderService.php`]).catch(() => undefined);
    d = (await s.openMethodByKey('src/Http/Controllers/OrderController.php#OrderController.store'))!;
    expect(d.entryPoints?.map((e) => e.label)).toEqual(['POST /api/orders']);
  });

  it('FR-18.2 parent::__construct() is a call to the parent\'s constructor, named "constructor"', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-ctor-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.writeFileSync(`${tmp}/Base.php`, '<?php\nclass Base { public function __construct(int $a) {} }\nclass Child extends Base { public function __construct() { parent::__construct(1); } }\n');
      const a = new PhpAdapter(tmp);
      const cs = await a.getOutgoingCalls((await a.getMethod('Base.php#Child.constructor'))!);
      expect(cs[0]).toMatchObject({ methodName: 'constructor', receiver: { kind: 'super' }, target: { key: 'Base.php#Base.constructor' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-18.12 a trait\'s `$this` is the class using it: calls to methods only that class declares resolve, and are its callers', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-trait-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.writeFileSync(
        `${tmp}/Saving.php`,
        `<?php
class Saver { public function save($b): void {} }
trait SavesOrders {
  private Saver $saver;
  public function saveOrder($b): bool {
    $this->saver->save($b);
    return $this->removeCredits($b);
  }
}
class Manager {
  use SavesOrders;
  public function placeAll($bs) { foreach ($bs as $b) { $this->saveOrder($b); } }
  private function removeCredits($b): bool { return true; }
}
class SpecialManager extends Manager {}
trait Logs { public function run(): void { $this->log('x'); } }
class A { use Logs; private function log($m) {} }
class B { use Logs; private function log($m) {} }
`,
      );
      const a = new PhpAdapter(tmp);
      const out = await a.getOutgoingCalls((await a.getMethod('Saving.php#SavesOrders.saveOrder'))!);
      // one class uses the trait (a subclass inherits it): `$this` is that class — its own methods and the trait's fields
      expect(out.map((c) => [c.methodName, c.target?.key])).toEqual([
        ['save', 'Saving.php#Saver.save'],
        ['removeCredits', 'Saving.php#Manager.removeCredits'],
      ]);
      const callers = await a.getCallers((await a.getMethod('Saving.php#Manager.removeCredits'))!);
      expect(callers.map((c) => c.enclosing.key)).toEqual(['Saving.php#SavesOrders.saveOrder']);
      // two unrelated classes use the trait: `$this->log()` has no single target, but it is a call of each class's own log
      const run = await a.getOutgoingCalls((await a.getMethod('Saving.php#Logs.run'))!);
      expect(run[0]).toMatchObject({ methodName: 'log' });
      expect(run[0].target).toBeUndefined();
      for (const cls of ['A', 'B']) expect((await a.getCallers((await a.getMethod(`Saving.php#${cls}.log`))!)).map((c) => c.enclosing.key)).toEqual(['Saving.php#Logs.run']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-19.1 a call that leaves the loop (`return $this->repo->find($id)` inside it) runs once: no I/O in a loop', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-leaves-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.writeFileSync(
        `${tmp}/S.php`,
        `<?php
use Illuminate\\Support\\Facades\\DB;
class Repo { public function find($id) { return DB::table('t')->find($id); } }
class S {
  public function __construct(private Repo $repo) {}
  public function firstMatch($ids) {
    foreach ($ids as $id) {
      if ($id > 3) { return $this->repo->find($id); }
    }
    return null;
  }
  public function thenThrow($ids) {
    foreach ($ids as $id) {
      if ($id > 3) { $this->repo->find($id); throw new \\Exception('x'); }
    }
  }
  public function each($ids) {
    foreach ($ids as $id) { $this->repo->find($id); }
  }
}
`,
      );
      const a = new PhpAdapter(tmp);
      const s = new DiagramSession({ adapter: a, classifier: createClassifier(tmp) });
      const loops = async (name: string) => {
        await s.openMethodByKey(`S.php#S.${name}`);
        await s.expandEverything();
        const d = (await s.scanSideEffects()) ?? s.current()!;
        return (d.findings ?? []).filter((f) => f.kind === 'io-in-loop').map((f) => f.title);
      };
      expect(await loops('firstMatch')).toEqual([]);
      expect(await loops('thenThrow')).toEqual([]);
      expect(await loops('each')).toEqual(['I/O in a loop: Repo.find (DB)']);
      const fr = (await a.getOutgoingCalls((await a.getMethod('S.php#S.firstMatch'))!))[0].fragments!;
      expect(fr.map((f) => [f.kind, f.leavesLoop ?? false])).toEqual([['loop', true], ['opt', false]]);
      // the message says so too (for hosts that list the flow)
      await s.openMethodByKey('S.php#S.firstMatch');
      expect(s.current()!.messages.filter((m) => m.methodName === 'find').map((m) => m.leavesLoop ?? false)).toEqual([true]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-18.13 PHP routes carry their names (`->name()`, with the groups\' `as` / `->name()` prefixes): tests call route(\'…\')', async () => {
    const eps = await adapter.getEntryPoints();
    expect(eps.find((e) => e.label === 'POST /api/orders')?.routeName).toBe('orders.store');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-names-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.mkdirSync(`${tmp}/routes`);
      fs.writeFileSync(`${tmp}/C.php`, '<?php\nclass C { public function a() {} public function b() {} public function c() {} }\n');
      fs.writeFileSync(
        `${tmp}/routes/web.php`,
        `<?php
Route::group(['prefix' => 'admin', 'as' => 'admin.'], function () {
    Route::get('users', [C::class, 'a'])->name('users');
    Route::name('reports.')->prefix('reports')->group(function () {
        Route::post('run', [C::class, 'b'])->middleware('auth')->name('run');
    });
});
Route::get('plain', [C::class, 'c']);
`,
      );
      const names = (await new PhpAdapter(tmp).getEntryPoints()).filter((e) => e.kind === 'http').map((e) => `${e.label} ${e.routeName ?? '-'}`);
      expect(names).toEqual(['GET /admin/users admin.users', 'POST /admin/reports/run admin.reports.run', 'GET /plain -']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-9.4 PHP: the value passes through ?: / ?: short / ?? to the target; not through a condition or ||', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-results-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.writeFileSync(
        `${tmp}/A.php`,
        `<?php
class A {
  public function a(): int { return 1; }
  public function b(): int { return 2; }
  public function c(): ?int { return null; }
  public function d(): bool { return true; }
  public function e(): bool { return true; }
  public function m($x) {
    $p = $x ? $this->a() : ($this->b());
    $q = $x ?: $this->c();
    $this->r = $x ?? $this->c();
    $s = $this->d() ? 1 : 2;
    $t = $x || $this->e();
    return $x ? null : $this->a();
  }
}
`,
      );
      const a = new PhpAdapter(tmp);
      const cs = await a.getOutgoingCalls((await a.getMethod('A.php#A.m'))!);
      expect(cs.map((c) => `${c.methodName}:${c.result ? (c.result.kind === 'assign' ? c.result.target : '↩') : '-'}`)).toEqual(['a:$p', 'b:$p', 'c:$q', 'c:r', 'd:-', 'e:-', 'a:↩']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-18.2 untyped code: a property typed by its constructor assignment; a method returning a library value; IDE stubs and Laravel aliases', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-untyped-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/composer.json`, '{"name":"x/y"}');
      fs.writeFileSync(
        `${tmp}/Service.php`,
        `<?php
namespace App;
class Client { public function getAll($p) { return [$p]; } }
class Service {
    private $api;
    public function __construct(Client $client) { $this->api = $client; }
    private function connection() { return cache()->getRedis()->connection('x'); }
    private function made() { return new Client(); }
    public function run() {
        $items = $this->connection()->get('k');
        $this->api->getAll('p');
        $this->made()->getAll('q');
        \\Log::error('e');
    }
}
`,
      );
      // laravel-ide-helper output: fake facade classes whose bodies call an unknown $instance
      fs.writeFileSync(`${tmp}/_ide_helper.php`, `<?php\nnamespace { class Log extends \\Illuminate\\Support\\Facades\\Log {} }\nnamespace Illuminate\\Support\\Facades { class Log { public static function error($m) { $instance->error($m); } } }\n`);
      expect(isAnalysedFile(`${tmp}/_ide_helper.php`)).toBe(false);
      const a = new PhpAdapter(tmp);
      const cs = await a.getOutgoingCalls((await a.getMethod('Service.php#Service.run'))!);
      const by = (name: string) => cs.filter((c) => c.methodName === name);
      expect(by('getAll').map((c) => c.target?.key)).toEqual(['Service.php#Client.getAll', 'Service.php#Client.getAll']);
      expect(by('get')[0]).toMatchObject({ isLibrary: true });
      expect(by('error')[0]).toMatchObject({ isLibrary: true, target: { key: 'lib:Illuminate\\Support\\Facades\\Log#Log.error' } });
      await a.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('issues inside folded calls: found in the background (the flow expanded fully), counted beside ⚠ N until shown', async () => {
    const s = session();
    const ep = (await s.getEntryPoints()).find((e) => e.label === 'POST /api/orders')!;
    const folded = (await s.openMethodByKey(ep.method.key, ep))!;
    expect(folded.findings?.some((f) => f.kind === 'layer-violation')).toBeFalsy(); // the service's calls are folded
    const after = (await s.scanSideEffects())!;
    expect(after.issuesBelow?.titles).toContain('Layer violation: OrderService → OrderRepositoryContract');
    expect(after.issuesBelow?.count).toBe(after.issuesBelow?.titles.length);
    // the class diagram says the same
    expect((await s.getClassDiagram())!.issuesBelow).toEqual(after.issuesBelow);
    // shown: no longer below
    const all = (await s.expandEverything())!;
    expect(all.findings?.map((f) => f.title)).toContain('Layer violation: OrderService → OrderRepositoryContract');
    expect(all.issuesBelow?.titles ?? []).not.toContain('Layer violation: OrderService → OrderRepositoryContract');

    // a hidden class: its issues are no "+n" (Expand all could never show them)
    const h = session();
    await h.openMethodByKey(ep.method.key, ep);
    await h.hide({ kind: 'class', classKey: SERVICE, className: 'OrderService' });
    const hidden = (await h.scanSideEffects()) ?? h.current()!;
    expect(hidden.issuesBelow?.titles ?? []).not.toContain('Layer violation: OrderService → OrderRepositoryContract');
    // design findings switched off after a first flow: none counted below (the background session follows the options)
    const o = session();
    const loop = (await o.getEntryPoints()).find((e) => e.label === 'orders:expire')!;
    await o.openMethodByKey(loop.method.key, loop);
    await o.scanSideEffects();
    await o.setOption('showFindings', false);
    await o.openMethodByKey(ep.method.key, ep);
    const off = (await o.scanSideEffects()) ?? o.current()!;
    expect((off.issuesBelow?.titles ?? []).filter((t) => !t.startsWith('Layer violation'))).toEqual([]);
  });

  it('the codebase map carries the design issues of its flows (the same walk), its violations apart', async () => {
    const s = session();
    const level = (await s.getAppMap())!;
    expect(level.findings?.map((f) => f.finding.title)).toContain('I/O in a loop: EloquentOrderRepository.findUser (DB)');
    expect(level.findings?.some((f) => f.finding.kind === 'layer-violation')).toBe(false);
    expect(level.violationList?.map((v) => `${v.fromName} → ${v.toName}`)).toContain('OrderService → OrderRepositoryContract');
  });

  it('FR-19.9 project-wide design issues: every entry point scanned in a separate session; cached; cancellable; a finding opens with its evidence', async () => {
    const s = session();
    const before = (await s.openMethodByKey(`${SERVICE}.placeOrder`))!;
    const progress: number[] = [];
    const found = (await s.findProjectIssues({ onProgress: (done) => progress.push(done) }))!;
    const loop = found.find((f) => f.finding.kind === 'io-in-loop')!;
    expect(loop.finding.title).toBe('I/O in a loop: EloquentOrderRepository.findUser (DB)');
    expect(loop.entryPoint.label).toBe('orders:expire');
    // FR-19.9 the files of its evidence: the looping caller and the repository it calls
    expect(loop.files).toEqual(expect.arrayContaining(['src/Repositories/EloquentOrderRepository.php']));
    expect(progress.length).toBeGreaterThan(3);
    // the layer violations too (as the flow's ⚠, the map and Review), one per class pair, listed last
    const violation = found.find((f) => f.finding.title === 'Layer violation: OrderService → OrderRepositoryContract')!;
    expect(violation.entryPoint.unreached).toBeUndefined();
    expect(found.at(-1)!.finding.kind).toBe('layer-violation');
    // FR-19.23 code no entry point reaches is checked too: BillingService is used by no route, command or job
    const unreached = found.find((f) => f.finding.title.startsWith('Layer violation: BillingService'))!;
    expect(unreached.entryPoint).toMatchObject({ unreached: true, unreachedWhy: 'no entry point reaches it: no callers', detail: 'not reached by any entry point' });
    // one finding per flaw project-wide (kind + title), however many entry points reach it
    expect(new Set(found.map((f) => `${f.finding.kind}|${f.finding.title}`)).size).toBe(found.length);
    // the user's diagram and history are untouched
    expect(s.current()).toBe(before);
    expect((await s.findProjectIssues())).toBe(found); // cached until refresh
    const again = await s.findProjectIssues({ rescan: true }); // FR-19.9 ↻ Scan again
    expect(again).not.toBe(found);
    expect(again).toEqual(found);
    // cancellation: a fresh session stops after the first entry point
    const other = session();
    let n = 0;
    expect(await other.findProjectIssues({ cancelled: () => n++ > 0 })).toBeUndefined();
    // opening the finding: same expansion as the scan, so the evidence ids exist
    const d = (await s.openFinding(loop.entryPoint))!;
    for (const id of loop.finding.messageIds!) expect(d.messages.some((m) => m.id === id)).toBe(true);
    expect(d.entryPoints?.[0].label).toBe('orders:expire');
  });
});

describe('FR-16.10 PHP: the project loads before the first request', () => {
  it('FR-16.10 warmUp parses and indexes the project files (the first diagram then finds them)', async () => {
    const adapter = new PhpAdapter(ROOT);
    const project = (adapter as unknown as { project: { files: Map<string, unknown> } }).project;
    expect(project.files.size).toBe(0);
    await adapter.warmUp();
    expect(project.files.size).toBeGreaterThan(5);
    const s = new DiagramSession({ adapter, classifier: createClassifier(ROOT) });
    await s.warmUp(); // again: nothing more to do
    expect((await adapter.getEntryPoints()).length).toBeGreaterThan(0);
  });
});
