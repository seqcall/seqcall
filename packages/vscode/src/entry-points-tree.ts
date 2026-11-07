import * as vscode from 'vscode';
import type { EntryOutcome, EntryPoint, EntryPointKind, EntryPointListNode } from '@seqcall/protocol';
import { appMapEntryKey, displayRoute, entriesUnder, entryOutcomeTags, entryPointTree } from '@seqcall/core';

/** FR-16.4 what the sidebar lists: the project's entry points, or why there are none. */
export type EntryPointsResult = { entryPoints: EntryPoint[]; project?: string } | { error: string };

const GROUPS: { kind: EntryPointKind; title: string; icon: string }[] = [
  { kind: 'http', title: 'HTTP endpoints', icon: 'globe' },
  { kind: 'route', title: 'Pages (client routes)', icon: 'browser' },
  { kind: 'ui', title: 'UI roots', icon: 'window' },
  { kind: 'cli', title: 'Programs & scripts', icon: 'terminal' },
  { kind: 'job', title: 'Background jobs', icon: 'clock' },
  { kind: 'handler', title: 'Handlers', icon: 'mail' },
  { kind: 'test', title: 'Tests', icon: 'beaker' },
];

/** A node of the core's `entryPointTree` (the panel's ⌂ list shows the same tree), with what the sidebar needs. */
export type EntryPointsNode =
  /** FR-16.8 one project of a multi-project root (a solution's .csproj, a monorepo package), its kinds below. */
  | { type: 'project'; name: string; items: EntryPoint[]; /** The test projects together (`Tests`): them below, not the kinds. */ tests?: true; children: EntryPointListNode[] }
  | { type: 'group'; kind: EntryPointKind; title: string; icon: string; items: EntryPoint[]; project?: string; children: EntryPointListNode[] }
  /** Entries sharing a path (`/api/payments`, `tests/Unit · PaymentTest`). */
  | { type: 'folder'; kind: EntryPointKind; label: string; path: string; items: EntryPoint[]; icon: string; children: EntryPointListNode[] }
  | { type: 'entry'; entryPoint: EntryPoint; icon: string; nested?: boolean }
  | { type: 'file'; file: string; entries: EntryPoint[]; icon: string }
  | { type: 'note'; text: string; tooltip?: string; icon: string };

/**
 * FR-16.4 the Seqcall sidebar (activity bar): where flows start, grouped like the panel's ⌂ list; a click opens
 * the flow. Loaded the first time the view is shown (no analysis before), again on ↻ Refresh. Typing filters
 * (VS Code's tree find).
 */
export class EntryPointsTree implements vscode.TreeDataProvider<EntryPointsNode> {
  private readonly changed = new vscode.EventEmitter<EntryPointsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: EntryPointsResult | undefined;
  /** FR-26.8 entry points ticked for a map of only them (`kind|label|methodKey`). */
  readonly selected = new Set<string>();
  /** FR-26.8 the checkboxes show only while selecting entry points for a map. */
  selecting = false;
  private loading: Promise<void> | undefined;
  /** FR-16.10 the list is loaded on request only (Load Entry Points, Go to Entry Point, ↻): until then the welcome. */
  private requested = false;

  constructor(
    private readonly load: () => Promise<EntryPointsResult>,
    /** The command a click on an entry point runs (its argument: the entry point). */
    private readonly openCommand: string,
    /** FR-16.4 the list arrived (or failed): the view's header shows what it lists. */
    private readonly onLoaded: () => void = () => undefined,
    /** FR-32.4 the outcomes known (`kind|label|methodKey`): a row shows its I/O kinds. */
    private readonly outcomes: () => Record<string, EntryOutcome> = () => ({}),
  ) {}

  /** FR-26.8 checkboxes on (selecting entry points for a map) or off. */
  setSelecting(on: boolean): void {
    this.selecting = on;
    this.changed.fire(undefined);
  }

  /** FR-26.8 the checkboxes again (the list itself unchanged). */
  refreshItems(): void {
    this.changed.fire(undefined);
  }

  refresh(): void {
    this.result = undefined;
    this.loading = undefined;
    this.changed.fire(undefined);
  }

  /** FR-16.10 the user asked for the list (Load Entry Points, ↻): it loads now and again after each refresh. */
  request(): void {
    this.requested = true;
    this.refresh();
  }

  /** Whether the list was asked for (the welcome shows until then). */
  isRequested(): boolean {
    return this.requested;
  }

