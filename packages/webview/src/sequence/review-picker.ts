/**
 * FR-24.13 what a review compares with, without typing branch names: a "Compare with" button opening a searchable
 * list — quick choices (my pull request, not pushed yet, the last commit, uncommitted edits), branches (most recent
 * first), tags and the last commits; a typed name, tag, hash or `HEAD~3` works too — and the mode: since the split
 * (a pull request) or tip against tip. Picking runs the review.
 */
import type { GitRefs, ReviewResult } from '@seqcall/protocol';
import { html } from '../dom';

export type CompareMode = 'split' | 'direct';

export interface PickerState {
  base: string;
  mode: CompareMode;
  refs?: GitRefs;
  refsError?: string;
}

interface Choice {
  section: string;
  /** What runs: the base and (quick choices) the mode. */
  base: string;
  mode?: CompareMode;
  label: string;
  detail: string;
  /** Searched besides the label. */
  text: string;
}

/** "2h", "3d", "5w", "4mo". */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, (now - ms) / 60000);
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  if (m < 60 * 24 * 14) return `${Math.round(m / 1440)}d`;
  if (m < 60 * 24 * 90) return `${Math.round(m / 10080)}w`;
  return `${Math.round(m / 43200)}mo`;
}

/** The choices of the list, in sections; the filter matches label and text. */
export function choices(refs: GitRefs | undefined): Choice[] {
  const out: Choice[] = [];
  if (refs?.target) out.push({ section: 'Quick', base: refs.target, mode: 'split', label: `Pull request into ${refs.target}`, detail: 'since this branch split off it', text: 'pr pull request' });
  if (refs?.upstream) out.push({ section: 'Quick', base: refs.upstream, mode: 'split', label: 'Not pushed yet', detail: `vs ${refs.upstream}`, text: 'push upstream' });
  out.push({ section: 'Quick', base: 'HEAD~1', mode: 'split', label: 'Since the previous commit', detail: 'HEAD~1: the last commit and uncommitted edits', text: 'last commit head~1' });
  out.push({ section: 'Quick', base: 'HEAD', mode: 'split', label: 'Uncommitted changes only', detail: 'vs HEAD', text: 'uncommitted working tree head' });
  for (const b of refs?.branches ?? []) out.push({ section: 'Branches', base: b.name, label: b.name, detail: `${ago(b.date)}${b.remote ? ' · remote' : ''} · ${b.subject}`, text: `${b.hash} ${b.subject}` });
  for (const t of refs?.tags ?? []) out.push({ section: 'Tags', base: t.name, label: t.name, detail: ago(t.date), text: t.hash });
  for (const c of refs?.commits ?? []) out.push({ section: `Commits on ${refs?.current ?? 'this branch'}`, base: c.hash, label: `${c.hash} ${c.subject}`, detail: `${ago(c.date)} · ${c.author}`, text: c.author });
  return out;
}

const matches = (c: Choice, q: string) => !q || `${c.label} ${c.detail} ${c.text}`.toLowerCase().includes(q.toLowerCase());

/** Rows per section before "type to narrow". */
const PER_SECTION = 12;

/**
 * The compare row of the review panel: the base button (opens the list in place), the mode, and Review / Re-run.
 * `run(base, mode, force)`.
 */
export function compareRow(s: PickerState, running: boolean, done: boolean, run: (base: string, mode: CompareMode, force?: boolean) => void): HTMLElement {
  const row = html('div', { class: 'rv-base rv-compare' });
  let mode = s.mode;
  const baseBtn = html('button', { type: 'button', class: 'rv-pick', 'data-cmd': 'pick-base', title: 'Choose a branch, tag or commit to compare with — or type one', 'aria-haspopup': 'listbox' }, [
    html('span', { class: 'rv-pick-name' }, [s.base]),
    html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, [' ▾']),
  ]);
  const radio = (value: CompareMode, text: string, title: string) => {
    const input = html('input', { type: 'radio', name: 'rv-mode', value }) as HTMLInputElement;
    input.checked = mode === value;
    input.addEventListener('change', () => {
      mode = value;
      run(s.base, mode); // another mode is another review
    });
    return html('label', { class: 'rv-mode', title }, [input, ` ${text}`]);
  };
  const go = html('button', { type: 'button', class: 'rv-btn primary', title: done ? 'Compute the review again (it is reused while the branch, its edits and the base do not change)' : 'Review the changes' }, [done ? '↻ Re-run' : 'Review']);
  go.addEventListener('click', () => run(s.base, mode, done));
  go.toggleAttribute('disabled', running);
  const picker = html('div', { class: 'rv-picker', hidden: '' });
  baseBtn.addEventListener('click', () => {
    if (!picker.hidden) {
      picker.hidden = true;
      return;
    }
    picker.replaceChildren(pickerList(s, (base, m) => {
      picker.hidden = true;
      run(base, m ?? mode);
    }));
    picker.hidden = false;
    (picker.querySelector('input') as HTMLInputElement | null)?.focus();
  });
  row.append(
    'Compare with',
    baseBtn,
    radio('split', 'since the split', 'Like a pull request: what this branch changed since it split off the base'),
    radio('direct', 'tip against tip', 'Every difference between the base and this branch now: what only the base has shows as removed (red)'),
    go,
  );
  return html('div', { class: 'rv-compare-wrap' }, [row, picker]);
}

