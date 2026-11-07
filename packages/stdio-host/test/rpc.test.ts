import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { Position } from '@seqcall/protocol';
import { startServer, STDIO_HOST_VERSION, type ServerOptions } from '../src/server';
import { events, intent } from './sse';

// The JSON-RPC server (FR-15.3, docs/RIDER-PLUGIN.md) on in-memory streams: framing, errors, the requests the
// editor sends, and browser mode's start (FR-21). browser.test.ts / stdio-host.test.ts have the main flows.

const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const CONTROLLER = `${REPO}/fixtures/sample-app/src/controllers/user-controller.ts`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-rpc-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(`${tmp}/${rel}`), { recursive: true });
  fs.writeFileSync(`${tmp}/${rel}`, text);
  return `${tmp}/${rel}`;
};

function positionOf(file: string, needle: string): Position {
  const text = fs.readFileSync(file, 'utf8');
  const before = text.slice(0, text.indexOf(needle)).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

/** The server on in-memory streams; `next(pred)` waits (at most `ms`) for a matching output line. */
function rpcHost(options: ServerOptions = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const waiters: { pred: (l: any) => boolean; resolve: (l: any) => void }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const w of waiters.splice(0)) (w.pred(line) ? w.resolve(line) : waiters.push(w));
    }
  });
  const handle = startServer(input, output, options);
  let id = 100;
  const next = (pred: (l: any) => boolean, what = 'a matching line', ms = 20_000) => // eslint-disable-line @typescript-eslint/no-explicit-any
    new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const hit = lines.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms; lines: ${JSON.stringify(lines).slice(0, 2000)}`)), ms);
      waiters.push({ pred, resolve: (l) => (clearTimeout(timer), resolve(l)) });
    });
  return {
    handle,
    lines,
    next,
    raw: (text: string) => input.write(text),
    send: (obj: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'),
    /** A request; resolves with its reply. Lines after this one in `lines` came after the request was handled. */
    request: async (method: string, params?: object) => {
      const n = ++id;
      input.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) }) + '\n');
      return next((l) => l.id === n, `the reply to ${method}`);
    },
    shutdown: async () => {
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'shutdown' }) + '\n');
      await handle.closed;
    },
  };
}
const posts = (lines: any[], view: string) => lines.filter((l) => l.method === 'post' && l.params.view === view).map((l) => l.params.message); // eslint-disable-line @typescript-eslint/no-explicit-any

describe('FR-15.3 JSON-RPC framing and errors', () => {
  it('FR-15.3 blank lines are skipped; bad JSON, a line that is no request, an unknown method and a failing request each get their JSON-RPC error', async () => {
    const host = rpcHost();
    host.raw('\n   \n');
    host.raw('{"id": 1, "method": \n');
    host.raw('null\n42\n');
    host.send({ method: 'nope' }); // a notification: nobody waits for a reply
    host.send({ id: 2, method: 'nope' });
    host.send({ id: 3, method: 'view', params: { view: 'sequence', message: null } });
    host.send({ method: 'view', params: { view: 'class', message: null } });
    host.send({ id: 4, method: 'showView', params: { view: 'sequence' } }); // stdio mode: no browser page to open
    expect(await host.next((l) => l.id === 4)).toEqual({ jsonrpc: '2.0', id: 4, result: null });
    expect(host.lines).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
      { jsonrpc: '2.0', method: 'log', params: { level: 'error', message: 'nope: unknown method nope' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'unknown method nope' } },
      { jsonrpc: '2.0', id: 3, error: { code: -32000, message: "Cannot read properties of null (reading 'type')" } },
      { jsonrpc: '2.0', method: 'log', params: { level: 'error', message: "view: Cannot read properties of null (reading 'type')" } },
      { jsonrpc: '2.0', id: 4, result: null },
    ]);
    await host.shutdown();
  });
});

describe('FR-15.2 the editor\'s requests reach the controller', () => {
  it('FR-15.2 / FR-12.4 class view messages, a closed class view, saved files and the caret', async () => {
    const host = rpcHost({ workspace: REPO });
    await host.request('view', { view: 'class', message: { type: 'ready' } });
    expect(posts(host.lines, 'class')).toEqual([{ type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' }]);
    const at = positionOf(CONTROLLER, 'this.validate(id);');
    await host.request('openAt', { file: CONTROLLER, position: at });
    // FR-16.14 the open class view shows the spinner while the project is first analysed
    expect(posts(host.lines, 'class').map((m) => m.type)).toEqual(['empty', 'busy', 'render']);
    // the sequence view closing does not stop the class view; the class view closing does
    await host.request('viewClosed', { view: 'sequence' });
    await host.request('openAt', { file: CONTROLLER, position: at });
    expect(posts(host.lines, 'class').map((m) => m.type)).toEqual(['empty', 'busy', 'render', 'render']);
    await host.request('viewClosed', { view: 'class' });
    await host.request('openAt', { file: CONTROLLER, position: at });
    expect(posts(host.lines, 'class')).toHaveLength(4); // none since it closed

    // saved files: none listed → nothing to refresh; the controller's file → a new render
    const renders = () => posts(host.lines, 'sequence').filter((m) => m.type === 'render').length;
    const before = renders();
    expect(await host.request('filesChanged', {})).toEqual({ jsonrpc: '2.0', id: expect.any(Number), result: null });
    expect(renders()).toBe(before);
    await host.request('filesChanged', { files: [CONTROLLER] });
    expect(renders()).toBe(before + 1);

    // the caret on a call highlights its message
    const diagram = posts(host.lines, 'sequence').filter((m) => m.type === 'render').at(-1).diagram;
    const call = diagram.messages.find((m: { kind: string; callSite?: object }) => m.kind !== 'found' && m.callSite);
    await host.request('caretMoved', { file: call.callSite.file, position: call.callSite.start });
    // (a background I/O scan may render again meanwhile, FR-17.5)
    expect(posts(host.lines, 'sequence').filter((m) => m.type === 'highlight')).toEqual([{ type: 'highlight', messageId: call.id }]);
    await host.shutdown();
  });

  it('FR-33.6 / FR-34.4 Info at Caret, an entry point from it, memory and Free Memory as requests', async () => {
    const host = rpcHost();
    const report = `${REPO}/fixtures/sample-app/src/console/report.ts`;
    const at = positionOf(report, 'function report');
    const name = { line: at.line, character: at.character + 11 };
    const info = (await host.request('describeAt', { file: report, position: name, word: 'report' })).result;
    expect(info).toMatchObject({ onName: true, routes: [expect.any(String)], item: '  · ' });
    expect(info.lines[0]).toBe('⌂ reached from 1 entry point');
    expect((await host.request('describeAt', { file: report, position: { line: 0, character: 0 } })).result).toBeNull();
    // an entry point's flow; without an index its Paths to here
    await host.request('openReach', { file: report, position: name, word: 'report', index: 0 });
    expect(posts(host.lines, 'sequence').at(-1)?.type).toBe('highlight');
    await host.request('openReach', { file: report, position: name, word: 'report' });
    expect(posts(host.lines, 'sequence').at(-1)).toEqual({ type: 'openPanel', panel: 'paths', messageId: 'root' });
    const memory = (await host.request('memory')).result;
    expect(memory.lines[0]).toMatch(/^Seqcall \(this process, pid \d+\): \d+ MB$/);
    expect(memory.summary).toMatch(/^Seqcall uses \d+ MB\.$/);
    expect((await host.request('freeMemory')).result).toBe('Seqcall dropped its caches.');
    await host.shutdown();
  });

  it('FR-15.2 initialize without a workspace keeps the one the sidecar started with; its C# sidecar path is used', async () => {
    put('ws/src/order.ts', 'export class Order {\n  total() {\n    return 1;\n  }\n}\n');
    const host = rpcHost({ workspace: `${tmp}/ws` });
    await host.request('initialize', {});
    await host.request('openAt', { file: `${tmp}/ws/src/order.ts`, position: { line: 2, character: 4 } });
    expect(host.lines.find((l) => l.method === 'progress')).toEqual({ jsonrpc: '2.0', method: 'progress', params: { title: 'Analysing ws…' } });

    put('cs/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    const cs = put('cs/Order.cs', 'public class Order {\n  public int Total() {\n    return 1;\n  }\n}\n');
    await host.request('initialize', { csharpSidecar: `${tmp}/none/Seqcall.CSharp.dll` });
    await host.request('openAt', { file: cs, position: { line: 2, character: 4 } });
    expect(posts(host.lines, 'sequence').at(-1)).toEqual({ type: 'error', message: expect.stringMatching(new RegExp(`^C# sidecar not found at ${tmp}/none/Seqcall\\.CSharp\\.dll\\.`)) });
    await host.shutdown();
  });

  it('FR-25.2 a shared diagram state names the editor: the one initialize gives, else JetBrains (stdio mode)', async () => {
    const host = rpcHost({ workspace: REPO });
    const toolOfCopy = async () => {
      await host.request('openAt', { file: CONTROLLER, position: positionOf(CONTROLLER, 'this.validate(id);') });
      await host.request('view', { view: 'sequence', message: { type: 'copyState' } });
      return JSON.parse(posts(host.lines, 'sequence').filter((m) => m.type === 'diagramState').at(-1).text).tool;
    };
    expect(await toolOfCopy()).toEqual({ version: STDIO_HOST_VERSION, host: 'jetbrains' });
    await host.request('initialize', { workspace: REPO, host: 'neovim' });
    expect(await toolOfCopy()).toEqual({ version: STDIO_HOST_VERSION, host: 'neovim' });
    await host.shutdown();
  });

  it('FR-24.11 a changed class opens side by side: the editor gets the file, its base text and a title', async () => {
    const root = `${tmp}/shop`;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
    put('shop/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
    const baseTax = 'export class Tax {\n  rate() {\n    return 1;\n  }\n}\n';
    put('shop/src/tax.ts', baseTax);
    const order = put('shop/src/order.ts', "import { Tax } from './tax';\nexport class Order {\n  total() {\n    return new Tax().rate();\n  }\n}\n");
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature/tax');
    put('shop/src/tax.ts', 'export class Tax {\n  rate() {\n    return 2;\n  }\n}\n');
    git('commit', '-q', '-am', 'tax');

    const host = rpcHost({ workspace: root });
    await host.request('openAt', { file: order, position: positionOf(order, 'return new Tax') });
    await host.request('view', { view: 'sequence', message: { type: 'requestReview' } });
    expect(posts(host.lines, 'sequence').find((m) => m.type === 'review' && m.state !== 'running')).toMatchObject({ state: 'done' });
    await host.request('view', { view: 'class', message: { type: 'openDiff', classKey: 'src/tax.ts#Tax' } });
    expect(host.lines.find((l) => l.method === 'openDiff')).toEqual({
      jsonrpc: '2.0',
      method: 'openDiff',
      params: { file: `${root}/src/tax.ts`, line: 2 /* the changed line, 0-based */, baseText: baseTax, title: 'tax.ts (develop ↔ feature/tax)' },
    });
    await host.shutdown();
  });
});

