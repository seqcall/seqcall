/** Tiny DOM helpers (no framework). Never sets `style` attributes (strict CSP friendly). */

export const SVG_NS = 'http://www.w3.org/2000/svg';

type AttrValue = string | number | boolean | undefined | null;
export type Attrs = Record<string, AttrValue>;
export type Child = Node | string | number | null | undefined | false;

function apply(el: Element, attrs: Attrs | undefined, children: Child[] | undefined): void {
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : el.ownerDocument!.createTextNode(String(c)));
    }
  }
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, children?: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, children);
  return el;
}

export function html<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, children?: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, children);
  return el;
}

/** `<title>` child for native SVG tooltips. */
export function svgTitle(text: string): SVGTitleElement {
  return svg('title', undefined, [text]);
}

/** Finds the closest ancestor (or self) carrying the given data attribute. */
export function closestWithData(target: EventTarget | null, attr: string): Element | null {
  let el = target as Element | null;
  while (el && el.nodeType === 1) {
    if (el.hasAttribute(`data-${attr}`)) return el;
    el = el.parentElement ?? (el.parentNode as Element | null);
  }
  return null;
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface RevealOptions {
  /** Space covered at the top by a sticky header. */
  top?: number;
  horizontalOnly?: boolean;
  /** Zoom out first when the union does not fit (FR-19.7/19.8): the current zoom, a setter, the floor. */
  zoom?: { current: number; set(z: number): void; min?: number };
  /** space covered at the right by a card: the union is fitted and centred left of it. */
  right?: number;
}

/**
 * Scrolls `container` so that `elements` (their union) are in view: centred when they fit, else their
 * top-left corner with a margin. Uses the rendered positions, so zoom and offsets need no care;
 * `top` = space covered at the top by a sticky header. Returns false when nothing could be measured.
 */
export function revealElements(container: HTMLElement, elements: Element[], opts: RevealOptions = {}): boolean {
  let rects = elements.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
  if (!rects.length) return false;
  const margin = 32;
  if (opts.zoom) {
    // zoom out (never in) until the union fits
    const { current, set, min = 0.25 } = opts.zoom; // 0.25 = MIN_ZOOM: the whole evidence over legible labels
    const w = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
    const h = Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top));
    const viewW = container.clientWidth - (opts.right ?? 0);
    const viewH = container.clientHeight - (opts.top ?? 0);
    // the margin shrinks with a small view (a short panel below the sticky header), never below zero room
    const ratio = (size: number, view: number): number => {
      const room = view - 2 * Math.min(margin, view / 8);
      return size > room && room > 0 && size > 0 ? room / size : 1;
    };
    const rw = ratio(w, viewW);
    const rh = opts.horizontalOnly ? 1 : ratio(h, viewH);
    const to = Math.max(min, Math.round(current * Math.min(rw, rh) * 100) / 100);
    if (to < current) {
      set(to);
      rects = elements.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
    }
  }
  const c = container.getBoundingClientRect();
  const top = opts.top ?? 0;
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const upper = Math.min(...rects.map((r) => r.top));
  const lower = Math.max(...rects.map((r) => r.bottom));
  const viewW = container.clientWidth - (opts.right ?? 0);
  const viewH = container.clientHeight - top;
  // horizontally
  if (left < c.left + margin || right > c.left + viewW - margin) {
    const w = right - left;
    const shift = w + 2 * margin <= viewW ? left - c.left - (viewW - w) / 2 : left - c.left - margin;
    container.scrollLeft = Math.max(0, container.scrollLeft + shift);
  }
  if (opts.horizontalOnly) return true;
  // vertically (below the sticky header)
  if (upper < c.top + top + margin || lower > c.top + top + viewH - margin) {
    const h = lower - upper;
    const shift = h + 2 * margin <= viewH ? upper - c.top - top - (viewH - h) / 2 : upper - c.top - top - margin;
    container.scrollTop = Math.max(0, container.scrollTop + shift);
  }
  return true;
}


/** how long a "Copied ✓" / "Saved ✓" confirmation stays (a shorter one is missed). */
export const FLASH_MS = 4000;
