import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClassRef, SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClassInfo, LanguageAdapter } from '../src/adapter';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';
import { AnalysisCache, isDataOnly } from '../src/session/cache';
import { createTsAdapter } from '../src/ts/ts-adapter';

// FR-7.15 a class that only holds data (a DTO, a request / response shape, an anemic entity) carries «data» and keeps
// its layer: the code cannot tell a DTO from an entity. A class with behaviour has no mark.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-data-only-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const dataOnly = async (adapter: LanguageAdapter, keys: string[]) =>
  Object.fromEntries(await Promise.all(keys.map(async (k) => [k.slice(k.indexOf('#') + 1), (await adapter.getClassInfo(k))?.dataOnly ?? false])));

const php = (ns: string, body: string) => `<?php\n\nnamespace ${ns};\n\n${body}\n`;
const phpModels = {
  // fields, a constructor that stores, getters, a fluent setter, constants, an array of fields
  'src/Models/OrderData.php': php(
    'Shop\\Models',
    `class OrderData
{
    public const KIND = 'order';
    private string $note = '';

    public function __construct(private int $id, int $total)
    {
        $this->total = $total;
    }

    public function getId(): int
    {
        return $this->id;
    }

    public function setNote(string $note): static
    {
        $this->note = $note;
        return $this;
    }

    public function toArray(): array
    {
        return ['id' => $this->id, 'kind' => self::KIND, 'tags' => [true, null]];
    }
}`,
  ),
  // a constructor that hands its values to its parent's
  'src/Models/LineData.php': php('Shop\\Models', 'class LineData extends OrderData\n{\n    public function __construct(int $id, private int $qty)\n    {\n        parent::__construct($id, 0);\n    }\n}'),
  'src/Models/Status.php': php('Shop\\Models', "enum Status: string\n{\n    case Open = 'open';\n    case Paid = 'paid';\n}"),
  // a getter that computes: behaviour
  'src/Models/Cart.php': php('Shop\\Models', 'class Cart\n{\n    private array $items = [];\n\n    public function getTotal(): int\n    {\n        return array_sum($this->items);\n    }\n}'),
  // returns its argument: not a getter
  'src/Models/Echo.php': php('Shop\\Models', 'class Echoes\n{\n    public function of(int $a): int\n    {\n        return $a;\n    }\n}'),
  // a constructor that checks its input: behaviour
  'src/Models/Money.php': php('Shop\\Models', "class Money\n{\n    public function __construct(private int $cents)\n    {\n        if ($cents < 0) {\n            throw new \\InvalidArgumentException('negative');\n        }\n    }\n}"),
  // data itself, but its trait has behaviour
  'src/Models/Tagged.php': php('Shop\\Models', 'class Tagged\n{\n    use HasTags;\n\n    private array $tags = [];\n}'),
  'src/Models/HasTags.php': php('Shop\\Models', "trait HasTags\n{\n    public function tagList(): string\n    {\n        return implode(',', $this->tags);\n    }\n}"),
  'src/Models/Labelled.php': php('Shop\\Models', 'class Labelled\n{\n    use HasLabel;\n}'),
  'src/Models/HasLabel.php': php('Shop\\Models', 'trait HasLabel\n{\n    public string $label = \'\';\n}'),
  'src/Models/Shape.php': php('Shop\\Models', 'interface Shape\n{\n    public function area(): float;\n}'),
};