describe('FR-21 browser mode through the server', () => {
  const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-rpc-webview-'));
  for (const f of ['sequence.js', 'class.js', 'styles.css']) fs.writeFileSync(path.join(webviewDir, f), `/* ${f} */`);
  afterAll(() => fs.rmSync(webviewDir, { recursive: true, force: true }));

  it('FR-21.1 a port already in use: the editor is told why, the sidecar keeps answering without browser URLs', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const host = rpcHost({ workspace: REPO, browser: { webviewDir, port } });
      const init = await host.request('initialize', { workspace: REPO });
      expect(host.lines.find((l) => l.method === 'log')).toEqual({ jsonrpc: '2.0', method: 'log', params: { level: 'error', message: `browser mode: listen EADDRINUSE: address already in use 127.0.0.1:${port}` } });
      expect(init.result).not.toHaveProperty('browser');
      await host.shutdown();
    } finally {
      blocker.close();
    }
  });

  it('showEntryPoints: no page yet → the page opens and gets the list once it is ready; a connected page gets it at once; without a browser it is posted', async () => {
    const app = `${REPO}/fixtures/sample-app`; // a small project: its entry points come quickly
    const host = rpcHost({ workspace: app, browser: { webviewDir } });
    const url = (await host.request('initialize', { workspace: app })).result.browser.sequence;
    await host.request('showEntryPoints', {});
    expect(host.lines.filter((l) => l.method === 'openBrowser').map((l) => l.params)).toEqual([{ view: 'sequence', url }]);
    const seq = await events(url.replace('/sequence?', '/events/sequence?'));
    await intent(url, 'sequence', { type: 'ready' });
    expect((await seq.next((m) => m.type === 'empty')).reason).toContain('Place the caret');
    const list = await seq.next((m) => m.type === 'entryPoints');
    expect([list.show, list.entryPoints.length > 0]).toEqual([true, true]);
    // the page is there: the list goes to it at once, no new tab
    await host.request('showEntryPoints', {});
    await seq.next((m) => m.type === 'entryPoints' && m !== list);
    expect(host.lines.filter((l) => l.method === 'openBrowser')).toHaveLength(1);
    seq.close();
    await host.shutdown();
    const plain = rpcHost({ workspace: app });
    await plain.request('showEntryPoints', {});
    expect(posts(plain.lines, 'sequence').find((m) => m.type === 'entryPoints')).toMatchObject({ show: true });
    await plain.shutdown();
  }, 60_000);

  it('FR-21.1 showView asks the editor to open the page each time while none is connected; a page posting a broken message is reported', async () => {
    const host = rpcHost({ workspace: REPO, browser: { webviewDir } });
    const url = (await host.request('initialize', { workspace: REPO })).result.browser.sequence;
    await host.request('showView', { view: 'sequence' });
    await host.request('showView', { view: 'sequence' }); // within the grace time of the first: asked again on request
    expect(host.lines.filter((l) => l.method === 'openBrowser').map((l) => l.params)).toEqual([
      { view: 'sequence', url },
      { view: 'sequence', url },
    ]);
    expect((await intent(url, 'sequence', null as unknown as object)).status).toBe(204);
    expect((await host.next((l) => l.method === 'log', 'the log of the broken message')).params).toEqual({ level: 'error', message: "sequence view: Cannot read properties of null (reading 'type')" });
    await host.shutdown();
  });
});
