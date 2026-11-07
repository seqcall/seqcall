/**
 * FR-16.4 / FR-16.5 how a list of entry points of one kind is shown as a tree (the VS Code sidebar): module-level
 * calls of one file under the file, a long list in folders. Editor-agnostic (no icons).
 */
import type { EntryOutcome, EntryPoint, EntryPointKind, EntryPointListNode } from '@seqcall/protocol';
import { appMapEntryKey } from './session';
import { SIDE_EFFECT_LABEL } from './side-effects';

/**
 * a route as every list shows it: parameters without their constraint (`/v{version:apiVersion}` →
 * `/v{version}`, `{id?}` → `{id}`). The webview has the same rule (`sequence/entry-points.ts`), it cannot import core.
 */
export function displayRoute(route: string): string {
  return route.replace(/\{(\*?\w+)(?::[^{}]+|\?)?\}/g, '{$1}');
}

/** A group with more entries than this is shown in folders (route path, test folder / class). */
export const FOLDER_ABOVE = 25;

export type EntryPointTreeNode =
  /** Entries sharing the path segments up to `depth` (`/api/payments`; `tests/Unit` → `PaymentTest`); `leaf`: a class / file. */
  | { type: 'folder'; label: string; path: string; depth: number; items: EntryPoint[]; leaf: boolean }
  | { type: 'file'; file: string; entries: EntryPoint[] }
  | { type: 'entry'; entryPoint: EntryPoint };

/**
 * FR-16.4 a long group in folders: more than FOLDER_ABOVE entries are split by their next path segment — the
 * route's (`/api` → `/payments`) for HTTP endpoints and pages, the file's folders then the class for the others;
 * a parameter that ends a route (`{id}`, `:id`; for pages `:id` only) is no folder, a folder with one entry is that entry, a chain of single sub-folders
 * is one folder (`/api/v1`), a level where everything would go into one folder is skipped. Entries without a
 * further segment come after the folders. Shorter groups: module-level calls by file (FR-16.5).
 */
export function entryPointFolders(kind: EntryPointKind, items: EntryPoint[], depth = 0, prefix = ''): EntryPointTreeNode[] {
  const leaves = (list: EntryPoint[]): EntryPointTreeNode[] => (kind === 'cli' ? byFile(list) : list.map((entryPoint) => ({ type: 'entry', entryPoint })));
  if (items.length <= FOLDER_ABOVE) return leaves(items);
  const url = kind === 'http' || kind === 'route';
  const join = (parts: string[]) => (url ? `/${parts.join('/')}` : parts.join('/'));
  const segs = new Map(items.map((e) => [e, segmentsOf(e)]));
  const groups = new Map<string, EntryPoint[]>();
  const rest: EntryPoint[] = [];
  for (const e of items) {
    const s = segs.get(e)![depth];
    // a parameter that ends the route is the entry itself (`/catalog/{id}`); one followed by more segments
    // (`/shop/:shopId/products/…`) is text the routes below share, a folder like any other
    if (s === undefined || (isParam(kind, s) && segs.get(e)!.length === depth + 1)) rest.push(e);
    else groups.set(s, [...(groups.get(s) ?? []), e]);
  }
  const folders: Extract<EntryPointTreeNode, { type: 'folder' }>[] = [];
  for (const [seg, list] of groups) {
    if (list.length === 1) {
      rest.push(list[0]);
      continue;
    }
    // a chain of single sub-folders is one folder: /api → /api/v1 while every entry goes on the same way
    const parts = [seg];
    let d = depth + 1;
    for (;;) {
      const next = segs.get(list[0])![d];
      if (next === undefined || !list.every((e) => segs.get(e)![d] === next && !(isParam(kind, next) && segs.get(e)!.length === d + 1))) break;
      parts.push(next);
      d++;
    }
    // a class / file is the last segment (shown as such)
    const leaf = !url && list.every((e) => segs.get(e)!.length === d);
    folders.push({ type: 'folder', label: join(parts), path: prefix ? `${prefix}${url ? '' : '/'}${join(parts)}` : join(parts), depth: d, items: list, leaf });
  }
  // everything in one folder: skip the level (its path is in the deeper folders' paths)
  if (folders.length === 1 && !rest.length) return entryPointFolders(kind, items, folders[0].depth, folders[0].path);
  folders.sort((a, b) => a.label.localeCompare(b.label));
  // loose entries in the list's order (sorted by the adapter)
  const order = new Map(items.map((e, i) => [e, i]));
  return [...folders, ...leaves(rest.sort((a, b) => order.get(a)! - order.get(b)!))];
}

