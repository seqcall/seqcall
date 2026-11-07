/**
 * the class view during a review: the classes the branch changed (Δ / NEW on their boxes), stepped
 * through in reading order (◀ ▶, P / N) — each scrolled to and outlined. The sequence view's bar walks the calls;
 * this one walks the boxes, so the class view's Δ marks can be stepped through too.
 */
import { html } from '../dom';
import type { ClassNodeGeom } from './layout';

/** The changed classes of the drawn diagram, top to bottom, then left to right. */
export function changedClasses(nodes: ClassNodeGeom[]): ClassNodeGeom[] {
  return nodes.filter((n) => n.node.change).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The bar: how many changed classes, the current one, ◀ ▶. `at` is -1 before the first step. */
export function classReviewBar(changed: ClassNodeGeom[], at: number, step: (by: 1 | -1) => void): HTMLElement {
  const btn = (text: string, title: string, by: 1 | -1) => {
    const b = html('button', { type: 'button', class: 'rb-btn', title, 'aria-label': title }, [text]) as HTMLButtonElement;
    b.addEventListener('click', () => step(by));
    return b;
  };
  const cur = changed[at];
  const newOnes = changed.filter((n) => n.node.change!.kind === 'new').length;
  const what = `${changed.length} class${changed.length === 1 ? '' : 'es'} changed on this branch${newOnes ? ` (${newOnes} new)` : ''}`;
  const text = cur ? `${cur.node.name} — ${cur.node.change!.kind === 'new' ? 'new' : `Δ${cur.node.change!.members.length} members`}` : '▶ for the first';
  return html('div', { class: 'review-bar class-review-bar', role: 'toolbar', 'aria-label': 'Review changes' }, [
    html('span', { class: 'rb-title', title: `${what}\nΔn = members the branch changed (hover a box's Δ for them, click it for the diff)` }, [`⎇ ${what}`]),
    html('span', { class: 'rb-sep' }, ['│']),
    btn('◀', 'Previous changed class (P)', -1),
    html('span', { class: 'rb-change' }, [html('span', { class: 'rb-count' }, [`Class ${cur ? at + 1 : '–'}/${changed.length}`]), ` ${text}`]),
    btn('▶', 'Next changed class (N)', 1),
  ]);
}
