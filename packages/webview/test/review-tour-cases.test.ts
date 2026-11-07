// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryPoint, HostToSequenceView, MethodRef, ReviewResult, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

/** The review tour (FR-24.9, FR-24.10, FR-24.15) in the less common orders: P first, the bar's buttons, stale answers. */
const P = 'root/1:placeOrder';
const ref = (cls: string, name: string): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true });
const ep = (label: string, cls: string): EntryPoint => ({ kind: 'http', verb: 'POST', label, method: ref(cls, 'handle') });
const A = ep('POST /orders', 'OrdersController');
const B = ep('POST /invoices', 'InvoicesController');
const method = (cls: string, name: string, from: EntryPoint) => ({ method: ref(cls, name), status: 'changed' as const, lines: [3], reachedFrom: [{ entryPoint: from, steps: [{ methodKey: from.method.key }, { methodKey: ref(cls, name).key }] }], tests: 0 });
const result: ReviewResult = {
  base: 'develop',
  resolvedBase: 'develop',
  files: [{ file: 'src/Order.ts', path: '/p/src/Order.ts', status: 'modified', added: 3, removed: 1 }],
  methods: [method('Order', 'total', A), method('Invoice', 'send', B)],
  issues: [],
  scanned: 2,
  notScanned: 0,
  otherLines: 0,
  computedAt: '2026-10-07T10:00:00.000Z',
};

let errors: unknown[] = [];
const onError = (e: ErrorEvent) => void errors.push(e.error ?? e.message);
beforeEach(() => {
  errors = [];
  window.addEventListener('error', onError);
});
afterEach(() => {
  window.removeEventListener('error', onError);
  vi.useRealTimers();
  expect(errors).toEqual([]);
});

function setup(d: SequenceDiagram, saved?: object) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  if (saved) bridge.setState(saved);
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: d });
  bridge.send({ type: 'review', state: 'done', result });
  bridge.posted.length = 0;
  const posted = () => bridge.posted.filter((m) => m.type !== 'log');
  const key = (k: string, target: EventTarget = document) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const lit = () => view.body.querySelector('.message.highlighted')?.getAttribute('data-msg-id');
  const count = () => view.root.querySelector('.review-bar .rb-change .rb-count')!.textContent;
  const barBtn = (text: string) => [...view.root.querySelectorAll<HTMLButtonElement>('.review-bar .rb-btn')].find((b) => b.textContent === text)!;
  const ticks = () => [...view.root.querySelectorAll<HTMLElement>('.change-ruler .ruler-tick')];
  return { bridge, view, posted, key, lit, count, barBtn, ticks };
}

/** Three own changes: an added call, a changed call, a method changed below a call. */
function plain(): SequenceDiagram {
  const d = cloneSequence();
  d.messages.find((m) => m.id === `${P}/0:findById`)!.diff = { status: 'added', call: true };
  d.messages.find((m) => m.id === `${P}/2:total`)!.diff = { call: true };
  d.messages.find((m) => m.id === `${P}/5:info`)!.diff = { method: 'changed' };
  return d;
}

/** Numbered: 1 on findById, 2 held below total (collapsed), 3 on info. */
function numberedDiagram(): SequenceDiagram {
  const d = cloneSequence();
  d.messages.find((m) => m.id === `${P}/0:findById`)!.diff = { status: 'added', call: true, count: 1, positions: [{ n: 1 }] };
  d.messages.find((m) => m.id === `${P}/2:total`)!.diff = { inside: 1, count: 1, held: [2] };
  d.messages.find((m) => m.id === `${P}/5:info`)!.diff = { method: 'changed', count: 1, positions: [{ n: 3 }] };
  d.reviewTotal = 3;
  return d;
}

describe('review: the panel and a restored view', () => {
  it('FR-24.13 the base and mode of the last review come back with the view; Cancel stops a running review', () => {
    const { view, posted } = setup(cloneSequence(), { reviewBase: 'main', reviewMode: 'direct' });
    view.showReview();
    expect(posted()).toEqual([{ type: 'requestGitRefs' }, { type: 'requestReview', base: 'main', mode: 'direct' }]);
    [...view.root.querySelectorAll<HTMLElement>('.review-panel button')].find((b) => b.textContent === 'Cancel')!.click();
    expect(posted().at(-1)).toEqual({ type: 'cancelReview' });
  });

  it('FR-24.4 Copy as Markdown in the panel copies the summary', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } });
    const { view } = setup(cloneSequence());
    view.showReview(false);
    const copy = view.root.querySelector('.review-panel .paths-copy') as HTMLElement;
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied ✓'));
    expect(written[0]).toContain('develop');
  });

  it('FR-24.9 a result without a branch name: “this branch”', () => {
    const { view } = setup(plain());
    expect(view.root.querySelector('.review-bar .rb-title')!.textContent).toBe('⎇ this branch vs develop');
  });
});

