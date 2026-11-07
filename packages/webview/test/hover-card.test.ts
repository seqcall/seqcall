// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverCard } from '../src/hover-card';
import { mount } from './helpers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A container with two anchors (`a`, `b`) and a plain area; the card shows the anchor's id. */
function setup(interactive: boolean, root: HTMLElement = mount()) {
  const card = new HoverCard(root, 350);
  const container = root.ownerDocument.createElement('div');
  container.innerHTML = '<span id="a">A</span><span id="b">B</span><i id="plain">-</i>';
  root.appendChild(container);
  const log: string[] = [];
  // like the views: the anchor is found with Element API (closest)
  const content = (t: Element) => {
    const anchor = t.closest('span');
    return anchor ? { anchor, body: [root.ownerDocument.createTextNode(`card ${anchor.id}`)] } : null;
  };
  card.attach(container, content, {
    interactive,
    shown: (a) => log.push(`shown ${a.id}`),
    hidden: () => log.push('hidden'),
  });
  const el = (id: string) => container.querySelector(`#${id}`)!;
  const over = (target: Node, x = 100, y = 100) => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
  const leaveTo = (from: Element, to: Element | null) => from.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: to }));
  const shown = () => (card.element.hidden ? null : card.element.textContent);
  return { card, container, el, over, leaveTo, shown, log };
}

describe('hover card (FR-9.6)', () => {
  it('FR-9.6 shows after the delay next to the mouse, and goes at once when the mouse leaves (plain card)', () => {
    const s = setup(false);
    s.over(s.el('a'));
    vi.advanceTimersByTime(349);
    expect(s.shown()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.shown()).toBe('card a');
    expect([s.card.element.style.left, s.card.element.style.top]).toEqual(['112px', '118px']);
    expect(s.card.element.classList.contains('interactive')).toBe(false);
    s.over(s.el('plain'));
    expect(s.shown()).toBeNull();
    expect(s.log).toEqual(['shown a', 'hidden']);
  });

  it('FR-9.6 near the bottom of the window, the card opens above the mouse', () => {
    const s = setup(false);
    s.over(s.el('a'), 100, window.innerHeight - 5);
    vi.advanceTimersByTime(350);
    expect(s.card.element.style.top).toBe(`${window.innerHeight - 15}px`);
  });

  it('FR-9.6 a page without a window (detached document) places the card at the mouse', () => {
    const doc = document.implementation.createHTMLDocument();
    const s = setup(false, doc.body);
    s.over(s.el('a'), 30, 40);
    vi.advanceTimersByTime(350);
    expect([s.card.element.style.left, s.card.element.style.top]).toEqual(['42px', '58px']);
  });

  it('FR-9.6 moving within the same anchor keeps the card; an event from a text node counts as "no card here"', () => {
    const s = setup(false);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.over(s.el('a'));
    expect(s.shown()).toBe('card a'); // not hidden and shown again
    s.over(s.el('plain').firstChild!);
    expect(s.shown()).toBeNull();
  });

  it('FR-9.7 an interactive card stays while the mouse crosses the diagram onto it, and while over it', () => {
    const s = setup(true);
    expect(s.card.element.classList.contains('interactive')).toBe(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.leaveTo(s.container, s.card.element); // straight onto the card
    s.over(s.el('plain')); // or across the plain diagram…
    s.card.element.dispatchEvent(new MouseEvent('mouseenter')); // …reaching the card in time
    vi.advanceTimersByTime(1000);
    expect(s.shown()).toBe('card a');
    s.leaveTo(s.card.element, s.el('plain')); // back into the diagram: not at once…
    expect(s.shown()).toBe('card a');
    s.over(s.el('plain')); // …it waits again
    vi.advanceTimersByTime(299);
    expect(s.shown()).toBe('card a');
    vi.advanceTimersByTime(1);
    expect(s.shown()).toBeNull();
  });

  it('FR-9.7 leaving the card for outside the diagram hides it at once; back to the anchor cancels the wait', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.leaveTo(s.card.element, document.body);
    expect(s.shown()).toBeNull();
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.over(s.el('plain'));
    s.over(s.el('a')); // back on the same anchor before the card went
    vi.advanceTimersByTime(1000);
    expect(s.shown()).toBe('card a');
  });

  it('FR-9.7 another anchor\'s card replaces an interactive card only after the delay (the mouse may be passing)', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.over(s.el('b'));
    vi.advanceTimersByTime(200);
    expect(s.shown()).toBe('card a');
    s.over(s.el('a')); // passing back: the pending b card is not cancelled by a's own anchor
    s.over(s.el('b'), 120, 130); // b again restarts the delay
    vi.advanceTimersByTime(349);
    expect(s.shown()).toBe('card a');
    vi.advanceTimersByTime(1);
    expect(s.shown()).toBe('card b');
    expect(s.card.element.style.left).toBe('132px');
    expect(s.log).toEqual(['shown a', 'hidden', 'shown b']);
  });

  it('FR-9.7 from an interactive card\'s anchor across the plain diagram to another anchor: its card after the delay', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.over(s.el('plain')); // leaving a: the card waits 300 ms
    s.over(s.el('b'));
    vi.advanceTimersByTime(349);
    expect(s.shown()).toBe('card a');
    vi.advanceTimersByTime(1);
    expect(s.shown()).toBe('card b');
  });

  it('FR-9.7 leaving the diagram straight onto the card does not start the wait', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.leaveTo(s.container, s.card.element);
    vi.advanceTimersByTime(1000);
    expect(s.shown()).toBe('card a');
  });

  it('FR-9.7 a card pending for another anchor is dropped when the mouse leaves it for the plain diagram', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.over(s.el('b'));
    vi.advanceTimersByTime(100);
    s.over(s.el('plain'));
    vi.advanceTimersByTime(1000);
    expect(s.shown()).toBeNull();
    expect(s.log).toEqual(['shown a', 'hidden']);
  });

  it('FR-9.6 a press in the diagram hides the card', () => {
    const s = setup(true);
    s.over(s.el('a'));
    vi.advanceTimersByTime(350);
    s.el('a').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(s.shown()).toBeNull();
  });
});
