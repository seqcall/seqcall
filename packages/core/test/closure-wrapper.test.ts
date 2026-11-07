import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createPhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-1.11 PHP `$this->guard('…', function () {…})($x)`: a project method wraps the closure in another one and returns
// it; the caller invokes the result at once. The invocation is the sender's own call (not `unknown`), and the closure's
// calls follow it in a `callback` frame.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-closure-wrap-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const ORDER = `<?php
namespace Shop;

use Closure;

class Order
{
    public function __construct(private Pricing $pricing) {}

    public function with(?int $amount, ...$hints): Order
    {
        return $this->guard('creating order', function (?int $amount, ...$hints) {
            $total = $this->pricing->total(...$hints);
            return $this->build($total);
        })($amount, ...$hints);
    }

    public function viaLibrary(): void
    {
        \\Lib\\Retry::wrap(function () {
            $this->pricing->total();
        })();
    }

    protected function guard(string $message, Closure $transaction): Closure
    {
        return function (...$args) use ($message, $transaction) {
            try {
                return $transaction(...$args);
            } catch (\\RuntimeException $e) {
                throw new \\LogicException($message, 0, $e);
            }
        };
    }

    private function build(int $total): Order
    {
        return $this;
    }
}
`;
const PRICING = `<?php
namespace Shop;

class Pricing
{
    public function total(...$hints): int
    {
        return 1;
    }
}
`;

const open = async (method: string) => {
  const root = project({
    'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Shop\\': 'src/' } } }),
    'src/Order.php': ORDER,
    'src/Pricing.php': PRICING,
  });
  const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
  await s.openMethodByKey(`src/Order.php#Order.${method}`);
  return (await s.expandEverything())!;
};

const lines = (d: SequenceDiagram) => {
  const name = (pid: string) => d.participants.find((p) => p.id === pid)!.className;
  const frames = (d.fragments ?? []).map((f) => `${f.kind} [${f.operands.map((o) => o.guard).join(' | ')}] ${f.operands[0].firstMessageId}..${f.operands.at(-1)!.lastMessageId}`);
  const msgs = d.messages
    .filter((m) => m.id !== 'root')
    .map((m) => `${m.kind} ${m.methodName} → ${name(m.to)}${m.unresolved ? ' (unresolved)' : ''}`);
  return [...msgs, ...frames];
};

describe('FR-1.11 PHP: invoking the closure a project method returned', () => {
  it('FR-1.11 `guard(…, function () {…})($x)`: a self call named guard(…), the closure\'s calls in a callback frame, no unknown', async () => {
    const d = await open('with');
    expect(lines(d)).toEqual([
      'self guard → Order',
      'self guard(…) → Order',
      'call total → Pricing',
      'self build → Order',
      'callback [guard(…)(…)] root/2:total..root/3:build',
    ]);
    expect(d.participants.map((p) => p.className)).not.toContain('unknown');
  });

  it('FR-1.11 the result of a library call invoked at once stays unresolved, named without the closure body', async () => {
    const d = await open('viaLibrary');
    // (library calls are hidden; the closure handed to it is a callback of that call, FR-1.11)
    expect(lines(d)).toEqual([
      'call total → Pricing',
      'call \\Lib\\Retry::wrap(…) → unknown (unresolved)',
      'callback [\\Lib\\Retry::wrap] root/1:total..root/1:total',
    ]);
  });
});
