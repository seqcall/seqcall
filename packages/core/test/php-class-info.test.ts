import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClassInfo } from '../src/adapter';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-12 / FR-7.7 structural info of PHP classes (class diagram, stereotypes, layer hints), on small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): PhpAdapter {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-info-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return new PhpAdapter(root);
}

const fieldsOf = (info: ClassInfo) => info.fields.map((f) => `${f.name}: ${f.type?.name ?? '-'}${f.collection ? '[]' : ''}${f.injected ? ' injected' : ''}${f.isStatic ? ' static' : ''}`);

const DOMAIN = `<?php
namespace App;
class Order {}
interface Ledger {}
`;

describe('FR-12 PHP class info', () => {
  it('an untyped constructor parameter assigned to `$this->field` makes the field injected; other assignments (static, another object\'s, a constant) and comparisons do not', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Shop.php': `<?php
namespace App;
class Shop {
  private $ledger;
  private $orders;
  private $count;
  private $copy;
  private $other;
  private static $shared;
  public function __construct($ledger, $orders, $limit, $peer) {
    $this->ledger = $ledger;
    $this->count = 0;
    $this->copy = $this->ledger;
    $other = $orders;
    $this->other = $unknown;
    self::$shared = $limit;
    $this::$shared = $limit;
    $this->orders->first = $orders;
    $peer->count = $limit;
    $this->other = limit;
    if ($this->copy === $orders) {}
  }
}
`,
    });
    const info = (await a.getClassInfo('src/Shop.php#Shop'))!;
    expect(fieldsOf(info)).toEqual(['ledger: - injected', 'orders: -', 'count: -', 'copy: -', 'other: -', 'shared: - static']);
    expect(info.constructorParams).toEqual([{ name: 'ledger' }, { name: 'orders' }, { name: 'limit' }, { name: 'peer' }]);
  });

  it('field types: declared, else the @var doc; a documented collection is its element, many; scalars and unknown shapes say nothing', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Cart.php': `<?php
namespace App;
class Cart {
  private Order $typed;
  /** @var Order */
  private $documented;
  /** @var Order[] */
  private $list;
  /** @var \\Illuminate\\Support\\Collection<int, Order> */
  private $collection;
  /** @var Holder<Order> */
  private $holder;
  /** @var array<int, Order|null> */
  private $nullable;
  /** @var int[] */
  private $numbers;
}
`,
    });
    expect(fieldsOf((await a.getClassInfo('src/Cart.php#Cart'))!)).toEqual([
      'typed: Order',
      'documented: Order',
      'list: Order[]',
      'collection: Order[]',
      'holder: Holder',
      'nullable: -',
      'numbers: -',
    ]);
  });

  it('attributes are its decorators (short names); an interface\'s parents are what it implements', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Entity.php': `<?php
namespace App;
#[Entity, \\Doctrine\\ORM\\Mapping\\Table('orders')]
#[Cached]
class Invoice {}
interface Archive extends Ledger, \\Countable {}
`,
    });
    expect((await a.getClassInfo('src/Entity.php#Invoice'))!.decorators).toEqual(['Entity', 'Table', 'Cached']);
    const archive = (await a.getClassInfo('src/Entity.php#Archive'))!;
    expect(archive.implements.map((r) => r.key)).toEqual(['src/Domain.php#Ledger', 'lib:Countable']);
    expect(archive.extends?.key).toBe('src/Domain.php#Ledger');
  });

  it('singletons: a static property of its own type, or a static getInstance(); a static untyped property is none', async () => {
    const a = open({
      'src/Clock.php': `<?php
namespace App;
class Clock { private static ?Clock $instance = null; private function __construct() {} }
class Registry { private static $items = []; public static function getInstance() {} }
class Config { private static $values = []; public static function get($k) {} }
`,
    });
    const flags = async (name: string) => {
      const i = (await a.getClassInfo(`src/Clock.php#${name}`))!;
      return { hasStaticInstance: i.hasStaticInstance, hasPrivateConstructor: i.hasPrivateConstructor, allMembersStatic: i.allMembersStatic };
    };
    expect(await flags('Clock')).toEqual({ hasStaticInstance: true, hasPrivateConstructor: true, allMembersStatic: true });
    expect(await flags('Registry')).toEqual({ hasStaticInstance: true, hasPrivateConstructor: false, allMembersStatic: true });
    expect(await flags('Config')).toEqual({ hasStaticInstance: false, hasPrivateConstructor: false, allMembersStatic: true });
  });

  it('method signatures: typed and untyped parameters, nullable types, return types; private / protected marked', async () => {
    const a = open({
      'src/Domain.php': DOMAIN,
      'src/Shop.php': `<?php
namespace App;
class Shop {
  public function __construct(?Ledger $ledger, $limit) {}
  protected function find(int $id): ?Order {}
  private function all() {}
}
`,
    });
    expect((await a.getClassInfo('src/Shop.php#Shop'))!.methods).toEqual([
      { name: 'constructor', isStatic: false, signature: 'constructor(?Ledger $ledger, $limit)' },
      { name: 'find', isStatic: false, signature: 'find(int $id): ?Order', visibility: 'protected' },
      { name: 'all', isStatic: false, signature: 'all()', visibility: 'private' },
    ]);
  });

  it('class keys that name nothing: an unknown file, an unknown class', async () => {
    const a = open({ 'src/Domain.php': DOMAIN });
    expect(await a.getClassInfo('src/Missing.php#Order')).toBeUndefined();
    expect(await a.getClassInfo('src/Domain.php#Cart')).toBeUndefined();
    expect((await a.getClassInfo('src/Domain.php#Order'))?.ref.key).toBe('src/Domain.php#Order');
  });
});

describe('FR-7.7 PHP module facts', () => {
  it('an unknown file has none', async () => {
    const a = open({ 'src/Domain.php': DOMAIN });
    expect(await a.getModuleFacts('src/Missing.php#Order')).toBeUndefined();
  });
});
