import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '@seqcall/protocol';
import { runCli } from '../src/cli';
import type { ContainerBinding, LanguageAdapter } from '@seqcall/core';
import type { MethodRef } from '@seqcall/protocol';
import { flowResult, runImpls, runUnreachable, stableIssueId, toIssue, type EntryPointsResult, type OutcomesResult, type Envelope, type FlowResult, type ImplsResult, type PathsResult, type Project, type ProjectIssue, type ReviewOutput, type UnreachableResult } from '../src/commands';
import { implsText, reviewText, unreachableText } from '../src/format';

const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const APP = `${REPO}/fixtures/sample-app`;
const PHP = `${REPO}/fixtures/php-app`;
const IO = `${REPO}/fixtures/io-app`;

async function cli(args: string[], cwd = REPO) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const json = async <R>(args: string[], cwd = REPO) => {
  const r = await cli([...args, '--format', 'json'], cwd);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as Envelope<R>;
};

describe('seqcall CLI (agent interface)', () => {
  it('FR-27.1 flow: the method\'s calls as an indented tree with layers, file:line, frames and implementations', async () => {
    const r = await cli(['flow', '--tree', 'fixtures/sample-app/src/controllers/user-controller.ts:12']);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^# seqcall flow · typescript · .*fixtures\/sample-app · \d+ ms$/);
    expect(lines[1]).toBe('UserController.getUser  [Presentation]  src/controllers/user-controller.ts:12');
    expect(r.out).toContain('\n  UserController.validate(id)  [Presentation]  src/controllers/user-controller.ts:13\n    opt [!id] @ src/controllers/user-controller.ts:28\n      Logger.error(\'missing id\')');
    expect(r.out).toContain('    UserRepository.findById(id)  [Ports]  async  impl: InMemoryUserRepository | SqlUserRepository  src/services/user-service.ts:15');
    expect(r.out).toContain("  loop [each t of ['a', 'b']] @ src/controllers/user-controller.ts:17\n    format.slugify(t)  src/controllers/user-controller.ts:17");
    expect(r.out).toContain('issues: none in this flow');
    expect(r.out).not.toContain('INCOMPLETE');
  });

  it('FR-27.1 flow --format json: envelope, call ids and method keys; a method key from it opens the same flow', async () => {
    const e = await json<FlowResult>(['flow', '--tree', 'fixtures/sample-app/src/controllers/user-controller.ts:12']);
    expect(e).toMatchObject({ schema: 'seqcall/v1', command: 'flow', project: { root: APP, language: 'typescript' }, complete: true, limits: [] });
    expect(e.result.method).toEqual({ key: 'src/controllers/user-controller.ts#UserController.getUser', label: 'UserController.getUser', at: 'src/controllers/user-controller.ts:12', layer: 'Presentation' });
    const err = e.result.calls!.find((c) => c.call === 'Logger.error')!;
    expect(err).toMatchObject({ id: 'root/0:validate/0:error', depth: 2, args: ["'missing id'"], at: 'src/controllers/user-controller.ts:29', frames: ['opt [!id] @ src/controllers/user-controller.ts:28'] });
    const find = e.result.calls!.find((c) => c.call === 'UserRepository.findById')!;
    expect(find).toMatchObject({ async: true, implementations: { names: ['InMemoryUserRepository', 'SqlUserRepository'] } });
    const byKey = await json<FlowResult>(['flow', '--tree', e.result.method.key, '--root', 'fixtures/sample-app']);
    expect(byKey.result.calls!.map((c) => c.id)).toEqual(e.result.calls!.map((c) => c.id));
  });

  it('FR-27.1 flow: issues with stable ids and the lines of their evidence; the DI container\'s creations are not calls (PHP)', async () => {
    const e = await json<FlowResult>(['flow', '--tree', 'fixtures/php-app/src/Http/Controllers/OrderController.php:14']);
    expect(e.project).toEqual({ root: PHP, language: 'php' });
    expect(e.result.entryPoints).toEqual(['POST /api/orders']);
    expect(e.result.calls!.every((c) => c.id.startsWith('root/'))).toBe(true);
    expect(e.result.calls!.find((c) => c.call === 'PaymentGateway.charge')).toMatchObject({ layer: 'Infrastructure', io: { kinds: ['http'] }, implementations: { drawn: 'StripeGateway' } });
    const v = e.result.issues.find((i) => i.kind === 'layer-violation')!;
    // FR-7.16 both layers come from role folders (`Services/`, `Repositories/`): a guess, so only possible, and why
    expect(v).toMatchObject({ certainty: 'possible', title: 'Layer violation: OrderService → OrderRepositoryContract' });
    expect(v.evidence!.slice(-2)).toEqual(['`OrderService` is Application by a guess: role folder `Services/`', '`OrderRepositoryContract` is Infrastructure by a guess: role folder `Repositories/`']);
    expect(v.at).toEqual(['src/Services/OrderService.php:28', 'src/Services/OrderService.php:50', 'src/Services/OrderService.php:52']);
    expect(v.id).toBe(stableIssueId({ id: 'x', kind: 'layer-violation', title: v.title, classKeys: ['src/Services/OrderService.php#OrderService', 'src/Repositories/OrderRepositoryContract.php#OrderRepositoryContract'] }));
  });

  it('FR-27.1 flow: the I/O list at the end; an N+1 names its loop with file:line (PHP)', async () => {
    const r = await cli(['flow', '--tree', 'fixtures/php-app/src/Console/Commands/ExpireOrders.php:15']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  loop [each $userId of [1, 2, 3]] @ src/Console/Commands/ExpireOrders.php:15\n    EloquentOrderRepository.findUser($userId)');
    expect(r.out).toContain('I/O (1; inside calls doing the same I/O not repeated):\n  DB  EloquentOrderRepository.findUser  src/Console/Commands/ExpireOrders.php:16  [IN LOOP]');
    expect(r.out).toContain('⚠ I/O in a loop: EloquentOrderRepository.findUser (DB)  (io-in-loop)  at src/Console/Commands/ExpireOrders.php:16\n      the loop: loop [each $userId of [1, 2, 3]] @ src/Console/Commands/ExpireOrders.php:15');
    const e = await json<FlowResult>(['flow', '--tree', 'fixtures/php-app/src/Console/Commands/ExpireOrders.php:15']);
    expect(e.result.io).toEqual([{ kinds: ['db'], call: 'EloquentOrderRepository.findUser', id: e.result.calls![0].id, at: 'src/Console/Commands/ExpireOrders.php:16', via: [], inLoop: true }]);
    expect(e.result.issues[0].loop).toBe('loop [each $userId of [1, 2, 3]] @ src/Console/Commands/ExpireOrders.php:15');
  });

  it('FR-27.1 a call inside a call doing the same I/O is part of it (the query\'s row reader): one I/O in the list', () => {
    const msg = (id: string, parentId: string, methodName: string, io?: { kinds: string[]; below?: boolean }) =>
      ({ id, parentId, depth: id.split('/').length - 1, methodName, className: 'Repo', to: 'p', args: [], kind: 'sync', ...(io ? { sideEffects: { ...io, evidence: [] } } : {}) }) as never;
    const d = {
      root: { key: 'a.cs#S.Run', name: 'Run', owner: { name: 'S' } },
      participants: [{ id: 'p', className: 'Repo' }],
      messages: [
        msg('root', '', 'Run'),
        msg('root/0:Find', 'root', 'Find', { kinds: ['db'], below: true }),
        msg('root/0:Find/0:Query', 'root/0:Find', 'Query', { kinds: ['db'] }),
        msg('root/0:Find/0:Query/0:ReadRows', 'root/0:Find/0:Query', 'ReadRows', { kinds: ['db'] }),
        msg('root/1:Send', 'root', 'Send', { kinds: ['http'] }),
      ],
    } as never;
    const r = flowResult('/p', d);
    expect(r.calls!.find((c) => c.call === 'Repo.ReadRows')?.io?.partOf).toBe('Repo.Query');
    expect(r.calls!.find((c) => c.call === 'Repo.Query')?.io?.partOf).toBeUndefined();
    expect(r.io.map((x) => `${x.kinds.join(',')} ${x.call} via ${x.via.join(' → ')}`)).toEqual(['db Repo.Query via Repo.Find', 'http Repo.Send via ']);
    // I/O only further down, with nothing below it shown (an interface call with no implementation chosen): listed
    const open = flowResult('/p', { ...(d as object), messages: [(d as { messages: unknown[] }).messages[0], msg('root/0:Pay', 'root', 'Pay', { kinds: ['http'], below: true })] } as never);
    expect(open.io).toEqual([{ kinds: ['http'], call: 'Repo.Pay', id: 'root/0:Pay', via: [], below: true }]);
  });

  it('FR-27.1 I/O below a call that leaves the loop (`return await …`) runs once: not IN LOOP', () => {
    const msg = (id: string, parentId: string, methodName: string, extra: object = {}) =>
      ({ id, parentId, depth: id.split('/').length - 1, methodName, className: 'S', to: 'p', args: [], kind: 'sync', ...extra }) as never;
    const db = { sideEffects: { kinds: ['db'], evidence: [] } };
    const d = {
      root: { key: 'a.cs#S.Run', name: 'Run', owner: { name: 'S' } },
      participants: [{ id: 'p', className: 'S' }],
      messages: [msg('root', '', 'Run'), msg('root/0:Info', 'root', 'Info', db), msg('root/1:Join', 'root', 'Join', { leavesLoop: true }), msg('root/1:Join/0:Insert', 'root/1:Join', 'Insert', db)],
      fragments: [{ id: 'root#loop0@0', kind: 'loop', ownerMessageId: 'root', operands: [{ guard: 'each c in cs', firstMessageId: 'root/0:Info', lastMessageId: 'root/1:Join' }] }],
    } as never;
    expect(flowResult('/p', d).io.map((x) => [x.call, x.inLoop ?? false, x.onceInLoop ?? false])).toEqual([
      ['S.Info', true, false],
      ['S.Insert', false, true],
    ]);
  });

  it('FR-27.6 short by default: flow gives the method, its I/O list and issues (no call tree); paths no code lines', async () => {
    const r = await cli(['flow', 'fixtures/php-app/src/Console/Commands/ExpireOrders.php:15']);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').slice(1)).toEqual([
      // the entry point it is (the background step tags the root, FR-16.3)
      'ExpireOrders.handle  src/Console/Commands/ExpireOrders.php:13  ← orders:expire',
      '1 call (the call tree: --tree)',
      'I/O (1; inside calls doing the same I/O not repeated):',
      '  DB  EloquentOrderRepository.findUser  src/Console/Commands/ExpireOrders.php:16  [IN LOOP]',
      'issues (1):',
      '  ⚠ I/O in a loop: EloquentOrderRepository.findUser (DB)  (io-in-loop)  at src/Console/Commands/ExpireOrders.php:16',
      '      the loop: loop [each $userId of [1, 2, 3]] @ src/Console/Commands/ExpireOrders.php:15',
    ]);
    const e = await json<FlowResult>(['flow', 'fixtures/php-app/src/Console/Commands/ExpireOrders.php:15']);
    expect(e.result.calls).toBeUndefined();
    expect(e.result.callCount).toBe(1);
    expect(e.result.io).toHaveLength(1);
    const p = await cli(['paths', 'fixtures/php-app/src/Domain/Pricing.php:9']);
    expect(p.out).toContain('  ← OrderService.placeOrder  src/Services/OrderService.php:34  +1 test caller\n');
    expect(p.out).not.toContain('`');
  });

  it('FR-27.1 flow --depth: only that many levels; the folded calls are named as a limit', async () => {
    const r = await cli(['flow', '--tree', 'fixtures/sample-app/src/controllers/user-controller.ts:12', '--depth', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^# INCOMPLETE: --depth 1: \d+ calls folded$/m);
    expect(r.out).toContain('UserService.findUser(id)  [Application]  async  (folded)');
    expect(r.out).not.toContain('UserRepository.findById');
  });

  it('FR-27.1 a frame that ends at an early exit (`return` inside the loop) still frames its calls', () => {
    const msg = (id: string, depth: number, methodName: string) => ({ id, depth, methodName, className: 'S', to: 'p', args: [], kind: 'sync' }) as never;
    const d = {
      root: { key: 'a.cs#S.Run', name: 'Run', owner: { name: 'S' } },
      participants: [{ id: 'p', className: 'S' }],
      messages: [msg('root', 0, 'Run'), msg('root/0:Each', 1, 'Each'), msg('root/0:Each/0:Read', 2, 'Read'), msg('root/0:Each/1:Write', 2, 'Write'), msg('root/1:After', 1, 'After')],
      exits: [{ id: 'root/0:Each!exit2', ownerMessageId: 'root/0:Each', kind: 'return', beforeId: undefined }],
      fragments: [{ id: 'root/0:Each#loop0@0', kind: 'loop', ownerMessageId: 'root/0:Each', operands: [{ guard: 'each c in cs', firstMessageId: 'root/0:Each/0:Read', lastMessageId: 'root/0:Each!exit2' }] }],
    } as never;
    const frames = Object.fromEntries(flowResult('/p', d).calls!.map((c) => [c.call, c.frames ?? []]));
    expect(frames).toEqual({ 'S.Each': [], 'S.Read': ['loop [each c in cs]'], 'S.Write': ['loop [each c in cs]'], 'S.After': [] });
  });

  it('FR-27.2 issue certainty and ids: "Possible I/O" is possible; the id is the silencing key, the same across renders', () => {
    const f: Finding = { id: 'render-7', kind: 'io-in-loop', title: 'Possible I/O in a loop: Repo.find (DB)', ignoreKey: 'Service.run', messageIds: ['root/0:find'] };
    const issue = toIssue('/p', f, [{ id: 'root/0:find', callSite: { file: '/p/src/a.ts', start: { line: 9, character: 0 }, end: { line: 9, character: 5 } } } as never]);
    expect(issue).toEqual({ id: 'io-in-loop:Service.run', kind: 'io-in-loop', certainty: 'possible', title: f.title, at: ['src/a.ts:10'] });
    expect(stableIssueId({ ...f, id: 'render-8' })).toBe(issue.id);
  });

  it('FR-27.3 paths: who reaches the method, up to the entry points; tests folded into a count unless --tests', async () => {
    const r = await cli(['paths', 'fixtures/php-app/src/Domain/Pricing.php:9', '--code']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('reached from: 1 http, 1 tests\n  http: POST /api/orders');
    expect(r.out).toContain("Pricing.priceOf\n  ← OrderService.placeOrder  src/Services/OrderService.php:34  `$total += Pricing::priceOf($item['sku'], $item['qty']);`  +1 test caller\n    ← OrderController.store  src/Http/Controllers/OrderController.php:16");
    expect(r.out).not.toContain('tests (');
    expect(r.out).toContain('[entry: POST /api/orders]');
    // --tests: the tree stays the same (test code only counted); the test methods are listed once, by class
    const e = await json<PathsResult>(['paths', 'fixtures/php-app/src/Domain/Pricing.php:9', '--tests']);
    expect(e.result.reachedFrom).toEqual({ http: ['POST /api/orders'] });
    expect(e.result.tests).toBe(1);
    expect(e.result.testList).toEqual([{ class: 'OrderServiceTest', file: 'tests/OrderServiceTest.php', methods: ['test_places_an_order'] }]);
    const place = e.result.target.callers![0];
    expect(place.tests).toBe(1);
    expect(place.callers!.map((c) => c.method)).toEqual(['OrderController.store']);
    const text = await cli(['paths', 'fixtures/php-app/src/Domain/Pricing.php:9', '--tests']);
    expect(text.out).toMatch(/\ntests \(1\):\n  OrderServiceTest  tests\/OrderServiceTest.php: test_places_an_order$/);
  });

  it('FR-27.3 paths: tests over HTTP (by URL and route name) and tests that mock the way down, found in the test code (FR-22.5)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-evidence-')).replace(/\\/g, '/');
    try {
      const w = (rel: string, src: string) => {
        fs.mkdirSync(path.dirname(`${dir}/${rel}`), { recursive: true });
        fs.writeFileSync(`${dir}/${rel}`, src);
      };
      w('composer.json', '{"name":"x/y"}');
      w('routes/api.php', "<?php\nRoute::post('orders', [OrderController::class, 'store'])->name('orders.store');\n");
      w('app/RepoContract.php', '<?php\ninterface RepoContract { public function save(array $o): void; }\n');
      w('app/Repo.php', '<?php\nclass Repo implements RepoContract {\n  public function save(array $o): void {\n  }\n}\n');
      w('app/OrderService.php', '<?php\nclass OrderService { public function __construct(private RepoContract $repo) {} public function place(array $o): void { $this->repo->save($o); } }\n');
      w('app/OrderController.php', '<?php\nclass OrderController { public function __construct(private OrderService $orders) {} public function store(): array { $this->orders->place([]); return []; } }\n');
      w('tests/Unit/OrderServiceTest.php', '<?php\nclass OrderServiceTest extends TestCase { public function test_places(): void { $repo = $this->createMock(RepoContract::class); (new OrderService($repo))->place([]); } }\n');
      w(
        'tests/Feature/OrderHttpTest.php',
        "<?php\nclass OrderHttpTest extends TestCase {\n  public function test_store(): void {\n    $this->postJson('/api/orders', []);\n  }\n  public function test_named(): void {\n    $this->post(route('orders.store'));\n  }\n  public function test_other(): void {\n    $this->getJson('/api/orders');\n  }\n}\n",
      );
      const e = await json<PathsResult>(['paths', 'app/Repo.php:3', '--tests'], dir);
      expect(e.result.reachedFrom).toEqual({ http: ['POST /api/orders'] });
      expect(e.result.tests).toBe(1);
      expect(e.result.testsMocking).toBe(1);
      expect(e.result.testList).toEqual([{ class: 'OrderServiceTest', file: 'tests/Unit/OrderServiceTest.php', methods: ['test_places'], mocks: ['RepoContract'] }]);
      // a GET of the same URL is another route
      expect(e.result.httpTests).toEqual([
        { route: 'POST /api/orders', at: 'tests/Feature/OrderHttpTest.php:4', in: 'OrderHttpTest.test_store', by: 'url' },
        { route: 'POST /api/orders', at: 'tests/Feature/OrderHttpTest.php:7', in: 'OrderHttpTest.test_named', by: 'name' },
      ]);
      const text = await cli(['paths', 'app/Repo.php:3'], dir);
      expect(text.out).toContain('  1 of the 1 tests mock a type on the way (their file or a helper it uses): they reach its interface, not this code');
      expect(text.out).toContain('  over HTTP from test code (found by URL / route-name text, not in the tree): 2 calls in 1 file (--tests lists them)');
      const listed = await cli(['paths', 'app/Repo.php:3', '--tests'], dir);
      expect(listed.out).toContain('  OrderServiceTest  tests/Unit/OrderServiceTest.php: test_places  [mocks RepoContract]');
      expect(listed.out).toContain('tests over HTTP (2, by text):\n  POST /api/orders  ← OrderHttpTest.test_store  tests/Feature/OrderHttpTest.php:4\n  POST /api/orders  ← OrderHttpTest.test_named  tests/Feature/OrderHttpTest.php:7  (route name)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-27.4 review: the changed methods of the branch since it split off the base (master when there is no develop)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-review-')).replace(/\\/g, '/');
    try {
      fs.cpSync(APP, dir, { recursive: true });
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' });
      git('init', '-q', '-b', 'master');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('checkout', '-qb', 'feature');
      const file = `${dir}/src/services/user-service.ts`;
      const src = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, src.replace('  async findUser(id: string): Promise<User> {\n', "  async findUser(id: string): Promise<User> {\n    for (const other of [id, id + '-alias']) {\n      await this.primary.findById(other);\n    }\n"));
      git('commit', '-qam', 'loop');
      const e = await json<ReviewOutput>(['review'], dir);
      expect(e.result).toMatchObject({ base: 'master', branch: 'feature', files: [{ path: 'src/services/user-service.ts', status: 'modified', added: 3, removed: 0 }] });
      expect(e.result.compared).toMatch(/^since the branch split off master \(\w+, 1 commits\)$/);
      expect(e.result.methods).toEqual([expect.objectContaining({ method: 'UserService.findUser', status: 'changed', lines: 'src/services/user-service.ts:15-17' })]);
      // FR-29 a loop in one method changes no dependency between layers: the structure is unchanged
      expect(e.result.structure).toMatchObject({ rows: [], notCompared: 0 });
      const text = await cli(['review', '--base', 'master'], dir);
      expect(text.out).toContain('changed methods (1):\n  UserService.findUser  changed  src/services/user-service.ts:15-17');
      expect(text.out).toMatch(/\nstructure: unchanged \(\d+ flows compared, \d+ unchanged\)\n/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-29 / FR-29.7 … 28.11 review text: the structure rows before the changed methods', () => {
    const envelope: Envelope<ReviewOutput> = {
      schema: 'seqcall/v1',
      command: 'review',
      project: { root: '/p', language: 'typescript' },
      complete: true,
      limits: [],
      elapsedMs: 1,
      result: {
        base: 'develop',
        compared: 'since the branch split off develop (abc, 1 commits)',
        branch: 'feature/shape',
        files: [],
        methods: [],
        issues: [],
        structure: {
          rows: [
            { kind: 'edge-added', title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer', pairs: ['Order → Db  src/domain/order.ts:4'], flow: 'GET /orders/:id' },
            { kind: 'edge-removed', title: 'orders → billing', detail: 'OrderService → InvoiceService', level: 'package', flow: 'GET /orders/:id' },
            { kind: 'entry-removed', title: 'GET /legacy/orders', detail: 'LegacyController.list' },
            { kind: 'io-added', title: 'Infrastructure: File', detail: 'ReportFile', level: 'layer', flow: 'GET /orders/:id' },
            { kind: 'cycle-added', title: 'Cycle: Application → Infrastructure → Application', detail: 'OrderRepo → Clock', level: 'layer' },
            { kind: 'layer-changed', title: 'TaxTable: Domain → Infrastructure', detail: 'moved from src/domain/tax-table.ts', level: 'layer' },
            { kind: 'client-added', title: 'Infrastructure: Confluent.Kafka (Queue)', detail: 'EventBus', level: 'layer' },
            { kind: 'role-changed', title: 'OrderRepo: «repository» → «repository» «singleton»', level: 'layer' },
          ],
          compared: 2,
          copied: 1,
          notCompared: 0,
        },
      },
    };
    expect(reviewText(envelope)).toContain(
      [
        'structure (8 changes against the base; 2 flows compared, 1 unchanged):',
        '  + dependency  Domain → Infrastructure  Order → Db  ← GET /orders/:id',
        '  - dependency (packages)  orders → billing  OrderService → InvoiceService  ← GET /orders/:id',
        '  - entry point  GET /legacy/orders  LegacyController.list',
        '  + I/O kind  Infrastructure: File  ReportFile  ← GET /orders/:id',
        '  + cycle  Cycle: Application → Infrastructure → Application  OrderRepo → Clock',
        '  ~ class changed layer  TaxTable: Domain → Infrastructure  moved from src/domain/tax-table.ts',
        '  + I/O client  Infrastructure: Confluent.Kafka (Queue)  EventBus',
        '  ~ class changed role  OrderRepo: «repository» → «repository» «singleton»',
        'issues in the changed flows: none',
      ].join('\n'),
    );
  });

  it('FR-27.5 usage errors exit 2 with a hint; --help prints the usage', async () => {
    expect((await cli(['--help'])).out).toContain('seqcall flow');
    expect((await cli([])).code).toBe(2);
    for (const args of [['nope'], ['flow'], ['flow', 'a.ts'], ['flow', 'missing.ts:3'], ['flow', '--tree', 'fixtures/sample-app/src/controllers/user-controller.ts:12', '--bogus'], ['flow', 'x.ts:1', '--format', 'xml']]) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/^seqcall: .*\n\(seqcall --help for usage\)$/);
    }
    const blank = await cli(['flow', '--tree', 'fixtures/sample-app/src/controllers/user-controller.ts:1']);
    expect(blank.code).toBe(2);
    expect(blank.err).toContain('no method at');
  });

  it('FR-27.8 entrypoints: routes, commands, jobs and handlers by kind with the handler\'s file:line; filter words must all match', async () => {
    const r = await cli(['entrypoints'], PHP);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[1]).toBe('15 entry points');
    expect(lines).toContain('  POST /api/orders  OrderController.store  src/Http/Controllers/OrderController.php:14  [name: orders.store, route]');
    // a route with middleware keeps its name (FR-18.13 with FR-18.14)
    expect(lines).toContain('  POST /api/refunds  RefundController.store  src/Http/Controllers/RefundController.php:7  [name: refunds.store, route]');
    expect(lines).toContain('cli (1):');
    expect(lines).toContain('  orders:expire  ExpireOrders.handle  src/Console/Commands/ExpireOrders.php:13  [Artisan command]');
    const f = await cli(['entrypoints', 'POST', 'orders'], PHP);
    expect(f.out.split('\n').slice(1)).toEqual(['1 of 15 entry points match "POST orders"', 'http (1):', '  POST /api/orders  OrderController.store  src/Http/Controllers/OrderController.php:14  [name: orders.store, route]']);
    const e = await json<EntryPointsResult>(['entrypoints', 'orders.store'], PHP);
    expect(e.result.entryPoints.map((x) => x.key)).toEqual(['src/Http/Controllers/OrderController.php#OrderController.store']);
    // the key opens that flow
    expect((await cli(['flow', e.result.entryPoints[0].key], PHP)).code).toBe(0);
    // tests only when asked
    const all = await json<EntryPointsResult>(['entrypoints', '--tests'], PHP);
    expect(all.result.total).toBeGreaterThan(15);
    expect(all.result.entryPoints.some((x) => x.kind === 'test')).toBe(true);
  });

  it('FR-32.5 outcomes: what each entry point\'s flow touches, by the classes doing it; --detail: their calls with file:line; filter words', async () => {
    const r = await cli(['outcomes'], IO);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').slice(1)).toEqual([
      'outcomes: 2 entry points (tests excluded), 2 with I/O — http 1, file 2',
      '  GET /notes/:id  routes.showNote  FILE via FileNotes',
      '  POST /notes/:id/share  routes.shareNote  HTTP via NoteService · FILE via FileNotes',
    ]);
    const d = await cli(['outcomes', 'share', '--detail'], IO);
    expect(d.out.split('\n').slice(1)).toEqual([
      'outcomes: 1 of 2 entry points match "share", 1 with I/O — http 1, file 1',
      '  POST /notes/:id/share  routes.shareNote  src/routes.ts:16  HTTP via NoteService · FILE via FileNotes',
      '      HTTP  NoteService: fetch  src/services/note-service.ts:13',
      '      FILE  FileNotes: fs/promises.readFile  src/adapters/file-notes.ts:9',
    ]);
    const e = await json<OutcomesResult>(['outcomes', 'share'], IO);
    expect(e).toMatchObject({ command: 'outcomes', complete: true, limits: [] });
    expect(e.result.entryPoints[0].io[0]).toEqual({ kind: 'http', via: [{ class: 'NoteService', calls: [{ call: 'fetch', at: 'src/services/note-service.ts:13' }] }] });
  });

  it('FR-27.9 issues: the design issues of every entry point\'s flow, each with its flow and files', async () => {
    const e = await json<{ issues: ProjectIssue[]; entryPoints: number }>(['issues'], PHP);
    expect(e.result.entryPoints).toBe(15);
    const loop = e.result.issues.find((i) => i.kind === 'io-in-loop')!;
    expect(loop).toMatchObject({ id: 'io-in-loop:EloquentOrderRepository.findUser', flow: 'orders:expire', flowKey: 'src/Console/Commands/ExpireOrders.php#ExpireOrders.handle' });
    // the same id as in that flow (FR-27.2): an agent can match the two
    const flow = await json<FlowResult>(['flow', loop.flowKey], PHP);
    expect(flow.result.issues.map((i) => i.id)).toContain(loop.id);
    expect(loop.files).toEqual(['src/Console/Commands/ExpireOrders.php', 'src/Repositories/EloquentOrderRepository.php']);
    const r = await cli(['issues'], PHP);
    expect(r.out).toContain(`issues (${e.result.issues.length}) in the flows of 15 entry points (tests excluded):\n  ⚠ I/O in a loop: EloquentOrderRepository.findUser (DB)  (io-in-loop)  in orders:expire\n      files: src/Console/Commands/ExpireOrders.php, src/Repositories/EloquentOrderRepository.php`);
    expect((await cli(['issues', 'x.php:3'], PHP)).code).toBe(2);
  });

  it('FR-31 unreachable: the methods no entry point reaches, by reason, with file:line; framework-called apart', async () => {
    const e = await json<UnreachableResult>(['unreachable'], PHP);
    expect(e.result.entryPoints).toBe(15);
    expect(e.result.methods.find((u) => u.method === 'OrderService.retryCharge')).toMatchObject({ reason: 'no-callers', at: expect.stringMatching(/^src\/Services\/OrderService\.php:\d+$/) });
    expect(e.result.methods.find((u) => u.method === 'Customer.account')).toMatchObject({ framework: 'extends Model' });
    const r = await cli(['unreachable'], PHP);
    expect(r.out.split('\n')[1]).toBe(`unreachable: ${e.result.methods.length} of ${e.result.total} methods (from 15 entry points, tests excluded)`);
    expect(r.out).toContain('\nno callers (');
    expect(r.out).toContain('\ncalled only from unreached code (');
    expect(r.out).toContain('\nprobably called by the framework (');
    expect(r.out).toContain('  Customer.account  src/Models/Customer.php:9  (extends Model)');
    expect((await cli(['unreachable', 'x.php:3'], PHP)).code).toBe(2);
  });

  it('FR-31 unreachable as text: every group, probably-reached and ignored counts, a library, the walk limit', () => {
    const env = (result: UnreachableResult, limits: string[] = []) =>
      unreachableText({ schema: 'seqcall/v1', command: 'unreachable', project: { root: '/p', language: 'php' }, complete: !limits.length, limits, elapsedMs: 1, result } as Envelope<UnreachableResult>);
    const row = (method: string, extra: Partial<UnreachableResult['methods'][0]> = {}) => ({ method, key: `k#${method}`, reason: 'no-callers' as const, callers: 0, ...extra });
    const text = env(
      {
        methods: [
          row('Shop.close', { at: 'src/Shop.php:4' }),
          row('Shop.audit', { reason: 'unreached-callers', callers: 2 }),
          row('Shop.trace', { reason: 'unreached-callers', callers: 1 }),
          row('Shop.quiet', { reason: 'unreached-callers', callers: 0 }),
          row('Shop.seed', { reason: 'tests-only', callers: 1 }),
          row('Order.total', { unresolved: 3 }),
          row('Order.sum', { reason: 'unreached-callers', callers: 1, unresolved: 3, via: 'Order.total' }),
          row('Order.getTotalAttribute', { framework: 'extends Model' }),
        ],
        total: 20,
        reached: 13,
        entryPoints: 2,
        missed: 1,
        ignored: 4,
      },
      ['walk limit: more methods may be reached'],
    );
    expect(text.split('\n').slice(1)).toEqual([
      '# INCOMPLETE: walk limit: more methods may be reached',
      'unreachable: 8 of 20 methods (from 2 entry points, tests excluded); 1 probably reached (a reference the walk does not follow), not listed; 4 ignored by the config',
      'no callers (1):',
      '  Shop.close  src/Shop.php:4',
      'called only from unreached code (3):',
      '  Shop.audit  (2 callers)',
      '  Shop.trace  (1 caller)',
      '  Shop.quiet',
      'only tests call it (1):',
      '  Shop.seed  (1 caller)',
      'maybe called — calls of the name the analysis could not resolve (2):',
      '  Order.total  (3 unresolved)',
      '  Order.sum  (3 unresolved, via Order.total)',
      'probably called by the framework (1):',
      '  Order.getTotalAttribute  (extends Model)',
    ]);
    expect(env({ methods: [], total: 9, reached: 0, entryPoints: 0, missed: 0 }).split('\n')[1]).toBe('no entry points (tests excluded) — a library? Nothing is listed (9 methods).');
    expect(env({ methods: [], total: 9, reached: 9, entryPoints: 1, missed: 0 }).split('\n').slice(1)).toEqual(['unreachable: 0 of 9 methods (from 1 entry points, tests excluded)']);
  });

  it('FR-31 unreachable: a cancelled scan fails; a method without a declaration has no line; the walk limit is a limit', async () => {
    const project = (r: unknown) => ({ root: '/p', language: 'php', session: { findUnreachableCode: async () => r } }) as unknown as Project;
    await expect(runUnreachable(project(undefined))).rejects.toThrow('scan cancelled');
    const m: MethodRef = { key: 'src/a.php#A.run', name: 'run', owner: { key: 'src/a.php#A', name: 'A', kind: 'class' }, isStatic: false, hasBody: true };
    const out = await runUnreachable(project({ methods: [{ method: m, reason: 'no-callers', callers: 0 }, { method: m, reason: 'unreached-callers', callers: 1, unresolved: 2, via: 'A.go', framework: 'extends Model' }], total: 3, reached: 2, entryPoints: 1, missed: 0, truncated: true, ignored: 1 }));
    expect(out).toEqual({
      result: {
        methods: [
          { method: 'A.run', key: 'src/a.php#A.run', reason: 'no-callers', callers: 0 },
          { method: 'A.run', key: 'src/a.php#A.run', reason: 'unreached-callers', callers: 1, framework: 'extends Model', unresolved: 2, via: 'A.go' },
        ],
        total: 3,
        reached: 2,
        entryPoints: 1,
        missed: 0,
        ignored: 1,
      },
      limits: ['walk limit: more methods may be reached than the walk saw (the list may hold live code)'],
    });
  });

  it('FR-27.10 impls: the implementations of an interface method and the class the DI container gives (PHP)', async () => {
    const r = await cli(['impls', 'src/Payments/PaymentGateway.php:7'], PHP);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').slice(1)).toEqual([
      'PaymentGateway.charge  (no body: interface / abstract)  src/Payments/PaymentGateway.php:7',
      'implementations (1):',
      '  StripeGateway.charge  src/Payments/StripeGateway.php:9',
      'DI registrations (1):',
      '  StripeGateway  src/Providers/AppServiceProvider.php:19  [singleton]',
      'the container gives: StripeGateway  (src/Providers/AppServiceProvider.php:19)',
    ]);
    expect((await cli(['impls', 'src/Payments/PaymentGateway.php:1'], PHP)).err).toContain('no method at');
  });

  it('FR-27.10 impls: per application when they differ; keyed / conditional registrations are chosen at run time', async () => {
    const owner = { key: 'src/I.cs#IRepo', name: 'IRepo', kind: 'interface' as const };
    const method: MethodRef = { key: 'src/I.cs#IRepo.Find()', name: 'Find', owner, isStatic: false, hasBody: false };
    const at = (line: number) => ({ file: '/p/src/Program.cs', start: { line, character: 0 }, end: { line, character: 1 } });
    const bindings: ContainerBinding[] = [
      { abstract: owner.key, concrete: 'src/Sql.cs#SqlRepo', range: at(10), hosts: ['Web'], lifetime: 'singleton' },
      { abstract: owner.key, concrete: 'src/Mem.cs#MemRepo', range: at(11), hosts: ['Web'], fallback: true },
      { abstract: owner.key, concrete: 'src/Sql.cs#SqlRepo', range: at(20), hosts: ['Batch'], key: 'live', keyKind: 'condition' },
      { abstract: owner.key, concrete: 'src/Mem.cs#MemRepo', range: at(20), hosts: ['Batch'], key: '!live', keyKind: 'condition' },
      { abstract: 'src/J.cs#IOther', concrete: 'src/O.cs#Other', range: at(30) },
    ];
    const adapter = {
      getMethod: async () => method,
      getImplementations: async () => [],
      getBindings: async () => bindings,
    } as unknown as LanguageAdapter;
    const p = { root: '/p', language: 'csharp', adapter } as unknown as Project;
    const { result } = await runImpls(p, { methodKey: method.key });
    expect(result.registrations.map((b) => `${b.concrete} ${b.at}`)).toEqual(['SqlRepo src/Program.cs:11', 'MemRepo src/Program.cs:12', 'SqlRepo src/Program.cs:21', 'MemRepo src/Program.cs:21']);
    expect(result.bound).toEqual([{ concrete: 'SqlRepo', at: 'src/Program.cs:11', host: 'Web' }, { host: 'Batch' }]);
    const text = implsText({ schema: 'seqcall/v1', command: 'impls', project: { root: '/p', language: 'csharp' }, complete: true, limits: [], elapsedMs: 1, result } as Envelope<ImplsResult>);
    expect(text).toContain('  MemRepo  src/Program.cs:12  [only if none yet, in Web]\n  SqlRepo  src/Program.cs:21  [when live, in Batch]');
    expect(text).toContain('the container gives in Web: SqlRepo  (src/Program.cs:11)\nthe container gives in Batch: chosen at run time (keyed / conditional registrations)');
    // the same class everywhere: one line
    bindings.splice(2, 2, { abstract: owner.key, concrete: 'src/Sql.cs#SqlRepo', range: at(20), hosts: ['Batch'] });
    expect((await runImpls(p, { methodKey: method.key })).result.bound).toEqual([{ concrete: 'SqlRepo', at: 'src/Program.cs:11' }]);
  });
});