/** The searchable list; Enter on text that matches nothing uses the text itself (a ref, tag or hash). */
function pickerList(s: PickerState, pick: (base: string, mode?: CompareMode) => void): HTMLElement {
  const input = html('input', { type: 'text', class: 'find-input rv-filter', placeholder: 'Branch, tag, commit message or hash — Enter uses what you type', 'aria-label': 'Compare with', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const list = html('div', { class: 'rv-pick-list', role: 'listbox' });
  const all = choices(s.refs);
  let rows: { el: HTMLElement; c: Choice }[] = [];
  let active = 0;
  const render = () => {
    const q = input.value.trim();
    list.replaceChildren();
    rows = [];
    if (s.refsError) list.appendChild(html('div', { class: 'fc-status' }, [s.refsError]));
    else if (!s.refs) list.appendChild(html('div', { class: 'fc-status' }, ['Reading branches…']));
    const sections = [...new Set(all.map((c) => c.section))];
    for (const section of sections) {
      const hits = all.filter((c) => c.section === section && matches(c, q));
      if (!hits.length) continue;
      list.appendChild(html('div', { class: 'fc-sep' }, [section]));
      for (const c of hits.slice(0, PER_SECTION)) {
        const el = html('button', { type: 'button', class: `fc-row rv-choice${c.base === s.base && !c.mode ? ' current' : ''}`, role: 'option', title: c.base }, [
          html('span', { class: 'fc-main' }, [html('span', { class: 'fc-label' }, [c.label]), html('span', { class: 'fc-methods' }, [c.detail])]),
        ]);
        el.addEventListener('click', () => pick(c.base, c.mode));
        rows.push({ el, c });
        list.appendChild(el);
      }
      if (hits.length > PER_SECTION) list.appendChild(html('div', { class: 'fc-status' }, [`+${hits.length - PER_SECTION} more — type to narrow`]));
    }
    if (q && !rows.length) list.appendChild(html('div', { class: 'fc-status' }, [`Enter: compare with "${q}" (a branch, tag, hash or HEAD~n)`]));
    active = 0;
    rows[0]?.el.classList.add('active');
  };
  const move = (d: number) => {
    if (!rows.length) return;
    rows[active]?.el.classList.remove('active');
    active = (active + d + rows.length) % rows.length;
    rows[active].el.classList.add('active');
    rows[active].el.scrollIntoView?.({ block: 'nearest' });
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') {
      const q = input.value.trim();
      // no rows only while typing (the quick choices match an empty filter): the text itself
      if (rows[active]) pick(rows[active].c.base, rows[active].c.mode);
      else pick(q);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  return html('div', { class: 'rv-pick-panel' }, [input, list]);
}

/**
 * What was compared, in one line: "demo/removed-call ↔ merge base 5a4ddc7 of feature/X · 1 commit · 0 files in the
 * project (1 outside: .platform/hooks/…)". For an empty review it says why.
 */
export function compareSummary(r: ReviewResult, project: number): string | undefined {
  const c = r.compare;
  if (!c) return undefined;
  const branch = r.branch ?? 'HEAD';
  const point = c.mode === 'split' ? `merge base ${c.point} of ${r.resolvedBase}` : `${r.resolvedBase} (${c.point})`;
  const commits = c.mode === 'direct' ? `${c.commits} commit${c.commits === 1 ? '' : 's'} only here, ${c.behind} only in ${r.resolvedBase}` : `${c.commits} commit${c.commits === 1 ? '' : 's'}`;
  const outside = c.outside.length ? ` (${c.outside.length} outside: ${c.outside.slice(0, 2).join(', ')}${c.outside.length > 2 ? ', …' : ''})` : '';
  return `${branch} ↔ ${point} · ${commits} · ${project} file${project === 1 ? '' : 's'} in this project${outside}`;
}
