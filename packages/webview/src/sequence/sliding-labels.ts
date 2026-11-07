/**
 * FR-10.4 sliding labels: a call's label sits near the sender's end of its arrow; on a long arrow scrolled
 * so that the label is out of view but part of the arrow is in it, the label slides along its own arrow to
 * just inside the view (its row, its arrow: nothing is drawn twice). A label whose place is in view, self
 * calls and the found message never move. When less of the arrow is in view than the label needs, the label
 * stays at the arrow's end nearest to the view, partly visible, until the arrow itself leaves the view.
 */
import type { ViewRect } from './guard-ghosts';
import type { MessageGeom } from './layout';

/** Room kept at the view's edges and before the arrowhead. */
const EDGE = 6;
const HEAD = 14;

/** How far (diagram units, + = right) the label of `mg` moves for the visible part `view`; 0 = stays. */
export function labelShift(mg: MessageGeom, view: ViewRect): number {
  if (mg.loopX !== undefined || mg.kind === 'found') return 0;
  if (mg.labelY < view.top || mg.labelY - 12 > view.bottom) return 0;
  const left = mg.labelX - 3;
  const width = mg.label.width + 6;
  if (left >= view.left && left + width <= view.right) return 0;
  const arrowMin = Math.min(mg.x1, mg.x2);
  const arrowMax = Math.max(mg.x1, mg.x2);
  if (arrowMax <= view.left || arrowMin >= view.right) return 0;
  // where the label may sit on its arrow (after the start, before the head)
  const arrowLo = arrowMin + EDGE;
  const arrowHi = arrowMax - HEAD - width;
  if (arrowHi < arrowLo) return 0; // the arrow is shorter than its label: nothing to slide along
  const lo = Math.max(arrowLo, view.left + EDGE);
  const hi = Math.min(arrowHi, view.right - EDGE - width);
  // fully in view when the visible part of the arrow is long enough; else at the end of the arrow nearest to
  // the view, partly visible — it leaves only with its arrow
  if (hi >= lo) return Math.round(Math.min(Math.max(left, lo), hi) - left);
  // too little room: a label partly in view where it is stays; one out of view goes to the nearest end
  if (left < view.right && left + width > view.left) return 0;
  const to = Math.min(Math.max((view.left + view.right - width) / 2, arrowLo), arrowHi);
  return Math.round(to - left);
}
