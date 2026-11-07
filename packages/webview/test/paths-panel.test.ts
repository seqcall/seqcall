// @vitest-environment jsdom
import type { CallPathNode, EntryPoint, MethodRef } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { initialOpen, methodTitle, pathsMarkdown, pathsPanel, pathsSummary, stepsOf, type PathsActions, type PathsState } from '../src/sequence/paths-panel';

const m = (cls: string, name: string, kind: 'class' | 'module' = 'class'): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind }, isStatic: false, hasBody: true }) as MethodRef;
const at = (line: number, extra = {}) => ({ range: { file: 'src/x.ts', start: { line, character: 0 }, end: { line, character: 5 } }, preview: 'x()', ...extra });
const node = (cls: string, extra: Partial<CallPathNode> = {}): CallPathNode => ({ method: m(cls, 'run'), call: at(1), ...extra });
const test = (name: string): CallPathNode => ({ method: m('ShopTests', name), call: at(2), inTest: true, end: 'test' });

function panel(s: Partial<PathsState>, copyOk = true) {
  const calls: string[] = [];
  const actions: PathsActions = {
    open: (steps, e) => calls.push(`open ${steps.map((x) => x.methodKey.replace(/^.*#/, '')).join(' > ')}${e ? ` (${e.label})` : ''}`),
    cancel: () => calls.push('cancel'),
    changed: () => calls.push('changed'),
    copy: async () => copyOk,
  };
  const state: PathsState = { messageId: 'root', title: 'Repo.find', state: 'done', ...s };
  const el = pathsPanel(state, actions);
  document.body.replaceChildren(el);
  const rows = () => [...el.querySelectorAll('.paths-item')].map((r) => r.textContent);
  return { el, calls, state, rows };
}

describe('FR-22 paths to here: words and steps', () => {
  it('FR-22.2 a module function and a class without a name are named by the method', () => {
    expect(methodTitle({ method: m('util', 'pad', 'module') })).toBe('pad');
    expect(methodTitle({ method: { ...m('X', 'run'), owner: { key: 'k', name: '', kind: 'class' } } })).toBe('run');
  });

  it('FR-4.5 a step through a method passed as an argument keeps "passed"', () => {
    expect(stepsOf([node('A', { call: at(3, { passed: true }) })])).toEqual([{ methodKey: 'src/A.ts#A.run', call: { range: at(3).range, passed: true } }]);
  });

  it('FR-22.2 the summary counts top-level callers and paths cut by the limit', () => {
    const tree = node('Repo', { call: undefined, callers: [node('A', { end: 'top' }), node('B', { end: 'limit' }), node('C', { end: 'limit' })] });
    expect(pathsSummary(tree)).toBe('Reached from 1 top-level caller (no entry point) · 2 paths cut by the limit');
    // a caller without a reason why the walk stopped (an older host) is not counted
    expect(pathsSummary(node('Repo', { call: undefined, callers: [node('A')] }))).toBe('Nothing in the project calls it');
  });
});

describe('FR-22.2 rows open at first', () => {
  it('FR-22.2 no path to an entry point and a small tree: all of it open, except paths that end only in tests', () => {
    const tree = node('Repo', { call: undefined, callers: [node('A', { callers: [node('B', { callers: [node('C', { end: 'top' })] })] }), node('T', { callers: [test('t1')] })] });
    expect([...initialOpen(tree)].sort()).toEqual(['', '0', '0/0']);
  });

  it('FR-22.2 with a path to an entry point only that path is open', () => {
    const route: EntryPoint = { kind: 'http', verb: 'GET', label: 'GET /a', method: m('Ctl', 'get') };
    const tree = node('Repo', { call: undefined, callers: [node('A', { callers: [node('Ctl', { entryPoints: [route], end: 'entry' })] }), node('B', { callers: [node('C', { end: 'top' })] })] });
    expect([...initialOpen(tree)].sort()).toEqual(['', '0']);
  });

  it('FR-22.2 a big tree without entry points: only the first two levels', () => {
    const deep = (d: number): CallPathNode => node(`D${d}`, d < 3 ? { callers: Array.from({ length: 4 }, () => deep(d + 1)) } : { end: 'top' });
    const tree = node('Repo', { call: undefined, callers: [deep(0), deep(0), deep(0), deep(0)] }); // > 60 nodes
    const open = initialOpen(tree);
    expect([...open]).toEqual(['', '0', '1', '2', '3']); // the target and its callers open: two levels of rows
  });
});

