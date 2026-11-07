import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.2 / FR-1.11 / FR-1.13 / FR-5.4 the calls of a PHP method: targets, library calls, receivers, arguments,
// results, closures. Small projects written per test (also half-typed code).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): PhpAdapter {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-calls-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return new PhpAdapter(root);
}

const DOMAIN = `<?php
namespace App;
class Base { public function save($what) {} }
class Order extends Base {
  public function total() {}
  public function process(callable $fn) { return $fn(1); }
  public function format($v) { return $v; }
}
class Customer { public function name() {} }
`;

/** The call sites of `Shop.run` (its body given) in `src/Shop.php`. */
async function sites(body: string, params = 'Order $order, $untyped', files: Record<string, string> = {}): Promise<CallSite[]> {
  const a = open({
    'src/Domain.php': DOMAIN,
    'src/Shop.php': `<?php
namespace App;
class Shop {
  private $order;
  public function run(${params}) {
${body}
  }
}
`,
    ...files,
  });
  return a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!);
}

const target = (c: CallSite) => `${c.methodName} → ${c.target?.key.replace(/^src\/Domain\.php#/, '') ?? '?'}${c.isLibrary ? ` (${c.libraryName})` : ''}`;

describe('FR-18.2 PHP calls: targets', () => {
  it('library names: the first two namespace segments, one when there is only one, php for global names', async () => {
    const cs = await sites(`
    \\Illuminate\\Support\\Str::of('x');
    \\Stripe\\Charge::create();
    strlen('x');`);
    expect(cs.map(target)).toEqual([
      'of → lib:Illuminate\\Support\\Str#Str.of (Illuminate\\Support)',
      'create → lib:Stripe\\Charge#Charge.create (Stripe)',
      'strlen → lib:php#<global>.strlen (php)',
    ]);
  });

  it('a method neither the class nor its project bases declare is unresolved (no library base to give it to)', async () => {
    const cs = await sites(`
    $order->missing();`);
    expect(cs.map(target)).toEqual(['missing → ?']);
  });

  it('calls of what is no method name: a variable variable, a closure called in place', async () => {
    const cs = await sites(`
    $name = 'f';
    $$name();
    (fn () => 1)();`);
    expect(cs.map((c) => `${c.methodName} ${c.receiver.kind}`)).toEqual(['$$name expression', 'fn () => 1 expression']);
  });

  it('a method without a body has no calls', async () => {
    const a = open({ 'src/Shop.php': '<?php abstract class Shop { abstract public function run(); }' });
    expect(await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!)).toEqual([]);
  });
});

describe('FR-18.2 PHP calls on library values', () => {
  it('a property of a library object; a parameter of a closure passed to a library call (also by name, also to `new`); not a typed one', async () => {
    const cs = await sites(`
    $d = now();
    $d->timezone->getName();
    \\Lib\\Router::group(callback: fn ($r) => $r->get('x'));
    new \\Lib\\Pipeline(fn ($p) => $p->send());
    array_map(fn (int $i) => $i->format(), [1]);`);
    expect(cs.map(target)).toEqual([
      'now → lib:php#<global>.now (php)',
      'getName → lib:Illuminate\\Support\\Carbon#Carbon.getName (Illuminate\\Support)',
      'group → lib:Lib\\Router#Router.group (Lib)',
      'get → lib:Lib\\Router#Router.get (Lib)',
      'constructor → lib:Lib\\Pipeline#Pipeline.constructor (Lib)',
      'send → lib:Lib\\Pipeline#Pipeline.send (Lib)',
      'array_map → lib:php#<global>.array_map (php)',
      'format → ?',
    ]);
  });
});

describe('FR-18.2 PHP project methods that return library values', () => {
  it('a call on the result of a project method without a return type that returns a library value (from its parameter) is a library call', async () => {
    const cs = await sites(
      `
    $c = new Cache();
    $c->pick('orders')->get('k');`,
      'Order $order, $untyped',
      { 'src/Cache.php': '<?php namespace App; class Cache { public function pick($name) { return cache()->store($name); } }' },
    );
    expect(cs.map(target)).toEqual([
      'constructor → src/Cache.php#Cache.constructor',
      'pick → src/Cache.php#Cache.pick',
      'get → lib:Illuminate\\Cache\\CacheManager#CacheManager.get (Illuminate\\Cache)',
    ]);
  });
});

describe('FR-1.11 PHP closures passed to library calls', () => {
  it('iteration: each <param> of <collection> (a chain, a property, a call without arguments; … when there is none); by name too', async () => {
    const cs = await sites(`
    collect()->each(function () { $this->order->total(); });
    $this->order->find(1)->items->each(fn ($i) => $i->total());
    array_map(fn ($o) => $o->total());
    collect([1])->map(callback: fn ($c) => $c->name());`);
    expect(cs.filter((c) => c.fragments).map((c) => `${c.methodName}: ${c.fragments!.map((f) => `${f.kind} ${f.guard}`).join(' / ')}`)).toEqual([
      'total: loop each of collect()',
      'total: loop each $i of $this->order->find(…)->items',
      'total: loop each $o of …',
      'name: loop each $c of collect(…)',
    ]);
  });

  it('half-typed closures (no body yet) add no calls', async () => {
    const cs = await sites(`
    array_map(function ($x), [1]);
    array_map(fn ($x) => , [1]);
    $order->total();`);
    expect(cs.map(target)).toEqual(['array_map → lib:php#<global>.array_map (php)', 'array_map → lib:php#<global>.array_map (php)', 'total → Order.total']);
  });
});