/** FR-16.4 the path an entry point is filed under: the route's segments, else its file's folders and its class. */
function segmentsOf(e: EntryPoint): string[] {
  if (e.kind === 'http' || e.kind === 'route') return (e.kind === 'http' ? e.label.slice(e.label.indexOf(' ') + 1) : e.label).split('/').filter(Boolean);
  const file = e.method.key.slice(0, e.method.key.indexOf('#'));
  const dirs = file.split('/').slice(0, -1);
  return e.method.owner.kind === 'module' ? [...dirs, file.split('/').pop()!] : [...dirs, e.method.owner.name];
}

/**
 * A route parameter is no folder: `{id}` / `:id` / `*` in HTTP routes; in React pages only `:id` / `*` / `$id` (TanStack) — there `{x}`
 * is a template part shown by name (`` `${accountPath}/bank` `` → `/{accountPath}/bank`, FR-16.6), a fixed prefix.
 */
const isParam = (kind: EntryPointKind, s: string) => (kind === 'route' ? /^[:*$]/ : /^[{:*]/).test(s);

/** FR-16.5 module-level calls of one file under the file (when it has more than one), in list order. */
export function byFile(list: EntryPoint[]): EntryPointTreeNode[] {
  const count = new Map<string, number>();
  for (const e of list) if (e.file) count.set(e.file, (count.get(e.file) ?? 0) + 1);
  const out: EntryPointTreeNode[] = [];
  const files = new Map<string, EntryPoint[]>();
  for (const e of list) {
    // every file of the list is counted above
    if (!e.file || count.get(e.file)! < 2) {
      out.push({ type: 'entry', entryPoint: e });
      continue;
    }
    let entries = files.get(e.file);
    if (!entries) {
      files.set(e.file, (entries = []));
      out.push({ type: 'file', file: e.file, entries });
    }
    entries.push(e);
  }
  return out;
}

/** FR-16.8 a project of a multi-project root with its entry points; `projects`: the test projects held together. */
export interface EntryPointProject {
  name: string;
  items: EntryPoint[];
  projects?: { name: string; items: EntryPoint[] }[];
}

/**
 * FR-16.8 the projects first when the entry points name them (`withProjects`): applications by name, then the
 * test-only projects — several of them together under one `Tests` project. Undefined for a single project.
 */
export function entryPointProjects(list: EntryPoint[], fallback = 'project'): EntryPointProject[] | undefined {
  if (!list.some((e) => e.project)) return undefined;
  const by = new Map<string, EntryPoint[]>();
  for (const e of list) by.set(e.project ?? fallback, [...(by.get(e.project ?? fallback) ?? []), e]);
  const all = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ name, items }));
  const testsOnly = (p: { items: EntryPoint[] }) => p.items.every((e) => e.kind === 'test');
  const tests = all.filter(testsOnly);
  return [...all.filter((p) => !testsOnly(p)), ...(tests.length > 1 ? [{ name: 'Tests', items: tests.flatMap((p) => p.items), projects: tests }] : tests)];
}

/**
 * FR-16.9 does an entry point match a search: every word (case-insensitive) somewhere in its label, `Class.method`,
 * detail or project (`shop delete` → `DELETE /api/shop/delete-product` in ShopApi). The panel's ⌂ list
 * matches the same way (webview `matchesFilter`).
 */
