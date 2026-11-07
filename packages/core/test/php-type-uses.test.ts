import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MethodRef } from '@seqcall/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { PhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-12.12 type uses of PHP methods: the project classes a method names without a call on an object.
const dirs: string[] = [];
const adapters: PhpAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): { root: string; adapter: PhpAdapter } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-uses-')).replace(/\\/g, '/');
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

const uses = async (adapter: PhpAdapter, key: string) => (await adapter.getTypeUses(ref(key))).map((u) => `${u.type.key} ${u.type.kind} @${u.range.start.line + 1}`);

const TYPES = `<?php
namespace Shop\\Types;
class Money { public static function zero(): self { return new self(); } }
class Order {}
class Refund {}
class Coupon {}
interface Payable {}
abstract class Fee {}
enum Status: string { case Paid = 'paid'; }
class Kinds { const CARD = 'card'; public static $all = []; }
class Ledger {}
class Draft {}
class Declined extends \\Exception {}
class Timeout extends \\Exception {}
class Receipt {}
class Line {}
class Documented {}
`;

describe('FR-12.12 type uses (PHP)', () => {
  it('FR-12.12 parameter / return types (union, nullable, closures), constants, enum cases, static members, ::class, new, instanceof, catch — once each, first reference', async () => {
    const { adapter } = open({
      'src/Types.php': TYPES,
      'src/Shop.php': `<?php
namespace Shop;
use Shop\\Types\\{Money, Order, Refund, Coupon, Payable, Fee, Status, Kinds, Ledger, Draft, Declined, Timeout, Receipt, Line, Documented};
use Illuminate\\Support\\Collection;
class Shop
{
    /** @param Documented $d */
    public function pay(Order $o, Refund|Coupon $r, ?Payable $p, int $n, Collection $c, $d): Fee
    {
        $s = Status::Paid;
        $k = Kinds::CARD;
        $a = Kinds::$all;
        $m = Money::zero();
        $class = Ledger::class;
        $x = new Draft();
        try {
            if ($p instanceof Receipt) {}
        } catch (Declined | Timeout $e) {}
        $f = fn (Line $l): Order => $o;
        $y = self::rate() + static::rate() + Shop::rate();
        strlen(PHP_EOL);
        $z = PHP_EOL . 'x';
        return $x;
    }
    private static function rate(): int { return 1; }
}
`,
    });
    expect(await uses(adapter, 'src/Shop.php#Shop.pay')).toEqual([
      'src/Types.php#Order class @8',
      'src/Types.php#Refund class @8',
      'src/Types.php#Coupon class @8',
      'src/Types.php#Payable interface @8',
      'src/Types.php#Fee abstract @8',
      'src/Types.php#Status class @10',
      'src/Types.php#Kinds class @11',
      'src/Types.php#Money class @13',
      'src/Types.php#Ledger class @14',
      'src/Types.php#Draft class @15',
      'src/Types.php#Receipt class @17',
      'src/Types.php#Declined class @18',
      'src/Types.php#Timeout class @18',
      'src/Types.php#Line class @19',
    ]);
  });

  it('FR-12.12 a constructor uses its promoted parameters\' types and what the property defaults name, not the declared property types; a function uses its intersection / return types and its closures\'', async () => {
    const { adapter } = open({
      'src/Types.php': TYPES,
      'src/Till.php': `<?php
namespace Shop;
use Shop\\Types\\{Kinds, Ledger, Status, Order, Receipt, Refund};
class Till
{
    private array $kinds = [Kinds::CARD];
    private ?Status $status = null;
    private int $count;
    public function __construct(private Ledger $ledger) {}
    public function open(): void {}
}
function total(Order&\\Countable $o): Receipt { $f = function (): Refund {}; }
`,
    });
    expect(await uses(adapter, 'src/Till.php#Till.constructor')).toEqual(['src/Types.php#Kinds class @6', 'src/Types.php#Ledger class @9']);
    expect(await uses(adapter, 'src/Till.php#Till.open')).toEqual([]);
    expect(await uses(adapter, 'src/Till.php#<module>.total')).toEqual(['src/Types.php#Order class @12', 'src/Types.php#Receipt class @12', 'src/Types.php#Refund class @12']);
    expect(await uses(adapter, 'src/Till.php#Till.missing')).toEqual([]);
  });

  it('FR-12.12 a domain class reading an infrastructure constant is a use violation, drawn and counted apart from call violations', async () => {
    const root = open({
      '.seqcall.json': JSON.stringify({ layers: [{ name: 'Domain', match: ['src/Domain/**'] }, { name: 'Infrastructure', match: ['src/Infra/**'] }] }),
      'src/Infra/Wire.php': `<?php
namespace Shop\\Infra;
class Wire { const PAID = 'paid'; }
`,
      'src/Domain/Order.php': `<?php
namespace Shop\\Domain;
use Shop\\Infra\\Wire;
class Order
{
    public function status(): string
    {
        return Wire::PAID;
    }
}
`,
    }).root;
    const s = new DiagramSession({ adapter: adapters[0], classifier: createClassifier(root) });
    await s.openMethodByKey('src/Domain/Order.php#Order.status');
    expect((await s.getClassDiagram())!.relations.filter((r) => r.violation)).toEqual([]);
    await s.setOption('showTypeUses', true);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.filter((r) => r.violation).map((r) => `${r.kind} ${r.from} → ${r.to}`)).toEqual(['use src/Domain/Order.php#Order → src/Infra/Wire.php#Wire']);
    expect(cd.typeUseViolations).toBe(1);
  });
});
