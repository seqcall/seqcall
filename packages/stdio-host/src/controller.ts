import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  configFileOf,
  isConfigFile,
  DiagramSession,
  createClassifier,
  createAdapter,
  layerScopes,
  relPathOfKey,
  setLayerRule,
  addFindingIgnore,
  removeIgnore,
  addLayerHintIgnore,
  type Classifier,
  type LanguageAdapter,
  ensureDependencyRule,
  formatState,
  stateFileName,
  locateStateFile,
  parseState,
  entryPointTree,
  throttled,
  unreachableScan,
  viewText,
  classViewText,
  askText,
  codeInfoLines,
  codeInfoPlain,
  CODE_INFO_ITEM,
  megabytes,
  memoryLines,
  processBytes,
  type ProjectMemory,
} from '@seqcall/core';
import type {
  ClassViewToHost,
  DiagramOptions,
  HostToClassView,
  HostToSequenceView,
  Message,
  ParticipantPositions,
  Position,
  SequenceDiagram,
  SequenceViewToHost,
  SourceRange,
  EntryPoint,
  Finding,
  DiffTarget,
  CallPathStep,
} from '@seqcall/protocol';
import { isInside, isSourceFile, languageOf, locateProject, locateWorkspace, pathKey, type ProjectLanguage, type ProjectLocation } from './locate';

/** What the editor host does with the controller's output (the stdio server turns these into notifications). */
export interface HostSink {
  postSequence(msg: HostToSequenceView): void;
  postClass(msg: HostToClassView): void;
  /** Open the file at the range in the editor. */
  navigate(range: SourceRange): void;
  /** FR-24.7 show a reviewed call's file side by side: its merge-base content against the file now, at the line. */
  openDiff?(target: DiffTarget, keepFocus?: boolean): void;
  /** The sequence view asked for the class diagram: the host opens/shows its class view. */
  showClassDiagram(): void;
  log(level: 'info' | 'error', message: string): void;
  /** A long first analysis started (title) or ended (null). */
  progress(title: string | null): void;
}

export interface ControllerOptions {
  /** The IDE's project directory (bounds the TS project-root search, like a VS Code workspace folder). */
  workspace?: string;
  /** Path of Seqcall.CSharp.dll (bundled with the plugin); default: core's resolution (env, dev build). */
  csharpSidecar?: string;
  /** FR-25.2 written into a shared diagram state: the sidecar's version and the editor it serves. */
  toolVersion?: string;
  hostName?: string;
}

interface ProjectEntry {
  readonly root: string;
  readonly language: ProjectLanguage;
  readonly adapter: LanguageAdapter;
  readonly classifier: Classifier;
  readonly session: DiagramSession;
}

const NO_METHOD_REASON =
  'Place the caret inside a method, constructor, getter/setter or function body and run "Show Sequence Diagram".';

/** FR-33.6 Info at Caret is asked for explicitly: it may wait longer than a hover (a C# solution's first walk). */
const DESCRIBE_BUDGET_MS = 8000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Editor-agnostic counterpart of packages/vscode/src/controller.ts: one DiagramSession per
 * project, view intents in, view models out through a HostSink. State lives in memory only
 * (walking skeleton: no persistence across IDE restarts yet).
 */
export class HeadlessController {
  private readonly entries = new Map<string, ProjectEntry>();
  private active: ProjectEntry | undefined;
  private classViewOpen = false;
  private highlighted: string | null = null;
  private readonly positions = new Map<string, ParticipantPositions>();

  constructor(
    private readonly sink: HostSink,
    private readonly opts: ControllerOptions = {},
  ) {}

  // ───────────────────────────── Projects ─────────────────────────────

  private entryFor(loc: ProjectLocation): ProjectEntry | undefined {
    return this.entries.get(`${loc.language}:${pathKey(loc.root)}`);
  }

  private ensure(file: string): ProjectEntry {
    return this.ensureAt(locateProject(file, this.opts.workspace));
  }

  private ensureAt(loc: ProjectLocation): ProjectEntry {
    const existing = this.entryFor(loc);
    if (existing) return existing;
    const make = () =>
      createAdapter(loc.language, loc.root, {
        csharp: { sidecarPath: this.opts.csharpSidecar, log: (line) => this.sink.log('info', `[C#] ${line}`) },
      });
    const adapter = make();
    const classifier = createClassifier(loc.root);
    const entry: ProjectEntry = { ...loc, adapter, classifier, session: new DiagramSession({ adapter, classifier, createBaseAdapter: make }) };
    this.entries.set(`${loc.language}:${pathKey(loc.root)}`, entry);
    return entry;
  }

  // ───────────────────────────── Host requests ─────────────────────────────

  /** FR-1.1 "Show Sequence Diagram" at the caret; true when a diagram opened. */
  async openAt(file: string, position: Position): Promise<boolean> {
    const fresh = !this.entryFor(locateProject(file, this.opts.workspace));
    const entry = this.ensure(file);
    if (fresh) {
      const text = entry.language === 'csharp' ? `Loading C# workspace ${path.basename(entry.root)}…` : `Analysing ${path.basename(entry.root)}…`;
      this.sink.progress(text);
      // FR-16.14 a spinner in the panels too (the IDE's progress bar is easy to miss)
      this.sink.postSequence({ type: 'busy', text });
      if (this.classViewOpen) this.sink.postClass({ type: 'busy', text });
    }
    try {
      const diagram = await entry.session.openAt(file, position);
      if (!diagram) {
        this.sink.postSequence({ type: 'empty', reason: 'No method found at the caret. ' + NO_METHOD_REASON });
        if (this.classViewOpen) this.sink.postClass({ type: 'empty', reason: 'The sequence diagram is empty.' });
        return false;
      }
      this.active = entry;
      await this.afterChange(entry, diagram);
      return true;
    } catch (e) {
      this.sink.log('error', `open: ${errorText(e)}`);
      this.sink.postSequence({ type: 'error', message: errorText(e) });
      return false;
    } finally {
      if (fresh) this.sink.progress(null);
    }
  }

