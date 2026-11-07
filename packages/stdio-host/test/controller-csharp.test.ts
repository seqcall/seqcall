import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessController } from '../src/controller';
import { REPO, recordingSink, tempProject } from './controller-helpers';

// A C# project through the HeadlessController (FR-15.2 / FR-18): the sidecar the plugin bundles is missing, or a fake
// one (packages/core/test/fixtures/fake-sidecar.mjs, run by node in place of dotnet) answers.

const FAKE = `${REPO}/packages/core/test/fixtures/fake-sidecar.mjs`;
const NO_SIDECAR_ENV = { SEQCALL_DOTNET: process.env.SEQCALL_DOTNET };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups) await f();
  cleanups = [];
  if (NO_SIDECAR_ENV.SEQCALL_DOTNET === undefined) delete process.env.SEQCALL_DOTNET;
  else process.env.SEQCALL_DOTNET = NO_SIDECAR_ENV.SEQCALL_DOTNET;
});

/** A solution with the controller the fake sidecar knows (Get at line 10). */
function solution() {
  const p = tempProject('cs', {
    'App.sln': '',
    'src/App.Web/Controllers/OrdersController.cs': `${'// header\n'.repeat(10)}public class OrdersController { public Order Get(int id) => _orders.FindAsync(id); }\n`,
  });
  cleanups.push(() => p.rm());
  return p;
}

describe('HeadlessController: C# projects', () => {
  it('FR-15.2 the sidecar is missing: the progress opens and closes, the view says where it was looked for', async () => {
    const p = solution();
    const r = recordingSink();
    const dll = path.join(p.root, 'missing', 'Seqcall.CSharp.dll');
    const c = new HeadlessController(r.sink, { workspace: p.root, csharpSidecar: dll });
    cleanups.push(() => c.dispose());
    await c.openAt(p.file('src/App.Web/Controllers/OrdersController.cs'), { line: 10, character: 40 });
    const message = r.seq.at(-1);
    expect(message?.type === 'error' && message.message).toMatch(new RegExp(`^C# sidecar not found at ${dll.replace(/[.\\]/g, '\\$&')}\\.`));
    expect(r.other.filter((o) => o.kind === 'progress').map((o) => o.arg)).toEqual([`Loading C# workspace ${path.basename(p.root)}…`, null]);
    expect(r.logs('error')).toEqual([`open: ${message?.type === 'error' ? message.message : ''}`]);
  });

  it('FR-15.2 the sidecar answers: the diagram of its method, its stderr in the log', async () => {
    const p = solution();
    process.env.SEQCALL_DOTNET = process.execPath; // `dotnet <dll> --root …` becomes `node fake-sidecar.mjs --root …`
    const r = recordingSink();
    const c = new HeadlessController(r.sink, { workspace: p.root, csharpSidecar: FAKE });
    cleanups.push(() => c.dispose());
    await c.openAt(p.file('src/App.Web/Controllers/OrdersController.cs'), { line: 10, character: 40 });
    const render = r.seq.find((m) => m.type === 'render');
    expect(render?.type === 'render' && [render.diagram.root.name, render.diagram.messages.map((m) => m.methodName)]).toEqual(['Get', ['Get', 'FindAsync']]);
    expect(r.logs('info')).toContain(`[C#] fake sidecar started (mode normal, TieredPGO=0 TC_CallCountingDelayMs=0, cwd ${p.root})`);
  });
});
