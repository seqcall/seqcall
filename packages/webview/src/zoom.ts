/**
 * Zoom shared by the sequence and class views: pure math plus a small toolbar control.
 * Zoom scales the rendered SVGs (width/height attributes; the viewBox stays in layout
 * coordinates), so layout and hit testing keep working in unscaled coordinates.
 */
import { html } from './dom';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;
const STEP = 1.2;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 1000) / 1000));
}

/** Next zoom step; snaps to 100% when passing it. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir > 0 ? z * STEP : z / STEP;
  if ((z < 1 && next > 1) || (z > 1 && next < 1)) return 1;
  return clampZoom(next);
}

/** Zoom that fits the content into the viewport (never enlarges beyond 100%). */
export function fitZoom(contentW: number, contentH: number, viewW: number, viewH: number): number {
  const rw = contentW > 0 && viewW > 0 ? viewW / contentW : 1;
  const rh = contentH > 0 && viewH > 0 ? viewH / contentH : 1;
  return clampZoom(Math.min(1, rw, rh));
}

/** the class view's Fit: the width, at least `min` (a whole-diagram fit leaves wide windows unreadable). */
export const READABLE_FIT = 0.6;
export function fitWidthZoom(contentW: number, viewW: number, min = READABLE_FIT): number {
  return clampZoom(Math.min(1, Math.max(min, fitZoom(contentW, 0, viewW, 0))));
}

/**
 * New scroll offsets so that the content point under the pointer (`px`,`py` relative to
 * the scroll viewport) stays under the pointer when zooming from `from` to `to`.
 */
export function scrollForZoom(scrollLeft: number, scrollTop: number, px: number, py: number, from: number, to: number): { left: number; top: number } {
  const cx = (scrollLeft + px) / from;
  const cy = (scrollTop + py) / from;
  return { left: Math.max(0, cx * to - px), top: Math.max(0, cy * to - py) };
}

/** Wheel delta → zoom factor (smooth for trackpads, ~1.2 per mouse notch). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-px * 0.0018);
}

export function formatZoom(z: number): string {
  return `${Math.round(z * 100)}%`;
}

export type ZoomCommand = 'zoomOut' | 'zoomIn' | 'zoomReset' | 'zoomFit';

/** Toolbar group: − 100% + Fit. */
export class ZoomControls {
  readonly element: HTMLElement;
  private readonly label: HTMLButtonElement;
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(onCommand: (cmd: ZoomCommand) => void, fitTitle = 'Fit to view') {
    const btn = (cmd: ZoomCommand, text: string, title: string, cls = '') => {
      const b = html('button', { type: 'button', class: `tb-btn ${cls}`.trim(), title, 'aria-label': title, 'data-cmd': cmd }, [html('span', { class: 'tb-label' }, [text])]);
      b.addEventListener('click', () => onCommand(cmd));
      this.buttons.push(b);
      return b;
    };
    const out = btn('zoomOut', '−', 'Zoom out (Ctrl/Cmd + wheel)', 'icon-only');
    this.label = btn('zoomReset', '100%', 'Reset zoom to 100%', 'tb-zoom-label');
    const inn = btn('zoomIn', '+', 'Zoom in (Ctrl/Cmd + wheel)', 'icon-only');
    const fit = btn('zoomFit', '⤢', fitTitle, 'icon-only');
    // floats over the canvas corner (map style) instead of taking toolbar width
    this.element = html('div', { class: 'zoom-group zoom-float', role: 'toolbar', 'aria-label': 'Zoom' }, [out, this.label, inn, fit]);
  }

  update(zoom: number, enabled: boolean): void {
    this.label.querySelector('.tb-label')!.textContent = formatZoom(zoom);
    for (const b of this.buttons) b.disabled = !enabled;
  }
}

/** Sets the displayed size of an SVG whose viewBox is in layout coordinates. */
export function scaleSvg(el: SVGSVGElement, width: number, height: number, zoom: number): void {
  el.setAttribute('width', String(Math.round(width * zoom * 10) / 10));
  el.setAttribute('height', String(Math.round(height * zoom * 10) / 10));
}
