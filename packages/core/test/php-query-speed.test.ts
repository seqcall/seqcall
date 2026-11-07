import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { children, parsePhp } from '../src/php/ast';
import { PhpAdapter } from '../src/php/php-adapter';

// Shortcuts that make a PHP design-issue scan faster: lists kept per parsed tree (a node's children, a body's calls by
// name). Each must answer what was answered before, and follow an edit (an edited file is parsed anew).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): { a: PhpAdapter; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-speed-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return { a: new PhpAdapter(root), root };
}

const callersOf = async (a: PhpAdapter, key: string) => (await a.getCallers((await a.getMethod(key))!)).map((c) => `${c.enclosing.key} ${c.preview}${c.passed ? ' (passed)' : ''}`);

const SHOP = `<?php
namespace App;
class Order { public function __construct(int $n) {} public function pay() {} }
class Express extends Order { public function __construct() { parent::__construct(0); } }
class Shop {
  public function checkout(Order $o) { $o->pay(); $f = $o->pay(...); return new Order(1); }
  public function nested(Order $o) { return function () use ($o) { $o->pay(); }; }
}
`;

describe('PHP lists kept per parsed tree (FR-4.1, FR-31)', () => {
  it("a node's children: the same list when asked again, in source order", () => {
    const program = parsePhp('<?php\nfunction a() { b(); c(); }\n', 'x.php');
    const list = children(program);
    expect(children(program)).toBe(list);
    const fn = list[0];
    expect(children(fn.body).map((s) => s.expression.what.name)).toEqual(['b', 'c']);
    // a copy with other arguments lists its own children, not the kept list of the node it was copied from
    const call = children(fn.body)[0].expression;
    expect(children(call)).toHaveLength(1);
    expect(children({ ...call, arguments: [] })).toHaveLength(1);
    expect(children({ ...call, what: undefined })).toHaveLength(0);
  });

  it('FR-4.1 callers by name: calls, first-class callables, closures, `new` and `parent::__construct` — the same when asked again', async () => {
    const { a } = open({ 'src/Shop.php': SHOP });
    const pay = [
      'src/Shop.php#Shop.checkout public function checkout(Order $o) { $o->pay(); $f = $o->pay(...); return new Order(1); }',
      'src/Shop.php#Shop.checkout public function checkout(Order $o) { $o->pay(); $f = $o->pay(...); return new Order(1); } (passed)',
      'src/Shop.php#Shop.nested public function nested(Order $o) { return function () use ($o) { $o->pay(); }; }',
    ];
    const ctor = [
      'src/Shop.php#Express.constructor class Express extends Order { public function __construct() { parent::__construct(0); } }',
      'src/Shop.php#Shop.checkout public function checkout(Order $o) { $o->pay(); $f = $o->pay(...); return new Order(1); }',
    ];
    expect(await callersOf(a, 'src/Shop.php#Order.pay')).toEqual(pay);
    expect(await callersOf(a, 'src/Shop.php#Order.constructor')).toEqual(ctor);
    expect(await callersOf(a, 'src/Shop.php#Order.pay')).toEqual(pay);
  });

  it('FR-4.1 callers from a trait used by one class: `$this` in each of its methods is that class', async () => {
    const { a } = open({
      'src/Cart.php': `<?php
namespace App;
trait Totals { public function sum() { return $this->add(); } public function avg() { return $this->add(); } }
class Cart { use Totals; public function add() { return 1; } }
`,
    });
    expect(await callersOf(a, 'src/Cart.php#Cart.add')).toEqual([
      'src/Cart.php#Totals.sum trait Totals { public function sum() { return $this->add(); } public function avg() { return $this->add(); } }',
      'src/Cart.php#Totals.avg trait Totals { public function sum() { return $this->add(); } public function avg() { return $this->add(); } }',
    ]);
    // the calls of each of its methods: the sole user is found once, for both
    for (const m of ['sum', 'avg']) {
      const calls = await a.getOutgoingCalls((await a.getMethod(`src/Cart.php#Totals.${m}`))!);
      expect(calls.map((c) => c.target?.key)).toEqual(['src/Cart.php#Cart.add']);
    }
  });

  it('FR-4.1 callers follow an edit: a call added, a call removed', async () => {
    const { a, root } = open({ 'src/Shop.php': SHOP });
    expect(await callersOf(a, 'src/Shop.php#Order.pay')).toHaveLength(3);
    const edited = SHOP.replace('$o->pay(); $f = $o->pay(...); ', '').replace("{ return function () use ($o) { $o->pay(); }; }", '{ $o->pay(); $o->pay(); }');
    await a.updateFile(`${root}/src/Shop.php`, edited);
    expect(await callersOf(a, 'src/Shop.php#Order.pay')).toEqual([
      'src/Shop.php#Shop.nested public function nested(Order $o) { $o->pay(); $o->pay(); }',
      'src/Shop.php#Shop.nested public function nested(Order $o) { $o->pay(); $o->pay(); }',
    ]);
  });

  it('per-method answers: asked again the same (a copy), new after an edit, dropped when package files load', async () => {
    const { a, root } = open({
      'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
return array('Shop\\\\Pay\\\\' => array($vendorDir . '/shop/pay/src'));
`,
      'vendor/shop/pay/src/Gateway.php': `<?php
namespace Shop\\Pay;
interface Gateway { public function charge(); }
`,
      'vendor/shop/pay/src/Card.php': `<?php
namespace Shop\\Pay;
class Card implements Gateway { public function charge() {} }
`,
      'src/Shop.php': SHOP,
    });
    const memo = (a as unknown as { memo: Map<string, unknown> }).memo;
    const checkout = (await a.getMethod('src/Shop.php#Shop.checkout'))!;
    const first = await a.getOutgoingCalls(checkout);
    expect(first.map((c) => c.methodName)).toEqual(['pay', 'constructor']);
    first.reverse();
    expect((await a.getOutgoingCalls(checkout)).map((c) => c.methodName)).toEqual(['pay', 'constructor']);
    expect(await a.getEarlyExits(checkout)).toEqual([]);
    expect((await a.getReturns(checkout)).length).toBe(1);
    expect(memo.size).toBe(3);

    await a.updateFile(`${root}/src/Shop.php`, SHOP.replace('$o->pay(); $f = $o->pay(...); ', ''));
    expect(memo.size).toBe(0);
    expect((await a.getOutgoingCalls(checkout)).map((c) => c.methodName)).toEqual(['constructor']);

    // the implementations of a package interface load its package: the answers so far are dropped at the next query
    const charge = (await a.getMethod('vendor/shop/pay/src/Gateway.php#Gateway.charge'))!;
    expect((await a.getImplementations(charge)).map((m) => m.key)).toEqual(['vendor/shop/pay/src/Card.php#Card.charge']);
    await a.getReturns(checkout);
    expect([...memo.keys()]).toEqual([`returns\0${checkout.key}`]);
  });
});
