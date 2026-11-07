import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.1 / FR-18.9 / FR-18.10 the PHP project: which files and packages are project code, library declarations,
// name resolution, files changed in the editor. Small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** `composer`: the composer.json text, null = none. */
function write(files: Record<string, string>, composer: string | null = '{"name":"shop/app"}'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-proj-')).replace(/\\/g, '/');
  dirs.push(root);
  if (composer !== null) fs.writeFileSync(`${root}/composer.json`, composer);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    if (rel.endsWith('/')) fs.mkdirSync(`${root}/${rel}`, { recursive: true });
    else fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
}

const callsOf = async (a: PhpAdapter, key: string): Promise<CallSite[]> => a.getOutgoingCalls((await a.getMethod(key))!);
const brief = (c: CallSite) => `${c.methodName} ${c.target?.key ?? '?'}${c.isLibrary ? ' (library)' : ''}`;

const PSR4 = (entries: Record<string, string[]>) => `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);
return array(
${Object.entries(entries)
  .map(([prefix, ds]) => `  '${prefix.replace(/\\/g, '\\\\')}' => array(${ds.map((d) => `$vendorDir . '/${d}'`).join(', ')}),`)
  .join('\n')}
  'App\\\\' => array($baseDir . '/src'),
);
`;

describe('FR-18.9 PHP first-party packages: which ones', () => {
  const files = {
    'vendor/composer/autoload_psr4.php': PSR4({ 'Shop\\Pay\\': ['shop/pay/src'] }),
    'vendor/shop/pay/src/Gateway.php': '<?php namespace Shop\\Pay; class Gateway { public function charge() {} }',
    'src/Checkout.php': '<?php namespace App; class Checkout { public function pay() { (new \\Shop\\Pay\\Gateway())->charge(); } }',
  };
  const charge = async (root: string) => brief((await callsOf(new PhpAdapter(root), 'src/Checkout.php#Checkout.pay')).find((c) => c.methodName === 'charge')!);

  it('the project\'s own vendor (from composer.json); "packages" that is no list is ignored', async () => {
    expect(await charge(write(files))).toBe('charge vendor/shop/pay/src/Gateway.php#Gateway.charge');
    expect(await charge(write({ ...files, '.seqcall.json': '{ "packages": "nothing/*" }' }))).toBe('charge vendor/shop/pay/src/Gateway.php#Gateway.charge');
  });

  it('none without a vendor in the composer name, without composer.json, with a broken one', async () => {
    const library = 'charge lib:Shop\\Pay\\Gateway#Gateway.charge (library)';
    expect(await charge(write(files, '{"name":"shop"}'))).toBe(library);
    expect(await charge(write(files, '{}'))).toBe(library);
    expect(await charge(write(files, null))).toBe(library);
    expect(await charge(write(files, '{"name": '))).toBe(library);
  });

  it('a class is looked for in every directory of its prefix: a missing file or a file declaring another class is passed over', async () => {
    const root = write({
      'vendor/composer/autoload_psr4.php': PSR4({ 'Shop\\Pay\\': ['shop/pay/old', 'shop/pay/src'] }),
      'vendor/shop/pay/old/Refund.php': '<?php namespace Shop\\Pay; class Legacy {}',
      'vendor/shop/pay/src/Gateway.php': '<?php namespace Shop\\Pay; class Gateway { public function charge() {} }',
      'vendor/shop/pay/src/Refund.php': '<?php namespace Shop\\Pay; class Refund { public function issue() {} }',
      'src/Checkout.php': '<?php namespace App; class Checkout { public function pay() { (new \\Shop\\Pay\\Gateway())->charge(); (new \\Shop\\Pay\\Refund())->issue(); } }',
    });
    expect((await callsOf(new PhpAdapter(root), 'src/Checkout.php#Checkout.pay')).map(brief)).toEqual([
      'constructor vendor/shop/pay/src/Gateway.php#Gateway.constructor',
      'charge vendor/shop/pay/src/Gateway.php#Gateway.charge',
      'constructor vendor/shop/pay/src/Refund.php#Refund.constructor',
      'issue vendor/shop/pay/src/Refund.php#Refund.issue',
    ]);
  });
});

