/**
 * FR-24 review of a branch: the base, progress while the host works, then what the branch changes —
 * issues on changed lines, the entry points it affects (with the changed methods under each), changed
 * methods no entry point reaches — and Copy as Markdown
 * for the pull request. Plain DOM inside the view's popup layer (portable to every host).
 */
import type { CallPathStep, EntryPoint, GitRefs, ReviewIssue, ReviewMethod, ReviewResult, StructureRow } from '@seqcall/protocol';
import { compareRow, compareSummary, type CompareMode } from './review-picker';
import { html } from '../dom';
import { issueTitle } from '../finding-guide';
import { displayRoute } from './entry-points';
import { entryTagText } from './layout';

export interface ReviewState {
  state: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  base: string;
  /** FR-24.13 since the split (default) or tip against tip; the picker's lists (asked for when the panel opens). */
  mode?: CompareMode;
  refs?: GitRefs;
  refsError?: string;
  phase?: string;
  done?: number;
  total?: number;
  result?: ReviewResult;
  error?: string;
}

export interface ReviewActions {
  /** `force`: compute again although nothing changed (FR-24.8); `mode`: FR-24.13. */
  run(base: string, force?: boolean, mode?: CompareMode): void;
  cancel(): void;
  end(): void;
  openIssue(issue: ReviewIssue): void;
  /** FR-29 the flow behind a structure row (zoomed to layers for a layer row). */
  openStructure(row: StructureRow): void;
  openPath(steps: CallPathStep[], entryPoint?: EntryPoint): void;
  copy(text: string): Promise<boolean>;
}

