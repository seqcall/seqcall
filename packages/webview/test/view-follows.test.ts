// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { revealElements } from '../src/dom';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// the view follows what the reader just did.

afterEach(() => vi.useRealTimers());

function opened(d: SequenceDiagram = cloneSequence(), viewW = 1200, viewH = 600) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: d });
  Object.defineProperty(view.scroll, 'clientWidth', { value: viewW });
  Object.defineProperty(view.scroll, 'clientHeight', { value: viewH });
  view.scroll.getBoundingClientRect = () => new DOMRect(0, 0, viewW, viewH);
  return { bridge, view };
}
const msgEl = (view: ReturnType<typeof opened>['view'], id: string) => [...view.body.querySelectorAll('.message[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id) as HTMLElement | undefined;

describe('FR-8.8 after Choose implementation the switched call is shown', () => {
  it('scrolled to when off screen, marked a moment; on screen: only marked', () => {
    vi.useFakeTimers();
    const d = cloneSequence();
    const poly = d.messages.find((m) => m.polymorphic)!;
    const { bridge, view } = opened(d, 300, 200);
    view.scroll.scrollTop = 5000; // far below it
    view.scroll.scrollLeft = 5000;
    (view as unknown as { post(m: SequenceViewToHost): void }).post({ type: 'selectImplementation', messageId: poly.id, classKey: poly.polymorphic!.implementations[0].key });
    bridge.send({ type: 'render', diagram: d });
    expect(view.scroll.scrollTop).toBeLessThan(5000);
    expect(msgEl(view, poly.id)!.classList.contains('just-swapped')).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(msgEl(view, poly.id)!.classList.contains('just-swapped')).toBe(false);
    // the next render (no switch) marks nothing; a switched call gone from the diagram: nothing to show
    bridge.send({ type: 'render', diagram: d });
    expect(view.body.querySelector('.just-swapped')).toBeNull();
    (view as unknown as { post(m: SequenceViewToHost): void }).post({ type: 'revertImplementation', messageId: 'gone' });
    bridge.send({ type: 'render', diagram: d });
    expect(view.body.querySelector('.just-swapped')).toBeNull();
  });
});

describe('FR-19.7 a finding is shown beside its card, at a readable zoom', () => {
  const finding = (d: SequenceDiagram) => {
    const [a, b] = [d.messages[2].id, d.messages[4].id];
    d.findings = [{ id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [a, b] }];
    return [a, b];
  };
  const pick = (view: ReturnType<typeof opened>['view'], [a, b]: string[], width: number) => {
    msgEl(view, a)!.getBoundingClientRect = () => new DOMRect(100, 100, 100, 20);
    msgEl(view, b)!.getBoundingClientRect = () => new DOMRect(100 + width - 100, 140, 100, 20);
    fire(view.toolbar.button('findings'), 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
  };

  it('fitted left of the open card: 1000 px of calls in a 1200 px view go to (1200 - 460 - 64) / 1000', () => {
    const d = cloneSequence();
    const ids = finding(d);
    const { view } = opened(d);
    pick(view, ids, 1000);
    expect(view.zoom).toBe(0.68); // 0.676 rounded
  });

  it('never below 60 %: then the first calls are shown', () => {
    const d = cloneSequence();
    const ids = finding(d);
    const { view } = opened(d);
    pick(view, ids, 5000);
    expect(view.zoom).toBe(0.6);
  });

  it('a folded card, or a view too narrow for card and calls: the whole width is used', () => {
    const d = cloneSequence();
    const ids = finding(d);
    const { view } = opened(d);
    pick(view, ids, 1000);
    // fold the card: the next finding uses the whole width
    fire(view.root.querySelector('.popup-layer .gc-fold')!, 'click');
    view.setZoom(1);
    pick(view, ids, 1000);
    expect(view.zoom).toBe(1);
    const narrow = opened(d, 700);
    pick(narrow.view, ids, 1000);
    expect(narrow.view.zoom).toBe(0.64); // (700 - 64) / 1000
  });
});

describe('revealElements: room taken at the right', () => {
  it('centres the union in what is left of the view', () => {
    const c = document.createElement('div');
    Object.defineProperty(c, 'clientWidth', { value: 1000 });
    Object.defineProperty(c, 'clientHeight', { value: 600 });
    c.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600);
    const el = document.createElement('div');
    el.getBoundingClientRect = () => new DOMRect(2000 - c.scrollLeft, 100, 200, 50);
    revealElements(c, [el], { right: 400 });
    expect(c.scrollLeft).toBe(2000 - (600 - 200) / 2);
  });
});

describe('FR-19.10 a finding\'s marks go with its card', () => {
  it('Close removes the highlight and the outlines; another finding\'s card keeps the new marks', () => {
    const d = cloneSequence();
    const m = d.messages.find((x) => x.from && x.from !== x.to)!;
    const to = d.participants.find((p) => p.id === m.to)!;
    const other = d.messages[4].id;
    d.findings = [
      { id: 'f1', kind: 'io-in-loop', title: 'one', messageIds: [m.id], classKeys: [to.classKey] },
      { id: 'f2', kind: 'io-in-loop', title: 'two', messageIds: [other] },
    ];
    const { view } = opened(d);
    const pick = (id: string) => {
      fire(view.toolbar.button('findings'), 'click');
      fire(view.root.querySelector(`.popup-layer [data-menu-id="finding:${id}"]`)!, 'click');
    };
    const lit = () => [...view.body.querySelectorAll('.message.highlighted')].map((e) => e.getAttribute('data-msg-id'));
    pick('f1');
    expect(lit()).toEqual([m.id]);
    expect(view.header.querySelector('.finding-hl')).not.toBeNull();
    pick('f2');
    expect(lit()).toEqual([other]);
    fire([...view.root.querySelectorAll<HTMLElement>('.popup-layer .gc-btn')].find((b) => b.textContent === 'Close')!, 'click');
    expect(lit()).toEqual([]);
    expect(view.header.querySelector('.finding-hl')).toBeNull();
  });
});
