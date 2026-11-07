import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * Browser mode (FR-21): for editors that cannot show HTML (Vim), the views run in a browser tab
 * served by the sidecar itself. Host → view messages are pushed over Server-Sent Events, view → host
 * messages arrive as POSTs and go through the same ordered queue as the JSON-RPC requests. Only
 * 127.0.0.1, every request needs the random token of the URLs the editor opens.
 */
export type ViewName = 'sequence' | 'class';

export interface BrowserBridgeOptions {
  /** Directory with sequence.js, class.js and styles.css (packages/webview/dist). */
  webviewDir: string;
  /** 0 (default): any free port. */
  port?: number;
  /** A view message from the page (`ready`, intents); called in arrival order per request. */
  onViewMessage(view: ViewName, message: unknown): void;
  /** The last page of a view went away (class: stop deriving class diagrams). */
  onViewClosed?(view: ViewName): void;
  /** A view page was requested without the current token (an old tab, a shortened URL). */
  onRejected?(path: string): void;
}

export interface BrowserBridge {
  /** `http://127.0.0.1:<port>/<view>?t=<token>`. */
  url(view: ViewName): string;
  /** Push a host message to every open page of the view. */
  post(view: ViewName, message: unknown): void;
  /** Number of connected pages of the view. */
  clients(view: ViewName): number;
  close(): Promise<void>;
}

const ASSETS: Record<string, string> = { 'sequence.js': 'text/javascript', 'class.js': 'text/javascript', 'styles.css': 'text/css' };

/** The page defines `__seqcallHostPost` before the bundle runs; messages wait until the event stream is open, so `ready` is never answered into the void. */
const page = (view: ViewName, token: string): string => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Seqcall · ${view === 'sequence' ? 'Sequence' : 'Class'}</title>
<link rel="stylesheet" href="/dist/styles.css?t=${token}"></head>
<body><div id="app"></div>
<script>(function () {
  var token = ${JSON.stringify(token)}, pending = [], open = false;
  var send = function (msg) { fetch('/intent/${view}?t=' + token, { method: 'POST', body: JSON.stringify(msg) }); };
  var events = new EventSource('/events/${view}?t=' + token);
  events.onopen = function () { open = true; pending.splice(0).forEach(send); };
  events.onmessage = function (e) { window.postMessage(JSON.parse(e.data), '*'); };
  window.__seqcallHostPost = function (msg) { if (open) send(msg); else pending.push(msg); };
})();</script>
<script src="/dist/${view}.js?t=${token}"></script>
</body></html>`;

export function startBrowserBridge(opts: BrowserBridgeOptions): Promise<BrowserBridge> {
  const token = randomBytes(16).toString('hex');
  const streams: Record<ViewName, Set<ServerResponse>> = { sequence: new Set(), class: new Set() };
  const viewOf = (name: string): ViewName | undefined => (name === 'sequence' || name === 'class' ? name : undefined);

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // the http server sets the request's url on every request (it is unset only on client-side responses)
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.searchParams.get('t') !== token) {
      // Only pages are worth a message (not e.g. the browser's own favicon request).
      if (viewOf(url.pathname.slice(1))) opts.onRejected?.(url.pathname);
      res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        .end(
          'Seqcall: wrong or missing token.\n\nThis page belongs to an earlier Seqcall session, or its URL was shortened.\n' +
            'Run :SeqcallOpen in your editor (Vim / Neovim) to open the current diagram.\n',
        );
      return;
    }
    const [, kind, name = ''] = url.pathname.split('/');
    const view = viewOf(kind) ?? viewOf(name);
    if (req.method === 'GET' && viewOf(kind) && !name) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(viewOf(kind)!, token));
    } else if (req.method === 'GET' && kind === 'dist' && ASSETS[name]) {
      // read first: a missing bundle is a 500 below, not a 200 with the error as the script
      const body = readFileSync(join(opts.webviewDir, name));
      res.writeHead(200, { 'content-type': ASSETS[name], 'cache-control': 'no-store' }).end(body);
    } else if (req.method === 'GET' && kind === 'events' && view) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      streams[view].add(res);
      req.on('close', () => {
        streams[view].delete(res);
        if (streams[view].size === 0) opts.onViewClosed?.(view);
      });
    } else if (req.method === 'POST' && kind === 'intent' && view) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          opts.onViewMessage(view, JSON.parse(body));
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end('bad message');
        }
      });
    } else {
      res.writeHead(404).end();
    }
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      try {
        handle(req, res);
      } catch (e) {
        /* v8 ignore next -- nothing in handle() throws after its writeHead; the guard keeps an unknown error from throwing again here */
        if (!res.headersSent) res.writeHead(500);
        res.end(String(e));
      }
    });
    // Clicks arrive seconds apart: with Node's default 5 s keep-alive, a client reusing a connection just
    // as the server closes it gets ECONNRESET (seen under load in the tests; fetch does not retry).
    server.keepAliveTimeout = 60_000;
    server.headersTimeout = 65_000;
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: (view) => `http://127.0.0.1:${port}/${view}?t=${token}`,
        post: (view, message) => {
          const frame = `data: ${JSON.stringify(message)}\n\n`;
          for (const res of streams[view]) res.write(frame);
        },
        clients: (view) => streams[view].size,
        close: () =>
          new Promise<void>((done) => {
            for (const set of Object.values(streams)) for (const res of set) res.end();
            server.close(() => done());
          }),
      });
    });
  });
}
