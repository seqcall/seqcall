// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { revealElements } from '../src/dom';

/** jsdom has no layout: rects are set per element; the container's content moves with its scroll offsets. */
function box(left: number, top: number, width: number, height: number, container?: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => {
    const dx = container?.scrollLeft ?? 0;
    const dy = container?.scrollTop ?? 0;
    return { left: left - dx, top: top - dy, right: left - dx + width, bottom: top - dy + height, width, height, x: left - dx, y: top - dy, toJSON() {} } as DOMRect;
  };
  return el;
}

function viewport(w: number, h: number): HTMLElement {
  const c = box(0, 0, w, h);
  Object.defineProperty(c, 'clientWidth', { value: w });
  Object.defineProperty(c, 'clientHeight', { value: h });
  return c;
}

describe('revealElements (find, issues, review: bring the evidence into view)', () => {
  it('FR-23.1 without zoom, centres a far-away element that fits', () => {
    const c = viewport(800, 600);
    const el = box(2000, 1000, 100, 50, c);
    expect(revealElements(c, [el])).toBe(true);
    expect(c.scrollLeft).toBe(2000 - 350); // centred: (800 - 100) / 2 left of it
    expect(c.scrollTop).toBe(1000 - 275);
  });

  it('FR-19.7 does not zoom when the evidence already fits', () => {
    const c = viewport(800, 600);
    const zooms: number[] = [];
    revealElements(c, [box(100, 100, 200, 100, c)], { zoom: { current: 1, set: (z) => zooms.push(z) } });
    expect(zooms).toEqual([]);
  });

  it('FR-19.7 zooms out until the union fits and still reveals a vertical line (width 0) after it', () => {
    const c = viewport(800, 600);
    let scale = 1;
    // a lifeline: no width, only height; it shrinks with the zoom
    const line = document.createElement('div');
    line.getBoundingClientRect = () => ({ left: 3000 * scale - c.scrollLeft, right: 3000 * scale - c.scrollLeft, top: 0, bottom: 2000 * scale, width: 0, height: 2000 * scale, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const zooms: number[] = [];
    expect(revealElements(c, [line], { zoom: { current: 1, set: (z) => { zooms.push(z); scale = z; } } })).toBe(true);
    expect(zooms).toEqual([0.27]); // (600 - 64) / 2000 rounded
    expect(c.scrollLeft).toBe(Math.round(3000 * 0.27 - 400));
  });
});
