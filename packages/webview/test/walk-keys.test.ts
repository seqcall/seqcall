// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

const P = 'root/1:placeOrder';
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;

const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const selected = () => [...view.body.querySelectorAll('.message.kb-selected')].map((e) => e.getAttribute('data-msg-id'));
/** The drawn messages top to bottom. */
const drawn = () => [...view.geometry!.messages].sort((a, b) => a.y - b.y);

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: cloneSequence() });
  let left = 0;
  let top = 0;
  Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(view.scroll, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => (left = v) });
  Object.defineProperty(view.scroll, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
  bridge.posted.length = 0;
});

describe('FR-9.9 walking the diagram with the keyboard', () => {
  it('FR-9.9 ↓ / ↑ go to the next / previous message as drawn; the first ↓ takes the first one on screen; the ends stay', () => {
    const ids = drawn().map((g) => g.id);
    key('ArrowUp', {}, document.body);
    expect(selected()).toEqual([ids[ids.length - 1]]); // nothing selected: ↑ takes the last one on screen
    key('Escape');
    expect(selected()).toEqual([]);
    key('ArrowDown');
    expect(selected()).toEqual([ids[0]]);
    key('ArrowDown');
    key('ArrowDown');
    expect(selected()).toEqual([ids[2]]);
    key('ArrowUp');
    expect(selected()).toEqual([ids[1]]);
    for (let i = 0; i < ids.length; i++) key('ArrowDown');
    expect(selected()).toEqual([ids[ids.length - 1]]);
  });

  it('FR-9.9 Shift+↓ / Shift+↑ skip the calls inside: the next message at the same depth or above', () => {
    const ms = drawn();
    const at = ms.findIndex((g) => g.id === P);
    const depth = ms[at].message.depth;
    const next = ms.slice(at + 1).find((g) => g.message.depth <= depth)!;
    // P has calls inside: plain ↓ goes into them, Shift+↓ past them
    expect(ms[at + 1].message.depth).toBeGreaterThan(depth);
    fire(view.body.querySelector(`[data-msg-id="${P}"] .msg-hit`)!, 'click');
    key('ArrowDown', { shiftKey: true });
    expect(selected()).toEqual([next.id]);
    key('ArrowUp', { shiftKey: true });
    expect(selected()).toEqual([P]);
  });

  it('FR-9.9 a click selects the call (its code opens, as before); Enter opens the selected call\'s code', () => {
    fire(view.body.querySelector(`[data-msg-id="${P}"] .msg-hit`)!, 'click');
    expect(selected()).toEqual([P]);
    expect(bridge.last()).toMatchObject({ type: 'navigate' });
    bridge.posted.length = 0;
    key('ArrowDown');
    const below = selected()[0]!;
    key('Enter');
    const m = view.diagram!.messages.find((x) => x.id === below)!;
    expect(bridge.last()).toEqual({ type: 'navigate', range: m.callSite });
  });

  it('FR-9.9 Space expands a collapsed call and collapses an open one; + only expands, − only collapses', () => {
    const d = view.diagram!;
    const closed = d.messages.find((m) => m.expandable && !m.expanded)!;
    const open = d.messages.find((m) => m.expanded)!;
    const pick = (id: string) => {
      while (selected()[0] !== id) key('ArrowDown');
    };
    pick(open.id);
    key('+');
    expect(bridge.posted).toEqual([]);
    key('-');
    expect(bridge.last()).toEqual({ type: 'collapse', messageId: open.id });
    bridge.posted.length = 0;
    key(' ');
    expect(bridge.last()).toEqual({ type: 'collapse', messageId: open.id });
    key('Escape');
    pick(closed.id);
    key('-');
    expect(bridge.posted).toEqual([{ type: 'collapse', messageId: open.id }]);
    key('+');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: closed.id });
    key(' ');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: closed.id });
    // a call that cannot open: Space does nothing
    const leaf = d.messages.find((m) => !m.expandable && !m.expanded)!;
    key('Escape');
    pick(leaf.id);
    bridge.posted.length = 0;
    key(' ');
    expect(bridge.posted).toEqual([]);
  });

  it('FR-9.9 → / ← start from the selected call, without the mouse over it', () => {
    fire(view.body.querySelector(`[data-msg-id="${P}"] .msg-hit`)!, 'click');
    key('ArrowRight');
    const to = view.diagram!.messages.find((m) => m.id === P)!.to;
    expect(view.header.querySelector('.jump-target')?.getAttribute('data-participant-id')).toBe(to);
    // walking on lets go of the jump: → follows the newly selected call
    key('ArrowDown');
    expect(view.body.querySelector('.jump-active')).toBeNull();
  });

  it('FR-9.9 the selection stays across renders while its call is drawn; Escape with Find open only closes Find', () => {
    key('ArrowDown');
    const first = selected()[0]!;
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(selected()).toEqual([first]);
    view.find.open('placeOrder');
    key('Escape');
    expect(view.find.bar.isOpen).toBe(false);
    expect(selected()).toEqual([first]);
    const d = cloneSequence();
    d.messages = d.messages.filter((m) => m.id !== first && m.parentId !== first);
    bridge.send({ type: 'render', diagram: d });
    expect(selected()).toEqual([]);
    key('Enter');
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
  });

  it('FR-9.9 not while typing, with Ctrl / Alt, or with a menu open; Enter and Space press a focused button instead', () => {
    const input = document.createElement('input');
    view.root.appendChild(input);
    key('ArrowDown', {}, input);
    key('ArrowDown', { ctrlKey: true });
    expect(selected()).toEqual([]);
    key('ArrowDown');
    const button = view.root.querySelector('button')!;
    key('Enter', {}, button);
    key(' ', {}, button);
    expect(bridge.posted).toEqual([]);
    // a key that means nothing here
    key('x');
    expect(bridge.posted).toEqual([]);
    fire(view.body.querySelector(`[data-msg-id="${P}"]`)!, 'contextmenu', { clientX: 10, clientY: 10 });
    const before = selected();
    key('ArrowDown');
    expect(selected()).toEqual(before);
  });
});
