/**
 * FR-16.2 entry-point list: searchable, grouped by kind; choosing one opens its sequence diagram.
 * Plain DOM inside the view's popup layer (portable to every host).
 */
import type { EntryOutcome, EntryPoint, EntryPointKind, EntryPointListNode, MethodRef } from '@seqcall/protocol';
import { html } from '../dom';
import { bindListKeys } from '../list-keys';
import { SIDE_EFFECT_TAG } from '../side-effects';

export interface EntryPointsState {
  /** undefined = still searching. */
  entryPoints?: EntryPoint[];
  project?: string;
  error?: string;
  /** FR-16.11 the host can switch to another project. */
  canSwitchProject?: boolean;
  filter: string;
  /**
   * Groups (`kind`, `project/kind`; default: all open except tests), projects (`project:name`) and folders
   * (`folder:kind:path`) the user opened / closed (default: closed).
   */
  open: Record<string, boolean>;
  /** FR-16.4 the host's tree (as the VS Code sidebar shows it); without it: by kind, files of module-level calls. */
  tree?: EntryPointListNode[];
  /** FR-16.5 files with several module-level calls the user opened (default: closed). */
  openFiles?: Record<string, boolean>;
  /** FR-26.8 entry points ticked for a map of only them (`entryKey`). */
  selected?: Set<string>;
  /** the tick boxes show only after *Select for map* (or while something is ticked). */
  selecting?: boolean;
  /** FR-16.15 the project's methods named like the filter (the host's answer for `query`), or the search running. */
  methods?: { query: string; methods?: MethodRef[]; more?: number };
  /** FR-32.4 the outcomes known (the flows opened, the project scan), by `entryKey`: pills on the rows, `has:` in the filter. */
  outcomes?: Record<string, EntryOutcome>;
}

/** FR-26.8 how a map selection names an entry point (the core's `appMapEntryKey`). */
export function entryKey(e: EntryPoint): string {
  return `${e.kind}|${e.label}|${e.method.key}`;
}

/**
 * FR-16.5 a group's rows: module-level calls of one file together under the file (when it has more than one),
 * in the order of the list; everything else as single rows.
 */
export function rowsByFile(list: EntryPoint[]): ({ entry: EntryPoint } | { file: string; entries: EntryPoint[] })[] {
  const count = new Map<string, number>();
  for (const e of list) if (e.file) count.set(e.file, (count.get(e.file) ?? 0) + 1);
  const out: ({ entry: EntryPoint } | { file: string; entries: EntryPoint[] })[] = [];
  const files = new Map<string, EntryPoint[]>();
  for (const e of list) {
    if (!e.file || count.get(e.file)! < 2) { // counted above
      out.push({ entry: e });
      continue;
    }
    let entries = files.get(e.file);
    if (!entries) {
      files.set(e.file, (entries = []));
      out.push({ file: e.file, entries });
    }
    entries.push(e);
  }
  return out;
}

const GROUPS: { kind: EntryPointKind; title: string }[] = [
  { kind: 'http', title: 'HTTP endpoints' },
  { kind: 'route', title: 'Pages (client routes)' },
  { kind: 'ui', title: 'UI roots' },
  { kind: 'cli', title: 'Programs & scripts' },
  { kind: 'job', title: 'Background jobs' },
  { kind: 'handler', title: 'Handlers' },
  { kind: 'test', title: 'Tests' },
];

/** The entry points below a tree node (core's `entriesUnder`; the webview cannot import core). */
const entriesBelow = (n: EntryPointListNode, list: EntryPoint[]): EntryPoint[] => (n.type === 'entry' ? [list[n.index]] : n.children.flatMap((c) => entriesBelow(c, list)));

/** Without the host's tree (an older host): the kinds, sorted, files of module-level calls together. */
function flatTree(list: EntryPoint[]): EntryPointListNode[] {
  const index = new Map(list.map((e, i) => [e, i]));
  const entry = (e: EntryPoint): EntryPointListNode => ({ type: 'entry', index: index.get(e)! });
  return GROUPS.flatMap((g) => {
    const of = sortForDisplay(list.filter((e) => e.kind === g.kind));
    return of.length ? [{ type: 'group' as const, kind: g.kind, children: rowsByFile(of).map((r) => ('entry' in r ? entry(r.entry) : { type: 'file' as const, file: r.file, children: r.entries.map(entry) })) }] : [];
  });
}

