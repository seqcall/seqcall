// Screenshot (and optional JS steps) of a JCEF page in a running IDE, via its remote DevTools
// (runIde starts the IDE with -Dide.browser.jcef.debug.port=9223). No dependencies; Node 22.
//   node packages/rider/scripts/jcef-screenshot.mjs <sequence|class> <out.png> [js step …]
// Env: PORT (default 9223).
import { writeFileSync } from 'node:fs';

const [view, out, ...steps] = process.argv.slice(2);
const port = Number(process.env.PORT ?? 9223);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.type === 'page' && t.url.endsWith(`/${view}.html`));
if (!target) {
  console.error(`no ${view} page; targets: ${targets.map((t) => t.url).join(', ')}`);
  process.exit(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const call = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
for (const step of steps) {
  const r = await call('Runtime.evaluate', { expression: step, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text));
}
const shot = await call('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(`wrote ${out}`);
ws.close();