  /** FR-16.4 what is listed: the project's name and the number of entry points (undefined until loaded). */
  summary(): { project?: string; count: number } | undefined {
    const r = this.result;
    return r && !('error' in r) ? { project: r.project, count: r.entryPoints.length } : undefined;
  }

  /** FR-16.9 the listed entry points (loaded first when needed), or why there are none. */
  async entryPoints(): Promise<EntryPointsResult> {
    if (!this.requested) {
      // Go to Entry Point asks for the list: the sidebar shows it from now on
      this.requested = true;
      this.changed.fire(undefined);
    }
    await this.ensureLoaded();
    return this.result!;
  }

  /** The top-level nodes once loaded (for tests). */
  async roots(): Promise<EntryPointsNode[]> {
    this.requested = true;
    await this.ensureLoaded();
    return this.nodes();
  }

  /** FR-26.8 ticks a node (an entry, or every entry of a group / file) on or off. */
  setChecked(n: EntryPointsNode, on: boolean): void {
    for (const e of entriesOf(n)) {
      if (e.kind === 'test') continue;
      if (on) this.selected.add(mapKey(e));
      else this.selected.delete(mapKey(e));
    }
  }

  /** FR-26.8 the ticked entry points that still exist. */
  selection(): string[] {
    const r = this.result;
    if (!r || 'error' in r) return [];
    return r.entryPoints.map(mapKey).filter((k) => this.selected.has(k));
  }

  private checkbox(entries: EntryPoint[]): vscode.TreeItemCheckboxState | undefined {
    const own = entries.filter((e) => e.kind !== 'test');
    if (!own.length) return undefined;
    return own.every((e) => this.selected.has(mapKey(e))) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  }

  getTreeItem(n: EntryPointsNode): vscode.TreeItem {
    const item = this.item(n);
    const state = n.type === 'note' || !this.selecting ? undefined : this.checkbox(entriesOf(n));
    if (state !== undefined) item.checkboxState = state;
    return item;
  }

