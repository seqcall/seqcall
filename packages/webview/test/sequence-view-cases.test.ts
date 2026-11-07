// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS } from '../src/dom';
import type { CallerInfo, ExitMarker, HostToSequenceView, Message, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { exitCard, messageCard, routeRow, startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockCallers, range } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';
import { fitZoom, stepZoom } from '../src/zoom';

/** Sequence view cases: host messages in odd orders, keys, wheel, hover, menus and cards of unusual diagrams. */
const P = 'root/1:placeOrder';

/** Exceptions in event handlers (jsdom reports them on window, the test would not see them otherwise). */
let errors: unknown[] = [];
const onError = (e: ErrorEvent) => void errors.push(e.error ?? e.message);
beforeEach(() => {
  errors = [];
  window.addEventListener('error', onError);
});
afterEach(() => {
  window.removeEventListener('error', onError);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  expect(errors).toEqual([]);
});

function setup(d: SequenceDiagram | null = cloneSequence()) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  if (d) bridge.send({ type: 'render', diagram: d });
  bridge.posted.length = 0;
  const posted = () => bridge.posted.filter((m) => m.type !== 'log');
  const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id) as SVGElement;
  const part = (id: string) => view.header.querySelector(`[data-participant-id="${id}"]`) as SVGElement;
  const item = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  const menuIds = () => [...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'));
  const tb = (cmd: string) => view.root.querySelector(`[data-cmd="${cmd}"]`) as HTMLButtonElement;
  return { bridge, view, posted, msgEl, part, item, menuIds, tb };
}
const contextMenu = (el: Element) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  el.dispatchEvent(e);
  return e;
};
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const msg = (d: SequenceDiagram, id: string) => d.messages.find((m) => m.id === id)!;