describe('FR-18.9 PHP first-party package files opened directly, whole packages loaded', () => {
  const files = {
    'vendor/composer/autoload_psr4.php': PSR4({ 'Shop\\Pay\\': ['shop/pay/src', 'shop/pay/missing'], 'Other\\Lib\\': ['other/lib/src'] }),
    'vendor/shop/pay/src/Ledger.php': '<?php namespace Shop\\Pay; interface Ledger { public function record(); }',
    'vendor/shop/pay/src/DbLedger.php': '<?php namespace Shop\\Pay; class DbLedger implements Ledger { public function record() { $this->flush(); } public function flush() {} }',
    'vendor/shop/pay/src/Http/Hook.php': '<?php namespace Shop\\Pay\\Http; class Hook { public function receive(\\Shop\\Pay\\DbLedger $l) { $l->flush(); } }',
    'vendor/other/lib/src/Client.php': '<?php namespace Other\\Lib; class Client { public function send() {} }',
    'src/Checkout.php': '<?php namespace App; class Checkout { public function pay(\\Shop\\Pay\\DbLedger $l) { $l->flush(); } }',
  };

  it('the method at the cursor in a package file not loaded yet; a file of another (third-party) package is none', async () => {
    const root = write(files);
    const a = new PhpAdapter(root);
    expect((await a.findEnclosingCallable(`${root}/vendor/shop/pay/src/DbLedger.php`, { line: 0, character: 90 }))?.key).toBe('vendor/shop/pay/src/DbLedger.php#DbLedger.record');
    expect(await a.findEnclosingCallable(`${root}/vendor/other/lib/src/Client.php`, { line: 0, character: 60 })).toBeUndefined();
    expect(await a.findEnclosingCallable(`${root}/vendor/shop/pay/src/Gone.php`, { line: 0, character: 0 })).toBeUndefined();
  });

  it('callers of a package method: the whole package is read (also after its implementations were), the project too', async () => {
    const root = write(files);
    const a = new PhpAdapter(root);
    const flush = (await a.getMethod('vendor/shop/pay/src/DbLedger.php#DbLedger.flush'))!;
    expect((await a.getImplementations((await a.getMethod('vendor/shop/pay/src/Ledger.php#Ledger.record'))!)).map((m) => m.key)).toEqual(['vendor/shop/pay/src/DbLedger.php#DbLedger.record']);
    expect((await a.getCallers(flush)).map((c) => c.enclosing.key)).toEqual([
      'src/Checkout.php#Checkout.pay',
      'vendor/shop/pay/src/DbLedger.php#DbLedger.record',
      'vendor/shop/pay/src/Http/Hook.php#Hook.receive',
    ]);
    const fresh = new PhpAdapter(root);
    expect((await fresh.getCallers((await fresh.getMethod('vendor/shop/pay/src/DbLedger.php#DbLedger.flush'))!)).map((c) => c.enclosing.key)).toEqual([
      'src/Checkout.php#Checkout.pay',
      'vendor/shop/pay/src/DbLedger.php#DbLedger.record',
      'vendor/shop/pay/src/Http/Hook.php#Hook.receive',
    ]);
  });
});

describe('FR-18.10 PHP library declarations (types only)', () => {
  it('found in any directory of the prefix (not a missing file, a folder or a file declaring another class); bases, interfaces and @method docs give types; a cycle of bases ends', async () => {
    const root = write({
      'vendor/composer/autoload_psr4.php': PSR4({ 'Acme\\Kit\\': ['acme/kit/a', 'acme/kit/b'] }),
      // a stale copy of Box in a/Bag.php (Box is read first and kept); a folder named Box.php
      'vendor/acme/kit/a/Bag.php': '<?php namespace Acme\\Kit; class Box {}',
      'vendor/acme/kit/a/Box.php/': '',
      'vendor/acme/kit/b/Box.php': '<?php namespace Acme\\Kit; class Box { public function bag(): Bag {} public function lid(): Scale {} public static function open(): Scale {} }',
      'vendor/acme/kit/b/Bag.php': '<?php namespace Acme\\Kit; class Bag extends Base implements Weighs { }',
      'vendor/acme/kit/b/Base.php': '<?php namespace Acme\\Kit; /** @method Scale measure() */ abstract class Base implements Weighs {}',
      'vendor/acme/kit/b/Weighs.php': '<?php namespace Acme\\Kit; interface Weighs {}',
      'vendor/acme/kit/b/Scale.php': '<?php namespace Acme\\Kit; class Scale { public function read() {} }',
      // a broken library: two classes extending each other
      'vendor/acme/kit/b/Ping.php': '<?php namespace Acme\\Kit; class Ping extends Pong {}',
      'vendor/acme/kit/b/Pong.php': '<?php namespace Acme\\Kit; class Pong extends Ping {}',
      'src/Shop.php': '<?php namespace App; class Shop { public function weigh() { $box = new \\Acme\\Kit\\Box(); $box->bag()->measure()->read(); $box->bag()->unknown(); (new \\Acme\\Kit\\Ping())->echo()->x(); $box->lid()->read(); $lid = "x"; $box->$lid()->read(); \\Acme\\Kit\\Box::open()->read(); } }',
    });
    const cs = await callsOf(new PhpAdapter(root), 'src/Shop.php#Shop.weigh');
    expect(cs.map((c) => `${brief(c)} on ${c.receiverType?.key ?? '?'}`)).toEqual([
      'constructor lib:Acme\\Kit\\Box#Box.constructor (library) on lib:Acme\\Kit\\Box',
      'bag lib:Acme\\Kit\\Box#Box.bag (library) on lib:Acme\\Kit\\Box',
      'measure lib:Acme\\Kit\\Bag#Bag.measure (library) on lib:Acme\\Kit\\Bag',
      'read lib:Acme\\Kit\\Scale#Scale.read (library) on lib:Acme\\Kit\\Scale',
      'bag lib:Acme\\Kit\\Box#Box.bag (library) on lib:Acme\\Kit\\Box',
      'unknown lib:Acme\\Kit\\Bag#Bag.unknown (library) on lib:Acme\\Kit\\Bag',
      'constructor lib:Acme\\Kit\\Ping#Ping.constructor (library) on lib:Acme\\Kit\\Ping',
      'echo lib:Acme\\Kit\\Ping#Ping.echo (library) on lib:Acme\\Kit\\Ping',
      'x lib:Acme\\Kit\\Ping#Ping.x (library) on ?',
      // Box as declared in b/, not the stale copy read with a/Bag.php
      'lid lib:Acme\\Kit\\Box#Box.lid (library) on lib:Acme\\Kit\\Box',
      'read lib:Acme\\Kit\\Scale#Scale.read (library) on lib:Acme\\Kit\\Scale',
      // a method name in a variable (`$lid` is not the method lid()): no declaration, no type (a call on Box's result)
      '$lid ? on ?',
      'read lib:Acme\\Kit\\Box#Box.read (library) on ?',
      'open lib:Acme\\Kit\\Box#Box.open (library) on lib:Acme\\Kit\\Box',
      'read lib:Acme\\Kit\\Scale#Scale.read (library) on lib:Acme\\Kit\\Scale',
    ]);
  });
});

