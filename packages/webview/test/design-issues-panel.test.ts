// @vitest-environment jsdom
import type { ProjectFinding } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { designIssuesMarkdown, designIssuesPanel, type DesignIssuesState } from '../src/sequence/design-issues';

const noop = { open: () => {}, cancel: () => {}, rescan: () => {} };
const statuses = (p: HTMLElement) => [...p.querySelectorAll('.ep-status')].map((s) => s.textContent);
const job: ProjectFinding = { finding: { id: 'f', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)' }, entryPoint: { kind: 'job', label: 'SyncJob.handle' } as never, files: ['src/Repo.ts'] };

describe('FR-19.9 the Design issues panel, unusual states', () => {
  it('FR-19.9 a failed scan without a message says it failed', () => {
    expect(statuses(designIssuesPanel({ state: 'error' }, noop))).toEqual(['The scan failed.']);
  });

  it('FR-19.9 running before the entry points are counted: no numbers, no bar; then 0 of n done', () => {
    const early = designIssuesPanel({ state: 'running' }, noop);
    expect(statuses(early)).toEqual(['Scanning flows… (entry points, then the methods no flow opened; each flow is expanded fully)Cancel']);
    expect(early.querySelector('.di-bar')).toBeNull();
    const counted = designIssuesPanel({ state: 'running', total: 8 }, noop);
    expect(statuses(counted)[0]).toBe('Scanning flows… 0 / 8 (entry points, then the methods no flow opened; each flow is expanded fully)Cancel');
    expect((counted.querySelector('.di-bar-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('FR-19.9 done without findings and without a count: "the entry points"; one entry point is singular', () => {
    expect(statuses(designIssuesPanel({ state: 'done' }, noop))).toEqual(['No design issues found in the entry points.']);
    expect(statuses(designIssuesPanel({ state: 'done', total: 1, findings: [] }, noop))).toEqual(['No design issues found in 1 entry point.']);
  });

  it('FR-19.9 findings without a count of entry points: "?"; an entry point without a verb is named as it is', () => {
    const p = designIssuesPanel({ state: 'done', findings: [job] }, noop);
    expect(statuses(p)).toEqual(['1 finding in ? entry points']);
    expect(p.querySelector('.di-from')!.textContent).toBe('← SyncJob.handle');
    expect((p.querySelector('.di-item') as HTMLElement).title).toBe('');
  });

  it('FR-19.23 the methods no entry point reaches: in the scope line (and those the limit left out), and named on their rows', () => {
    expect(statuses(designIssuesPanel({ state: 'done', total: 2, findings: [], unreached: { scanned: 1, skipped: 0 } }, noop))).toEqual(['No design issues found in 2 entry points and 1 method no flow opened.']);
    const lost: ProjectFinding = { ...job, entryPoint: { kind: 'handler', label: 'AuditEntry.persist', unreached: true } as never };
    const p = designIssuesPanel({ state: 'done', total: 1, findings: [lost], unreached: { scanned: 30, skipped: 4 } }, noop);
    expect(statuses(p)).toEqual(['1 finding in 1 entry point and 30 methods no flow opened (4 more not checked: the limit)']);
    expect(p.querySelector('.di-from')!.textContent).toBe('← AuditEntry.persist (no entry point reaches it)');
    expect(designIssuesMarkdown({ state: 'done', total: 1, unreached: { scanned: 30, skipped: 0 } }, [lost]).split('\n')[0]).toBe('**Design issues** — 1 finding in 1 entry point and 30 methods no flow opened');
  });

  it('FR-19.9 a scan the code changed during says so: with and without findings, and in the Markdown', () => {
    const note = 'The code changed while this ran: the list may mix old and new code. ↻ checks again.';
    expect(statuses(designIssuesPanel({ state: 'done', total: 2, findings: [], changed: true }, noop))).toEqual(['No design issues found in 2 entry points.', note]);
    expect(statuses(designIssuesPanel({ state: 'done', total: 2, findings: [job], changed: true }, noop))).toEqual(['1 finding in 2 entry points', note]);
    expect(designIssuesMarkdown({ state: 'done', total: 2, changed: true }, [job]).split('\n').slice(-1)[0]).toBe(`- I/O in a loop: Repo.find (DB) — from \`SyncJob.handle\``);
    expect(designIssuesMarkdown({ state: 'done', total: 2, changed: true }, [job])).toContain(`_${note}_`);
  });

  it('FR-19.23 while the methods none reaches are looked for: the entry points\' findings already, no bar; a row opens', () => {
    const opened: ProjectFinding[] = [];
    const p = designIssuesPanel({ state: 'running', total: 8, done: 8, walking: true, findings: [job] }, { ...noop, open: (f) => opened.push(f) });
    expect(statuses(p)).toEqual(['Looking for the methods no entry point reaches… (the unreachable-code check, kept for ∅ and the next scan)Cancel', '1 finding in the entry points so far']);
    expect(p.querySelector('.di-bar')).toBeNull();
    (p.querySelector('.di-item') as HTMLElement).click();
    expect(opened).toEqual([job]);
    // two findings: plural; scanning the methods none reaches after the walk: the bar again
    const later = designIssuesPanel({ state: 'running', total: 12, done: 9, findings: [job, job] }, noop);
    expect(statuses(later)[1]).toBe('2 findings in the entry points so far');
    expect(later.querySelector('.di-bar')).not.toBeNull();
  });

  it('FR-19.23 a row names the group of the unreachable-code list; a list older than the code says so (panel and Markdown)', () => {
    const tested: ProjectFinding = { ...job, entryPoint: { kind: 'handler', label: 'Seeder.run', unreached: true, unreachedWhy: 'no entry point reaches it: only tests call it' } as never };
    const s: DesignIssuesState = { state: 'done', total: 1, findings: [tested], unreached: { scanned: 3, skipped: 0, stale: true } };
    const p = designIssuesPanel(s, noop);
    expect(p.querySelector('.di-from')!.textContent).toBe('← Seeder.run (no entry point reaches it: only tests call it)');
    const note = 'The methods no entry point reaches are from a check before the last change: a method added, newly called or no longer called shows after ↻.';
    expect(statuses(p)).toContain(note);
    expect(designIssuesMarkdown(s, [tested])).toContain(`_${note}_`);
    expect(designIssuesMarkdown(s, [tested])).toContain('from `Seeder.run (no entry point reaches it: only tests call it)`');
    expect(statuses(designIssuesPanel({ ...s, findings: [] }, noop))).toContain(note);
  });
});

describe('Copy as Markdown on the Design issues list', () => {
  it('the list grouped as shown, routes as the list writes them; Copied ✓ / Copy failed', async () => {
    const route: ProjectFinding = { finding: { id: 'g', kind: 'god-class', title: 'God class: OrderService' }, entryPoint: { kind: 'http', verb: 'GET', label: 'GET /v{version:apiVersion}/orders' } as never, others: 2 };
    const s: DesignIssuesState = { state: 'done', findings: [job, route], total: 7, project: 'shop', truncated: 1 };
    expect(designIssuesMarkdown(s, [job, route])).toBe(
      [
        '**Design issues · shop** — 2 findings in 7 entry points',
        '',
        '_1 flow hit the expand limit (some calls stayed folded and were not checked)._',
        '',
        '### I/O in loops (N+1) (1)',
        '- I/O in a loop: Repo.find (DB) — from `SyncJob.handle`',
        '',
        '### God classes (1)',
        '- God class: OrderService — from `GET /v{version}/orders` and 2 more',
      ].join('\n'),
    );
    expect(designIssuesMarkdown({ state: 'done' }, [job]).split('\n')[0]).toBe('**Design issues** — 1 finding in ? entry points');
    let copied = '';
    let ok = true;
    const p = designIssuesPanel(s, { ...noop, copy: async (t) => ((copied = t), ok) });
    const btn = p.querySelector('.ep-title .paths-copy') as HTMLButtonElement;
    expect(btn.nextElementSibling!.classList.contains('di-rescan')).toBe(true);
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toBe(designIssuesMarkdown(s, [job, route]));
    expect(btn.textContent).toBe('Copied ✓');
    ok = false;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(btn.textContent).toBe('Copy failed');
    // nothing found, or no copy action: no button
    expect(designIssuesPanel({ state: 'done', findings: [], total: 3 }, { ...noop, copy: async () => true }).querySelector('.paths-copy')).toBeNull();
    expect(designIssuesPanel(s, noop).querySelector('.paths-copy')).toBeNull();
  });
});
