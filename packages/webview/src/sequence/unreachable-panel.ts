/**
 * FR-31 unreachable code: progress while the call graph is walked, then the methods no entry point reaches, grouped
 * by reason — dead-code candidates first, then the maybe-called and the framework-called. Choosing one opens its
 * declaration. Plain DOM inside the view's popup layer (portable to every host).
 */
import type { UnreachableMethod, UnreachableScan } from '@seqcall/protocol';
import { html } from '../dom';
import { CHANGED_NOTE } from './design-issues';

/** FR-31.1 the list is kept across saves (the walk takes up to minutes). */
export const KEPT_NOTE = 'The code changed since this check: a method added, newly called or no longer called shows after ↻.';

export interface UnreachableState {
  state: 'running' | 'done' | 'cancelled' | 'error';
  phase?: 'reach' | 'check';
  done?: number;
  total?: number;
  result?: UnreachableScan;
  project?: string;
  error?: string;
  /** Words the rows must contain (method or file). */
  filter?: string;
}

/** Rows drawn per group; the rest is counted (filter to narrow). */
const MAX_ROWS = 200;

interface Group {
  title: string;
  hint: string;
  rows: UnreachableMethod[];
  note(u: UnreachableMethod): string;
}

const label = (u: UnreachableMethod) => (u.method.owner.name && u.method.owner.name !== u.method.name ? `${u.method.owner.name}.${u.method.name}` : u.method.name);
const fileOf = (u: UnreachableMethod) => u.method.declaration?.file.replace(/\\/g, '/') ?? '';
const shortFile = (u: UnreachableMethod) => (u.method.declaration ? `${fileOf(u).replace(/^.*\//, '')}:${u.method.declaration.start.line + 1}` : '');
const callers = (u: UnreachableMethod) => (u.callers ? `${u.callers} caller${u.callers > 1 ? 's' : ''}` : '');

function groups(methods: UnreachableMethod[]): Group[] {
  const plain = methods.filter((u) => !u.framework && !u.unresolved);
  return [
    { title: 'No callers', hint: 'Nothing in the project calls it: a candidate for deletion.', rows: plain.filter((u) => u.reason === 'no-callers'), note: () => '' },
    { title: 'Called only from unreached code', hint: 'Its callers are unreached themselves: it goes with them.', rows: plain.filter((u) => u.reason === 'unreached-callers'), note: callers },
    { title: 'Only tests call it', hint: 'Production code never calls it; its tests do.', rows: plain.filter((u) => u.reason === 'tests-only'), note: callers },
    {
      title: 'Maybe called',
      hint: 'A call of this name the analysis could not resolve (an untyped receiver, a facade, a template) may reach it: check by hand.',
      rows: methods.filter((u) => !u.framework && u.unresolved),
      note: (u) => `${u.unresolved} unresolved call${u.unresolved! > 1 ? 's' : ''}${u.via ? ` · via ${u.via}` : ''}`,
    },
    { title: 'Probably called by the framework', hint: 'Magic / runtime methods, classes extending a library type, and what they reach.', rows: methods.filter((u) => u.framework), note: (u) => u.framework! },
  ];
}

const summary = (r: UnreachableScan, shown: number) => {
  const extra = [r.missed && `${r.missed} probably reached (not listed)`, r.ignored && `${r.ignored} ignored by the config`].filter(Boolean).join(' · ');
  return `${shown} of ${r.total} methods no entry point reaches (${r.entryPoints} entry points, tests excluded)${extra ? ` · ${extra}` : ''}`;
};

const matches = (filter: string | undefined) => {
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return (u: UnreachableMethod) => words.every((w) => `${label(u)} ${fileOf(u)}`.toLowerCase().includes(w));
};

/** The list as Markdown (for an issue, a chat, an AI agent), grouped as shown. */
export function unreachableMarkdown(s: UnreachableState): string {
  const r = s.result!;
  const methods = r.methods.filter(matches(s.filter));
  const out = [`**Unreachable code${s.project ? ` · ${s.project}` : ''}** — ${summary(r, methods.length)}${r.truncated ? ' (walk limit reached: some may be reached)' : ''}`];
  if (r.changed) out.push('', `_${CHANGED_NOTE}_`);
  if (r.stale) out.push('', `_${KEPT_NOTE}_`);
  for (const g of groups(methods)) {
    if (!g.rows.length) continue;
    out.push('', `### ${g.title} (${g.rows.length})`);
    for (const u of g.rows) {
      const note = g.note(u);
      out.push(`- \`${label(u)}\`${u.method.declaration ? ` — ${fileOf(u)}:${u.method.declaration.start.line + 1}` : ''}${note ? ` (${note})` : ''}`);
    }
  }
  return out.join('\n');
}

