import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

// FR-1.23 a closure the caller wrote, handed on as a parameter to a library call (`->then($work)`, `p.then(cb)`):
// the library runs it — drawn as the invocation of that parameter, back to the object that wrote the closure.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-closure-lib-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

/** The messages as an indented tree: `ƒ` marks a parameter invocation, `(lambda)` a closure the caller wrote. */
const tree = (d: SequenceDiagram) => {
  const name = (pid: string) => d.participants.find((p) => p.id === pid)!.className;
  const depth = (id: string) => id.split('/').length - 2;
  return d.messages
    .filter((m) => m.id !== 'root')
    .map((m) => `${'  '.repeat(depth(m.id))}${m.viaParameter ? 'ƒ ' : ''}${m.methodName} → ${name(m.to)}${m.viaLambda ? ' (lambda)' : ''}`);
};

describe('FR-1.23 a closure handed on to a library call is run there', () => {
  it('FR-1.23 PHP: a closure passed down two project calls and handed to `->then($work)` shows its calls, and the closure it runs shows its own', async () => {
    const root = project({
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Shop\\': 'src/' } } }),
      'src/Checkout.php': `<?php
namespace Shop;

class Checkout
{
    public function __construct(private Wallet $wallet, private Ledger $ledger) {}

    public function pay(string $account): int
    {
        return $this->wallet->forCustomer($account, function (int $customer) {
            return $this->ledger->book($customer);
        });
    }
}
`,
      'src/Wallet.php': `<?php
namespace Shop;

class Wallet
{
    public function __construct(private Lock $lock, private Audit $audit) {}

    public function forCustomer(string $account, \\Closure $work): int
    {
        return $this->lock->run($account, function () use ($account, $work) {
            $this->audit->note($account);
            return $work(7);
        });
    }
}
`,
      'src/Lock.php': `<?php
namespace Shop;

use Illuminate\\Redis\\Limiters\\ConcurrencyLimiterBuilder;

class Lock
{
    public function run(string $key, \\Closure $work): mixed
    {
        return $this->funnel($key)->then($work);
    }

    private function funnel(string $key): ConcurrencyLimiterBuilder
    {
        return new ConcurrencyLimiterBuilder($key);
    }
}
`,
      'src/Ledger.php': `<?php
namespace Shop;

class Ledger
{
    public function book(int $customer): int
    {
        return $customer;
    }
}
`,
      'src/Audit.php': `<?php
namespace Shop;

class Audit
{
    public function note(string $account): void
    {
    }
}
`,
    });
    const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('src/Checkout.php#Checkout.pay');
    const d = (await s.expandEverything())!;
    expect(tree(d)).toEqual([
      'forCustomer → Wallet',
      '  run → Lock',
      '    funnel → Lock',
      '    ƒ $work → Wallet (lambda)',
      '      note → Audit',
      '      ƒ $work → Checkout (lambda)',
      '        book → Ledger',
    ]);
  });

  it('FR-1.23 TypeScript: a callback parameter handed to `promise.then(cb)` runs the caller\'s arrow function', async () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }),
      'src/ledger.ts': 'export class Ledger {\n  book(n: number) { return n; }\n}\n',
      // handed over inside an `if`: the invocation is framed like the call
      'src/lock.ts': 'export class Lock {\n  run(cb: (n: number) => number, n = 1) {\n    if (n > 0) {\n      void Promise.resolve(n).then(cb);\n    }\n    return n;\n  }\n}\n',
      'src/checkout.ts': `import { Ledger } from './ledger';
import { Lock } from './lock';
export class Checkout {
  constructor(private lock: Lock, private ledger: Ledger) {}
  pay() {
    return this.lock.run((n) => this.ledger.book(n));
  }
}
`,
    });
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('src/checkout.ts#Checkout.pay');
    const d = (await s.expandEverything())!;
    expect(tree(d)).toEqual(['run → Lock', '  ƒ cb → Checkout (lambda)', '    book → Ledger']);
    expect(d.fragments?.map((f) => [f.kind, f.operands[0].guard, f.operands[0].firstMessageId])).toEqual([['opt', 'n > 0', 'root/0:run/1:cb']]);
  });
});