describe('review tour: the bar’s buttons and P first (FR-24.9)', () => {
  it('FR-24.9 the stop\'s card goes after a while without the mouse; read (hovered), it stays', () => {
    vi.useFakeTimers();
    const { view, barBtn } = setup(plain());
    const card = () => view.root.ownerDocument.querySelector('.hover-card') as HTMLElement;
    barBtn('▶').click();
    vi.advanceTimersByTime(200);
    expect(card().hidden).toBe(false);
    vi.advanceTimersByTime(8000);
    expect(card().hidden).toBe(true);
    // hovered: kept
    barBtn('▶').click();
    vi.advanceTimersByTime(200);
    const matches = card().matches.bind(card());
    card().matches = (sel: string) => sel === ':hover' || matches(sel);
    vi.advanceTimersByTime(8000);
    expect(card().hidden).toBe(false);
    // another card shown meanwhile: not hidden by the old timer
    card().matches = matches;
    barBtn('▶').click();
    vi.advanceTimersByTime(200);
    const anchor = view.hoverCard.anchor;
    barBtn('◀').click();
    vi.advanceTimersByTime(7900);
    expect(view.hoverCard.anchor).not.toBe(anchor);
    expect(card().hidden).toBe(false);
  });

  it('FR-24.9 ▶ and ◀ on the bar step like N and P; ⏭ opens the next flow', () => {
    const { posted, lit, barBtn } = setup(plain());
    barBtn('▶').click();
    expect(lit()).toBe(`${P}/0:findById`);
    barBtn('▶').click();
    expect(lit()).toBe(`${P}/2:total`);
    barBtn('◀').click();
    expect(lit()).toBe(`${P}/0:findById`);
    barBtn('⏭').click();
    expect(posted().at(-1)).toMatchObject({ type: 'openChangeFlow' });
  });

  it('FR-24.9 P before any N: the last own change; a current change that is gone: P starts from the end', () => {
    const { bridge, key, lit } = setup(plain());
    key('p');
    expect(lit()).toBe(`${P}/5:info`);
    // the host redraws without the current one
    const d = plain();
    d.messages = d.messages.filter((m) => m.id !== `${P}/5:info`);
    bridge.send({ type: 'render', diagram: d });
    key('p');
    expect(lit()).toBe(`${P}/2:total`);
  });

  it('FR-24.15 a ruler tick on a call whose changes are in the other implementation selects that call', () => {
    const d = plain();
    const charge = d.messages.find((m) => m.id === `${P}/4:charge`)!;
    charge.diff = { count: 1, elsewhere: [{ classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway', className: 'PaypalGateway', count: 1 }] };
    const { ticks, lit } = setup(d);
    ticks()[2].click();
    expect(lit()).toBe(charge.id);
  });

  it('FR-24.9 N / P are not taken while typing, and other keys are left alone', () => {
    const { view, key, lit } = setup(plain());
    const input = document.createElement('input');
    view.root.appendChild(input);
    expect(key('n', input)).toBe(true);
    expect(lit()).toBeUndefined();
    expect(key('x')).toBe(true); // not prevented
    expect(key('n')).toBe(false);
  });

  it('FR-24.10 the host highlights a call that is not drawn after a tour step opened a flow: nothing is selected', () => {
    const { bridge, key, lit } = setup(plain());
    key('N');
    bridge.send({ type: 'highlight', messageId: `${P}/9:gone` });
    expect(lit()).toBeUndefined();
  });

  it('FR-24.9 a layer opened for folded changes whose call is gone (or has nothing after it): the bar just shows the diagram', () => {
    const d = cloneSequence();
    const crossing = d.messages.find((m) => m.id === `${P}/6:notifyCustomer`)!;
    crossing.diff = { folded: 2 };
    const { bridge, posted, key, lit, count } = setup(d);
    key('n');
    expect(posted().at(-1)).toEqual({ type: 'setLayerOpen', layer: crossing.to, open: true });
    // the opened diagram has no stop after the call
    const opened = cloneSequence();
    opened.messages.find((m) => m.id === `${P}/0:findById`)!.diff = { status: 'added', call: true };
    bridge.send({ type: 'render', diagram: opened });
    expect(lit()).toBeUndefined();
    expect(count()).toBe('Change –/1');
    // another time the call itself is gone
    key('p');
    const again = cloneSequence();
    again.messages.find((m) => m.id === `${P}/6:notifyCustomer`)!.diff = { folded: 2 };
    bridge.send({ type: 'render', diagram: again });
    key('n');
    const without = cloneSequence();
    without.messages = without.messages.filter((m) => !m.id.startsWith(`${P}/6:notifyCustomer`));
    without.messages.find((m) => m.id === `${P}/0:findById`)!.diff = { status: 'added', call: true };
    bridge.send({ type: 'render', diagram: without });
    expect(count()).toBe('Change –/1');
  });
});

describe('review tour by number (FR-24.15)', () => {
  it('FR-24.15 P before any N goes to the last change; past the last, ▶ says so once, then opens the next flow', () => {
    const { posted, key, lit, count } = setup(numberedDiagram());
    key('p');
    expect(lit()).toBe(`${P}/5:info`);
    expect(count()).toBe('Change 3/3');
    key('n');
    expect(document.querySelector('.review-bar .rb-change')!.textContent).toContain('last change here');
    key('n');
    expect(posted().at(-1)).toMatchObject({ type: 'openChangeFlow' });
  });

  it('FR-24.15 ▲n below a collapsed call goes to the first change it holds; a call holding none asks the host to reveal', () => {
    const d = numberedDiagram();
    const { posted, view } = setup(d);
    fire(view.body.querySelector(`[data-msg-id="${P}/2:total"] .diff-inside`)!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'showChange', n: 2 });
    const bare = numberedDiagram();
    bare.messages.find((m) => m.id === `${P}/3:constructor`)!.diff = { inside: 1 };
    bare.messages.find((m) => m.id === `${P}/3:constructor`)!.expanded = false;
    bare.messages = bare.messages.filter((m) => m.parentId !== `${P}/3:constructor`);
    const s = setup(bare);
    fire(s.view.body.querySelector(`[data-msg-id="${P}/3:constructor"] .diff-inside`)!, 'click');
    expect(s.posted().at(-1)).toEqual({ type: 'revealChange', messageId: `${P}/3:constructor` });
  });

  it('FR-24.15 the host answers a change it was asked for with a call that is not drawn: nothing is selected, the number stays', () => {
    const { bridge, posted, key, lit, count } = setup(numberedDiagram());
    key('n');
    key('n'); // 2 is held below total: asked from the host
    expect(posted().at(-1)).toEqual({ type: 'showChange', n: 2 });
    bridge.send({ type: 'highlight', messageId: `${P}/9:gone` });
    expect(lit()).toBeUndefined();
    expect(count()).toBe('Change 2/3');
  });

  it('FR-24.15 a ruler tick on a stop without a number (a call opened by hand) selects that call', () => {
    const d = numberedDiagram();
    const extra = d.messages.find((m) => m.id === `${P}/4:charge`)!;
    extra.diff = { call: true };
    const { ticks, lit } = setup(d);
    ticks()[2].click();
    expect(lit()).toBe(extra.id);
  });
});

describe('review tour: stops without an own change', () => {
  it('FR-24.15 a ruler tick on a call holding change 2 asks the host for it; one holding no number reveals what is below', () => {
    const d = numberedDiagram();
    const ctor = d.messages.find((m) => m.id === `${P}/3:constructor`)!;
    ctor.expanded = false;
    ctor.diff = { inside: 1 };
    d.messages = d.messages.filter((m) => m.parentId !== ctor.id);
    const { ticks, posted } = setup(d);
    ticks()[1].click(); // total: holds 2
    expect(posted().at(-1)).toEqual({ type: 'showChange', n: 2 });
    ticks()[2].click(); // the constructor: changes below, no number
    expect(posted().at(-1)).toEqual({ type: 'revealChange', messageId: ctor.id });
  });

  it('FR-24.9 N again on a folded stop before the layer opened asks again; P passes calls that only hold changes', () => {
    const d = plain();
    const notify = d.messages.find((m) => m.id === `${P}/6:notifyCustomer`)!;
    notify.diff = { folded: 1 };
    const total = d.messages.find((m) => m.id === `${P}/2:total`)!;
    total.diff = { inside: 1 };
    const { posted, key, lit, ticks } = setup(d);
    ticks()[3].click(); // the folded call
    expect(posted().at(-1)).toEqual({ type: 'setLayerOpen', layer: notify.to, open: true });
    key('n');
    expect(posted().filter((m) => m.type === 'setLayerOpen')).toHaveLength(2);
    ticks()[2].click(); // info (own)
    key('p'); // total only holds changes: on to findById
    expect(lit()).toBe(`${P}/0:findById`);
  });
});

describe('review tour: the ruler', () => {
  it('FR-24.9 a tick names its call, Class.method or the bare name of a function', () => {
    const d = plain();
    delete d.messages.find((m) => m.id === `${P}/5:info`)!.className;
    const { ticks } = setup(d);
    expect(ticks().map((t) => t.title)).toEqual(['CustomerRepository.findById', 'PriceCalculator.total', 'info']);
  });
});
