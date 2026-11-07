/**
 * FR-22 paths to here: the callers of a method walked up to the entry points, as a reverse tree
 * (the method on top, its callers below). Choosing a row opens the diagram from that method down to
 * the target, expanded along the path. Plain DOM inside the view's popup layer (portable to every host).
 */
import type { CallPathNode, CallPathStep, EntryPoint } from '@seqcall/protocol';
import { html } from '../dom';
import { displayRoute } from './entry-points';
import { formatLocation, normalizeSource } from './labels';
import { entryTagText } from './layout';

export interface PathsState {
  messageId: string;
  /** `Class.method` of the target. */
  title: string;
  state: 'running' | 'done' | 'cancelled' | 'error';
  methods?: number;
  tree?: CallPathNode;
  truncated?: boolean;
  error?: string;
  /** Open rows by tree path (`""` = the target, `"0/2"` = its first caller's third caller). */
  open?: Set<string>;
}

export interface PathsActions {
  open(steps: CallPathStep[], entryPoint?: EntryPoint): void;
  cancel(): void;
  /** Re-render after a row was opened / closed. */
  changed(): void;
  copy(text: string): Promise<boolean>;
}

/** Rows shown at once before "+N more" (the walk itself is limited to a few hundred paths). */
const MAX_ROWS = 400;

export const methodTitle = (n: CallPathNode): string => {
  const owner = n.method.owner;
  return owner.kind !== 'module' && owner.name ? `${owner.name}.${n.method.name}` : n.method.name;
};

const mainEntry = (n: CallPathNode): EntryPoint | undefined => n.entryPoints?.find((e) => e.kind !== 'test') ?? n.entryPoints?.[0];
const isTestEnd = (n: CallPathNode) => n.end === 'test' || (n.end === 'entry' && !n.entryPoints?.some((e) => e.kind !== 'test'));

function* leaves(n: CallPathNode, chain: CallPathNode[] = []): Generator<CallPathNode[]> {
  const here = [n, ...chain];
  if (!n.callers?.length) yield here;
  else for (const c of n.callers) yield* leaves(c, here);
}

/** The path from `chain[0]` (start) down to the target (last), as `openPath` steps. */
export function stepsOf(chain: CallPathNode[]): CallPathStep[] {
  return chain.map((n) => ({ methodKey: n.method.key, ...(n.call ? { call: { range: n.call.range, ...(n.call.passed ? { passed: true } : {}) } } : {}) }));
}

/** "2 routes · 1 job · 3 tests · 1 without entry point" (distinct starts). */
export function pathsSummary(tree: CallPathNode): string {
  const kinds = new Map<string, Set<string>>();
  const add = (k: string, id: string) => kinds.set(k, (kinds.get(k) ?? new Set()).add(id));
  for (const chain of leaves(tree)) {
    const start = chain[0];
    if (start === tree) continue;
    const e = mainEntry(start);
    if (isTestEnd(start)) add('test', start.method.key);
    else if (e) add(e.kind, `${e.kind}|${e.label}`);
    else if (start.end === 'top') add('top', start.method.key);
    else if (start.end === 'limit') add('limit', start.method.key);
  }
  const words: [string, string, string][] = [
    ['http', 'route', 'routes'],
    ['route', 'page', 'pages'],
    ['ui', 'UI root', 'UI roots'],
    ['cli', 'program', 'programs'],
    ['job', 'job', 'jobs'],
    ['handler', 'handler', 'handlers'],
    ['top', 'top-level caller (no entry point)', 'top-level callers (no entry point)'],
    ['limit', 'path cut by the limit', 'paths cut by the limit'],
    ['test', 'test', 'tests'],
  ];
  const parts = words.filter(([k]) => kinds.get(k)?.size).map(([k, one, many]) => `${kinds.get(k)!.size} ${kinds.get(k)!.size === 1 ? one : many}`);
  return parts.length ? `Reached from ${parts.join(' · ')}` : 'Nothing in the project calls it';
}

/**
 * Rows open at first: those leading to a route / program / job / handler; with no such path, the
 * whole tree when it is small, else its first two levels. Paths ending in tests stay closed.
 */
