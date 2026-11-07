/**
 * FR-19.9 project-wide design issues: progress while the entry points are scanned, then the findings
 * grouped by kind; choosing one opens its flow (expanded as the scan saw it) with the evidence
 * highlighted. Plain DOM inside the view's popup layer (portable to every host).
 */
import type { FindingKind, ProjectFinding } from '@seqcall/protocol';
import { html } from '../dom';
import { issueTitle } from '../finding-guide';
import { displayRoute } from './entry-points';

export interface DesignIssuesState {
  state: 'running' | 'done' | 'cancelled' | 'error';
  done?: number;
  total?: number;
  findings?: ProjectFinding[];
  project?: string;
  /** flows cut by the expand limit (as the codebase map says). */
  truncated?: number;
  /** FR-19.23 methods no entry point reaches: checked too, and left out by the limit. */
  unreached?: { scanned: number; skipped: number; stale?: boolean };
  /** While running: the entry points are done (their findings shown), the methods none reaches are looked for. */
  walking?: boolean;
  /** The code changed while the scan ran: not kept, ↻ scans again. */
  changed?: boolean;
  error?: string;
}

const GROUPS: { kind: FindingKind; title: string }[] = [
  { kind: 'io-in-loop', title: 'I/O in loops (N+1)' },
  { kind: 'io-in-domain', title: 'I/O in Domain' },
  { kind: 'cyclic-collaboration', title: 'Cyclic collaborations' },
  { kind: 'dependency-cycle', title: 'Dependency cycles' },
  { kind: 'layer-ping-pong', title: 'Layer ping-pong' },
  { kind: 'god-class', title: 'God classes' },
  { kind: 'too-many-dependencies', title: 'Too many dependencies' },
  // the flow's ⚠, the map and Review list them too — one per class pair
  { kind: 'layer-violation', title: 'Layer violations' },
];

/** the same words as the codebase map's note. */
const cutNote = (n: number) => `${n} flow${n > 1 ? 's' : ''} hit the expand limit (some calls stayed folded and were not checked).`;

/** A file was saved while the scan ran: the result mixes old and new code. */
export const CHANGED_NOTE = 'The code changed while this ran: the list may mix old and new code. ↻ checks again.';

/** FR-31 the unreachable-code list is kept across saves: what a save changed in it shows after ↻. */
export const STALE_NOTE = 'The methods no entry point reaches are from a check before the last change: a method added, newly called or no longer called shows after ↻.';

/** The entry point a finding was found from, as the list shows it (FR-19.23 or the method no entry point reaches). */
const fromText = (f: ProjectFinding): string =>
  f.entryPoint.unreached ? `${f.entryPoint.label} (${f.entryPoint.unreachedWhy ?? 'no entry point reaches it'})` : f.entryPoint.verb ? `${f.entryPoint.verb} ${displayRoute(f.entryPoint.label.slice(f.entryPoint.verb.length).trim())}` : f.entryPoint.label;

/** FR-19.23 what was scanned: "3 entry points and 12 methods no flow opened" (+ those left out). */
function scopeText(s: DesignIssuesState, unknown = '?'): string {
  const eps = `${s.total ?? unknown} entry point${s.total === 1 ? '' : 's'}`;
  const u = s.unreached;
  if (!u?.scanned) return eps;
  return `${eps} and ${u.scanned} method${u.scanned === 1 ? '' : 's'} no flow opened${u.skipped ? ` (${u.skipped} more not checked: the limit)` : ''}`;
}

/** the list as Markdown (for an issue, a chat, an AI agent), grouped as shown. */
export function designIssuesMarkdown(s: DesignIssuesState, findings: ProjectFinding[]): string {
  const out = [`**Design issues${s.project ? ` · ${s.project}` : ''}** — ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${scopeText(s)}`];
  if (s.truncated) out.push('', `_${cutNote(s.truncated)}_`);
  if (s.changed) out.push('', `_${CHANGED_NOTE}_`);
  if (s.unreached?.stale) out.push('', `_${STALE_NOTE}_`);
  for (const g of GROUPS) {
    const rows = findings.filter((f) => f.finding.kind === g.kind);
    if (!rows.length) continue;
    out.push('', `### ${g.title} (${rows.length})`);
    for (const f of rows) out.push(`- ${issueTitle(f.finding)} — from \`${fromText(f)}\`${f.others ? ` and ${f.others} more` : ''}`);
  }
  return out.join('\n');
}

