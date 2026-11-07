import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.2 / FR-18.8 / FR-18.10 what the declarations tell about the type of an expression: the class a call goes
// to (receiverType) and the method it reaches (target). Small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): PhpAdapter {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-types-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return new PhpAdapter(root);
}

/** `name → target` of each call of `Shop.run` in `src/Shop.php` (the body given), in evaluation order. */
async function calls(body: string, files: Record<string, string> = {}, head = ''): Promise<string[]> {
  const a = open({
    'src/Domain.php': DOMAIN,
    'src/Shop.php': `<?php
namespace App;
${head}
class Shop {
  public function run(Order $order, $untyped) {
${body}
  }
}
`,
    ...files,
  });
  const cs = await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!);
  return cs.map(brief);
}

const brief = (c: CallSite) => `${c.methodName} → ${c.target?.key.replace(/^src\/Domain\.php#/, '') ?? '?'}`;

const DOMAIN = `<?php
namespace App;
class Customer { public function name() {} }
class Order {
  public ?Customer $customer = null;
  public static ?Order $last = null;
  public $next;
  public function total() {}
  public function copy(): self {}
  public function fresh(): static {}
  public function either(): Customer|Invoice {}
  public function both(): Customer&Countable {}
  public function scalars(): int|string {}
  public function count(): int {}
  /** @return Customer */
  public function buyer() {}
  public ?self $previous = null;
  /** @var self */
  public $origin;
  public static function make(): Order {}
  public static function create(): static {}
}
class Invoice extends Order { public function pay() {} public function up(): parent {} }
`;

describe('FR-18.2 PHP expression types', () => {
  it('the result of clone, a ternary (its value, else the other branch), ??, an assignment, a static call (`static` is the class called)', async () => {
    expect(
      await calls(`
    (clone $order)->total();
    ($untyped ? $order : null)->total();
    ($untyped ?: $order)->total();
    ($untyped ?? $order)->total();
    ($untyped || $order)->total();
    ($o = new Order())->total();
    Order::make()->total();
    Invoice::create()->pay();`),
    ).toEqual([
      'total → Order.total',
      'total → Order.total',
      'total → Order.total',
      'total → Order.total',
      'total → ?',
      'constructor → Order.constructor',
      'total → Order.total',
      'make → Order.make',
      'total → Order.total',
      'create → Order.create',
      'pay → Invoice.pay',
    ]);
  });

  it('static properties by their declared type; X::class and constants (also one named like a property) are no objects', async () => {
    expect(
      await calls(`
    Order::$last->total();
    $cls = Order::class;
    $cls->total();
    Order::LIMIT->total();
    Order::previous->total();
    $untyped::$last->total();`),
    ).toEqual(['total → Order.total', 'total → ?', 'total → ?', 'total → ?', 'total → ?']);
  });

  it('declared return types: self / static, a union or intersection (its first class), scalars; parent', async () => {
    expect(
      await calls(`
    $order->copy()->total();
    $order->fresh()->total();
    $order->either()->name();
    $order->both()->name();
    $order->scalars()->name();
    (new Invoice())->up()->total();`),
    ).toEqual([
      'copy → Order.copy',
      'total → Order.total',
      'fresh → Order.fresh',
      'total → Order.total',
      'either → Order.either',
      'name → Customer.name',
      'both → Order.both',
      'name → Customer.name',
      'scalars → Order.scalars',
      'name → ?',
      'constructor → Invoice.constructor',
      'up → Invoice.up',
      'total → Order.total',
    ]);
  });

  it('what is no known object: a variable variable, an anonymous class, a property of an unknown object, dynamic method names', async () => {
    expect(
      await calls(`
    $$untyped->total();
    (new class { public function total() {} })->total();
    $untyped->customer->name();
    $m = 'total';
    $order->$m();
    Order::$m();
    $order->customer->$m();`),
    ).toEqual(['total → ?', 'total → ?', 'name → ?', '$m → ?', '$m → ?', '$m → ?']);
  });
});