export function unreachablePanel(s: UnreachableState, actions: { open(u: UnreachableMethod): void; cancel(): void; rescan(): void; filter(text: string): void; copy?(text: string): Promise<boolean> }): HTMLElement {
  const panel = html('div', { class: 'entry-points-panel design-issues-panel unreachable-panel', role: 'dialog', 'aria-label': 'Unreachable code' });
  const button = (text: string, onClick: () => void, cls = 'notice-btn', title?: string) => {
    const b = html('button', { type: 'button', class: cls, ...(title ? { title, 'aria-label': title } : {}) }, [text]);
    b.addEventListener('click', onClick);
    return b;
  };
  const rescan = s.state === 'done' ? button('↻', actions.rescan, 'di-rescan', 'Scan again') : null;
  const title = html('div', { class: 'ep-title' }, ['∅ Unreachable code', s.project ? html('span', { class: 'ep-project' }, [` · ${s.project}`]) : null, rescan]);
  panel.appendChild(title);
  const status = (text: string, cls = 'ep-status') => panel.appendChild(html('div', { class: cls }, [text]));
  if (s.state === 'error') {
    status(s.error ?? 'The scan failed.', 'ep-status error');
    return panel;
  }
  if (s.state === 'running') {
    const what = s.phase === 'check' ? `Checking what no entry point reaches… ${s.done ?? 0} / ${s.total ?? '?'}` : `Following the calls from the entry points… ${s.done ?? 0} methods`;
    const row = html('div', { class: 'ep-status di-progress' }, [what]);
    row.appendChild(button('Cancel', actions.cancel));
    panel.appendChild(row);
    if (s.phase === 'check' && s.total) {
      const bar = html('div', { class: 'di-bar' }, [html('div', { class: 'di-bar-fill' })]);
      (bar.firstChild as HTMLElement).style.width = `${Math.round((100 * (s.done ?? 0)) / s.total)}%`;
      panel.appendChild(bar);
    }
    return panel;
  }
  if (s.state === 'cancelled') {
    const row = html('div', { class: 'ep-status' }, ['Scan cancelled. ']);
    row.appendChild(button('Scan again', actions.rescan));
    panel.appendChild(row);
    return panel;
  }
  const r = s.result!;
  if (!r.entryPoints) {
    status(`No entry points (routes, commands, jobs, handlers) — e.g. a library: every method would be listed (${r.total}).`);
    return panel;
  }
  if (!r.methods.length) {
    status(`Every method of the project is reached from its ${r.entryPoints} entry points.`);
    return panel;
  }
  if (actions.copy) {
    const copy = button('Copy as Markdown', () => void actions.copy!(unreachableMarkdown(s)).then((ok) => (copy.textContent = ok ? 'Copied ✓' : 'Copy failed')), 'paths-copy', 'Copy the list as Markdown, to paste into an issue, a chat or an AI agent');
    title.insertBefore(copy, rescan);
  }
  const search = html('input', { type: 'search', class: 'ep-search', placeholder: 'Filter by method or file', 'aria-label': 'Filter unreachable methods', value: s.filter ?? '' }) as HTMLInputElement;
  search.addEventListener('input', () => actions.filter(search.value));
  panel.appendChild(search);
  const methods = r.methods.filter(matches(s.filter));
  status(summary(r, methods.length));
  if (r.truncated) status('The walk hit its limit: some listed methods may be reached.', 'ep-status di-truncated');
  if (r.changed) status(CHANGED_NOTE, 'ep-status di-truncated');
  if (r.stale) status(KEPT_NOTE, 'ep-status di-truncated');
  const list = html('div', { class: 'ep-list', role: 'listbox' });
  for (const g of groups(methods)) {
    if (!g.rows.length) continue;
    list.appendChild(html('div', { class: 'ep-group', title: g.hint }, [`${g.title} `, html('span', { class: 'ep-count' }, [String(g.rows.length)])]));
    for (const u of g.rows.slice(0, MAX_ROWS)) {
      const note = g.note(u);
      const item = html('button', { type: 'button', class: 'ep-item di-item un-item', role: 'option', title: `${fileOf(u)}${note ? `\n${note}` : ''}` }, [
        html('span', { class: 'di-title' }, [label(u)]),
        html('span', { class: 'di-from' }, [[shortFile(u), note].filter(Boolean).join(' · ')]),
      ]);
      item.addEventListener('click', () => actions.open(u));
      list.appendChild(item);
    }
    if (g.rows.length > MAX_ROWS) list.appendChild(html('div', { class: 'ep-status' }, [`… ${g.rows.length - MAX_ROWS} more (filter to narrow)`]));
  }
  panel.appendChild(list);
  return panel;
}
