/**
 * FR-11.8 hiding a category in one step, from an object (sequence) or a class (class diagram):
 * every class named like it (`*Mapper`, its name's last word) or every class with one of its stereotypes. The same
 * submenu in both views.
 */
import type { HideFilterSpec } from '@seqcall/protocol';
import type { MenuItem } from './menu';

/** Stereotypes that are no category worth hiding (every interface, every library). */
const NOT_A_CATEGORY = new Set(['interface', 'external', 'abstract']);

export function categoryMenu(className: string, stereotypes: readonly string[], hide: (filter: HideFilterSpec) => void): MenuItem[] {
  const last = /[A-Z][a-z0-9]*$/.exec(className)?.[0];
  const items: MenuItem[] = [];
  if (last && last !== className) items.push({ id: 'hide-pattern', label: `Classes named *${last}`, title: `Hide the calls to every class whose name ends in ${last}`, action: () => hide({ kind: 'classPattern', pattern: `*${last}` }) });
  for (const s of stereotypes) {
    if (!NOT_A_CATEGORY.has(s)) items.push({ id: `hide-stereotype:${s}`, label: `Every «${s}» class`, title: `Hide the calls to every class marked «${s}»`, action: () => hide({ kind: 'stereotype', stereotype: s }) });
  }
  return items.length ? [{ id: 'hide-category', label: 'Hide every…', submenu: items }] : [];
}
