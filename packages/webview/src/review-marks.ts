/**
 * FR-24.11 what a reviewed branch did to a class, drawn the same way in both diagrams: a tag on the
 * object / class box (NEW, or Δn changed members) with the members in its tooltip; click = the class side by side.
 */
import type { ClassChange, MemberChange } from '@seqcall/protocol';
import { svg, svgTitle } from './dom';

export const memberSign: Record<MemberChange['change'], string> = { added: '+', changed: '~', removed: '−' };

const kindText = (m: MemberChange) => (m.kind === 'declaration' ? 'base types' : m.kind);

/** "New class on this branch" / "Changed on this branch:" with a line per member. */
export function changeTitle(c: ClassChange, listed?: number): string {
  if (c.kind === 'new') return 'New on this branch\n(click: open it side by side)';
  // a class box lists the members the flow uses: say why Δ2 shows one marked row
  const unlisted = listed === undefined ? 0 : c.members.length - listed;
  const note = unlisted > 0 ? [`(${unlisted} of them not listed in the box: not used in the drawn calls)`] : [];
  return ['Changed on this branch:', ...c.members.map((m) => `${memberSign[m.change]} ${m.text}${m.kind !== 'method' ? ` (${kindText(m)})` : ''}`), ...note, '(click: open it side by side)'].join('\n');
}

/** A member's change and its diff lines (row tooltips). */
export function memberTitle(m: MemberChange): string {
  const what = { added: 'added', changed: 'changed', removed: 'removed' }[m.change];
  return [`${memberSign[m.change]} ${m.text} — ${kindText(m)} ${what} on this branch`, ...(m.hunk ?? []).map((l) => `${l.kind} ${l.text}`), '(click: open the change side by side)'].join('\n');
}

/** The tag on the top edge of a box, left of its top-right corner (the ⚑ layer hint keeps the corner). */
export function changeTag(c: ClassChange, boxWidth: number, classKey: string, rightInset = 20, listed?: number): SVGGElement {
  const text = c.kind === 'new' ? 'NEW' : `Δ${c.members.length}`;
  const w = Math.round(text.length * 6.2 + 10);
  const x = Math.max(4, boxWidth - rightInset - w);
  return svg('g', { class: `change-tag ${c.kind}`, 'data-class-diff': classKey, role: 'button' }, [
    svgTitle(changeTitle(c, listed)),
    svg('rect', { x, y: -7, width: w, height: 13, rx: 6.5, ry: 6.5 }),
    svg('text', { x: x + w / 2, y: 3, 'text-anchor': 'middle' }, [text]),
  ]);
}