/** A row one level deeper per tree level (FR-16.4 folders). */
function indent<T extends HTMLElement>(row: T, depth: number, base = 10): T {
  if (depth) row.style.paddingLeft = `${base + 12 * depth}px`;
  return row;
}

/** Rows per group before "refine the search". */
const MAX_ROWS = 150;

/**
 * Case-insensitive match on the label, the method, the detail and the project (FR-16.8); all words must match (as core's
 * `entryPointMatches`). FR-32.4 `has:http` (a kind or its tag: `has:mq`), `has:io` (any): its known outcome does that I/O
 * — an entry point whose outcome is not known yet does not match.
 */
export function matchesFilter(e: EntryPoint, filter: string, outcomes?: Record<string, EntryOutcome>): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.label} ${e.method.owner.name}.${e.method.name} ${e.detail ?? ''} ${e.project ?? ''}`.toLowerCase();
  const kinds = outcomes?.[entryKey(e)]?.kinds;
  const has = (w: string) => !!kinds?.some((k) => w === 'io' || w === k || w === SIDE_EFFECT_TAG[k].toLowerCase());
  return words.every((w) => (w.startsWith('has:') ? has(w.slice(4)) : hay.includes(w)));
}

/** FR-16.15 the words of the filter the project's methods are searched by (`has:` words are about the outcome). */
export function methodQuery(filter: string): string {
  return filter.split(/\s+/).filter((w) => w && !w.toLowerCase().startsWith('has:')).join(' ');
}

/** FR-32.4 a row's pill: `DB·HTTP+` (`+`: there may be more); nothing while unknown or without I/O. */
export function outcomePill(o: EntryOutcome | undefined): HTMLElement | null {
  if (!o?.kinds.length) return null;
  const tags = o.kinds.map((k) => SIDE_EFFECT_TAG[k]);
  return html('span', { class: 'ep-io', title: `I/O of its whole flow: ${tags.join(', ')}${o.atLeast ? ' (at least: there may be more)' : ''}` }, [`${tags.join('·')}${o.atLeast ? '+' : ''}`]);
}

/** Route constraints shortened for display: `{version:apiVersion}` → `{version}`, `{id:long}` → `{id}`. */
// the same rule as core's displayRoute (the VS Code lists), so a route reads the same everywhere
export function displayRoute(route: string): string {
  return route.replace(/\{(\*?\w+)(?::[^{}]+|\?)?\}/g, '{$1}');
}

const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** HTTP endpoints by path, then verb (a resource's endpoints together); others by label. */
export function sortForDisplay(list: EntryPoint[]): EntryPoint[] {
  const path = (e: EntryPoint) => (e.verb ? e.label.slice(e.verb.length).trim() : e.label).toLowerCase();
  const verb = (e: EntryPoint) => (e.verb ? (VERB_ORDER.indexOf(e.verb) + 1 || 99) : 0);
  return [...list].sort((a, b) => path(a).localeCompare(path(b)) || verb(a) - verb(b));
}

const methodText = (e: EntryPoint): string => (e.method.owner.kind === 'module' ? e.method.name : `${e.method.owner.name}.${e.method.name}`);

/** FR-16.15 the pause after typing before the project's methods are searched. */
const METHOD_SEARCH_MS = 300;

export function entryPointsPanel(state: EntryPointsState, actions: { open(e: EntryPoint): void; changed(): void; /** FR-16.15 */ searchMethods?(query: string): void; openMethod?(m: MethodRef): void; designIssues?(): void; unreachable?(): void; review?(): void; appMap?(entryPoints?: string[]): void; switchProject?(): void }): HTMLElement {
  const panel = html('div', { class: 'entry-points-panel', role: 'dialog', 'aria-label': 'Entry points' });
  // FR-16.11 the project name switches the project when the host has several (as the sidebar's Switch Project…)
  const project = state.canSwitchProject && actions.switchProject
    ? html('button', { type: 'button', class: 'ep-project ep-switch-project', title: 'Switch project: list the entry points of another project of the workspace' }, [` · ${state.project ?? 'project'} ▾`])
    : state.project
      ? html('span', { class: 'ep-project' }, [` · ${state.project}`])
      : null;
  project?.addEventListener('click', () => actions.switchProject?.());
  const title = html('div', { class: 'ep-title' }, ['Entry points', project]);
  // FR-19.9: design issues of the whole project, found through its entry points
  if (actions.designIssues) {
    const b = html('button', { type: 'button', class: 'ep-issues-btn', title: 'Scan every entry point (expanded fully) for design issues: I/O in loops, cycles, I/O in Domain …' }, ['⚠ Design issues']);
    b.addEventListener('click', () => actions.designIssues!());
    title.appendChild(b);
  }
  // FR-24: what does this branch change, and does it add problems?
  if (actions.review) {
    const b = html('button', { type: 'button', class: 'ep-issues-btn ep-tool-btn ep-review-btn', title: 'Review this branch against its base (develop): changed methods, the entry points they affect, issues on changed lines' }, ['⎇ Review changes']);
    b.addEventListener('click', () => actions.review!());
    title.appendChild(b);
  }
  // FR-26: every entry point's flow together — the application's classes, folder by folder;
  // FR-26.8 only the ticked ones, or (while filtering) the matching ones
  const selected = (state.selected ??= new Set<string>());
  let mapButton: HTMLButtonElement | undefined;
  let mapScope: () => string[] | undefined = () => undefined;
  const clearSel = html('button', { type: 'button', class: 'ep-issues-btn ep-clear-sel', title: 'Untick every entry point' }, ['✕']) as HTMLButtonElement;
  const selectButton = html('button', { type: 'button', class: 'ep-issues-btn ep-tool-btn ep-select-btn' }) as HTMLButtonElement;
  if (actions.appMap) {
    mapButton = html('button', { type: 'button', class: 'ep-issues-btn ep-tool-btn ep-appmap-btn' }, ['⛶ Codebase map']) as HTMLButtonElement;
    mapButton.addEventListener('click', () => actions.appMap!(mapScope()));
    title.append(mapButton);
  }
  // FR-31 (after the map, so the older buttons keep their place): methods no entry point reaches (dead-code candidates)
  if (actions.unreachable) {
    const b = html('button', { type: 'button', class: 'ep-issues-btn ep-tool-btn ep-unreachable-btn', title: 'Methods no entry point reaches: candidates for deletion (and what the framework or unresolved calls may still call)' }, ['∅ Unreachable']);
    b.addEventListener('click', () => actions.unreachable!());
    title.appendChild(b);
  }
  panel.appendChild(title);
  if (state.error) {
    panel.appendChild(html('div', { class: 'ep-status error' }, [state.error]));
    return panel;
  }
  if (!state.entryPoints) {
    panel.appendChild(html('div', { class: 'ep-status' }, ['Searching entry points… (the first time loads the project)']));
    return panel;
  }
  if (!state.entryPoints.length) {
    panel.appendChild(html('div', { class: 'ep-status' }, ['No entry points found (HTTP routes, main / module-level calls, jobs, handlers, tests).']));
    return panel;
  }
  const search = html('input', { type: 'search', class: 'ep-search', placeholder: 'Filter: route, class, method…', 'aria-label': 'Filter entry points' }) as HTMLInputElement;
  search.value = state.filter;
  const list = html('div', { class: 'ep-list', role: 'listbox' });
  const fill = () => {
    list.textContent = '';
    const filtering = state.filter.trim().length > 0;
    // no tick boxes until the user asks to select (nobody can guess what they are for)
    const ticking = !!mapButton && (!!state.selecting || selected.size > 0);
    const tick = (keys: string[], label: string) => {
      const box = html('input', { type: 'checkbox', class: 'ep-check', 'aria-label': `Select ${label} for a map`, title: 'Tick to put this in a codebase map of only the ticked flows (⛶ Map of selected)' }) as HTMLInputElement;
      const n = keys.filter((k) => selected.has(k)).length;
      box.checked = n > 0 && n === keys.length;
      box.indeterminate = n > 0 && n < keys.length;
      // a click on the box selects; the row's own click (open the flow) does not happen
      box.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const on = !(n === keys.length);
        for (const k of keys) {
          if (on) selected.add(k);
          else selected.delete(k);
        }
        fill();
      });
      return box;
    };
    const all = state.entryPoints!;
    const match = (e: EntryPoint) => matchesFilter(e, state.filter, state.outcomes);
    const item = (e: EntryPoint, depth: number, nested: boolean) => {
      const method = methodText(e);
      const route = e.verb ? e.label.slice(e.verb.length).trim() : e.label;
      // under its file, a module-level call is just the call
      const label = e.kind === 'http' ? displayRoute(route) : nested && e.file && route.startsWith(`${e.file}: `) ? route.slice(e.file.length + 2) : route;
      const row = indent(html('button', { type: 'button', class: `ep-item kind-${e.kind}${nested ? ' ep-nested' : ''}`, role: 'option', 'data-method-key': e.method.key, title: `${e.label}\n${method}${e.detail ? ` · ${e.detail}` : ''}${e.file ? `\n${e.file}` : ''}` }, [
        ...(ticking && e.kind !== 'test' ? [tick([entryKey(e)], e.label)] : []),
        e.verb ? html('span', { class: `ep-verb verb-${e.verb.toLowerCase()}` }, [e.verb]) : null,
        html('span', { class: 'ep-label' }, [label]),
        outcomePill(state.outcomes?.[entryKey(e)]),
        label !== method && label !== `${method}()` ? html('span', { class: 'ep-method' }, [method]) : null,
      ]), depth);
      row.addEventListener('click', () => actions.open(e));
      list.appendChild(row);
    };
    /** FR-16.4 one level of the tree (the host's, as the VS Code sidebar shows it); `budget`: rows left in this group. */
    const level = (nodes: EntryPointListNode[], depth: number, budget: { left: number; skipped: number }, kind?: EntryPointKind, project?: string) => {
      for (const n of nodes) {
        const under = entriesBelow(n, all);
        const hits = under.filter(match);
        if (filtering && !hits.length) continue;
        if (n.type === 'entry') {
          if (budget.left-- > 0) item(all[n.index], depth, false);
          else budget.skipped++;
          continue;
        }
        if (n.type === 'group') {
          const g = GROUPS.find((x) => x.kind === n.kind)!;
          const key = project ? `${project}/${n.kind}` : n.kind;
          const open = filtering || (state.open[key] ?? n.kind !== 'test');
          const head = indent(html('button', { type: 'button', class: 'ep-group', 'data-group': n.kind, 'aria-expanded': String(open) }, [
            ...(ticking && n.kind !== 'test' ? [tick(hits.map(entryKey), g.title)] : []),
            `${open ? '▾' : '▸'} ${g.title} `,
            html('span', { class: 'ep-count' }, [filtering ? `${hits.length}/${under.length}` : String(under.length)]),
          ]), depth, 22);
          head.addEventListener('click', () => {
            state.open[key] = !open;
            fill();
          });
          list.appendChild(head);
          if (!open) continue;
          const rows = { left: MAX_ROWS, skipped: 0 };
          level(n.children, depth, rows, n.kind, project);
          if (rows.skipped) list.appendChild(html('div', { class: 'ep-more' }, [`+${rows.skipped} more — refine the filter`]));
          continue;
        }
        if (budget.left <= 0) {
          budget.skipped += hits.length;
          continue;
        }
        // FR-16.8 a project, FR-16.4 a folder of a long group, FR-16.5 one file's module-level calls: opened on click (and while filtering)
        const key = n.type === 'project' ? `project:${n.name}` : n.type === 'folder' ? `folder:${kind}:${n.path}` : n.file;
        const open = filtering || !!(n.type === 'file' ? state.openFiles?.[key] : state.open[key]);
        const text = n.type === 'project' ? n.name : n.type === 'folder' ? (kind === 'http' ? displayRoute(n.label) : n.label) : n.file;
        const count = n.type === 'file' ? `${under.length} calls` : filtering ? `${hits.length}/${under.length}` : String(under.length);
        const title = n.type === 'project' ? `${n.name}: ${under.length} entry points` : n.type === 'folder' ? `${n.path} — ${under.length} entry points` : `${n.file}: ${under.length} calls when the module is loaded`;
        const row = indent(html('button', { type: 'button', class: `ep-item ${n.type === 'project' ? 'ep-project-row' : n.type === 'folder' ? 'ep-folder' : 'ep-file'}`, [n.type === 'file' ? 'data-file' : `data-${n.type}`]: n.type === 'project' ? n.name : n.type === 'folder' ? n.path : n.file, 'aria-expanded': String(open), title }, [
          ...(ticking && (n.type === 'file' || under.some((e) => e.kind !== 'test')) ? [tick(hits.filter((e) => e.kind !== 'test').map(entryKey), text)] : []),
          html('span', { class: 'ep-label' }, [`${open ? '▾' : '▸'} ${text}`]),
          html('span', { class: 'ep-method' }, [count]),
        ]), depth);
        row.addEventListener('click', () => {
          if (n.type === 'file') state.openFiles = { ...state.openFiles, [key]: !open };
          else state.open[key] = !open;
          fill();
        });
        list.appendChild(row);
        if (!open) continue;
        if (n.type === 'file') {
          for (const c of n.children) if (!filtering || match(all[(c as { index: number }).index])) item(all[(c as { index: number }).index], depth + 1, true);
        } else level(n.children, depth + 1, budget, kind, n.type === 'project' && !n.tests ? n.name : project);
      }
    };
    level(state.tree ?? flatTree(all), 0, { left: MAX_ROWS, skipped: 0 });
    // FR-16.15 the project's methods named so: a feature found by name, not only by its entry point
    const found = state.methods;
    if (filtering && found && found.query === methodQuery(state.filter) && actions.openMethod) {
      if (!found.methods) list.appendChild(html('div', { class: 'ep-status ep-methods-status' }, ['Searching the methods…']));
      else if (found.methods.length) {
        list.appendChild(html('div', { class: 'ep-group ep-methods-head' }, ['Methods ', html('span', { class: 'ep-count' }, [`${found.methods.length}${found.more ? '+' : ''}`])]));
        for (const m of found.methods) {
          const name = m.owner.kind === 'module' ? m.name : `${m.owner.name}.${m.name}`;
          const file = m.owner.key.slice(0, m.owner.key.indexOf('#'));
          const row = html('button', { type: 'button', class: 'ep-item ep-method-row', role: 'option', 'data-method-key': m.key, title: `${name}\n${file}\nClick: open its diagram` }, [
            html('span', { class: 'ep-label' }, [name]),
            html('span', { class: 'ep-method' }, [file.replace(/^.*\//, '')]),
          ]);
          row.addEventListener('click', () => actions.openMethod!(m));
          list.appendChild(row);
        }
        if (found.more) list.appendChild(html('div', { class: 'ep-more' }, [`+${found.more} more — refine the filter`]));
      }
    }
    if (!list.childElementCount) list.appendChild(html('div', { class: 'ep-status' }, ['No match']));
    // FR-26.8 the map button follows the ticks, else the filter
    if (mapButton) {
      const ticked = state.entryPoints!.filter((e) => selected.has(entryKey(e)));
      const matching = filtering ? state.entryPoints!.filter((e) => e.kind !== 'test' && match(e)) : [];
      const scope = ticked.length ? ticked : matching;
      mapScope = () => (scope.length ? scope.map(entryKey) : undefined);
      mapButton.textContent = ticked.length ? `⛶ Map of selected (${ticked.length})` : matching.length ? `⛶ Map of ${matching.length} matching` : '⛶ Codebase map';
      mapButton.title = scope.length
        ? `The classes the flows of these ${scope.length} entry points reach, merged, folder by folder (in the class diagram)`
        : 'Codebase map: the classes every entry point reaches, merged, folder by folder (in the class diagram). Tick entry points (or filter) for a map of only them';
      // ✕ (untick all) only while something is ticked
      if (ticked.length) mapButton.after(clearSel);
      else clearSel.remove();
      selectButton.textContent = ticking ? 'Cancel' : '☐ Select for map';
      selectButton.title = ticking ? 'Untick everything and hide the tick boxes' : 'Tick entry points for a codebase map of only their flows';
    }
  };
  clearSel.addEventListener('click', () => {
    selected.clear();
    fill();
  });
  selectButton.addEventListener('click', () => {
    state.selecting = !(state.selecting || selected.size > 0);
    if (!state.selecting) selected.clear();
    fill();
  });
  // FR-16.15 the methods are asked for after a pause in typing (3 letters at least)
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    state.filter = search.value;
    const q = methodQuery(state.filter);
    clearTimeout(timer);
    if (actions.searchMethods && q.length >= 3) {
      timer = setTimeout(() => {
        state.methods = { query: q };
        fill();
        actions.searchMethods!(q);
      }, METHOD_SEARCH_MS);
    }
    fill();
    actions.changed();
  });
  // FR-16.15 the host's answer arrived (the view put it into `state.methods`)
  panel.addEventListener('methods', () => fill());
  // the keyboard: ↓ / ↑ through the rows; Enter in the filter opens the only match
  const rows = () => [...list.querySelectorAll<HTMLElement>('.ep-item')];
  bindListKeys(search, list, rows);
  search.addEventListener('keydown', (e) => {
    const matches = rows().filter((r) => r.hasAttribute('data-method-key'));
    if (e.key !== 'Enter' || matches.length !== 1) return;
    e.preventDefault();
    matches[0].click();
  });
  fill();
  // Select for map beside the filter (the title row is full with the four lists)
  panel.append(mapButton ? html('div', { class: 'ep-search-row' }, [search, selectButton]) : search, list);
  return panel;
}
