import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { collectionElement } from '../src/php/class-info';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)).replace(/\\/g, '/');
const roots: string[] = [];
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

describe('Aggregation: fields holding a collection (FR-12.15)', () => {
  it('FR-12.15 TS: arrays, sets, maps (values) and Record are collections of their element; a single object is not', async () => {
    const root = tmp('seqcall-agg-');
    roots.push(root);
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true }, include: ['src'] }));
    fs.writeFileSync(
      `${root}/src/order.ts`,
      `export class Line { price() { return 1; } }
export class Tag { label() { return 't'; } }
export class Item { id() { return 'i'; } }
export class Customer { name() { return 'c'; } }
export class Order {
  lines: Line[] = [];
  readonly tags = new Set<Tag>();
  byId: Map<string, Item> = new Map();
  extra: Record<string, Item> = {};
  constructor(private customer: Customer, private history: readonly Line[]) {}
  total() {
    this.customer.name();
    let sum = 0;
    for (const l of this.lines) sum += l.price();
    this.tags.forEach((t) => t.label());
    return sum;
  }
}
`,
    );
    const adapter = createTsAdapter(root);
    const info = (await adapter.getClassInfo('src/order.ts#Order'))!;
    const field = (name: string) => info.fields.find((f) => f.name === name)!;
    expect(field('lines')).toMatchObject({ type: { name: 'Line' }, collection: true });
    expect(field('tags')).toMatchObject({ type: { name: 'Tag' }, collection: true });
    expect(field('byId')).toMatchObject({ type: { name: 'Item' }, collection: true });
    expect(field('extra')).toMatchObject({ type: { name: 'Item' }, collection: true });
    expect(field('history')).toMatchObject({ type: { name: 'Line' }, collection: true });
    expect(field('customer').collection).toBeUndefined();
    // in the class diagram: an aggregation of many Lines / Tags, a plain association to the Customer
    const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await s.openMethodByKey('src/order.ts#Order.total');
    const cd = (await s.getClassDiagram())!;
    const rel = (to: string, label: string) => cd.relations.find((r) => r.kind === 'association' && r.to === `src/order.ts#${to}` && r.label === label);
    expect(rel('Line', 'lines')).toMatchObject({ aggregation: true, multiplicity: '*' });
    expect(rel('Line', 'lines')!.calls!.length).toBe(1); // l.price() through the loop variable
    expect(rel('Tag', 'tags')).toMatchObject({ aggregation: true, multiplicity: '*' });
    expect(rel('Customer', 'customer')).toBeDefined();
    expect(rel('Customer', 'customer')!.aggregation).toBeUndefined();
  });

  it('FR-12.15 PHP: documented collections (@var X[], array<int, X>, list<X>, Collection<int, X>, Collection|X[])', async () => {
    expect(['Order[]', '?Order[]', 'array<Order>', 'array<int, Order>', 'list<Order>', 'Collection<int, Order>', 'Collection|Order[]', '\\Illuminate\\Support\\Collection<int, \\App\\Order>'].map(collectionElement)).toEqual(['Order', 'Order', 'Order', 'Order', 'Order', 'Order', 'Order', '\\App\\Order']);
    expect(['Order', 'Order|null', undefined].map(collectionElement)).toEqual([undefined, undefined, undefined]);
    const root = tmp('seqcall-agg-php-');
    roots.push(root);
    fs.writeFileSync(`${root}/composer.json`, JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' } } }));
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/src/Line.php`, '<?php\nnamespace App;\nclass Line {}\n');
    fs.writeFileSync(`${root}/src/Customer.php`, '<?php\nnamespace App;\nclass Customer {}\n');
    fs.writeFileSync(
      `${root}/src/Order.php`,
      `<?php
namespace App;
use Illuminate\\Support\\Collection;
class Order {
    /** @var Line[] */
    private array $lines = [];
    /** @var Collection<int, Line> */
    private Collection $history;
    /** @var int[] */
    private array $counts = [];
    public function __construct(private Customer $customer) {}
}
`,
    );
    const info = (await createPhpAdapter(root).getClassInfo('src/Order.php#Order'))!;
    const field = (name: string) => info.fields.find((f) => f.name === name)!;
    expect(field('lines')).toMatchObject({ type: { name: 'Line' }, collection: true });
    expect(field('history')).toMatchObject({ type: { name: 'Line' }, collection: true });
    expect(field('counts').collection).toBeUndefined(); // scalars: no class
    expect(field('customer')).toMatchObject({ type: { name: 'Customer' } });
    expect(field('customer').collection).toBeUndefined();
  });
});
