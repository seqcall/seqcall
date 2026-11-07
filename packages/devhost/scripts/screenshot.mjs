// Headless-Chrome driver for visual checks of the dev host (no dependencies; Node 22).
//
//   node packages/devhost/scripts/screenshot.mjs <url> <out.png> [width] [height] [step ...]
//
// Steps run in order after the page loaded (~3.5 s):
//   - any JavaScript expression → evaluated in the page, its (JSON) value is printed
//     e.g. "document.querySelector('[data-cmd=view]').click();document.querySelector('[data-menu-id$=lanes]').click();'ok'"
//          "new Promise(r => setTimeout(r, 2000)).then(() => 'waited')"   (wait for ELK etc.)
//   - drag:x1,y1,x2,y2   → real mouse press/move/release (x1==x2,y1==y2 = a click)
//   - wheel:x,y,deltaY   → Ctrl+wheel (zoom) at x,y
// Env: PORT (DevTools port, default random), CHROME (binary, default google-chrome-stable),
//      UDD (directory for the throw-away Chrome profile, default the OS temp dir), DBG=1 (Chrome stderr),
//      DARK=1 (emulate prefers-color-scheme: dark — the views' dark fallback theme).
//
// Simple screenshots without interaction:
//   google-chrome-stable --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
//     --window-size=1700,1000 --virtual-time-budget=5000 --screenshot=out.png "<url>"
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, w = '1700', h = '1000', ...steps] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: screenshot.mjs <url> <out.png> [width] [height] [step ...]');
  process.exit(2);
}
const port = Number(process.env.PORT ?? 9333 + Math.floor(Math.random() * 500));
const profile = mkdtempSync(join(process.env.UDD ?? tmpdir(), 'seqcall-chrome-'));
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome-stable',
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
// never leave the headless Chrome or its throw-away profile behind (also when interrupted: a closed pipe, Ctrl+C, a timeout)
const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGPIPE', 'SIGHUP']) process.on(sig, () => process.exit(1));
chrome.stderr.on('data', (d) => process.env.DBG && process.stderr.write(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 150 && !targets?.find((t) => t.type === 'page'); i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    /* not up yet */
  }
  await sleep(200);
}
const page = targets?.find((t) => t.type === 'page');
if (!page) {
  console.error('Chrome DevTools endpoint not reachable');
  chrome.kill();
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
if (process.env.DARK) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await send('Page.navigate', { url });
await sleep(3500);
for (const s of steps) {
  if (s.startsWith('wheel:')) {
    const [x, y, dy] = s.slice(6).split(',').map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2 });
  } else if (s.startsWith('drag:')) {
    const [x1, y1, x2, y2] = s.slice(5).split(',').map(Number);
    const me = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    await me('mousePressed', x1, y1, { buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 8; k++) {
      await me('mouseMoved', x1 + ((x2 - x1) * k) / 8, y1 + ((y2 - y1) * k) / 8, { buttons: 1 });
      await sleep(20);
    }
    await me('mouseReleased', x2, y2, { buttons: 0, clickCount: 1 });
  } else {
    const r = await send('Runtime.evaluate', { expression: s, returnByValue: true, awaitPromise: true });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result));
  }
  await sleep(400);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
ws.close();
chrome.kill();
