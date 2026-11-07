import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MethodRef } from '@seqcall/protocol';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.1 / FR-31.1 / FR-5.8 / FR-1.15 the PHP adapter's queries by file, position and key, on small projects
// written per test (also broken, half-typed files: the parser recovers from syntax errors).
const dirs: string[] = [];
const adapters: PhpAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): { root: string; adapter: PhpAdapter } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-q-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  const adapter = new PhpAdapter(root);
  adapters.push(adapter);
  return { root, adapter };
}

const ref = (key: string): MethodRef => ({ key, name: key.replace(/^.*\./, ''), owner: { key: key.replace(/\.[^.]*$/, ''), name: '', kind: 'class' }, isStatic: false, hasBody: true });

const SHOP = `<?php
namespace App;
class Order {
  public function total() { return 1; }
  private static function tax() {}
}
interface Payable { public function pay(int $amount, string $currency); }
function money_format($v) { return $v; }
`;

describe('FR-31.1 PHP: the classes and functions of a file', () => {
  it('each class with its methods (constructors as "constructor"), the file\'s functions as its module; an unknown file has none', async () => {
    const { root, adapter } = open({ 'src/Shop.php': SHOP.replace('public function total', 'public function __construct() {}\n  public function total') });
    const types = await adapter.getFileTypes(`${root}/src/Shop.php`);
    expect(types.map((t) => ({ type: `${t.type.kind} ${t.type.key}`, methods: t.methods.map((m) => `${m.key} static=${m.isStatic} body=${m.hasBody}`) }))).toEqual([
      {
        type: 'class src/Shop.php#Order',
        methods: ['src/Shop.php#Order.constructor static=false body=true', 'src/Shop.php#Order.total static=false body=true', 'src/Shop.php#Order.tax static=true body=true'],
      },
      { type: 'interface src/Shop.php#Payable', methods: ['src/Shop.php#Payable.pay static=false body=false'] },
      { type: 'module src/Shop.php#<module>', methods: ['src/Shop.php#<module>.money_format static=true body=true'] },
    ]);
    expect(await adapter.getFileTypes(`${root}/src/Missing.php`)).toEqual([]);
  });

  it('a file of classes only has no module', async () => {
    const { root, adapter } = open({ 'src/Order.php': '<?php class Order { public function total() {} }' });
    expect((await adapter.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order']);
  });

  it('a file nested too deep for the parser counts as empty; the other files still load', async () => {
    const deep = `<?php class Generated { public function data() { return ${'['.repeat(5000)}${']'.repeat(5000)}; } }`;
    const { root, adapter } = open({ 'src/Generated.php': deep, 'src/Order.php': '<?php class Order { public function total() {} }' });
    expect(await adapter.getFileTypes(`${root}/src/Generated.php`)).toEqual([]);
    expect((await adapter.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order']);
  });

  it('a file that ends right after `enum` / `enum Name` (typed, not saved yet) is parsed (php-parser loops forever on it)', async () => {
    const { root, adapter } = open({ 'src/Order.php': '<?php class Order { public function total() {} }' });
    await adapter.updateFile(`${root}/src/Order.php`, '<?php\nclass Order { public function total() {} }\nenum Status');
    expect((await adapter.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order', 'src/Order.php#Status']);
    await adapter.updateFile(`${root}/src/Order.php`, '<?php\nclass Order { public function total() {} }\nenum');
    expect((await adapter.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order']);
  });
});

describe('FR-18.1 PHP: the method at the cursor and methods by key', () => {
  it('the cursor in a method, in a function, between them (none), past the end of the file (none); an unknown file has none', async () => {
    const { root, adapter } = open({ 'src/Shop.php': SHOP });
    const at = async (line: number, character = 4) => (await adapter.findEnclosingCallable(`${root}/src/Shop.php`, { line, character }))?.key;
    expect(await at(3)).toBe('src/Shop.php#Order.total');
    expect(await at(7, 30)).toBe('src/Shop.php#<module>.money_format');
    expect(await at(1)).toBeUndefined(); // the namespace line: outside every class and function
    expect(await at(5, 0)).toBeUndefined(); // the class's closing brace: in the class, in no method
    expect(await at(40)).toBeUndefined();
    expect(await adapter.findEnclosingCallable(`${root}/src/Missing.php`, { line: 3, character: 4 })).toBeUndefined();
  });

  it('keys that name no method: library keys, keys without a file part, unknown files, class keys, unknown classes and methods', async () => {
    // a class Orde with a method `order`: the class key `#Order` has no dot and names no method
    const { adapter } = open({ 'src/Shop.php': `${SHOP}class Orde { public function order() {} }\n` });
    expect((await adapter.getMethod('src/Shop.php#Order.total'))?.key).toBe('src/Shop.php#Order.total');
    expect((await adapter.getMethod('src/Shop.php#Orde.order'))?.key).toBe('src/Shop.php#Orde.order');
    for (const key of ['lib:Illuminate\\Support\\Facades\\Log#Log.info', 'Order.total', 'src/Missing.php#Order.total', 'src/Shop.php#Order', 'src/Shop.php#Cart.total', 'src/Shop.php#Order.missing', 'src/Shop.php#<module>.missing']) {
      expect([key, await adapter.getMethod(key)]).toEqual([key, undefined]);
    }
  });

  it('queries on a method that does not exist (any more) answer empty', async () => {
    const { adapter } = open({ 'src/Shop.php': SHOP });
    const gone = ref('src/Shop.php#Order.removed');
    expect(await adapter.getOutgoingCalls(gone)).toEqual([]);
    expect(await adapter.getParameterNames(gone)).toEqual([]);
    expect(await adapter.getEarlyExits(gone)).toEqual([]);
    expect(await adapter.getReturns(gone)).toEqual([]);
  });

  it('parameter names in order; a method without a body has no early exits and no returns', async () => {
    const { adapter } = open({ 'src/Shop.php': SHOP });
    const pay = ref('src/Shop.php#Payable.pay');
    expect(await adapter.getParameterNames(pay)).toEqual(['amount', 'currency']);
    expect(await adapter.getEarlyExits(pay)).toEqual([]);
    expect(await adapter.getReturns(pay)).toEqual([]);
  });
});

describe('FR-5.8 PHP: what a method returns', () => {
  it('a bare `return;` returns nothing; null is empty; a local variable by name (not $this, not a parameter); a list element by element', async () => {
    const src = `<?php
class Shop {
  public function place($given) {
    if ($given) return;
    if (!$given) return null;
    $order = new Order();
    if ($order) return $order;
    if ($order === 1) return $this;
    if ($order === 2) return $given;
    if ($order === 3) return [$order, , 'ok'];
    if ($order === 4) return [$order];
    if ($order === 5) return [...$order, 'ok'];
    if ($order === 6) return [&$order, 'ok'];
    if ($order === 7) return $$given;
    return ['order' => $order, 'status' => 'ok'];
  }
}
`;
    const { root, adapter } = open({ 'src/Shop.php': src });
    const lines = src.split('\n');
    // the range of the (last) text `snippet` on (0-based) line `line`
    const r = (line: number, snippet: string, skip = 0, length = snippet.length) => {
      const character = lines[line].lastIndexOf(snippet) + skip;
      return { file: `${root}/src/Shop.php`, start: { line, character }, end: { line, character: character + length } };
    };
    expect(await adapter.getReturns(ref('src/Shop.php#Shop.place'))).toEqual([
      { range: r(3, 'return;'), values: [] },
      { range: r(4, 'return null;'), values: [{ range: r(4, 'null'), empty: true }] },
      { range: r(6, 'return $order;'), values: [{ range: r(6, '$order'), variable: 'order' }] },
      { range: r(7, 'return $this;'), values: [{ range: r(7, '$this') }] },
      { range: r(8, 'return $given;'), values: [{ range: r(8, '$given') }] },
      // `[$order, , 'ok']` (a half-typed list: the parser keeps the empty slot, the blank between the commas)
      { range: r(9, "return [$order, , 'ok'];"), tuple: true, values: [{ range: r(9, '$order'), variable: 'order' }, { range: r(9, ', ,', 1, 1) }, { range: r(9, "'ok'") }] },
      // one element, a spread, a reference, keys: one value (the array), not a tuple
      { range: r(10, 'return [$order];'), values: [{ range: r(10, '[$order]') }] },
      { range: r(11, "return [...$order, 'ok'];"), values: [{ range: r(11, "[...$order, 'ok']") }] },
      { range: r(12, "return [&$order, 'ok'];"), values: [{ range: r(12, "[&$order, 'ok']") }] },
      // a variable variable is no local of a known name
      { range: r(13, 'return $$given;'), values: [{ range: r(13, '$$given') }] },
      { range: r(14, "return ['order' => $order, 'status' => 'ok'];"), values: [{ range: r(14, "['order' => $order, 'status' => 'ok']") }] },
    ]);
  });
});
