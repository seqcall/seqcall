/**
 * Text measurement is injectable: the browser uses canvas `measureText`, tests (jsdom has
 * no layout engine) use the char-width estimate. Font specs must match styles.css.
 */

import { cutFrom } from './text';

export type TextStyle =
  | 'participant'
  | 'stereotype'
  | 'method'
  | 'args'
  | 'marker'
  | 'group'
  | 'className'
  | 'member'
  /** FR-17 I/O tags (DB, HTTP …). */
  | 'tag';

export type MeasureText = (text: string, style: TextStyle) => number;

export interface FontSpec {
  size: number;
  weight: number;
  italic?: boolean;
  mono?: boolean;
}

export const FONT_SPECS: Record<TextStyle, FontSpec> = {
  participant: { size: 13, weight: 600 },
  stereotype: { size: 11, weight: 400, italic: true },
  method: { size: 12, weight: 600 },
  args: { size: 11, weight: 400, mono: true },
  marker: { size: 10, weight: 500 },
  group: { size: 11, weight: 600 },
  className: { size: 13, weight: 700 },
  member: { size: 12, weight: 400, mono: true },
  tag: { size: 8, weight: 700 },
};

/** Deterministic estimate: average glyph width as a fraction of the font size. */
export const estimateTextWidth: MeasureText = (text, style) => {
  const f = FONT_SPECS[style];
  const factor = f.mono ? 0.6 : f.weight >= 600 ? 0.6 : 0.55;
  return Math.ceil(text.length * f.size * factor);
};

const UI_FALLBACK = 'system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif';
const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';

/** Canvas-based measurement using the actual theme fonts; falls back to the estimate. */
export function createCanvasMeasure(doc: Document = document): MeasureText {
  // jsdom (view tests without an injected measure) has no fonts; the only callers are the two view constructors,
  // which run in a browser (or jsdom), where `navigator` always exists
  if (/jsdom/i.test(navigator.userAgent)) return estimateTextWidth;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = doc.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return estimateTextWidth;
  const rootStyle = doc.defaultView?.getComputedStyle(doc.documentElement);
  const ui = rootStyle?.getPropertyValue('--vscode-font-family').trim() || UI_FALLBACK;
  const mono = rootStyle?.getPropertyValue('--vscode-editor-font-family').trim() || MONO_FALLBACK;
  const cache = new Map<string, number>();
  const c = ctx;
  return (text, style) => {
    const key = style + '\u0000' + text;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const f = FONT_SPECS[style];
    c.font = `${f.italic ? 'italic ' : ''}${f.weight} ${f.size}px ${f.mono ? mono : ui}`;
    const w = Math.ceil(c.measureText(text).width);
    cache.set(key, w);
    return w;
  };
}

/** Truncates `text` with an ellipsis so that it fits into `maxWidth`. */
export function fitText(text: string, maxWidth: number, style: TextStyle, measure: MeasureText): string {
  if (measure(text, style) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '…', style) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…'; // lo = 0: only the …
}

/**
 * The stereotypes worth a line in a box (compact boxes): not one the name already says
 * (`OrderRepository` «repository», `CouponsController` «controller»), not «seam» where the box shows the port it was
 * reached through or is itself an «interface» / «port» (reached through an abstraction by definition). Hovering the line (or the box, when none is left) still lists them all with their reasons (FR-7.9).
 */
export function shownStereotypes(stereotypes: readonly string[], name: string, opts: { portLine?: boolean } = {}): string[] {
  const plain = cutFrom(name, '<').replace(/^.*[.:\\/]/, '').toLowerCase();
  const abstraction = opts.portLine || stereotypes.includes('interface') || stereotypes.includes('port');
  return stereotypes.filter((s) => !(abstraction && s === 'seam') && !(s.length > 2 && plain.endsWith(s.toLowerCase())));
}

/** UML convention: all stereotypes on one line, `«interface, repository, port»`. */
export function stereotypeText(stereotypes: readonly string[]): string | undefined {
  return stereotypes.length ? `«${stereotypes.join(', ')}»` : undefined;
}

/**
 * The one-line stereotype text fitted into `maxWidth`; truncated inside the guillemets
 * (`«interface, repo…»`) when too wide. `undefined` when there are no stereotypes.
 */
export function fitStereotypes(stereotypes: readonly string[], maxWidth: number, measure: MeasureText): string | undefined {
  const full = stereotypeText(stereotypes);
  if (!full || measure(full, 'stereotype') <= maxWidth) return full;
  const inner = fitText(stereotypes.join(', '), maxWidth - measure('«»', 'stereotype'), 'stereotype', measure);
  return `«${inner}»`;
}