describe('FR-7.15 classes that only hold data', () => {
  it('FR-7.15 PHP: fields, a storing constructor, getters, a fluent setter, an array of fields, a data trait are data; an enum (domain vocabulary), a computing getter, a getter with an argument, a checking constructor, a trait with logic, an interface method are not', async () => {
    const root = project(phpModels);
    const keys = ['OrderData', 'LineData', 'Status', 'Cart', 'Echo', 'Money', 'Tagged', 'Labelled', 'Shape'].map((f) => `src/Models/${f}.php#${f === 'Echo' ? 'Echoes' : f}`);
    expect(await dataOnly(createPhpAdapter(root), keys)).toEqual({
      OrderData: true,
      LineData: true,
      Status: false,
      Cart: false,
      Echoes: false,
      Money: false,
      Tagged: false,
      Labelled: true,
      Shape: false,
    });
  });

  it('FR-7.15 TS: a field class, a fluent setter, get / set accessors, an interface of fields, an object type are data; an enum, a computing getter, a function field, a checking constructor, an interface method are not', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }),
      'src/models/order.ts': `export enum Kind { A = 'a' }
export class OrderDto {
  [extra: string]: unknown;
  id = 0;
  kind = Kind.A;
  items: string[] = [];
  private _note = '';
  constructor(public readonly ref: string, total: number) { this.total = total; }
  total: number;
  get note() { return this._note; }
  set note(v: string) { this._note = v; }
  withId(id: number) { this.id = id; return this; }
  toJSON() { return { id: this.id, kind: this.kind }; }
}
export class Cart {
  items: number[] = [];
  get total() { return this.items.reduce((a, b) => a + b, 0); }
}
export class Handler {
  run = () => 1;
}
export class Flags {
  rate = -1;
  on = !0;
}
export class Registry {
  static names: string[];
  static { Registry.names = []; }
}
export class Money {
  constructor(private cents: number) { if (cents < 0) throw new Error('negative'); }
}
export abstract class Entity {
  abstract validate(): boolean;
}
export class Tagged extends Entity {
  tags = new Set<string>();
  constructor(id: number) { super(); }
  validate() { return true; }
}
export interface OrderView { id: number; lines: { sku: string }[] }
export interface Priced extends OrderView { price(): number }
export interface Keyed extends Record<'a' | 'b', number> {}
export interface Checked extends Tagged {}
export type Row = { id: number; name: string };
export type Pick2 = 'a' | 'b';
`,
    });
    const keys = ['OrderDto', 'Cart', 'Handler', 'Flags', 'Registry', 'Money', 'Entity', 'Tagged', 'OrderView', 'Priced', 'Keyed', 'Checked', 'Row', 'Pick2', 'Kind'].map((n) => `src/models/order.ts#${n}`);
    expect(await dataOnly(createTsAdapter(root), keys)).toEqual({
      OrderDto: true,
      Cart: false,
      Handler: false,
      // a negation computes
      Flags: false,
      // a static block runs code
      Registry: false,
      Money: false,
      // an abstract method: a subclass's behaviour
      Entity: false,
      Tagged: true,
      OrderView: true,
      Priced: false,
      Keyed: true,
      // the class's method
      Checked: false,
      Row: true,
      // a type other than an object type: unknown
      Pick2: false,
      // an enum is domain vocabulary
      Kind: false,
    });
  });

  it('FR-7.15 up the base classes: a project base with behaviour, a library base (its code is not read) make it no data; unknown while a base is not known', () => {
    const ref = (key: string): ClassRef => ({ key, name: key.split('#')[1] ?? key, kind: 'class' });
    const infos: Record<string, Partial<ClassInfo>> = {
      'a#Dto': { dataOnly: true, extends: ref('a#BaseDto') },
      'a#BaseDto': { dataOnly: true },
      'a#Rich': { dataOnly: true, extends: ref('a#Entity') },
      'a#Entity': {},
      'a#Lib': { dataOnly: true, extends: ref('lib:Vendor\\Data') },
      'a#Pending': { dataOnly: true, extends: ref('a#Later') },
    };
    const info = (k: string) => infos[k] as ClassInfo | undefined;
    expect(['a#Dto', 'a#Rich', 'a#Lib', 'a#Pending'].map((k) => isDataOnly(k, info))).toEqual([true, false, false, undefined]);
  });

  it('FR-7.15 before its class info is fetched there is no mark (a provisional answer); after, a data class carries «data» and keeps its layer', async () => {
    const dto: ClassRef = { key: 'src/models/Dto.ts#Dto', name: 'Dto', kind: 'class' };
    const adapter = { getClassInfo: async () => ({ ref: dto, implements: [], fields: [], constructorParams: [], methods: [], dataOnly: true }) } as unknown as LanguageAdapter;
    const cache = new AnalysisCache(adapter, createClassifier(project({})));
    expect([cache.peekClassify(dto).layer, cache.peekClassify(dto).stereotypes]).toEqual(['Domain', []]);
    const c = await cache.resolve(() => cache.classify(dto, {}));
    expect([c.layer, c.stereotypes, c.stereotypeReasons?.[0].text]).toEqual(['Domain', ['data'], 'only holds data: fields, getters and setters, a constructor that only stores values']);
    expect(cache.peekClassify(dto).stereotypes).toEqual(['data']);
  });

  it('FR-7.15 the mark in any layer; none for a class without class info, a library or unknown class, or one already marked by a rule', async () => {
    const svc: ClassRef = { key: 'src/services/Quote.ts#Quote', name: 'Quote', kind: 'class' };
    const gone: ClassRef = { key: 'src/services/Gone.ts#Gone', name: 'Gone', kind: 'class' };
    const lib: ClassRef = { key: 'lib:pkg#Thing', name: 'Thing', kind: 'external' };
    const adapter = { getClassInfo: async (k: string) => (k === svc.key ? { ref: svc, implements: [], fields: [], constructorParams: [], methods: [], dataOnly: true } : undefined) } as unknown as LanguageAdapter;
    const root = project({ '.seqcall.json': JSON.stringify({ stereotypes: [{ stereotype: 'data', match: { path: 'src/rules/**' } }] }) });
    const cache = new AnalysisCache(adapter, createClassifier(root));
    const quote = await cache.resolve(() => cache.classify(svc, {}));
    expect([quote.layer, quote.stereotypes]).toEqual(['Application', ['service', 'data']]);
    expect((await cache.resolve(() => cache.classify(gone, {}))).stereotypes).not.toContain('data');
    expect((await cache.resolve(() => cache.classify(lib, {}))).stereotypes).not.toContain('data');
    const ruled: ClassRef = { key: 'src/rules/Limit.ts#Limit', name: 'Limit', kind: 'class' };
    expect((await cache.resolve(() => cache.classify(ruled, {}))).stereotypes).toEqual(['data']);
    // a classifier that gives no reasons: the mark brings its own
    const bare = new AnalysisCache(adapter, { classify: () => ({ stereotypes: [], namespace: 'src/services' }) } as unknown as ReturnType<typeof createClassifier>);
    expect((await bare.resolve(() => bare.classify(svc, {}))).stereotypeReasons!.map((r) => r.stereotype)).toEqual(['data']);
  });

  it('FR-7.15 PHP diagram: a data class in a model folder stays Domain with «data»; a class with behaviour has no mark; an Eloquent model keeps its Active Record note', async () => {
    const root = project({
      ...phpModels,
      'src/Models/Order.php': php('Shop\\Models', 'use Illuminate\\Database\\Eloquent\\Model;\n\nclass Order extends Model\n{\n    public function getRef(): string\n    {\n        return $this->ref;\n    }\n}'),
      'src/Services/Billing.php': php(
        'Shop\\Services',
        `use Shop\\Models\\Cart;
use Shop\\Models\\Order;
use Shop\\Models\\OrderData;

class Billing
{
    public function __construct(private OrderData $data, private Cart $cart, private Order $order) {}

    public function run(): int
    {
        $this->order->getRef();
        $this->cart->getTotal();
        return $this->data->getId();
    }
}`,
      ),
    });
    const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('src/Services/Billing.php#Billing.run');
    const d: SequenceDiagram = (await s.expandAll())!;
    const box = (name: string) => d.participants.find((p) => p.className === name)!;
    expect(['OrderData', 'Cart', 'Order'].map((n) => [n, box(n).layer ?? null, box(n).stereotypes.includes('data')])).toEqual([
      ['OrderData', 'Domain', true],
      ['Cart', 'Domain', false],
      ['Order', null, false],
    ]);
    expect(box('OrderData').layerReason!.rule).toBe('role-folder');
    expect(box('Order').layerReason!.noted![0]).toMatch(/Active Record model/);
    // the class diagram says the same
    const cd = await s.getClassDiagram();
    const node = (name: string) => cd!.classes.find((c) => c.name === name)!;
    expect([node('OrderData').layer, node('OrderData').stereotypes.includes('data'), node('Cart').stereotypes.includes('data')]).toEqual(['Domain', true, false]);
    // Hide every… → Every «data» class (FR-11.8): the calls to it go, in both diagrams
    const hidden = (await s.hide({ kind: 'stereotype', stereotype: 'data' }))!;
    expect(hidden.participants.map((p) => p.className)).not.toContain('OrderData');
    expect((await s.getClassDiagram())!.classes.map((c) => c.name)).not.toContain('OrderData');
  });
});