describe('FR-18.1 PHP files changed in the editor', () => {
  const ORDER = '<?php namespace App; class Order { public function total() {} }';

  it('a change before the project is read is applied when it is; a change undone (no content) falls back to the disk', async () => {
    const root = write({ 'src/Order.php': ORDER });
    const a = new PhpAdapter(root);
    await a.updateFile(`${root}/src/Order.php`, '<?php namespace App; class Order { public function sum() {} }');
    await a.updateFile(`${root}/src/New.php`, '<?php namespace App; class Fresh { public function make() {} }');
    await a.updateFile(`${root}/src/New.php`);
    expect((await a.getFileTypes(`${root}/src/Order.php`)).flatMap((t) => t.methods.map((m) => m.key))).toEqual(['src/Order.php#Order.sum']);
    expect(await a.getFileTypes(`${root}/src/New.php`)).toEqual([]);
  });

  it('a new file, a deleted file, files that are no PHP, a folder named like a PHP file', async () => {
    const root = write({ 'src/Order.php': ORDER, 'src/Old.php': '<?php class Old { public function x() {} }', 'src/Folder.php/': '' });
    const a = new PhpAdapter(root);
    await a.warmUp();
    await a.updateFile(`${root}/src/Fresh.php`, '<?php namespace App; class Fresh { public function make() {} }');
    expect((await a.getMethod('src/Fresh.php#Fresh.make'))?.key).toBe('src/Fresh.php#Fresh.make');
    fs.rmSync(`${root}/src/Old.php`);
    await a.updateFile(`${root}/src/Old.php`);
    expect(await a.getMethod('src/Old.php#Old.x')).toBeUndefined();
    await a.updateFile(`${root}/src/notes.txt`, '<?php class Txt {}');
    expect(await a.getFileTypes(`${root}/src/notes.txt`)).toEqual([]);
    await a.updateFile(`${root}/src/Folder.php`);
    expect(await a.getFileTypes(`${root}/src/Folder.php`)).toEqual([]);
  });

  it('a class or function declared in two files: changing one file keeps the other\'s declaration', async () => {
    const root = write({
      'src/A.php': '<?php namespace App; class Order { public function a() {} } function money() { return 1; }',
      'src/B.php': '<?php namespace App; class Order { public function b() {} } function money() { return 2; }',
      'src/Shop.php': '<?php namespace App; class Shop { public function run() { (new Order())->b(); money(); } }',
    });
    const a = new PhpAdapter(root);
    const targets = async () => (await callsOf(a, 'src/Shop.php#Shop.run')).filter((c) => c.kind === 'call').map((c) => c.target?.key);
    expect(await targets()).toEqual(['src/B.php#Order.b', 'src/B.php#<module>.money']);
    await a.updateFile(`${root}/src/A.php`, '<?php namespace App; class Other {}');
    expect(await targets()).toEqual(['src/B.php#Order.b', 'src/B.php#<module>.money']);
    // the file whose declarations are in use changes too: none is left
    await a.updateFile(`${root}/src/B.php`, '<?php namespace App; class Other {}');
    expect(await targets()).toEqual(['lib:App\\Order#Order.b', 'lib:php#<global>.money']);
  });
});

