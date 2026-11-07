// @vitest-environment jsdom
import type { EntryPoint, MethodRef, ReviewIssue, ReviewMethod, ReviewResult } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { reviewMarkdown, reviewPanel, type ReviewActions, type ReviewState } from '../src/sequence/review-panel';

const ref = (cls: string, name: string, kind: 'class' | 'module' = 'class'): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind }, isStatic: false, hasBody: true }) as MethodRef;
const job: EntryPoint = { kind: 'job', label: 'Nightly.run', method: ref('Nightly', 'run') };
const job2: EntryPoint = { kind: 'job', label: 'Hourly.run', method: ref('Hourly', 'run') };
const method = (m: MethodRef, extra: Partial<ReviewMethod> = {}): ReviewMethod => ({ method: m, status: 'changed', lines: [3], reachedFrom: [], tests: 0, ...extra });
const issue = (extra: Partial<ReviewIssue> = {}): ReviewIssue => ({ finding: { id: 'f', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find' }, where: 'changed-class', ...extra });
const file = (f: string, test = false) => ({ file: f, path: `/p/${f}`, status: 'modified' as const, added: 1, removed: 0, ...(test ? { test: true } : {}) });
const base = (extra: Partial<ReviewResult> = {}): ReviewResult => ({ base: 'develop', resolvedBase: 'develop', files: [file('src/a.ts')], methods: [], issues: [], scanned: 0, notScanned: 0, otherLines: 0, ...extra }) as ReviewResult;

function panel(s: Partial<ReviewState>, copyOk = true) {
  const calls: string[] = [];
  const actions: ReviewActions = {
    run: (b, f, m) => calls.push(`run ${b} ${f} ${m}`), cancel: () => calls.push('cancel'), end: () => calls.push('end'),
    openIssue: (i) => calls.push(`issue ${i.finding.id}`), openStructure: (r) => calls.push(`structure ${r.title}`),
    openPath: (steps, e) => calls.push(`path ${steps.map((x) => x.methodKey).join('>')}${e ? ` ${e.label}` : ''}`),
    copy: async () => copyOk,
  };
  const el = pathsLess(reviewPanel({ state: 'done', base: 'develop', ...s }, actions));
  return { el, calls, text: (sel: string) => [...el.querySelectorAll(sel)].map((x) => x.textContent) };
}
const pathsLess = (el: HTMLElement) => (document.body.replaceChildren(el), el);

describe('FR-24 the review panel, unusual states', () => {
  it('FR-24.3 a failed review, with and without a message; a cancelled one', () => {
    expect(panel({ state: 'error' }).text('.ep-status')).toEqual(['The review failed.']);
    expect(panel({ state: 'error', error: 'no git' }).text('.ep-status')).toEqual(['no git']);
    expect(panel({ state: 'cancelled' }).text('.ep-status')).toEqual(['Review cancelled.']);
  });

  it('FR-24.3 running before the host names its step or knows the count: no bar', () => {
    const p = panel({ state: 'running' });
    expect(p.text('.ep-status')).toEqual(['Reviewing…Cancel']);
    expect(p.el.querySelector('.di-bar')).toBeNull();
    const q = panel({ state: 'running', total: 4 });
    expect(q.text('.ep-status')).toEqual(['Reviewing… 0 / 4Cancel']);
    expect((q.el.querySelector('.di-bar-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('FR-24.13 no changes and no compare info (an older host): just that', () => {
    const p = panel({ result: base({ files: [] }) });
    expect(p.text('.ep-status')).toEqual(['No changes in this project against develop.']);
    expect(p.el.querySelector('.rv-compared')).toBeNull();
    expect(p.text('.ep-project')).toEqual([' · this branch vs develop']);
  });

  it('FR-24.3 the summary in plural and singular; a module function; nothing reached', () => {
    const r = base({
      files: [file('src/a.ts'), file('test/a.test.ts', true)],
      methods: [method(ref('util', 'pad', 'module'), { tests: 1 })],
      issues: [issue({ where: 'changed-lines' }), issue({ where: 'changed-lines' })],
    });
    const p = panel({ result: r });
    expect(p.text('.rv-summary')).toEqual(['1 method changed in 2 files · 0 entry points affected · ⚠ 2 issues on changed lines · 1 test file changed']);
    expect(p.text('.ep-group')).toEqual(['Issues 2', 'Changed, no static caller from an entry point 1 — called dynamically (container, untyped factory), by the framework, or not yet']);
    expect(p.text('.rv-item').slice(2, 3)).toEqual(['▲padchanged · called by 1 test']);
  });

  it('FR-24.3 two test files, two entry points; a method added on one line, called by tests, reached by both', () => {
    const m = method(ref('Order', 'total'), { status: 'added', lines: [5], tests: 2, reachedFrom: [{ entryPoint: job, steps: [] }, { entryPoint: job2, steps: [] }] });
    const p = panel({ result: base({ files: [file('t/a.test.ts', true), file('t/b.test.ts', true)], methods: [m, method(ref('Order', 'tax'), { tests: 2, truncated: true })] }) });
    expect(p.text('.rv-summary')[0]).toBe('2 methods changed in 2 files · 2 entry points affected · no issues on changed lines · 2 test files changed');
    expect(p.text('.rv-method')).toEqual(['✚Order.totaladded · 1 line · called by 2 tests', '✚Order.totaladded · 1 line · called by 2 tests']);
    expect(p.text('.rv-item').at(-1)).toBe('▲Order.taxchanged · called by 2 tests · callers not all walked');
  });

  it('FR-24.3 issues: from a changed method (no entry point), or from nowhere known, in a changed class', () => {
    const p = panel({ result: base({ issues: [issue({ methodKey: 'src/Order.ts#Order.total' }), issue({ finding: { id: 'g', kind: 'god-class', title: 'God class: Order' } })] }) });
    expect(p.text('.di-item .rv-sub')).toEqual(['in a changed class · ← Order.total', 'in a changed class']);
  });

  it('FR-29 structure: one entry point not compared; a row with its detail', () => {
    const p = panel({ result: base({ structure: { rows: [{ kind: 'edge-added', title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer' }], notCompared: 1 } as never }) });
    expect(p.text('.ep-group')[0]).toBe('Structure 1 — 1 affected entry point not compared (limit)');
    expect(p.text('.rv-struct .rv-sub')).toEqual(['new dependency between layers · Order → Db']);
  });

  it('FR-29 structure: entry points not compared (plural); a row without detail; a reached method on two lines with one test', () => {
    const m = method(ref('Order', 'total'), { lines: [3, 4], tests: 1, reachedFrom: [{ entryPoint: job, steps: [] }] });
    const r = base({ methods: [m], structure: { rows: [{ kind: 'edge-removed', title: 'Domain → Db', level: 'layer' }], notCompared: 2 } as never });
    const p = panel({ result: r });
    expect(p.text('.ep-group')[0]).toBe('Structure 1 — 2 affected entry points not compared (limit)');
    expect(p.text('.rv-struct .rv-sub')).toEqual(['dependency between layers removed']);
    expect(p.text('.rv-method')).toEqual(['▲Order.totalchanged · 2 lines · called by 1 test']);
    expect(p.text('.ep-group')).toEqual(['Structure 1 — 2 affected entry points not compared (limit)', 'Entry points affected 1']); // every method reached
    expect(p.text('.rv-legend')[0]).not.toContain('not scanned');
    expect(reviewMarkdown(r).split('\n')).toContain('- − Domain → Db — dependency between layers removed');
  });

  it('FR-24.3 one issue: singular; a route that takes any verb is named by its tag', () => {
    const any: EntryPoint = { kind: 'http', label: '/hook', method: ref('Hook', 'run') };
    const r = base({ issues: [issue({ where: 'changed-lines', entryPoint: any })] });
    const p = panel({ result: r });
    expect(p.text('.rv-summary')[0]).toBe('0 methods changed in 1 file · 0 entry points affected · ⚠ 1 issue on changed lines · no test file changed');
    expect(p.text('.di-item .rv-sub')).toEqual(['in a changed class · ← /hook']);
    expect(reviewMarkdown(r).split('\n')).toContain('- ⚠ I/O in a loop: Repo.find — in a changed class (← `/hook`)');
  });

  it('FR-24.3 entry points not all scanned for issues are noted', () => {
    expect(panel({ result: base({ notScanned: 3 }) }).text('.rv-legend')[0]).toContain('3 more affected entry points were not scanned for issues (limit).');
  });

  it('FR-24.4 Copy as Markdown says whether the copy worked', async () => {
    for (const [ok, text] of [[true, 'Copied ✓'], [false, 'Copy failed']] as const) {
      const p = panel({ result: base() }, ok);
      const b = p.el.querySelector('.paths-copy') as HTMLElement;
      b.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(b.textContent).toBe(text);
    }
  });
});

describe('FR-24.4 the review as Markdown, unusual results', () => {
  it('FR-24.4 no branch name, one method in two files, nothing else to say', () => {
    const md = reviewMarkdown(base({ files: [file('a'), file('b')], methods: [method(ref('Order', 'total'), { tests: 1, reachedFrom: [{ entryPoint: job, steps: [] }] })] }));
    expect(md.split('\n')).toEqual([
      '**Seqcall review** — `branch` vs `develop`: 1 method changed in 2 files',
      '',
      'No design issues on changed lines.',
      '',
      '**Entry points affected**',
      '- `JOB Nightly.run` — Order.total',
      '',
      '**No test file changed.**',
    ]);
  });

  it('FR-24.4 an issue without an entry point, tests changed; structure detail and entry, not compared', () => {
    const md = reviewMarkdown(base({
      branch: 'feat/x',
      methods: [method(ref('A', 'b')), method(ref('A', 'c'))],
      files: [file('t/a.test.ts', true)],
      issues: [issue({ at: { file: 'src/x/order.ts', line: 7 } })],
      structure: { rows: [{ kind: 'edge-added', title: 'Domain → Db', detail: 'Order → Db', level: 'package', entryPoint: job }], notCompared: 2 } as never,
    })).split('\n');
    expect(md[0]).toBe('**Seqcall review** — `feat/x` vs `develop`: 2 methods changed in 1 file');
    expect(md).toContain('- ✚ Domain → Db — new dependency between packages: Order → Db (← `JOB Nightly.run`)');
    expect(md).toContain('- 2 affected entry points not compared (limit)');
    expect(md).toContain('- ⚠ I/O in a loop: Repo.find — order.ts:7');
    expect(md).toContain('**Tests changed:** `t/a.test.ts`');
    expect(md).not.toContain('**Entry points affected**'); // none reached
  });
});