export function initialOpen(tree: CallPathNode): Set<string> {
  const open = new Set<string>(['']);
  let any = false;
  const walk = (n: CallPathNode, id: string): boolean => {
    let leads = !!n.end && n.end === 'entry' && !isTestEnd(n);
    (n.callers ?? []).forEach((c, i) => {
      if (walk(c, id ? `${id}/${i}` : String(i))) leads = true;
    });
    if (leads && n.callers?.length) open.add(id);
    any ||= leads;
    return leads;
  };
  walk(tree, '');
  if (any) return open;
  let count = 0;
  const all = (n: CallPathNode, id: string, depth: number) => {
    count++;
    (n.callers ?? []).forEach((c, i) => all(c, id ? `${id}/${i}` : String(i), depth + 1));
  };
  all(tree, '', 0);
  const fill = (n: CallPathNode, id: string, depth: number) => {
    if (!n.callers?.length || (count > 60 && depth >= 2) || isTestOnly(n)) return;
    open.add(id);
    n.callers.forEach((c, i) => fill(c, id ? `${id}/${i}` : String(i), depth + 1));
  };
  fill(tree, '', 0);
  open.add('');
  return open;
}

/** A test calling the method directly (grouped into one "N tests" row). */
const isTestLeaf = (n: CallPathNode) => !n.callers?.length && isTestEnd(n);

const isTestOnly = (n: CallPathNode): boolean => [...leaves(n)].every((chain) => isTestEnd(chain[0]));

/** Markdown for a PR description: one line per path, start first (routes, other starts, tests). */
export function pathsMarkdown(s: PathsState): string {
  const tree = s.tree!;
  const line = (chain: CallPathNode[]) => {
    const e = mainEntry(chain[0]);
    const tag = e ? `\`${e.kind === 'http' ? `${e.verb ?? ''} ${displayRoute(e.label.slice(e.verb?.length ?? 0).trim())}`.trim() : entryTagText(e)}\` ` : '';
    const end = chain[0].end === 'top' ? ' _(nothing calls it)_' : chain[0].end === 'limit' ? ' _(cut by the limit)_' : '';
    return `- ${tag}${chain.map(methodTitle).join(' → ')}${end}`;
  };
  const chains = [...leaves(tree)].filter((c) => c[0] !== tree);
  const rank = (c: CallPathNode[]) => (mainEntry(c[0]) ? 0 : 1);
  const out = [`**Paths to \`${s.title}\`** — ${pathsSummary(tree)}`, ''];
  for (const c of chains.filter((c) => !isTestEnd(c[0])).sort((a, b) => rank(a) - rank(b))) out.push(line(c));
  // tests: one line per test class and path below it ("24 tests in `XTests` → A.b → …")
  const tests = new Map<string, number>();
  for (const c of chains.filter((c) => isTestEnd(c[0]))) {
    const key = `${c[0].method.owner.name}|${c.slice(1).map(methodTitle).join(' → ')}`;
    tests.set(key, (tests.get(key) ?? 0) + 1);
  }
  for (const [key, count] of tests) {
    const [cls, rest] = key.split('|');
    out.push(`- ${count} test${count === 1 ? '' : 's'} in \`${cls}\` → ${rest}`);
  }
  if (!chains.length) out.push('_No callers in the project._');
  if (s.truncated) out.push('', '_Some paths were cut by the walk limits._');
  return out.join('\n');
}