describe('FR-22.4 Copy as Markdown, unusual paths', () => {
  it('FR-22.4 starts: a route without a verb, a job, nothing calls it, cut by the limit; one test; truncated', () => {
    const anyVerb: EntryPoint = { kind: 'http', label: '/hook', method: m('Hook', 'run') };
    const job: EntryPoint = { kind: 'job', label: 'Nightly.run', method: m('Nightly', 'run') };
    const tree = node('Repo', { call: undefined, callers: [node('Hook', { entryPoints: [anyVerb], end: 'entry' }), node('Nightly', { entryPoints: [job], end: 'entry' }), node('Top', { end: 'top' }), node('Cut', { end: 'limit' }), test('one')] });
    const md = pathsMarkdown({ messageId: 'r', title: 'Repo.find', state: 'done', tree, truncated: true }).split('\n');
    expect(md.slice(2)).toEqual([
      '- `/hook` Hook.run → Repo.run',
      '- `JOB Nightly.run` Nightly.run → Repo.run',
      '- Top.run → Repo.run _(nothing calls it)_',
      '- Cut.run → Repo.run _(cut by the limit)_',
      '- 1 test in `ShopTests` → Repo.run',
      '',
      '_Some paths were cut by the walk limits._',
    ]);
  });

  it('FR-22.4 nothing calls the method', () => {
    expect(pathsMarkdown({ messageId: 'r', title: 'Repo.find', state: 'done', tree: node('Repo', { call: undefined }) }).split('\n').at(-1)).toBe('_No callers in the project._');
  });
});

describe('FR-22.2 the panel, unusual states', () => {
  it('FR-22.2 a failed walk, with and without a message; a cancelled one', () => {
    expect(panel({ state: 'error' }).el.querySelector('.ep-status')!.textContent).toBe('The search failed.');
    expect(panel({ state: 'error', error: 'timeout' }).el.querySelector('.ep-status')!.textContent).toBe('timeout');
    expect([...panel({ state: 'cancelled' }).el.querySelectorAll('.ep-status')].map((e) => e.textContent)).toEqual(['Search cancelled.']);
  });

  it('FR-22.2 running before any method was walked', () => {
    expect(panel({ state: 'running' }).el.querySelector('.ep-status')!.textContent).toBe('Walking the callers up to the entry points… 0 methodsCancel');
  });

  it('FR-22.2 nothing calls it: the summary only; the walk was cut: said in the summary', () => {
    const p = panel({ tree: node('Repo', { call: undefined }), truncated: true });
    expect(p.el.querySelector('.paths-summary')!.textContent).toBe('Nothing in the project calls it (some paths cut by the limits)');
    expect(p.el.querySelector('.paths-list')).toBeNull();
  });

  it('FR-22.4 Copy as Markdown says whether the copy worked', async () => {
    for (const [ok, text] of [[false, 'Copy failed'], [true, 'Copied ✓']] as const) {
      const p = panel({ tree: node('Repo', { call: undefined }) }, ok);
      const b = p.el.querySelector('.paths-copy') as HTMLElement;
      b.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(b.textContent).toBe(text);
    }
  });

  it('FR-22.2 row tags: a route without a verb, a job, "passed", "…" where the walk stopped', () => {
    const anyVerb: EntryPoint = { kind: 'http', label: '/hook', method: m('Hook', 'run') };
    const job: EntryPoint = { kind: 'job', label: 'Nightly.run', method: m('Nightly', 'run') };
    const tree = node('Repo', { call: undefined, callers: [node('Hook', { entryPoints: [anyVerb], end: 'entry' }), node('Nightly', { entryPoints: [job], end: 'entry', call: at(4, { passed: true }) }), node('Cut', { end: 'limit' })] });
    expect(panel({ tree }).rows()).toEqual(['▾Repo.run', '/hookHook.runx.ts:2', 'JOB Nightly.runNightly.runpassedx.ts:5', 'Cut.run…x.ts:2']);
  });

  it('FR-22.2 ▸ opens a closed row, ▾ closes it; the toggle of a leaf does nothing (the row opens its path)', () => {
    const tree = node('Repo', { call: undefined, callers: [node('A', { callers: [node('B', { end: 'top' })] })] });
    const s: Partial<PathsState> = { tree, open: new Set(['']) };
    const p = panel(s);
    (p.el.querySelector('[data-path-id="0"] .paths-toggle') as HTMLElement).click();
    expect([...p.state.open!]).toEqual(['', '0']);
    const again = panel({ tree, open: p.state.open });
    (again.el.querySelector('[data-path-id="0"] .paths-toggle') as HTMLElement).click();
    expect([...again.state.open!]).toEqual(['']);
    const leaf = panel({ tree, open: new Set(['', '0']) });
    (leaf.el.querySelector('[data-path-id="0/0"] .paths-toggle') as HTMLElement).click();
    expect(leaf.calls).toEqual(['open B.run > A.run > Repo.run']);
  });

  it('FR-22.2 one test calling it directly: "1 test"; the open group closes again', () => {
    const tree = node('Repo', { call: undefined, callers: [test('one')] });
    const p = panel({ tree, open: new Set(['', '/tests']) });
    expect(p.rows()).toEqual(['▾Repo.run', '▾1 test', 'ShopTests.onetestx.ts:3']);
    (p.el.querySelector('.paths-tests') as HTMLElement).click();
    expect(p.state.open!.has('/tests')).toBe(false);
    expect(p.calls).toEqual(['changed']);
  });

  it('FR-22.2 more than 400 rows: the rest is not drawn, and the list says so', () => {
    const tree = node('Repo', { call: undefined, callers: Array.from({ length: 450 }, (_, i) => node(`C${i}`, { end: 'top' })) });
    const p = panel({ tree });
    expect(p.rows()).toHaveLength(400);
    expect(p.el.querySelector('.ep-more')!.textContent).toBe('More rows not shown — close some paths');
  });
});