export function designIssuesPanel(s: DesignIssuesState, actions: { open(f: ProjectFinding): void; cancel(): void; rescan(): void; copy?(text: string): Promise<boolean>}): HTMLElement {
  const panel = html('div', { class: 'entry-points-panel design-issues-panel', role: 'dialog', 'aria-label': 'Design issues' });
  const button = (label: string, onClick: () => void, cls = 'notice-btn', title?: string) => {
    const b = html('button', { type: 'button', class: cls, ...(title ? { title, 'aria-label': title } : {}) }, [label]);
    b.addEventListener('click', onClick);
    return b;
  };
  // a finished result (cached until the code changes) can be scanned again on demand
  const rescan = s.state === 'done' ? button('↻', actions.rescan, 'di-rescan', 'Scan again') : null;
  const title = html('div', { class: 'ep-title' }, ['⚠ Design issues', s.project ? html('span', { class: 'ep-project' }, [` · ${s.project}`]) : null, rescan]);
  panel.appendChild(title);
  const status = (text: string, cls = 'ep-status') => panel.appendChild(html('div', { class: cls }, [text]));
  if (s.state === 'error') {
    status(s.error ?? 'The scan failed.', 'ep-status error');
    return panel;
  }
  if (s.state === 'running') {
    const total = s.total ? ` ${s.done ?? 0} / ${s.total}` : '';
    const text = s.walking
      ? 'Looking for the methods no entry point reaches… (the unreachable-code check, kept for ∅ and the next scan)'
      : `Scanning flows…${total} (entry points, then the methods no flow opened; each flow is expanded fully)`;
    const row = html('div', { class: 'ep-status di-progress' }, [text]);
    row.appendChild(button('Cancel', actions.cancel));
    panel.appendChild(row);
    if (s.total && !s.walking) {
      const bar = html('div', { class: 'di-bar' }, [html('div', { class: 'di-bar-fill' })]);
      (bar.firstChild as HTMLElement).style.width = `${Math.round((100 * (s.done ?? 0)) / s.total)}%`;
      panel.appendChild(bar);
    }
    // FR-19.23 the entry points' findings already, while the rest runs (the methods none reaches can take minutes)
    if (s.findings?.length) {
      panel.appendChild(html('div', { class: 'ep-status' }, [`${s.findings.length} finding${s.findings.length === 1 ? '' : 's'} in the entry points so far`]));
      panel.appendChild(findingList(s.findings, actions));
    }
    return panel;
  }
  if (s.state === 'cancelled') {
    const row = html('div', { class: 'ep-status' }, ['Scan cancelled. ']);
    row.appendChild(button('Scan again', actions.rescan));
    panel.appendChild(row);
    return panel;
  }
  const findings = s.findings ?? [];
  if (s.total === 0) {
    status('No entry points to scan (routes, commands, jobs, handlers) — e.g. a library. Open a flow and use ⚠ in the toolbar instead.');
    return panel;
  }
  if (!findings.length) {
    status(`No design issues found in ${scopeText(s, 'the')}.`);
    if (s.truncated) status(cutNote(s.truncated), 'ep-status di-truncated');
    if (s.changed) status(CHANGED_NOTE, 'ep-status di-truncated');
    if (s.unreached?.stale) status(STALE_NOTE, 'ep-status di-truncated');
    return panel;
  }
  // as on the Review and Paths to here panels
  if (actions.copy) {
    const copy = button('Copy as Markdown', () => void actions.copy!(designIssuesMarkdown(s, findings)).then((ok) => (copy.textContent = ok ? 'Copied ✓' : 'Copy failed')), 'paths-copy', 'Copy the list as Markdown, to paste into an issue, a chat or an AI agent');
    title.insertBefore(copy, rescan);
  }
  panel.appendChild(html('div', { class: 'ep-status' }, [`${findings.length} finding${findings.length === 1 ? '' : 's'} in ${scopeText(s)}`]));
  if (s.truncated) panel.appendChild(html('div', { class: 'ep-status di-truncated' }, [cutNote(s.truncated)]));
  if (s.changed) panel.appendChild(html('div', { class: 'ep-status di-truncated' }, [CHANGED_NOTE]));
  if (s.unreached?.stale) panel.appendChild(html('div', { class: 'ep-status di-truncated' }, [STALE_NOTE]));
  panel.appendChild(findingList(findings, actions));
  return panel;
}

/** The findings grouped by kind; a row opens its flow. */
function findingList(findings: ProjectFinding[], actions: { open(f: ProjectFinding): void }): HTMLElement {
  const list = html('div', { class: 'ep-list', role: 'listbox' });
  for (const g of GROUPS) {
    const rows = findings.filter((f) => f.finding.kind === g.kind);
    if (!rows.length) continue;
    list.appendChild(html('div', { class: 'ep-group' }, [`${g.title} `, html('span', { class: 'ep-count' }, [String(rows.length)])]));
    for (const f of rows) {
      const from = fromText(f);
      const item = html('button', { type: 'button', class: `ep-item di-item kind-${f.finding.kind}`, role: 'option', title: f.finding.detail ?? '' }, [
        html('span', { class: 'di-title' }, [issueTitle(f.finding)]),
        html('span', { class: 'di-from' }, [`← ${from}${f.others ? ` · +${f.others} more` : ''}`]),
      ]);
      item.addEventListener('click', () => actions.open(f));
      list.appendChild(item);
    }
  }
  return list;
}
