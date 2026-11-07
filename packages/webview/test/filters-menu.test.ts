import type { HiddenFilterInfo } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { filtersMenu } from '../src/filters-menu';

const hide: HiddenFilterInfo = { filter: { id: 'h1', kind: 'methodName', methodName: 'log' }, hiddenCount: 3 };
const stop = (count: number): HiddenFilterInfo => ({ filter: { id: 's1', kind: 'class', classKey: 'k', className: 'Mailer', noExpand: true }, hiddenCount: count });
const rows = (items: ReturnType<typeof filtersMenu>) => items.map((i) => (i.separator ? '---' : `${i.label}${i.hint ? ` [${i.hint}]` : ''}${i.disabled ? ' (off)' : ''}`));

describe('Filters ▾ dropdown', () => {
  it('FR-11.3 without filters: one disabled row with the hint, Remove all disabled', () => {
    expect(rows(filtersMenu([], () => {}, 'Hide calls from the message menu'))).toEqual([
      'No filters [Hide calls from the message menu] (off)',
      '---',
      'Remove all filters (off)',
    ]);
  });

  it('FR-11.7 only "don\'t expand" rules: no Hidden section, counts calls in singular and plural', () => {
    expect(rows(filtersMenu([stop(2)], () => {}))).toEqual(['Not expanded (off)', 'Class Mailer [2 calls · remove]', '---', 'Remove all filters']);
    expect(rows(filtersMenu([stop(1)], () => {}))[1]).toBe('Class Mailer [1 call · remove]');
  });

  it('FR-11.3 hide rules first, then the "don\'t expand" rules; a row removes its rule', () => {
    const posted: unknown[] = [];
    const items = filtersMenu([stop(2), hide], (m) => posted.push(m));
    expect(rows(items)).toEqual(['Hidden (off)', 'All calls to log [3 hidden · unhide]', 'Not expanded (off)', 'Class Mailer [2 calls · remove]', '---', 'Remove all filters']);
    items[1].action!();
    items[items.length - 1].action!();
    expect(posted).toEqual([{ type: 'unhide', filterId: 'h1' }, { type: 'unhideAll' }]);
  });
});
