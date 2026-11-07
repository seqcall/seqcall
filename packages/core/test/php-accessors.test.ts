import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-18.15 Eloquent accessors / mutators run when their attribute is read / assigned (`$member->loyalty_points`):
// Laravel builds the method name from the attribute, so no call names them.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-accessors-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const php = (ns: string, body: string) => `<?php\n\nnamespace ${ns};\n\n${body}\n`;
const files = {
  'src/Models/Member.php': php(
    'Shop\\Models',
    `use Illuminate\\Database\\Eloquent\\Casts\\Attribute;
use Illuminate\\Database\\Eloquent\\Model;
use Shop\\Services\\Rates;

class Member extends Model
{
    use ShowsCredits;

    /** a real property: PHP reads it, the model is not asked */
    public string $plain = '';

    public function __construct(private Rates $rates) {}

    public function getLoyaltyPointsAttribute(): int
    {
        return $this->rates->credits($this->id);
    }

    public function setNicknameAttribute(string $value): void
    {
        $this->rates->clean($value);
    }

    protected function status(): Attribute
    {
        return Attribute::make(get: fn () => 'active');
    }

    public function getPlainAttribute(): string
    {
        return 'never';
    }

    public function wallet(): int
    {
        return $this->loyalty_points;
    }

    /** a plain method named like an attribute another class has an accessor for: no accessor */
    public function badge(): string
    {
        return 'gold';
    }
}`,
  ),
  // the model's trait reads the attribute on `$this` (the model)
  'src/Models/ShowsCredits.php': php('Shop\\Models', 'trait ShowsCredits\n{\n    public function shown(): string\n    {\n        return (string) $this->loyalty_points;\n    }\n}'),
  'src/Models/Medal.php': php('Shop\\Models', 'use Illuminate\\Database\\Eloquent\\Model;\n\nclass Medal extends Model\n{\n    public function getBadgeAttribute(): string\n    {\n        return \'x\';\n    }\n}'),
  // a method without a body in a file that names the attribute
  'src/Models/HasCredits.php': php('Shop\\Models', 'interface HasCredits\n{\n    /** the loyalty_points */\n    public function credits(): int;\n}'),
  'src/Services/Rates.php': php('Shop\\Services', 'class Rates\n{\n    public function credits(int $id): int\n    {\n        return $id;\n    }\n\n    public function clean(string $v): string\n    {\n        return $v;\n    }\n}'),
  'src/Services/Lobby.php': php(
    'Shop\\Services',
    `use Shop\\Models\\Member;

class Lobby
{
    public function enter(Member $member, $any): string
    {
        $credits = $member->loyalty_points;
        $member->nickname = 'neo';
        $member->plain;
        $member->other;
        $member->badge;
        // an object of unknown class, a nested class: no accessor known
        $any->loyalty_points;
        $log = new class {};
        return $member->status . $credits;
    }
}`,
  ),
  'resources/views/account.blade.php': '<p>{{ $member->loyalty_points }} {{ $member->name() }}</p>\n',
};

describe('FR-18.15 Eloquent accessors and mutators', () => {
  it('FR-18.15 reading an attribute runs its accessor (`get…Attribute`, `…(): Attribute`), assigning one its mutator; a real property and an attribute without one stay plain reads', async () => {
    const root = project(files);
    const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
    const d = (await s.openMethodByKey('src/Services/Lobby.php#Lobby.enter'))!;
    const calls = d.messages.filter((m) => m.id !== 'root').map((m) => [m.methodName, m.accessor ?? null, m.methodKey?.replace(/^.*#/, '') ?? null]);
    expect(calls).toEqual([
      ['loyalty_points', 'get', 'Member.getLoyaltyPointsAttribute'],
      ['nickname', 'set', 'Member.setNicknameAttribute'],
      ['status', 'get', 'Member.status'],
    ]);
    // the accessor's body is a step like any call
    const e = (await s.expandEverything())!;
    expect(e.messages.filter((m) => m.methodName === 'credits').length).toBe(1);
  });

  it('FR-18.15 the callers of an accessor are the reads of its attribute, inside its own model too; the Blade views name it for FR-31.3', async () => {
    const root = project(files);
    const adapter = createPhpAdapter(root);
    const accessor = (await adapter.findEnclosingCallable(`${root}/src/Models/Member.php`, { line: 16, character: 10 }))!;
    expect(accessor.name).toBe('getLoyaltyPointsAttribute');
    const callers = await adapter.getCallers(accessor);
    expect(callers.map((c) => [c.enclosing.name, c.preview])).toEqual([
      ['wallet', 'return $this->loyalty_points;'],
      ['shown', 'return (string) $this->loyalty_points;'],
      ['enter', '$credits = $member->loyalty_points;'],
    ]);
    const mutator = (await adapter.findEnclosingCallable(`${root}/src/Models/Member.php`, { line: 21, character: 10 }))!;
    expect((await adapter.getCallers(mutator)).map((c) => c.preview)).toEqual(["$member->nickname = 'neo';"]);
    const names = (await adapter.getTemplateCallNames!())!;
    expect([names.get('getloyaltypointsattribute'), names.get('loyaltypoints'), names.get('name'), names.get('getnameattribute')]).toEqual([1, 1, 1, undefined]);
  });
});
