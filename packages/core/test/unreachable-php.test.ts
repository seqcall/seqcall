import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { PhpAdapter } from '../src/php/php-adapter';
import { bladeCallNames } from '../src/php/templates';
import { DiagramSession } from '../src/session';

// FR-31 unreachable code of the Laravel-style sample: routes, jobs, listeners, commands and route middleware start the walk.
const ROOT = path.resolve(__dirname, '../../../fixtures/php-app').replace(/\\/g, '/');
const adapter = new PhpAdapter(ROOT);
afterAll(() => adapter.dispose());

describe('FR-31 unreachable code (PHP)', () => {
  it('FR-31.1 the project methods: every class of the own files (not vendor) with its methods', async () => {
    const keys = (await adapter.getProjectTypes()).flatMap((t) => t.methods.map((m) => m.key));
    expect(keys).toEqual(expect.arrayContaining(['src/Services/OrderService.php#OrderService.retryCharge', 'src/Http/Middleware/RequireFeature.php#RequireFeature.handle']));
    expect(keys.some((k) => k.startsWith('vendor/'))).toBe(false);
  });

  it('FR-31.1 / FR-31.2 a route\'s middleware is reached; service providers and Eloquent relations are listed as called by the framework', async () => {
    const r = (await new DiagramSession({ adapter, classifier: createClassifier(ROOT) }).findUnreachableCode())!;
    const listed = (m: string) => r.methods.find((u) => `${u.method.owner.name}.${u.method.name}` === m);
    expect(listed('RequireFeature.handle')).toBeUndefined();
    expect(listed('OrderService.retryCharge')).toMatchObject({ reason: 'no-callers' });
    expect(listed('AppServiceProvider.register')).toMatchObject({ framework: 'extends ServiceProvider' });
    expect(listed('Customer.account')).toMatchObject({ framework: 'extends Model' });
    expect(r.entryPoints).toBeGreaterThan(0);
  });

  it('FR-31.1 the callers search shares its scan between methods of one name — same callers as a fresh search — until a file changes', async () => {
    const shared = new PhpAdapter(ROOT);
    const ids = async (a: PhpAdapter, key: string) => (await a.getCallers((await a.getMethod(key))!)).map((c) => c.id);
    const one = 'src/Clients/RequestClient.php#RequestClient.handle';
    const other = 'src/Clients/RetryingRequestClient.php#RetryingRequestClient.handle';
    const first = await ids(shared, one);
    expect([first, await ids(shared, other)]).toEqual([await ids(new PhpAdapter(ROOT), one), await ids(new PhpAdapter(ROOT), other)]);
    expect(first.length).toBeGreaterThan(0);
    // the file of the first caller no longer calls handle
    const file = `${ROOT}/${first[0].split(':')[0]}`;
    await shared.updateFile(file, fs.readFileSync(file, 'utf8').replace(/->handle\(/g, '->other('));
    expect(await ids(shared, one)).not.toContain(first[0]);
  });

  it('FR-31.1 package files loaded on demand (FR-18.9) clear the shared scans: their types may resolve more calls', async () => {
    const a = new PhpAdapter(ROOT);
    const scans = () => (a as unknown as { callsByName: Map<string, unknown> }).callsByName.size;
    await a.getCallers((await a.getMethod('src/Services/QuoteService.php#QuoteService.quote'))!);
    await a.getCallers((await a.getMethod('src/Services/QuoteService.php#QuoteService.draft'))!);
    expect(scans()).toBe(2);
    // resolving the bill's calls loads the first-party billing package
    await a.getOutgoingCalls((await a.getMethod('src/Services/BillingService.php#BillingService.bill'))!);
    await a.getCallers((await a.getMethod('src/Services/QuoteService.php#QuoteService.draft'))!);
    expect(scans()).toBe(1);
  });

  it('FR-31.3 the names called in Blade templates (not in vendor / node_modules / hidden folders), lower case, counted', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-blade-')).replace(/\\/g, '/');
    try {
      for (const dir of ['resources/views/shop', 'vendor/acme/views', 'node_modules/x', '.cache']) fs.mkdirSync(`${root}/${dir}`, { recursive: true });
      fs.writeFileSync(`${root}/resources/views/shop/order.blade.php`, '<p>{{ $order->Total() }} {{ Shop::isOpen() }}</p>\n@if(formatPrice($order->total()))<b/>@endif\n');
      fs.writeFileSync(`${root}/resources/views/shop/plain.php`, '<?php $x->notBlade();');
      for (const dir of ['vendor/acme/views', 'node_modules/x', '.cache']) fs.writeFileSync(`${root}/${dir}/a.blade.php`, '{{ $x->hidden() }}');
      expect(Object.fromEntries(bladeCallNames(root))).toEqual({ total: 2, isopen: 1, if: 1, formatprice: 1 });
      expect((await new PhpAdapter(root).getTemplateCallNames()).get('total')).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

