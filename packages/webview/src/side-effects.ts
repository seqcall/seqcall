import type { FlowOutcome, SideEffectKind, SideEffects } from '@seqcall/protocol';
import { round, svg, svgTitle } from './dom';

/** FR-17 short tags of the I/O kinds (same as the core's labels). */
export const SIDE_EFFECT_TAG: Record<SideEffectKind, string> = { db: 'DB', cache: 'CACHE', http: 'HTTP', file: 'FILE', queue: 'MQ', cloud: 'CLOUD', process: 'PROC' };

/** "DB·HTTP" */
export function sideEffectText(e: SideEffects): string {
  return e.kinds.map((k) => SIDE_EFFECT_TAG[k]).join('·');
}

/** FR-32.2 the outcome at the gate: `⇢ HTTP · FILE`, `+` when the flow was not followed to its end. */
export function outcomeText(o: FlowOutcome): string {
  return `⇢ ${o.io.length ? o.io.map((k) => SIDE_EFFECT_TAG[k.kind]).join(' · ') : 'no I/O'}${o.atLeast ? '+' : ''}`;
}

/** Tooltip / hover-card lines: what was found, and where. */
export function sideEffectLines(e: SideEffects, whole = false): string[] {
  const head = whole ? 'I/O in this file / type' : e.below ? 'I/O further down (already analysed calls)' : 'I/O';
  return [head, ...e.evidence];
}

/** Horizontal padding of the pill around its text. */
export const IO_PILL_PAD = 4;

/** Small pill with the I/O tags; `x`, `y` = top-left corner. */
export function sideEffectPill(e: SideEffects, x: number, y: number, width: number, extraClass = '', title?: string): SVGGElement {
  return svg('g', { class: `io-badge${e.below ? ' below' : ''}${extraClass ? ` ${extraClass}` : ''}`, 'data-io': e.kinds.join(' ') }, [
    title ? svgTitle(title) : null,
    svg('rect', { x: round(x), y: round(y), width: round(width), height: 12, rx: 3, ry: 3 }),
    svg('text', { class: 'io-text', x: round(x + IO_PILL_PAD), y: round(y + 9) }, [sideEffectText(e)]),
  ]);
}
