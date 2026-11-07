// @vitest-environment jsdom
import type { GitRefs, ReviewResult } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { ago, choices, compareRow, compareSummary, type CompareMode } from '../src/sequence/review-picker';

const NOW = Date.UTC(2026, 9, 19);
const MIN = 60_000;

describe('FR-24.13 Compare with: the list', () => {
  it('FR-24.13 ages: minutes, hours, days, weeks, months', () => {
    expect([ago(NOW - 5 * MIN, NOW), ago(NOW - 3 * 60 * MIN, NOW), ago(NOW - 2 * 1440 * MIN, NOW), ago(NOW - 21 * 1440 * MIN, NOW), ago(NOW - 120 * 1440 * MIN, NOW)]).toEqual(['5m', '3h', '2d', '3w', '4mo']);
    expect(ago(NOW + 10 * MIN, NOW)).toBe('0m'); // a clock ahead: not negative
  });

  it('FR-24.13 without branch data only the quick choices; commits of a detached HEAD are "on this branch"', () => {
    expect(choices(undefined).map((c) => c.label)).toEqual(['Since the previous commit', 'Uncommitted changes only']);
    const refs: GitRefs = { branches: [], tags: [], commits: [{ hash: 'abc1234', date: NOW, author: 'Ann', subject: 'Fix total' }] };
    expect(choices(refs).at(-1)!.section).toBe('Commits on this branch');
  });
});

describe('FR-24.13 Compare with: the picker', () => {
  const refs: GitRefs = {
    current: 'feat/x', target: 'develop', upstream: 'origin/feat/x',
    branches: Array.from({ length: 14 }, (_, i) => ({ name: `b${i}`, remote: i === 0, date: NOW, hash: `h${i}`, subject: `s${i}` })),
    tags: [], commits: [],
  };
  function setup(s: { refs?: GitRefs; refsError?: string } = { refs }) {
    const runs: [string, CompareMode, boolean | undefined][] = [];
    const el = compareRow({ base: 'develop', mode: 'split', ...s }, false, false, (b, m, f) => runs.push([b, m, f]));
    document.body.replaceChildren(el);
    const open = () => (el.querySelector('[data-cmd="pick-base"]') as HTMLElement).click();
    const input = () => el.querySelector('.rv-filter') as HTMLInputElement;
    const key = (k: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const type = (q: string) => {
      input().value = q;
      input().dispatchEvent(new Event('input'));
    };
    const statuses = () => [...el.querySelectorAll('.fc-status')].map((x) => x.textContent);
    const active = () => el.querySelector('.rv-choice.active .fc-label')?.textContent;
    return { el, runs, open, key, type, statuses, active, picker: () => el.querySelector('.rv-picker') as HTMLElement };
  }

  it('FR-24.13 the button opens the list (filter focused) and closes it again', () => {
    const s = setup();
    s.open();
    expect(s.picker().hidden).toBe(false);
    expect(document.activeElement).toBe(s.el.querySelector('.rv-filter'));
    s.open();
    expect(s.picker().hidden).toBe(true);
  });

  it('FR-24.13 the mode: another mode is another review, run at once', () => {
    const s = setup();
    (s.el.querySelector('input[value="direct"]') as HTMLInputElement).click();
    (s.el.querySelector('.rv-btn.primary') as HTMLElement).click();
    expect(s.runs).toEqual([['develop', 'direct', undefined], ['develop', 'direct', false]]);
  });

  it('FR-24.13 more than 12 branches: the rest is counted', () => {
    const s = setup();
    s.open();
    expect(s.statuses()).toEqual(['+2 more — type to narrow']);
  });

  it('FR-24.13 ↓ ↑ move (wrapping), Enter runs the active choice with its mode', () => {
    const s = setup();
    s.open();
    expect(s.active()).toBe('Pull request into develop');
    s.key('ArrowUp');
    expect(s.active()).toBe('b11'); // the last row shown
    s.key('ArrowDown');
    s.key('ArrowDown');
    expect(s.active()).toBe('Not pushed yet');
    expect(s.key('a')).toBe(true); // typing is not taken
    s.key('Enter');
    expect(s.runs).toEqual([['origin/feat/x', 'split', undefined]]);
    expect(s.picker().hidden).toBe(true);
  });

  it('FR-24.13 Enter on text that matches nothing compares with the text itself', () => {
    const s = setup();
    s.open();
    s.type('v2.1.0');
    expect(s.statuses()).toEqual(['Enter: compare with "v2.1.0" (a branch, tag, hash or HEAD~n)']);
    s.key('ArrowDown'); // no rows: nothing to move
    s.key('Enter');
    expect(s.runs).toEqual([['v2.1.0', 'split', undefined]]);
  });

  it('FR-24.13 git not readable, or still reading: said above the quick choices', () => {
    const e = setup({ refsError: 'not a git repository' });
    e.open();
    expect(e.statuses()).toEqual(['not a git repository']);
    const r = setup({});
    r.open();
    expect(r.statuses()).toEqual(['Reading branches…']);
  });
});

describe('FR-24.13 what was compared, in one line', () => {
  const base: ReviewResult = { base: 'develop', resolvedBase: 'develop', files: [], methods: [], issues: [], scanned: 0 } as unknown as ReviewResult;

  it('FR-24.13 no compare info (an older host): no line', () => {
    expect(compareSummary(base, 0)).toBeUndefined();
  });

  it('FR-24.13 since the split: the merge base and the commits of the branch', () => {
    const r = { ...base, branch: 'feat/x', compare: { mode: 'split' as const, point: '5a4ddc7', commits: 1, behind: 4, outside: [] } };
    expect(compareSummary(r, 3)).toBe('feat/x ↔ merge base 5a4ddc7 of develop · 1 commit · 3 files in this project');
    expect(compareSummary({ ...r, compare: { ...r.compare, commits: 2 } }, 3)).toBe('feat/x ↔ merge base 5a4ddc7 of develop · 2 commits · 3 files in this project');
  });

  it('FR-24.13 tip against tip on a detached HEAD, one commit each way, one file, files outside listed with …', () => {
    const r = { ...base, compare: { mode: 'direct' as const, point: '5a4ddc7', commits: 1, behind: 1, outside: ['.platform/a', '.platform/b', 'docs/c'] } };
    expect(compareSummary(r, 1)).toBe('HEAD ↔ develop (5a4ddc7) · 1 commit only here, 1 only in develop · 1 file in this project (3 outside: .platform/a, .platform/b, …)');
    expect(compareSummary({ ...r, branch: 'feat/x', compare: { ...r.compare, commits: 2, outside: ['x'] } }, 2)).toBe('feat/x ↔ develop (5a4ddc7) · 2 commits only here, 1 only in develop · 2 files in this project (1 outside: x)');
  });
});