  /** FR-13.1: files saved/changed on disk. */
  async filesChanged(files: string[]): Promise<void> {
    const config = files.find((f) => isConfigFile(f));
    for (const entry of this.entries.values()) {
      try {
        let diagram: SequenceDiagram | undefined;
        if (config && isInside(entry.root, path.dirname(config))) {
          entry.classifier.reloadConfig();
          diagram = await entry.session.refresh();
        } else {
          // source files only, as the VS Code / Rider hosts send them (Vim sends every saved file: a README, a .d.ts)
          const mine = files.filter((f) => isInside(f, entry.root) && isSourceFile(f) && languageOf(f) === entry.language);
          if (mine.length === 0) continue;
          diagram = await entry.session.refresh(mine);
        }
        if (entry === this.active) await this.afterChange(entry, diagram);
      } catch (e) {
        this.sink.log('error', `refresh: ${errorText(e)}`);
        if (entry === this.active) this.sink.postSequence({ type: 'error', message: errorText(e) });
      }
    }
  }

  /** FR-2.4 highlight the message whose call site contains the caret (debounced by the host). */
  async caretMoved(file: string, position: Position): Promise<void> {
    const diagram = this.active?.session.current();
    if (!diagram) return;
    const id = findMessageAt(diagram.messages, file, position);
    if (id === this.highlighted) return;
    this.highlighted = id;
    this.sink.postSequence({ type: 'highlight', messageId: id });
  }

  // ───────────────────────────── View → host ─────────────────────────────

