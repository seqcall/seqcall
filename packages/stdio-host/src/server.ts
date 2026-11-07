import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { startBrowserBridge, type BrowserBridge, type ViewName } from './browser';
import { HeadlessController, type ControllerOptions, type HostSink } from './controller';

/**
 * Newline-delimited JSON-RPC 2.0 server on stdio (same framing as the C# sidecar, see
 * docs/RIDER-PLUGIN.md). Host → sidecar: requests (with `id`, answered) or notifications;
 * they are processed strictly in arrival order. Sidecar → host: notifications only
 * (`post`, `navigate`, `showClassDiagram`, `log`, `progress`).
 *
 * Browser mode (FR-21, `browser` option): the views run in a browser tab served by the sidecar
 * (browser.ts) instead of in the editor. `post` then goes to the pages, and the sidecar asks the
 * editor to open a view's URL with `openBrowser { view, url }` when no page of it is connected.
 */
export const STDIO_HOST_VERSION = '0.1.0';

interface RpcIn {
  jsonrpc?: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface BrowserModeOptions {
  /** Directory with the webview bundles (sequence.js, class.js, styles.css). */
  webviewDir: string;
  /** 0 / undefined: any free port. */
  port?: number;
}

export interface ServerOptions extends ControllerOptions {
  browser?: BrowserModeOptions;
}

/** Do not ask twice for the same view while a just-opened tab is still connecting. */
const OPEN_BROWSER_GRACE_MS = 10_000;

export interface ServerHandle {
  /** Settles when the input ended or `shutdown` was handled. */
  readonly closed: Promise<void>;
}

/**
 * Runs tasks one after another in arrival order. A task that throws is reported and does not
 * stop the tasks after it (a rejected chain would silently skip every later request).
 */
export function serialQueue(onError: (e: unknown) => void) {
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => (queue = queue.then(task).catch(onError));
  return { enqueue, idle: () => queue };
}

/** The text of a thrown value: the controller, the core and Node throw Error objects. */
/* v8 ignore next -- no input makes them throw a non-Error value */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function startServer(input: Readable, output: Writable, options: ServerOptions = {}): ServerHandle {
  const { browser: browserOptions, ...rest } = options;
  // FR-25.2 a shared diagram state says which Seqcall made it (browser mode serves Vim / Neovim, stdio Rider)
  const defaults = { toolVersion: STDIO_HOST_VERSION, hostName: browserOptions ? 'vim' : 'jetbrains', ...rest };
  const write = (obj: object) => output.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const notify = (method: string, params: unknown) => write({ method, params });
  let bridge: BrowserBridge | undefined;
  const openRequested: Record<ViewName, number> = { sequence: 0, class: 0 };
  const openBrowser = (view: ViewName) => {
    if (!bridge || bridge.clients(view) > 0 || Date.now() - openRequested[view] < OPEN_BROWSER_GRACE_MS) return;
    openRequested[view] = Date.now();
    notify('openBrowser', { view, url: bridge.url(view) });
  };
  const post = (view: ViewName, message: unknown) => (bridge ? bridge.post(view, message) : notify('post', { view, message }));
  const sink: HostSink = {
    postSequence: (message) => post('sequence', message),
    postClass: (message) => post('class', message),
    navigate: (range) => notify('navigate', { range }),
    openDiff: (target) => notify('openDiff', target),
    showClassDiagram: () => (bridge ? openBrowser('class') : notify('showClassDiagram', {})),
    log: (level, message) => notify('log', { level, message }),
    progress: (title) => notify('progress', { title }),
  };
  let controller = new HeadlessController(sink, defaults);
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const dispatch = async (msg: RpcIn): Promise<unknown> => {
    const p = (msg.params ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (msg.method) {
      case 'initialize':
        await controller.dispose();
        controller = new HeadlessController(sink, { ...defaults, workspace: p.workspace ?? defaults.workspace, csharpSidecar: p.csharpSidecar ?? defaults.csharpSidecar, ...(typeof p.host === 'string' ? { hostName: p.host } : {}) });
        return {
          name: 'seqcall-stdio-host',
          version: STDIO_HOST_VERSION,
          node: process.version,
          ...(bridge ? { browser: { sequence: bridge.url('sequence'), class: bridge.url('class') } } : {}),
        };
      case 'openAt':
        await controller.openAt(p.file, p.position);
        openBrowser('sequence');
        return null;
      case 'showView': // browser mode: open (again) a view's page
        if (bridge) {
          openRequested[p.view as ViewName] = 0;
          if (bridge.clients(p.view) === 0) openBrowser(p.view);
          else notify('openBrowser', { view: p.view, url: bridge.url(p.view), connected: true });
        }
        return null;
      case 'showEntryPoints': {
        // the entry-point list in the sequence page (opened when it is not), also before any diagram
        const connected = !bridge || bridge.clients('sequence') > 0;
        await controller.showEntryPoints(connected);
        if (bridge && !connected) {
          openRequested.sequence = 0;
          openBrowser('sequence');
        }
        return null;
      }
      case 'view':
        return p.view === 'class' ? controller.onClassMessage(p.message) : controller.onSequenceMessage(p.message);
      case 'viewClosed':
        if (p.view === 'class') controller.classViewClosed();
        return null;
      case 'filesChanged':
        return controller.filesChanged(p.files ?? []);
      case 'caretMoved':
        return controller.caretMoved(p.file, p.position);
      // FR-33.6 Info at Caret, FR-33.7 an entry point from it (or its Paths to here)
      case 'describeAt':
        return controller.describeAt(p.file, p.position, p.word);
      case 'openReach':
        await controller.openReach(p.file, p.position, p.word, p.index ?? 'paths');
        openBrowser('sequence');
        return null;
      // FR-34.4 memory
      case 'memory':
        return controller.memory();
      case 'freeMemory':
        return controller.freeMemory();
      case 'shutdown':
        closing = true;
        await controller.dispose();
        await bridge?.close();
        bridge = undefined;
        return null;
      default:
        throw Object.assign(new Error(`unknown method ${msg.method}`), { code: -32601 });
    }
  };

  /* v8 ignore next -- every task catches its own errors (requests, view messages, the bridge's start): this only reports an unknown one */
  const { enqueue, idle } = serialQueue((e) => sink.log('error', errorText(e)));
  if (browserOptions) {
    void enqueue(async () => {
      try {
        bridge = await startBrowserBridge({
          webviewDir: browserOptions.webviewDir,
          port: browserOptions.port,
          // Through the same queue as the editor's requests: strictly in arrival order.
          onViewMessage: (view, message) =>
            void enqueue(() =>
              (view === 'class' ? controller.onClassMessage(message as never) : controller.onSequenceMessage(message as never)).catch((e) =>
                sink.log('error', `${view} view: ${errorText(e)}`),
              ),
            ),
          onRejected: (path) =>
            sink.log('error', `a browser page asked for ${path} without the current token (an old tab or a shortened URL): use :SeqcallOpen`),
          onViewClosed: (view) => {
            if (view === 'class') void enqueue(async () => controller.classViewClosed());
          },
        });
      } catch (e) {
        sink.log('error', `browser mode: ${errorText(e)}`);
      }
    });
  }
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcIn;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    // valid JSON but no request object (`null`, `42`): JSON-RPC's invalid request (its id is unknown)
    if (msg === null || typeof msg !== 'object') {
      write({ id: null, error: { code: -32600, message: 'invalid request' } });
      return;
    }
    void enqueue(async () => {
      try {
        const result = await dispatch(msg);
        if (msg.id !== undefined) write({ id: msg.id, result: result ?? null });
      } catch (e) {
        const err = e as Error & { code?: number };
        if (msg.id !== undefined) write({ id: msg.id, error: { code: err.code ?? -32000, message: errorText(e) } });
        else sink.log('error', `${msg.method}: ${errorText(e)}`);
      }
      if (closing) {
        rl.close();
        resolveClosed();
      }
    });
  });
  rl.on('close', () => {
    void idle()
      .then(() => Promise.all([controller.dispose(), bridge?.close()]))
      .finally(resolveClosed);
  });
  return { closed };
}
