import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { PhpAdapter } from '../src/php/php-adapter';
import { DiagramSession } from '../src/session';

// FR-18.14 the request pipeline on a small project that the tests change: a middleware whose `$next` leads to one
// without a handle in the project, and a handle deleted while its route's diagram is open.
let root = '';
const GATE = `<?php
namespace App\\Http;
class Gate {
  public function handle($request, $next) {
    if (!$request) {
      return 0;
    }
    return $next($request);
  }
}
`;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-pipeline-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  };
  write('composer.json', '{"name":"shop/app","autoload":{"psr-4":{"App\\\\":"app/"}}}');
  write('app/Http/OrderController.php', `<?php\nnamespace App\\Http;\nclass OrderController {\n  public function store() {\n    return 1;\n  }\n}\n`);
  write('app/Http/Gate.php', GATE);
  write('routes/web.php', `<?php\nuse App\\Http\\OrderController;\nuse App\\Http\\Gate;\nRoute::post('orders', [OrderController::class, 'store'])->middleware([Gate::class, 'auth']);\nRoute::put('orders', [OrderController::class, 'store'])->middleware([Gate::class . ':a', Gate::class . ':b']);\n`);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-18.14 the request pipeline', () => {
  it("a middleware's `next ⇒` to one without a handle in the project; a handle deleted meanwhile leaves its middleware a name", async () => {
    const s = new DiagramSession({ adapter: new PhpAdapter(root), classifier: createClassifier(root) });
    const entry = (await s.getEntryPoints()).find((e) => e.label === 'POST /orders')!;
    expect(entry.middleware?.map((m) => `${m.name}${m.method ? ' (handle)' : ''}`)).toEqual(['App\\Http\\Gate (handle)', 'auth']);
    await s.openMethodByKey('app/Http/OrderController.php#OrderController.store', entry);
    await s.expand('middleware');
    let d = (await s.expand('middleware/0:handle'))!;
    const next = d.messages.find((m) => m.parentId === 'middleware/0:handle' && m.continuesPipeline)!;
    // the next step is `auth`, an alias: its handle is no method of the project
    expect([d.participants.find((p) => p.id === next.to)!.className, next.methodName, next.expandable]).toEqual(['auth', 'handle', false]);

    fs.writeFileSync(`${root}/app/Http/Gate.php`, `<?php\nnamespace App\\Http;\nclass Gate {\n}\n`);
    d = (await s.refresh([`${root}/app/Http/Gate.php`]))!;
    const gate = d.messages.find((m) => m.id === 'middleware/0:handle')!;
    expect([gate.className, gate.expandable]).toEqual(['Gate', false]);
    await s.dispose();
    fs.writeFileSync(`${root}/app/Http/Gate.php`, GATE);
  });

  it('the same middleware class twice (other parameters): two handles on one lifeline', async () => {
    const s = new DiagramSession({ adapter: new PhpAdapter(root), classifier: createClassifier(root) });
    const entry = (await s.getEntryPoints()).find((e) => e.label === 'PUT /orders')!;
    await s.openMethodByKey('app/Http/OrderController.php#OrderController.store', entry);
    const d = (await s.expand('middleware'))!;
    const handles = d.messages.filter((m) => m.parentId === 'middleware');
    expect(handles.map((m) => m.args.join(', '))).toEqual(['$request, $next, a', '$request, $next, b']);
    expect(new Set(handles.map((m) => m.to)).size).toBe(1);
    await s.dispose();
  });
});
