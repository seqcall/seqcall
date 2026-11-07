// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBridge, createWindowBridge } from '../src/bridge';

afterEach(() => {
  delete globalThis.acquireVsCodeApi;
  delete window.__seqcallHostPost;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** A fake of the API VS Code gives a webview (acquireVsCodeApi may be called only once per webview). */
function fakeVsCode(state: unknown = null) {
  const api = { posted: [] as unknown[], state, postMessage: (m: unknown) => void api.posted.push(m), getState: () => api.state, setState: (s: unknown) => void (api.state = s) };
  const acquire = vi.fn(() => api);
  globalThis.acquireVsCodeApi = acquire;
  return { api, acquire };
}

describe('window bridge (JCEF, browser mode, dev host)', () => {
  it('takes the messages the page posts to itself and ignores those from other windows', () => {
    const got: unknown[] = [];
    const off = createWindowBridge<{ type: string }, never>().onMessage((m) => got.push(m));
    // another window (an opener or a framing page) posting into the view
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'render' }, source: null }));
    // the host's way in: window.postMessage on the page itself — browsers set `source` to the page's window
    // (jsdom's postMessage leaves it null, so the event is built here; the real path is checked in Chrome)
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'highlight' }, source: window }));
    off();
    expect(got).toEqual([{ type: 'highlight' }]);
  });

  it('NFR-2 ignores page messages that are not host messages (no object, no string type)', () => {
    const got: unknown[] = [];
    const off = createWindowBridge<{ type: string }, never>().onMessage((m) => got.push(m));
    for (const data of [null, 'render', { type: 3 }, { kind: 'render' }]) window.dispatchEvent(new MessageEvent('message', { data, source: window }));
    off();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'late' }, source: window }));
    expect(got).toEqual([]);
  });

  it('FR-15.6 posts intents to the hook a JCEF host injected', () => {
    const hook = vi.fn();
    const intents: unknown[] = [];
    window.addEventListener('seqcall:intent', (e) => intents.push((e as CustomEvent).detail));
    window.__seqcallHostPost = hook;
    createWindowBridge<never, { type: string }>().post({ type: 'navigate' });
    expect(hook).toHaveBeenCalledWith({ type: 'navigate' });
    expect(intents).toEqual([]);
  });

  it('FR-21.1 without an injected hook, posts intents as an seqcall:intent event (browser mode, dev host)', () => {
    const intents: unknown[] = [];
    window.addEventListener('seqcall:intent', (e) => intents.push((e as CustomEvent).detail));
    createWindowBridge<never, { type: string }>().post({ type: 'ready' });
    expect(intents).toEqual([{ type: 'ready' }]);
  });

  it('FR-13.1 keeps the view state over a page reload in sessionStorage', () => {
    createWindowBridge('k').setState({ zoom: 0.8 });
    expect(JSON.parse(sessionStorage.getItem('k')!)).toEqual({ zoom: 0.8 });
    expect(createWindowBridge('k').getState()).toEqual({ zoom: 0.8 });
    expect(createWindowBridge('other').getState()).toBeUndefined();
  });

  it('FR-13.1 starts without state when the stored state is not JSON', () => {
    sessionStorage.setItem('seqcall-state', '{broken');
    expect(createWindowBridge().getState()).toBeUndefined();
  });

  it('FR-13.1 keeps the state in memory when sessionStorage refuses it (quota, blocked storage)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const b = createWindowBridge();
    b.setState({ zoom: 2 });
    expect(b.getState()).toEqual({ zoom: 2 });
  });
});

describe('VS Code bridge', () => {
  // the API object is cached per module (VS Code allows one acquireVsCodeApi call per webview): a fresh module per test
  async function load() {
    vi.resetModules();
    return import('../src/bridge');
  }

  it('NFR-2 inside VS Code posts through acquireVsCodeApi, once per webview', async () => {
    const { api, acquire } = fakeVsCode();
    const m = await load();
    m.createHostBridge<never, { type: string }>().post({ type: 'ready' });
    m.createHostBridge<never, { type: string }>().post({ type: 'navigate' });
    expect(api.posted).toEqual([{ type: 'ready' }, { type: 'navigate' }]);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('NFR-2 takes VS Code messages whatever their source (the extension host is not a window)', async () => {
    fakeVsCode();
    const m = await load();
    const got: unknown[] = [];
    m.createHostBridge<{ type: string }, never>().onMessage((x) => got.push(x));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'render' }, source: null }));
    expect(got).toEqual([{ type: 'render' }]);
  });

  it('FR-13.2 keeps the state in VS Code (restored when the panel comes back); no state is undefined', async () => {
    const { api } = fakeVsCode(null);
    const m = await load();
    const b = m.createHostBridge();
    expect(b.getState()).toBeUndefined();
    b.setState({ zoom: 1.5 });
    expect(api.state).toEqual({ zoom: 1.5 });
    expect(b.getState()).toEqual({ zoom: 1.5 });
  });

  it('NFR-2 outside VS Code createHostBridge falls back to the window bridge', () => {
    const intents: unknown[] = [];
    window.addEventListener('seqcall:intent', (e) => intents.push((e as CustomEvent).detail));
    createHostBridge<never, { type: string }>().post({ type: 'ready' });
    expect(intents).toContainEqual({ type: 'ready' });
  });
});
