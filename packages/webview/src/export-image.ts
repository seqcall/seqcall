/**
 * FR-25 the whole diagram as an image to share: one standalone SVG of everything drawn (not just the visible
 * part; the sequence diagram's header and body stacked), with the computed styles inlined — the theme's colours
 * and fonts travel with it — on the panel's background; PNG at 2× for chat and documents, or SVG.
 * Copy puts the PNG on the clipboard; Save goes through the host (VS Code: a save dialog) or a download.
 */

import { trimChar } from './text';

/** Presentation properties copied from the computed style (classes and CSS variables do not travel). */
const PROPS = [
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'paint-order', 'visibility',
];

/** A clone of `svg` with each element's computed presentation inlined; hidden elements dropped. */
function inlined(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  const drop: Element[] = [];
  src.forEach((el, i) => {
    const out = dst[i] as SVGElement;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') {
      drop.push(out);
      return;
    }
    const values = new Map(PROPS.map((p) => [p, cs.getPropertyValue(p)]));
    // a translucent fill / stroke: the colour opaque, its alpha in the matching opacity (understood everywhere)
    for (const paint of ['fill', 'stroke']) {
      const c = portableColor(values.get(paint)!);
      values.set(paint, c.color);
      if (c.alpha !== undefined) values.set(`${paint}-opacity`, String(Number(values.get(`${paint}-opacity`)) * c.alpha));
    }
    const style = PROPS.map((p) => {
      const v = values.get(p);
      return v ? `${p}:${v}` : '';
    }).filter(Boolean);
    out.setAttribute('style', style.join(';'));
    out.removeAttribute('class');
  });
  for (const el of drop) el.remove();
  return clone;
}

const SRGB = /color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([-\d.e]+%?))?\)/g;
const channel = (v: string) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255);

/**
 * CSS Color 4 `color(srgb r g b / a)` — what browsers compute for `color-mix()` — as `rgb(…)`: SVG tools outside the
 * browser (rsvg, Inkscape, office suites) do not know it and paint such boxes black. `alpha` when one colour had one
 * below 1 (the caller moves it into fill-opacity / stroke-opacity).
 */
export function portableColor(value: string): { color: string; alpha?: number } {
  let alpha: number | undefined;
  const color = value.replace(SRGB, (_, r: string, g: string, b: string, a?: string) => {
    const n = a === undefined ? 1 : a.endsWith('%') ? Number(a.slice(0, -1)) / 100 : Number(a);
    if (n < 1) alpha = n;
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
  });
  return { color, ...(alpha !== undefined ? { alpha } : {}) };
}

export interface ImagePart {
  svg: SVGSVGElement;
  /** Vertical offset of this part in the image. */
  y: number;
  /** only this window of the part (its own coordinates), clipped at its edges. */
  view?: { x: number; y: number; width: number; height: number };
}

/** One standalone SVG document of the parts, at least `width` × `height` (more when labels run past), on `background`. */
export function standaloneSvg(parts: ImagePart[], width: number, height: number, background: string): { svg: string; width: number; height: number } {
  const ns = 'http://www.w3.org/2000/svg';
  // labels may run past the layout's width (they do on screen too): the image covers what is drawn
  for (const part of parts) {
    if (part.view) continue; // a window: its size is the image's
    try {
      const b = part.svg.getBBox();
      width = Math.max(width, b.x + b.width + 8);
      height = Math.max(height, part.y + b.y + b.height + 8);
    } catch {
      // not rendered (no layout engine): the given size
    }
  }
  const doc = document.createElementNS(ns, 'svg');
  doc.setAttribute('width', String(Math.ceil(width)));
  doc.setAttribute('height', String(Math.ceil(height)));
  doc.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  const paper = portableColor(background);
  bg.setAttribute('fill', paper.color);
  if (paper.alpha !== undefined) bg.setAttribute('fill-opacity', String(paper.alpha));
  doc.appendChild(bg);
  for (const part of parts) {
    const c = inlined(part.svg);
    // the parts are drawn at scale 1, wherever the panel is zoomed or scrolled; nothing clipped at their edges
    c.removeAttribute('style');
    c.setAttribute('x', '0');
    c.setAttribute('y', String(Math.round(part.y)));
    if (part.view) {
      const v = part.view;
      c.setAttribute('viewBox', `${Math.round(v.x)} ${Math.round(v.y)} ${Math.round(v.width)} ${Math.round(v.height)}`);
      c.setAttribute('width', String(Math.round(v.width)));
      c.setAttribute('height', String(Math.round(v.height)));
      doc.appendChild(c);
      continue;
    }
    c.setAttribute('overflow', 'visible');
    // the viewBox size (the layout's); a part without one keeps its own width / height attributes (cloned)
    const w = part.svg.viewBox.baseVal?.width;
    const h = part.svg.viewBox.baseVal?.height;
    if (w && h) {
      c.setAttribute('width', String(w));
      c.setAttribute('height', String(h));
    }
    doc.appendChild(c);
  }
  const text = new XMLSerializer().serializeToString(doc);
  // the serializer writes the SVG namespace on the root (an element made with createElementNS); make sure it is there once
  return { svg: text.startsWith('<svg xmlns=') ? text : text.replace(/^<svg/, `<svg xmlns="${ns}"`), width: Math.ceil(width), height: Math.ceil(height) };
}

/** Canvas limits: a huge diagram is scaled down rather than failing. */
const MAX_SIDE = 16000;
const MAX_AREA = 120_000_000;

/** The SVG rendered to a PNG blob at `scale` (2× for sharp text), within the canvas limits. */
export async function svgToPng(svgText: string, width: number, height: number, scale = 2): Promise<Blob> {
  const s = Math.max(0.25, Math.min(scale, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height))));
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * s);
  canvas.height = Math.ceil(height * s);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image is too large'))), 'image/png'));
}

/** The panel's background colour (the image's background). */
export function backgroundOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c;
  }
  return '#ffffff';
}

/** Puts the PNG on the clipboard; false where the host does not allow it. */
export async function copyPng(png: Promise<Blob>): Promise<boolean> {
  try {
    // no ClipboardItem (older browsers, jsdom) or no clipboard.write (insecure context) throws: false below
    // the promise keeps the click's user activation while the image renders
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A file name for the image: the diagram's subject, safe for any file system. */
export function imageName(subject: string): string {
  return trimChar(subject.replace(/[^\w.-]+/g, '-'), '-').slice(0, 80) || 'diagram';
}

/** Saves through a download (browser / JCEF hosts); VS Code blocks downloads in webviews — its host saves instead. */
export function download(name: string, data: Blob | string, type: string): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/** VS Code saves files for the webview (downloads are blocked there); other hosts download. */
export function hostSaves(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
}
