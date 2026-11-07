import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClassRef, SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClassInfo } from '../src/adapter';
import { activeRecordBase, isModel } from '../src/active-record';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-7.14 a `Models/` folder names Domain, but an Active Record model there (data and database access in one class)
// gets no layer: Domain would hide the database, Infrastructure would make every service using it a violation.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-active-record-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const php = (ns: string, body: string) => `<?php\n\nnamespace ${ns};\n\n${body}\n`;
const models = {
  'src/Models/Order.php': php('Shop\\Models', 'use Illuminate\\Database\\Eloquent\\Model;\n\nclass Order extends Model\n{\n    public function total(): int\n    {\n        return 1;\n    }\n}'),
  // a model of the project's own model: Active Record too
  'src/Models/Invoice.php': php('Shop\\Models', 'class Invoice extends Order\n{\n    public function due(): int\n    {\n        return 2;\n    }\n}'),
  // a shared package's class: read from `vendor/` when it is there, else unknown
  'src/Models/Setting.php': php('Shop\\Models', 'use Shop\\Common\\Models\\Setting as SettingModel;\n\nclass Setting extends SettingModel\n{\n    public function value(): string\n    {\n        return "x";\n    }\n}'),
  // plain classes in the same folder stay Domain
  'src/Models/Money.php': php('Shop\\Models', 'class Money\n{\n    public function add(int $a): int\n    {\n        return $a;\n    }\n}'),
  'src/Models/Rate.php': php('Shop\\Models', 'use Shop\\Common\\Support\\Base;\n\nclass Rate extends Base\n{\n    public function of(): int\n    {\n        return 3;\n    }\n}'),
};
const service = php(
  'Shop\\Services',
  `use Shop\\Models\\Order;
use Shop\\Models\\Invoice;
use Shop\\Models\\Setting;
use Shop\\Models\\Money;
use Shop\\Models\\Rate;

class Billing
{
    public function __construct(private Order $order, private Invoice $invoice, private Setting $setting, private Money $money, private Rate $rate) {}

    public function run(): int
    {
        $this->setting->value();
        $this->money->add($this->order->total());
        $this->rate->of();
        return $this->invoice->due();
    }
}`,
);

async function open(root: string): Promise<{ d: SequenceDiagram; s: DiagramSession }> {
  const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
  await s.openMethodByKey('src/Services/Billing.php#Billing.run');
  return { d: (await s.expandAll())!, s };
}