describe('FR-18.1 PHP files being typed', () => {
  it('a class or function keyword without a name yet declares nothing', async () => {
    const root = write({ 'src/Order.php': '<?php namespace App; class Order { public function total() {} }' });
    const a = new PhpAdapter(root);
    await a.updateFile(`${root}/src/Order.php`, '<?php namespace App;\nclass Order { public function total() {} }\nclass');
    expect((await a.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order']);
    await a.updateFile(`${root}/src/Order.php`, '<?php namespace App;\nclass Order { public function total() {} }\nfunction');
    expect((await a.getFileTypes(`${root}/src/Order.php`)).map((t) => t.type.key)).toEqual(['src/Order.php#Order']);
  });
});

describe('FR-18.2 PHP name resolution', () => {
  it('classes: `namespace\\X`, a `use`d namespace with the rest of the name, in declarations too; config/app.php without aliases', async () => {
    const root = write({
      'config/app.php': "<?php return ['name' => 'Shop'];",
      'src/Models/Order.php': '<?php namespace App\\Models; class Base { public function save() {} } class Order extends Base { public function total() {} }',
      'src/Shop.php': `<?php
namespace App;
use App\\Models;
class Special extends Models\\Order {}
class Shop {
  public function run() {
    (new Models\\Order())->total();
    (new namespace\\Special())->save();
    \\Log::info('x');
  }
}
`,
    });
    const cs = (await callsOf(new PhpAdapter(root), 'src/Shop.php#Shop.run')).filter((c) => c.kind === 'call');
    expect(cs.map(brief)).toEqual(['total src/Models/Order.php#Order.total', 'save src/Models/Order.php#Base.save', 'info lib:Illuminate\\Support\\Facades\\Log#Log.info (library)']);
  });

  it('a global class name is a project alias from config/app.php before the framework\'s', async () => {
    const root = write({
      'config/app.php': `<?php
return [
  'aliases' => [
    'Money' => App\\Support\\Money::class,
    'Log' => \\App\\Support\\AuditLog::class,
  ],
];
`,
      'src/Support/Money.php': '<?php namespace App\\Support; class Money { public static function of() {} } class AuditLog { public static function info() {} }',
      'src/Shop.php': '<?php class Shop { public function run() { Money::of(); \\Log::info(); Cache::get(); } }',
    });
    expect((await callsOf(new PhpAdapter(root), 'src/Shop.php#Shop.run')).map(brief)).toEqual([
      'of src/Support/Money.php#Money.of',
      'info src/Support/Money.php#AuditLog.info',
      'get lib:Illuminate\\Support\\Facades\\Cache#Cache.get (library)',
    ]);
  });

  it('@param doc types: by the parameter\'s name (not another\'s, not a tag without a type); `namespace\\X` in a doc type', async () => {
    const root = write({
      'src/Models/Order.php': '<?php namespace App\\Models; class Order { public function total() {} }',
      'src/Shop.php': `<?php
namespace App;
use App\\Models\\Order;
class Shop {
  /**
   * @param $loose
   * @param Order $other
   * @param namespace\\Models\\Order $order
   */
  public function run($order, $loose, $missing) { $order->total(); $missing->total(); }
}
`,
    });
    expect((await callsOf(new PhpAdapter(root), 'src/Shop.php#Shop.run')).map(brief)).toEqual(['total src/Models/Order.php#Order.total', 'total ?']);
  });

  it('functions: `\\fn()`, `use function`, a namespace-qualified name, `use const` is no class', async () => {
    const root = write({
      'src/Support/helpers.php': '<?php namespace App\\Support; function money() { return 1; } function tax() { return 2; }',
      'src/Shop.php': `<?php
namespace App;
use function App\\Support\\money;
use const App\\Support\\RATE;
class Shop {
  public function run() {
    money();
    \\strlen('x');
    \\config('x');
    Support\\tax();
    $r = new RATE();
  }
}
`,
    });
    const cs = await callsOf(new PhpAdapter(root), 'src/Shop.php#Shop.run');
    expect(cs.map(brief)).toEqual([
      'money src/Support/helpers.php#<module>.money',
      'strlen lib:php#<global>.strlen (library)',
      // the helper, not the Config facade a class name `Config` stands for
      'config lib:php#<global>.config (library)',
      'tax src/Support/helpers.php#<module>.tax',
      'constructor lib:App\\RATE#RATE.constructor (library)',
    ]);
  });
});
