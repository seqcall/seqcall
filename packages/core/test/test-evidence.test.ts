import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { httpRoutes, httpTestCalls, mockedTypes, mocksUsedBy, testSources, urlMatchesRoute } from '../src/test-evidence';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-test-evidence-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ep = (label: string, extra: Partial<EntryPoint> = {}): EntryPoint => ({ kind: 'http', label, method: { key: 'k', name: 'm', owner: { key: 'o', name: 'O', kind: 'class' }, isStatic: false, hasBody: true }, ...extra });

describe('FR-22.5 tests that reach a route over HTTP, mocks on the way', () => {
  it('FR-22.5 a URL in test code matches a route: parameters and API versions stand for any value, fixed segments must agree', () => {
    const route = '/v1.3|1.4/Orders/{publicId}/confirm';
    expect(urlMatchesRoute('{version}/orders/{orderPublicId}/confirm', route)).toBe(true);
    expect(urlMatchesRoute('/{version}/orders/{TestOrderPublicId}/confirm', route)).toBe(true);
    expect(urlMatchesRoute('http://localhost/v1.4/orders/abc/confirm?x=1', route)).toBe(true);
    expect(urlMatchesRoute('{version}/orders/{id}/confirm-with-code', route)).toBe(false);
    expect(urlMatchesRoute('{version}/{x}/{id}/confirm', route)).toBe(false); // a run-time value is no fixed segment
    expect(urlMatchesRoute('/users/:id', '/users/:id')).toBe(true);
    expect(urlMatchesRoute('/api/users/${id}', '/api/users/:id')).toBe(true);
    expect(urlMatchesRoute('/{a}', '/{id}')).toBe(false); // nothing fixed to compare
    // an API version is a version or a run-time value, not a fixed word: `/api/orders/{id}/confirm` is another service's URL
    expect(urlMatchesRoute('/api/orders/{orderId}/confirm', route)).toBe(false);
    expect(urlMatchesRoute('/v2/orders/{orderId}/confirm', route)).toBe(true);
  });

  it('FR-22.5 lines of test code calling the routes: by URL (the verb on the line must agree) or by the route name', () => {
    const routes = httpRoutes([
      ep('POST /v1.3|1.4/Orders/{publicId}/confirm', { verb: 'POST' }),
      ep('GET /v1.4/Orders/{publicId}', { verb: 'GET' }),
      ep('POST /api/cart/checkout', { verb: 'POST', routeName: 'api.cart.checkout' }),
      { ...ep('Job.handle'), kind: 'job' },
    ]);
    expect(routes.map((r) => r.label)).toEqual(['POST /v1.3|1.4/Orders/{publicId}/confirm', 'GET /v1.4/Orders/{publicId}', 'POST /api/cart/checkout']);
    const sources = [
      {
        rel: 'tests/Bdd/ConfirmActions.cs',
        src: [
          'class ConfirmActions {',
          '  async Task Join() { _context.Response = await _client!.PostAsJsonAsync($"{version}/orders/{orderPublicId}/confirm", body); }',
          '  async Task Show() { await _client.GetAsync($"{version}/orders/{id}"); }',
          '  async Task Wrong() { await _client.DeleteAsync($"{version}/orders/{id}"); }',
          '}',
        ].join('\n'),
      },
      { rel: 'tests/Feature/CheckoutTest.php', src: "<?php\nclass CheckoutTest { const TARGET_ROUTE = 'api.cart.checkout';\n function test_it() { $this->post(route('api.cart.checkout'), []); } }" },
      { rel: 'tests/Other.cs', src: 'class Other { void M() { var s = "nothing here"; } }' },
      // a Pact consumer test: a request this code sends to another service, not a test of these routes
      { rel: 'tests/Pact/MapsApiTests.cs', src: 'class G { void M() { pact.UponReceiving("x")\n.WithRequest(HttpMethod.Post, $"/v1/orders/{id}/confirm"); } }' },
    ];
    expect(httpTestCalls(sources, routes).map((c) => `${c.file}:${c.line} ${c.by} ${c.route}`)).toEqual([
      'tests/Bdd/ConfirmActions.cs:2 url POST /v1.3|1.4/Orders/{publicId}/confirm',
      'tests/Bdd/ConfirmActions.cs:3 url GET /v1.4/Orders/{publicId}',
      'tests/Feature/CheckoutTest.php:2 name POST /api/cart/checkout',
      'tests/Feature/CheckoutTest.php:3 name POST /api/cart/checkout',
    ]);
  });

  it('FR-22.5 mocked types: Moq / NSubstitute / FakeItEasy, PHPUnit / Mockery / Laravel, jest-mock-extended; also through a helper the test uses', () => {
    const names = ['IOrderStore', 'OrderService', 'Repo'];
    expect(mockedTypes('var m = new Mock<IOrderStore>();', names)).toEqual(['IOrderStore']);
    expect(mockedTypes('var s = Substitute.For<Core.Interfaces.IOrderStore>();', names)).toEqual(['IOrderStore']);
    expect(mockedTypes('A.Fake<OrderService>()', names)).toEqual(['OrderService']);
    expect(mockedTypes('$m = $this->createMock(Repo::class);', names)).toEqual(['Repo']);
    expect(mockedTypes("$m = Mockery::mock(\\App\\Repo::class);", names)).toEqual(['Repo']);
    expect(mockedTypes('$this->mock(Repo::class, fn ($m) => $m);', names)).toEqual(['Repo']);
    expect(mockedTypes('const r = mock<Repo>();', names)).toEqual(['Repo']);
    expect(mockedTypes('var real = new OrderService(repo); // Mock later', names)).toEqual([]);
    const helper = { rel: 'tests/Unit/TestHelper.cs', src: 'static class TestHelper { public static Mock<IOrderStore> Store = new(); }' };
    const test = { rel: 'tests/Unit/OrderServiceTests.cs', src: 'class T { void A() { TestHelper.SetupMockStore(); } }' };
    const integration = { rel: 'tests/Integration/OrderServiceTests.cs', src: 'class T { void A() { var s = Provider.Get<OrderService>(); } }' };
    expect(mocksUsedBy(test, [helper, test, integration], names)).toEqual(['IOrderStore']);
    expect(mocksUsedBy(integration, [helper, test, integration], names)).toEqual([]);
  });

  it('FR-22.5 routes without a verb, with ANY, or with a verb only in the label; quoted strings of every kind; a route with no fixed segment', () => {
    const routes = httpRoutes([ep('ANY /api/hook'), ep('POST /api/orders'), ep('/health')]);
    expect(routes).toStrictEqual([
      { label: 'ANY /api/hook', path: '/api/hook' },
      { label: 'POST /api/orders', verb: 'POST', path: '/api/orders' },
      { label: '/health', path: '/health' },
    ]);
    const src = [
      "await request.delete('/api/hook');", // ANY: every verb
      'await request.get(`/api/orders`);', // another verb than the route's
      "await request.post('/api/orders');",
      'fetch("/health");',
    ].join('\n');
    expect(httpTestCalls([{ rel: 'tests/api.test.ts', src }], routes).map((c) => `${c.line} ${c.route}`)).toEqual(['1 ANY /api/hook', '3 POST /api/orders', '4 /health']);
    // only parameters: nothing fixed to look for, nothing matches
    expect(httpTestCalls([{ rel: 'tests/a.test.ts', src: "get('/x');" }], httpRoutes([ep('GET /{slug}')]))).toEqual([]);
    // no routes at all
    expect(httpTestCalls([{ rel: 'tests/a.test.ts', src }], [])).toEqual([]);
  });

  it('FR-22.5 a segment with an unclosed brace is a fixed segment', () => {
    expect(urlMatchesRoute('/files/a{b', '/files/a{b')).toBe(false); // a URL segment with a brace is built at run time
    expect(urlMatchesRoute('/files/ab', '/files/a{b')).toBe(false);
    expect(urlMatchesRoute('/files/ab', '/files/a{b}')).toBe(true);
  });

  it('FR-22.5 the test files of a project: by language and the test globs, dependency folders and unreadable files skipped, 12 levels deep', () => {
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(`${tmp}/${rel}`), { recursive: true });
      fs.writeFileSync(`${tmp}/${rel}`, `// ${rel}`);
    };
    write('tests/b.test.ts');
    write('tests/a.test.ts');
    write('tests/helper.ts');
    write('tests/Order.cs');
    write('node_modules/p/x.test.ts');
    write('.cache/y.test.ts');
    const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join('/');
    write(`${deep}/ok.test.ts`);
    write(`${deep}/d12/too-deep.test.ts`);
    // a dangling link: listed, but cannot be read
    fs.symlinkSync(`${tmp}/missing.ts`, `${tmp}/tests/gone.test.ts`);
    const found = testSources(tmp, 'typescript', (rel) => rel.endsWith('.test.ts'));
    expect(found.map((f) => f.rel)).toEqual([`${deep}/ok.test.ts`, 'tests/a.test.ts', 'tests/b.test.ts']);
    expect(found[1].src).toBe('// tests/a.test.ts');
    expect(testSources(`${tmp}/missing`, 'typescript', () => true)).toEqual([]);
  });
});

