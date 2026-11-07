import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A headless Chrome driven over the DevTools protocol (no dependency; the same approach as
 * packages/devhost/scripts/screenshot.mjs): pages, real mouse clicks at an element's centre (hit-tested, so a
 * button under a menu or card is not clickable), keys, waiting for a condition, and every page error recorded.
 */

/** The Chrome binary: `$CHROME`, else the first of google-chrome-stable / chromium / google-chrome on the PATH. */
export function findChrome(): string | undefined {
  if (process.env.CHROME) return process.env.CHROME;
  return ['google-chrome-stable', 'chromium', 'chromium-browser', 'google-chrome'].find((b) => spawnSync('which', [b], { stdio: 'ignore' }).status === 0);
}

type Pending = (m: { result?: any; error?: { message: string } }) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class Page {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  /** Uncaught exceptions and console errors of the page, oldest first. */
  readonly errors: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' '));
      }
    };
  }

  static async open(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }

  send(method: string, params: object = {}): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      this.pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor('the page loaded', 'document.readyState === "complete"');
    // when the DOM last changed: the settle point of `settled()`
    await this.eval('window.__changed = Date.now(); new MutationObserver(() => (window.__changed = Date.now())).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); true');
  }

  /** The value of a page expression (awaited when it is a promise). */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression}`);
    return r.result.value as T;
  }

  /** Polls `expression` until it is truthy; its value. */
  async waitFor<T = unknown>(what: string, expression: string, timeoutMs = 15_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.eval<T>(expression).catch(() => undefined);
      if (v) return v;
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}: ${expression}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** No DOM change for `quietMs` (late renders: the background I/O scan, ELK). */
  async settled(quietMs = 400, timeoutMs = 20_000): Promise<void> {
    await this.waitFor('a quiet page', `Date.now() - window.__changed > ${quietMs}`, timeoutMs);
  }

  /** The centre of the first element matching `selector` (scrolled into view). */
  async centre(selector: string): Promise<{ x: number; y: number }> {
    const box = await this.waitFor<{ x: number; y: number }>(
      `${selector} on screen`,
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
    );
    return box;
  }

  /** A real click (press / release) at the element's centre (or at `at`, a point of it); `button: 'right'` opens a context menu. */
  async click(selector: string, opts: { button?: 'left' | 'right'; modifiers?: number; at?: { x: number; y: number } } = {}): Promise<void> {
    const { x, y } = opts.at ?? (await this.centre(selector));
    // hit-test: what is on top there must be the element (or inside it)
    const top = await this.eval<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const t = document.elementFromPoint(${x}, ${y}); return !!e && !!t && (e === t || e.contains(t)); })()`);
    if (!top) throw new Error(`${selector} is covered at (${Math.round(x)}, ${Math.round(y)}): a click would not reach it`);
    const button = opts.button ?? 'left';
    const buttons = button === 'left' ? 1 : 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1, modifiers: opts.modifiers ?? 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers: opts.modifiers ?? 0 });
  }

  /** Marks the first element matching `selector` whose text contains `text` (for a click); its selector. */
  async withText(selector: string, text: string): Promise<string> {
    const mark = `e2e-${Math.random().toString(36).slice(2)}`;
    await this.waitFor(`${selector} with "${text}"`, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (e) e.setAttribute('data-e2e', ${JSON.stringify(mark)}); return !!e; })()`);
    return `[data-e2e="${mark}"]`;
  }

  /** A key with modifiers (2 = Ctrl), e.g. `key('f', 2)`. */
  async key(key: string, modifiers = 0): Promise<void> {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  }

  /** Text typed into the focused element. */
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  close(): void {
    this.ws.close();
  }
}

/** One headless Chrome; `page()` opens a new tab. `close()` kills it and removes its profile (also on exit). */
export class Browser {
  private constructor(
    private readonly chrome: ChildProcess,
    private readonly port: number,
    private readonly profile: string,
  ) {}

  static async launch(binary: string, width = 1500, height = 950): Promise<Browser> {
    // a short profile path: a long TMPDIR makes Chromium's socket path too long and it crashes (docs/RIDER-PLUGIN.md)
    const base = process.env.UDD ?? (tmpdir().length <= 40 ? tmpdir() : '/tmp');
    const profile = mkdtempSync(join(base, 'seqcall-chrome-'));
    const port = 9333 + Math.floor(Math.random() * 2000);
    // its own process group: Chrome's helper processes go with it (killing the main process alone leaves them writing the profile)
    const chrome = spawn(binary, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', detached: true });
    const browser = new Browser(chrome, port, profile);
    process.once('exit', () => browser.kill());
    for (let i = 0; i < 150; i++) {
      const pages = await browser.targets().catch(() => []);
      if (pages.length) return browser;
      await new Promise((r) => setTimeout(r, 100));
    }
    await browser.close();
    throw new Error(`Chrome (${binary}) did not open its DevTools port`);
  }

  private async targets(): Promise<{ type: string; webSocketDebuggerUrl: string }[]> {
    const all = (await (await fetch(`http://127.0.0.1:${this.port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    return all.filter((t) => t.type === 'page');
  }

  /** A new tab on `url`. */
  async page(url: string): Promise<Page> {
    const t = (await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
    const page = await Page.open(t.webSocketDebuggerUrl);
    await page.goto(url);
    return page;
  }

  /** Kills Chrome with its helper processes and removes the profile once they are gone. */
  async close(): Promise<void> {
    const exited = this.chrome.exitCode !== null || this.chrome.signalCode !== null ? Promise.resolve() : new Promise((r) => this.chrome.once('exit', r));
    this.kill();
    await exited;
    await new Promise((r) => setTimeout(r, 200)); // the helpers of the group end with it
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  /** The process group, at once (also when the test process exits). */
  kill(): void {
    try {
      process.kill(-this.chrome.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
