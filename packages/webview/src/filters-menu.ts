import type { HiddenFilterInfo, HideFilter, HideFilterSpec } from '@seqcall/protocol';
import type { MenuItem } from './menu';
import { describeHideFilter } from './sequence/labels';

/** Posts to the host what the Filters ▾ dropdown and the hide / don't expand menu items ask for. */
type Post = (msg: { type: 'hide'; filter: HideFilterSpec } | { type: 'unhide'; filterId: string } | { type: 'unhideAll' }) => void;

/**
 * FR-11.3 / FR-11.7 the Filters ▾ dropdown, the same in both diagrams: the hide rules, then the "don't expand"
 * rules, each with its count; clicking one removes it.
 */
export function filtersMenu(filters: HiddenFilterInfo[], post: Post, emptyHint?: string): MenuItem[] {
  const row = (f: HiddenFilterInfo): MenuItem => ({
    id: `unhide:${f.filter.id}`,
    label: describeHideFilter(f.filter),
    hint: f.filter.noExpand ? `${f.hiddenCount} call${f.hiddenCount === 1 ? '' : 's'} · remove` : `${f.hiddenCount} hidden · unhide`,
    action: () => post({ type: 'unhide', filterId: f.filter.id }),
  });
  const hidden = filters.filter((f) => !f.filter.noExpand);
  const stops = filters.filter((f) => f.filter.noExpand);
  const items: MenuItem[] = [];
  if (!filters.length) items.push({ label: 'No filters', hint: emptyHint, disabled: true });
  if (hidden.length) items.push({ id: 'filters:hidden', label: 'Hidden', disabled: true }, ...hidden.map(row));
  if (stops.length) {
    items.push(
      { id: 'filters:no-expand', label: 'Not expanded', title: 'Shown, but Overview and Expand all (✦ ▾) leave them folded (⊡); a click still expands one', disabled: true },
      ...stops.map(row),
    );
  }
  items.push({ separator: true, label: '' });
  items.push({ id: 'unhide-all', label: 'Remove all filters', disabled: !filters.length, action: () => post({ type: 'unhideAll' }) });
  return items;
}

/** FR-11.7 the "don't expand" twin of a hide rule. */
export function noExpand(spec: HideFilterSpec): HideFilterSpec {
  return { ...spec, noExpand: true };
}

/** FR-11.7 the "don't expand" rule a call / class is under, from the diagram's filters. */
export function noExpandRule(filters: HiddenFilterInfo[], id: string | undefined): HideFilter | undefined {
  return id ? filters.find((f) => f.filter.id === id)?.filter : undefined;
}