describe('FR-18.2 / FR-5.4 PHP arguments and results', () => {
  it('argument origins: $this, a named argument, an object created in place (not an anonymous class), a half-typed named argument', async () => {
    const cs = await sites(`
    $order->save($this);
    $order->save(what: $untyped);
    $order->save(new Customer());
    $order->save(new class {});
    $order->save(what: );`);
    expect(cs.filter((c) => c.methodName === 'save').map((c) => c.argOrigins)).toEqual([
      [{ kind: 'self' }],
      [{ kind: 'parameter', name: 'untyped' }],
      [{ kind: 'created', ordinal: 2 }],
      undefined,
      undefined,
    ]);
  });

  it('an object created into a field is assigned to it; into another object\'s property or an array element: to nothing known', async () => {
    const cs = await sites(`
    $this->order = new Order();
    $untyped->order = new Order();
    $list[0] = new Order();`);
    expect(cs.map((c) => c.assignedTo)).toEqual([{ kind: 'field', name: 'order' }, undefined, undefined]);
  });
});

describe('FR-1.13 PHP functions passed as arguments', () => {
  it('first-class callables: a project method, a library function; a callable variable is none', async () => {
    const cs = await sites(`
    $order->process($order->format(...));
    $order->process(strlen(...));
    $order->process($untyped(...));`);
    expect(cs.filter((c) => c.methodName === 'process').map((c) => c.argFunctions)).toEqual([
      [{ kind: 'method', target: expect.objectContaining({ key: 'src/Domain.php#Order.format' }), receiver: { kind: 'parameter', name: 'order' }, receiverType: expect.objectContaining({ key: 'src/Domain.php#Order' }), isLibrary: false }],
      [{ kind: 'method', target: expect.objectContaining({ key: 'lib:php#<global>.strlen' }), receiver: { kind: 'module', name: 'strlen' }, isLibrary: true, libraryName: 'php' }],
      undefined,
    ]);
  });

  it('a closure passed to a project method (also by name) carries its calls; a half-typed one carries none', async () => {
    const cs = await sites(`
    $order->process(fn: function ($v) { $v->name(); });
    $order->process(function ($v));`);
    expect(cs.filter((c) => c.methodName === 'process').map((c) => c.argFunctions?.map((f) => (f?.kind === 'lambda' ? { params: f.params, calls: f.calls?.map(target) } : f)))).toEqual([
      [{ params: ['v'], calls: ['name → ?'] }],
      [{ params: ['v'], calls: [] }],
    ]);
  });
});

describe('FR-4.1 PHP callers', () => {
  it('a call inside a class declared in a method body is that class\'s, not the method\'s', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Shop.php': `<?php
namespace App;
class Shop {
  public function run(Order $order) {
    $order->total();
    return new class { public function later(Order $o) { $o->total(); } };
  }
}
`,
    });
    const callers = await a.getCallers((await a.getMethod('src/Domain.php#Order.total'))!);
    expect(callers.map((c) => `${c.enclosing.key} ${c.range.start.line}`)).toEqual(['src/Shop.php#Shop.run 4']);
  });
});

describe('FR-18.2 PHP calls in half-typed code', () => {
  it('a call whose argument list is not closed yet: the other calls are still there', async () => {
    const cs = await sites(`
    $order->total();
    $order->save(`);
    expect(cs.map(target)).toEqual(['total → Order.total', 'save → Base.save']);
  });

  it('a call without a callee (php-parser\'s recovery from `foreach ($x as (function () {…})()`): no target; the calls in its closure are a callback', async () => {
    const cs = await sites(`
    foreach ($untyped as
    (function () { inner(); })();
    $order->total();`);
    expect(cs.map((c) => `${target(c)}: ${c.fragments?.map((f) => `${f.kind} ${f.guard}`).join(' / ') ?? ''}`)).toEqual([
      ' → ?: loop each (function () { inner(); })() of $untyped',
      'inner → lib:php#<global>.inner (php): loop each (function () { inner(); })() of $untyped / callback ',
      '(function () { inner(); }) → ?: loop each (function () { inner(); })() of $untyped',
      'total → Order.total: ',
    ]);
  });

  it('`new` without a class yet creates nothing known', async () => {
    const cs = await sites(`
    $x = new ;
    $order->total();`);
    expect(cs.map(target)).toEqual(['constructor → ?', 'total → Order.total']);
  });
});
