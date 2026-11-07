import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Position } from '@seqcall/protocol';
import { startServer } from '../src/server';
import { Browser, findChrome, type Page } from './cdp';

/**
 * User stories in a real browser (headless Chrome) against the production stack of the browser mode (FR-21): the
 * real page (packages/webview/dist), the real controller and core on fixtures/sample-app. What only a real page
 * shows: clicks that reach their button, menus, the page's geometry, two pages kept in step, the editor told.
 * Diagram content is the golden tests' (packages/core/test/golden); the VS Code webview under its CSP is FR-12.1's.
 * Skipped without Chrome (`$CHROME` or google-chrome-stable / chromium on the PATH).
 */
const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const ROOT = `${REPO}/fixtures/sample-app`;
const CONTROLLER = `${ROOT}/src/controllers/user-controller.ts`;
const WEBVIEW = `${REPO}/packages/webview`;
const chrome = findChrome();

function positionOf(file: string, needle: string): Position {
  const before = fs.readFileSync(file, 'utf8').split(needle)[0].split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

/** The page bundles, rebuilt when a webview source is newer (an old bundle would test an old page). */
function freshWebview(): void {
  const newest = (dir: string): number =>
    Math.max(...fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).mtimeMs)));
  const built = ['sequence.js', 'class.js', 'styles.css'].map((f) => path.join(WEBVIEW, 'dist', f));
  if (built.every((f) => fs.existsSync(f)) && Math.min(...built.map((f) => fs.statSync(f).mtimeMs)) >= newest(path.join(WEBVIEW, 'src'))) return;
  execFileSync(process.execPath, ['build.mjs'], { cwd: WEBVIEW, stdio: 'ignore' });
}

/** The sidecar in browser mode over in-memory JSON-RPC: what the editor receives, and requests to it. */
function editor() {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let buf = '';
  output.on('data', (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
  });
  const handle = startServer(input, output, { workspace: ROOT, browser: { webviewDir: `${WEBVIEW}/dist` } });
  let id = 0;
  const next = async <T = any>(what: string, pred: (l: any) => boolean, from = 0, timeoutMs = 30_000): Promise<T> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
      const hit = lines.slice(from).find(pred);
      if (hit) return hit;
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  return {
    handle,
    lines,
    next,
    notify: (method: string, params: object) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    request: async (method: string, params: object) => {
      const n = ++id;
      input.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      return (await next(`the answer to ${method}`, (l) => l.id === n)).result;
    },
  };
}

