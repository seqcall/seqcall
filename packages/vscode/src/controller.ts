import { BaseDiff } from './baseDiff';
import { dialogs } from './dialogs';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type {
  ClassViewToHost,
  DiagramOptions,
  EntryOutcome,
  HostToClassView,
  HostToSequenceView,
  Message,
  Position,
  SequenceDiagram,
  SequenceViewToHost,
  CallPathStep,
  EntryPoint,
  Finding,
  DiffTarget,
  GitRefs,
} from '@seqcall/protocol';
import { LIVE_OPTION_SETTINGS, affects, readConfig, setting } from './config';
import { Navigator } from './navigation';
import { configFileOf, discoverProjects, entryPointTree, megabytes, memoryLines, memorySummary, processBytes, type ProjectMemory, folderProject, addFindingIgnore, addLayerHintIgnore, removeIgnore, formatState, stateFileName, layerScopes, locateStateFile, parseState, relPathOfKey, setLayerRule, ensureDependencyRule, throttled, unreachableScan, viewText, classViewText, askText } from '@seqcall/core';
import { fromProtocolPath, isInside, isSupportedDocument, languageOf, pathKey, samePath, toProtocolPath, type ProjectLanguage, type ProjectLocation } from './paths';
import { SessionManager, type ProjectEntry } from './sessionManager';
import { StateStore } from './state';
import { WebviewHost } from './webviewHost';

export const SEQUENCE_VIEW_TYPE = 'seqcall.sequence';
export const CLASS_VIEW_TYPE = 'seqcall.class';

type SequenceHost = WebviewHost<HostToSequenceView, SequenceViewToHost>;
type ClassHost = WebviewHost<HostToClassView, ClassViewToHost>;

const NO_METHOD_REASON =
  'Place the cursor inside a method, constructor, getter/setter or function body and run "Show Sequence Diagram".';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Editor glue: owns the panels, routes view intents to the active DiagramSession and
 * pushes the resulting models back. No analysis logic lives here.
 */

export class Controller implements vscode.Disposable {
  readonly store: StateStore;
  readonly sessions: SessionManager;
  readonly navigator = new Navigator();
  private sequence: SequenceHost | undefined;
  private classView: ClassHost | undefined;
  /** Project whose diagram the sequence panel currently shows. */
  private active: ProjectEntry | undefined;
  /** FR-24.7 the base ↔ now diff editor of reviewed calls. */
  private readonly baseDiff = new BaseDiff();
  /** FR-24.7 diffs opened (test API). */
  readonly diffsShown: DiffTarget[] = [];
  private followCursor: boolean;
  private highlightedMessageId: string | null = null;
  /** Bumped on every cursor move: a slower follow-cursor lookup must not win over a newer one. */
  private selectionSeq = 0;
  /** "Seqcall" output channel: view diagnostics and host errors. */
  private readonly output = vscode.window.createOutputChannel('Seqcall');
  /** Recent log lines (for tests). */
  readonly logs: { level: 'info' | 'error'; message: string }[] = [];
  /** Background work that may still post to the views (re-renders not asked by a view message, I/O scans). */
  private background = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {
    this.store = new StateStore(context.workspaceState);
    this.sessions = new SessionManager(this.store, {
      extensionPath: context.extensionPath,
      log: (message) => this.log('info', message),
    });
    this.followCursor = this.store.getFollowCursor();
    void vscode.commands.executeCommand('setContext', 'seqcall.followCursor', this.followCursor);
  }

  // ───────────────────────────── Panels ─────────────────────────────

  get sequenceHost(): SequenceHost | undefined {
    return this.sequence;
  }

  get classHost(): ClassHost | undefined {
    return this.classView;
  }

  get activeEntry(): ProjectEntry | undefined {
    return this.active;
  }

  /** FR-32.4 new outcomes are known (a flow opened, the project scan): the sidebar redraws its rows. */
  onOutcomes: () => void = () => undefined;

  /** FR-32.4 the outcomes known for the listed project's entry points (`kind|label|methodKey`); nothing is scanned. */
  entryOutcomes(): Record<string, EntryOutcome> {
    return (this.entryPointsEntry ?? this.active)?.session.entryOutcomes() ?? {};
  }

