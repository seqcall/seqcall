import type { Finding } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { issuesMenu } from '../src/issues-ui';

const rows = (items: ReturnType<typeof issuesMenu>) => items.map((i) => (i.separator ? '---' : `${i.label}${i.hint ? ` [${i.hint}]` : ''}${i.disabled ? ' (off)' : ''}`));
const violation = (detail?: string): Finding => ({ id: 'v', kind: 'layer-violation', title: 'Layer violation: Order → Db', ...(detail === undefined ? {} : { detail }), classKeys: ['a', 'b'] });

describe('⚠ N issues menu (FR-19.17)', () => {
  it('FR-19.17 a violation without a detail has no hint; with one, the part before the colon', () => {
    expect(rows(issuesMenu([violation()], () => {}))).toEqual(['⚠ 1 layer violation (off)', 'Order → Db']);
    expect(rows(issuesMenu([violation('Domain → Infrastructure: inner depends on outer')], () => {}))[1]).toBe('Order → Db [Domain → Infrastructure]');
  });

  it('FR-19.17 one issue inside folded calls, and no way to expand them here (class diagram): named, not clickable', () => {
    const items = issuesMenu([], () => {}, 0, { issues: { count: 1, titles: ['I/O in a loop: Order.save'] } });
    expect(rows(items)).toEqual(['+ 1 more inside folded calls — Expand all shows it (off)']);
    expect(items[0].title).toBe('I/O in a loop: Order.save');
    expect(items[0].action).toBeUndefined();
  });

  it('FR-19.17 the sequence diagram expands them from the row', () => {
    let expanded = 0;
    const items = issuesMenu([], () => {}, 0, { issues: { count: 2, titles: ['a', 'b'] }, expand: () => expanded++ });
    expect(rows(items)).toEqual(['+ 2 more inside folded calls — Expand all shows them']);
    items[0].action!();
    expect(expanded).toBe(1);
  });

  it('FR-19.22 what the config ignores is listed after the issues, one row per pattern; picking one stops ignoring it', () => {
    const stopped: string[] = [];
    const ignored = { patterns: { findings: ['Repo.find'], layerHints: ['src/util/**'] }, stop: (section: string, pattern: string) => stopped.push(`${section}:${pattern}`) };
    const items = issuesMenu([violation()], () => {}, 0, undefined, ignored);
    expect(rows(items)).toEqual([
      '⚠ 1 layer violation (off)',
      'Order → Db',
      '---',
      '2 ignored in .seqcall.json — click to stop ignoring (off)',
      '↺ Repo.find [finding]',
      '↺ src/util/** [⚑ layer hint]',
    ]);
    expect(items[4].title).toBe('Stop ignoring Repo.find: remove it from findings.ignore in .seqcall.json');
    items[4].action!();
    items[5].action!();
    expect(stopped).toEqual(['findings:Repo.find', 'layerHints:src/util/**']);
    // nothing ignored (or an older host): no section
    expect(rows(issuesMenu([violation()], () => {}, 0, undefined, { patterns: undefined, stop: () => {} }))).toEqual(['⚠ 1 layer violation (off)', 'Order → Db']);
    expect(rows(issuesMenu([], () => {}, 0, undefined, { patterns: { layerHints: ['a/**'] }, stop: () => {} }))).toEqual([
      'No design issues or layer violations in the shown calls [expand calls to look deeper] (off)',
      '---',
      '1 ignored in .seqcall.json — click to stop ignoring (off)',
      '↺ a/** [⚑ layer hint]',
    ]);
  });
});
