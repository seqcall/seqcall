// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundOf, blobToBase64, copyPng, download, imageName, standaloneSvg, svgToPng } from '../src/export-image';
import { mount } from './helpers';

const NS = 'http://www.w3.org/2000/svg';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function part(attrs: Record<string, string>): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.appendChild(document.createElementNS(NS, 'rect'));
  return s;
}
const parsed = (text: string) => new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;

describe('FR-25.1 the image: SVG document', () => {
  it('FR-25.1 a part without a viewBox keeps its width / height; one with neither gets no size', () => {
    const a = part({ width: '300', height: '40' });
    const b = part({});
    const root = parsed(standaloneSvg([{ svg: a, y: 0 }, { svg: b, y: 40 }], 300, 100, '#fff').svg);
    const [pa, pb] = [...root.children].filter((c) => c.tagName === 'svg');
    expect([pa.getAttribute('width'), pa.getAttribute('height')]).toEqual(['300', '40']);
    expect([pb.getAttribute('width'), pb.getAttribute('height')]).toEqual([null, null]);
  });

  it('FR-25.1 a part with a viewBox gets its size from it (the layout\'s size, whatever the zoom)', () => {
    const a = part({ viewBox: '0 0 640 80', width: '320', height: '40' }); // zoomed to 50 %
    const p = [...parsed(standaloneSvg([{ svg: a, y: 0 }], 640, 80, '#fff').svg).children].find((c) => c.tagName === 'svg')!;
    expect([p.getAttribute('width'), p.getAttribute('height')]).toEqual(['640', '80']);
  });

  it('FR-25.1 labels running past the layout widen the image (measured bounding box)', () => {
    const a = part({ viewBox: '0 0 300 40' });
    (a as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 420.2, height: 40 }) as DOMRect;
    const out = standaloneSvg([{ svg: a, y: 10 }], 300, 40, '#fff');
    expect([out.width, out.height]).toEqual([429, 58]);
  });

  it('FR-25.1 a serializer that leaves out the SVG namespace (the image would not open): it is added once', () => {
    vi.spyOn(XMLSerializer.prototype, 'serializeToString').mockReturnValue('<svg width="1" height="1"></svg>');
    expect(standaloneSvg([], 1, 1, '#fff').svg).toBe(`<svg xmlns="${NS}" width="1" height="1"></svg>`);
  });
});

describe('FR-25.1 the image: PNG, clipboard, download', () => {
  /** jsdom has no image decoding and no canvas: fakes that record the canvas size and give a blob (or none). */
  function fakeCanvas(blob: Blob | null) {
    const drawn: number[][] = [];
    vi.stubGlobal('Image', class { src = ''; decode = async () => undefined; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (_: unknown, ...xywh: number[]) => drawn.push(xywh) }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(blob));
    return drawn;
  }

  it('FR-25.1 PNG at 2× for sharp text', async () => {
    const drawn = fakeCanvas(new Blob(['png']));
    expect(await (await svgToPng('<svg/>', 800, 600)).text()).toBe('png');
    expect(drawn).toEqual([[0, 0, 1600, 1200]]);
  });

  it('FR-25.1 a huge diagram is scaled down to the canvas limits instead of failing', async () => {
    const drawn = fakeCanvas(new Blob(['png']));
    await svgToPng('<svg/>', 20000, 3000);
    expect(drawn).toEqual([[0, 0, 16000, 2400]]); // the longest side at 16000 px
  });

  it('FR-25.1 a canvas that gives no image (too large for the browser) is an error the view can show', async () => {
    fakeCanvas(null);
    await expect(svgToPng('<svg/>', 100, 100)).rejects.toThrow('the image is too large');
  });

  it('FR-25.1 Copy as image puts the PNG on the clipboard where the host allows it', async () => {
    const written: unknown[] = [];
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, unknown>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items: unknown[]) => void written.push(...items) } });
    const png = Promise.resolve(new Blob(['png']));
    expect(await copyPng(png)).toBe(true);
    expect((written[0] as { items: Record<string, unknown> }).items['image/png']).toBe(png);
  });

  it('FR-25.1 Copy as image is false without the clipboard API, or when the host refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    expect(await copyPng(Promise.resolve(new Blob()))).toBe(false); // no ClipboardItem (jsdom, older JCEF)
    vi.stubGlobal('ClipboardItem', class {});
    expect(await copyPng(Promise.resolve(new Blob()))).toBe(false); // no clipboard.write
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => { throw new Error('NotAllowedError'); } } });
    expect(await copyPng(Promise.resolve(new Blob()))).toBe(false);
  });

  it('FR-25.1 the PNG as base64 for the host to save (also above 32 KB, in chunks)', async () => {
    const bytes = new Uint8Array(0x8000 + 3).map((_, i) => i % 251);
    expect(await blobToBase64(new Blob([bytes]))).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('FR-25.1 the image\'s background is the panel\'s: the first ancestor with a colour, else white', () => {
    const root = mount();
    root.style.backgroundColor = 'rgb(30, 30, 30)';
    const middle = document.createElement('div');
    middle.style.backgroundColor = 'transparent';
    root.appendChild(middle);
    const inner = document.createElement('div');
    inner.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    middle.appendChild(inner);
    expect(backgroundOf(inner)).toBe('rgb(30, 30, 30)');
    expect(backgroundOf(document.body)).toBe('#ffffff');
    // a browser that reports a transparent background by name
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((e) => (e === inner ? ({ backgroundColor: 'transparent' } as CSSStyleDeclaration) : real(e)));
    expect(backgroundOf(inner)).toBe('rgb(30, 30, 30)');
  });

  it('FR-25.1 a subject without letters is named "diagram"', () => {
    expect(imageName('<<>>')).toBe('diagram');
  });

  it('FR-25.1 Save in a browser / JCEF downloads the file and frees it after a second', () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    URL.createObjectURL = (b: Blob) => (blobs.push(b), `blob:${blobs.length}`);
    URL.revokeObjectURL = (u: string) => void revoked.push(u);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.download} ${this.href}`);
    });
    const png = new Blob(['png'], { type: 'image/png' });
    download('Order.place.svg', '<svg/>', 'image/svg+xml');
    download('Order.place.png', png, 'image/png');
    expect(clicks).toEqual(['Order.place.svg blob:1', 'Order.place.png blob:2']);
    expect(blobs[0].type).toBe('image/svg+xml');
    expect(blobs[1]).toBe(png);
    expect(document.querySelectorAll('a[download]')).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(revoked).toEqual(['blob:1', 'blob:2']);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });
});
