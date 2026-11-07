// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { observeCompact } from '../src/compact';

type Win = Window & { ResizeObserver?: unknown };

/** jsdom has no ResizeObserver: a fake one the test drives, and animation frames run on demand. */
function fakeResize() {
  const win = window as Win;
  let callback: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
  const frames: (() => void)[] = [];
  win.ResizeObserver = class {
    constructor(cb: typeof callback) {
      callback = cb;
    }
    observe() {}
  };
  const raf = win.requestAnimationFrame;
  win.requestAnimationFrame = (f: FrameRequestCallback) => frames.push(() => f(0));
  return {
    resize: (width: number) => callback!([{ contentRect: { width } }]),
    frames,
    flush: () => frames.splice(0).forEach((f) => f()),
    restore: () => (win.requestAnimationFrame = raf),
  };
}

let restore = () => {};
afterEach(() => {
  restore();
  delete (window as Win).ResizeObserver;
});

describe('FR-14.3 narrow panels (compact toolbar)', () => {
  it('FR-14.3 a toolbar narrower than the limit turns compact in the next frame, and back when it widens', () => {
    const r = fakeResize();
    restore = r.restore;
    const bar = document.createElement('div');
    observeCompact(bar, 860);
    r.resize(456);
    expect(bar.classList.contains('compact')).toBe(false); // not inside the observer callback
    r.flush();
    expect(bar.classList.contains('compact')).toBe(true);
    r.resize(500); // still narrow: no new frame
    expect(r.frames).toHaveLength(0);
    r.resize(1200);
    r.flush();
    expect(bar.classList.contains('compact')).toBe(false);
  });

  it('FR-14.3 a hidden toolbar (width 0) is not compact', () => {
    const r = fakeResize();
    restore = r.restore;
    const bar = document.createElement('div');
    observeCompact(bar, 860);
    r.resize(0);
    expect(r.frames).toHaveLength(0);
    expect(bar.classList.contains('compact')).toBe(false);
  });

  it('FR-14.3 without ResizeObserver (old browser) the toolbar stays as it is', () => {
    const bar = document.createElement('div');
    expect(() => observeCompact(bar, 860)).not.toThrow();
    expect(bar.classList.contains('compact')).toBe(false);
  });
});