  private item(n: EntryPointsNode): vscode.TreeItem {
    if (n.type === 'project') {
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Collapsed);
      const kinds = GROUPS.map((g) => ({ g, n: n.items.filter((e) => e.kind === g.kind).length })).filter((x) => x.n);
      item.description = String(n.items.length);
      item.tooltip = `${n.name}: ${kinds.map((x) => `${x.n} ${x.g.title.toLowerCase()}`).join(', ')}`;
      item.iconPath = new vscode.ThemeIcon(kinds.every((x) => x.g.kind === 'test') ? 'beaker' : 'project');
      item.id = `project:${n.tests ? '*' : ''}${n.name}`;
      if (n.tests) item.tooltip = `${n.children.length} test projects, ${n.items.length} tests`;
      return item;
    }
    if (n.type === 'group') {
      const item = new vscode.TreeItem(n.title, n.kind === 'test' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(n.items.length);
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.id = `group:${n.project ?? ''}:${n.kind}`;
      return item;
    }
    if (n.type === 'folder') {
      const item = new vscode.TreeItem(n.kind === 'http' ? displayRoute(n.label) : n.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(n.items.length);
      item.tooltip = `${n.path} — ${n.items.length} entry points`;
      item.iconPath = new vscode.ThemeIcon(n.icon);
      item.id = `folder:${n.kind}:${n.path}`;
      return item;
    }
    if (n.type === 'file') {
      // FR-16.5 a file's module-level calls together
      const item = new vscode.TreeItem(n.file.split('/').pop()!, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${n.entries.length} calls · ${n.file}`;
      item.tooltip = `${n.file}: ${n.entries.length} calls when the module is loaded`;
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.id = `file:${n.file}`;
      return item;
    }
    if (n.type === 'note') {
      const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(n.icon);
      if (n.tooltip) item.tooltip = n.tooltip;
      return item;
    }
    const ep = n.entryPoint;
    // a module-level function is just its name (`productByIdDeleteRoute`, not `delete.route.productById…`)
    const method = ep.method.owner.kind === 'module' ? ep.method.name : `${ep.method.owner.name}.${ep.method.name}`;
    // under its file, a module-level call is just the call
    const label = n.nested && ep.file && ep.label.startsWith(`${ep.file}: `) ? ep.label.slice(ep.file.length + 2) : ep.label;
    // a route as the panel writes it; the tooltip keeps it in full
    const item = new vscode.TreeItem(ep.kind === 'http' ? displayRoute(label) : label, vscode.TreeItemCollapsibleState.None);
    // HTTP: the route is the label, the handler method beside it; others: the method is the label
    // FR-32.4 its flow's I/O once known (`DB·HTTP+`: there may be more)
    const io = entryOutcomeTags(this.outcomes()[appMapEntryKey(ep)]);
    const beside = ep.label === method ? ep.detail : method;
    item.description = io ? [beside, io].filter(Boolean).join('  ') : beside;
    item.tooltip = [ep.label, method, ep.detail, io && `I/O of its whole flow: ${io}`].filter((x, i, a) => x && a.indexOf(x) === i).join('\n');
    item.iconPath = new vscode.ThemeIcon(n.icon);
    item.id = `entry:${ep.kind}:${ep.method.key}:${ep.label}`;
    item.command = { command: this.openCommand, title: 'Open the flow', arguments: [ep] };
    return item;
  }

  async getChildren(n?: EntryPointsNode): Promise<EntryPointsNode[]> {
    if (n?.type === 'project') return n.children.map((c) => this.node(c, n.tests ? undefined : n.name));
    if (n?.type === 'group' || n?.type === 'folder') return n.children.map((c) => this.node(c, undefined, n.kind));
    if (n?.type === 'file') return n.entries.map((entryPoint) => ({ type: 'entry', entryPoint, icon: n.icon, nested: true }));
    if (n) return [];
    // FR-16.10 nothing is scanned until asked (the view's welcome has the button)
    if (!this.result && !this.requested) return [];
    if (!this.result) {
      // the first look starts the analysis; the list arrives with a refresh of the tree
      void this.ensureLoaded().then(() => this.changed.fire(undefined));
      return [{ type: 'note', text: 'Finding entry points…', icon: 'loading~spin' }];
    }
    return this.nodes();
  }

  private ensureLoaded(): Promise<void> {
    this.loading ??= this.load()
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        this.result = r;
        this.onLoaded();
      });
    return this.loading;
  }

  private nodes(): EntryPointsNode[] {
    const r = this.result;
    if (!r) return [];
    if ('error' in r) return [{ type: 'note', text: r.error, tooltip: r.error, icon: 'warning' }];
    if (!r.entryPoints.length) return [{ type: 'note', text: 'No entry points found', tooltip: 'No HTTP routes, programs, jobs, handlers or tests were recognised in this project.', icon: 'info' }];
    // FR-16.8 several projects (a solution, a monorepo): the projects first — applications by name, test-only ones after
    // (several test projects — a solution's UnitTests.* / IntegrationTests.* — under one Tests node)
    return entryPointTree(r.entryPoints, r.project).map((t) => this.node(t));
  }

  /** A node of the core's tree as the sidebar's (its entry points, icon, title); `kind`: the group it is in. */
  private node(t: EntryPointListNode, project?: string, kind?: EntryPointKind): EntryPointsNode {
    const list = (this.result as { entryPoints: EntryPoint[] }).entryPoints;
    const icon = GROUPS.find((g) => g.kind === kind)?.icon ?? '';
    if (t.type === 'project') return { type: 'project', name: t.name, items: entriesUnder(t, list), ...(t.tests ? { tests: true as const } : {}), children: t.children };
    if (t.type === 'group') return { type: 'group', ...GROUPS.find((g) => g.kind === t.kind)!, items: entriesUnder(t, list), ...(project ? { project } : {}), children: t.children };
    if (t.type === 'folder') return { type: 'folder', kind: kind!, label: t.label, path: t.path, items: entriesUnder(t, list), icon: t.leaf ? 'symbol-class' : 'folder', children: t.children };
    if (t.type === 'file') return { type: 'file', file: t.file, entries: entriesUnder(t, list), icon };
    return { type: 'entry', entryPoint: list[t.index], icon };
  }
}

/** FR-26.8 how a map selection names an entry point (the core's `appMapEntryKey`). */
export function mapKey(e: EntryPoint): string {
  return `${e.kind}|${e.label}|${e.method.key}`;
}

function entriesOf(n: EntryPointsNode): EntryPoint[] {
  if (n.type === 'group' || n.type === 'folder' || n.type === 'project') return n.items;
  if (n.type === 'file') return n.entries;
  if (n.type === 'entry') return [n.entryPoint];
  return [];
}