  async onSequenceMessage(msg: SequenceViewToHost): Promise<void> {
    switch (msg.type) {
      case 'log':
        return this.sink.log(msg.level, msg.message);
      case 'navigate':
        return this.sink.navigate(msg.range);
      case 'focusClass': // FR-12.17
        return this.classViewOpen ? this.sink.postClass({ type: 'focusClass', classKey: msg.classKey }) : undefined;
      case 'openClassDiagram':
        return this.sink.showClassDiagram();
      case 'openAppMap': // FR-26 the class view on the codebase map (it asks for the map itself)
        this.appMapSelection = msg.entryPoints;
        if (this.classViewOpen) this.sink.postClass({ type: 'showAppMap', ...(msg.entryPoints?.length ? { entryPoints: msg.entryPoints } : {}) });
        else this.appMapPending = true;
        return this.sink.showClassDiagram();
      case 'setLayer':
        return this.setLayer(msg.classKey, msg.layer, msg.match);
      case 'saveImage': // FR-25 the page downloads the image itself in these hosts
        return this.sink.log('info', `image ${msg.name}: saved by the page`);
      case 'requestLayerScopes': // FR-7.12
        return this.sink.postSequence({ type: 'layerScopes', classKey: msg.classKey, scopes: this.active ? layerScopes(this.active.root, msg.classKey, msg.className) : [] });
      case 'ignoreFinding':
        return this.ignoreFinding(msg.pattern);
      case 'ignoreLayerHint':
        return this.ignoreLayerHint(msg.pattern);
      case 'unignoreFinding':
      case 'unignoreLayerHint':
        return this.unignore(msg.type === 'unignoreFinding' ? 'findings' : 'layerHints', msg.pattern);
      case 'ready': {
        // (Re)loaded view: show the current state.
        const entry = this.active;
        if (entry) await this.renderSequence(entry, entry.session.current());
        else this.sink.postSequence({ type: 'empty', reason: NO_METHOD_REASON });
        // the entry points asked for before the page was there (Vim's :SeqcallEntryPoints)
        if (this.entryPointsPending) {
          this.entryPointsPending = false;
          await this.sendEntryPoints(true);
        }
        return;
      }
      case 'savePositions':
        if (this.active) this.positions.set(`${this.active.root}|${msg.rootKey}`, msg.positions);
        return;
      case 'copyState': // FR-25.2
        return this.copyState('sequence', msg.save);
      case 'copyText': // FR-25.4 / FR-25.5
        return this.copyText('sequence', msg.messageId);
      case 'openState':
        return this.openState(msg.text);
      case 'restoreSettings': {
        const entry = this.active;
        if (!entry) return;
        // as in VS Code: a failure is reported, not thrown past the controller
        try {
          return await this.afterChange(entry, await entry.session.restoreSettings());
        } catch (e) {
          this.sink.log('error', `${msg.type}: ${errorText(e)}`);
          return this.sink.postSequence({ type: 'error', message: errorText(e) });
        }
      }
      case 'useSharedConfig': { // FR-25.3
        const entry = this.active;
        if (!entry) return;
        try {
          return await this.afterChange(entry, await entry.session.useSharedConfig(msg.on));
        } catch (e) {
          this.sink.log('error', `shared config: ${errorText(e)}`);
          return this.sink.postSequence({ type: 'stateReport', error: errorText(e) });
        }
      }
      case 'requestEntryPoints':
        return this.sendEntryPoints();
      case 'switchEntryPointsProject':
        return; // FR-16.11 one project per sidecar: never offered (canSwitchProject unset)
      case 'openDependencyRule':
        return this.openDependencyRule();
      case 'openMethod':
        return this.openEntryPoint(msg.methodKey, msg.entryPoint);
      case 'requestProjectFindings':
        return this.sendProjectFindings(false, msg.rescan);
      case 'cancelProjectFindings':
        this.projectScanCancelled = true;
        return;
      case 'requestUnreachable':
        return this.sendUnreachable(false, msg.rescan);
      case 'cancelUnreachable':
        this.unreachableCancelled = true;
        return;
      case 'openFinding':
        return this.openFinding(msg.entryPoint, msg.finding);
      case 'cancelPaths':
        this.pathsCancelled = true;
        return;
      case 'cancelSearch':
        this.searchGeneration++;
        return;
      case 'requestReview':
        return this.sendReview(false, msg.base, msg.force, msg.mode);
      case 'requestGitRefs': {
        // FR-24.13 the review picker's lists
        const entry = this.entryPointsProject();
        if (!entry) return this.sink.postSequence({ type: 'gitRefs', error: 'Open a project or a source file first.' });
        try {
          return this.sink.postSequence({ type: 'gitRefs', refs: await entry.session.gitRefs() });
        } catch (e) {
          return this.sink.postSequence({ type: 'gitRefs', error: errorText(e) });
        }
      }
      case 'searchMethods': {
        // FR-16.15 the ⌂ filter's method search (no project: nothing found)
        const entry = this.entryPointsProject();
        const r = entry ? await entry.session.searchMethods(msg.query) : { methods: [], more: 0 };
        return this.sink.postSequence({ type: 'methodResults', query: msg.query, ...r });
      }
      case 'cancelReview':
        this.reviewCancelled = true;
        return;
    }
    const entry = this.active;
    if (!entry) return this.sink.postSequence({ type: 'empty', reason: NO_METHOD_REASON });
    const s = entry.session;
    try {
      switch (msg.type) {
        case 'requestCallers':
          return this.sink.postSequence({ type: 'callers', messageId: msg.messageId, callers: await s.getCallers(msg.messageId) });
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
          return this.sink.postSequence({ type: 'highlight', messageId: msg.issue.finding.messageIds?.[0] ?? null, messageIds: msg.issue.finding.messageIds ?? [], finding: msg.issue.finding });
        }
        case 'openReviewStructure': {
          const r = await s.openReviewStructure(msg.row);
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          return this.sink.postSequence({ type: 'highlight', messageId: r.messageId ?? null });
        }
        case 'endReview':
          return this.afterChange(entry, await s.endReview());
        case 'openDiff': {
          const target = msg.classKey ? await s.classDiffTarget(msg.classKey, msg.member) : msg.messageId ? await s.diffTarget(msg.messageId, { method: msg.method }) : undefined;
          if (!target) return this.sink.log('info', 'no diff for this call (the review has ended?)');
          // a host without a diff viewer opens the file at the call
          if (this.sink.openDiff) return this.sink.openDiff(target, msg.keepFocus);
          return this.sink.navigate({ file: target.file, start: { line: target.line, character: 0 }, end: { line: target.line, character: 0 } });
        }
        case 'revealSearchHit': {
          const r = await s.revealSearchHit(msg.hit);
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          return this.sink.postSequence({ type: 'highlight', messageId: r.messageId });
        }
        case 'openPath':
          return this.openPathIn(entry, msg.steps, msg.entryPoint);
        // FR-24.9 / FR-24.10 stepping through the review's changes
        case 'showChange':
        case 'revealChange':
        case 'openChangeFlow': {
          const r = await (msg.type === 'revealChange' ? s.revealChange(msg.messageId) : msg.type === 'showChange' ? s.showChange(msg.n) : s.openChangeFlow(msg.paths, msg.entryPoint));
          if (!r) return;
          await this.afterChange(entry, r.diagram);
          return this.sink.postSequence({ type: 'highlight', messageId: r.messageId });
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
        case 'setOption':
          return this.afterChange(entry, await s.setOption(msg.option, msg.value as DiagramOptions[typeof msg.option]));
        case 'setLayerOpen': // FR-28.7
          return this.afterChange(entry, await s.setLayerOpen(msg.layer, msg.open));
        case 'foldLayers': // FR-28.9
          return this.afterChange(entry, await s.foldAllLayers());
        default: {
          const unknown: never = msg;
          this.sink.log('error', `unknown sequence view message ${JSON.stringify(unknown)}`);
        }
      }
    } catch (e) {
      this.sink.log('error', `${msg.type}: ${errorText(e)}`);
      this.sink.postSequence({ type: 'error', message: errorText(e) });
    }
  }