describe('FR-7.14 Active Record models in a model folder have no layer', () => {
  it('FR-7.14 an Eloquent model, a model of a model: no layer, said as a note; plain classes stay Domain; a package base that cannot be read: Domain, unknown said as a note', async () => {
    const { d, s } = await open(project({ ...models, 'src/Services/Billing.php': service }));
    const box = (name: string) => d.participants.find((p) => p.className === name)!;
    expect(['Order', 'Invoice', 'Setting', 'Money', 'Rate'].map((n) => [n, box(n).layer ?? null])).toEqual([
      ['Order', null],
      ['Invoice', null],
      ['Setting', 'Domain'],
      ['Money', 'Domain'],
      ['Rate', 'Domain'],
    ]);
    const order = box('Order').layerReason!;
    expect([order.rule, order.strength, order.text]).toEqual(['none', 'weak', 'no rule applies']);
    const note = 'role folder `Models/` names Domain, but it is an Active Record model (extends `Model`): data and database access in one class, no layer of its own';
    expect(order.notApplied.at(-1)).toBe(note);
    expect(order.noted).toEqual([note]);
    expect(box('Invoice').layerReason!.noted).toEqual([note.replace('`Model`', '`Order` → … `Model`')]);
    // no `vendor/`: not guessed from the namespace
    expect([box('Setting').layerReason!.rule, box('Setting').layerReason!.noted]).toEqual([
      'role-folder',
      ['extends `Setting` of a package that could not be read: whether it is an Active Record model (no layer of its own) is unknown'],
    ]);
    expect(box('Money').layerReason!.rule).toBe('role-folder');
    expect(box('Money').layerReason!.noted).toBeUndefined();
    // the class diagram says the same
    const cd = (await s.getClassDiagram())!;
    expect(['Order', 'Setting', 'Money'].map((n) => cd.classes.find((c) => c.name === n)?.layer ?? null)).toEqual([null, 'Domain', 'Domain']);
  });

  it('FR-7.14 a package base read from `vendor/`: a plain data class stays Domain, a package model (up to Eloquent) gets no layer', async () => {
    const vendor = {
      'vendor/composer/autoload_psr4.php': "<?php\n\n$vendorDir = dirname(__DIR__);\n\nreturn array(\n    'Shop\\\\Common\\\\' => array($vendorDir . '/shop/common/src'),\n);\n",
      // a data object of the package: not a model
      'vendor/shop/common/src/Models/Setting.php': php('Shop\\Common\\Models', 'class Setting extends \\stdClass\n{\n    public $key;\n}'),
      'vendor/shop/common/src/Support/Base.php': php('Shop\\Common\\Support', 'class Base\n{\n}'),
      // a model of the package, two steps up to Eloquent
      'vendor/shop/common/src/Models/Account.php': php('Shop\\Common\\Models', 'class Account extends Record\n{\n}'),
      'vendor/shop/common/src/Models/Record.php': php('Shop\\Common\\Models', 'use Illuminate\\Database\\Eloquent\\Model;\n\nclass Record extends Model\n{\n}'),
      'src/Models/Invoice.php': php('Shop\\Models', 'use Shop\\Common\\Models\\Account;\n\nclass Invoice extends Account\n{\n    public function due(): int\n    {\n        return 2;\n    }\n}'),
    };
    const { d, s } = await open(project({ ...models, ...vendor, 'src/Services/Billing.php': service }));
    const box = (name: string) => d.participants.find((p) => p.className === name)!;
    // Rate's package base `Base` has no base of its own
    expect(['Setting', 'Rate', 'Invoice'].map((n) => [n, box(n).layer ?? null, box(n).layerReason!.noted ?? null])).toEqual([
      ['Setting', 'Domain', null],
      ['Rate', 'Domain', null],
      ['Invoice', null, ['role folder `Models/` names Domain, but it is an Active Record model (extends `Account` → … `Model`): data and database access in one class, no layer of its own']],
    ]);
    // the class diagram says the same
    expect((await s.getClassDiagram())!.classes.find((c) => c.name === 'Invoice')?.layer ?? null).toBeNull();
  });

  it('FR-7.14 the Laravel preset keeps `app/Models` in Domain (Eloquent models there are Domain by the preset)', async () => {
    const root = project({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'app/Models/Order.php': models['src/Models/Order.php'].replace('Shop\\Models', 'App\\Models'),
      'app/Services/Billing.php': php('App\\Services', 'use App\\Models\\Order;\n\nclass Billing\n{\n    public function __construct(private Order $order) {}\n\n    public function run(): int\n    {\n        return $this->order->total();\n    }\n}'),
    });
    const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('app/Services/Billing.php#Billing.run');
    const d = (await s.expandAll())!;
    const order = d.participants.find((p) => p.className === 'Order')!;
    expect([order.layer, order.layerReason?.rule]).toEqual(['Domain', 'preset']);
  });

  it('FR-7.14 up the chain: pending while a class info or a library base is missing, no model for an unresolved base, a cycle, or a library base the adapter cannot read', () => {
    const info = (extendsKey?: string) => ({ ref: { key: 'x', name: 'x', kind: 'class' }, ...(extendsKey ? { extends: { key: extendsKey, name: extendsKey.replace(/^.*[#\\]/, ''), kind: 'class' } } : {}) }) as ClassInfo;
    const infos: Record<string, ClassInfo> = { 'a#A': info('b#B'), 'b#B': info('a#A'), 'c#C': info('unknown'), 'd#D': info('e#E') };
    const of = (key: string) => activeRecordBase(key, (k) => infos[k]);
    expect([of('a#A'), of('c#C'), of('d#D')]).toEqual([false, false, undefined]);
    infos['l#L'] = info('lib:Shop\\Common\\Base');
    expect(of('l#L')).toBe(false);
    const lib = (bases: Record<string, ClassRef | null | 'unread'>) => activeRecordBase('l#L', (k) => infos[k], (k) => bases[k]);
    expect([lib({}), lib({ 'lib:Shop\\Common\\Base': null }), isModel(lib({ 'lib:Shop\\Common\\Base': 'unread' }))]).toEqual([undefined, false, false]);
    expect(lib({ 'lib:Shop\\Common\\Base': { key: 'lib:Illuminate\\Database\\Eloquent\\Model', name: 'Model', kind: 'external' } })).toMatchObject({ base: { name: 'Model' }, via: { name: 'Base' } });
  });
});
