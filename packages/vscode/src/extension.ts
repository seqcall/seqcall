import * as vscode from 'vscode';
import type { HostToClassView, HostToSequenceView, SequenceViewToHost, ClassViewToHost, DiffTarget, EntryPoint, Position } from '@seqcall/protocol';
import { CLASS_VIEW_TYPE, Controller, SEQUENCE_VIEW_TYPE } from './controller';
import { EntryPointsTree, type EntryPointsNode } from './entry-points-tree';
import { DesignIssuesTree, ReviewTree, type SidebarAction, type SidebarNode } from './sidebar-views';
import { fromProtocolPath } from './paths';
import { entryPointSearch, SEARCH_MAX } from './entry-point-search';
import { isSourceFile, isSupportedDocument, toProtocolPath } from './paths';
import { checkAutomatically, checkManually, registerUpdater } from './updater';
import { dialogs } from './dialogs';
import { SeqcallHoverProvider, HOVER_SELECTOR, OPEN_FROM_HOVER, OPEN_REACH } from './hover';
import type { CheckResult, UpdateDeps } from '@seqcall/core';

const SELECTION_DEBOUNCE_MS = 400;
const REFRESH_DEBOUNCE_MS = 300;

/** Small API returned from activate() so extension-host tests can drive the glue. */
export interface SeqcallTestApi {
  getSequencePanel(): vscode.WebviewPanel | undefined;
  getClassPanel(): vscode.WebviewPanel | undefined;
  /** Every message the host sent (or queued) to the sequence view, oldest first. */
  sequenceMessages(): HostToSequenceView[];
  classMessages(): HostToClassView[];
  readonly lastPostedMessage: HostToSequenceView | undefined;
  simulateViewMessage(msg: SequenceViewToHost): Promise<void>;
  simulateClassViewMessage(msg: ClassViewToHost): Promise<void>;
  /**
   * Resolves once no background work runs (cursor / file / config / setting reactions, I/O scans), no debounce
   * is pending and nothing was posted to the views for `quietMs` — a render counted after it belongs to the next action.
   */
  settled(quietMs?: number): Promise<void>;
  /** Lines written to the "Seqcall" output channel (incl. view diagnostics). */
  logs(): { level: 'info' | 'error'; message: string }[];
  /** FR-24.7 opens the base ↔ now diff editor of a reviewed call. */
  showBaseDiff(target: DiffTarget): Promise<void>;
  /** FR-16.4 the sidebar's top-level nodes (loads the entry points). */
  entryPointsTree(): Promise<EntryPointsNode[]>;
  /** FR-26.8 ticks exactly these entry points in the sidebar (as the checkboxes would). */
  entryPointsSelect(keys: string[]): void;
  entryPointsSelection(): string[];
  /** FR-16.4 a node's children and tree item (folders, checkboxes), the header, the projects and the chosen one. */
  entryPointsChildren(node: EntryPointsNode): Promise<EntryPointsNode[]>;
  /** FR-19.12 / FR-24.14 the sidebar's Design Issues and Review views: their rows and the line on top. */
  designIssues(): { roots: SidebarNode[]; message: string | undefined };
  /** Feeds the Design Issues view a scan result (the fixture has no issues to scan for). */
  showDesignIssues(msg: Extract<HostToSequenceView, { type: 'projectFindings' }>): void;
  review(): { roots: SidebarNode[]; message: string | undefined };
  /** Feeds the Review view a result (the fixture's branch has no changes). */
  showReview(msg: Extract<HostToSequenceView, { type: 'review' }>): void;
  entryPointsItem(node: EntryPointsNode): vscode.TreeItem;
  entryPointsHeader(): string | undefined;
  /** FR-16.10 the sidebar's list was asked for; the background load of a project (undefined: none running). */
  entryPointsRequested(): boolean;
  preloadOf(root: string): Promise<void> | undefined;
  workspaceProjects(): { root: string; language: string }[];
  setEntryPointsProject(project: { root: string; language: 'typescript' | 'csharp' | 'php' } | undefined): void;
  /** FR-30.2 Check for Updates with parts of the GitHub side replaced (sign-in, fetch, install, confirm). */
  checkForUpdates(overrides: Partial<UpdateDeps>): Promise<CheckResult | undefined>;
  /** FR-30.1 the automatic check (the test host is no installed extension: it is not scheduled there). */
  checkForUpdatesAutomatically(overrides: Partial<UpdateDeps>): Promise<CheckResult | undefined>;
  /** The extension's global state (FR-30.1 when the last check was). */
  globalState(): vscode.Memento;
  /** The notifications, pickers and save dialogs: replace one to answer it. */
  dialogs: typeof dialogs;
  /** FR-13.2 a sequence panel VS Code restored after a restart. */
  restoreSequencePanel(panel: vscode.WebviewPanel): Promise<void>;
}

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): SeqcallTestApi {
  const ctl = new Controller(context);
  controller = ctl;
  context.subscriptions.push(ctl);

  context.subscriptions.push(
    // a URI argument (editor context / title menus, or a caller naming the file) picks that document's editor
    vscode.commands.registerCommand('seqcall.showSequenceDiagram', (uri?: unknown) =>
      ctl.showSequenceDiagram(uri instanceof vscode.Uri ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString()) : undefined),
    ),
    vscode.commands.registerCommand('seqcall.showClassDiagram', () => ctl.showClassDiagram()),
    // FR-33 the editor's hover and its links
    vscode.languages.registerHoverProvider(HOVER_SELECTOR, new SeqcallHoverProvider(ctl.sessions, (message) => ctl.log('error', message))),
    // FR-34 memory
    vscode.commands.registerCommand('seqcall.showMemory', () => ctl.showMemory()),
    vscode.commands.registerCommand('seqcall.freeMemory', () => ctl.freeMemory()),
    vscode.commands.registerCommand(OPEN_REACH, (file: string, position: Position, word: string, index?: number) => ctl.openReach(file, position, word, index ?? undefined)),
    vscode.commands.registerCommand(OPEN_FROM_HOVER, (file: string, position: Position, panel?: 'paths') => ctl.openFromHover(file, position, panel)),
    vscode.commands.registerCommand('seqcall.showEntryPoints', () => ctl.sendEntryPoints(true)),
    vscode.commands.registerCommand('seqcall.showCodebaseMap', () => ctl.showAppMap()),
    vscode.commands.registerCommand('seqcall.toggleFollowCursor', () => ctl.toggleFollowCursor()),
    vscode.commands.registerCommand('seqcall.find', () => ctl.find()),
    vscode.commands.registerCommand('seqcall.reviewChanges', () => ctl.sendReview(true)),
    // FR-25.2 a diagram's state to share / a shared one to open
    vscode.commands.registerCommand('seqcall.copyDiagramState', () => ctl.copyState()),
    vscode.commands.registerCommand('seqcall.openDiagramState', () => ctl.openStateFromClipboard()),
  );

  // FR-16.4 the Seqcall sidebar: entry points, loaded the first time the view is shown
  // eslint-disable-next-line prefer-const
  let treeView: vscode.TreeView<EntryPointsNode>;
  // FR-16.4 a line on top of the list says what is listed (`shop · 1434 entry points`), FR-26.8 and how many
  // are ticked — the view's message: its description is not shown while it is the container's only view
  const showSelection = () => {
    const n = tree.selection().length;
    const s = tree.summary();
    const parts = [s ? `${s.project ?? 'project'} · ${s.count} entry point${s.count === 1 ? '' : 's'}` : '', n ? `${n} selected` : ''].filter(Boolean);
    if (treeView) treeView.message = parts.join(' · ') || undefined;
    void vscode.commands.executeCommand('setContext', 'seqcall.entryPointsSelected', n > 0);
  };
  const tree = new EntryPointsTree(
    () => ctl.loadEntryPoints(),
    'seqcall.openEntryPoint',
    () => {
      showSelection();
      // Switch Project only where there is a choice
      void vscode.commands.executeCommand('setContext', 'seqcall.severalProjects', ctl.workspaceProjects().length > 1);
    },
    () => ctl.entryOutcomes(),
  );
  // FR-32.4 rows show the outcomes known (a flow opened, the project scan)
  ctl.onOutcomes = () => tree.refreshItems();
  treeView = vscode.window.createTreeView('seqcall.entryPoints', { treeDataProvider: tree, showCollapseAll: true });
  const selecting = (on: boolean) => {
    tree.setSelecting(on);
    void vscode.commands.executeCommand('setContext', 'seqcall.selectingForMap', on);
  };
  context.subscriptions.push(
    treeView,
    treeView.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) tree.setChecked(node, state === vscode.TreeItemCheckboxState.Checked);
      showSelection();
    }),
    vscode.commands.registerCommand('seqcall.mapOfSelectedEntryPoints', () => ctl.showAppMap(tree.selection())),
    vscode.commands.registerCommand('seqcall.clearEntryPointSelection', () => {
      tree.selected.clear();
      tree.refreshItems();
      showSelection();
    }),
    vscode.commands.registerCommand('seqcall.openEntryPoint', (ep: EntryPoint) => ctl.openEntryPointFromSidebar(ep)),
    vscode.commands.registerCommand('seqcall.refreshEntryPoints', () => tree.request()),
    // FR-16.10 the list on request (the view's welcome button)
    vscode.commands.registerCommand('seqcall.loadEntryPoints', () => tree.request()),
    // FR-26.8 checkboxes only while selecting for a map
    vscode.commands.registerCommand('seqcall.selectEntryPointsForMap', () => selecting(true)),
    vscode.commands.registerCommand('seqcall.doneSelectingEntryPoints', () => selecting(false)),
    // FR-16.9 Go to Entry Point…: every entry point of the listed project, searched, Enter opens its flow
    vscode.commands.registerCommand('seqcall.goToEntryPoint', async () => {
      const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { entryPoint?: EntryPoint }>();
      qp.title = 'Go to Entry Point';
      qp.placeholder = 'Words of the route, Class.method, kind or project (e.g. "operator delete"); has:db, has:http … once known';
      qp.matchOnDescription = true;
      qp.busy = true;
      qp.show();
      const r = await tree.entryPoints();
      qp.busy = false;
      if ('error' in r) {
        qp.items = [{ label: `$(warning) ${r.error}`, alwaysShow: true }];
        return;
      }
      if (r.project) qp.title = `Go to Entry Point · ${r.project} · ${r.entryPoints.length}`;
      // own matching (all words anywhere, as the panel's search): VS Code's filter is not applied (alwaysShow)
      const show = () => {
        const { items, total } = entryPointSearch(r.entryPoints, qp.value, ctl.entryOutcomes());
        qp.items = [
          ...items.map((i) => ({ ...i, alwaysShow: true })),
          ...(total > SEARCH_MAX ? [{ label: `$(ellipsis) ${total - SEARCH_MAX} more — refine the search`, alwaysShow: true }] : []),
          ...(!total ? [{ label: 'No entry point matches', alwaysShow: true }] : []),
        ];
      };
      show();
      qp.onDidChangeValue(show);
      qp.onDidAccept(() => {
        const ep = qp.selectedItems[0]?.entryPoint;
        if (!ep) return;
        qp.hide();
        void ctl.openEntryPointFromSidebar(ep);
      });
      qp.onDidHide(() => qp.dispose());
    }),
    // FR-16.4 which project's entry points; the list follows the open diagram unless one was chosen
    vscode.commands.registerCommand('seqcall.switchEntryPointsProject', async () => {
      if (await ctl.chooseEntryPointsProject()) tree.request(); // a chosen project: its list
    }),
    ctl.onDidChangeEntryPointsProject.event(() => tree.refresh()),
  );

  // FR-19.12 / FR-24.14 Design Issues and Review views: empty until asked, results from wherever they were asked
  const setContext = (key: string, value: unknown) => void vscode.commands.executeCommand('setContext', key, value);
  // eslint-disable-next-line prefer-const
  let issuesView: vscode.TreeView<SidebarNode>, reviewView: vscode.TreeView<SidebarNode>;
  const issues = new DesignIssuesTree(() => {
    if (issuesView) issuesView.message = issues.message;
    setContext('seqcall.designIssues', issues.status() ?? 'none');
  });
  const review = new ReviewTree(() => {
    if (reviewView) reviewView.message = review.message;
    setContext('seqcall.review', review.status() ?? 'none');
  });
  issuesView = vscode.window.createTreeView('seqcall.designIssues', { treeDataProvider: issues, showCollapseAll: true });
  reviewView = vscode.window.createTreeView('seqcall.review', { treeDataProvider: review, showCollapseAll: true });
  setContext('seqcall.designIssues', 'none');
  setContext('seqcall.review', 'none');
  const reviewAgain = (force: boolean) => {
    const { base, mode } = ctl.reviewSettings();
    return ctl.sendReview(false, base, force, mode, true);
  };
  context.subscriptions.push(
    issuesView,
    reviewView,
    ctl.onProjectFindings.event((m) => issues.onMessage(m)),
    ctl.onReview.event((m) => review.onMessage(m)),
    ctl.onReviewEnded.event(() => review.clear()),
    vscode.commands.registerCommand('seqcall.sidebarOpen', async (a: SidebarAction) => {
      if (a.kind === 'file') await vscode.window.showTextDocument(fromProtocolPath(a.path), { preview: true });
      else await ctl.fromSidebar(a.msg);
    }),
    vscode.commands.registerCommand('seqcall.showUnreachable', () => ctl.sendUnreachable(true)),
    vscode.commands.registerCommand('seqcall.scanDesignIssues', () => ctl.sendProjectFindings(false, false, true)),
    vscode.commands.registerCommand('seqcall.rescanDesignIssues', () => ctl.sendProjectFindings(false, true, true)),
    vscode.commands.registerCommand('seqcall.cancelDesignIssues', () => ctl.cancelProjectScan()),
    vscode.commands.registerCommand('seqcall.reviewBranch', () => reviewAgain(false)),
    vscode.commands.registerCommand('seqcall.rerunReview', () => reviewAgain(true)),
    vscode.commands.registerCommand('seqcall.reviewCompareWith', () => ctl.chooseReviewBase()),
    vscode.commands.registerCommand('seqcall.cancelReviewFromSidebar', () => ctl.cancelReview()),
    vscode.commands.registerCommand('seqcall.endReview', () => ctl.fromSidebar({ type: 'endReview' })),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
  );

  // FR-30 updates from the GitHub releases
  registerUpdater(context, (level, message) => ctl.log(level, message));

  // FR-16.10 load the project in the background (after startup; setting seqcall.preloadProject)
  const preloadTimer = setTimeout(() => void ctl.track(ctl.preload()), 1000);
  context.subscriptions.push({ dispose: () => clearTimeout(preloadTimer) });

  // FR-13.2: restore panels after a window reload.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SEQUENCE_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => ctl.restoreSequencePanel(panel),
    }),
    vscode.window.registerWebviewPanelSerializer(CLASS_VIEW_TYPE, {
      deserializeWebviewPanel: (panel) => ctl.restoreClassPanel(panel),
    }),
  );

  // FR-1.7 / FR-2.4: react to cursor moves (debounced).
  let selectionTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isSupportedDocument(e.textEditor.document)) return;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        selectionTimer = undefined;
        if (vscode.window.activeTextEditor === e.textEditor) void ctl.track(ctl.onSelectionChanged(e.textEditor));
      }, SELECTION_DEBOUNCE_MS);
    }),
    { dispose: () => selectionTimer && clearTimeout(selectionTimer) },
  );

  // FR-13.1: refresh on save and on external file changes (deduplicated, debounced).
  const pending = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    const file = toProtocolPath(uri);
    if (!isSourceFile(file)) return;
    pending.add(file);
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const files = [...pending];
      pending.clear();
      void ctl.track(ctl.refreshFiles(files));
    }, REFRESH_DEBOUNCE_MS);
  };
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,cs,php}');
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/.seqcall.json');
  const onConfigFile = (uri: vscode.Uri) => void ctl.track(ctl.reloadClassifierConfig(toProtocolPath(uri)));
  context.subscriptions.push(
    sourceWatcher,
    configWatcher,
    vscode.workspace.onDidSaveTextDocument((doc) => scheduleRefresh(doc.uri)),
    sourceWatcher.onDidChange(scheduleRefresh),
    sourceWatcher.onDidCreate(scheduleRefresh),
    sourceWatcher.onDidDelete(scheduleRefresh),
    configWatcher.onDidChange(onConfigFile),
    configWatcher.onDidCreate(onConfigFile),
    configWatcher.onDidDelete(onConfigFile),
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
    vscode.workspace.onDidChangeConfiguration((e) => void ctl.track(ctl.onConfigurationChanged(e))),
  );

  return {
    entryPointsTree: () => tree.roots(),
    entryPointsSelect: (keys: string[]) => {
      tree.selected.clear();
      for (const k of keys) tree.selected.add(k);
      showSelection();
    },
    entryPointsSelection: () => tree.selection(),
    entryPointsChildren: (node) => tree.getChildren(node),
    designIssues: () => ({ roots: issues.getChildren(), message: issuesView.message }),
    showDesignIssues: (msg) => issues.onMessage(msg),
    review: () => ({ roots: review.getChildren(), message: reviewView.message }),
    showReview: (msg) => review.onMessage(msg),
    entryPointsItem: (node) => tree.getTreeItem(node),
    entryPointsHeader: () => treeView.message,
    entryPointsRequested: () => tree.isRequested(),
    preloadOf: (root) => ctl.preloadOf(root),
    workspaceProjects: () => ctl.workspaceProjects(),
    checkForUpdates: (overrides) => checkManually(context, (level, message) => ctl.log(level, message), overrides),
    checkForUpdatesAutomatically: (overrides) => checkAutomatically(context, (level, message) => ctl.log(level, message), overrides),
    globalState: () => context.globalState,
    dialogs,
    restoreSequencePanel: (panel) => ctl.restoreSequencePanel(panel),
    setEntryPointsProject: (project) => {
      ctl.setEntryPointsProject(project);
      tree.refresh();
    },
    getSequencePanel: () => ctl.sequenceHost?.panel,
    getClassPanel: () => ctl.classHost?.panel,
    sequenceMessages: () => [...(ctl.sequenceHost?.sent ?? [])],
    classMessages: () => [...(ctl.classHost?.sent ?? [])],
    get lastPostedMessage() {
      return ctl.sequenceHost?.lastPosted;
    },
    simulateViewMessage: async (msg) => {
      const host = ctl.sequenceHost;
      if (!host) throw new Error('Sequence panel is not open');
      await host.receive(msg);
    },
    logs: () => [...ctl.logs],
    simulateClassViewMessage: async (msg) => {
      const host = ctl.classHost;
      if (!host) throw new Error('Class panel is not open');
      await host.receive(msg);
    },
    showBaseDiff: (target) => ctl.showBaseDiff(target),
    settled: async (quietMs = 300) => {
      const posted = () => (ctl.sequenceHost?.posted ?? 0) + (ctl.classHost?.posted ?? 0);
      const deadline = Date.now() + 30_000;
      let last = posted();
      let quietSince = Date.now();
      for (;;) {
        const n = posted();
        if (n !== last || ctl.busy || selectionTimer || refreshTimer) {
          last = n;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= quietMs) return;
        if (Date.now() > deadline) throw new Error('settled(): the views kept changing for 30 s');
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

export function deactivate(): void {
  controller = undefined;
}
