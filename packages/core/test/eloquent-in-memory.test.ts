import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-17.2 an Eloquent model's in-memory methods are no DB I/O; FR-18 an inherited library method is drawn from the
// library class that declares it, not from a trait of a nearer ancestor.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-eloquent-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const php = (ns: string, body: string) => `<?php\n\nnamespace ${ns};\n\n${body}\n`;
const laravel = {
  'vendor/composer/autoload_psr4.php': "<?php\n\n$vendorDir = dirname(__DIR__);\n\nreturn array(\n    'Illuminate\\\\' => array($vendorDir . '/laravel/framework/src/Illuminate'),\n);\n",
  'vendor/laravel/framework/src/Illuminate/Database/Eloquent/Model.php': php(
    'Illuminate\\Database\\Eloquent',
    'abstract class Model\n{\n    public function is($model): bool\n    {\n        return true;\n    }\n\n    public function save(): bool\n    {\n        return true;\n    }\n}',
  ),
  'vendor/laravel/framework/src/Illuminate/Database/Eloquent/Factories/HasFactory.php': php('Illuminate\\Database\\Eloquent\\Factories', 'trait HasFactory\n{\n    public static function factory()\n    {\n    }\n}'),
};
const app = {
  // the model's base class extends Eloquent's Model; the model itself uses a library trait
  'src/Models/Record.php': php('Shop\\Models', 'use Illuminate\\Database\\Eloquent\\Model;\n\nabstract class Record extends Model\n{\n}'),
  // a trait of the project next to the library's: not a library base
  'src/Models/Stamps.php': php('Shop\\Models', 'trait Stamps\n{\n}'),
  'src/Models/Order.php': php('Shop\\Models', 'use Illuminate\\Database\\Eloquent\\Factories\\HasFactory;\n\nclass Order extends Record\n{\n    use Stamps, HasFactory;\n}'),
  'src/Services/Pairing.php': php(
    'Shop\\Services',
    'use Shop\\Models\\Order;\n\nclass Pairing\n{\n    public function same(Order $a, Order $b): bool\n    {\n        return $a->is($b);\n    }\n\n    public function keep(Order $a): bool\n    {\n        return $a->save();\n    }\n}',
  ),
};

async function rootIo(root: string, method: string) {
  const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
  const d = (await s.openMethodByKey(`src/Services/Pairing.php#Pairing.${method}`))!;
  return d.messages.find((m) => m.id === 'root')!.sideEffects ?? null;
}

describe('FR-17.2 an Eloquent model compared in memory does no I/O', () => {
  it('FR-17.2 `$a->is($b)` is no DB I/O, `$a->save()` is — named after `Model`, which declares both', async () => {
    const root = project({ ...laravel, ...app });
    expect(await rootIo(root, 'same')).toBeNull();
    expect(await rootIo(root, 'keep')).toEqual({ kinds: ['db'], evidence: ['DB: Model.save'] });
  });

  it('FR-17.2 without Laravel in `vendor/` too (an unread method is taken from the library base class before a trait)', async () => {
    const root = project(app);
    expect(await rootIo(root, 'same')).toBeNull();
    expect(await rootIo(root, 'keep')).toEqual({ kinds: ['db'], evidence: ['DB: Model.save'] });
  });
});