export function entryPointMatches(e: EntryPoint, query: string, outcomes?: Record<string, EntryOutcome>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.label} ${e.method.owner.name}.${e.method.name} ${e.detail ?? ''} ${e.project ?? ''}`.toLowerCase();
  // FR-32.4 `has:http` (a kind or its tag), `has:io` (any): the known outcome does that I/O (unknown: no match)
  const kinds = outcomes?.[appMapEntryKey(e)]?.kinds;
  const has = (w: string) => !!kinds?.some((k) => w === 'io' || w === k || w === SIDE_EFFECT_LABEL[k].toLowerCase());
  return words.every((w) => (w.startsWith('has:') ? has(w.slice(4)) : hay.includes(w)));
}

/** FR-32.4 an entry point's I/O in a list row: `DB·HTTP+` (`+`: there may be more); empty while unknown or without I/O. */
export function entryOutcomeTags(o: EntryOutcome | undefined): string {
  return o?.kinds.length ? `${o.kinds.map((k) => SIDE_EFFECT_LABEL[k]).join('·')}${o.atLeast ? '+' : ''}` : '';
}

/** FR-16.2 the kinds in list order (both lists). */
export const ENTRY_POINT_KINDS: EntryPointKind[] = ['http', 'route', 'ui', 'cli', 'job', 'handler', 'test'];

const VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** FR-16.1 HTTP endpoints by path, then verb (a resource's endpoints together); others by label. */
export function sortForDisplay(list: EntryPoint[]): EntryPoint[] {
  const path = (e: EntryPoint) => (e.verb ? e.label.slice(e.verb.length).trim() : e.label).toLowerCase();
  const verb = (e: EntryPoint) => (e.verb ? VERB_ORDER.indexOf(e.verb) + 1 || 99 : 0);
  return [...list].sort((a, b) => path(a).localeCompare(path(b)) || verb(a) - verb(b));
}

/**
 * FR-16.4 the whole list as both lists show it (the VS Code sidebar walks it, the panel's ⌂ list gets it with the
 * entry points): projects first (FR-16.8), then the kinds, each sorted for display and in folders when long.
 */
export function entryPointTree(list: EntryPoint[], project?: string): EntryPointListNode[] {
  const index = new Map(list.map((e, i) => [e, i]));
  const entry = (e: EntryPoint): EntryPointListNode => ({ type: 'entry', index: index.get(e)! });
  const nodes = (kind: EntryPointKind, xs: EntryPointTreeNode[]): EntryPointListNode[] =>
    xs.map((x) =>
      x.type === 'entry'
        ? entry(x.entryPoint)
        : x.type === 'file'
          ? { type: 'file', file: x.file, children: x.entries.map(entry) }
          : { type: 'folder', label: x.label, path: x.path, ...(x.leaf ? { leaf: true as const } : {}), children: nodes(kind, entryPointFolders(kind, x.items, x.depth, x.path)) },
    );
  const groups = (items: EntryPoint[]): EntryPointListNode[] =>
    ENTRY_POINT_KINDS.flatMap((kind) => {
      const of = sortForDisplay(items.filter((e) => e.kind === kind));
      return of.length ? [{ type: 'group' as const, kind, children: nodes(kind, entryPointFolders(kind, of)) }] : [];
    });
  const projects = entryPointProjects(list, project);
  if (!projects) return groups(list);
  return projects.map((p) =>
    p.projects ? { type: 'project', name: p.name, tests: true, children: p.projects.map((q) => ({ type: 'project' as const, name: q.name, children: groups(q.items) })) } : { type: 'project', name: p.name, children: groups(p.items) },
  );
}

/** The entry points below a node of `entryPointTree`, in list order. */
export function entriesUnder(n: EntryPointListNode, list: EntryPoint[]): EntryPoint[] {
  return n.type === 'entry' ? [list[n.index]] : n.children.flatMap((c) => entriesUnder(c, list));
}
