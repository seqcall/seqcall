// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

const P = 'root/1:placeOrder';
const FIND = `${P}/0:findById`;
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgHit = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!.querySelector('.msg-hit')!;
const lifeline = (id: string) => view.geometry!.participants.find((p) => p.id === id)!.x;
const key = (k: string, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: cloneSequence() });
  // jsdom has no layout: a 200 px wide viewport whose scroll position is kept
  let left = 0;
  let top = 0;
  Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(view.scroll, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => (left = v) });
  Object.defineProperty(view.scroll, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
});

describe('jump to the sender / receiver of a message (FR-9.7)', () => {
  it('FR-9.7 a click on a chip in the hover card scrolls the lifeline to the middle and marks its head', async () => {
    fire(msgHit(P), 'mouseover', { clientX: 30, clientY: 40 });
    await wait(400);
    const card = view.hoverCard.element;
    expect(card.classList.contains('interactive')).toBe(true);
    expect(card.querySelector('.hc-keys')!.textContent).toContain('→ receiver');
    const receiver = [...card.querySelectorAll<HTMLElement>('.hc-chip[data-jump]')].find((c) => c.dataset.participantId === 'p-svc')!;
    fire(receiver, 'click');
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline('p-svc') - 100));
    expect(view.header.querySelector('.jump-target')?.getAttribute('data-participant-id')).toBe('p-svc');
    expect(card.hidden).toBe(true);
  });

  it('FR-9.7 over a message, → goes to its receiver and ← to its sender; Backspace goes back step by step', () => {
    view.scroll.scrollLeft = 7;
    fire(msgHit(FIND), 'mouseover', { clientX: 30, clientY: 40 });
    expect(key('ArrowRight')).toBe(false); // handled (default prevented)
    const toReceiver = view.scroll.scrollLeft;
    expect(toReceiver).toBe(Math.max(0, lifeline(view.diagram!.messages.find((m) => m.id === FIND)!.to) - 100));
    key('ArrowLeft');
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline('p-svc') - 100));
    key('Backspace');
    expect(view.scroll.scrollLeft).toBe(toReceiver);
    key('Backspace');
    expect(view.scroll.scrollLeft).toBe(7);
    expect(key('Backspace')).toBe(true); // nothing left to go back to: the key is not taken
  });

  it('FR-9.7 after a jump the keys stay with that message (marked) until the mouse really moves', () => {
    const mouse = (x: number, y: number) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
    mouse(30, 40);
    fire(msgHit(FIND), 'mouseover', { clientX: 30, clientY: 40 });
    key('ArrowRight');
    const marked = () => [...view.body.querySelectorAll('.jump-active')].map((e) => e.getAttribute('data-msg-id'));
    expect(marked()).toEqual([FIND]);
    // the scroll put another message under the pointer (the browser reports it, the mouse did not move)
    fire(msgHit('root/0:validate'), 'mouseover', { clientX: 30, clientY: 40 });
    mouse(31, 41);
    key('ArrowLeft');
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline('p-svc') - 100)); // FIND's sender, not validate's
    // a real move lets go: the message under the mouse counts again
    mouse(80, 90);
    expect(marked()).toEqual([]);
    fire(msgHit('root/0:validate'), 'mouseover', { clientX: 80, clientY: 90 });
    key('ArrowLeft');
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline('p-ctrl') - 100));
  });

  it('FR-9.7 FR-24.9 the review tour\'s card (on the label): its ends are marked, ← / → follow its message, also after a chip click', async () => {
    const d = cloneSequence();
    d.messages.find((m) => m.id === FIND)!.diff = { call: true, status: 'added' };
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'review', state: 'done', result: { base: 'main', resolvedBase: 'main', branch: 'x', files: [{ file: 'src/X.ts', path: '/p/src/X.ts', status: 'modified', added: 1, removed: 0 }], methods: [{ method: { key: 'src/X.ts#X.m', name: 'm', owner: { key: 'src/X.ts#X', name: 'X', kind: 'class' }, isStatic: false, hasBody: true }, status: 'added', lines: [1], reachedFrom: [], tests: 0 }], issues: [], scanned: 0, notScanned: 0, otherLines: 0, computedAt: '2026-10-20T00:00:00.000Z' } });
    key('n');
    await wait(200);
    const card = view.hoverCard.element;
    expect(card.hidden).toBe(false);
    expect(view.hoverCard.anchor!.classList.contains('msg-label')).toBe(true);
    const find = view.diagram!.messages.find((m) => m.id === FIND)!;
    const marked = [...view.header.querySelectorAll('.hover-end')].map((e) => e.getAttribute('data-participant-id')).sort();
    expect(marked).toEqual([find.from, find.to].sort());
    expect(key('ArrowRight')).toBe(false);
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline(find.to) - 100));
    view.scroll.scrollLeft = 0;
    // shown again (a scroll hides it): a chip click, then ← goes to the sender of that message
    key('p');
    key('n');
    await wait(200);
    const receiver = [...card.querySelectorAll<HTMLElement>('.hc-chip[data-jump]')].find((c) => c.dataset.participantId === find.to)!;
    fire(receiver, 'click');
    expect([...view.body.querySelectorAll('.jump-active')].map((e) => e.getAttribute('data-msg-id'))).toEqual([FIND]);
    expect(key('ArrowLeft')).toBe(false);
    expect(view.scroll.scrollLeft).toBe(Math.max(0, lifeline(find.from!) - 100));
  });

  it('FR-9.7 the arrow keys do nothing without a message under the mouse, or while typing', () => {
    expect(key('ArrowRight')).toBe(true);
    fire(msgHit(FIND), 'mouseover', { clientX: 30, clientY: 40 });
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(key('ArrowRight', input)).toBe(true);
    expect(view.scroll.scrollLeft).toBe(0);
  });

  it('FR-9.7 the card stays while the mouse moves onto it, and goes when the mouse leaves it', async () => {
    fire(msgHit(P), 'mouseover', { clientX: 30, clientY: 40 });
    await wait(400);
    const card = view.hoverCard.element;
    view.body.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: card }));
    await wait(350);
    expect(card.hidden).toBe(false);
    card.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    expect(card.hidden).toBe(true);
  });
});