const label = (k: string) => k.replace(/^.*#/, '').replace(/^<module>\./, '');
const methodName = (m: ReviewMethod) => (m.method.owner.kind === 'module' ? m.method.name : `${m.method.owner.name}.${m.method.name}`);
export const entryText = (e: EntryPoint): string => (e.kind === 'http' && e.verb ? `${e.verb} ${displayRoute(e.label.slice(e.verb.length).trim())}` : entryTagText(e));
const where = (i: ReviewIssue) => (i.at ? `${i.at.file.replace(/^.*\//, '')}:${i.at.line}` : 'in a changed class');

/** FR-29 a structure row's words: what kind of change, its glyph, its class and title. */
const STRUCTURE_NOUN: Record<string, string> = { edge: 'dependency', violation: 'layer violation', entry: 'entry point', io: 'I/O kind', client: 'I/O client', cycle: 'cycle' };
export const structureKind = (row: StructureRow): { what: string; glyph: string; cls: 'added' | 'removed' | 'changed' } => {
  if (row.kind === 'layer-changed') return { what: 'class changed layer', glyph: '↦', cls: 'changed' };
  if (row.kind === 'role-changed') return { what: 'class changed role', glyph: '↦', cls: 'changed' };
  const added = row.kind.endsWith('-added');
  // FR-7.16 resting on a guessed layer (as the sidebar's)
  const noun = `${row.possible ? 'possible ' : ''}${STRUCTURE_NOUN[row.kind.replace(/-(added|removed)$/, '')]}`;
  const level = row.kind.startsWith('io') || row.kind.startsWith('client') ? ' in the layer' : row.kind.startsWith('edge') || row.kind.startsWith('cycle') ? (row.level === 'package' ? ' between packages' : ' between layers') : '';
  return { what: added ? `new ${noun}${level}` : `${noun}${level} removed`, glyph: added ? '✚' : '−', cls: added ? 'added' : 'removed' };
};
export const structureTitle = (row: StructureRow): string => (row.kind.startsWith('entry') && row.entryPoint ? entryText(row.entryPoint) : row.title);
const NO_STRUCTURE_CHANGE = 'No structural change: the same dependencies, cycles, I/O kinds and clients between layers and packages, layer violations, layers and roles of classes and entry points as the base.';

export function reviewPanel(s: ReviewState, actions: ReviewActions): HTMLElement {
  const panel = html('div', { class: 'entry-points-panel review-panel', role: 'dialog', 'aria-label': 'Review changes' });
  const r = s.result;
  const button = (text: string, run: () => void, cls = 'rv-btn', title?: string) => {
    const b = html('button', { type: 'button', class: cls, ...(title ? { title } : {}) }, [text]);
    b.addEventListener('click', run);
    return b;
  };
  const title = html('div', { class: 'ep-title' }, ['⎇ Review changes', r ? html('span', { class: 'ep-project' }, [` · ${r.branch ?? 'this branch'} vs ${r.resolvedBase}`]) : null]);
  if (r && s.state === 'done') {
    const copy = button('Copy as Markdown', () => void actions.copy(reviewMarkdown(r)).then((ok) => (copy.textContent = ok ? 'Copied ✓' : 'Copy failed')), 'paths-copy', 'Copy the review summary for the pull request');
    title.appendChild(copy);
    title.appendChild(button('End review', actions.end, 'rv-btn', 'Remove the change marks from the diagrams'));
  }
  panel.appendChild(title);
  // FR-24.13 what to compare with: a searchable list of branches, tags and commits, and the mode
  // (FR-24.8: the same base and mode again is a Re-run that computes it anyway)
  panel.appendChild(
    compareRow({ base: s.base, mode: s.mode ?? 'split', refs: s.refs, refsError: s.refsError }, s.state === 'running', s.state === 'done', (base, mode, force) =>
      actions.run(base, !!force && base === s.base && mode === (s.mode ?? 'split'), mode),
    ),
  );
  const status = (text: string, cls = 'ep-status') => panel.appendChild(html('div', { class: cls }, [text]));
  if (s.state === 'error') {
    status(s.error ?? 'The review failed.', 'ep-status error');
    return panel;
  }
  if (s.state === 'cancelled') {
    status('Review cancelled.');
    return panel;
  }
  if (s.state === 'running') {
    const row = html('div', { class: 'ep-status di-progress' }, [`${s.phase ?? 'Reviewing'}…${s.total ? ` ${s.done ?? 0} / ${s.total}` : ''}`]);
    row.appendChild(button('Cancel', actions.cancel, 'notice-btn'));
    panel.appendChild(row);
    if (s.total) {
      const bar = html('div', { class: 'di-bar' }, [html('div', { class: 'di-bar-fill' })]);
      (bar.firstChild as HTMLElement).style.width = `${Math.round((100 * (s.done ?? 0)) / s.total)}%`;
      panel.appendChild(bar);
    }
    return panel;
  }
  if (!r) {
    status('What does this branch change — and does it add problems? Reviews the branch against the base: changed methods, the entry points they affect, issues on changed lines, risks.');
    return panel;
  }
  const compared = compareSummary(r, r.files.length);
  if (!r.files.length) {
    // FR-24.13 say why: what was compared, and what changed elsewhere in the repository
    status(`No changes in this project against ${r.resolvedBase}.`);
    if (compared) panel.appendChild(html('div', { class: 'rv-compared' }, [compared]));
    return panel;
  }
  if (compared) panel.appendChild(html('div', { class: 'rv-compared' }, [compared]));
  // summary
  const reached = new Map<string, { entryPoint: EntryPoint; methods: { m: ReviewMethod; steps: CallPathStep[] }[] }>();
  for (const m of r.methods) {
    for (const x of m.reachedFrom) {
      const id = `${x.entryPoint.kind}|${x.entryPoint.label}`;
      const g = reached.get(id) ?? { entryPoint: x.entryPoint, methods: [] };
      g.methods.push({ m, steps: x.steps });
      reached.set(id, g);
    }
  }
  const unreached = r.methods.filter((m) => !m.reachedFrom.length && !m.notWalked);
  const notWalked = r.methods.filter((m) => m.notWalked);
  const onLines = r.issues.filter((i) => i.where === 'changed-lines').length;
  const testFiles = r.files.filter((f) => f.test).length;
  panel.appendChild(
    html('div', { class: 'rv-summary' }, [
      `${r.methods.length} method${r.methods.length === 1 ? '' : 's'} changed in ${r.files.length} file${r.files.length === 1 ? '' : 's'} · ${reached.size} entry point${reached.size === 1 ? '' : 's'} affected`,
      onLines ? html('span', { class: 'warn' }, [` · ⚠ ${onLines} issue${onLines === 1 ? '' : 's'} on changed lines`]) : ' · no issues on changed lines',
      ` · ${testFiles ? `${testFiles} test file${testFiles === 1 ? '' : 's'} changed` : 'no test file changed'}`,
    ]),
  );
  if (r.computedAt) {
    const at = new Date(r.computedAt);
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    panel.appendChild(html('div', { class: 'rv-when' }, [r.reused ? `Computed at ${time} — nothing changed since (same commits, edits and base)` : `Computed at ${time}`]));
  }
  const list = html('div', { class: 'ep-list', role: 'listbox' });
  const group = (text: string, n: number, note?: string) =>
    list.appendChild(html('div', { class: 'ep-group', ...(note ? { title: note } : {}) }, [`${text} `, html('span', { class: 'ep-count' }, [String(n)]), note ? html('span', { class: 'rv-note' }, [` — ${note}`]) : null]));
  const item = (children: (Node | string | null)[], run: () => void, cls = '', title?: string) => {
    const b = html('button', { type: 'button', class: `ep-item rv-item ${cls}`.trim(), role: 'option', ...(title ? { title } : {}) }, children);
    b.addEventListener('click', run);
    list.appendChild(b);
  };
  // FR-29 Level 0 first: did the shape change? The reviewer stops here when it did not.
  const st = r.structure;
  if (st?.rows.length) {
    group('Structure', st.rows.length, st.notCompared ? `${st.notCompared} affected entry point${st.notCompared === 1 ? '' : 's'} not compared (limit)` : undefined);
    for (const row of st.rows) {
      const { what, glyph, cls } = structureKind(row);
      const from = row.entryPoint && !row.kind.startsWith('entry') ? ` · ← ${entryText(row.entryPoint)}` : '';
      const openable = row.entryPoint && row.kind !== 'entry-removed';
      item(
        [html('span', {}, [html('span', { class: `rv-status ${cls}` }, [glyph]), structureTitle(row)]), html('span', { class: 'rv-sub' }, [`${what}${row.detail ? ` · ${row.detail}` : ''}${from}`])],
        () => actions.openStructure(row),
        `rv-struct kind-${row.kind}`,
        openable ? (row.level === 'layer' ? 'Open the flow zoomed to layers, at this call' : 'Open the flow at this call') : 'Only the base has it: nothing to open',
      );
    }
  } else if (st) list.appendChild(html('div', { class: 'ep-group rv-shape-ok' }, [NO_STRUCTURE_CHANGE]));
  if (r.issues.length) {
    group('Issues', r.issues.length);
    for (const i of r.issues) {
      const from = i.entryPoint ? entryText(i.entryPoint) : i.methodKey ? label(i.methodKey) : '';
      item([html('span', { class: 'di-title' }, [issueTitle(i.finding)]), html('span', { class: 'rv-sub' }, [`${where(i)}${from ? ` · ← ${from}` : ''}`])], () => actions.openIssue(i), `di-item kind-${i.finding.kind}`, i.finding.detail);
    }
  }
  if (reached.size) {
    group('Entry points affected', reached.size);
    for (const g of [...reached.values()].sort((a, b) => b.methods.length - a.methods.length)) {
      item([html('span', { class: 'rv-ep' }, [entryText(g.entryPoint)])], () => actions.openPath([{ methodKey: g.entryPoint.method.key }], g.entryPoint), '', `${g.entryPoint.label} — open its diagram`);
      for (const { m, steps } of g.methods) {
        item(
          [html('span', {}, [html('span', { class: `rv-status ${m.status}` }, [m.status === 'added' ? '✚' : '▲']), methodName(m)]), html('span', { class: 'rv-sub' }, [`${m.status} · ${m.lines.length} line${m.lines.length === 1 ? '' : 's'}${m.tests ? ` · called by ${m.tests} test${m.tests === 1 ? '' : 's'}` : ' · no test calls it directly'}`])],
          () => actions.openPath(steps, g.entryPoint),
          'rv-method',
          'Open the flow from the entry point, expanded down to this method',
        );
      }
    }
  }
  if (unreached.length) {
    group('Changed, no static caller from an entry point', unreached.length, 'called dynamically (container, untyped factory), by the framework, or not yet');
    for (const m of unreached) {
      item([html('span', {}, [html('span', { class: `rv-status ${m.status}` }, [m.status === 'added' ? '✚' : '▲']), methodName(m)]), html('span', { class: 'rv-sub' }, [`${m.status}${m.tests ? ` · called by ${m.tests} test${m.tests === 1 ? '' : 's'}` : ''}${m.truncated ? ' · callers not all walked' : ''}`])], () => actions.openPath([{ methodKey: m.method.key }]));
    }
  }
  if (notWalked.length) {
    group('Changed, callers not walked (limit)', notWalked.length, 'too many changed methods: who reaches these is unknown');
    for (const m of notWalked) {
      item([html('span', {}, [html('span', { class: `rv-status ${m.status}` }, [m.status === 'added' ? '✚' : '▲']), methodName(m)]), html('span', { class: 'rv-sub' }, [`${m.status} · callers not walked`])], () => actions.openPath([{ methodKey: m.method.key }]));
    }
  }
  panel.appendChild(list);
  const notes = [
    'Diagrams mark the branch: green arrow = a call on a changed line, underlined = a method added (green) or changed.',
    'Callers are found statically: calls through an untyped factory or the container, and tests that go through HTTP, are not followed.',
    r.notScanned ? `${r.notScanned} more affected entry points were not scanned for issues (limit).` : '',
    notWalked.length ? `${notWalked.length} changed methods were not walked up to the entry points (limit).` : '',
  ].filter(Boolean);
  panel.appendChild(html('div', { class: 'rv-legend' }, [notes.join(' ')]));
  return panel;
}

/** The review as a Markdown comment for the pull request. */
export function reviewMarkdown(r: ReviewResult): string {
  const out = [`**Seqcall review** — \`${r.branch ?? 'branch'}\` vs \`${r.resolvedBase}\`: ${r.methods.length} method${r.methods.length === 1 ? "" : "s"} changed in ${r.files.length} file${r.files.length === 1 ? "" : "s"}`, ''];
  const eps = new Map<string, string[]>();
  for (const m of r.methods) for (const x of m.reachedFrom) eps.set(entryText(x.entryPoint), [...(eps.get(entryText(x.entryPoint)) ?? []), methodName(m)]);
  if (r.structure?.rows.length) {
    out.push('**Structure**');
    for (const row of r.structure.rows) {
      const { what, glyph } = structureKind(row);
      out.push(`- ${glyph} ${structureTitle(row)} — ${what}${row.detail ? `: ${row.detail}` : ''}${row.entryPoint && !row.kind.startsWith('entry') ? ` (← \`${entryText(row.entryPoint)}\`)` : ''}`);
    }
    if (r.structure.notCompared) out.push(`- ${r.structure.notCompared} affected entry points not compared (limit)`);
    out.push('');
  } else if (r.structure) out.push(NO_STRUCTURE_CHANGE, '');
  if (r.issues.length) {
    out.push('**Issues**');
    for (const i of r.issues) out.push(`- ⚠ ${issueTitle(i.finding)} — ${where(i)}${i.entryPoint ? ` (← \`${entryText(i.entryPoint)}\`)` : ''}`);
    out.push('');
  } else out.push('No design issues on changed lines.', '');
  if (eps.size) {
    out.push('**Entry points affected**');
    for (const [e, ms] of eps) out.push(`- \`${e}\` — ${[...new Set(ms)].join(', ')}`);
    out.push('');
  }
  const unreached = r.methods.filter((m) => !m.reachedFrom.length && !m.notWalked);
  if (unreached.length) out.push(`**No static caller from an entry point:** ${unreached.map(methodName).join(', ')}`, '');
  const notWalked = r.methods.filter((m) => m.notWalked);
  if (notWalked.length) out.push(`**Callers not walked (limit):** ${notWalked.map(methodName).join(', ')}`, '');
  const untested = r.methods.filter((m) => !m.tests);
  if (untested.length) out.push(`**No test calls directly:** ${untested.map(methodName).join(', ')}`, '');
  const tests = r.files.filter((f) => f.test);
  out.push(tests.length ? `**Tests changed:** ${tests.map((f) => `\`${f.file}\``).join(', ')}` : '**No test file changed.**', '');
  return out.join('\n').trim();
}