describe('sequence view: measuring and placeholders', () => {
  it('FR-6.1 without an injected measure the view measures text on a canvas (as in a browser)', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/126');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '', measureText: (t: string) => ({ width: t.length * 20 }) }) as unknown as CanvasRenderingContext2D);
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge);
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const { view: estimated } = setup();
    const wide = view.geometry!.participants.map((p) => p.width);
    estimated.geometry!.participants.forEach((p, i) => expect(wide[i]).toBeGreaterThan(p.width));
  });

  it('FR-10.1 an empty message during a drag: the drop draws nothing and saves nothing', () => {
    const { bridge, view, part, posted } = setup();
    fire(part('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 200 });
    bridge.send({ type: 'empty', reason: '' });
    fire(document.body, 'mouseup');
    expect(view.body.querySelector('svg')).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('FR-10.1 a right button press or a press beside the boxes starts no drag; a small move is a click', () => {
    const { view, part, posted } = setup();
    const x = view.geometry!.participants.find((p) => p.id === 'p-svc')!.x;
    fire(part('p-svc').querySelector('rect')!, 'mousedown', { button: 2, clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 200 });
    fire(document.body, 'mouseup');
    fire(view.header.querySelector('svg')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 200 });
    fire(document.body, 'mouseup');
    fire(part('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 101 });
    fire(document.body, 'mouseup');
    expect(view.geometry!.participants.find((p) => p.id === 'p-svc')!.x).toBe(x);
    expect(posted()).toEqual([]);
  });

  it('FR-10.1 the click that ends a drag does not navigate', () => {
    const d = cloneSequence();
    d.options = { ...d.options, autoTidy: false };
    const { part, posted } = setup(d);
    fire(part('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 220 });
    fire(document.body, 'mouseup');
    fire(part('p-svc').querySelector('rect')!, 'click');
    expect(posted().map((m) => m.type)).toEqual(['savePositions']);
  });

  it('FR-6.1 scrolling an empty view does nothing', () => {
    const { view } = setup(null);
    view.scroll.dispatchEvent(new Event('scroll'));
    expect(view.body.querySelector('.guard-ghosts')).toBeNull();
  });
});

describe('sequence view: zoom (FR-14.5)', () => {
  it('FR-14.5 Fit makes the width fit the view; 100% resets; − zooms out', () => {
    const { view, tb } = setup();
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: view.geometry!.width / 2 });
    view.scroll.scrollLeft = 80;
    fire(tb('zoomFit'), 'click');
    expect(view.zoom).toBe(0.5);
    expect(view.scroll.scrollLeft).toBe(0);
    fire(tb('zoomReset'), 'click');
    expect(view.zoom).toBe(1);
    fire(tb('zoomOut'), 'click');
    expect(view.zoom).toBe(stepZoom(1, -1));
  });

  it('FR-14.5 Ctrl / Cmd + wheel zooms (and closes menus); a plain wheel scrolls; nothing without a diagram', () => {
    const { view, tb } = setup(null);
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(view.zoom).toBe(1);
    const { view: v2, tb: tb2 } = setup();
    void tb;
    fire(tb2('view'), 'click');
    v2.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(v2.zoom).toBe(1);
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    v2.scroll.dispatchEvent(e);
    expect(v2.zoom).toBeGreaterThan(1);
    expect(e.defaultPrevented).toBe(true);
    expect(v2.root.querySelector('.popup-layer .menu')).toBeNull();
    v2.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, metaKey: true, bubbles: true, cancelable: true }));
    expect(v2.zoom).toBeLessThan(1);
  });

  it('FR-14.5 a zoom set before the first diagram applies to it; 100% at 100% writes no state', () => {
    const { bridge, view, tb } = setup(null);
    view.setZoom(2);
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(Number(view.body.querySelector('svg')!.getAttribute('width'))).toBeCloseTo(view.geometry!.width * 2, 0);
    fire(tb('zoomReset'), 'click');
    const writes = vi.spyOn(bridge, 'setState');
    fire(tb('zoomReset'), 'click');
    expect(writes).not.toHaveBeenCalled();
  });

  it('FR-1.16 without animation frames (an old browser) the guard copies follow the scroll at once', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const d = cloneSequence();
    d.fragments = [{ id: `${P}#loop@1`, kind: 'loop', ownerMessageId: P, operands: [{ guard: 'each item', firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/6:notifyCustomer` }] }];
    const { view } = setup(d);
    const op = view.geometry!.fragments[0].operands[0];
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: 2000 });
    view.scroll.scrollLeft = op.guardX + op.guardWidth / 2 + 1;
    view.scroll.dispatchEvent(new Event('scroll'));
    const ghosts = view.body.querySelector('.guard-ghosts')!;
    expect(ghosts.textContent).toContain('← loop [each item]');
    // a click beside the copies (no target x) scrolls nowhere
    const left = view.scroll.scrollLeft;
    ghosts.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(view.scroll.scrollLeft).toBe(left);
  });
});

describe('sequence view: hover card, keys and jumps (FR-9.6, FR-9.7)', () => {
  const over = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 50, clientY: 50 }));

  it('FR-9.6 a message shows its card; an expand glyph keeps its own tooltip; an early exit explains itself', () => {
    vi.useFakeTimers();
    const d = cloneSequence();
    const exit: ExitMarker = { id: `${P}!exit0`, ownerMessageId: P, kind: 'throw', guard: '!order.isPaid', range: range('services/order-service.ts', 30, 6), beforeId: `${P}/5:info` };
    d.exits = [exit];
    const { view, msgEl } = setup(d);
    const card = () => (view.hoverCard.element.hidden ? null : view.hoverCard.element.querySelector('.hc-call')!.textContent);
    over(msgEl(`${P}/2:total`).querySelector('.msg-label')!);
    vi.advanceTimersByTime(400);
    expect(card()).toContain('total(');
    over(msgEl(P).querySelector('.expand-glyph')!);
    vi.advanceTimersByTime(400);
    expect(card()).toBeNull();
    over(view.body.querySelector(`[data-exit-id="${exit.id}"]`)!);
    vi.advanceTimersByTime(400);
    expect(card()).toBe('Throws when !order.isPaid');
  });

  it('FR-9.7 → over a lifeline (no message under the mouse) jumps nowhere; typing in a field is not a jump', () => {
    const { view, msgEl } = setup();
    fire(msgEl(P), 'mouseover');
    fire(view.body.querySelector('.lifeline')!, 'mouseover');
    view.scroll.scrollLeft = 0;
    expect(key('ArrowRight')).toBe(true);
    expect(view.scroll.scrollLeft).toBe(0);
    fire(msgEl(P), 'mouseover');
    const input = document.createElement('input');
    view.root.appendChild(input);
    expect(key('ArrowRight', {}, input)).toBe(true); // not prevented
    expect(view.header.querySelector('.jump-target')).toBeNull();
  });

  it('FR-9.7 a jump to an object that is not drawn does nothing; jumps without a message keep the keys on the mouse; 20 steps back at most', () => {
    const { view } = setup();
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 300 });
    view.jumpTo('p-gone');
    expect(view.header.querySelector('.jump-target')).toBeNull();
    for (let i = 0; i < 25; i++) {
      view.scroll.scrollLeft = i;
      view.jumpTo(i % 2 ? 'p-log' : 'p-ctrl');
    }
    expect(view.body.querySelector('.jump-active')).toBeNull();
    const back: number[] = [];
    while (view.jumpBackTo()) back.push(view.scroll.scrollLeft);
    expect(back).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  });
});

describe('sequence view: host messages in odd orders', () => {
  it('FR-23.3 a highlight of a call that is not drawn marks nothing and scrolls nowhere', () => {
    const { bridge, view } = setup();
    view.scroll.scrollTop = 7;
    bridge.send({ type: 'highlight', messageId: `${P}/9:gone` });
    expect(view.body.querySelector('.highlighted')).toBeNull();
    expect(view.scroll.scrollTop).toBe(7);
    expect(view.root.querySelector('.placeholder.error')).toBeNull();
  });

  it('FR-19.10 an issue the host reveals before any diagram: its card shows (nothing to outline)', () => {
    const { bridge, view } = setup(null);
    bridge.send({ type: 'highlight', messageId: null, finding: { id: 'f', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find' } });
    expect(view.root.querySelector('.popup-layer .guide-card .gc-title')!.textContent).toBe('⚠ I/O in a loop: Repo.find');
  });

  it('FR-4.1 callers of a call that is not drawn are ignored; callers nobody asked for open at the corner', () => {
    const { bridge, view } = setup();
    const callers: CallerInfo[] = [mockCallers[0]];
    bridge.send({ type: 'callers', messageId: `${P}/9:gone`, callers });
    expect(view.root.querySelector('.callers-panel')).toBeNull();
    bridge.send({ type: 'callers', messageId: P, callers });
    const panel = view.root.querySelector('.popup-layer .callers-panel') as HTMLElement;
    expect([panel.style.left, panel.style.top]).toEqual(['40px', '40px']);
    expect(view.root.querySelectorAll('.caller-item')).toHaveLength(1);
  });

  it('FR-4.4 / FR-22 callers nobody asked for: Include tests and Paths to here… open at the corner too', () => {
    const { bridge, view, posted } = setup();
    const callers: CallerInfo[] = [mockCallers[0], { ...mockCallers[1], id: 'c3', inTest: true }];
    bridge.send({ type: 'callers', messageId: P, callers });
    const box = view.root.querySelector('.callers-tests-toggle') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(posted()).toEqual([{ type: 'setOption', option: 'includeTestCallers', value: true }]);
    expect(view.root.querySelectorAll('.caller-item')).toHaveLength(2);
    (view.root.querySelector('.callers-paths') as HTMLElement).click();
    expect(posted().at(-1)).toEqual({ type: 'requestPaths', messageId: P });
    const panel = view.root.querySelector('.popup-layer .paths-panel') as HTMLElement;
    expect([panel.style.left, panel.style.top]).toEqual(['40px', '40px']);
  });

  it('FR-22 paths of another call, or while the panel is closed, are not shown; a later answer keeps the method count', () => {
    const { bridge, view, msgEl, item } = setup();
    contextMenu(msgEl(P).querySelector('.msg-label')!);
    item('paths-to-here')!.click();
    bridge.send({ type: 'paths', messageId: 'root', state: 'done', methods: 9 });
    expect(view.root.querySelector('.paths-panel')!.textContent).not.toContain('9');
    bridge.send({ type: 'paths', messageId: P, state: 'running', methods: 4 });
    expect(view.root.querySelector('.paths-panel')!.textContent).toContain('4');
    bridge.send({ type: 'paths', messageId: P, state: 'running' });
    expect(view.root.querySelector('.paths-panel')!.textContent).toContain('4');
    view.root.querySelector('.popup-layer')!.replaceChildren(); // the panel closed
    bridge.send({ type: 'paths', messageId: P, state: 'done', methods: 5 });
    expect(view.root.querySelector('.paths-panel')).toBeNull();
  });

  it('FR-24.13 / FR-19.9 / FR-16.2 answers for closed panels only update the state', () => {
    const { bridge, view, tb } = setup();
    bridge.send({ type: 'gitRefs', error: 'not a git repository' });
    bridge.send({ type: 'projectFindings', state: 'done', findings: [] });
    bridge.send({ type: 'entryPoints', entryPoints: [], project: 'shop' });
    expect(view.root.querySelector('.popup-layer')?.children.length ?? 0).toBe(0);
    expect(view.root.querySelector('.placeholder.error')).toBeNull();
    // the list shows what arrived meanwhile when it opens
    fire(tb('entryPoints'), 'click');
    expect(view.root.querySelector('.entry-points-panel')).not.toBeNull();
  });

});

describe('sequence view: messageCard / exitCard / routeRow', () => {
  const d = cloneSequence();
  const base = msg(d, `${P}/2:total`);
  const texts = (nodes: Node[]) => nodes.map((n) => (n as HTMLElement).textContent);

  it('FR-9.6 a call to an object the diagram does not list has no route row', () => {
    expect(routeRow({ ...base, to: 'p-gone' }, d, document)).toBeUndefined();
    expect((messageCard({ ...base, to: 'p-gone' }, document, d)[0] as HTMLElement).className).toBe('hc-call');
  });

  it('FR-9.6 notes: recursive, one of alternative creations (branches / returns)', () => {
    expect(texts(messageCard({ ...base, recursive: true }, document))).toContain('recursive call');
    expect(texts(messageCard({ ...base, alternative: { index: 1, count: 2, why: 'return' } }, document))).toContain('Alternative 1 of 2 — each of them is returned, which ends the method: only one of these objects exists in a run, drawn on one lifeline');
    expect(texts(messageCard({ ...base, alternative: { index: 2, count: 3, why: 'branch' } }, document))).toContain('Alternative 2 of 3 — they are in different branches: only one of these objects exists in a run, drawn on one lifeline');
  });

  it('FR-24.4 the called method added or changed on the branch', () => {
    expect(texts(messageCard({ ...base, diff: { method: 'added' } }, document))[1]).toBe('Method added on this branch');
    expect(texts(messageCard({ ...base, diff: { method: 'changed' } }, document))[1]).toBe('Method changed on this branch');
  });

  it('FR-24.7 a changed line that reaches another method: why, with one implementation or several', () => {
    const one = texts(messageCard({ ...base, diff: { call: true, before: 'Calc.sum' } }, document));
    expect(one.slice(1, 3)).toEqual(['Reaches another method than before: Calc.sum', 'This line was not edited: the called method changed (its signature or its class)']);
    const poly = msg(d, `${P}/4:charge`);
    const many = texts(messageCard({ ...poly, diff: { call: true, before: 'StripeGateway.charge' } }, document));
    expect(many).toContain('This line was not edited: PaymentGateway now has 2 implementations, so the call is no longer resolved to one');
    const el = messageCard({ ...base, diff: { call: true } }, document)[1] as HTMLElement;
    expect([el.className, el.textContent]).toEqual(['hc-diff-head changed', 'On a changed line']);
  });

  it('FR-16.3 the root names its entry points (one or several, with details)', () => {
    const root = msg(d, 'root');
    const one = { ...d, entryPoints: [{ kind: 'http' as const, label: 'POST /orders', method: d.root }] };
    expect(texts(messageCard(root, document, one))).toEqual(expect.arrayContaining(['Entry point', 'POST /orders']));
    const two = { ...d, entryPoints: [{ kind: 'http' as const, label: 'POST /orders', detail: 'api', method: d.root }, { kind: 'cli' as const, label: 'orders:place', method: d.root }] };
    expect(texts(messageCard(root, document, two))).toEqual(expect.arrayContaining(['Entry point (2)', 'POST /orders · api', 'orders:place']));
  });

  it('FR-28 a zoomed call lists the calls it folds, how many more, how many still collapsed', () => {
    const lines = texts(messageCard({ ...base, folded: { count: 5, names: ['Repo.find', 'Repo.save'], expandable: 2 } }, document));
    expect(lines).toEqual(expect.arrayContaining(['Folded inside the layer (5)', 'Repo.find', 'Repo.save', '+3 more', '2 of them still collapsed — ⊕ opens them']));
    expect(texts(messageCard({ ...base, folded: { count: 2, names: ['Repo.find', 'Repo.save'], expandable: 0 } }, document))).not.toContain('+0 more');
  });

  it('FR-1.15 a throw without an exception type, without a guard', () => {
    const e: ExitMarker = { id: 'x', ownerMessageId: P, kind: 'throw', range: range('services/order-service.ts', 30, 6) };
    expect(texts(exitCard(e, document))[0]).toBe('Throws here');
  });
});

describe('sequence view: messages without the usual parts', () => {
  it('FR-11.1 a call without a class: only the name rules, no class-method ones', () => {
    const d = cloneSequence();
    const m = msg(d, `${P}/2:total`);
    delete m.classKey;
    delete m.className;
    const { msgEl, menuIds } = setup(d);
    contextMenu(msgEl(m.id).querySelector('.msg-label')!);
    const ids = menuIds();
    expect(ids).toContain('hide-name');
    expect(ids).toContain('no-expand-name');
    expect(ids).not.toContain('hide-class-method');
    expect(ids).not.toContain('no-expand-class-method');
  });

  it('FR-22 Paths to here from the root of a module function: titled with the function name only', () => {
    const d = cloneSequence();
    d.root = { ...d.root, owner: { ...d.root.owner, kind: 'module', name: 'orders.ts' } };
    const { msgEl, item, view } = setup(d);
    contextMenu(msgEl('root').querySelector('.msg-label')!);
    item('paths-to-here')!.click();
    expect(view.root.querySelector('.paths-panel')!.textContent).toContain('placeOrder');
    expect(view.root.querySelector('.paths-panel')!.textContent).not.toContain('orders.ts.placeOrder');
  });

  it('a call with nothing to open shows Expand greyed out, with why', () => {
    const why = (extra: Partial<SequenceDiagram['messages'][number]>) => {
      const d = cloneSequence();
      Object.assign(msg(d, `${P}/2:total`), { expandable: false, expanded: false, recursive: false, ...extra });
      const { msgEl, item } = setup(d);
      contextMenu(msgEl(`${P}/2:total`).querySelector('.msg-label')!);
      const row = item('expand')!;
      return [row.classList.contains('disabled'), row.querySelector('.menu-hint')!.textContent, row.title];
    };
    expect(why({})).toEqual([true, 'no body to open', 'Nothing to open: no body to open']);
    expect(why({ unresolved: 'typed any' })[1]).toBe('target not found');
    expect(why({ classKey: 'lib:node#Map' })[1]).toBe('library call');
    expect(why({ recursive: true })[1]).toBe('calls itself again');
  });

  it('FR-3.1 Collapse / Expand / Go to call site from the message menu', () => {
    const { msgEl, item, posted } = setup();
    contextMenu(msgEl(P).querySelector('.msg-label')!);
    item('collapse')!.click();
    contextMenu(msgEl(`${P}/2:total`).querySelector('.msg-label')!);
    item('expand')!.click();
    contextMenu(msgEl(`${P}/2:total`).querySelector('.msg-label')!);
    item('goto')!.click();
    expect(posted()).toEqual([{ type: 'collapse', messageId: P }, { type: 'expand', messageId: `${P}/2:total` }, { type: 'navigate', range: range('services/order-service.ts', 23, 18) }]);
  });
});

describe('sequence view: clicks and their anchors', () => {
  /** jsdom has no layout: an element of the given selector is at `pos()` on screen, everything else at 0. */
  function placed(match: (el: Element) => boolean, pos: () => { x: number; y: number }) {
    const proto = SVGElement.prototype as unknown as { getBoundingClientRect(): DOMRect };
    vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return match(this) ? new DOMRect(pos().x, pos().y, 10, 10) : new DOMRect(0, 0, 0, 0);
    });
  }

  it('FR-10.5 a minimized frame’s ⊞ stays under the mouse when the diagram comes back', () => {
    const d = cloneSequence();
    d.fragments = [{ id: `${P}#loop@1`, kind: 'loop', ownerMessageId: P, operands: [{ guard: 'each item', firstMessageId: `${P}/2:total`, lastMessageId: `${P}/2:total` }] }];
    const { bridge, view, posted } = setup(d);
    let moved = 0;
    placed((el) => el.classList.contains('frag-toggle'), () => ({ x: 300 + moved - view.scroll.scrollLeft, y: 200 - view.scroll.scrollTop }));
    fire(view.body.querySelector('[data-fragment-id] .frag-toggle')!, 'click');
    expect(posted()).toEqual([{ type: 'collapseFragment', fragmentId: `${P}#loop@1` }]);
    moved = 120;
    bridge.send({ type: 'render', diagram: d });
    expect(view.scroll.scrollLeft).toBe(120);
  });

  it('FR-10.5 the call whose ⊕ was clicked lost its glyph (no body any more): its label stays in place; gone: nothing moves', () => {
    const { bridge, view, msgEl } = setup();
    let moved = 0;
    const id = `${P}/2:total`;
    placed((el) => el.closest('[data-msg-id]')?.getAttribute('data-msg-id') === id && (el.classList.contains('expand-glyph') || el.classList.contains('msg-label')), () => ({ x: 300 + moved - view.scroll.scrollLeft, y: 200 }));
    fire(msgEl(id).querySelector('.expand-glyph')!, 'click');
    moved = 60;
    const bare = cloneSequence();
    Object.assign(msg(bare, id), { expandable: false });
    bridge.send({ type: 'render', diagram: bare });
    expect(view.scroll.scrollLeft).toBe(60);
    fire(msgEl(`${P}/0:findById`).querySelector('.expand-glyph')!, 'click');
    const without = cloneSequence();
    without.messages = without.messages.filter((m) => m.id !== `${P}/0:findById`);
    bridge.send({ type: 'render', diagram: without });
    expect(view.scroll.scrollLeft).toBe(60);
  });

  it('FR-1.17 a catch row without its own location goes to the try', () => {
    const d = cloneSequence();
    const tryRange = range('services/order-service.ts', 22, 4, 3);
    d.fragments = [{ id: `${P}#try@1`, kind: 'try', ownerMessageId: P, range: tryRange, operands: [{ firstMessageId: `${P}/2:total`, lastMessageId: `${P}/2:total` }], catches: [{ guard: 'catch', outcome: 'logged, swallowed', swallowed: true }] }];
    const { view, posted } = setup(d);
    fire(view.body.querySelector('[data-fragment-part="guard"][data-operand="1"]')!, 'click');
    expect(posted()).toEqual([{ type: 'navigate', range: tryRange }]);
  });

  it('FR-24.9 ▲n below a collapsed call without a review tour asks the host to reveal the change', () => {
    const d = cloneSequence();
    msg(d, `${P}/2:total`).diff = { inside: 2 };
    const { msgEl, posted } = setup(d);
    fire(msgEl(`${P}/2:total`).querySelector('.diff-inside')!, 'click');
    expect(posted()).toEqual([{ type: 'revealChange', messageId: `${P}/2:total` }]);
  });

  it('FR-14.4 no canvas menu on an exit marker, a frame or before any diagram', () => {
    const d = cloneSequence();
    d.exits = [{ id: `${P}!exit0`, ownerMessageId: P, kind: 'return', range: range('services/order-service.ts', 21, 6), beforeId: `${P}/2:total` }];
    d.fragments = [{ id: `${P}#opt@1`, kind: 'opt', ownerMessageId: P, operands: [{ guard: 'x', firstMessageId: `${P}/5:info`, lastMessageId: `${P}/5:info` }] }];
    const { view } = setup(d);
    for (const el of [view.body.querySelector('[data-exit-id]')!, view.body.querySelector('.fragment rect, .fragment path')!]) {
      expect(contextMenu(el).defaultPrevented).toBe(false);
      expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
    }
    const { view: empty } = setup(null);
    expect(contextMenu(empty.scroll).defaultPrevented).toBe(false);
    expect(empty.root.querySelector('.popup-layer .menu')).toBeNull();
  });
});

describe('sequence view: implementations (FR-8)', () => {
  const charge = `${P}/4:charge`;
  function withPoly(poly: Partial<NonNullable<Message['polymorphic']>>) {
    const d = cloneSequence();
    Object.assign(msg(d, charge).polymorphic!, poly);
    return setup(d);
  }
  const openBadge = (s: ReturnType<typeof setup>) => fire(s.msgEl(charge).querySelector('.poly-badge')!, 'click');
  const rows = (s: ReturnType<typeof setup>) => [...s.view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.textContent);

  it('FR-8.6 keyed registrations: each implementation shows its key (or condition) and where; none is chosen', () => {
    const at = range('Program.cs', 40);
    const s = withPoly({ keyed: [{ classKey: 'src/infrastructure/stripe-gateway.ts#StripeGateway', key: '"card"', kind: 'key', at }, { classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway', key: 'IsWallet', kind: 'condition', at }] });
    openBadge(s);
    expect(rows(s).slice(0, 2)).toEqual(['StripeGatewaykeyed "card" · Program.cs:41', 'PaypalGatewaywhen IsWallet · Program.cs:41']);
  });

  it('FR-8.6 a binding for this class only says so; Back to interface reverts a choice', () => {
    const at = range('Startup.cs', 12);
    const s = withPoly({ bound: { classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway', at, contextual: true }, selectedKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway' });
    openBadge(s);
    expect(s.item('open-binding')!.textContent).toBe('Open the binding (Startup.cs:13)for this class');
    s.item('back-to-interface')!.click();
    expect(s.posted()).toEqual([{ type: 'revertImplementation', messageId: charge }]);
  });

  it('FR-8.2 an interface without implementations says so', () => {
    const s = withPoly({ implementations: [] });
    openBadge(s);
    expect(rows(s)[0]).toBe('No implementations found');
  });
});

describe('sequence view: participant menus', () => {
  it('FR-28.7 a layer with one object: “Show its object here”; Find its messages opens the find bar', () => {
    const d = cloneSequence();
    d.options.layerZoom = true;
    d.participants = [{ id: 'layer:Presentation', classKey: 'layer:Presentation', className: 'Presentation', label: 'Presentation', kind: 'module', stereotypes: [], layer: 'Presentation', namespace: '', groupId: 'g-pres', objects: [{ id: 'p-ctrl', label: ':OrderController', classKey: 'src/controllers/order-controller.ts#OrderController', className: 'OrderController' }] }];
    d.messages = [{ ...msg(d, 'root'), to: 'layer:Presentation' }];
    const { view, part, item, posted } = setup(d);
    contextMenu(part('layer:Presentation').querySelector('rect')!);
    expect(item('open-layer')!.textContent).toBe('Show its object here⊕');
    item('open-layer')!.click();
    expect(posted()).toEqual([{ type: 'setLayerOpen', layer: 'layer:Presentation', open: true }]);
    contextMenu(part('layer:Presentation').querySelector('rect')!);
    item('find-messages')!.click();
    expect((view.root.querySelector('.find-bar') as HTMLElement).hidden).toBe(false);
  });

  it('FR-2.3 / FR-8.3 / FR-11.7 an object’s menu: Go to declaration, Back to interface, Let Expand all open its calls again', () => {
    const d = cloneSequence();
    msg(d, `${P}/4:charge`).polymorphic!.selectedKey = 'src/infrastructure/stripe-gateway.ts#StripeGateway';
    const gw = d.participants.find((p) => p.id === 'p-gw')!;
    d.hiddenFilters = [...d.hiddenFilters, { filter: { id: `noExpand:class:${gw.classKey}`, kind: 'class', classKey: gw.classKey, className: gw.className, noExpand: true }, hiddenCount: 0 }];
    const { part, item, posted } = setup(d);
    contextMenu(part('p-gw').querySelector('rect')!);
    item('goto')!.click();
    contextMenu(part('p-gw').querySelector('rect')!);
    item('back-to-interface')!.click();
    contextMenu(part('p-gw').querySelector('rect')!);
    expect(item('allow-expand-class')!.textContent).toBe('Let Expand all open calls to PaymentGateway again');
    item('allow-expand-class')!.click();
    expect(posted()).toEqual([
      { type: 'navigate', range: gw.declaration },
      { type: 'revertImplementation', messageId: `${P}/4:charge` },
      { type: 'unhide', filterId: `noExpand:class:${gw.classKey}` },
    ]);
  });
});

describe('sequence view: issues, their evidence and cards (FR-19)', () => {
  const pick = (s: ReturnType<typeof setup>, id: string) => {
    fire(s.tb('findings'), 'click');
    s.item(`finding:${id}`)!.click();
  };
  const card = (s: ReturnType<typeof setup>) => s.view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
  const btn = (s: ReturnType<typeof setup>, label: string) => [...card(s).querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === label)!;
  const kept = (s: ReturnType<typeof setup>) => [...s.view.root.querySelectorAll('.evidence-keep')].map((e) => e.getAttribute('data-msg-id') ?? e.getAttribute('data-activation-for') ?? e.getAttribute('data-participant-id') ?? e.getAttribute('data-lifeline') ?? e.getAttribute('data-fragment-id'));

  it('FR-19.20 the loop around an issue’s call stays undimmed with it; calls of the issue that are not drawn are left out', () => {
    const d = cloneSequence();
    d.fragments = [{ id: `${P}#loop@1`, kind: 'loop', ownerMessageId: P, operands: [{ guard: 'each item', firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` }] }];
    d.findings = [{ id: 'n1', kind: 'io-in-loop', title: 'I/O in a loop: CustomerRepository.findById', messageIds: [`${P}/0:findById`, `${P}/9:gone`], classKeys: [d.participants[6].classKey] }];
    const s = setup(d);
    pick(s, 'n1');
    expect(s.view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(kept(s)).toContain(`${P}#loop@1`);
    expect(s.part('p-repo1').classList.contains('finding-hl')).toBe(true);
    expect(s.part('p-repo2').classList.contains('finding-hl')).toBe(false);
  });

  it('FR-28.4 zoomed: an issue call whose caller is folded into a layer still dims the rest', () => {
    const d = cloneSequence();
    // the call path names a call the zoom folded away (not drawn): its own message is drawn under placeOrder
    const deep = { ...msg(d, `${P}/2:total`), id: `${P}/7:audit/0:write`, parentId: P, methodName: 'write' };
    d.messages.push(deep);
    d.findings = [{ id: 'n1', kind: 'io-in-loop', title: 'I/O in a loop', messageIds: [deep.id] }];
    const s = setup(d);
    pick(s, 'n1');
    expect(kept(s)).toEqual(expect.arrayContaining(['root', P, deep.id, 'p-svc', 'p-price']));
  });

  it('FR-19.20 a second issue revealed while the first card is open keeps the diagram dimmed for the second', () => {
    const d = cloneSequence();
    d.findings = [
      { id: 'a', kind: 'io-in-loop', title: 'I/O in a loop: A', messageIds: [`${P}/0:findById`] },
      { id: 'b', kind: 'io-in-loop', title: 'I/O in a loop: B', messageIds: [`${P}/1:findById`] },
    ];
    const s = setup(d);
    pick(s, 'a');
    // the host reveals the second while the first card is open (e.g. from the class diagram)
    s.bridge.send({ type: 'highlight', messageId: null, finding: d.findings[1] });
    expect(s.view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(kept(s)).toContain(`${P}/1:findById`);
    expect(kept(s)).not.toContain(`${P}/0:findById`);
    btn(s, 'Close').click();
    expect(s.view.root.classList.contains('evidence-dimmed')).toBe(false);
  });

  it('FR-19.17 a layer violation through an interface without an object: its side named from the title, its layer from the evidence', () => {
    const d = cloneSequence();
    const svc = d.participants.find((p) => p.id === 'p-svc')!;
    svc.layerHint = { suggested: 'Domain', reasons: ['pure'], noMove: true };
    d.findings = [{ id: 'v', kind: 'layer-violation', title: 'Layer violation: OrderService → InvoicePort', detail: 'Application must not depend on Infrastructure', classKeys: [svc.classKey, 'src/billing/invoice-port.ts#InvoicePort'], messageIds: [`${P}/4:charge`], evidence: ['InvoicePort: Infrastructure'] }];
    const s = setup(d);
    pick(s, 'v');
    expect(card(s).querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: OrderService (Application) → InvoicePort (Infrastructure)');
    expect([...card(s).querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Show in diagram', 'Adjust the rule', 'Copy as Markdown', 'Ask AI', 'Close']);
    s.view.root.querySelector(`[data-msg-id="${P}/4:charge"]`)!.classList.remove('highlighted');
    btn(s, 'Show in diagram').click();
    expect(s.msgEl(`${P}/4:charge`).classList.contains('highlighted')).toBe(true);
    btn(s, 'Close').click();
    expect(card(s)).toBeNull();
  });

  it('FR-19.17 a violation without class keys: both sides from the title; a side whose name is missing is “?”', () => {
    const d = cloneSequence();
    d.findings = [{ id: 'v', kind: 'layer-violation', title: 'Layer violation: Shop', messageIds: [`${P}/4:charge`] }];
    const s = setup(d);
    pick(s, 'v');
    expect(card(s).querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: Shop → ?');
    expect(card(s).querySelector('.gc-detail')).toBeNull();
  });

  it('FR-12.16 Move on a violation card asks where the misplaced class goes', () => {
    const d = cloneSequence();
    const svc = d.participants.find((p) => p.id === 'p-svc')!;
    svc.layerHint = { suggested: 'Domain', reasons: ['pure'] };
    d.findings = [{ id: 'v', kind: 'layer-violation', title: 'Layer violation: OrderService → PaymentGateway', classKeys: [svc.classKey, d.participants[5].classKey], messageIds: [`${P}/4:charge`] }];
    const s = setup(d);
    pick(s, 'v');
    btn(s, 'Move OrderService to Domain').click();
    expect(s.posted().at(-1)).toEqual({ type: 'requestLayerScopes', classKey: svc.classKey, className: 'OrderService' });
  });
});

describe('sequence view: notices and shared states', () => {
  it('FR-3.3 a depth limit with one call left: in the singular; Collapse all from the notice', () => {
    const d = cloneSequence();
    d.expandNotice = { reason: 'depth', limit: 6, folded: 1, messages: 40, depth: 6 };
    const { view, posted } = setup(d);
    expect(view.root.querySelector('.expand-notice .notice-text')!.textContent).toBe('ⓘ Reached the depth limit (6 levels) — 1 call still folded (⊕).');
    [...view.root.querySelectorAll<HTMLElement>('.expand-notice button')].find((b) => b.textContent === 'Collapse all')!.click();
    expect(posted()).toEqual([{ type: 'collapseAll' }]);
  });

  it('FR-3.10 Smart expand stopped by its cap: the important calls still folded; Continue asks for more, ✕ closes', () => {
    const d = cloneSequence();
    d.expandNotice = { reason: 'smart', limit: 100, folded: 3, messages: 98, depth: 5 };
    const { view, posted } = setup(d);
    const notice = view.root.querySelector('.expand-notice:not(.borrowed-config)') as HTMLElement;
    expect(notice.querySelector('.notice-text')!.textContent).toBe('ⓘ Overview stopped at 98 messages (limit 100) — 3 important calls still folded (⊕).');
    const buttons = [...notice.querySelectorAll<HTMLElement>('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Continue', 'Collapse all', '✕']);
    buttons[0].click();
    buttons[1].click();
    expect(posted()).toEqual([{ type: 'smartExpand', more: true }, { type: 'collapseAll' }]);
    buttons[2].click();
    expect(notice.hidden).toBe(true);
    // one call: in the singular
    const one = cloneSequence();
    one.expandNotice = { reason: 'smart', limit: 100, folded: 1, messages: 99, depth: 5 };
    expect(setup(one).view.root.querySelector('.expand-notice .notice-text')!.textContent).toBe('ⓘ Overview stopped at 99 messages (limit 100) — 1 important call still folded (⊕).');
  });

  it('FR-25.2 ✕ closes the shared-state notice; a report before any diagram is ignored; no report and no error: “Unknown error”', () => {
    const report = { source: 'OrderController.placeOrder · shop', differences: [], missing: [], seen: { messages: 3, participants: 2 }, now: { messages: 3, participants: 2 }, settingsReplaced: false };
    const empty = setup(null);
    empty.bridge.send({ type: 'stateReport', report });
    expect(empty.view.root.querySelector('[data-state-notice]')).toBeNull();
    expect(empty.view.root.querySelector('.placeholder.error')).toBeNull();
    const { bridge, view } = setup();
    bridge.send({ type: 'stateReport', report });
    const notice = view.root.querySelector('.expand-notice:not(.borrowed-config)') as HTMLElement;
    expect(notice.hidden).toBe(false);
    (notice.querySelector('.notice-close') as HTMLElement).click();
    expect(notice.hidden).toBe(true);
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.root.querySelector('[data-state-notice]')).toBeNull();
    bridge.send({ type: 'stateReport' });
    expect(view.root.querySelector('.state-card .lr-note')!.textContent).toBe('Unknown error');
  });
});

describe('sequence view: menus’ remaining actions', () => {
  it('FR-14.2 / FR-14.4 the marks in View ▾ and the canvas menu’s commands post their intents', () => {
    const { view, item, posted, tb } = setup();
    fire(tb('view'), 'click');
    item('view:showReviewMarks')!.click();
    for (const id of ['show:expand-all', 'expand-one-level', 'collapse-all']) {
      contextMenu(view.body.querySelector('svg')!);
      item(id)!.click();
    }
    expect(posted()).toEqual([
      { type: 'setOption', option: 'showReviewMarks', value: false }, // on by default
      { type: 'expandAll' },
      { type: 'expandAll', oneLevel: true },
      { type: 'collapseAll' },
    ]);
    contextMenu(view.body.querySelector('svg')!);
    item('canvas:tidy')!.click();
    expect(posted().at(-1)).toMatchObject({ type: 'savePositions' });
  });

  it('FR-14.1 the toolbar is inert before a diagram (except ⌂); → Forward posts its intent', () => {
    const empty = setup(null);
    for (const cmd of ['back', 'expandMenu', 'smartExpand', 'classDiagram']) empty.tb(cmd).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(empty.posted()).toEqual([]);
    const d = cloneSequence();
    d.canGoForward = true;
    const { tb, posted } = setup(d);
    fire(tb('forward'), 'click');
    expect(posted()).toEqual([{ type: 'forward' }]);
  });

  it('FR-22.3 a path whose start is no entry point opens without one', () => {
    const { bridge, view, msgEl, item, posted } = setup();
    contextMenu(msgEl(P).querySelector('.msg-label')!);
    item('paths-to-here')!.click();
    const method = (name: string) => ({ key: `src/shop/${name}.ts#Shop.${name}`, name, owner: { key: `src/shop/${name}.ts#Shop`, name: 'Shop', kind: 'class' as const }, isStatic: false, hasBody: true });
    bridge.send({ type: 'paths', messageId: P, state: 'done', methods: 2, tree: { method: method('place'), callers: [{ method: method('checkout'), call: { range: range('shop.ts', 4), preview: 'this.place()' }, end: 'top' }] } });
    bridge.posted.length = 0;
    fire([...view.root.querySelectorAll('.paths-item')].find((r) => r.textContent!.includes('checkout'))!, 'click');
    expect(posted()).toStrictEqual([{ type: 'openPath', steps: [{ methodKey: 'src/shop/checkout.ts#Shop.checkout', call: { range: range('shop.ts', 4) } }, { methodKey: 'src/shop/place.ts#Shop.place' }] }]);
  });
});

describe('sequence view: Share ▾ image (FR-25)', () => {
  function fakeCanvas() {
    vi.stubGlobal('Image', class { src = ''; decode = async () => undefined; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: () => undefined }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'])));
  }
  const share = (s: ReturnType<typeof setup>, id: string) => {
    fire(s.tb('image'), 'click');
    s.item(id)!.click();
  };

  it('the visible area only: the scrolled window at scale 1, header over the same columns', async () => {
    fakeCanvas();
    const srcs: string[] = [];
    vi.stubGlobal('Image', class { set src(v: string) { srcs.push(v); } decode = async () => undefined; });
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    const s = setup();
    Object.assign(s.view, { zoom: 2 });
    for (const [k, v] of Object.entries({ scrollLeft: 100, scrollTop: 60, clientWidth: 400, clientHeight: 500 })) Object.defineProperty(s.view.scroll, k, { configurable: true, value: v });
    share(s, 'image:png-visible');
    await vi.waitFor(() => expect(s.posted().map((m) => m.type)).toEqual(['saveImage']));
    const doc = new DOMParser().parseFromString(decodeURIComponent(srcs[0].slice(srcs[0].indexOf(',') + 1)), 'image/svg+xml');
    const header = (s.view.header.querySelector('svg') as SVGSVGElement).viewBox.baseVal.height;
    const parts = [...doc.documentElement.children].filter((c) => c.tagName === 'svg').map((c) => [c.getAttribute('viewBox'), c.getAttribute('width'), c.getAttribute('y')]);
    // 400 × 500 px at zoom 2 = 200 × 250 of the diagram, scrolled to 50, 30
    expect(parts).toEqual([
      [`50 0 200 ${Math.round(header)}`, '200', '0'],
      [`50 30 200 ${Math.round(250 - header)}`, '200', String(Math.round(header))],
    ]);
    fire(s.tb('image'), 'click');
    expect(s.item('image:copy-visible')!.textContent).toContain('Copy the visible area (PNG)');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    s.item('image:copy-visible')!.click();
    await vi.waitFor(() => expect(s.tb('image').dataset.flash).toBe('Copy not allowed here — use Save as PNG'));
    expect(srcs).toHaveLength(2);
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  });

  it('FR-25 PNG: VS Code saves through the host (base64), a browser downloads it', async () => {
    fakeCanvas();
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    const s = setup();
    share(s, 'image:png');
    await vi.waitFor(() => expect(s.posted()).toEqual([{ type: 'saveImage', format: 'png', name: 'OrderController.placeOrder.png', data: btoa('png') }]));
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const files: string[] = [];
    URL.createObjectURL = () => 'blob:1';
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push(this.download);
    });
    share(s, 'image:png');
    share(s, 'image:svg');
    await vi.waitFor(() => expect(files.sort()).toEqual(['OrderController.placeOrder.png', 'OrderController.placeOrder.svg']));
  });

  it('FR-25.1 Copy as image: “Copied ✓” for 2.5 s; refused: says so and logs it', async () => {
    fakeCanvas();
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, unknown>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => undefined } });
    const s = setup();
    const btn = s.tb('image');
    const before = btn.title;
    vi.useFakeTimers();
    share(s, 'image:copy');
    for (let i = 0; i < 50 && btn.title === before; i++) await vi.advanceTimersByTimeAsync(0);
    expect(btn.title).toBe('Copied ✓');
    vi.advanceTimersByTime(FLASH_MS);
    expect([btn.title, btn.dataset.flash]).toEqual([before, undefined]);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    share(s, 'image:copy');
    for (let i = 0; i < 50 && btn.title === before; i++) await vi.advanceTimersByTimeAsync(0);
    expect(btn.title).toBe('Copy not allowed here — use Save as PNG');
    expect(s.bridge.posted).toContainEqual({ type: 'log', level: 'info', message: 'copy image: the clipboard refused the image' });
  });
});

describe('sequence view: more odd orders', () => {
  it('FR-3.8 new calls left of the view (scrolled right past them): the view scrolls back to the first', () => {
    const d = cloneSequence();
    const folded = cloneSequence();
    folded.messages = folded.messages.filter((m) => !m.id.startsWith(`${P}/`)).map((m) => (m.id === P ? { ...m, expanded: false } : m));
    const { bridge, view, msgEl } = setup(folded);
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: 3000 });
    view.scroll.scrollLeft = 5000;
    fire(msgEl(P).querySelector('.expand-glyph')!, 'click');
    bridge.send({ type: 'render', diagram: d });
    expect(view.scroll.scrollLeft).toBeLessThan(5000);
  });

  it('FR-10.5 a minimized frame that is gone after the render: nothing moves', () => {
    const d = cloneSequence();
    d.fragments = [{ id: `${P}#loop@1`, kind: 'loop', ownerMessageId: P, operands: [{ guard: 'each item', firstMessageId: `${P}/2:total`, lastMessageId: `${P}/2:total` }] }];
    const { bridge, view } = setup(d);
    view.scroll.scrollLeft = 30;
    fire(view.body.querySelector('[data-fragment-id] .frag-toggle')!, 'click');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.scroll.scrollLeft).toBe(30);
  });

  it('FR-4.4 Include tests in callers nobody asked for: the panel comes back at the corner with the next render; not when the call is gone', () => {
    const { bridge, view } = setup();
    const callers = [mockCallers[0], { ...mockCallers[1], id: 'c3', inTest: true }];
    const toggle = () => {
      bridge.send({ type: 'callers', messageId: P, callers });
      const box = view.root.querySelector('.callers-tests-toggle') as HTMLInputElement;
      box.checked = !box.checked;
      box.dispatchEvent(new Event('change'));
    };
    toggle();
    const on = cloneSequence();
    on.options.includeTestCallers = true;
    bridge.send({ type: 'render', diagram: on });
    const panel = view.root.querySelector('.popup-layer .callers-panel') as HTMLElement;
    expect([panel.style.left, panel.style.top]).toEqual(['40px', '40px']);
    toggle();
    const gone = cloneSequence();
    gone.messages = gone.messages.filter((m) => !m.id.startsWith(P));
    bridge.send({ type: 'render', diagram: gone });
    expect(view.root.querySelector('.callers-panel')).toBeNull();
    expect(view.root.querySelector('.placeholder.error')).toBeNull();
    expect(view.body.querySelector('svg')).not.toBeNull();
  });

  it('FR-19.17 a layer violation without message ids marks no call red', () => {
    const d = cloneSequence();
    d.findings = [{ id: 'v', kind: 'layer-violation', title: 'Layer violation: OrderService → Order', classKeys: [d.participants[1].classKey] }];
    const { view } = setup(d);
    expect(view.body.querySelector('.message.violation')).toBeNull();
  });

  it('FR-10.4 a diagram without calls scrolls (no labels to slide)', () => {
    const d = cloneSequence();
    d.messages = [];
    const { view } = setup(d);
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 200 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: 300 });
    vi.stubGlobal('requestAnimationFrame', undefined);
    view.scroll.dispatchEvent(new Event('scroll'));
    view.scroll.dispatchEvent(new Event('scroll'));
    expect(view.body.querySelector('.msg-label')).toBeNull();
  });

  it('FR-10.1 without animation frames a drag redraws at once', () => {
    const d = cloneSequence();
    d.options = { ...d.options, autoTidy: false };
    const { view, part } = setup(d);
    vi.stubGlobal('requestAnimationFrame', undefined);
    const before = view.geometry!.participants.find((p) => p.id === 'p-svc')!.x;
    fire(part('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 180 });
    expect(view.geometry!.participants.find((p) => p.id === 'p-svc')!.x).toBe(Math.round(before + 80));
    fire(document.body, 'mouseup');
  });

  it('FR-10.2 Tidy up before any diagram does nothing', () => {
    const { view, posted } = setup(null);
    view.tidyUp();
    expect(posted()).toEqual([]);
  });

  it('FR-7.8 Move to layer… on the card of a diagram without layer choices offers nothing', () => {
    const d = cloneSequence();
    const p = d.participants.find((x) => x.id === 'p-svc')!;
    p.layerReason = { rule: 'role-folder', text: 'role folder `services/`', strength: 'strong', notApplied: [] };
    delete d.layerChoices;
    const { view, part, item } = setup(d);
    contextMenu(part('p-svc').querySelector('rect')!);
    item('why-layer')!.click();
    (view.root.querySelector('.layer-reason-card [data-cmd="lr-move"]') as HTMLElement).click();
    expect(view.root.querySelector('.popup-layer .menu-item')).toBeNull();
  });

  it('FR-19.10 with the find bar open an issue’s card sits below it', () => {
    const d = cloneSequence();
    d.findings = [{ id: 'g', kind: 'io-in-loop', title: 'I/O in a loop', messageIds: [`${P}/0:findById`] }];
    const { view, tb, item } = setup(d);
    view.find.open();
    (view.root.querySelector('.find-bar') as HTMLElement).getBoundingClientRect = () => ({ bottom: 200 }) as DOMRect; // lower than the header
    fire(tb('findings'), 'click');
    item('finding:g')!.click();
    expect((view.root.querySelector('.popup-layer .guide-card') as HTMLElement).style.top).toBe('206px');
  });
});

describe('sequence view: the last odd cases', () => {
  it('FR-9.7 a click in a card beside its chips jumps nowhere', () => {
    vi.useFakeTimers();
    const { view, msgEl } = setup();
    msgEl(P).querySelector('.msg-label')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 50, clientY: 50 }));
    vi.advanceTimersByTime(400);
    fire(view.hoverCard.element.querySelector('.hc-call')!, 'click');
    expect(view.header.querySelector('.jump-target')).toBeNull();
  });

  it('FR-3.8 a panel no taller than the header: nothing to judge, the view does not move sideways', () => {
    const folded = cloneSequence();
    folded.messages = folded.messages.filter((m) => !m.id.startsWith(`${P}/`)).map((m) => (m.id === P ? { ...m, expanded: false } : m));
    const { bridge, view, msgEl } = setup(folded);
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 100 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: view.geometry!.headerHeight });
    view.scroll.scrollLeft = 5000;
    fire(msgEl(P).querySelector('.expand-glyph')!, 'click');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.scroll.scrollLeft).toBe(5000);
  });

  it('Fold layers on or off fits the width again; other renders keep the zoom', () => {
    const { bridge, view } = setup();
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 300 });
    view.setZoom(0.25);
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.zoom).toBe(0.25);
    const folded = cloneSequence();
    folded.options = { ...folded.options, layerZoom: true };
    bridge.send({ type: 'render', diagram: folded });
    expect(view.zoom).toBe(fitZoom(view.geometry!.width, 0, 300, 0));
  });

  it('FR-14.5 Fit before any diagram keeps the zoom', () => {
    const { view } = setup(null);
    view.fit();
    expect(view.zoom).toBe(1);
  });

  it('FR-8.6 a binding for every class says so', () => {
    const d = cloneSequence();
    msg(d, `${P}/4:charge`).polymorphic!.bound = { classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway', at: range('Startup.cs', 12), contextual: false };
    const s = setup(d);
    fire(s.msgEl(`${P}/4:charge`).querySelector('.poly-badge')!, 'click');
    expect(s.item('open-binding')!.textContent).toBe('Open the binding (Startup.cs:13)for every class');
  });

  it('FR-22 Copy as Markdown in the paths panel copies the paths', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    const { bridge, view, msgEl, item } = setup();
    contextMenu(msgEl(P).querySelector('.msg-label')!);
    item('paths-to-here')!.click();
    const method = (name: string) => ({ key: `src/shop/${name}.ts#Shop.${name}`, name, owner: { key: `src/shop/${name}.ts#Shop`, name: 'Shop', kind: 'class' as const }, isStatic: false, hasBody: true });
    bridge.send({ type: 'paths', messageId: P, state: 'done', methods: 2, tree: { method: method('place'), callers: [{ method: method('checkout'), call: { range: range('shop.ts', 4), preview: 'this.place()' }, end: 'top' }] } });
    const copy = view.root.querySelector('.paths-panel .paths-copy') as HTMLElement;
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied ✓'));
    expect(written[0]).toContain('checkout');
  });
});