  async onClassMessage(msg: ClassViewToHost): Promise<void> {
    switch (msg.type) {
      case 'log':
        return this.sink.log(msg.level, msg.message);
      case 'ready':
        this.classViewOpen = true;
        if (this.appMapPending) {
          this.appMapPending = false;
          this.sink.postClass({ type: 'showAppMap', ...(this.appMapSelection?.length ? { entryPoints: this.appMapSelection } : {}) });
        }
        return this.updateClass();
      case 'requestAppMap':
        return this.sendAppMap(msg.path ?? '', !!msg.rescan, msg.open, msg.entryPoints);
      case 'cancelAppMap':
        this.appMapCancelled = true;
        return;
      case 'navigate':
        return this.sink.navigate(msg.range);
      case 'openDiff': // FR-24.11 a changed class side by side
        return this.onSequenceMessage(msg);
      case 'hide':
      case 'unhide':
      case 'unhideAll':
      case 'focus': // FR-12.13: focus on a class-diagram method's call
      case 'setOption': // a mark of both diagrams, from the class view
      case 'setLayerOpen': // FR-28.7
      case 'foldLayers': // FR-28.9
        return this.onSequenceMessage(msg); // shared filters / options: both views re-render
      case 'copyState': // FR-25.2 / FR-25.3 the flow's state, as from the sequence view
        return this.copyState('class', msg.save);
      case 'copyText': // FR-25.4
        return this.copyText('class');
      case 'openState':
        return this.openState(msg.text, 'class');
      case 'useSharedConfig':
        return this.onSequenceMessage(msg);
      // a design issue picked in the codebase map: its flow, in the sequence diagram
      case 'openFinding':
        return this.openFinding(msg.entryPoint, msg.finding);
      case 'openDependencyRule':
        return this.openDependencyRule();
      case 'setLayer':
        return this.setLayer(msg.classKey, msg.layer, msg.match);
      case 'saveImage': // FR-25 the page downloads the image itself in these hosts
        return this.sink.log('info', `image ${msg.name}: saved by the page`);
      case 'requestLayerScopes': // FR-7.12
        return this.sink.postClass({ type: 'layerScopes', classKey: msg.classKey, scopes: this.active ? layerScopes(this.active.root, msg.classKey, msg.className) : [] });
      case 'ignoreFinding':
        return this.ignoreFinding(msg.pattern);
      case 'ignoreLayerHint':
        return this.ignoreLayerHint(msg.pattern);
      case 'unignoreFinding':
      case 'unignoreLayerHint':
        return this.unignore(msg.type === 'unignoreFinding' ? 'findings' : 'layerHints', msg.pattern);
      case 'findInFlow':
        // FR-23.4 not among the drawn classes: find it in the flow (its collapsed calls too)
        return this.sink.postSequence({ type: 'openFind', query: msg.query });
      case 'revealRelation': {
        // FR-12.14 the calls behind a relation are collapsed: open them, then highlight
        const entry = this.active;
        if (!entry) return;
        // as in VS Code: a failure is logged, not thrown past the controller
        try {
          const r = await entry.session.revealRelation(msg.from, msg.to, msg.field);
          if (!r.messageIds.length) {
            // no call through it (FR-12.9): the field's declaration, else the class
            const target = r.fieldDeclaration ?? msg.fallback;
            return target ? this.sink.navigate(target) : undefined;
          }
          await this.afterChange(entry, r.diagram);
          this.highlighted = r.messageIds[0];
          return this.sink.postSequence({ type: 'highlight', messageId: this.highlighted, messageIds: r.messageIds });
        } catch (e) {
          return this.sink.log('error', `reveal relation: ${errorText(e)}`);
        }
      }
      case 'openInSequence': // 
        return this.sink.postSequence({ type: 'openPanel', panel: msg.panel, messageId: msg.messageId });
      case 'highlightMessages': // FR-12.9
        this.highlighted = msg.messageIds[0] ?? null;
        return this.sink.postSequence({ type: 'highlight', messageId: this.highlighted, messageIds: msg.messageIds });
      case 'setTypeUses': // FR-12.12
        if (!this.active) return;
        try {
          await this.active.session.setOption('showTypeUses', msg.value);
          await this.updateClass();
        } catch (e) {
          this.sink.log('error', `class diagram: ${errorText(e)}`);
        }
        return;
    }
  }

  /** Project of the last entry-point list. */
  private entryPointsEntry: ProjectEntry | undefined;
  /** the entry points were asked for while no sequence page was connected: sent on its `ready`. */
  private entryPointsPending = false;

  /** the editor asks for the entry-point list (Vim's :SeqcallEntryPoints): now, or once the page is there. */
  async showEntryPoints(connected: boolean): Promise<void> {
    if (connected) return this.sendEntryPoints(true);
    this.entryPointsPending = true;
  }

  /** FR-16.2 / FR-19.9: the diagram's project, else the IDE's workspace. */
  private entryPointsProject(): ProjectEntry | undefined {
    return this.active ?? (this.opts.workspace ? this.ensureAt(locateWorkspace(this.opts.workspace)) : undefined);
  }

  /** FR-16.2: the diagram's project, else the IDE's workspace. */
  async sendEntryPoints(show = false): Promise<void> {
    const entry = this.entryPointsProject();
    if (!entry) return this.sink.postSequence({ type: 'entryPoints', entryPoints: [], error: 'No project open.', show });
    this.entryPointsEntry = entry;
    const project = path.basename(entry.root);
    try {
      this.sink.progress(`Finding entry points in ${project}…`);
      const entryPoints = await entry.session.getEntryPoints();
      // FR-16.4 the panel's ⌂ list as the VS Code sidebar shows it
      this.sink.postSequence({ type: 'entryPoints', entryPoints, project, show, tree: entryPointTree(entryPoints, project) });
    } catch (e) {
      this.sink.log('error', `entry points: ${errorText(e)}`);
      this.sink.postSequence({ type: 'entryPoints', entryPoints: [], project, error: errorText(e), show });
    } finally {
      this.sink.progress(null);
    }
  }

  private projectScanCancelled = false;
  /** FR-26 the sequence view asked for the map before the class view was open. */
  private appMapPending = false;
  /** FR-26.8 the entry points the pending map is for (absent = all). */
  private appMapSelection: string[] | undefined;
  private appMapCancelled = false;

  /** FR-26 the codebase map at a folder (progress while the entry points are scanned; cached by the session). */
  async sendAppMap(folder: string, rescan = false, open?: string[], entryPoints?: string[]): Promise<void> {
    const entry = this.entryPointsProject();
    if (!entry) return this.sink.postClass({ type: 'appMap', state: 'error', error: 'Open a project or a source file first.' });
    this.appMapCancelled = false;
    const project = path.basename(entry.root);
    let last = 0;
    this.sink.postClass({ type: 'appMap', state: 'running', done: 0, project });
    try {
      const level = await entry.session.getAppMap(folder, {
        rescan,
        open,
        entryPoints,
        cancelled: () => this.appMapCancelled,
        onProgress: (done, total) => {
          const now = Date.now();
          if (now - last < 250 && done < total) return;
          last = now;
          this.sink.postClass({ type: 'appMap', state: 'running', done, total, project });
        },
      });
      this.sink.postClass(level ? { type: 'appMap', state: 'done', level, project } : { type: 'appMap', state: 'cancelled', project });
    } catch (e) {
      this.sink.log('error', `codebase map: ${errorText(e)}`);
      this.sink.postClass({ type: 'appMap', state: 'error', error: errorText(e), project });
    }
  }

