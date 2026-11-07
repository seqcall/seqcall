/**
 * FR-1.16 a fragment's guard is drawn next to the first call it guards (right of the owner's activation
 * bar). A wide frame — it also encloses participants far to the left or right — can be scrolled so that
 * the frame is on screen but its guard is not. Then a copy floats at the edge of the view on the guard's
 * line, with an arrow towards the real one (`opt [x != null] →`); clicking it scrolls there.
 */
import { svg, svgTitle } from '../dom';
import type { MeasureText } from '../measure';
import type { SequenceGeometry } from './layout';

/** The visible part of the body, in diagram coordinates. */
export interface ViewRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface GuardGhost {
  fragmentId: string;
  /** The frame's kind (its colour). */
  kind: string;
  operand: number;
  text: string;
  /** Full guard (tooltip). */
  title: string;
  x: number;
  /** Text baseline. */
  y: number;
  side: 'left' | 'right';
  /** Background (covers what is left of the real guard at that edge), in diagram coordinates. */
  bgX: number;
  bgWidth: number;
  /** x of the real guard (where a click scrolls to). */
  targetX: number;
}

const ROOM = 6;

export function guardGhosts(geom: SequenceGeometry, view: ViewRect, measure: MeasureText): GuardGhost[] {
  const out: GuardGhost[] = [];
  for (const fg of geom.fragments) {
    if (fg.x2 <= view.left || fg.x1 >= view.right) continue; // the frame is not on screen
    const tagVisible = fg.x1 >= view.left && fg.x1 + fg.tagWidth <= view.right;
    fg.operands.forEach((op, k) => {
      if (!op.guard) return;
      // the guard's line is on screen (not hidden under the frozen header, not below the view)
      if (op.guardY - 10 < view.top || op.guardY > view.bottom) return;
      const gx1 = op.guardX;
      const gx2 = op.guardX + op.guardWidth;
      // more than half of the guard (or the ⊖ after it) is out of view
      const mid = (gx1 + gx2) / 2;
      const right = mid > view.right;
      const left = mid < view.left;
      if (!right && !left) return;
      // the frame's kind goes with every guard (as on the real one)
      const prefix = `${fg.fragment.kind} `;
      const text = right ? `${prefix}${op.guard} →` : `← ${prefix}${op.guard}`;
      const width = Math.ceil(measure(text, 'args'));
      const lo = Math.max(view.left, fg.x1) + ROOM + (k === 0 && tagVisible && fg.x1 >= view.left ? fg.tagWidth : 0);
      const hi = Math.min(view.right, fg.x2) - ROOM;
      if (hi - lo < width) return; // no room inside the visible part of the frame
      const x = right ? hi - width : lo;
      // the background reaches the view's edge, so a cut-off rest of the real guard does not peek out
      const bgX = right ? x - 4 : Math.max(view.left, fg.x1 + 1);
      const bgEnd = right ? Math.min(view.right, fg.x2 - 1) : x + width + 4;
      out.push({ fragmentId: fg.id, kind: fg.fragment.kind, operand: k, text, title: `[${op.guardFull}] — click to scroll to it`, x, y: op.guardY, side: right ? 'right' : 'left', targetX: gx1, bgX, bgWidth: bgEnd - bgX });
    });
  }
  return out;
}

/** The ghosts as an SVG group (`data-ghost-x` = where a click scrolls to). */
export function renderGuardGhosts(ghosts: GuardGhost[]): SVGGElement {
  const g = svg('g', { class: 'guard-ghosts' });
  for (const gh of ghosts) {
    const one = svg('g', { class: `guard-ghost-item kind-${gh.kind}`, 'data-ghost-x': Math.round(gh.targetX), role: 'button' }, [
      svg('rect', { class: 'guard-ghost-bg', x: Math.round(gh.bgX), y: Math.round(gh.y - 9), width: Math.max(0, Math.round(gh.bgWidth)), height: 12 }),
      svg('text', { class: 'frag-guard guard-ghost', x: Math.round(gh.x), y: Math.round(gh.y) }, [gh.text]),
      svgTitle(gh.title),
    ]);
    g.appendChild(one);
  }
  return g;
}
