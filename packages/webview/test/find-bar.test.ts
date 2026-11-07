// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FLASH_MS } from '../src/dom';
import { FindBar } from '../src/find-bar';
import { mount } from './helpers';

function setup(withToolbar = false) {
  const calls: string[] = [];
  const bar = new FindBar(
    { change: (q) => calls.push(`change:${q}`), next: () => calls.push('next'), previous: () => calls.push('previous'), dim: (on) => calls.push(`dim:${on}`), close: () => calls.push('close') },
    'Find',
  );
  const root = mount();
  if (withToolbar) {
    const tb = document.createElement('div');
    tb.className = 'toolbar';
    tb.getBoundingClientRect = () => ({ bottom: 41.4 }) as DOMRect;
    root.appendChild(tb);
  }
  root.appendChild(bar.element);
  const btn = (title: string) => bar.element.querySelector(`button[title^="${title}"]`) as HTMLButtonElement;
  const key = (k: string, shiftKey = false) => bar.input.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
  return { bar, calls, btn, key };
}

describe('FR-23.1 find bar', () => {
  it('FR-23.1 ↑ / ↓ step through the matches, ✕ closes', () => {
    const s = setup();
    s.bar.open('order');
    s.btn('Next').click();
    s.btn('Previous').click();
    s.btn('Close').click();
    expect(s.calls).toEqual(['change:order', 'next', 'previous', 'close']);
    expect(s.bar.isOpen).toBe(false);
  });

  it('FR-23.1 going round the end says so for a moment: Back to the first / Back to the last', () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.bar.open('order');
      const wrap = () => s.bar.element.querySelector<HTMLElement>('.find-wrap')!;
      expect(s.bar.step(-1, 1, 3)).toBe(0); // the first match: no wrap
      expect(wrap().hidden).toBe(true);
      expect(s.bar.step(1, 1, 3)).toBe(2);
      expect(wrap().hidden).toBe(true);
      expect(s.bar.step(2, 1, 3)).toBe(0);
      expect(wrap().hidden).toBe(false);
      expect(wrap().textContent).toBe('↻ Back to the first');
      expect(s.bar.step(0, 1, 3)).toBe(1); // the next step without a wrap clears it
      expect(wrap().hidden).toBe(true);
      expect(s.bar.step(0, -1, 3)).toBe(2);
      expect(wrap().textContent).toBe('↻ Back to the last');
      vi.advanceTimersByTime(FLASH_MS);
      expect(wrap().hidden).toBe(true);
      // one match: stepping stays, nothing to say
      expect(s.bar.step(0, 1, 1)).toBe(0);
      expect(wrap().hidden).toBe(true);
      // closing clears it
      s.bar.step(2, 1, 3);
      s.bar.close();
      expect(wrap().hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-23.1 Enter / Shift+Enter step, Escape closes, other keys type', () => {
    const s = setup();
    s.bar.open('o');
    s.key('Enter');
    s.key('Enter', true);
    s.key('a');
    expect(s.bar.isOpen).toBe(true);
    s.key('Escape');
    expect(s.calls).toEqual(['change:o', 'next', 'previous', 'close']);
  });

  it('FR-23.1 a closed bar has no query; closing it again does nothing', () => {
    const s = setup();
    s.bar.input.value = 'left over';
    expect(s.bar.query).toBe('');
    s.bar.close();
    expect(s.calls).toEqual([]);
  });

  it('FR-23.1 opening without a query searches the last one again', () => {
    const s = setup();
    s.bar.input.value = 'order';
    s.bar.open();
    expect(s.calls).toEqual(['change:order']);
  });

  it('FR-23.1 opening again keeps the query (no new search) unless one is given', () => {
    const s = setup();
    s.bar.open('order');
    s.bar.open();
    expect(s.calls).toEqual(['change:order']);
    s.bar.open('invoice');
    expect(s.calls).toEqual(['change:order', 'change:invoice']);
    expect(s.bar.query).toBe('invoice');
  });

  it('FR-23.1 sits under the view\'s toolbar when there is one', () => {
    const a = setup(true);
    a.bar.open('x');
    expect(a.bar.element.style.top).toBe('47px');
    const b = setup(false);
    b.bar.open('x');
    expect(b.bar.element.style.top).toBe('');
  });

  it('FR-23.1 the count: "3 of 12", "? of 12" with no match selected, empty without a query', () => {
    const s = setup();
    s.bar.open('o');
    const count = () => s.bar.element.querySelector('.find-count')!.textContent;
    s.bar.setCount(2, 12);
    expect(count()).toBe('3 of 12');
    s.bar.setCount(-1, 12);
    expect(count()).toBe('? of 12');
    s.bar.input.value = ' ';
    s.bar.setCount(0, 0);
    expect(count()).toBe('');
  });
});