  /** FR-31: a running unreachable-code scan stops at its next step. */
  private unreachableCancelled = false;

  /** FR-31 the methods no entry point reaches (progress while running; cached by the session). */
  async sendUnreachable(show = false, rescan = false): Promise<void> {
    const entry = this.entryPointsProject();
    if (!entry) return this.sink.postSequence({ type: 'unreachable', state: 'error', error: 'Open a project or a source file first.', show });
    this.entryPointsEntry = entry;
    this.unreachableCancelled = false;
    const project = path.basename(entry.root);
    this.sink.postSequence({ type: 'unreachable', state: 'running', phase: 'reach', done: 0, project, show });
    try {
      const r = await entry.session.findUnreachableCode({ rescan, cancelled: () => this.unreachableCancelled, onProgress: throttled((phase, done, total) => this.sink.postSequence({ type: 'unreachable', state: 'running', phase, done, total, project })) });
      this.sink.postSequence(r ? { type: 'unreachable', state: 'done', result: unreachableScan(r), project } : { type: 'unreachable', state: 'cancelled', project });
    } catch (e) {
      this.sink.log('error', `unreachable code: ${errorText(e)}`);
      this.sink.postSequence({ type: 'unreachable', state: 'error', error: errorText(e), project });
    }
  }

  /** FR-19.9 design issues of the whole project (progress while running; cached by the session). */
  async sendProjectFindings(show = false, rescan = false): Promise<void> {
    const entry = this.entryPointsProject();
    if (!entry) return this.sink.postSequence({ type: 'projectFindings', state: 'error', error: 'Open a project or a source file first.', show });
    this.entryPointsEntry = entry;
    this.projectScanCancelled = false;
    const project = path.basename(entry.root);
    let last = 0;
    this.sink.postSequence({ type: 'projectFindings', state: 'running', done: 0, project, show });
    try {
      const findings = await entry.session.findProjectIssues({
        rescan,
        cancelled: () => this.projectScanCancelled,
        onProgress: (done, total) => {
          const now = Date.now();
          if (now - last < 250 && done < total) return;
          last = now;
          this.sink.postSequence({ type: 'projectFindings', state: 'running', done, total, project });
        },
        // FR-19.23 the entry points' findings while the methods none reaches are looked for
        onEntryPointsDone: (findings) => this.sink.postSequence({ type: 'projectFindings', state: 'running', findings, walking: true, project }),
      });
      this.sink.postSequence(findings ? { type: 'projectFindings', state: 'done', findings, total: entry.session.projectEntryPointCount, truncated: entry.session.projectTruncatedCount, unreached: entry.session.projectUnreachedCount, ...(entry.session.projectFindingsChanged ? { changed: true } : {}), outcomes: entry.session.entryOutcomes(), project } : { type: 'projectFindings', state: 'cancelled', project });
    } catch (e) {
      this.sink.log('error', `design issues: ${errorText(e)}`);
      this.sink.postSequence({ type: 'projectFindings', state: 'error', error: errorText(e) });
    }
  }

  /** FR-24: a running review stops at its next step. */
  private reviewCancelled = false;
  /** FR-24.13 since the split (a pull request) or tip against tip. */
  private reviewMode: 'split' | 'direct' = 'split';
  private reviewBase = 'develop';