describe('FR-18.2 PHP property types', () => {
  it('a @property of the class doc; an untyped property by what the class assigns (constructor first, abstract methods skipped)', async () => {
    const files = {
      'src/Cart.php': `<?php
namespace App;
/** @property Customer $owner */
abstract class Cart {
  private $order;
  private $loop1;
  private $loop2;
  abstract public function size();
  public function fill() { $this->order = new Order(); }
  public function link() { $this->loop1 = $this->loop2; $this->loop2 = $this->loop1; }
}
`,
    };
    expect(
      await calls(
        `
    $cart = new Cart();
    $cart->owner->name();
    $cart->order->total();
    $cart->loop1->total();`,
        files,
      ),
    ).toEqual(['constructor → src/Cart.php#Cart.constructor', 'name → Customer.name', 'total → Order.total', 'total → ?']);
  });

  it('FR-18.8 Eloquent relation properties: to-one gives the model (also after other calls), to-many a Collection; a class name string, a relation call not on $this, an abstract or documented method: no relation (a property of the library base)', async () => {
    const files = {
      'src/Account.php': `<?php
namespace App;
/** @method Customer boss() */
class Account extends \\Illuminate\\Database\\Eloquent\\Model {
  public function owner() { return $this->belongsTo(Customer::class); }
  public function orders() { return $this->hasMany(Order::class); }
  public function plain() { return $this->belongsTo('App\\\\Customer'); }
  public function helper() { $this->touch(); return $this->hasOne(Customer::class); }
  public function legacy() { $q = new Query(); $q->hasOne(Customer::class); hasOne(Customer::class); return $q; }
  abstract public function draft();
}
`,
    };
    expect(
      await calls(
        `
    $a = new Account();
    $a->owner->name();
    $a->orders->first();
    $a->plain->name();
    $a->helper->name();
    $a->legacy->name();
    $a->draft->name();
    $a->boss->name();`,
        files,
      ),
    ).toEqual([
      'constructor → src/Account.php#Account.constructor',
      'name → Customer.name',
      'first → lib:Illuminate\\Database\\Eloquent\\Collection#Collection.first',
      'name → lib:Illuminate\\Database\\Eloquent\\Model#Model.name',
      'name → Customer.name',
      'name → lib:Illuminate\\Database\\Eloquent\\Model#Model.name',
      'name → lib:Illuminate\\Database\\Eloquent\\Model#Model.name',
      'name → lib:Illuminate\\Database\\Eloquent\\Model#Model.name',
    ]);
  });
});

