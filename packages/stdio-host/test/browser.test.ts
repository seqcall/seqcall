import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { Position } from '@seqcall/protocol';
import { startServer } from '../src/server';
import { events, intent } from './sse';

const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const CONTROLLER = `${REPO}/fixtures/sample-app/src/controllers/user-controller.ts`;

function positionOf(file: string, needle: string): Position {
  const text = fs.readFileSync(file, 'utf8');
  const before = text.slice(0, text.indexOf(needle)).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

// Stub bundles: the bridge only serves them.
const webviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-webview-'));
for (const f of ['sequence.js', 'class.js', 'styles.css']) fs.writeFileSync(path.join(webviewDir, f), `/* ${f} */`);
afterAll(() => fs.rmSync(webviewDir, { recursive: true, force: true }));

/** JSON-RPC over in-memory streams; `next(pred)` waits for a matching line. */
function rpcHost() {
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
  const handle = startServer(input, output, { workspace: REPO, browser: { webviewDir } });
  return {
    handle,
    lines,
    send: (obj: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'),
    next: (pred: (l: any) => boolean) => // eslint-disable-line @typescript-eslint/no-explicit-any
      new Promise<any>((resolve) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const hit = lines.find(pred);
        if (hit) resolve(hit);
        else waiters.push({ pred, resolve });
      }),
  };
}

describe('browser mode (FR-21: views in a browser tab for editors without HTML views)', () => {
  it('FR-21.1 serves the views on 127.0.0.1 behind a token, pushes models over SSE and takes intents by POST', async () => {
    const host = rpcHost();
    host.send({ id: 1, method: 'initialize', params: { workspace: REPO } });
    const init = await host.next((l) => l.id === 1);
    const seqUrl: string = init.result.browser.sequence;
    expect(seqUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sequence\?t=[0-9a-f]{32}$/);

    // Wrong token: nothing is served.
    const stale = await fetch(seqUrl.replace(/t=\w+/, 't=nope'));
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain(':SeqcallOpen'); // the page says what to do
    expect((await fetch(seqUrl.replace(/\?t=\w+/, ''))).status).toBe(403);
    // A page without the current token is reported to the editor; the browser's favicon request is not.
    expect((await fetch(seqUrl.replace(/\/sequence\?t=\w+/, '/favicon.ico'))).status).toBe(403);
    const rejected = host.lines.filter((l) => l.method === 'log' && /without the current token/.test(l.params.message));
    expect(rejected.map((l) => l.params.level)).toEqual(['error', 'error']);
    expect(rejected[0].params.message).toContain('/sequence');
    // The page defines the host bridge before the bundle and loads the assets with the token.
    const html = await (await fetch(seqUrl)).text();
    expect(html.indexOf('__seqcallHostPost')).toBeLessThan(html.indexOf('/dist/sequence.js'));
    const token = new URL(seqUrl).searchParams.get('t');
    expect(await (await fetch(seqUrl.replace('/sequence?', '/dist/sequence.js?'))).text()).toContain('sequence.js');
    expect(html).toContain(`/dist/styles.css?t=${token}`);

    // openAt: no page yet → the editor is asked to open the URL; the model goes to the page, not stdout.
    host.send({ method: 'openAt', params: { file: CONTROLLER, position: positionOf(CONTROLLER, 'this.validate(id);') } });
    const open = await host.next((l) => l.method === 'openBrowser');
    expect(open.params).toEqual({ view: 'sequence', url: seqUrl });
    const seq = await events(seqUrl.replace('/sequence?', '/events/sequence?'));
    expect(seq.status).toBe(200);
    await intent(seqUrl, 'sequence', { type: 'ready' });
    const render = await seq.next((m) => m.type === 'render');
    expect(render.diagram.root.name).toBe('getUser');
    expect(host.lines.some((l) => l.method === 'post')).toBe(false);

    // A click in the page navigates the editor (stdout notification).
    const range = render.diagram.messages[0].callSite;
    expect(range).toBeDefined();
    await intent(seqUrl, 'sequence', { type: 'navigate', range });
    expect((await host.next((l) => l.method === 'navigate')).params.range).toEqual(range);

    // A second openAt while the page is connected does not open another tab.
    host.send({ id: 2, method: 'openAt', params: { file: CONTROLLER, position: positionOf(CONTROLLER, 'this.validate(id);') } });
    await host.next((l) => l.id === 2);
    expect(host.lines.filter((l) => l.method === 'openBrowser')).toHaveLength(1);

    // The class view: requested from the page → its URL; its page gets the class diagram.
    await intent(seqUrl, 'sequence', { type: 'openClassDiagram' });
    const openClass = await host.next((l) => l.method === 'openBrowser' && l.params.view === 'class');
    const cls = await events(openClass.params.url.replace('/class?', '/events/class?'));
    await intent(openClass.params.url, 'class', { type: 'ready' });
    expect((await cls.next((m) => m.type === 'render')).diagram.classes.length).toBeGreaterThan(0);

    // showView re-opens a view on request even when its page is connected (the tab may be hidden).
    host.send({ id: 3, method: 'showView', params: { view: 'sequence' } });
    expect((await host.next((l) => l.method === 'openBrowser' && l.params.connected)).params.view).toBe('sequence');

    seq.close();
    cls.close();
    host.send({ id: 9, method: 'shutdown' });
    await host.handle.closed;
    await expect(fetch(seqUrl)).rejects.toThrow(); // the port is closed with the sidecar
  });
});
