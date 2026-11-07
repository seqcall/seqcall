import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MethodRef } from '@seqcall/protocol';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.3 implementations and FR-4.1 / FR-4.5 callers in PHP, on small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): PhpAdapter {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-callers-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return new PhpAdapter(root);
}

const method = async (a: PhpAdapter, key: string) => (await a.getMethod(key))!;
const callersOf = async (a: PhpAdapter, key: string) => (await a.getCallers(await method(a, key))).map((c) => `${c.enclosing.key} ${c.preview}${c.passed ? ' (passed)' : ''}${c.inTest ? ' (test)' : ''}`);

describe('FR-18.3 PHP implementations', () => {
  it('of an interface / abstract method: only classes whose method has a body (not one still to be written)', async () => {
    const a = open({
      'src/Payments.php': `<?php
namespace App;
interface Gateway { public function charge(int $cents); }
abstract class BaseGateway implements Gateway { abstract public function charge(int $cents); }
class Stripe extends BaseGateway { public function charge(int $cents) { return $cents; } }
class Draft extends BaseGateway {}
class Bare implements Gateway {}
`,
    });
    const impls = async (key: string) => (await a.getImplementations(await method(a, key))).map((m) => m.key);
    expect(await impls('src/Payments.php#Gateway.charge')).toEqual(['src/Payments.php#Stripe.charge']);
    expect(await impls('src/Payments.php#BaseGateway.charge')).toEqual(['src/Payments.php#Stripe.charge']);
  });

  it('an interface declared twice (an old copy loaded after it): classes without the method, or with only an @method doc, are no implementations', async () => {
    const a = open({
      'src/Gateway.php': '<?php namespace App; interface Gateway { public function charge(int $cents); }',
      'src/old/Gateway.php': '<?php namespace App; interface Gateway {}',
      'src/Stripe.php': `<?php
namespace App;
class Stripe implements Gateway { public function charge(int $cents) { return $cents; } }
/** @method int charge(int $cents) */
class Magic implements Gateway { public function __call($m, $a) {} }
class Bare implements Gateway {}
`,
    });
    expect((await a.getImplementations(await method(a, 'src/Gateway.php#Gateway.charge'))).map((m) => m.key)).toEqual(['src/Stripe.php#Stripe.charge']);
  });
});