export function pathsPanel(s: PathsState, actions: PathsActions): HTMLElement {
  const panel = html('div', { class: 'entry-points-panel paths-panel', role: 'dialog', 'aria-label': `Paths to ${s.title}` });
  const title = html('div', { class: 'ep-title' }, ['Paths to ', html('span', { class: 'code paths-target' }, [s.title])]);
  panel.appendChild(title);
  const status = (text: string, cls = 'ep-status') => panel.appendChild(html('div', { class: cls }, [text]));
  if (s.state === 'error') {
    status(s.error ?? 'The search failed.', 'ep-status error');
    return panel;
  }
  if (s.state === 'cancelled') {
    status('Search cancelled.');
    return panel;
  }
  if (s.state === 'running' || !s.tree) {
    const row = html('div', { class: 'ep-status di-progress' }, [`Walking the callers up to the entry points… ${s.methods ?? 0} methods`]);
    const b = html('button', { type: 'button', class: 'notice-btn' }, ['Cancel']);
    b.addEventListener('click', actions.cancel);
    row.appendChild(b);
    panel.appendChild(row);
    return panel;
  }
  const tree = s.tree;
  const copy = html('button', { type: 'button', class: 'paths-copy', title: 'Copy the paths as a Markdown list (e.g. for a pull request)' }, ['Copy as Markdown']);
  copy.addEventListener('click', () => {
    void actions.copy(pathsMarkdown(s)).then((ok) => (copy.textContent = ok ? 'Copied ✓' : 'Copy failed'));
  });
  title.appendChild(copy);
  status(`${pathsSummary(tree)}${s.truncated ? ' (some paths cut by the limits)' : ''}`, 'ep-status paths-summary');
  if (!tree.callers?.length) return panel;
  const open = (s.open ??= initialOpen(tree));
  const list = html('div', { class: 'ep-list paths-list', role: 'tree' });
  let rows = 0;
  const row = (n: CallPathNode, id: string, depth: number, chain: CallPathNode[]) => {
    if (rows++ >= MAX_ROWS) return;
    const here = [n, ...chain];
    const hasCallers = !!n.callers?.length;
    const isOpen = hasCallers && open.has(id);
    const toggle = html('span', { class: 'paths-toggle', 'aria-hidden': 'true' }, [hasCallers ? (isOpen ? '▾' : '▸') : '']);
    const e = mainEntry(n);
    const tags: (HTMLElement | null)[] = [];
    if (e && n !== tree && e.kind !== 'test') {
      tags.push(e.kind === 'http' ? html('span', { class: 'paths-entry kind-http' }, [html('span', { class: `ep-verb verb-${(e.verb ?? '').toLowerCase()}` }, [e.verb ?? '']), displayRoute(e.label.slice(e.verb?.length ?? 0).trim())]) : html('span', { class: `paths-entry kind-${e.kind}` }, [entryTagText(e)]));
    }
    if (n.call?.passed) tags.push(html('span', { class: 'caller-tag', title: 'Passed as an argument to this call, which invokes it' }, ['passed']));
    if (n.call?.count) tags.push(html('span', { class: 'caller-tag', title: `${n.call.count} calls from this method` }, [`×${n.call.count}`]));
    if (n.inTest || e?.kind === 'test') tags.push(html('span', { class: 'caller-tag', title: e?.detail ?? 'Test code' }, ['test']));
    if (n.end === 'top' && n !== tree) tags.push(html('span', { class: 'paths-end', title: 'Nothing in the project calls this method (a framework, a public API or dead code)' }, ['no callers']));
    if (n.end === 'limit') tags.push(html('span', { class: 'paths-end', title: 'The walk stopped here (depth or size limit)' }, ['…']));
    const tip = n.call ? `${normalizeSource(n.call.preview)}\n${n.call.range.file}:${n.call.range.start.line + 1}\nClick: open the diagram from here, expanded down to ${s.title}` : s.title;
    const item = html('button', { type: 'button', class: `ep-item paths-item${n.inTest || isTestEnd(n) ? ' in-test' : ''}${n === tree ? ' paths-root' : ''}`, role: 'treeitem', 'data-path-id': id, title: tip, ...(hasCallers ? { 'aria-expanded': String(isOpen) } : {}) }, [
      toggle,
      // an entry point's route says most: first, the method name after it
      ...(e && n !== tree && e.kind !== 'test' ? [tags.shift()!] : []),
      html('span', { class: 'paths-name' }, [methodTitle(n)]),
      ...tags,
      n.call ? html('span', { class: 'ep-method paths-loc' }, [formatLocation(n.call.range)]) : null,
    ]);
    item.style.paddingLeft = `${10 + depth * 14}px`;
    toggle.addEventListener('click', (ev) => {
      if (!hasCallers) return;
      ev.stopPropagation();
      if (isOpen) open.delete(id);
      else open.add(id);
      actions.changed();
    });
    item.addEventListener('click', () => actions.open(stepsOf(here), mainEntry(n)));
    list.appendChild(item);
    if (!isOpen) return;
    // tests that call this method directly: one row ("24 tests"), opened on demand
    const childId = (i: number) => (id ? `${id}/${i}` : String(i));
    const tests: number[] = [];
    n.callers!.forEach((c, i) => {
      if (isTestLeaf(c)) tests.push(i);
      else row(c, childId(i), depth + 1, here);
    });
    if (!tests.length) return;
    const groupId = `${id}/tests`;
    const groupOpen = open.has(groupId);
    const group = html('button', { type: 'button', class: 'ep-item paths-item paths-tests in-test', role: 'treeitem', 'aria-expanded': String(groupOpen), title: `Tests calling ${methodTitle(n)} directly` }, [
      html('span', { class: 'paths-toggle', 'aria-hidden': 'true' }, [groupOpen ? '▾' : '▸']),
      html('span', { class: 'paths-name' }, [`${tests.length} test${tests.length === 1 ? '' : 's'}`]),
    ]);
    group.style.paddingLeft = `${10 + (depth + 1) * 14}px`;
    group.addEventListener('click', () => {
      if (groupOpen) open.delete(groupId);
      else open.add(groupId);
      actions.changed();
    });
    list.appendChild(group);
    if (groupOpen) for (const i of tests) row(n.callers![i], childId(i), depth + 2, here);
  };
  row(tree, '', 0, []);
  if (rows > MAX_ROWS) list.appendChild(html('div', { class: 'ep-more' }, ['More rows not shown — close some paths']));
  panel.appendChild(list);
  return panel;
}