describe('FR-18.2 PHP variable types', () => {
  it('an inline @var hint on the assignment (it wins over the assigned value); a later assignment wins over it; a hint for another variable says nothing', async () => {
    expect(
      await calls(`
    /** @var Customer $c */
    $c = $untyped->find();
    $c->name();
    /** @var Order $d */
    $d = $untyped->find();
    $d = new Customer();
    $d->name();
    /** @var Order $other */
    $e = $untyped->find();
    $e->total();
    $f = new Customer();
    $f = $untyped->find();
    $f->name();`),
    ).toEqual([
      'find → ?',
      'name → Customer.name',
      'find → ?',
      'constructor → Customer.constructor',
      'name → Customer.name',
      'find → ?',
      'total → ?',
      'constructor → Customer.constructor',
      'find → ?',
      // the last assignment whose type is known (`if (…) $f = <typed>; else $f = <untyped>;`)
      'name → Customer.name',
    ]);
  });

  it('a parameter reassigned: a typed value on every path replaces its declared type, one in a branch joins it, an untyped one keeps it', async () => {
    expect(await calls(`
    $order->total();
    $order = new Invoice();
    $order->pay();`)).toEqual(['total → Order.total', 'constructor → Invoice.constructor', 'pay → Invoice.pay']);
    // Order or Invoice: what they share is Order, which has no pay()
    expect(await calls(`
    if ($untyped) { $order = new Invoice(); }
    $order->pay();
    $order->total();`)).toEqual(['constructor → Invoice.constructor', 'pay → ?', 'total → Order.total']);
    expect(await calls(`
    $order = $untyped->find();
    $order->total();`)).toEqual(['find → ?', 'total → Order.total']);
  });

  it('an inline @var hint before a foreach or an if names the variable used in it', async () => {
    expect(
      await calls(`
    /** @var Customer $c */
    foreach ($untyped as $c) { $c->name(); }
    /** @var Order $o */
    if ($untyped) { $o->total(); }`),
    ).toEqual(['name → Customer.name', 'total → Order.total']);
  });

  it('different classes assigned in branches, returned by an untyped method or named in a union type: the base they share; without one, as before', async () => {
    const head = `interface Gateway { public function pay(); }
abstract class Tender implements Gateway { abstract public function pay(); public function open() {} }
class Card extends Tender { public function pay() {} }
class Cash extends Tender { public function pay() {} }
class Voucher implements Gateway { public function pay() {} }
class Picker {
  public function tender($k) { if ($k) { return new Card(); } return new Cash(); }
  public function one($k) { if ($k) { return new Card(); } return new Card(); }
  /** @return bool|Card|Cash */
  public function doc($k) {}
  public function typed($k): Card|Cash|null {}
  public function mixed($k) { if ($k) { return new Card(); } return new Customer(); }
  /** @return Card&Countable */
  public function both($k) {}
}`;
    expect(
      await calls(
        `
    switch ($untyped) { case 'card': $g = new Card(); break; case 'cash': $g = new Cash(); break; default: $g = new Voucher(); }
    $g->pay();
    if ($untyped) { $w = new Card(); } else { $w = new Cash(); }
    $w->open();
    $x = new Card();
    if ($untyped) { $x = new Cash(); }
    $x->pay();
    $y = new Card();
    $y = new Cash();
    $y->pay();
    try { $t = new Card(); } catch (\\Exception $e) { $t = new Customer(); }
    $t->pay();
    if ($untyped) { $z = new Card(); $z->pay(); }
    (new Picker())->tender(1)->open();
    (new Picker())->one(1)->pay();
    (new Picker())->doc(1)->open();
    (new Picker())->typed(1)->open();
    (new Picker())->mixed(1)->pay();
    (new Picker())->both(1)->pay();`,
        {},
        head,
      ),
    ).toEqual([
      'constructor → src/Shop.php#Card.constructor',
      'constructor → src/Shop.php#Cash.constructor',
      'constructor → src/Shop.php#Voucher.constructor',
      'pay → src/Shop.php#Gateway.pay', // the interface all three implement
      'constructor → src/Shop.php#Card.constructor',
      'constructor → src/Shop.php#Cash.constructor',
      'open → src/Shop.php#Tender.open', // the abstract base
      'constructor → src/Shop.php#Card.constructor',
      'constructor → src/Shop.php#Cash.constructor',
      'pay → src/Shop.php#Tender.pay', // the first assignment holds when the branch does not run
      'constructor → src/Shop.php#Card.constructor',
      'constructor → src/Shop.php#Cash.constructor',
      'pay → src/Shop.php#Cash.pay', // the later assignment replaces the earlier one
      'constructor → src/Shop.php#Card.constructor',
      'constructor → Customer.constructor',
      'pay → ?', // nothing shared: the last assignment, as before (a Customer has no pay)
      'constructor → src/Shop.php#Card.constructor',
      'pay → src/Shop.php#Card.pay', // the use in the same branch
      'constructor → src/Shop.php#Picker.constructor',
      'tender → src/Shop.php#Picker.tender',
      'open → src/Shop.php#Tender.open', // returns of two classes
      'constructor → src/Shop.php#Picker.constructor',
      'one → src/Shop.php#Picker.one',
      'pay → src/Shop.php#Card.pay', // the same class twice
      'constructor → src/Shop.php#Picker.constructor',
      'doc → src/Shop.php#Picker.doc',
      'open → src/Shop.php#Tender.open', // a documented union
      'constructor → src/Shop.php#Picker.constructor',
      'typed → src/Shop.php#Picker.typed',
      'open → src/Shop.php#Tender.open', // a declared one
      'constructor → src/Shop.php#Picker.constructor',
      'mixed → src/Shop.php#Picker.mixed',
      'pay → src/Shop.php#Card.pay', // returns sharing no base: the first, as before
      'constructor → src/Shop.php#Picker.constructor',
      'both → src/Shop.php#Picker.both',
      'pay → src/Shop.php#Card.pay', // an intersection: the first
    ]);
  });

  it('an abstract base without the method its subclasses share through an interface: the interface method; not when one subclass lacks it', async () => {
    expect(
      await calls(
        `
    if ($untyped) { $p = new Card(); } else { $p = new Cash(); }
    $p->refund();
    $p->refund();
    if ($untyped) { $q = new Bag(); } else { $q = new Jar(); }
    $q->refund();
    (new Picker())->base()->refund();`,
        {},
        `interface Refunds { public function refund(); }
abstract class Till {}
abstract class Middle extends Till {}
class Card extends Middle implements Refunds { public function refund() {} }
class Cash extends Till implements Refunds { public function refund() {} }
abstract class Box {}
class Bag extends Box implements Refunds { public function refund() {} }
class Jar extends Box {}
abstract class Empty_ {}
class Picker { public function base(): Empty_ {} }`,
      ),
    ).toEqual([
      'constructor → src/Shop.php#Card.constructor',
      'constructor → src/Shop.php#Cash.constructor',
      'refund → src/Shop.php#Refunds.refund', // their base Till has none: the interface both implement
      'refund → src/Shop.php#Refunds.refund',
      'constructor → src/Shop.php#Bag.constructor',
      'constructor → src/Shop.php#Jar.constructor',
      'refund → ?', // a Jar cannot refund
      'constructor → src/Shop.php#Picker.constructor',
      'base → src/Shop.php#Picker.base',
      'refund → ?', // no subclass at all
    ]);
  });

  it("a backed enum's built-in from / tryFrom: one of its cases; not on a class, not another static", async () => {
    expect(
      await calls(
        `
    Status::from('p')->label();
    Status::tryFrom('x')?->label();
    Status::cases()->label();
    Customer::from('p')->name();`,
        {},
        `enum Status: string { case Paid = 'p'; public function label() {} }`,
      ),
    ).toEqual([
      'from → lib:BackedEnum#BackedEnum.from',
      'label → src/Shop.php#Status.label',
      'tryFrom → lib:BackedEnum#BackedEnum.tryFrom',
      'label → src/Shop.php#Status.label',
      'cases → lib:BackedEnum#BackedEnum.cases',
      'label → lib:BackedEnum#BackedEnum.label', // (a list of cases, read from the library's declaration as before)
      'from → ?',
      'name → ?',
    ]);
  });

  it('a trait declaring a method abstract, another trait implementing it: the call reaches the body', async () => {
    expect(
      await calls(`    (new Basket())->add();`, {}, `trait NeedsLog { abstract protected function log(string $m); public function add() { $this->log('x'); } }
trait Logs { protected function log(string $m) {} }
class Basket { use NeedsLog; use Logs; }`),
    ).toEqual(['constructor → src/Shop.php#Basket.constructor', 'add → src/Shop.php#NeedsLog.add']);
    const a = open({ 'src/Shop.php': `<?php
namespace App;
trait NeedsLog { abstract protected function log(string $m); }
trait Logs { protected function log(string $m) {} }
class Basket { use NeedsLog; use Logs; public function add() { $this->log('x'); } }
` });
    expect((await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Basket.add'))!)).map(brief)).toEqual(['log → src/Shop.php#Logs.log']);
  });

  it('a caught exception: its first type; a catch without a variable types nothing', async () => {
    expect(
      await calls(`
    try { $order->total(); } catch (Customer|Order $e) { $e->name(); } catch (Invoice) { $e->pay(); }`),
    ).toEqual(['total → Order.total', 'name → Customer.name', 'pay → ?']);
  });

  it('foreach over a parameter documented as a list (Order[] or Collection<int, Order>); not over other sources, scalars or a single object', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Shop.php': `<?php
namespace App;
class Shop {
  /**
   * @param Order[] $list
   * @param \\Illuminate\\Support\\Collection<int, Customer> $people
   * @param array $plain
   * @param Customer $one
   */
  public function run($list, $people, $plain, $one) {
    foreach ($list as $o) { $o->total(); }
    foreach ($people as $p) { $p->name(); }
    foreach ($plain as $x) { $x->total(); }
    foreach ($one as $z) { $z->name(); }
    foreach ($this->list as $y) { $y->total(); }
  }
}
`,
    });
    const cs = await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!);
    expect(cs.map(brief)).toEqual(['total → Order.total', 'name → Customer.name', 'total → ?', 'name → ?', 'total → ?']);
  });

  it('closures: a variable from `use (…)` or captured by an arrow function has its type outside; an untyped closure parameter is the library\'s value', async () => {
    expect(
      await calls(`
    $c = new Customer();
    array_map(function ($i) use ($c) { $c->name(); }, [1]);
    array_map(fn ($i) => $c->name(), [1]);
    array_map(function ($c) { $c->name(); }, [1]);
    array_map(function ($i) { $c->name(); }, [1]);`),
    ).toEqual([
      'constructor → Customer.constructor',
      'array_map → lib:php#<global>.array_map',
      'name → Customer.name',
      'array_map → lib:php#<global>.array_map',
      'name → Customer.name',
      'array_map → lib:php#<global>.array_map',
      'name → lib:php#php.name',
      'array_map → lib:php#<global>.array_map',
      'name → ?',
    ]);
  });
});

describe('FR-18.2 PHP return types', () => {
  it('@method docs; a declared scalar with a @return class; untyped methods returning what they build (not a closure\'s value); a cycle of untyped methods ends', async () => {
    const files = {
      'src/Maker.php': `<?php
namespace App;
/** @method Customer magic() */
class Maker {
  /** @return Customer */
  public function documented(): mixed {}
  public function built() { $f = function () { return new Customer(); }; return new Order(); }
  public function ping() { return $this->pong(); }
  public function pong() { return $this->ping(); }
  public function __call($m, $a) {}
}
interface Source { public function get(); }
`,
    };
    expect(
      await calls(
        `
    $m = new Maker();
    $m->magic()->name();
    $m->documented()->name();
    $m->built()->total();
    $m->ping()->total();`,
        files,
      ),
    ).toEqual([
      'constructor → src/Maker.php#Maker.constructor',
      'magic → ?',
      'name → Customer.name',
      'documented → src/Maker.php#Maker.documented',
      'name → Customer.name',
      'built → src/Maker.php#Maker.built',
      'total → Order.total',
      'ping → src/Maker.php#Maker.ping',
      'total → ?',
    ]);
  });
});

describe('FR-18.2 PHP helpers', () => {
  it('an object the container builds by class: app()->make, $this->app->make, $app->makeWith, App::make, a typed Container; a property set that way', async () => {
    const files = {
      'src/Billing.php': `<?php
namespace App;
use Illuminate\\Support\\Facades\\App;
use Illuminate\\Container\\Container;
class Billing {
  private $order;
  public function __construct() { $this->order = app()->make(Order::class); }
  public function run($app, Container $box, $other) {
    $this->app->make(Customer::class)->name();
    $app->makeWith(Order::class, ['id' => 1])->total();
    App::make(Customer::class)->name();
    $box->make(Order::class)->total();
    $this->order->total();
    $other->make(Order::class)->total();
    app()->make('orders')->total();
    $other::make(Order::class)->total();
  }
}
`,
    };
    const a = open({ 'src/Domain.php': DOMAIN, ...files });
    const m = (await a.getMethod('src/Billing.php#Billing.run'))!;
    const named = (await a.getOutgoingCalls(m)).filter((c) => c.methodName === 'name' || c.methodName === 'total').map((c) => `${c.methodName} → ${c.target ? c.target.key.replace(/^src\/Domain\.php#/, '') : '?'}`);
    expect(named).toEqual(['name → Customer.name', 'total → Order.total', 'name → Customer.name', 'total → Order.total', 'total → Order.total', 'total → ?', 'total → lib:php#php.total', 'total → ?']); // an untyped receiver: unknown; a string id: a library value; a class held in a variable: unknown
    await a.dispose();
  });

  it('app() / resolve() with a class give it; with anything else a library value; collect() a Collection', async () => {
    expect(
      await calls(`
    app(Order::class)->total();
    resolve(Customer::class)->name();
    app('orders')->total();
    app()->make('x');
    collect([])->first();`),
    ).toEqual([
      'app → lib:php#<global>.app',
      'total → Order.total',
      'resolve → lib:php#<global>.resolve',
      'name → Customer.name',
      'app → lib:php#<global>.app',
      'total → lib:php#php.total',
      'app → lib:php#<global>.app',
      'make → lib:php#php.make',
      'collect → lib:php#<global>.collect',
      'first → lib:Illuminate\\Support\\Collection#Collection.first',
    ]);
  });
});

describe('FR-18.2 PHP types: more shapes', () => {
  it('an interface method without a return type gives nothing to chain on; a @return doc does; a scalar return type is no class', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Shop.php': `<?php
namespace App;
interface Source { public function get(); }
class Shop {
  public function run(Source $source, Order $order) {
    $source->get()->total();
    $order->buyer()->name();
    $order->count()->total();
  }
}
`,
    });
    const cs = await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!);
    expect(cs.map(brief)).toEqual(['get → src/Shop.php#Source.get', 'total → ?', 'buyer → Order.buyer', 'name → Customer.name', 'count → Order.count', 'total → ?']);
  });

  it('a property typed self (declared or documented) is the declaring class', async () => {
    expect(await calls(`
    $order->previous->total();
    $order->origin->total();`)).toEqual(['total → Order.total', 'total → Order.total']);
  });

  it('chains through calls the scan cannot name: dynamic method names, an unknown class, a callable variable; an array element', async () => {
    expect(
      await calls(`
    // (variables named like methods that exist: the name is the variable's value, not its name)
    $copy = 'x';
    $order->$copy()->total();
    $make = 'x';
    Order::$make()->total();
    $untyped::make()->total();
    $f = 'make';
    $f()->total();
    $list = [$order];
    $list[0]->total();`),
    ).toEqual(['$copy → ?', 'total → ?', '$make → ?', 'total → ?', 'make → ?', 'total → ?', '$f → ?', 'total → ?', 'total → ?']);
  });

  it('a value from a library call reaches a closure through `use` (only then); a closure parameter of the same name hides it', async () => {
    expect(
      await calls(`
    $store = cache()->store();
    array_map(function ($i) use ($store) { $store->get($i); }, [1]);
    array_map(fn ($store) => $store->get(), [1]);
    array_map(function ($i) { $store->forget(); }, [1]);`),
    ).toEqual([
      'cache → lib:php#<global>.cache',
      'store → lib:Illuminate\\Cache\\CacheManager#CacheManager.store',
      'array_map → lib:php#<global>.array_map',
      'get → lib:Illuminate\\Cache\\CacheManager#CacheManager.get',
      'array_map → lib:php#<global>.array_map',
      'get → lib:php#php.get',
      // not in `use (…)`: no value from outside
      'array_map → lib:php#<global>.array_map',
      'forget → ?',
    ]);
  });

  it('a nullsafe call on a library value keeps the library type', async () => {
    expect(await calls(`
    $d = now();
    $d?->copy()->format('Y');`)).toEqual([
      'now → lib:php#<global>.now',
      'copy → lib:Illuminate\\Support\\Carbon#Carbon.copy',
      'format → lib:Illuminate\\Support\\Carbon#Carbon.format',
    ]);
  });

  it('a fluent chain is followed 12 calls deep (the analysis stays bounded)', async () => {
    const chain = (n: number) => `$order${'->copy()'.repeat(n)}->total();`;
    const last = async (n: number) => (await calls(chain(n))).at(-1);
    expect(await last(12)).toBe('total → Order.total');
    expect(await last(13)).toBe('total → ?');
  });
});

describe('mock expectations in PHP tests', () => {
  it('shouldReceive / expects and the chain after them are library calls (Mockery MockInterface), on an unknown receiver or a mocked project class', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'tests/OrderTest.php': `<?php
namespace App;
class OrderTest {
  private Order $order;
  public function test_it($mock, $other) {
    $mock->shouldReceive('save')->once()->andReturn(true);
    $this->order->shouldReceive('total')->twice();
    $this->order->total();
    $mock->allows('find')->andReturns(null);
    $other->expects($this)->method('x')->willReturn(1);
    $other->unrelated()->once();
  }
}
`,
    });
    const m = (await a.getMethod('tests/OrderTest.php#OrderTest.test_it'))!;
    const rows = (await a.getOutgoingCalls(m)).map((c) => `${c.methodName} → ${c.isLibrary ? `lib ${c.target!.owner.name}` : c.target ? c.target.key.replace(/^src\/Domain\.php#/, '') : '?'}`);
    expect(rows).toEqual([
      'shouldReceive → lib MockInterface', 'once → lib MockInterface', 'andReturn → lib MockInterface',
      'shouldReceive → lib MockInterface', 'twice → lib MockInterface',
      'total → Order.total',
      'allows → lib MockInterface', 'andReturns → lib MockInterface',
      'expects → lib MockInterface', 'method → lib MockInterface', 'willReturn → lib MockInterface',
      'unrelated → ?', 'once → ?',
    ]);
    await a.dispose();
  });
});