describe('FR-4.1 PHP callers', () => {
  it('callers of a constructor are the `new` expressions of its class (also through a subclass without its own)', async () => {
    const a = open({
      'src/Order.php': `<?php
namespace App;
class Order { public function __construct(public int $id) {} }
class Express extends Order {}
class Shop {
  public function place() { return new Order(1); }
  public function rush() { return new Express(2); }
  public function other() { return new \\DateTime(); }
}
`,
    });
    expect(await callersOf(a, 'src/Order.php#Order.constructor')).toEqual([
      'src/Order.php#Shop.place public function place() { return new Order(1); }',
      'src/Order.php#Shop.rush public function rush() { return new Express(2); }',
    ]);
  });

  it('callers of a constructor that replaces its parent\'s: `new` of its class only (never `new Parent`)', async () => {
    const a = open({
      'src/Order.php': `<?php
namespace App;
class Order { public function __construct(public int $id) {} }
class Express extends Order { public function __construct() { parent::__construct(0); } }
class Shop {
  public function place() { return new Order(1); }
  public function rush() { return new Express(); }
}
`,
    });
    expect(await callersOf(a, 'src/Order.php#Express.constructor')).toEqual(['src/Order.php#Shop.rush public function rush() { return new Express(); }']);
    expect(await callersOf(a, 'src/Order.php#Order.constructor')).toEqual([
      'src/Order.php#Express.constructor class Express extends Order { public function __construct() { parent::__construct(0); } }',
      'src/Order.php#Shop.place public function place() { return new Order(1); }',
    ]);
  });

  it('callers of a function, and calls passed as first-class callables (`fn(...)`, `$this->m(...)`)', async () => {
    const a = open({
      'src/helpers.php': `<?php
namespace App;
function money(int $cents) { return $cents / 100; }
`,
      'src/Shop.php': `<?php
namespace App;
class Shop {
  public function total() {
    $f = money(...);
    return money(5);
  }
  public function tax() {}
  public function all() { return array_map($this->tax(...), []); }
}
`,
    });
    expect(await callersOf(a, 'src/helpers.php#<module>.money')).toEqual([
      'src/Shop.php#Shop.total $f = money(...); (passed)',
      'src/Shop.php#Shop.total return money(5);',
    ]);
    expect(await callersOf(a, 'src/Shop.php#Shop.tax')).toEqual(['src/Shop.php#Shop.all public function all() { return array_map($this->tax(...), []); } (passed)']);
  });

  it('callers of an implementation: calls through its interface, from files that never name the implementation', async () => {
    const a = open({
      'src/Gateway.php': `<?php
namespace App;
interface Gateway { public function charge(int $cents); }
class Stripe implements Gateway { public function charge(int $cents) { return $cents; } }
`,
      'src/Checkout.php': `<?php
namespace App;
class Checkout { public function pay(Gateway $gateway) { return $gateway->charge(100); } }
`,
    });
    expect(await callersOf(a, 'src/Gateway.php#Stripe.charge')).toEqual(['src/Checkout.php#Checkout.pay class Checkout { public function pay(Gateway $gateway) { return $gateway->charge(100); } }']);
  });

  it('a method that does not exist (any more) has no callers', async () => {
    const a = open({ 'src/Shop.php': '<?php class Shop { public function total() { $this->tax(); } }' });
    const gone: MethodRef = { key: 'src/Shop.php#Shop.tax', name: 'tax', owner: { key: 'src/Shop.php#Shop', name: 'Shop', kind: 'class' }, isStatic: false, hasBody: true };
    expect(await a.getCallers(gone)).toEqual([]);
  });

  it('a project method implementing a package interface: callers in package code through it; a method of the same name without one: none from there', async () => {
    const a = open({
      'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
return array('Shop\\\\Pay\\\\' => array($vendorDir . '/shop/pay/src'));
`,
      'vendor/shop/pay/src/Settings.php': `<?php
namespace Shop\\Pay;
interface Settings { public function read(); }
`,
      'vendor/shop/pay/src/Editor.php': `<?php
namespace Shop\\Pay;
class Editor { public function show() { return resolve(Settings::class)->read(); } }
`,
      'src/Store.php': `<?php
namespace App;
class Store implements \\Shop\\Pay\\Settings { public function read() {} }
class Note { public function read() {} }
`,
    });
    expect(await callersOf(a, 'src/Store.php#Store.read')).toEqual([
      'vendor/shop/pay/src/Editor.php#Editor.show class Editor { public function show() { return resolve(Settings::class)->read(); } }',
    ]);
    expect(await callersOf(a, 'src/Store.php#Note.read')).toEqual([]);
  });

  it("a trait's variable holding `$this` is the using class: the same use read for each class that uses the trait", async () => {
    const a = open({
      'src/Shop.php': `<?php
namespace App;
trait Pings { public function run() { $me = $this; $me->ping(); } }
class Order { use Pings; public function ping() {} }
class Invoice { use Pings; public function ping() {} }
`,
    });
    // (two classes use the trait: on its own, \$this is the trait, which has no ping)
    expect((await a.getOutgoingCalls(await method(a, 'src/Shop.php#Pings.run'))).map((c) => c.target?.key ?? '?')).toEqual(['?']);
    expect(await callersOf(a, 'src/Shop.php#Order.ping')).toEqual(['src/Shop.php#Pings.run trait Pings { public function run() { $me = $this; $me->ping(); } }']);
    expect(await callersOf(a, 'src/Shop.php#Invoice.ping')).toEqual(['src/Shop.php#Pings.run trait Pings { public function run() { $me = $this; $me->ping(); } }']);
  });
});