describe.skipIf(!chrome)('user stories in a real browser (browser mode, fixtures/sample-app)', () => {
  let browser: Browser;
  let host: ReturnType<typeof editor>;
  let urls: { sequence: string; class: string };
  const pages: Page[] = [];

  beforeAll(async () => {
    freshWebview();
    browser = await Browser.launch(chrome!);
    host = editor();
    urls = (await host.request('initialize', { workspace: ROOT })).browser;
  }, 120_000);

  afterAll(async () => {
    for (const p of pages) p.close();
    await browser?.close();
    host?.notify('shutdown', {});
    await host?.handle.closed;
  });

  afterEach(() => {
    // every story: no exception and no console error in any page
    expect(pages.flatMap((p) => p.errors)).toEqual([]);
  });

  /** The sequence page showing the method at `needle` in the controller (as Show Sequence Diagram there). */
  async function sequenceAt(needle: string): Promise<Page> {
    const from = host.lines.length;
    host.notify('openAt', { file: CONTROLLER, position: positionOf(CONTROLLER, needle) });
    if (!pages[0]) {
      await host.next('the editor asked to open the page', (l) => l.method === 'openBrowser' && l.params.view === 'sequence', from);
      pages[0] = await browser.page(urls.sequence);
    }
    const page = pages[0];
    // a fresh page for every story: a menu or find bar a failed story left open does not fail the next ones
    await page.goto(urls.sequence);
    await page.waitFor('a diagram', `document.querySelectorAll('[data-msg-id]').length > 1`);
    await page.settled();
    return page;
  }

  const labels = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('[data-participant-id]')].map((g) => g.textContent.trim())`);

  it('FR-1.1 / FR-3.1 a diagram opens in the page; ⊕ on a call (a real click) draws its calls; participant boxes do not overlap', async () => {
    const page = await sequenceAt('this.validate(id);');
    const findUser = await page.eval<string>(`[...document.querySelectorAll('[data-msg-id]')].find((g) => g.textContent.includes('findUser'))?.getAttribute('data-msg-id')`);
    expect(findUser).toBeTruthy();
    expect(await page.eval<number>(`document.querySelectorAll('[data-msg-id^="${findUser}/"]').length`)).toBe(0);
    await page.click(`[data-msg-id="${findUser}"] [data-action="expand"]`);
    await page.waitFor('the calls of findUser', `document.querySelectorAll('[data-msg-id^="${findUser}/"]').length > 0`);
    await page.settled();
    expect((await labels(page)).some((l) => l.includes('UserRepository'))).toBe(true);
    // the boxes of the objects side by side, none over another
    const boxes = await page.eval<{ l: number; r: number }[]>(`[...document.querySelectorAll('.participants [data-participant-id] .p-box')].map((b) => { const r = b.getBoundingClientRect(); return { l: r.left, r: r.right }; }).sort((a, b) => a.l - b.l)`);
    expect(boxes.length).toBeGreaterThan(3);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].l, `box ${i} starts before box ${i - 1} ends`).toBeGreaterThanOrEqual(boxes[i - 1].r - 0.5);
  });

  /** The id of the first drawn call whose label contains `text`. */
  const callId = (page: Page, text: string) =>
    page.waitFor<string>(`a call ${text}`, `[...document.querySelectorAll('[data-msg-id]')].find((g) => g.querySelector('.msg-label')?.textContent.includes(${JSON.stringify(text)}))?.getAttribute('data-msg-id')`);

  it('FR-2.1 a click on a call tells the editor to open its line', async () => {
    const page = await sequenceAt('this.validate(id);');
    const slugify = await callId(page, 'slugify');
    const from = host.lines.length;
    await page.click(`[data-msg-id="${slugify}"] .msg-label text`);
    const nav = await host.next<{ params: { range: { file: string; start: { line: number } } } }>('navigate', (l) => l.method === 'navigate', from);
    expect(nav.params.range.file).toBe(CONTROLLER);
    expect(nav.params.range.start.line).toBe(positionOf(CONTROLLER, "['a', 'b'].map((t) => slugify(t))").line);
  });

  it('FR-11.1 / FR-11.3 Hide from the context menu; ⊘ Filters lists the rule and a click brings the calls back', async () => {
    const page = await sequenceAt('this.validate(id);');
    const count = () => page.eval<number>(`[...document.querySelectorAll('[data-msg-id] .msg-label')].filter((l) => l.textContent.includes('info(')).length`);
    expect(await count()).toBe(1);
    await page.click(`[data-msg-id="${await callId(page, 'info(')}"] .msg-label text`, { button: 'right' });
    await page.click('[data-menu-id="hide-menu"]');
    await page.click('[data-menu-id="hide-name"]');
    await page.waitFor('info hidden', `![...document.querySelectorAll('[data-msg-id] .msg-label')].some((l) => l.textContent.includes('info('))`);
    await page.settled();
    await page.click('[data-cmd="hidden"]');
    await page.click(await page.withText('.menu-item', 'info'));
    await page.waitFor('info back', `[...document.querySelectorAll('[data-msg-id] .msg-label')].some((l) => l.textContent.includes('info('))`);
    expect(await count()).toBe(1);
  });

  it('FR-3.12 the ▾ menu: One more level opens the next calls, Collapse all goes back to depth 1', async () => {
    const page = await sequenceAt('this.validate(id);');
    const drawn = () => page.eval<number>(`document.querySelectorAll('[data-msg-id]').length`);
    const before = await drawn();
    await page.click('[data-cmd="expandMenu"]');
    await page.click('[data-menu-id="expand-one-level"]');
    await page.waitFor('one more level', `document.querySelectorAll('[data-msg-id]').length > ${before}`);
    await page.settled();
    await page.click('[data-cmd="expandMenu"]');
    await page.click('[data-menu-id="collapse-all"]');
    await page.waitFor('depth 1 again', `document.querySelectorAll('[data-msg-id]').length === ${before}`);
    expect(await drawn()).toBe(before);
  });

  it('FR-23.1 / FR-23.3 Ctrl+F opens the find bar; a call inside a collapsed one is found and revealed', async () => {
    const page = await sequenceAt('this.validate(id);');
    expect(await page.eval<boolean>(`!document.querySelector('[data-msg-id] .msg-label') || ![...document.querySelectorAll('[data-msg-id] .msg-label')].some((l) => l.textContent.includes('query('))`)).toBe(true);
    await page.eval(`document.querySelector('.seq-scroll').focus()`); // the keyboard in the diagram (as after a click in it)
    await page.key('f', 2);
    await page.waitFor('the find bar', `!document.querySelector('.find-bar').hidden && document.activeElement === document.querySelector('.find-input')`);
    await page.type('query');
    await page.click(await page.withText('.find-deep-item', 'query'));
    await page.waitFor('the hit drawn and highlighted', `[...document.querySelectorAll('[data-msg-id].highlighted .msg-label')].some((l) => l.textContent.includes('query('))`);
    await page.key('Escape');
  });

  it('FR-16.2 ⌂ lists the entry points; a click opens that flow', async () => {
    const page = await sequenceAt('this.validate(id);');
    await page.click('[data-cmd="entryPoints"]');
    const key = await page.waitFor<string>('the entry points', `document.querySelector('.ep-item')?.getAttribute('data-method-key')`);
    await page.click(`.ep-item[data-method-key="${key}"]`);
    const name = key.slice(key.lastIndexOf('.') + 1);
    await page.waitFor(`the flow of ${name}`, `document.querySelector('[data-msg-id="root"] .msg-label')?.textContent.includes(${JSON.stringify(name)})`);
    expect(await page.eval<string>(`document.querySelector('[data-msg-id="root"] .msg-label').textContent`)).toContain(name);
  });

  it('FR-12.1 / FR-12.9 the class page draws the flow\'s classes apart; a relation clicked there highlights its calls in the sequence page', async () => {
    const page = await sequenceAt('this.validate(id);');
    const from = host.lines.length;
    await page.click('[data-cmd="classDiagram"]');
    const open = await host.next<{ params: { url: string } }>('the class page asked for', (l) => l.method === 'openBrowser' && l.params.view === 'class', from);
    const cls = await browser.page(open.params.url);
    pages.push(cls);
    await cls.waitFor('classes', `document.querySelectorAll('.class-node').length > 2`);
    await host.next('the class view rendered', (l) => l.method === 'log' && /class view rendered [1-9]/.test(l.params.message), from);
    await cls.settled();
    const nodes = await cls.eval<{ l: number; t: number; r: number; b: number }[]>(`[...document.querySelectorAll('.class-node')].map((n) => { const r = n.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })`);
    for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) expect(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, 'two class boxes overlap').toBe(true);
    // a relation with calls behind it: a point on its line
    const rel = await cls.waitFor<{ id: string; x: number; y: number }>('a relation', `(() => { for (const g of document.querySelectorAll('.relation.rel-dependency[data-relation-id], .relation.rel-association[data-relation-id]')) { const p = g.querySelector('.rel-hit'); if (!p) continue; const pt = p.getPointAtLength(p.getTotalLength() / 2); const m = p.getScreenCTM(); const x = m.a * pt.x + m.c * pt.y + m.e, y = m.b * pt.x + m.d * pt.y + m.f; const t = document.elementFromPoint(x, y); if (t && g.contains(t)) return { id: g.getAttribute('data-relation-id'), x, y }; } return null; })()`);
    // (another story may have left a call highlighted: the highlight has to change to the relation's calls)
    const highlighted = `[...document.querySelectorAll('[data-msg-id].highlighted')].map((g) => g.getAttribute('data-msg-id')).join(' ')`;
    const before = await page.eval<string>(highlighted);
    await cls.click(`[data-relation-id="${rel.id}"]`, { at: rel });
    await page.waitFor('its calls highlighted in the sequence page', `(() => { const now = ${highlighted}; return now !== '' && now !== ${JSON.stringify(before)}; })()`);
  });

  it('FR-28.1 ◫ Layers draws one lifeline per layer; a second click the objects again', async () => {
    const page = await sequenceAt('this.validate(id);');
    await page.click('[data-cmd="layerZoom"]');
    await page.waitFor('layer lifelines', `document.querySelectorAll('.participants [data-participant-id^="layer:"]').length > 1`);
    await page.settled();
    await page.click('[data-cmd="layerZoom"]');
    await page.waitFor('the objects again', `!document.querySelector('.participants [data-participant-id^="layer:"]')`);
    expect(await page.eval<number>(`document.querySelectorAll('.participants [data-participant-id]').length`)).toBeGreaterThan(1);
  });
});
