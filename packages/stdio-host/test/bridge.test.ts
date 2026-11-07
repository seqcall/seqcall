import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { startBrowserBridge, type BrowserBridge, type ViewName } from '../src/browser';
import { events, intent } from './sse';

// The browser bridge alone (FR-21), with stub bundles; browser.test.ts runs it behind the JSON-RPC server.
const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-bridge-'));
for (const f of ['sequence.js', 'styles.css']) fs.writeFileSync(path.join(webviewDir, f), `/* ${f} */`); // class.js is missing
afterAll(() => fs.rmSync(webviewDir, { recursive: true, force: true }));

let bridge: BrowserBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

async function start() {
  const messages: [ViewName, unknown][] = [];
  const closed: ViewName[] = [];
  bridge = await startBrowserBridge({ webviewDir, onViewMessage: (view, message) => messages.push([view, message]), onViewClosed: (view) => closed.push(view) });
  const b = bridge;
  /** A path of the bridge with the current token. */
  const at = (p: string) => b.url('sequence').replace('/sequence?', `${p}?`);
  return { bridge: b, messages, closed, at };
}

/** A raw HTTP request (fetch cannot send a malformed request line). */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('FR-21 browser bridge', () => {
  it('FR-21.1 each view has its own page: title and bundle of the view, with the token', async () => {
    const { bridge: b } = await start();
    const token = new URL(b.url('class')).searchParams.get('t');
    const cls = await (await fetch(b.url('class'))).text();
    expect(cls).toContain('<title>Seqcall · Class</title>');
    expect(cls).toContain(`<script src="/dist/class.js?t=${token}"></script>`);
    expect(await (await fetch(b.url('sequence'))).text()).toContain('<title>Seqcall · Sequence</title>');
  });

  it('FR-21.1 unknown paths and views are 404 and reach no view', async () => {
    const { at, messages } = await start();
    const status = async (p: string, method = 'GET') => (await fetch(at(p), { method, ...(method === 'POST' ? { body: '{"type":"ready"}' } : {}) })).status;
    expect(await status('/intent/nope', 'POST')).toBe(404);
    expect(await status('/intent/sequence')).toBe(404); // an intent is a POST
    expect(await status('/events/nope')).toBe(404);
    expect(await status('/dist/app.js')).toBe(404);
    expect(await status('/sequence/extra')).toBe(404);
    expect(await status('/nothing')).toBe(404);
    expect(messages).toEqual([]);
  });

  it('FR-21.1 a view message must be JSON: else 400, and the host gets nothing', async () => {
    const { bridge: b, messages } = await start();
    const bad = await fetch(b.url('class').replace('/class?', '/intent/class?'), { method: 'POST', body: '{"type":' });
    expect([bad.status, await bad.text()]).toEqual([400, 'bad message']);
    expect(messages).toEqual([]);
    expect((await intent(b.url('class'), 'class', { type: 'ready' })).status).toBe(204);
    expect(messages).toEqual([['class', { type: 'ready' }]]);
  });

  it('FR-21.1 a view counts as closed when its last page went away, not before', async () => {
    const { bridge: b, closed } = await start();
    const events1 = await events(b.url('class').replace('/class?', '/events/class?'));
    const events2 = await events(b.url('class').replace('/class?', '/events/class?'));
    expect(b.clients('class')).toBe(2);
    b.post('class', { type: 'empty', reason: 'x' });
    expect(await events2.next((m) => m.type === 'empty', 'the posted message', 2000)).toEqual({ type: 'empty', reason: 'x' });
    events1.close();
    for (let i = 0; i < 100 && b.clients('class') > 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(b.clients('class')).toBe(1);
    expect(closed).toEqual([]);
    events2.close();
    for (let i = 0; i < 100 && !closed.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toEqual(['class']);
  });

  it('FR-21.1 a bundle missing from the webview folder is a server error, not an empty script', async () => {
    const { at } = await start();
    const res = await fetch(at('/dist/class.js'));
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/^Error: ENOENT: no such file or directory, open '.*class\.js'$/);
    // the bridge keeps serving
    expect(await (await fetch(at('/dist/sequence.js'))).text()).toBe('/* sequence.js */');
  });

  it('FR-21.1 a request with a malformed URL gets a server error, the bridge keeps serving', async () => {
    const { bridge: b } = await start();
    const port = Number(new URL(b.url('sequence')).port);
    const reply = await raw(port, 'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    expect(reply).toMatch(/^HTTP\/1\.1 500 /);
    expect(reply).toContain('TypeError: Invalid URL');
    expect((await fetch(b.url('sequence'))).status).toBe(200);
  });
});
