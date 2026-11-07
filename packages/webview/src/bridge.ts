/**
 * Host abstraction. The views talk to the editor only through this interface, so the
 * same bundle runs in a VS Code webview, a JetBrains JCEF browser, or the dev harness.
 */
export interface HostBridge<In, Out> {
  post(msg: Out): void;
  /** Subscribes to host messages; returns an unsubscribe function. */
  onMessage(cb: (msg: In) => void): () => void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  // Provided by VS Code inside webviews.
  // eslint-disable-next-line no-var
  var acquireVsCodeApi: (() => VsCodeApi) | undefined;
  interface Window {
    /** Optional host hook (e.g. injected by a JCEF host) used by the fallback bridge. */
    __seqcallHostPost?: (msg: unknown) => void;
  }
}

function listenWindow<In>(cb: (msg: In) => void, accept: (e: MessageEvent) => boolean = () => true): () => void {
  const handler = (e: MessageEvent) => {
    if (accept(e) && e.data && typeof e.data === 'object' && typeof e.data.type === 'string') cb(e.data as In);
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}

let vscodeApi: VsCodeApi | undefined;

export function createVsCodeBridge<In, Out>(): HostBridge<In, Out> {
  // acquireVsCodeApi may only be called once per webview.
  vscodeApi ??= globalThis.acquireVsCodeApi!();
  const api = vscodeApi;
  return {
    post: (msg) => api.postMessage(msg),
    onMessage: (cb) => listenWindow(cb),
    getState: <T>() => (api.getState() ?? undefined) as T | undefined,
    setState: (s) => api.setState(s),
  };
}

/**
 * Fallback for non-VS Code hosts: outgoing messages go to `window.__seqcallHostPost` if a
 * host injected it, otherwise to an `seqcall:intent` event. Incoming messages are `window`
 * message events the page posts to itself (JCEF runs `window.postMessage`, browser mode
 * and the dev host forward their event stream / responses the same way); messages from
 * other windows (an opener, a framing page) are ignored. State is kept in memory
 * (+ sessionStorage when available).
 */
export function createWindowBridge<In, Out>(storageKey = 'seqcall-state'): HostBridge<In, Out> {
  let memory: unknown;
  try {
    const raw = window.sessionStorage?.getItem(storageKey);
    if (raw) memory = JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return {
    post(msg) {
      if (typeof window.__seqcallHostPost === 'function') window.__seqcallHostPost(msg);
      else window.dispatchEvent(new CustomEvent('seqcall:intent', { detail: msg }));
    },
    onMessage: (cb) => listenWindow(cb, (e) => e.source === window),
    getState: <T>() => memory as T | undefined,
    setState(s) {
      memory = s;
      try {
        window.sessionStorage?.setItem(storageKey, JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
  };
}

export function createHostBridge<In, Out>(): HostBridge<In, Out> {
  return typeof globalThis.acquireVsCodeApi === 'function' ? createVsCodeBridge<In, Out>() : createWindowBridge<In, Out>();
}