  /** FR-24 review of the current branch: progress while it runs, then the result (the diagram marks the changes). */
  async sendReview(show = false, base?: string, force = false, mode?: 'split' | 'direct'): Promise<void> {
    const entry = this.entryPointsProject();
    if (!entry) return this.sink.postSequence({ type: 'review', state: 'error', error: 'Open a project or a source file first.', show });
    this.entryPointsEntry = entry;
    if (base) this.reviewBase = base;
    if (mode) this.reviewMode = mode;
    this.reviewCancelled = false;
    let last = 0;
    this.sink.postSequence({ type: 'review', state: 'running', phase: 'Reading the changes (git)', show });
    try {
      const result = await entry.session.reviewChanges({
        base: this.reviewBase,
        force,
        mode: this.reviewMode,
        cancelled: () => this.reviewCancelled,
        onProgress: (phase, done, total) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.sink.postSequence({ type: 'review', state: 'running', phase, done, total });
        },
      });
      this.sink.postSequence(result ? { type: 'review', state: 'done', result } : { type: 'review', state: 'cancelled' });
      if (result && entry === this.active) await this.afterChange(entry, await entry.session.redraw());
    } catch (e) {
      this.sink.log('error', `review: ${errorText(e)}`);
      this.sink.postSequence({ type: 'review', state: 'error', error: errorText(e) });
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
          this.sink.postSequence({ type: 'searchResults', query, state: 'running', methods });
        },
      });
      // a newer query or the closed find bar (cancelSearch) supersedes this search: its result is dropped. No result
      // only then — the search's only early end is `cancelled()`, which is `!current()` (core search.ts searchBelow)
      if (!r || !current()) return;
      this.sink.postSequence({ type: 'searchResults', query, state: 'done', hits: r.hits, methods: r.methods, truncated: r.truncated, ...(deeper ? { deeper } : {}) });
    } catch (e) {
      this.sink.log('error', `find: ${errorText(e)}`);
      if (current()) this.sink.postSequence({ type: 'searchResults', query, state: 'error', error: errorText(e) });
    }
  }

  /** FR-22: a running paths-to-here walk stops before its next references query. */
  private pathsCancelled = false;

  /** FR-22 paths to here of a message's method (progress while the callers are walked). */
  private async sendPaths(entry: ProjectEntry, messageId: string): Promise<void> {
    this.pathsCancelled = false;
    let last = 0;
    this.sink.postSequence({ type: 'paths', messageId, state: 'running', methods: 0 });
    try {
      const r = await entry.session.findPathsToHere(messageId, {
        cancelled: () => this.pathsCancelled,
        onProgress: (methods) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          this.sink.postSequence({ type: 'paths', messageId, state: 'running', methods });
        },
      });
      this.sink.postSequence(r ? { type: 'paths', messageId, state: 'done', tree: r.tree, methods: r.methods, truncated: r.truncated } : { type: 'paths', messageId, state: 'cancelled' });
    } catch (e) {
      this.sink.log('error', `paths to here: ${errorText(e)}`);
      this.sink.postSequence({ type: 'paths', messageId, state: 'error', error: errorText(e) });
    }
  }

  /** FR-19.9: the flow of a project finding, expanded as the scan saw it, with the evidence highlighted. */
  private async openFinding(entryPoint: EntryPoint, finding: Finding): Promise<void> {
    const entry = this.entryPointsEntry ?? this.active;
    if (!entry) return;
    try {
      const diagram = await entry.session.openFinding(entryPoint);
      if (!diagram) return this.sink.postSequence({ type: 'empty', reason: 'That entry point no longer exists. ' + NO_METHOD_REASON });
      this.active = entry;
      await this.afterChange(entry, diagram);
      this.sink.postSequence({ type: 'highlight', messageId: finding.messageIds?.[0] ?? null, messageIds: finding.messageIds ?? [], finding });
    } catch (e) {
      this.sink.postSequence({ type: 'error', message: errorText(e) });
    }
  }

  private async openEntryPoint(methodKey: string, entryPoint?: EntryPoint): Promise<void> {
    const entry = this.entryPointsEntry ?? this.active;
    if (!entry) return;
    try {
      const diagram = await entry.session.openMethodByKey(methodKey, entryPoint);
      if (!diagram) return this.sink.postSequence({ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON });
      this.active = entry;
      await this.afterChange(entry, diagram);
    } catch (e) {
      this.sink.log('error', `open entry point: ${errorText(e)}`);
      this.sink.postSequence({ type: 'error', message: errorText(e) });
    }
  }

  /** FR-25.2 the current diagram's state as JSON to share (the page copies or downloads it). */
  private async copyState(from: 'sequence' | 'class' = 'sequence', save = false): Promise<void> {
    const post = (m: { type: 'diagramState'; text?: string; error?: string; save?: boolean; name?: string }) => (from === 'class' ? this.sink.postClass(m) : this.sink.postSequence(m));
    const entry = this.active;
    const diagram = entry?.session.current();
    if (!entry || !diagram) return post({ type: 'diagramState', error: 'No diagram to share.' });
    try {
      const state = await entry.session.exportState({
        language: entry.language,
        tool: { ...(this.opts.toolVersion ? { version: this.opts.toolVersion } : {}), ...(this.opts.hostName ? { host: this.opts.hostName } : {}) },
        positions: this.positions.get(`${entry.root}|${diagram.root.key}`),
      });
      post(state ? { type: 'diagramState', text: formatState(state), ...(save ? { save, name: stateFileName(state) } : {}) } : { type: 'diagramState', error: 'No diagram to share.' });
    } catch (e) {
      this.sink.log('error', `copy state: ${errorText(e)}`);
      post({ type: 'diagramState', error: errorText(e) });
    }
  }

  /** FR-25.4 the shown flow (or its classes) as text; the view that asked copies it (JCEF / the browser tab). */
  private async copyText(from: 'sequence' | 'class', messageId?: string): Promise<void> {
    const post = (m: { type: 'diagramText'; text?: string; error?: string }) => (from === 'class' ? this.sink.postClass(m) : this.sink.postSequence(m));
    const entry = this.active;
    // the I/O badges still being scanned: wait, else the text says "none found" for I/O below the folded calls
    await entry?.session.ioScanned();
    const diagram = entry?.session.current();
    const classes = entry && diagram && from === 'class' ? await entry.session.getClassDiagram() : undefined;
    if (!entry || !diagram || (from === 'class' && !classes)) return post({ type: 'diagramText', error: 'No diagram to copy.' });
    const text = classes ? classViewText(entry.root, classes, diagram) : messageId ? askText(entry.root, diagram, messageId) : viewText(entry.root, diagram);
    post(text ? { type: 'diagramText', text } : { type: 'diagramText', error: 'That call is no longer in the diagram.' });
  }

  /** FR-25.3 a shared diagram's config is in use: the project's file is not written (the views hold these back too). */
  private refuseConfigWrite(): boolean {
    if (!this.active?.session.configBorrowed()) return false;
    this.sink.log('error', `the shared diagram's layer config is in use: ${path.basename(configFileOf(this.active.root))} not changed (Back to my config first)`);
    return true;
  }

  /** FR-25.2 opens a shared state in the project holding its root file (the loaded projects first, then the workspace). */
  private async openState(text: string, from: 'sequence' | 'class' = 'sequence'): Promise<void> {
    try {
      const state = parseState(text);
      const roots = [...(this.active ? [this.active.root] : []), ...[...this.entries.values()].map((e) => e.root), ...(this.opts.workspace ? [this.opts.workspace] : [])];
      const file = await locateStateFile(state, roots);
      if (!file) throw new Error(`${state.root.key.slice(0, state.root.key.indexOf('#'))} is not in this workspace. Open the state in the project ${state.project.name}${state.project.dir ? ` (${state.project.dir})` : ''}.`);
      const entry = this.ensure(file);
      const { diagram, report } = await entry.session.restoreState(state, { language: entry.language, toolVersion: this.opts.toolVersion });
      if (diagram && state.positions) this.positions.set(`${entry.root}|${diagram.root.key}`, state.positions);
      this.active = entry;
      await this.afterChange(entry, diagram);
      this.sink.postSequence({ type: 'stateReport', report });
    } catch (e) {
      this.sink.log('error', `open state: ${errorText(e)}`);
      this.sink.postSequence({ type: 'stateReport', error: errorText(e) });
      if (from === 'class') this.sink.postClass({ type: 'stateReport', error: errorText(e) });
    }
  }

  /** The host closed its class view: stop deriving class diagrams. */
  classViewClosed(): void {
    this.classViewOpen = false;
  }

  // ───────────────────────────── Host → view ─────────────────────────────

  private async afterChange(entry: ProjectEntry, diagram: SequenceDiagram | undefined): Promise<void> {
    this.highlighted = null;
    if (entry !== this.active) return;
    this.renderSequence(entry, diagram);
    if (diagram) void this.scanSideEffects(entry);
    await this.updateClass();
  }

  /** FR-17.5: deeper I/O badges arrive after the render (background scan); a newer render makes it stale. */
  private async scanSideEffects(entry: ProjectEntry): Promise<void> {
    try {
      const diagram = await entry.session.scanSideEffects();
      if (diagram && entry === this.active) this.renderSequence(entry, diagram);
    } catch (e) {
      this.sink.log('error', `I/O scan: ${errorText(e)}`);
    }
  }

  private renderSequence(entry: ProjectEntry, diagram: SequenceDiagram | undefined): void {
    if (!diagram) this.sink.postSequence({ type: 'empty', reason: NO_METHOD_REASON });
    else this.sink.postSequence({ type: 'render', diagram, positions: this.positions.get(`${entry.root}|${diagram.root.key}`) });
  }

  /** FR-12.4 live class diagram. */
  private async updateClass(): Promise<void> {
    if (!this.classViewOpen) return;
    const entry = this.active;
    if (!entry) return this.sink.postClass({ type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' });
    try {
      const diagram = await entry.session.getClassDiagram();
      if (entry !== this.active) return;
      const seq = entry.session.current();
      // no sequence diagram any more (its root method was deleted, FR-13.1): the session still derives the classes of
      // the flow it had — the view would show classes of a diagram that is gone
      if (!diagram || !seq) this.sink.postClass({ type: 'empty', reason: 'The sequence diagram is empty.' });
      else this.sink.postClass({ type: 'render', diagram, hiddenFilters: seq.hiddenFilters, options: seq.options, rootClassKey: seq.root.owner.key, layerChoices: seq.layerChoices, ...(seq.borrowedConfig ? { borrowedConfig: seq.borrowedConfig } : {}) });
    } catch (e) {
      this.sink.log('error', `class diagram: ${errorText(e)}`);
      this.sink.postClass({ type: 'empty', reason: `Error: ${errorText(e)}` });
    }
  }

  /** FR-7.5: an explicit user action in the view; adds a rule to the project's .seqcall.json. */
  /** FR-7.5 / FR-7.12 a layer rule for `match` (a scope's glob), else for the class's file. */
  private async setLayer(classKey: string, layer: string, match?: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    const rel = match ?? relPathOfKey(classKey);
    if (!entry || !rel) return;
    const file = configFileOf(entry.root);
    try {
      fs.writeFileSync(file, setLayerRule(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, rel, layer));
    } catch (e) {
      this.sink.log('error', `cannot write ${file}: ${errorText(e)}`);
      return;
    }
    this.sink.log('info', `layer: ${rel} → ${layer} (${path.basename(file)})`);
    await this.filesChanged([file.replace(/\\/g, '/')]);
  }

  /** FR-12.16 "Adjust the rule": the config at `dependencyRule` (the default written when missing — an explicit user action). */
  private async openDependencyRule(): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const file = configFileOf(entry.root);
    let r: ReturnType<typeof ensureDependencyRule>;
    // the read too (an unreadable config: a folder of that name, no permission), as the other config writes
    try {
      r = ensureDependencyRule(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
      if (r.changed) fs.writeFileSync(file, r.text);
    } catch (e) {
      this.sink.log('error', `cannot write ${file}: ${errorText(e)}`);
      return;
    }
    if (r.changed) {
      this.sink.log('info', `dependencyRule: the default added to ${path.basename(file)}`);
      await this.filesChanged([file.replace(/\\/g, '/')]);
    }
    const at = { line: r.line, character: 0 };
    this.sink.navigate({ file: file.replace(/\\/g, '/'), start: at, end: at });
  }

  /** FR-19.10: an explicit user action in the view; adds a pattern to `findings.ignore` in .seqcall.json. */
  private async ignoreFinding(pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const file = configFileOf(entry.root);
    try {
      fs.writeFileSync(file, addFindingIgnore(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, pattern));
    } catch (e) {
      this.sink.log('error', `cannot write ${file}: ${errorText(e)}`);
      return;
    }
    this.sink.log('info', `findings.ignore += ${pattern} (${path.basename(file)})`);
    await this.filesChanged([file.replace(/\\/g, '/')]);
  }

  /** FR-7.11: an explicit user action in the view; adds a file glob to `layerHints.ignore` in .seqcall.json. */
  private async ignoreLayerHint(pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const file = configFileOf(entry.root);
    try {
      fs.writeFileSync(file, addLayerHintIgnore(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, pattern));
    } catch (e) {
      this.sink.log('error', `cannot write ${file}: ${errorText(e)}`);
      return;
    }
    this.sink.log('info', `layerHints.ignore += ${pattern} (${path.basename(file)})`);
    await this.filesChanged([file.replace(/\\/g, '/')]);
  }

  /** FR-19.22 Stop ignoring in the ⚠ menu: removes the pattern from `findings.ignore` / `layerHints.ignore`. */
  private async unignore(section: 'findings' | 'layerHints', pattern: string): Promise<void> {
    if (this.refuseConfigWrite()) return;
    const entry = this.active;
    if (!entry) return;
    const file = configFileOf(entry.root);
    try {
      const out = removeIgnore(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, section, pattern);
      if (out === undefined) return;
      fs.writeFileSync(file, out);
    } catch (e) {
      this.sink.log('error', `cannot write ${file}: ${errorText(e)}`);
      return;
    }
    this.sink.log('info', `${section}.ignore -= ${pattern} (${path.basename(file)})`);
    await this.filesChanged([file.replace(/\\/g, '/')]);
  }

  /** FR-22 a path opened top-down from its start, expanded to its last method, which is highlighted. */
  private async openPathIn(entry: ProjectEntry, steps: CallPathStep[], entryPoint?: EntryPoint): Promise<void> {
    const opened = await entry.session.openPath(steps, entryPoint);
    if (!opened) return this.sink.postSequence({ type: 'empty', reason: 'That method no longer exists. ' + NO_METHOD_REASON });
    this.active = entry;
    await this.afterChange(entry, opened.diagram);
    this.sink.postSequence({ type: 'highlight', messageId: opened.messageId });
  }

  // ───────────────────────────── Info at Caret (FR-33.6) ─────────────────────────────

  /**
   * FR-33.6 what the hover says at the caret (Rider: *Info at Caret*, Vim: `:SeqcallInfo`): its lines — those starting
   * with `item` belong to the line above; `plain`: the same with the items numbered, for a text popup —, every entry point the callers lead to (for the pick list), and whether the
   * caret is on a method's name (then *Paths to here* applies). Asked explicitly, so it loads the project when needed.
   */
  async describeAt(file: string, position: Position, word?: string): Promise<{ lines: string[]; item: string; plain: string[]; routes: string[]; onName: boolean } | null> {
    const entry = this.ensure(file);
    try {
      const info = await entry.session.describeAt(file, position, { ...(word ? { word } : {}), budgetMs: DESCRIBE_BUDGET_MS });
      if (!info) return null;
      const lines = codeInfoLines(info, entry.root);
      return { lines, item: CODE_INFO_ITEM, plain: codeInfoPlain(lines), routes: info.reach?.routes?.map((r) => r.entryPoint.label) ?? [], onName: !info.call };
    } catch (e) {
      this.sink.log('error', `info: ${errorText(e)}`);
      return null;
    }
  }

  /**
   * FR-33.7 an entry point from *Info at Caret*: route `index` opens its flow down to the method; `paths` opens the
   * method's diagram with its Paths to here.
   */
  async openReach(file: string, position: Position, word: string | undefined, target: number | 'paths'): Promise<void> {
    const entry = this.ensure(file);
    if (target === 'paths') {
      if (await this.openAt(file, position)) this.sink.postSequence({ type: 'openPanel', panel: 'paths', messageId: 'root' });
      return;
    }
    const info = await entry.session.describeAt(file, position, { ...(word ? { word } : {}), budgetMs: 30_000 });
    const route = info?.reach?.routes?.[target];
    if (!route) return this.sink.log('error', `no entry point ${target} reaches the method at the caret`);
    await this.openPathIn(entry, route.steps, route.entryPoint);
  }

  // ───────────────────────────── Memory (FR-34.4) ─────────────────────────────

  /**
   * FR-34.4 this process (the analysis of TypeScript / PHP and the diagrams; exact, it is Seqcall's own) and the C#
   * sidecars of the loaded projects: one line each, and a summary.
   */
  async memory(): Promise<{ lines: string[]; summary: string }> {
    const projects: ProjectMemory[] = await Promise.all(
      [...this.entries.values()].map(async (e) => ({ name: path.basename(e.root), language: e.language, ...(await e.session.processMemory()) })),
    );
    const own = process.memoryUsage().rss;
    const csharp = processBytes(projects);
    const lines = [`Seqcall (this process, pid ${process.pid}): ${megabytes(own)}`];
    if (projects.length) lines.push(...memoryLines(projects, "analysed in Seqcall's own process (above)"));
    return { lines, summary: `Seqcall uses ${megabytes(own)}${csharp ? `, the C# analysis ${megabytes(csharp)}` : ''}.` };
  }

  /** FR-34.4 Free Memory: every loaded project drops its caches and kept scans and stops its C# sidecar. */
  async freeMemory(): Promise<string> {
    const held = processBytes(await Promise.all([...this.entries.values()].map(async (e) => ({ name: '', language: e.language, ...(await e.session.processMemory()) }))));
    await Promise.all([...this.entries.values()].map((e) => e.session.freeMemory()));
    const message = held
      ? `Seqcall dropped its caches and stopped the C# analysis (${megabytes(held)}); it loads again with the next diagram.`
      : 'Seqcall dropped its caches.';
    this.sink.log('info', message);
    return message;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.values()].flatMap((e) => [e.adapter.dispose().catch(() => undefined), e.session.dispose().catch(() => undefined)]));
    this.entries.clear();
  }
}

/** Innermost visible message whose call site contains the position (FR-2.4; same as the VS Code host). */
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
