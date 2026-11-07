// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasMeasure, estimateTextWidth, fitText } from '../src/measure';

const realAgent = navigator.userAgent;
afterEach(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: realAgent });
  document.documentElement.style.removeProperty('--vscode-font-family');
  document.documentElement.style.removeProperty('--vscode-editor-font-family');
  vi.restoreAllMocks();
});

/** A browser: not jsdom, a canvas whose text width is 7 px per character, recording the fonts asked for. */
function browserCanvas() {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Chrome/140' });
  const fonts: string[] = [];
  const ctx = {
    font: '',
    measureText(text: string) {
      fonts.push(this.font);
      return { width: text.length * 7 - 0.5 };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  return fonts;
}

describe('text measurement (box widths, label fitting)', () => {
  it('NFR-4 in a browser, measures with the editor\'s fonts on a canvas, each text once', () => {
    const fonts = browserCanvas();
    document.documentElement.style.setProperty('--vscode-font-family', 'Inter');
    document.documentElement.style.setProperty('--vscode-editor-font-family', 'Fira Code');
    const m = createCanvasMeasure();
    expect(m('Order', 'participant')).toBe(35);
    expect(m('Order', 'participant')).toBe(35);
    expect(m('id: string', 'args')).toBe(70);
    expect(m('«service»', 'stereotype')).toBe(63);
    expect(fonts).toEqual(['600 13px Inter', '400 11px Fira Code', 'italic 400 11px Inter']);
  });

  it('NFR-4 without theme fonts (a browser tab, JCEF) falls back to system fonts', () => {
    const fonts = browserCanvas();
    const m = createCanvasMeasure();
    m('a', 'method');
    m('b', 'member');
    expect(fonts).toEqual(['600 12px system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif', '400 12px ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace']);
  });

  it('NFR-4 a document without a window (no computed style) uses the fallback fonts', () => {
    const fonts = browserCanvas();
    createCanvasMeasure(document.implementation.createHTMLDocument())('a', 'group');
    expect(fonts).toEqual(['600 11px system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif']);
  });

  it('NFR-4 without a 2D canvas (none, or it throws) the estimate is used', () => {
    browserCanvas();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    expect(createCanvasMeasure()).toBe(estimateTextWidth);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('canvas blocked');
    });
    expect(createCanvasMeasure()).toBe(estimateTextWidth);
  });

  it('NFR-5 under jsdom (view tests) the estimate is used, even with a canvas: layouts stay the same on every machine', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ measureText: () => ({ width: 1 }) }) as unknown as CanvasRenderingContext2D);
    expect(createCanvasMeasure()).toBe(estimateTextWidth);
  });

  it('FR-6.4 a label that fits stays; a longer one is cut with …; no room at all leaves only …', () => {
    const per = (t: string) => t.length * 10;
    expect(fitText('Domain', 60, 'group', per)).toBe('Domain');
    expect(fitText('Infrastructure', 60, 'group', per)).toBe('Infra…');
    expect(fitText('Infra structure', 70, 'group', per)).toBe('Infra…'); // no space before the …
    expect(fitText('Domain', 5, 'group', per)).toBe('…');
  });
});