  private ensureSequencePanel(): SequenceHost {
    if (this.sequence && !this.sequence.isDisposed) {
      if (!this.sequence.panel.visible) this.sequence.panel.reveal(undefined, true);
      return this.sequence;
    }
    const panel = vscode.window.createWebviewPanel(
      SEQUENCE_VIEW_TYPE,
      'Sequence Diagram',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return this.attachSequencePanel(panel);
  }

  private attachSequencePanel(panel: vscode.WebviewPanel): SequenceHost {
    const host: SequenceHost = new WebviewHost<HostToSequenceView, SequenceViewToHost>(
      panel,
      this.context.extensionUri,
      'sequence.js',
      (msg) => this.onSequenceMessage(msg),
      () => {
        if (this.sequence === host) this.sequence = undefined;
      },
    );
    this.sequence = host;
    return host;
  }

  private ensureClassPanel(): ClassHost {
    if (this.classView && !this.classView.isDisposed) {
      this.classView.panel.reveal(undefined, true);
      return this.classView;
    }
    const panel = vscode.window.createWebviewPanel(
      CLASS_VIEW_TYPE,
      'Class Diagram',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return this.attachClassPanel(panel);
  }

  private attachClassPanel(panel: vscode.WebviewPanel): ClassHost {
    const host: ClassHost = new WebviewHost<HostToClassView, ClassViewToHost>(
      panel,
      this.context.extensionUri,
      'class.js',
      (msg) => this.onClassMessage(msg),
      () => {
        if (this.classView === host) this.classView = undefined;
      },
    );
    this.classView = host;
    return host;
  }

  // ───────────────────────────── Commands ─────────────────────────────

  /** FR-1.1 */
  async showSequenceDiagram(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor || !isSupportedDocument(editor.document)) {
      // FR-16.4 no source file to start from: where flows start instead of a dead end
      if (vscode.workspace.workspaceFolders?.length) return this.sendEntryPoints(true);
      const host = this.ensureSequencePanel();
      host.post({ type: 'empty', reason: 'Open a JavaScript, TypeScript, C# or PHP file. ' + NO_METHOD_REASON });
      return;
    }
    const file = toProtocolPath(editor.document.uri);
    const pos = editor.selection.active;
    await this.openAt(file, { line: pos.line, character: pos.character });
  }

  async openAt(file: string, position: Position): Promise<void> {
    const host = this.ensureSequencePanel();
    // FR-16.14 the first diagram of a project waits for its analysis: both panels show a spinner meanwhile
    const loc = this.sessions.locate(file);
    const name = loc.root.split('/').pop();
    if (this.preloading.has(loc.root)) this.postBusy(`Loading ${name} in the background… the diagram appears when it is loaded.`);
    else if (!this.sessions.get(loc)) this.postBusy(loc.language === 'csharp' ? `Loading C# workspace ${name}…` : `Analysing ${name}…`);
    // a new panel: on screen before the analysis blocks the extension host
    if (host.lastPosted?.type === 'busy') await host.whenReady(3000);
    try {
      await this.sessions.ensure(file, async (entry) => {
        // FR-16.10 still loading in the background: the diagram waits for the same load
        await this.preloading.get(entry.root)?.catch(() => undefined);
        const diagram = await entry.session.openAt(file, position);
        if (!diagram) {
          host.post({ type: 'empty', reason: 'No method found at the cursor. ' + NO_METHOD_REASON });
          // Keep the class diagram consistent with the (now empty) sequence view.
          if (this.classView && !this.classView.isDisposed) this.classView.post({ type: 'empty', reason: 'The sequence diagram is empty.' });
          return;
        }
        this.active = entry;
        await this.afterChange(entry, diagram);
      });
    } catch (e) {
      this.log('error', `open: ${errorText(e)}`);
      host.post({ type: 'error', message: errorText(e) });
    }
  }

  /** FR-33 a hover's link: the sequence diagram of the method at `position`; `panel` 'paths' then opens its paths to here. */
  async openFromHover(file: string, position: Position, panel?: 'paths'): Promise<void> {
    await this.openAt(file, position);
    if (panel === 'paths' && this.active?.session.current()) this.sequence?.post({ type: 'openPanel', panel: 'paths', messageId: 'root' }, false);
  }

  /** FR-22 a path opened top-down from its start, expanded to its last method, which is highlighted. */
  private async openPathIn(entry: ProjectEntry, steps: CallPathStep[], entryPoint?: EntryPoint): Promise<void> {
    const opened = await entry.session.openPath(steps, entryPoint);
    if (!opened) {
      this.sequence?.post({ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON });
      return;
    }
    this.active = entry;
    await this.afterChange(entry, opened.diagram);
    this.lastOpenedPath = opened.messageId;
    this.sequence?.post({ type: 'highlight', messageId: opened.messageId }, false);
  }

  /**
   * FR-33.7 an entry point in a hover: its flow down to the method (`index` in the hover's list), or — `+n more` — all
   * of them to pick from, the first row opening Paths to here.
   */
  async openReach(file: string, position: Position, word: string, index?: number): Promise<void> {
    const entry = this.sessions.get(this.sessions.locate(file));
    if (!entry) return;
    // the hover's own answer, kept by the session (asked again: the link carries only where it was)
    const routes = (await entry.session.describeAt(file, position, { word, budgetMs: 30_000 }))?.reach?.routes ?? [];
    let route = index === undefined ? undefined : routes[index];
    if (index === undefined) {
      const items = [
        { label: '$(list-tree) Show all in Paths to here', route: undefined },
        ...routes.map((r) => ({ label: r.entryPoint.label, description: r.entryPoint.detail ?? r.entryPoint.kind, detail: `${r.steps.length - 1} call${r.steps.length === 2 ? '' : 's'} down to ${word}`, route: r })),
      ];
      const picked = await dialogs.pick(items, { placeHolder: `${routes.length} entry points reach ${word}: open one's flow down to it`, matchOnDescription: true });
      if (!picked) return;
      if (!picked.route) return this.openFromHover(file, position, 'paths');
      route = picked.route;
    }
    if (!route) return;
    this.ensureSequencePanel();
    await this.openPathIn(entry, route.steps, route.entryPoint);
  }

  /** FR-34.1 the loaded projects with the memory of their analysis processes (C#: the sidecar, and a review's base version). */
  private async projectMemory(): Promise<ProjectMemory[]> {
    return Promise.all(
      this.sessions.all().map(async (e) => ({ name: e.root.split('/').pop() || e.root, language: e.language, ...(await e.session.processMemory()) })),
    );
  }

  /** FR-34.3 Show Memory: one line per loaded project in the output channel; a notification with Free Memory. */
  async showMemory(): Promise<void> {
    const projects = await this.projectMemory();
    this.log('info', 'Memory:');
    for (const line of memoryLines(projects, 'runs in the extension host, shared with other extensions — not measured alone')) this.log('info', `  ${line}`);
    const choice = await dialogs.info(`Seqcall: ${memorySummary(projects)}`, 'Free Memory', 'Show Details');
    if (choice === 'Free Memory') await this.freeMemory();
    else if (choice === 'Show Details') this.output.show(true);
  }

  /** FR-34.2 Free Memory: every loaded project drops its caches and kept scans and stops its analysis processes. */
  async freeMemory(): Promise<void> {
    const held = processBytes(await this.projectMemory());
    await Promise.all(this.sessions.all().map((e) => e.session.freeMemory()));
    const message = held
      ? `Seqcall dropped its caches and stopped the C# analysis (${megabytes(held)}); it loads again with the next diagram.`
      : 'Seqcall dropped its caches.';
    this.log('info', message);
    void dialogs.info(message);
  }

  /** FR-16.14 a spinner with `text` in the sequence panel (and the class panel when open) until the next render. */
  private postBusy(text: string): void {
    this.ensureSequencePanel().post({ type: 'busy', text });
    if (this.classView && !this.classView.isDisposed) this.classView.post({ type: 'busy', text });
  }

  async showClassDiagram(): Promise<void> {
    this.ensureClassPanel();
    await this.updateClassPanel();
  }

  /** FR-26 the class view on the codebase map (it asks for the map; the flow's classes stay behind it). */
  async showAppMap(entryPoints?: string[]): Promise<void> {
    const host = this.ensureClassPanel();
    host.post({ type: 'showAppMap', ...(entryPoints?.length ? { entryPoints } : {}) }, false);
    await this.updateClassPanel();
  }

  async toggleFollowCursor(): Promise<void> {
    await this.setFollowCursor(!this.followCursor, true);
  }

  isFollowingCursor(): boolean {
    return this.followCursor;
  }

  private async setFollowCursor(value: boolean, pushToSession: boolean): Promise<void> {
    this.followCursor = value;
    await this.store.setFollowCursor(value);
    await vscode.commands.executeCommand('setContext', 'seqcall.followCursor', value);
    for (const entry of this.sessions.all()) {
      if (!pushToSession && entry === this.active) continue;
      try {
        const diagram = await entry.session.setOption('followCursor', value);
        this.sessions.persist(entry);
        if (entry === this.active) await this.afterChange(entry, diagram);
      } catch (e) {
        if (entry === this.active) this.sequence?.post({ type: 'error', message: errorText(e) });
      }
    }
    vscode.window.setStatusBarMessage(`Seqcall: follow cursor ${value ? 'on' : 'off'}`, 2000);
  }

  // ───────────────────────────── View → host ─────────────────────────────

  log(level: 'info' | 'error', message: string): void {
    this.logs.push({ level, message });
    if (this.logs.length > 200) this.logs.shift();
    this.output.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
  }

  private async onSequenceMessage(msg: SequenceViewToHost): Promise<void> {
    if (msg.type === 'log') {
      this.log(msg.level, msg.message);
      return;
    }
    if (msg.type === 'setLayer') {
      await this.setLayer(msg.classKey, msg.className, msg.layer, msg.match);
      return;
    }
    if (msg.type === 'saveImage') return this.saveImage(msg.name, msg.format, msg.data);
    if (msg.type === 'requestLayerScopes') {
      this.sequence?.post({ type: 'layerScopes', classKey: msg.classKey, scopes: this.active ? layerScopes(this.active.root, msg.classKey, msg.className) : [] }, false);
      return;
    }
    if (msg.type === 'ignoreFinding') return this.ignoreFinding(msg.pattern);
    if (msg.type === 'ignoreLayerHint') return this.ignoreLayerHint(msg.pattern);
    if (msg.type === 'unignoreFinding' || msg.type === 'unignoreLayerHint') return this.unignore(msg.type === 'unignoreFinding' ? 'findings' : 'layerHints', msg.pattern);
    if (msg.type === 'ready') {
      // Panel reloaded or restored: make sure it shows the current state.
      if (this.active && !this.sequence?.lastPosted) {
        await this.afterChange(this.active, this.active.session.current());
      }
      return;
    }
    if (msg.type === 'navigate') {
      await this.reveal(msg.range);
      return;
    }
    // FR-12.17 an object clicked in the sequence diagram: its class in the class diagram (when it is open)
    if (msg.type === 'focusClass') {
      if (this.classView && !this.classView.isDisposed) this.classView.post({ type: 'focusClass', classKey: msg.classKey }, false);
      return;
    }
    if (msg.type === 'openDiff') {
      const s = this.active?.session;
      const target = msg.classKey ? await s?.classDiffTarget(msg.classKey, msg.member) : msg.messageId ? await s?.diffTarget(msg.messageId, { method: msg.method }) : undefined;
      if (!target) return void dialogs.info('Seqcall: no diff for this call (the review has ended?)');
      return this.showBaseDiff(target, msg.keepFocus);
    }
    if (msg.type === 'openClassDiagram') {
      await this.showClassDiagram();
      return;
    }
    if (msg.type === 'openAppMap') return this.showAppMap(msg.entryPoints);
    if (msg.type === 'requestEntryPoints') return this.sendEntryPoints();
    if (msg.type === 'switchEntryPointsProject') return this.switchEntryPointsProject();
    if (msg.type === 'openDependencyRule') return this.openDependencyRule();
    if (msg.type === 'openMethod') return this.openEntryPoint(msg.methodKey, msg.entryPoint);
    if (msg.type === 'requestProjectFindings') return this.sendProjectFindings(false, msg.rescan);
    if (msg.type === 'cancelProjectFindings') {
      this.projectScanCancelled = true;
      return;
    }
    if (msg.type === 'requestUnreachable') return this.sendUnreachable(false, msg.rescan);
    if (msg.type === 'cancelUnreachable') {
      this.unreachableCancelled = true;
      return;
    }
    if (msg.type === 'openFinding') return this.openFinding(msg.entryPoint, msg.finding);
    if (msg.type === 'cancelPaths') {
      this.pathsCancelled = true;
      return;
    }
    if (msg.type === 'cancelSearch') {
      this.searchGeneration++;
      return;
    }
    if (msg.type === 'requestReview') return this.sendReview(false, msg.base, msg.force, msg.mode);
    if (msg.type === 'requestGitRefs') return this.sendGitRefs();
    if (msg.type === 'searchMethods') return this.sendMethodResults(msg.query);
    if (msg.type === 'cancelReview') {
      this.reviewCancelled = true;
      return;
    }
    if (msg.type === 'copyState') return this.copyState('sequence', msg.save);
    if (msg.type === 'copyText') return this.copyText('sequence', msg.messageId);
    if (msg.type === 'openState') return this.openState(msg.text);
    const entry = this.active;
    if (msg.type === 'savePositions') {
      if (entry) await this.store.setPositions(entry.root, msg.rootKey, msg.positions);
      return;
    }
    if (!entry) {
      this.sequence?.post({ type: 'empty', reason: NO_METHOD_REASON });
      return;
    }
    const s = entry.session;
    try {
      switch (msg.type) {
        case 'requestCallers':
          this.sequence?.post({ type: 'callers', messageId: msg.messageId, callers: await s.getCallers(msg.messageId) });
          return;
        case 'expand':
          return this.afterChange(entry, await s.expand(msg.messageId));
        case 'collapse':
          return this.afterChange(entry, await s.collapse(msg.messageId));
        case 'expandAll':
          return this.afterChange(entry, await (msg.oneLevel ? s.expandAll() : s.expandEverything(msg.messageId)));
        case 'smartExpand':
          return this.afterChange(entry, await s.smartExpand(msg.messageId, msg.more, msg.view));
        case 'collapseAll':
          return this.afterChange(entry, await s.collapseAll());
        case 'collapseFragment':
          return this.afterChange(entry, await s.collapseFragment(msg.fragmentId));
        case 'expandFragment':
          return this.afterChange(entry, await s.expandFragment(msg.fragmentId));
        case 'followCase':
          return this.afterChange(entry, await s.followCase(msg.fragmentId, msg.case));
        case 'showAllCases':
          return this.afterChange(entry, await s.showAllCases(msg.fragmentId));
        case 'showErrorPath':
          return this.afterChange(entry, await s.showErrorPath(msg.key));
        case 'selectImplementation':
          return this.afterChange(entry, await s.selectImplementation(msg.messageId, msg.classKey));
        case 'revertImplementation':
          return this.afterChange(entry, await s.revertImplementation(msg.messageId));
        case 'reroot':
          return this.afterChange(entry, await s.reroot(msg.messageId, msg.callerId));
        case 'requestPaths':
          return this.sendPaths(entry, msg.messageId);
        case 'searchCollapsed':
          return this.sendSearch(entry, msg.query, msg.deeper);
        case 'openReviewIssue': {
          const d = await s.openReviewFlow(msg.issue);
          await this.afterChange(entry, d);
          this.sequence?.post({ type: 'highlight', messageId: msg.issue.finding.messageIds?.[0] ?? null, messageIds: msg.issue.finding.messageIds ?? [], finding: msg.issue.finding }, false);
          return;
        }
        case 'openReviewStructure': {
          const r = await s.openReviewStructure(msg.row);
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          this.sequence?.post({ type: 'highlight', messageId: r.messageId ?? null }, false);
          return;
        }
        case 'endReview':
          this.onReviewEnded.fire();
          return this.afterChange(entry, await s.endReview());
        case 'revealSearchHit': {
          const r = await s.revealSearchHit(msg.hit);
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          this.highlightedMessageId = r.messageId;
          this.sequence?.post({ type: 'highlight', messageId: r.messageId }, false);
          return;
        }
        case 'openPath':
          return this.openPathIn(entry, msg.steps, msg.entryPoint);
        // FR-24.9 / FR-24.10 stepping through the review's changes
        case 'showChange':
        case 'revealChange':
        case 'openChangeFlow': {
          const r = msg.type === 'revealChange' ? await s.revealChange(msg.messageId) : msg.type === 'showChange' ? await s.showChange(msg.n) : await s.openChangeFlow(msg.paths, msg.entryPoint);
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          this.highlightedMessageId = r.messageId;
          this.sequence?.post({ type: 'highlight', messageId: r.messageId }, false);
          return;
        }
        case 'focus':
          return this.afterChange(entry, await s.focus(msg.messageId));
        case 'hide':
          return this.afterChange(entry, await s.hide(msg.filter));
        case 'unhide':
          return this.afterChange(entry, await s.unhide(msg.filterId));
        case 'unhideAll':
          return this.afterChange(entry, await s.unhideAll());
        case 'back':
          return this.afterChange(entry, await s.back());
        case 'forward':
          return this.afterChange(entry, await s.forward());
        case 'restoreSettings': // FR-25.2
          return this.afterChange(entry, await s.restoreSettings());
        case 'useSharedConfig': // FR-25.3
          try {
            return await this.afterChange(entry, await s.useSharedConfig(msg.on));
          } catch (e) {
            void dialogs.warning(`Seqcall: ${errorText(e)}`);
            return;
          }
        case 'setOption': {
          const diagram = await s.setOption(msg.option, msg.value as DiagramOptions[typeof msg.option]);
          if (msg.option === 'followCursor') await this.setFollowCursor(Boolean(msg.value), false);
          return this.afterChange(entry, diagram);
        }
        case 'setLayerOpen': // FR-28.7
          return this.afterChange(entry, await s.setLayerOpen(msg.layer, msg.open));
        case 'foldLayers': // FR-28.9
          return this.afterChange(entry, await s.foldAllLayers());
        default: {
          const unknown: never = msg;
          console.warn('[seqcall] unknown sequence view message', unknown);
        }
      }
    } catch (e) {
      this.log('error', `${msg.type}: ${errorText(e)}`);
      this.sequence?.post({ type: 'error', message: errorText(e) });
    }
  }

  private async onClassMessage(msg: ClassViewToHost): Promise<void> {
    if (msg.type === 'log') return this.log(msg.level, msg.message);
    if (msg.type === 'ready') return;
    // Hiding is shared with the sequence view: same filters, both panels re-render.
    // shared filters, and FR-12.13 focus on a class-diagram method's call: handled like the sequence view's
    if (msg.type === 'hide' || msg.type === 'unhide' || msg.type === 'unhideAll' || msg.type === 'focus' || msg.type === 'openDiff' || msg.type === 'setOption' || msg.type === 'setLayerOpen' || msg.type === 'foldLayers') return this.onSequenceMessage(msg);
    if (msg.type === 'setLayer') return this.setLayer(msg.classKey, msg.className, msg.layer, msg.match);
    if (msg.type === 'saveImage') return this.saveImage(msg.name, msg.format, msg.data);
    if (msg.type === 'requestLayerScopes') {
      if (this.classView && !this.classView.isDisposed) this.classView.post({ type: 'layerScopes', classKey: msg.classKey, scopes: this.active ? layerScopes(this.active.root, msg.classKey, msg.className) : [] }, false);
      return;
    }
    if (msg.type === 'openDependencyRule') return this.openDependencyRule();
    // a design issue picked in the codebase map: its flow, in the sequence diagram
    if (msg.type === 'openFinding') {
      this.ensureSequencePanel();
      return this.openFinding(msg.entryPoint, msg.finding);
    }
    if (msg.type === 'ignoreFinding') return this.ignoreFinding(msg.pattern);
    if (msg.type === 'ignoreLayerHint') return this.ignoreLayerHint(msg.pattern);
    if (msg.type === 'unignoreFinding' || msg.type === 'unignoreLayerHint') return this.unignore(msg.type === 'unignoreFinding' ? 'findings' : 'layerHints', msg.pattern);
    // FR-25.2 / FR-25.3 the flow's state, as from the sequence view (a report goes there)
    if (msg.type === 'copyState') return this.copyState('class', msg.save);
    if (msg.type === 'copyText') return this.copyText('class');
    if (msg.type === 'openState') return this.openState(msg.text, 'class');
    if (msg.type === 'useSharedConfig') return this.onSequenceMessage(msg);
    if (msg.type === 'requestAppMap') return this.sendAppMap(msg.path ?? '', !!msg.rescan, msg.open, msg.entryPoints);
    if (msg.type === 'cancelAppMap') {
      this.appMapCancelled = true;
      return;
    }
    // FR-12.12: type uses are a session option (persisted); only the class diagram changes.
    if (msg.type === 'setTypeUses') {
      const entry = this.active;
      if (!entry) return;
      try {
        await entry.session.setOption('showTypeUses', msg.value);
        this.sessions.persist(entry);
        await this.updateClassPanel();
      } catch (e) {
        this.log('error', `class diagram: ${errorText(e)}`);
      }
      return;
    }
    // FR-23.4: not among the drawn classes — find it in the flow (its collapsed calls too)
    if (msg.type === 'findInFlow') {
      const host = this.ensureSequencePanel();
      host.panel.reveal(undefined, false);
      host.post({ type: 'openFind', query: msg.query }, false);
      return;
    }
    // FR-12.14: the calls behind a relation are collapsed: open them, then highlight (FR-12.9).
    if (msg.type === 'revealRelation') {
      const entry = this.active;
      if (!entry) return;
      try {
        const r = await entry.session.revealRelation(msg.from, msg.to, msg.field);
        if (!r.messageIds.length) {
          // no call through it (FR-12.9): the field's declaration, else the class
          const target = r.fieldDeclaration ?? msg.fallback;
          if (target) await this.reveal(target);
          return;
        }
        await this.afterChange(entry, r.diagram);
        this.highlightedMessageId = r.messageIds[0];
        this.sequence?.post({ type: 'highlight', messageId: this.highlightedMessageId, messageIds: r.messageIds }, false);
      } catch (e) {
        this.log('error', `reveal relation: ${errorText(e)}`);
      }
      return;
    }
    // FR-12.9: a clicked relation highlights its calls in the sequence diagram.
    if (msg.type === 'highlightMessages') {
      this.highlightedMessageId = msg.messageIds[0] ?? null;
      this.sequence?.post({ type: 'highlight', messageId: this.highlightedMessageId, messageIds: msg.messageIds }, false);
      return;
    }
    // a class method row's Show callers / Paths to here: the sequence panel opens it
    if (msg.type === 'openInSequence') {
      this.sequence?.panel.reveal(undefined, false);
      this.sequence?.post({ type: 'openPanel', panel: msg.panel, messageId: msg.messageId }, false);
      return;
    }
    if (msg.type === 'navigate') await this.reveal(msg.range);
  }

  /** FR-24.7 the side-by-side diff of a reviewed call, beside the diagram. */
  async showBaseDiff(target: DiffTarget, keepFocus = false): Promise<void> {
    this.diffsShown.push(target);
    await this.baseDiff.show(target, this.sequence?.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One, keepFocus);
  }

  private async reveal(range: Parameters<Navigator['reveal']>[0]): Promise<void> {
    try {
      await this.navigator.reveal(range, this.sequence?.panel.viewColumn);
    } catch (e) {
      void dialogs.warning(`Seqcall: cannot open ${range.file}: ${errorText(e)}`);
    }
  }

  // ───────────────────────────── Entry points (FR-16) ─────────────────────────────

  // ───────────────────────────── FR-16.10 background load ─────────────────────────────

  /** Projects loading in the background (root → the load). */
  private readonly preloading = new Map<string, Promise<void>>();
  private preloadStatus: vscode.StatusBarItem | undefined;

  /**
   * FR-16.10 when a workspace opens: load its project in the background (setting `seqcall.preloadProject`,
   * default on) — the project of the open editor, else the folder's (or the one nearest below it). No entry-point
   * scan; the status bar shows the load. A diagram opened meanwhile waits for the same load.
   */
  async preload(): Promise<void> {
    if (!setting('preloadProject', true)) return;
    const anchor = this.entryPointsAnchor();
    if (!anchor) return;
    const status = (this.preloadStatus ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0));
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          if (this.preloading.has(entry.root)) return;
          const name = entry.root.split('/').pop();
          const started = Date.now();
          status.text = `$(sync~spin) Seqcall: loading ${name}…`;
          status.tooltip = `Loading ${entry.root} in the background, so the first diagram does not wait (setting: Seqcall › Preload Project)`;
          status.show();
          const load = entry.session.warmUp();
          this.preloading.set(entry.root, load);
          try {
            await load;
            this.log('info', `preloaded ${entry.root} in ${Date.now() - started} ms`);
            status.text = `$(check) Seqcall: ${name} ready`;
            setTimeout(() => status.hide(), 4000);
          } catch (e) {
            this.log('error', `preload ${entry.root}: ${errorText(e)}`);
            status.text = `$(warning) Seqcall: ${name} not loaded`;
            status.tooltip = errorText(e);
            setTimeout(() => status.hide(), 15000);
          } finally {
            this.preloading.delete(entry.root);
          }
        },
        anchor.language,
        true,
      );
    } catch (e) {
      this.log('error', `preload: ${errorText(e)}`);
    }
  }

  /** FR-16.10 the background load of a project (for tests); undefined when none runs. */
  preloadOf(root: string): Promise<void> | undefined {
    return this.preloading.get(root);
  }

  /** Project of the last entry-point list (its methods open there). */
  private entryPointsEntry: ProjectEntry | undefined;
  /** FR-19.9 / FR-24 progress and results of the design-issue scan and the review (the sidebar views), wherever asked. */
  readonly onProjectFindings = new vscode.EventEmitter<Extract<HostToSequenceView, { type: 'projectFindings' }>>();
  readonly onReview = new vscode.EventEmitter<Extract<HostToSequenceView, { type: 'review' }>>();
  /** FR-24 End review (the panel or the sidebar): the review's marks and lists go. */
  readonly onReviewEnded = new vscode.EventEmitter<void>();

  /** The last review's base and mode (the sidebar's Re-run). */
  reviewSettings(): { base: string; mode: 'split' | 'direct' } {
    return { base: this.reviewBase, mode: this.reviewMode };
  }

  /**
   * FR-24.13 the sidebar's *Compare with…*: the review picker's choices as a quick pick (quick choices, branches,
   * tags, commits; typed text is used as is) and the mode; runs the review. False when dismissed.
   */
  async chooseReviewBase(): Promise<boolean> {
    const anchor = this.entryPointsAnchor();
    if (!anchor) return false;
    let refs: GitRefs | undefined;
    try {
      await this.sessions.ensure(anchor.file, async (entry) => (refs = await entry.session.gitRefs()), anchor.language);
    } catch (e) {
      void dialogs.warning(`Seqcall: ${errorText(e)}`);
      return false;
    }
    const ago = (ms: number) => {
      const d = Math.round((Date.now() - ms) / 86_400_000);
      return d < 1 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
    };
    type Pick = vscode.QuickPickItem & { base?: string; mode?: 'split' | 'direct'; toggle?: boolean };
    const sep = (label: string): Pick => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const r = refs!;
    for (;;) {
      const mode = this.reviewMode;
      const items: Pick[] = [
        sep('Quick'),
        ...(r.target ? [{ label: `Pull request into ${r.target}`, description: 'since this branch split off it', base: r.target, mode: 'split' as const }] : []),
        ...(r.upstream ? [{ label: 'Not pushed yet', description: `vs ${r.upstream}`, base: r.upstream, mode: 'split' as const }] : []),
        { label: 'Since the previous commit', description: 'HEAD~1', base: 'HEAD~1', mode: 'split' },
        { label: 'Uncommitted changes only', description: 'vs HEAD', base: 'HEAD', mode: 'split' },
        sep('Branches'),
        ...r.branches.map((b) => ({ label: b.name, description: `${ago(b.date)}${b.remote ? ' · remote' : ''}`, detail: b.subject, base: b.name })),
        ...(r.tags.length ? [sep('Tags'), ...r.tags.map((t) => ({ label: t.name, description: ago(t.date), base: t.name }))] : []),
        sep(`Commits on ${r.current ?? 'this branch'}`),
        ...r.commits.map((c) => ({ label: `${c.hash} ${c.subject}`, description: `${ago(c.date)} · ${c.author}`, base: c.hash })),
        sep('Mode'),
        { label: mode === 'split' ? '$(arrow-swap) Compare tip against tip instead' : '$(arrow-swap) Compare since the split instead (a pull request)', description: `now: ${mode === 'split' ? 'since the split' : 'tip against tip'}`, toggle: true },
      ];
      const qp = vscode.window.createQuickPick<Pick>();
      qp.items = items;
      qp.title = `Review: compare ${r.current ?? 'this branch'} with… (${mode === 'split' ? 'since the split' : 'tip against tip'})`;
      qp.placeholder = 'A branch, tag, commit, or type any ref (HEAD~3, origin/main)';
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      const picked = await new Promise<{ item?: Pick; typed?: string } | undefined>((resolve) => {
        qp.onDidAccept(() => resolve({ item: qp.selectedItems[0], typed: qp.value.trim() }));
        qp.onDidHide(() => resolve(undefined));
        qp.show();
      });
      qp.dispose();
      if (!picked) return false;
      if (picked.item?.toggle) {
        this.reviewMode = mode === 'split' ? 'direct' : 'split';
        continue;
      }
      const base = picked.item?.base ?? picked.typed;
      if (!base) return false;
      void this.sendReview(false, base, false, picked.item?.mode ?? this.reviewMode, true);
      return true;
    }
  }

  cancelProjectScan(): void {
    this.projectScanCancelled = true;
  }

  cancelReview(): void {
    this.reviewCancelled = true;
  }

  /**
   * FR-19.9 / FR-24 a row of a sidebar view: the same intent as in the panel's lists, in the project the view
   * lists (the panel opens for it).
   */
  async fromSidebar(msg: SequenceViewToHost): Promise<void> {
    this.ensureSequencePanel();
    if (this.entryPointsEntry) this.active = this.entryPointsEntry;
    this.lastOpenedPath = undefined;
    await this.onSequenceMessage(msg);
    // FR-24.14 a changed method picked in the Review view: also its code in the editor, its class in the class diagram
    // (as a click on the call in the diagram does); the highlight stays (no highlightedMessageId — a reveal at a
    // declaration finds no call there and would clear it)
    if (msg.type === 'openPath' && this.lastOpenedPath) await this.showPathTarget(this.lastOpenedPath);
  }

  /** The call an `openPath` highlighted (from the sidebar). */
  private lastOpenedPath: string | undefined;

  /** FR-24.14 the method a sidebar row opened: its declaration in the editor, its class focused in the class diagram. */
  private async showPathTarget(messageId: string): Promise<void> {
    const d = this.active?.session.current();
    if (!d) return;
    const m = d.messages.find((x) => x.id === messageId);
    const at = messageId === 'root' ? d.root.declaration : (m?.targetDeclaration ?? m?.callSite);
    if (at) await this.reveal(at);
    const classKey = messageId === 'root' ? d.root.owner.key : (m?.classKey ?? d.participants.find((p) => p.id === m?.to)?.classKey);
    // FR-12.17 project classes only (as an object click)
    if (classKey && classKey.includes('#') && !classKey.startsWith('lib:') && this.classView && !this.classView.isDisposed) this.classView.post({ type: 'focusClass', classKey }, false);
  }

  /** FR-16.4 the project chosen with Switch Project (undefined: follow the open diagram). */
  private pinnedProject: ProjectLocation | undefined;
  /** FR-16.4 the open diagram moved to another project than the listed one (the sidebar reloads unless pinned). */
  readonly onDidChangeEntryPointsProject = new vscode.EventEmitter<void>();

  /** FR-16.4 the workspace's projects (for Switch Project). */
  workspaceProjects(): ProjectLocation[] {
    return discoverProjects((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  }

  /** FR-16.4 list the entry points of this project (undefined: of the open diagram's, as by default). */
  setEntryPointsProject(project: ProjectLocation | undefined): void {
    this.pinnedProject = project;
  }

  entryPointsProject(): ProjectLocation | undefined {
    return this.pinnedProject;
  }

  /** FR-16.4 Switch Project…: a quick pick of the workspace's projects; true when the choice changed. */
  async chooseEntryPointsProject(): Promise<boolean> {
    const projects = this.workspaceProjects();
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => toProtocolPath(f.uri));
    const rel = (root: string) => {
      const folder = folders.find((f) => isInside(root, f) || samePath(root, f));
      return folder ? root.slice(folder.length).replace(/^\//, '') || '.' : root;
    };
    const current = this.pinnedProject;
    type Pick = vscode.QuickPickItem & { project?: ProjectLocation };
    const items: Pick[] = [
      { label: `${current ? '' : '$(check) '}Follow the open diagram`, description: 'the project of the diagram or file you work on (default)' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...projects.map((p) => ({
        label: `${current && samePath(current.root, p.root) && current.language === p.language ? '$(check) ' : ''}${p.root.split('/').pop()}`,
        description: rel(p.root),
        detail: { typescript: 'TypeScript / JavaScript', csharp: 'C#', php: 'PHP' }[p.language],
        project: p,
      })),
    ];
    const pick = await dialogs.pick(items, { title: 'Entry points of which project?', matchOnDescription: true });
    if (!pick) return false;
    this.setEntryPointsProject(pick.project);
    return true;
  }

  /** FR-16.11 Switch project from the panel's entry-point list: the same choice as the sidebar's, both lists follow. */
  private async switchEntryPointsProject(): Promise<void> {
    if (!(await this.chooseEntryPointsProject())) return;
    this.onDidChangeEntryPointsProject.fire();
    await this.sendEntryPoints(true);
  }

  /** Pinned project, else the diagram's project, else the active editor's, else the first workspace folder (C# with a solution). */
  private entryPointsAnchor(): { file: string; language?: ProjectLanguage } | undefined {
    if (this.pinnedProject) return { file: `${this.pinnedProject.root}/__root__`, language: this.pinnedProject.language };
    if (this.active) return { file: `${this.active.root}/__root__`, language: this.active.language };
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && isSupportedDocument(doc)) return { file: toProtocolPath(doc.uri) };
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    // the folder when it is a project (C# solution, tsconfig / jsconfig, composer.json), else the project nearest
    // below it (`suite/` → `suite/Platform/Platform.sln`), else the folder as JS/TS
    const project = folderProject(folder.uri.fsPath);
    if (project) return { file: `${toProtocolPath(fromProtocolPath(project.root))}/__root__`, language: project.language };
    return { file: `${toProtocolPath(folder.uri)}/__root__`, language: 'typescript' };
  }

  /** FR-19.9: a running project-wide scan stops after the current entry point. */
  private projectScanCancelled = false;

  /** FR-31: a running unreachable-code scan stops at its next step. */
  private unreachableCancelled = false;

  /** FR-31 the methods no entry point reaches (progress while running; cached by the session). */
  async sendUnreachable(show = false, rescan = false): Promise<void> {
    const panel = this.ensureSequencePanel();
    const post = (m: Extract<HostToSequenceView, { type: 'unreachable' }>) => panel.post(m, false);
    const anchor = this.entryPointsAnchor();
    if (!anchor) return post({ type: 'unreachable', state: 'error', error: 'Open a folder or a source file first.', show });
    this.unreachableCancelled = false;
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          this.entryPointsEntry = entry;
          const project = entry.root.split('/').pop();
          post({ type: 'unreachable', state: 'running', phase: 'reach', done: 0, project, show });
          const r = await entry.session.findUnreachableCode({ rescan, cancelled: () => this.unreachableCancelled, onProgress: throttled((phase, done, total) => post({ type: 'unreachable', state: 'running', phase, done, total, project })) });
          post(r ? { type: 'unreachable', state: 'done', result: unreachableScan(r), project } : { type: 'unreachable', state: 'cancelled', project });
        },
        anchor.language,
      );
    } catch (e) {
      this.log('error', `unreachable code: ${errorText(e)}`);
      post({ type: 'unreachable', state: 'error', error: errorText(e) });
    }
  }

  /** FR-19.9 design issues of the whole project (progress while running; cached by the session). */
  async sendProjectFindings(show = false, rescan = false, fromSidebar = false): Promise<void> {
    // FR-19.9 the sidebar's Design Issues view asks without opening the panel (an open one shows it too)
    const panel = fromSidebar ? this.sequence : this.ensureSequencePanel();
    const host = {
      post: (m: Extract<HostToSequenceView, { type: 'projectFindings' }>, _state: boolean) => {
        panel?.post(m, false);
        this.onProjectFindings.fire(m);
      },
    };
    const anchor = this.entryPointsAnchor();
    if (!anchor) {
      host.post({ type: 'projectFindings', state: 'error', error: 'Open a folder or a source file first.', show }, false);
      return;
    }
    this.projectScanCancelled = false;
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          this.entryPointsEntry = entry;
          const project = entry.root.split('/').pop();
          let last = 0;
          host.post({ type: 'projectFindings', state: 'running', done: 0, project, show }, false);
          const findings = await entry.session.findProjectIssues({
            rescan,
            cancelled: () => this.projectScanCancelled,
            onProgress: (done, total) => {
              const now = Date.now();
              if (now - last < 250 && done < total) return;
              last = now;
              host.post({ type: 'projectFindings', state: 'running', done, total, project }, false);
            },
            // FR-19.23 the entry points' findings while the methods none reaches are looked for
            onEntryPointsDone: (findings) => host.post({ type: 'projectFindings', state: 'running', findings, walking: true, project }, false),
          });
          host.post(findings ? { type: 'projectFindings', state: 'done', findings, total: entry.session.projectEntryPointCount, truncated: entry.session.projectTruncatedCount, unreached: entry.session.projectUnreachedCount, ...(entry.session.projectFindingsChanged ? { changed: true } : {}), outcomes: entry.session.entryOutcomes(), project } : { type: 'projectFindings', state: 'cancelled', project }, false);
          if (findings) this.onOutcomes();
        },
        anchor.language,
      );
    } catch (e) {
      this.log('error', `design issues: ${errorText(e)}`);
      host.post({ type: 'projectFindings', state: 'error', error: errorText(e) }, false);
    }
  }

  private appMapCancelled = false;

  /** FR-26 the codebase map at a folder (progress while the entry points are scanned; cached by the session). */
  async sendAppMap(folder: string, rescan = false, open?: string[], entryPoints?: string[]): Promise<void> {
    const host = this.ensureClassPanel();
    const anchor = this.entryPointsAnchor();
    if (!anchor) {
      host.post({ type: 'appMap', state: 'error', error: 'Open a folder or a source file first.' }, false);
      return;
    }
    this.appMapCancelled = false;
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          this.entryPointsEntry = entry;
          const project = entry.root.split('/').pop();
          let last = 0;
          host.post({ type: 'appMap', state: 'running', done: 0, project }, false);
          const level = await entry.session.getAppMap(folder, {
            rescan,
            open,
            entryPoints,
            cancelled: () => this.appMapCancelled,
            onProgress: (done, total) => {
              const now = Date.now();
              if (now - last < 250 && done < total) return;
              last = now;
              host.post({ type: 'appMap', state: 'running', done, total, project }, false);
            },
          });
          host.post(level ? { type: 'appMap', state: 'done', level, project } : { type: 'appMap', state: 'cancelled', project }, false);
        },
        anchor.language,
      );
    } catch (e) {
      this.log('error', `codebase map: ${errorText(e)}`);
      host.post({ type: 'appMap', state: 'error', error: errorText(e) }, false);
    }
  }

  /** FR-24: a running review stops at its next step. */
  private reviewCancelled = false;
  /** FR-24 the base of the last review (the view sends its own; the command reuses this one). */
  /** FR-24.13 since the split (a pull request) or tip against tip. */
  private reviewMode: 'split' | 'direct' = 'split';
  private reviewBase = 'develop';

  /** FR-24 review of the current branch: progress while it runs, then the result (the diagram marks the changes). */
  /** FR-24.13 the review picker's lists: branches, tags and commits of the project's repository. */
  /** FR-16.15 the ⌂ filter's method search. */
  private async sendMethodResults(query: string): Promise<void> {
    const host = this.ensureSequencePanel();
    const anchor = this.entryPointsAnchor();
    if (!anchor) return host.post({ type: 'methodResults', query, methods: [], more: 0 }, false);
    try {
      await this.sessions.ensure(anchor.file, async (entry) => host.post({ type: 'methodResults', query, ...(await entry.session.searchMethods(query)) }, false), anchor.language);
    } catch (e) {
      this.log('error', `method search: ${errorText(e)}`);
      host.post({ type: 'methodResults', query, methods: [], more: 0 }, false);
    }
  }

  private async sendGitRefs(): Promise<void> {
    const host = this.ensureSequencePanel();
    const anchor = this.entryPointsAnchor();
    if (!anchor) return host.post({ type: 'gitRefs', error: 'Open a folder or a source file first.' }, false);
    try {
      await this.sessions.ensure(anchor.file, async (entry) => host.post({ type: 'gitRefs', refs: await entry.session.gitRefs() }, false), anchor.language);
    } catch (e) {
      host.post({ type: 'gitRefs', error: errorText(e) }, false);
    }
  }

  async sendReview(show = false, base?: string, force = false, mode?: 'split' | 'direct', fromSidebar = false): Promise<void> {
    // FR-24 the sidebar's Review view asks without opening the panel (an open one shows it too)
    const panel = fromSidebar ? this.sequence : this.ensureSequencePanel();
    const host = {
      post: (m: Extract<HostToSequenceView, { type: 'review' }>, _state: boolean) => {
        panel?.post(m, false);
        this.onReview.fire(m);
      },
    };
    const anchor = this.entryPointsAnchor();
    if (!anchor) {
      host.post({ type: 'review', state: 'error', error: 'Open a folder or a source file first.', show }, false);
      return;
    }
    if (base) this.reviewBase = base;
    if (mode) this.reviewMode = mode;
    this.reviewCancelled = false;
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          this.entryPointsEntry = entry;
          let last = 0;
          host.post({ type: 'review', state: 'running', phase: 'Reading the changes (git)', show }, false);
          const result = await entry.session.reviewChanges({
            base: this.reviewBase,
            force,
            mode: this.reviewMode,
            cancelled: () => this.reviewCancelled,
            onProgress: (phase, done, total) => {
              const now = Date.now();
              if (now - last < 250) return;
              last = now;
              host.post({ type: 'review', state: 'running', phase, done, total }, false);
            },
          });
          host.post(result ? { type: 'review', state: 'done', result } : { type: 'review', state: 'cancelled' }, false);
          // the open diagram shows the changes now
          if (result && entry === this.active) await this.afterChange(entry, await entry.session.redraw());
        },
        anchor.language,
      );
    } catch (e) {
      this.log('error', `review: ${errorText(e)}`);
      host.post({ type: 'review', state: 'error', error: errorText(e) }, false);
    }
  }

  /** FR-23: a newer query (or closing the find bar) stops the running search. */
  private searchGeneration = 0;

  /** FR-23.2 calls matching the find bar's query below the collapsed messages (progress while searching). */
  private async sendSearch(entry: ProjectEntry, query: string, deeper?: boolean): Promise<void> {
    const generation = ++this.searchGeneration;
    const current = () => generation === this.searchGeneration;
    let last = 0;
    try {
      const r = await entry.session.searchCollapsed(query, {
        deeper,
        cancelled: () => !current(),
        onProgress: (methods) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.sequence?.post({ type: 'searchResults', query, state: 'running', methods }, false);
        },
      });
      if (!current()) return;
      this.sequence?.post(r ? { type: 'searchResults', query, state: 'done', hits: r.hits, methods: r.methods, truncated: r.truncated, ...(deeper ? { deeper } : {}) } : { type: 'searchResults', query, state: 'cancelled' }, false);
    } catch (e) {
      this.log('error', `find: ${errorText(e)}`);
      if (current()) this.sequence?.post({ type: 'searchResults', query, state: 'error', error: errorText(e) }, false);
    }
  }

  /** FR-23 Ctrl+F in a diagram panel (VS Code keeps the key): the focused panel opens its find bar. */
  find(): void {
    if (this.classView && !this.classView.isDisposed && this.classView.panel.active) this.classView.post({ type: 'openFind' }, false);
    else this.ensureSequencePanel().post({ type: 'openFind' }, false);
  }

  /** FR-22: a running paths-to-here walk stops before its next references query. */
  private pathsCancelled = false;

  /** FR-22 paths to here of a message's method (progress while the callers are walked). */
  private async sendPaths(entry: ProjectEntry, messageId: string): Promise<void> {
    this.pathsCancelled = false;
    let last = 0;
    this.sequence?.post({ type: 'paths', messageId, state: 'running', methods: 0 }, false);
    try {
      const r = await entry.session.findPathsToHere(messageId, {
        cancelled: () => this.pathsCancelled,
        onProgress: (methods) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.sequence?.post({ type: 'paths', messageId, state: 'running', methods }, false);
        },
      });
      this.sequence?.post(r ? { type: 'paths', messageId, state: 'done', tree: r.tree, methods: r.methods, truncated: r.truncated } : { type: 'paths', messageId, state: 'cancelled' }, false);
    } catch (e) {
      this.log('error', `paths to here: ${errorText(e)}`);
      this.sequence?.post({ type: 'paths', messageId, state: 'error', error: errorText(e) }, false);
    }
  }

  /** FR-19.9: the flow of a project finding, expanded as the scan saw it, with the evidence highlighted. */
  private async openFinding(entryPoint: EntryPoint, finding: Finding): Promise<void> {
    const entry = this.entryPointsEntry ?? this.active;
    if (!entry) return;
    try {
      const diagram = await entry.session.openFinding(entryPoint);
      if (!diagram) {
        this.sequence?.post({ type: 'empty', reason: 'That entry point no longer exists. ' + NO_METHOD_REASON });
        return;
      }
      this.active = entry;
      await this.afterChange(entry, diagram);
      this.sequence?.post({ type: 'highlight', messageId: finding.messageIds?.[0] ?? null, messageIds: finding.messageIds ?? [], finding }, false);
    } catch (e) {
      this.log('error', `open finding: ${errorText(e)}`);
      this.sequence?.post({ type: 'error', message: errorText(e) });
    }
  }

  async sendEntryPoints(show = false): Promise<void> {
    const host = this.ensureSequencePanel();
    const r = await this.loadEntryPoints();
    const canSwitchProject = this.workspaceProjects().length > 1;
    host.post('error' in r ? { type: 'entryPoints', entryPoints: [], error: r.error, show, canSwitchProject } : { type: 'entryPoints', entryPoints: r.entryPoints, project: r.project, show, canSwitchProject, tree: entryPointTree(r.entryPoints, r.project) }, false);
  }

  /** FR-16.1 the entry points of the diagram's project (else the active editor's, else the first folder's). */
  async loadEntryPoints(): Promise<{ entryPoints: EntryPoint[]; project?: string } | { error: string }> {
    const anchor = this.entryPointsAnchor();
    if (!anchor) return { error: 'Open a folder or a source file first.' };
    let result: { entryPoints: EntryPoint[]; project?: string } | { error: string } = { entryPoints: [] };
    try {
      await this.sessions.ensure(
        anchor.file,
        async (entry) => {
          this.entryPointsEntry = entry;
          result = { entryPoints: await entry.session.getEntryPoints(), project: entry.root.split('/').pop() };
        },
        anchor.language,
      );
    } catch (e) {
      this.log('error', `entry points: ${errorText(e)}`);
      return { error: errorText(e) };
    }
    return result;
  }

  /** FR-16.4 a click in the sidebar: the flow of that entry point in the sequence panel. */
  async openEntryPointFromSidebar(entryPoint: EntryPoint): Promise<void> {
    this.ensureSequencePanel();
    await this.openEntryPoint(entryPoint.method.key, entryPoint);
  }

  private async openEntryPoint(methodKey: string, entryPoint?: EntryPoint): Promise<void> {
    const entry = this.entryPointsEntry ?? this.active;
    if (!entry) return;
    try {
      const diagram = await entry.session.openMethodByKey(methodKey, entryPoint);
      if (!diagram) {
        this.sequence?.post({ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON });
        return;
      }
      this.active = entry;
      await this.afterChange(entry, diagram);
    } catch (e) {
      this.log('error', `open entry point: ${errorText(e)}`);
      this.sequence?.post({ type: 'error', message: errorText(e) });
    }
  }

  // ───────────────────────────── FR-25.2 diagram state to share ─────────────────────────────

  /** The current diagram's state as JSON on the clipboard, or (`save`) in a file chosen in a save dialog. */
  async copyState(from: 'sequence' | 'class' = 'sequence', save = false): Promise<void> {
    const view = from === 'class' && this.classView && !this.classView.isDisposed ? this.classView : this.sequence;
    const entry = this.active;
    const diagram = entry?.session.current();
    if (!entry || !diagram) {
      void dialogs.info('Seqcall: open a sequence diagram first; its state is what gets copied.');
      return;
    }
    try {
      const state = await entry.session.exportState({
        language: entry.language,
        tool: { version: String(this.context.extension.packageJSON.version ?? ''), host: 'vscode' },
        positions: this.store.getPositions(entry.root, diagram.root.key),
      });
      if (!state) return;
      if (save) {
        if (await this.saveState(formatState(state), stateFileName(state))) view?.post({ type: 'diagramState', done: true, save: true }, false);
        return;
      }
      await vscode.env.clipboard.writeText(formatState(state));
      view?.post({ type: 'diagramState', done: true }, false);
      vscode.window.setStatusBarMessage('Seqcall: diagram copied as text — paste it into an issue or chat', 3000);
    } catch (e) {
      this.log('error', `copy state: ${errorText(e)}`);
      view?.post({ type: 'diagramState', error: errorText(e) }, false);
    }
  }

  /** FR-25.4 the shown flow (or, from the class view, its classes) as text, on the clipboard (to paste into an AI chat, an issue, a PR). */
  async copyText(from: 'sequence' | 'class', messageId?: string): Promise<void> {
    const view = from === 'class' && this.classView && !this.classView.isDisposed ? this.classView : this.sequence;
    const entry = this.active;
    // the I/O badges still being scanned: wait, else the text says "none found" for I/O below the folded calls
    await entry?.session.ioScanned();
    const diagram = entry?.session.current();
    const classes = entry && diagram && from === 'class' ? await entry.session.getClassDiagram() : undefined;
    if (!entry || !diagram || (from === 'class' && !classes)) return view?.post({ type: 'diagramText', error: 'No diagram to copy.' }, false);
    const text = classes ? classViewText(entry.root, classes, diagram) : messageId ? askText(entry.root, diagram, messageId) : viewText(entry.root, diagram);
    if (!text) return view?.post({ type: 'diagramText', error: 'That call is no longer in the diagram.' }, false);
    await vscode.env.clipboard.writeText(text);
    view?.post({ type: 'diagramText', done: true }, false);
    vscode.window.setStatusBarMessage(messageId ? 'Seqcall: a prompt about this call copied — paste it into your AI chat or agent' : 'Seqcall: flow copied as text — paste it into a chat, an issue or an AI agent', 3000);
  }

  /** FR-25.2 the state as a .seqcall.json file (a save dialog: webviews cannot download). */
  private async saveState(text: string, name: string): Promise<boolean> {
    const folder = this.active ? fromProtocolPath(this.active.root) : vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await dialogs.save({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters: { 'Seqcall diagram': ['json'] },
      title: 'Save the diagram to open elsewhere (attach it to an issue)',
    });
    if (!uri) return false;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    this.log('info', `diagram saved: ${uri.fsPath}`);
    void dialogs.info(`Diagram saved as ${uri.fsPath.split(/[\\/]/).pop()} — attach it to an issue; Share → Open a shared diagram… opens it`, 'Reveal').then(async (pick) => {
      if (pick === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', uri);
    });
    return true;
  }

  /** FR-25.3 a shared diagram's config is in use: the project's file is not written (the views hold these back too). */
  private refuseConfigWrite(): boolean {
    if (!this.active?.session.configBorrowed()) return false;
    void dialogs.warning('Seqcall: the shared diagram\'s layer config is in use — go back to your config before changing .seqcall.json.', 'Back to my config').then((pick) => {
      if (pick) void this.onSequenceMessage({ type: 'useSharedConfig', on: false });
    });
    return true;
  }

  /** The command: a state on the clipboard opens at once, anything else opens the paste card. */
  async openStateFromClipboard(): Promise<void> {
    const text = await vscode.env.clipboard.readText();
    if (text.includes('seqcall-state')) return this.openState(text);
    this.ensureSequencePanel().post({ type: 'openStatePrompt' }, false);
  }

  /** Opens a shared state in the project holding its root file (loaded projects first, then the workspace folders). */
  async openState(text: string, from: 'sequence' | 'class' = 'sequence'): Promise<void> {
    const host = this.ensureSequencePanel();
    try {
      const state = parseState(text);
      const roots = [
        ...(this.active ? [this.active.root] : []),
        ...this.sessions.all().map((e) => e.root),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => toProtocolPath(f.uri)),
      ];
      const file = await locateStateFile(state, roots);
      if (!file) throw new Error(`${state.root.key.slice(0, state.root.key.indexOf('#'))} is not in this workspace. Open the folder of the project ${state.project.name}${state.project.dir ? ` (${state.project.dir})` : ''} and try again.`);
      await this.sessions.ensure(file, async (entry) => {
        const { diagram, report } = await entry.session.restoreState(state, { language: entry.language, toolVersion: String(this.context.extension.packageJSON.version ?? '') });
        if (diagram && state.positions) await this.store.setPositions(entry.root, diagram.root.key, state.positions);
        this.active = entry;
        await this.afterChange(entry, diagram);
        host.post({ type: 'stateReport', report }, false);
        this.log('info', `opened shared diagram ${report.source}: ${report.differences.length} differences, ${report.missing.length} not found`);
      });
    } catch (e) {
      this.log('error', `open state: ${errorText(e)}`);
      host.post({ type: 'stateReport', error: errorText(e) }, false);
      if (from === 'class') this.classView?.post({ type: 'stateReport', error: errorText(e) }, false);
    }
  }

  // ───────────────────────────── Host → view ─────────────────────────────

  /** Common tail of every mutation: persist, render both panels, remember the root. */
  private async afterChange(entry: ProjectEntry, diagram: SequenceDiagram | undefined): Promise<void> {
    this.sessions.persist(entry);
    // FR-16.4 the sidebar follows the open diagram to another project (unless a project was chosen)
    if (!this.pinnedProject && this.entryPointsEntry && entry !== this.entryPointsEntry && entry === this.active) this.onDidChangeEntryPointsProject.fire();
    this.highlightedMessageId = null;
    if (entry !== this.active) return;
    if (!diagram) {
      this.sequence?.post({ type: 'empty', reason: NO_METHOD_REASON });
    } else {
      this.sequence?.post({
        type: 'render',
        diagram,
        positions: this.store.getPositions(entry.root, diagram.root.key),
      });
      const decl = diagram.root.declaration;
      void this.store.setLastRoot({
        projectRoot: entry.root,
        language: entry.language,
        methodKey: diagram.root.key,
        file: decl?.file,
        position: decl?.start,
      });
      void this.track(this.scanSideEffects(entry));
    }
    await this.updateClassPanel();
  }

  /** Counts `work` as background work until it settles (test API `settled()`). */
  track<T>(work: Promise<T>): Promise<T> {
    this.background++;
    return work.finally(() => this.background--);
  }

  /** Background work is running (test API). */
  get busy(): boolean {
    return this.background > 0;
  }

  /** FR-17.5: deeper I/O badges arrive after the render (background scan); a newer render makes it stale. */
  private async scanSideEffects(entry: ProjectEntry): Promise<void> {
    try {
      const diagram = await entry.session.scanSideEffects();
      if (!diagram || entry !== this.active) return;
      this.sequence?.post({ type: 'render', diagram, positions: this.store.getPositions(entry.root, diagram.root.key) });
      // FR-32.4 the entry point's outcome arrived: the sidebar shows it on its row
      if (diagram.outcome) this.onOutcomes();
    } catch (e) {
      this.log('error', `I/O scan: ${errorText(e)}`);
    }
  }

  /** FR-12.4: live class diagram. */
  private async updateClassPanel(): Promise<void> {
    const host = this.classView;
    if (!host || host.isDisposed) return;
    const entry = this.active;
    if (!entry) {
      host.post({ type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' });
      return;
    }
    try {
      const diagram = await entry.session.getClassDiagram();
      if (entry !== this.active || host.isDisposed) return; // superseded while analysing
      const seq = entry.session.current();
      const maxMethods = setting('classDiagram.maxMethods', 5);
      if (diagram) host.post({ type: 'render', diagram, hiddenFilters: seq?.hiddenFilters, ...(seq ? { options: seq.options } : {}), rootClassKey: seq?.root.owner.key, layerChoices: seq?.layerChoices, maxMethods, ...(seq?.borrowedConfig ? { borrowedConfig: seq.borrowedConfig } : {}) });
      else host.post({ type: 'empty', reason: 'The sequence diagram is empty.' });
    } catch (e) {
      this.log('error', `class diagram: ${errorText(e)}`);
      host.post({ type: 'empty', reason: `Error: ${errorText(e)}` });
    }
  }

  // ───────────────────────────── Editor events ─────────────────────────────

  /** FR-1.7 follow cursor + FR-2.4 highlight (called debounced). */
  async onSelectionChanged(editor: vscode.TextEditor): Promise<void> {
    if (!this.sequence || this.sequence.isDisposed || !isSupportedDocument(editor.document)) return;
    const seq = ++this.selectionSeq;
    const file = toProtocolPath(editor.document.uri);
    const pos = editor.selection.active;
    const position = { line: pos.line, character: pos.character };

    // Selections made by our own navigation must not re-root the diagram.
    if (this.followCursor && !this.navigator.isLastRevealed(editor)) {
      const entry = this.sessions.get(this.sessions.locate(file));
      if (!entry) {
        // New project: load it (with progress) only on explicit follow.
        await this.openAt(file, position);
        return;
      }
      try {
        const method = await entry.adapter.findEnclosingCallable(file, position);
        if (seq !== this.selectionSeq) return; // the cursor moved on meanwhile
        const current = entry === this.active ? entry.session.current() : undefined;
        if (method && method.key !== current?.root.key) {
          this.active = entry;
          const diagram = await entry.session.openMethod(method);
          await this.afterChange(entry, diagram);
          return;
        }
      } catch (e) {
        this.sequence?.post({ type: 'error', message: errorText(e) });
        return;
      }
    }

    // FR-2.4: highlight the visible message whose call site contains the cursor.
    const diagram = this.active?.session.current();
    if (!diagram || !this.sequence) return;
    const id = findMessageAt(diagram.messages, file, position);
    if (id !== this.highlightedMessageId) {
      this.highlightedMessageId = id;
      this.sequence.post({ type: 'highlight', messageId: id }, false);
    }
  }

  /** FR-13.1: re-analyse changed files and re-render. */
  async refreshFiles(files: string[]): Promise<void> {
    for (const entry of this.sessions.all()) {
      const mine = files.filter((f) => isInside(f, entry.root) && languageOf(f) === entry.language);
      if (mine.length === 0) continue;
      try {
        const diagram = await entry.session.refresh(mine);
        if (entry === this.active) await this.afterChange(entry, diagram);
      } catch (e) {
        this.log('error', `refresh: ${errorText(e)}`);
        if (entry === this.active) this.sequence?.post({ type: 'error', message: errorText(e) });
      }
    }
  }

  /**
   * FR-7.5: put a class's file into a layer by adding a rule to the project's
   * .seqcall.json (comments/formatting kept), refresh both panels, offer Undo/Open.
   */
  /** FR-7.5 / FR-7.12 a layer rule for `match` (a scope's glob), else for the class's file; with Undo. */
  private async setLayer(classKey: string, className: string, layer: string, match?: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    const rel = match ?? relPathOfKey(classKey);
    if (!entry || !rel) return;
    const uri = fromProtocolPath(configFileOf(entry.root));
    const configName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    let before: string | undefined;
    try {
      before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      before = undefined;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(setLayerRule(before, rel, layer), 'utf8'));
    } catch (e) {
      void dialogs.error(`Seqcall: cannot write ${configName}: ${errorText(e)}`);
      return;
    }
    this.log('info', `layer: ${rel} → ${layer} (${configName})`);
    await this.reloadClassifierConfig(toProtocolPath(uri));
    void dialogs.info(`${match && match !== relPathOfKey(classKey) ? match : className} → ${layer} layer (rule added to ${configName})`, 'Open', 'Undo').then(async (pick) => {
      if (pick === 'Open') await vscode.window.showTextDocument(uri);
      if (pick === 'Undo') {
        if (before === undefined) await vscode.workspace.fs.delete(uri);
        else await vscode.workspace.fs.writeFile(uri, Buffer.from(before, 'utf8'));
        await this.reloadClassifierConfig(toProtocolPath(uri));
      }
    });
  }

  /** FR-25 the diagram image: a save dialog (webviews cannot download), then Open / Reveal. */
  private async saveImage(name: string, format: 'png' | 'svg', data: string): Promise<void> {
    const folder = this.active ? fromProtocolPath(this.active.root) : vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await dialogs.save({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters: format === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
      title: 'Save the diagram as an image',
    });
    if (!uri) return;
    try {
      await vscode.workspace.fs.writeFile(uri, format === 'png' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8'));
    } catch (e) {
      void dialogs.error(`Seqcall: cannot save the image: ${errorText(e)}`);
      return;
    }
    this.log('info', `image saved: ${uri.fsPath}`);
    void dialogs.info(`Diagram saved as ${uri.fsPath.split(/[\\/]/).pop()}`, 'Open', 'Reveal').then(async (pick) => {
      if (pick === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
      if (pick === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', uri);
    });
  }

  /** FR-12.16 "Adjust the rule" on a layer-violation card: the config at `dependencyRule` (the default added when missing, with Undo). */
  private async openDependencyRule(): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const uri = fromProtocolPath(configFileOf(entry.root));
    const configName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    let before: string | undefined;
    try {
      before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      before = undefined;
    }
    const r = ensureDependencyRule(before);
    if (r.changed) {
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(r.text, 'utf8'));
      } catch (e) {
        void dialogs.error(`Seqcall: cannot write ${configName}: ${errorText(e)}`);
        return;
      }
      await this.reloadClassifierConfig(toProtocolPath(uri));
      void dialogs.info(`The default dependency rule was added to ${configName} — edit the ring of a layer (0 = innermost)`, 'Undo').then(async (pick) => {
        if (pick !== 'Undo') return;
        if (before === undefined) await vscode.workspace.fs.delete(uri);
        else await vscode.workspace.fs.writeFile(uri, Buffer.from(before, 'utf8'));
        await this.reloadClassifierConfig(toProtocolPath(uri));
      });
    }
    const pos = new vscode.Position(r.line, 0);
    const doc = await vscode.workspace.openTextDocument(uri);
    await this.untilDocumentHolds(doc, r.text);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
  }

  /**
   * Waits until `doc` holds `text`. A document open before the file was written reads the new text a moment later; a
   * selection set before that ends up elsewhere (the reload moves it). Unsaved edits: never; 2 s.
   */
  private async untilDocumentHolds(doc: vscode.TextDocument, text: string): Promise<void> {
    if (doc.getText() === text) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        sub.dispose();
        clearTimeout(timer);
        resolve();
      };
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === doc && doc.getText() === text) done();
      });
      const timer = setTimeout(done, 2000);
    });
  }

  /** FR-19.10: "Ignore …" on a finding's card — adds the pattern to `findings.ignore`, with Open / Undo. */
  /** FR-7.11: silences a file's ⚑ layer hint — a glob in `layerHints.ignore` (.seqcall.json), with Undo. */
  private async ignoreLayerHint(pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const uri = fromProtocolPath(configFileOf(entry.root));
    const configName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    let before: string | undefined;
    try {
      before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      before = undefined;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(addLayerHintIgnore(before, pattern), 'utf8'));
    } catch (e) {
      void dialogs.error(`Seqcall: cannot write ${configName}: ${errorText(e)}`);
      return;
    }
    this.log('info', `layerHints.ignore += ${pattern} (${configName})`);
    await this.reloadClassifierConfig(toProtocolPath(uri));
    void dialogs.info(`Layer hint silenced for ${pattern} (added to ${configName})`, 'Open', 'Undo').then(async (pick) => {
      if (pick === 'Open') await vscode.window.showTextDocument(uri);
      if (pick === 'Undo') {
        if (before === undefined) await vscode.workspace.fs.delete(uri);
        else await vscode.workspace.fs.writeFile(uri, Buffer.from(before, 'utf8'));
        await this.reloadClassifierConfig(toProtocolPath(uri));
      }
    });
  }

  private async ignoreFinding(pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const uri = fromProtocolPath(configFileOf(entry.root));
    const configName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    let before: string | undefined;
    try {
      before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      before = undefined;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(addFindingIgnore(before, pattern), 'utf8'));
    } catch (e) {
      void dialogs.error(`Seqcall: cannot write ${configName}: ${errorText(e)}`);
      return;
    }
    this.log('info', `findings.ignore += ${pattern} (${configName})`);
    await this.reloadClassifierConfig(toProtocolPath(uri));
    void dialogs.info(`Ignoring ${pattern} in design findings (added to ${configName})`, 'Open', 'Undo').then(async (pick) => {
      if (pick === 'Open') await vscode.window.showTextDocument(uri);
      if (pick === 'Undo') {
        if (before === undefined) await vscode.workspace.fs.delete(uri);
        else await vscode.workspace.fs.writeFile(uri, Buffer.from(before, 'utf8'));
        await this.reloadClassifierConfig(toProtocolPath(uri));
      }
    });
  }

  /** FR-19.22 Stop ignoring in the ⚠ menu: removes the pattern from `findings.ignore` / `layerHints.ignore`. */
  private async unignore(section: 'findings' | 'layerHints', pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const uri = fromProtocolPath(configFileOf(entry.root));
    const configName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
    try {
      const out = removeIgnore(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), section, pattern);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(out!, 'utf8'));
    } catch (e) {
      void dialogs.error(`Seqcall: cannot write ${configName}: ${errorText(e)}`);
      return;
    }
    this.log('info', `${section}.ignore -= ${pattern} (${configName})`);
    await this.reloadClassifierConfig(toProtocolPath(uri));
  }

  /** `.seqcall.json` changed: reload classifier rules and refresh. */
  async reloadClassifierConfig(configFile: string): Promise<void> {
    const dir = configFile.replace(/\/[^/]*$/, '');
    for (const entry of this.sessions.all()) {
      if (!samePath(entry.root, dir) && !isInside(entry.root, dir)) continue;
      try {
        entry.classifier.reloadConfig();
        const diagram = await entry.session.refresh();
        if (entry === this.active) await this.afterChange(entry, diagram);
      } catch (e) {
        if (entry === this.active) this.sequence?.post({ type: 'error', message: errorText(e) });
      }
    }
  }

  /** Settings changed: apply display options live to all sessions. */
  async onConfigurationChanged(e: vscode.ConfigurationChangeEvent): Promise<void> {
    if (affects(e, 'classDiagram.maxMethods')) await this.updateClassPanel();
    const changed = LIVE_OPTION_SETTINGS.filter((k) => affects(e, k));
    if (changed.length === 0) return;
    for (const entry of this.sessions.all()) {
      const cfg = readConfig(fromProtocolPath(entry.root)).options;
      try {
        let diagram: SequenceDiagram | undefined;
        for (const k of changed) diagram = await entry.session.setOption(k, cfg[k]);
        if (entry === this.active) await this.afterChange(entry, diagram);
        else this.sessions.persist(entry);
      } catch (err) {
        if (entry === this.active) this.sequence?.post({ type: 'error', message: errorText(err) });
      }
    }
  }

  // ───────────────────────────── Restore (FR-13.2) ─────────────────────────────

  async restoreSequencePanel(panel: vscode.WebviewPanel): Promise<void> {
    const host = this.attachSequencePanel(panel);
    const last = this.store.getLastRoot();
    if (!last) {
      host.post({ type: 'empty', reason: NO_METHOD_REASON });
      return;
    }
    // locate() looks at the file's directory, so a placeholder file name inside the root works.
    const anchor = last.file ?? `${last.projectRoot}/__root__`;
    try {
      await this.sessions.ensure(
        anchor,
        async (entry) => {
          const method = await entry.adapter.getMethod(last.methodKey);
          let diagram: SequenceDiagram | undefined;
          if (method) diagram = await entry.session.openMethod(method);
          else if (last.file && last.position) diagram = await entry.session.openAt(last.file, last.position);
          if (!diagram) {
            host.post({ type: 'empty', reason: 'The previous diagram root no longer exists. ' + NO_METHOD_REASON });
            return;
          }
          this.active = entry;
          await this.afterChange(entry, diagram);
        },
        last.language ?? (last.file ? languageOf(last.file) : 'typescript'),
      );
    } catch (e) {
      host.post({ type: 'error', message: errorText(e) });
    }
  }

  async restoreClassPanel(panel: vscode.WebviewPanel): Promise<void> {
    this.attachClassPanel(panel);
    await this.updateClassPanel();
  }

  dispose(): void {
    this.preloadStatus?.dispose();
    this.onDidChangeEntryPointsProject.dispose();
    this.onProjectFindings.dispose();
    this.onReview.dispose();
    this.onReviewEnded.dispose();
    this.output.dispose();
    this.sequence?.dispose();
    this.classView?.dispose();
    this.navigator.dispose();
    this.baseDiff.dispose();
    this.sessions.dispose();
  }
}

/** Innermost visible message whose call site contains the position (FR-2.4). */
export function findMessageAt(messages: Message[], file: string, pos: Position): string | null {
  let best: { id: string; size: number } | undefined;
  const key = pathKey(file);
  for (const m of messages) {
    const r = m.callSite;
    if (!r || m.kind === 'found' || pathKey(r.file) !== key) continue;
    const afterStart = pos.line > r.start.line || (pos.line === r.start.line && pos.character >= r.start.character);
    const beforeEnd = pos.line < r.end.line || (pos.line === r.end.line && pos.character <= r.end.character);
    if (!afterStart || !beforeEnd) continue;
    const size = (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
    if (!best || size <= best.size) best = { id: m.id, size };
  }
  return best?.id ?? null;
}
