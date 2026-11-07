import type {
  Finding,
  EntryOutcome,
  FlowOutcome,
  LayerHint,
  ClassRef,
  CallerInfo,
  CallPathStep,
  ReviewIssue,
  ReviewResult,
  ReviewStructure,
  StructureRow,
  SearchHit,
  SourceRange,
  EntryPoint,
  RouteMiddleware,
  ExpandNotice,
  FindingKind,
  Importance,
  ProjectFinding,
  ClassDiagram,
  DiagramOptions,
  HideFilter,
  HideFilterSpec,
  MethodRef,
  Position,
  SequenceDiagram,
  SideEffectKind,
  ClassChange,
  ClassMember,
  DiffLine,
  MemberChange,
  Message,
  DiffTarget,
  StereotypeReason,
  GitRefs,
  AppMapLevel,
  ClassNode,
  ClassRelation,
  DiagramStateReport,
  DiagramStateSnapshot,
  ParticipantPositions,
  BorrowedConfig,
  IgnoredPatterns,
  UnreachableMethod,
  CodeCallInfo,
  CodeInfo,
  SideEffects,
  ProcessMemory,
} from '@seqcall/protocol';
import { gitRefs } from './review/git-refs';
import { listSourceFiles } from './project-files';
import { applyRoles, heldClasses, MAX_DELEGATE_DEPTH, portsAndAdapters } from './roles';
import type { CallSite, ClassInfo, ContainerBinding, FileType, FragmentScope, LanguageAdapter } from './adapter';
import type { Classifier } from './classifier';
import { deriveClassDiagram, guessedLayers, methodGroupWriter, type MethodTypeUses } from './class-diagram';
import { activeRecordBase, isModel } from './active-record';
import { classFindings, flowFindings, layerViolationFindings, mergeCycles, withoutTypeUses, withClassEvidence, withMessageEvidence, type ClassSize } from './findings';
import { buildAppLevel, mergeScans, type AppModel, type EntryPointScan } from './app-map';
import { fileOfClassKey } from './class-key';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { suggestLayer, type Purity } from './layer-hints';
import { directIo, followTargets, ioBelow, ioKindOfCall, ioCallName, ioOfCall, ioOfImplementations, isIoLibrary, libraryClients, libraryIo, MAX_IO_DEPTH, MAX_IO_IMPLEMENTATIONS, MAX_IO_METHODS, toSideEffects, withLambdaCalls, type IoFinding } from './side-effects';
import { findPathsToHere, type PathsResult } from './paths';
import { callAt as callUnderCursor, reachOf, whatRuns } from './code-info';
import { reviewBranch, type ReviewMarks } from './review/review';
import { createBaseAdapter } from './review/base-version';
import { branchChanges, callChangeLines, git, hunkAround, isChangedLine, type BranchChanges } from './review/git-changes';
import { diffFlow, mergeRemoved, movedKey, type FlowDiff } from './review/flow-diff';
import { changeAt, collectChanges, firstHeldBy, hasOwnChange, interfaceChangesLast, placeChanges, type FlowChanges, type PlacedChanges } from './review/flow-changes';
import { TestFileMatcher } from './test-files';
import { SEARCH_DEEPER_LIMITS, SEARCH_LIMITS, searchBelow, type SearchAnchor } from './search';
import { AnalysisCache } from './session/cache';
import { type CallEnd, type CompiledSmartConfig, compileSmartConfig, expansionPriority, messageFacts, revealValue, scoreCall } from './smart-expand';
import { offPathOperands, offPathReason, onlyBuildsFailure } from './main-path';
import { type BuildResult, type ViewState, buildDiagram, classInCategory } from './session/build';
import { bindingLookup } from './session/bindings';
import { configFileOf, isConfigFile } from './classifier-impl';
import { withProjects } from './entry-point-projects';
import { timeSlicer } from './time-slice';
import { findUnreachable, unreachableGroup, type UnreachableResult } from './unreachable';
import { codeDifferences, gitState, limitChanged, readConfigText, STATE_FORMAT, STATE_SCHEMA_VERSION } from './session/share';
import { cutFrom } from './text';
import { outcomeOfFlow } from './outcomes';
import { markFoldableBands, markFoldableClasses, projectClassLayers, projectLayers, zoomKey } from './layer-zoom';
import { affectedScans, diffStructure, entryIdentity, type IoUse } from './review/structure-diff';

/** State the host persists per workspace (FR-11.2) and passes back on start. */
export interface SessionPersistentState {
  filters: HideFilter[];
  options: DiagramOptions;
}

// calm defaults for a first look — no arguments, results or return types; I/O badges and fragments stay (the design findings point at them)
export const DEFAULT_OPTIONS: DiagramOptions = {
  showArguments: false,
  maxArgumentLength: 30,
  showLibraryCalls: false,
  followCursor: false,
  showFragments: true,
  showPipeline: true,
  showTypeUses: false,
  showSideEffects: true,
  scanSideEffects: true,
  showFindings: true,
  autoTidy: true,
  showReviewMarks: true,
  showResults: false,
  showReturnTypes: false,
  mergeHelpers: false,
  layerZoom: false,
  foldErrors: true,
};

export interface DiagramSessionDeps {
  adapter: LanguageAdapter;
  classifier: Classifier;
  initialState?: Partial<SessionPersistentState>;
  /** Initial expansion depth (FR-1.3). Default 1 = direct calls of the root only. */
  defaultDepth?: number;
  /** Pre-select the implementation when exactly one exists (FR-8.5). Default true. */
  autoSelectSingleImplementation?: boolean;
  /**
   * FR-24.6 a fresh adapter of the same kind for the same project — fed the base version of the branch's
   * files during a review, to draw what the branch added and removed in a flow. Without it: no comparison.
   */
  createBaseAdapter?(): LanguageAdapter;
  /** A session working for another one (project scan, review, issues below): no background issue check of its own. */
  internal?: boolean;
}


/** Bounds for "expand all" (FR-3.3) and for rendering. */
/** Levels Expand all opens (below the clicked message for Expand all below); the message budget is the real cap. */
const MAX_EXPAND_DEPTH = 12;
const MAX_EXPAND_MESSAGES = 500;
const MAX_RENDER_MESSAGES = 2000;
const MAX_HISTORY = 50;
/**
 * The flow itself: the root and what it calls. Expand all / Smart without a scope open only these — the steps drawn
 * before the root (FR-8.7 container, FR-18.14 pipeline) stay as the developer left them.
 */
const inFlow = (id: string): boolean => id === 'root' || id.startsWith('root/');
/** FR-19 `findings.ignore` globs (on `Class.method` / class names). */
function ignoreMatcher(globs: unknown): (name: string) => boolean {
  const list = Array.isArray(globs) ? globs.filter((g): g is string => typeof g === 'string' && g.length > 0) : [];
  // no globs: a matcher of nothing
  return picomatch(list, { dot: true });
}

/** FR-17.5: adapter requests in flight per step of the background scan (keeps user operations responsive). */
const SCAN_BATCH = 4;

/** FR-16.15 the languages' source extensions (a method search before any entry point is known). */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.cs', '.php']);

/** at most this many methods no entry point reaches are scanned (each is expanded fully). */
const MAX_UNREACHED = 400;
/** FR-19.23 a method the unreachable-code walk reaches but no entry point's flow opened (cut by the expand limit, an event handler, a callback). */
const NOT_OPENED = 'not opened by any entry point\'s flow';

/**
 * Editor-agnostic exploration state machine. Every mutating method resolves to the new
 * (already filtered, labelled and grouped) diagram, or undefined if there is no root.
 * Hosts call `getPersistentState()` after mutations to persist filters/options.
 *
 * The adapter is asynchronous; all public operations are serialized (one at a time, in call
 * order), so overlapping UI intents cannot interleave their reads and writes of the state.
 */
export class DiagramSession {
  private readonly adapter: LanguageAdapter;
  private readonly classifier: Classifier;
  private readonly cache: AnalysisCache;
  private readonly defaultDepth: number;
  private readonly autoSelect: boolean;
  private filters: HideFilter[];
  private options: DiagramOptions;
  /** FR-8.4: remembered implementation class per interface/abstract class key. */
  private readonly interfaceChoices = new Map<string, string>();
  private history: ViewState[] = [];
  private index = -1;
  private lastBuild: BuildResult | undefined;
  private lastDiagram: SequenceDiagram | undefined;
  /** FR-25.4 the I/O part of the background scan running now (`ioScanned`). */
  private ioScan: Promise<SequenceDiagram | undefined> | undefined;
  /** FR-28 while zoomed to layers: per drawn call, the calls folded into it (`expand` opens the collapsed ones). */
  private lastFolded: Map<string, string[]> = new Map();
  private readonly callersCache = new Map<string, CallerInfo[]>();
  /** FR-22 references per method key for paths-to-here walks (until refresh). */
  private readonly pathCallers = new Map<string, Promise<CallerInfo[]>>();
  /** FR-7.7 purity per class key (undefined = unknown), until the next refresh. */
  private readonly purityMemo = new Map<string, Purity | undefined>();
  /** FR-16.1 entry points of the project (one scan, until the next refresh). */
  private entryPoints: Promise<EntryPoint[]> | undefined;
  /** FR-19.9 the last project-wide design-issue scan (until refresh). */
  private projectFindings: ProjectFinding[] | undefined;
  /** FR-19.9 entry points the last scan covered. */
  private projectScanned = 0;
  /** FR-26.4 what each entry point's flow reached (FR-19.9 findings too), kept until a file it touched changes. */
  private readonly epScans = new Map<string, EntryPointScan>();
  /** FR-26 when the last entry point was scanned (ISO). */
  private epScansAt: string | undefined;
  /** FR-26.4 entry points the last walk scanned (the others were cached). */
  private epRescanned = 0;
  /** FR-26 the merged scans (until one changes). */
  private appModel: AppModel | undefined;
  /** FR-26.8 the model of the last selection of entry points (its keys, sorted, joined). */
  private appModelSelected: { key: string; model: AppModel } | undefined;
  /** One walk over the entry points at a time; the next one starts where a cancelled one stopped. */
  private walking: Promise<unknown> | undefined;
  /** FR-16.3 the scanned entry points once known (read synchronously when rendering). */
  private entryPointList: EntryPoint[] | undefined;
  /** FR-3.3: the notice of the last expand-everything, shown by the next render only. */
  private pendingNotice: ExpandNotice | undefined;
  /** Bumped by every render: a side-effect scan started before a newer render is stale (FR-17.5). */
  private renderGeneration = 0;
  /**
   * Bumped by every code change (`invalidate`): a project-wide scan that ran across one read old and new code — its
   * result is returned (marked) but not kept, and the per-flow scans it made after the change are not stored.
   */
  private codeGeneration = 0;
  /** The last `findProjectIssues` result spans a code change (not kept: the next request scans again). */
  private projectChanged = false;
  /** The render the background step made itself last (reRenderIfChanged): no user step. */
  private stepRender = -1;
  /** Tail of the operation queue (see `serialized`). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: DiagramSessionDeps) {
    this.adapter = deps.adapter;
    this.classifier = deps.classifier;
    this.createBaseAdapter = deps.createBaseAdapter;
    this.cache = new AnalysisCache(deps.adapter, deps.classifier);
    this.defaultDepth = Math.max(1, deps.defaultDepth ?? 1);
    this.autoSelect = deps.autoSelectSingleImplementation ?? true;
    this.filters = [...(deps.initialState?.filters ?? [])];
    this.options = { ...DEFAULT_OPTIONS, ...(deps.initialState?.options ?? {}) };
    this.internal = !!deps.internal;
  }

  private readonly internal: boolean;
  /** the issues of each flow expanded fully (root key | entry point → issues), from a background session. */
  private readonly deepIssues = new Map<string, Finding[]>();
  /** FR-32.1 the outcome of the same fully expanded flow (by `deepKey`). */
  private readonly deepOutcomes = new Map<string, FlowOutcome>();
  /** FR-32.4 the outcomes of the entry points opened (by `appMapEntryKey`), until the code changes. */
  private readonly openedOutcomes = new Map<string, FlowOutcome>();
  private deepSession: DiagramSession | undefined;
  /** The options and hide filters the background session was made with (another set: a new session). */
  private deepSessionFor = '';

  private get state(): ViewState | undefined {
    return this.history[this.index];
  }

  /** Runs `op` after every previously started operation has settled (failed ones included). */
  private serialized<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op, op);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ───────────── opening / history ─────────────

  /** FR-1.1: diagram of the method enclosing the position. Pushes history. */
  openAt(file: string, position: Position): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const method = await this.adapter.findEnclosingCallable(file, position);
      return method ? this.doOpenMethod(method) : undefined;
    });
  }

  /**
   * FR-16.2: diagram of a method by key (an entry point); undefined when it no longer exists.
   * FR-16.3 `entry`: the entry point it was chosen as — shown at the found message.
   */
  openMethodByKey(methodKey: string, entry?: EntryPoint): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const method = await this.adapter.getMethod(methodKey);
      return method ? this.doOpenMethod(method, entry?.method.key === method.key ? entry : undefined) : undefined;
    });
  }

  /** FR-16.3 the entry-point list for tagging a diagram's root, scanned in the background the first time; true = it arrived now. */
  private async ensureEntryPoints(): Promise<boolean> {
    if (this.entryPointList || !this.adapter.getEntryPoints) return false;
    try {
      await this.getEntryPoints();
    } catch {
      return false;
    }
    const state = this.state;
    return !!state && this.rootEntryPoints(state).length > 0;
  }

  /** FR-16.1: where flows start in the project — scanned once, cached until refresh. */
  getEntryPoints(): Promise<EntryPoint[]> {
    this.entryPoints ??= (this.adapter.getEntryPoints?.() ?? Promise.resolve([])).then(
      (found) => {
        // FR-16.8 several projects under the root (a solution, a monorepo): each entry point names its own
        const list = withProjects(this.classifier.projectRoot?.() ?? this.adapter.projectRoot, found);
        this.entryPointList = list;
        return list;
      },
      (e: unknown) => {
        this.entryPoints = undefined;
        throw e;
      },
    );
    return this.entryPoints;
  }

  /**
   * FR-19.9 design issues of the whole project: every entry point (tests excluded) is opened in a
   * separate session — the user's diagram and history stay untouched — expanded fully (FR-3.3), I/O
   * scanned (FR-17.5), and its flow and class findings collected, deduplicated (the first entry point
   * reaching a finding is kept, the others counted). One entry point at a time, so `cancelled` takes
   * effect quickly and user operations interleave; cached until refresh (or `rescan`).
   */
  async findProjectIssues(
    opts: {
      onProgress?(done: number, total: number): void;
      /** The entry points are scanned: their findings, while the methods none reaches are looked for (FR-31, can take minutes). */
      onEntryPointsDone?(findings: ProjectFinding[]): void;
      cancelled?(): boolean;
      rescan?: boolean;
    } = {},
  ): Promise<ProjectFinding[] | undefined> {
    if (this.projectFindings && !opts.rescan) {
      this.projectChanged = false;
      return this.projectFindings;
    }
    if (opts.rescan) this.dropScans();
    const generation = this.codeGeneration;
    const scans = await this.scanEntryPoints(opts, false);
    if (!scans) return undefined;
    // code no entry point reaches is checked too (else a guard gets a false "all clear"): the methods the
    // unreachable-code list (FR-31) names, so ⚠ and ∅ agree; that walk is shared with ∅ and kept across saves
    opts.onEntryPointsDone?.(this.collectFindings(scans).findings);
    const list = await this.findUnreachableCode({ cancelled: opts.cancelled, rescan: opts.rescan });
    if (!list) return undefined;
    const unreached = await this.scanUnreached(scans, list, opts);
    if (!unreached) return undefined;
    const { findings } = this.collectFindings([...scans, ...unreached]);
    this.projectTruncated = scans.filter((x) => x.truncated).length;
    // the code changed while it ran: shown (marked), not kept — the next request scans again
    this.projectChanged = generation !== this.codeGeneration;
    if (this.projectChanged) return findings;
    this.projectFindings = findings;
    return this.projectFindings;
  }

  /**
   * FR-19.9 the issues of scanned flows, project-wide: the same flaw reached from several entry points is one finding
   * ("+N more"). Also the codebase map's ⚠ N.
   */
  private collectFindings(scans: EntryPointScan[]): { findings: ProjectFinding[] } {
    const found = new Map<string, ProjectFinding>();
    for (const s of scans) {
      // ids hold flow-specific message paths, so the kind and title identify a finding project-wide
      for (const { finding: f, classKeys } of s.findings) {
        const key = `${f.kind}|${f.title}`;
        const known = found.get(key);
        if (known) {
          known.others = (known.others ?? 0) + 1;
          continue;
        }
        const evidence = new Set(classKeys.map(fileOfClassKey).filter((x): x is string => !!x));
        found.set(key, { finding: f, entryPoint: s.entry, files: [...evidence] });
      }
    }
    const order: FindingKind[] = ['io-in-loop', 'io-in-domain', 'cyclic-collaboration', 'dependency-cycle', 'layer-ping-pong', 'god-class', 'too-many-dependencies', 'layer-violation'];
    const findings = [...found.values()].sort(
      (a, b) => order.indexOf(a.finding.kind) - order.indexOf(b.finding.kind) || Number(a.finding.title.startsWith('Possible')) - Number(b.finding.title.startsWith('Possible')) || a.finding.title.localeCompare(b.finding.title),
    );
    return { findings };
  }

  /**
   * FR-26 the codebase map at the folder `path` ('' = the top): the classes and relations every
   * entry point's flow reaches (tests excluded), merged — see `buildAppLevel`. The flows are the
   * design-issue scan's (FR-19.9): one walk serves both; only entry points whose files changed since
   * are scanned again (FR-26.4), `rescan` scans all.
   */
  async getAppMap(
    path = '',
    opts: { onProgress?(done: number, total: number): void; cancelled?(): boolean; rescan?: boolean; open?: string[]; /** FR-26.8 only these entry points (`appMapEntryKey`). */ entryPoints?: string[] } = {},
  ): Promise<AppMapLevel | undefined> {
    if (opts.rescan) this.dropScans();
    const only = opts.entryPoints?.length ? new Set(opts.entryPoints) : undefined;
    const scans = await this.scanEntryPoints({ ...opts, only }, true);
    if (!scans) return undefined;
    // FR-26.8 a selection merges only its entry points' flows (the whole map's model stays cached as it is)
    let model: AppModel;
    if (only) {
      const key = [...only].sort().join('\n');
      if (this.appModelSelected?.key !== key) this.appModelSelected = { key, model: mergeScans(scans) };
      model = this.appModelSelected.model;
    } else model = this.appModel ??= mergeScans(scans);
    // the map's ⚠ N lists the design issues of the same walk too (its violations are the level's own list)
    const findings = this.collectFindings(scans).findings.filter((f) => f.finding.kind !== 'layer-violation');
    return {
      ...buildAppLevel(model, path, { layerOrder: this.classifier.layerOrder(), computedAt: this.epScansAt ?? new Date().toISOString(), open: opts.open }),
      rescanned: this.epRescanned,
      ...(findings.length ? { findings } : {}),
    };
  }

  private dropScans(): void {
    this.epScans.clear();
    this.unreachedScans.clear();
    this.fileTypes.clear();
    this.appModel = undefined;
    this.appModelSelected = undefined;
    this.projectFindings = undefined;
  }

  /**
   * FR-19.9 / FR-26.1 every entry point (tests excluded) is opened in a separate session — the
   * user's diagram and history stay untouched — expanded fully (FR-3.3), I/O scanned (FR-17.5); its
   * findings, classes and relations are kept per entry point. Entry points scanned before (and not
   * changed since) are reused. One entry point at a time, so `cancelled` takes effect quickly and user
   * operations interleave; undefined when cancelled (what was scanned so far is kept).
   */
  private async scanEntryPoints(opts: { onProgress?(done: number, total: number): void; cancelled?(): boolean; only?: Set<string> }, follow: boolean): Promise<EntryPointScan[] | undefined> {
    while (this.walking) await this.walking.catch(() => undefined);
    const run = this.walkEntryPoints(opts, follow);
    this.walking = run;
    try {
      return await run;
    } finally {
      // still this run's: the others wait above until it is cleared, and set their own right after
      this.walking = undefined;
    }
  }

  /** `follow` (the map, FR-26.2): also where each flow stops — the design issues need only the flows. */
  private async walkEntryPoints(opts: { onProgress?(done: number, total: number): void; cancelled?(): boolean; only?: Set<string> }, follow: boolean): Promise<EntryPointScan[] | undefined> {
    const all = (await this.getEntryPoints()).filter((e) => e.kind !== 'test');
    // FR-26.8 a selection scans (and returns) only its entry points; scans of the others are kept
    const eps = opts.only ? all.filter((e) => opts.only!.has(entryKey(e))) : all;
    if (!opts.only) this.projectScanned = eps.length;
    const keys = new Set(all.map(entryKey));
    for (const k of [...this.epScans.keys()]) {
      if (keys.has(k)) continue;
      this.epScans.delete(k); // a route that no longer exists
      this.appModel = undefined;
      this.appModelSelected = undefined;
      this.projectFindings = undefined;
    }
    const done = new Map<string, EntryPointScan>();
    for (const e of eps) {
      const known = this.epScans.get(entryKey(e));
      if (known) done.set(entryKey(e), known);
    }
    const todo = eps.filter((e) => {
      const known = this.epScans.get(entryKey(e));
      return !known || (follow && known.pending);
    });
    this.epRescanned = todo.length;
    if (todo.length) {
      const scan = new DiagramSession({
        adapter: this.adapter,
        classifier: this.classifier,
        internal: true,
        initialState: { options: { ...this.options, showLibraryCalls: false, showFindings: true, showSideEffects: true, scanSideEffects: true, showTypeUses: false, layerZoom: false, foldedLayers: [], foldErrors: false } },
      });
      const subFlows = new Map<string, SubFlow>(); // FR-26.2 method flows, shared by the entry points of this walk
      const cached = eps.length - todo.length;
      // gives way between flows: in-process adapters (TS, PHP) would otherwise hold the host for the whole walk
      const slice = timeSlicer();
      for (let i = 0; i < todo.length; i++) {
        await slice();
        if (opts.cancelled?.()) return undefined;
        const e = todo[i];
        const generation = this.codeGeneration;
        const result = this.epScans.get(entryKey(e)) ?? (await scanEntryPoint(scan, this.adapter, e));
        if (follow && result.pending) await followStops(scan, this.adapter, result, subFlows);
        done.set(entryKey(e), result);
        // the code changed while it was scanned: used for this answer, not kept
        if (generation === this.codeGeneration) this.epScans.set(entryKey(e), result);
        this.appModel = undefined;
        this.appModelSelected = undefined;
        this.projectFindings = undefined;
        opts.onProgress?.(cached + i + 1, eps.length);
      }
      this.epScansAt = new Date().toISOString();
    } else opts.onProgress?.(eps.length, eps.length);
    // not read back from epScans: a change during the walk may have dropped scans read at its start (each entry
    // point is in `done`: known at the start, or scanned above)
    return eps.map((e) => done.get(entryKey(e))!);
  }

  /**
   * FR-19.23 code the entry points' flows did not open, each method scanned as an entry point would be
   * (expanded fully, I/O scanned), so its issues are listed too, marked `unreached`. First the methods the unreachable-code
   * walk (FR-31) reaches but no flow opened (a flow cut by the expand limit, an event handler, a callback): they run, and
   * their issues would be missed otherwise; then the walk's list (so ⚠ and ∅ name the same methods and groups) — those
   * no other unreached method calls first, their flows take in the ones they call. A method seen inside an earlier scan
   * is not scanned again; at most MAX_UNREACHED methods (the rest are counted, the order decides which). Undefined when
   * cancelled.
   */
  private async scanUnreached(scans: EntryPointScan[], list: UnreachableResult, opts: { onProgress?(done: number, total: number): void; cancelled?(): boolean }): Promise<EntryPointScan[] | undefined> {
    const seen = new Set<string>();
    const reach = (s: EntryPointScan) => {
      for (const c of s.classes) for (const m of c.methods) seen.add(`${c.key}|${m.name}`);
    };
    scans.forEach(reach);
    const isSeen = (m: MethodRef) => seen.has(`${m.owner.key}|${m.name}`);
    // a cycle of unreached methods has no first one: they come after, unless a scan before took them in
    const listed = [...list.methods.filter((u) => u.reason !== 'unreached-callers'), ...list.methods.filter((u) => u.reason === 'unreached-callers')];
    const fromList = listed.map((u) => ({ method: u.method, why: `no entry point reaches it: ${unreachableGroup(u)}` }));
    const known = new Set(listed.map((u) => u.method.key));
    const candidates: { method: MethodRef; why: string }[] = [];
    // the project's language: the extensions of the files the flows reached
    const files = new Set(scans.flatMap((s) => [...s.files]));
    const extensions = new Set([...files].map((f) => f.slice(f.lastIndexOf('.'))).filter((e) => e.length > 1));
    for (const t of await this.projectTypes(extensions)) {
      if (t.type.kind === 'interface' || t.type.kind === 'external' || t.type.kind === 'unknown') continue;
      // test code is no production path (as the entry points: tests excluded)
      if (this.classifier.classify(t.type, undefined).layerReason?.rule === 'test') continue;
      for (const m of t.methods) if (m.hasBody && !known.has(m.key)) candidates.push({ method: m, why: NOT_OPENED });
    }
    candidates.push(...fromList);
    const open = candidates.filter((c) => !isSeen(c.method));
    this.projectUnreached = { scanned: 0, skipped: Math.max(0, open.length - MAX_UNREACHED), ...(list.stale ? { stale: true } : {}) };
    const scan = new DiagramSession({
      adapter: this.adapter,
      classifier: this.classifier,
      internal: true,
      initialState: { options: { ...this.options, showLibraryCalls: false, showFindings: true, showSideEffects: true, scanSideEffects: true, showTypeUses: false, layerZoom: false, foldedLayers: [], foldErrors: false } },
    });
    const out: EntryPointScan[] = [];
    const slice = timeSlicer();
    const todo = open.slice(0, MAX_UNREACHED);
    for (let i = 0; i < todo.length; i++) {
      const { method, why } = todo[i];
      if (isSeen(method)) continue;
      // scanned before and its files unchanged (as the entry points' scans, FR-26.4)
      let result = this.unreachedScans.get(method.key);
      if (!result) {
        await slice();
        if (opts.cancelled?.()) return undefined;
        opts.onProgress?.(this.projectScanned + i + 1, this.projectScanned + todo.length);
        // a list kept across saves may be older than the code: the method as it is now, if it is still there
        const m = await this.adapter.getMethod(method.key);
        if (!m) continue;
        const entry: EntryPoint = { kind: 'handler', label: `${m.owner.name}.${m.name}`, detail: 'not reached by any entry point', method: m, unreached: true, unreachedWhy: why };
        const generation = this.codeGeneration;
        result = await scanEntryPoint(scan, this.adapter, entry);
        if (generation === this.codeGeneration) this.unreachedScans.set(method.key, result);
      }
      reach(result);
      this.projectUnreached.scanned++;
      // a scan kept from an older list: its row says what the list says now
      if (result.findings.length) out.push(result.entry.unreachedWhy === why ? result : { ...result, entry: { ...result.entry, unreachedWhy: why } });
    }
    return out;
  }

  /** FR-19.23 / FR-16.15 the types of the project's source files with these extensions (each file asked once, cached). */
  private async projectTypes(extensions: ReadonlySet<string>): Promise<FileType[]> {
    const root = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
    const out: FileType[] = [];
    for (const file of listSourceFiles(root, extensions)) {
      let types = this.fileTypes.get(file);
      if (!types) this.fileTypes.set(file, (types = (await this.adapter.getFileTypes?.(`${root}/${file}`)) ?? []));
      out.push(...types);
    }
    return out;
  }

  /**
   * FR-16.15 the project's methods whose `Class.method` holds every word of the query (case-insensitive),
   * for the ⌂ filter: a feature found by name without an editor cursor (a browser host, a newcomer). The language is the
   * entry points' (else every supported one). Tests last; at most `limit`, `more` counts the rest.
   */
  async searchMethods(query: string, limit = 30): Promise<{ methods: MethodRef[]; more: number }> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { methods: [], more: 0 };
    const known = this.entryPoints ? await this.entryPoints.catch(() => []) : [];
    const extensions = new Set(known.map((e) => /(\.\w+)#/.exec(e.method.owner.key)).filter((x) => x !== null).map((x) => x[1]));
    const all: { m: MethodRef; test: boolean }[] = [];
    for (const t of await this.projectTypes(extensions.size ? extensions : SOURCE_EXTENSIONS)) {
      if (t.type.kind === 'external' || t.type.kind === 'unknown') continue;
      for (const m of t.methods) {
        const name = `${t.type.kind === 'module' ? '' : `${t.type.name}.`}${m.name}`.toLowerCase();
        if (words.every((w) => name.includes(w))) all.push({ m, test: this.classifier.classify(t.type, undefined).layerReason?.rule === 'test' });
      }
    }
    all.sort((a, b) => Number(a.test) - Number(b.test));
    return { methods: all.slice(0, limit).map((x) => x.m), more: Math.max(0, all.length - limit) };
  }

  /** methods no entry point reaches that the last project-wide scan checked, and those left out. */
  get projectUnreachedCount(): { scanned: number; skipped: number; stale?: boolean } {
    return this.projectUnreached;
  }

  private projectUnreached: { scanned: number; skipped: number; stale?: boolean } = { scanned: 0, skipped: 0 };
  /** FR-19.23 the scans of methods no entry point reaches (by method key), kept as the entry points' are. */
  private unreachedScans = new Map<string, EntryPointScan>();
  /** FR-19.23 the types (and methods) each source file declares, for the scan of unreached code. */
  private fileTypes = new Map<string, FileType[]>();

  /**
   * FR-31.1 the project's methods no entry point reaches (see `findUnreachable`). Kept across saves, marked `stale` (the
   * walk takes up to minutes; a save rarely changes what is reached) until `rescan` or a changed project config. Not
   * serialized: user operations interleave. Undefined when cancelled.
   */
  async findUnreachableCode(opts: { onProgress?(phase: 'reach' | 'check', done: number, total?: number): void; cancelled?(): boolean; rescan?: boolean } = {}): Promise<UnreachableResult | undefined> {
    if (this.unreachable && !opts.rescan) return this.unreachableAt === this.codeGeneration ? this.unreachable : { ...this.unreachable, stale: true };
    const generation = this.codeGeneration;
    const root = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
    const tests = new TestFileMatcher(root);
    const prefix = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    const result = await findUnreachable({
      adapter: this.adapter,
      entryPoints: await this.getEntryPoints(),
      isTest: (file) => {
        const f = file.replace(/\\/g, '/');
        return tests.isTest(f.startsWith(prefix) ? f.slice(prefix.length) : f);
      },
      callers: (m) => this.cachedCallers(m),
      ignored: (m) => {
        const file = m.declaration?.file.replace(/\\/g, '/') ?? '';
        return !!this.classifier.unreachableIgnored?.(file.startsWith(prefix) ? file.slice(prefix.length) : file, `${m.owner.name}.${m.name}`);
      },
      ...opts,
    });
    if (!result) return undefined;
    // the code changed while it walked: shown (marked), not kept — the next request walks again
    if (generation !== this.codeGeneration) return { ...result, changed: true };
    this.unreachable = result;
    this.unreachableAt = generation;
    return result;
  }

  /** FR-31.1 the last unreachable-code scan (kept across saves; dropped with the project config). */
  private unreachable: UnreachableResult | undefined;
  /** The code generation the kept scan was made at: older = `stale`. */
  private unreachableAt = 0;

  /**
   * FR-32.5 the outcome of every entry point's flow (tests excluded; `only`: these, by `appMapEntryKey`), from the
   * scans the design-issue scan (FR-19.9) makes and keeps — one walk serves both. Undefined when cancelled.
   */
  async findOutcomes(opts: { only?: Set<string>; onProgress?(done: number, total: number): void; cancelled?(): boolean } = {}): Promise<{ entry: EntryPoint; outcome?: FlowOutcome; failed?: true }[] | undefined> {
    const scans = await this.scanEntryPoints(opts, false);
    return scans?.map((s) => ({ entry: s.entry, ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.failed ? { failed: true as const } : {}) }));
  }

  /**
   * FR-32.4 the outcomes known now, for the entry-point lists: those of the project scans kept (FR-19.9) and of the
   * entry points opened (newer), by `appMapEntryKey`. Nothing is scanned for it.
   */
  entryOutcomes(): Record<string, EntryOutcome> {
    const out: Record<string, EntryOutcome> = {};
    const put = (k: string, o: FlowOutcome) => (out[k] = { kinds: o.io.map((x) => x.kind), ...(o.atLeast ? { atLeast: true as const } : {}) });
    for (const [k, scan] of this.epScans) if (scan.outcome) put(k, scan.outcome);
    for (const [k, o] of this.openedOutcomes) put(k, o);
    return out;
  }

  /** FR-19.9 entry points the last project-wide scan covered (0: nothing to scan, e.g. a library). */
  get projectEntryPointCount(): number {
    return this.projectScanned;
  }

  /** flows of the last project-wide scan that hit the expand limit (their deepest calls stayed folded). */
  get projectTruncatedCount(): number {
    return this.projectTruncated;
  }

  /** The last `findProjectIssues` answer read code that changed while it ran (it was not kept). */
  get projectFindingsChanged(): boolean {
    return this.projectChanged;
  }

  private projectTruncated = 0;

  /**
   * FR-19.9 opens the flow a project finding was found in the way the scan saw it (expanded fully,
   * I/O scanned), so the finding's evidence ids are valid in this view.
   */
  openFinding(entry: EntryPoint): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const method = await this.adapter.getMethod(entry.method.key);
      if (!method) return undefined;
      // FR-19.23 a method no entry point reaches is opened as itself (no entry point's steps before it)
      return this.doOpenMethod(method, entry.unreached ? undefined : entry);
    }).then(async (d) => {
      if (!d) return undefined;
      await this.expandEverything();
      return (await this.scanSideEffects()) ?? this.current();
    });
  }

  /**
   * FR-16.3 the entry points of the current root: the one it was opened from first, then the others of the
   * already scanned list (no scan is started for this — on a C# solution a scan takes seconds).
   */
  private rootEntryPoints(state: ViewState): EntryPoint[] {
    const out: EntryPoint[] = [];
    const id = (e: EntryPoint) => `${e.kind}|${e.label}`;
    const seen = new Set<string>();
    const add = (e: EntryPoint) => {
      if (e.method.key !== state.root.key || seen.has(id(e))) return;
      seen.add(id(e));
      out.push(e);
    };
    if (state.entry) add(state.entry);
    // non-test entry points before tests
    for (const e of [...(this.entryPointList ?? [])].sort((a, b) => Number(a.kind === 'test') - Number(b.kind === 'test'))) add(e);
    return out;
  }

  openMethod(method: MethodRef): Promise<SequenceDiagram> {
    return this.serialized(() => this.doOpenMethod(method));
  }

  private async doOpenMethod(method: MethodRef, entry?: EntryPoint): Promise<SequenceDiagram> {
    this.push({ root: method, expanded: new Set(), choices: new Map(), ...(entry ? { entry } : {}) });
    for (let level = 1; level < this.defaultDepth; level++) {
      if (!(await this.expandOneLevel())) break;
    }
    return (await this.render())!;
  }

  /**
   * FR-16.10 loads the project in the background (hosts call it when a workspace opens): the first diagram then
   * finds it ready. Not serialized — a diagram asked meanwhile shares the same load.
   */
  async warmUp(): Promise<void> {
    await this.adapter.warmUp?.();
  }

  /** The diagram produced by the most recent operation (no analysis). */
  current(): SequenceDiagram | undefined {
    return this.lastDiagram;
  }

  back(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (this.index > 0) await this.goTo(this.index - 1);
      return this.render();
    });
  }

  forward(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (this.index < this.history.length - 1) await this.goTo(this.index + 1);
      return this.render();
    });
  }

  private push(state: ViewState): void {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(state);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.index = this.history.length - 1;
    this.callersCache.clear();
  }

  private async goTo(index: number): Promise<void> {
    this.index = index;
    const state = this.history[index];
    // the root may have moved since the entry was recorded
    state.root = (await this.adapter.getMethod(state.root.key)) ?? state.root;
    this.callersCache.clear();
  }

  // ───────────── expand / collapse ─────────────

  expand(messageId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const nodes = await this.nodes();
      const node = nodes.get(messageId);
      if (this.state && node?.expandable && !node.expanded) this.state.expanded.add(messageId);
      // FR-28 zoomed to layers, the call is open: ⊕ opens the collapsed calls folded into it (one level)
      else if (this.state && this.layerFold()) {
        for (const id of this.lastFolded.get(messageId) ?? []) {
          const n = nodes.get(id);
          if (n?.expandable && !n.expanded) this.state.expanded.add(id);
        }
      }
      return this.render();
    });
  }

  collapse(messageId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (this.state) this.collapseSubtree(this.state, messageId);
      return this.render();
    });
  }

  /** FR-3.3: one more level, bounded by depth and message count. */
  expandAll(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      await this.expandOneLevel();
      return this.render();
    });
  }

  /**
   * FR-3.3 / FR-3.7 expand everything — the whole diagram, or below `messageId` — level by level
   * (breadth-first, so a cap leaves a complete shallow picture), within MAX_EXPAND_DEPTH and
   * MAX_EXPAND_MESSAGES. When calls stay folded, the next render carries an `expandNotice` saying why.
   */
  expandEverything(messageId?: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      let capped = false;
      if (!messageId && this.state) this.state.smart = false;
      // FR-3.12 a view starts from closed: the same result whatever was open before
      if (this.state) this.resetBelow(this.state, messageId);
      // gives way between levels (in-process adapters: a large flow is seconds of work — the design-issue scan runs it per entry point)
      const slice = timeSlicer();
      for (let round = 0; round <= MAX_EXPAND_DEPTH; round++) {
        await slice();
        const r = await this.expandLevel(messageId);
        capped ||= r.capped;
        if (!r.changed || r.capped) break;
      }
      const build = await this.build();
      if (build) {
        const inScope = (id: string) => (messageId ? id === messageId || id.startsWith(`${messageId}/`) : inFlow(id));
        // calls left folded by a "don't expand" rule (FR-11.7) are what the user asked for, not a limit; the steps before
        // the root (FR-8.7 container, FR-18.14 pipeline) are opened by hand only — neither is "still folded" by a limit
        const folded = [...build.nodes.values()].filter((n) => n.expandable && !n.expanded && (n.effective || n.lambdaCalls) && !(n.noExpand && n.id !== messageId) && inScope(n.id)).length;
        if (folded) {
          const depth = Math.max(0, ...[...build.nodes.values()].filter((n) => n.expanded).map((n) => n.depth));
          this.pendingNotice = { reason: capped ? 'messages' : 'depth', messages: build.messages.length, depth, folded, limit: capped ? MAX_EXPAND_MESSAGES : MAX_EXPAND_DEPTH };
        }
      }
      return this.render();
    });
  }

  /**
   * FR-12.14 a class-diagram relation whose calls are not drawn (they are inside collapsed calls — an
   * association comes from a field, a layer violation from the class's code): expands, level by level,
   * the collapsed calls into the source class (and its own calls below them) until a call from the
   * source to the target appears — through `field` when given. Bounded by MAX_EXPAND_DEPTH rounds and
   * the message budget. Resolves to the rendered diagram and the ids of the matching calls (none found:
   * the diagram as it was, no ids — and for a field, where it is declared: the place to show instead).
   */
  revealRelation(from: string, to: string, field?: string): Promise<{ diagram: SequenceDiagram | undefined; messageIds: string[]; fieldDeclaration?: SourceRange }> {
    return this.serialized(async () => {
      const state = this.state;
      if (!state) return { diagram: undefined, messageIds: [] };
      const expandedBefore = new Set(state.expanded);
      let matches: string[] = [];
      for (let round = 0; round <= MAX_EXPAND_DEPTH; round++) {
        // a build is undefined only without a state
        const build = (await this.build())!;
        const byId = new Map(build.participants.map((p) => [p.id, p]));
        matches = build.messages
          .filter((m) => {
            if ((m.kind !== 'call' && m.kind !== 'create') || !m.from) return false;
            const src = byId.get(m.from);
            const dst = byId.get(m.to);
            if (src?.classKey !== from || !dst) return false;
            if (dst.classKey !== to && m.port?.key !== to && dst.implementsInterface?.key !== to) return false;
            const origin = build.participantMeta.get(dst.id)?.origin;
            return !field || m.kind === 'create' || origin?.kind !== 'field' || origin.name === field;
          })
          .map((m) => m.id);
        if (matches.length) break;
        // collapsed calls whose body is the source class's code: calls into it, and its own calls below them
        const candidates = [...build.nodes.values()].filter((n) => {
          const target = byId.get(n.participantId);
          return n.expandable && !n.expanded && n.effective && target?.classKey === from;
        });
        if (!candidates.length) break;
        await Promise.all(candidates.map((n) => this.cache.fetchOutgoing(n.effective!)));
        let total = build.messages.length;
        let added = false;
        for (const n of candidates) {
          const extra = this.cache.outgoing(n.effective!).length;
          if (total + extra > MAX_RENDER_MESSAGES) break;
          state.expanded.add(n.id);
          total += extra;
          added = true;
        }
        if (!added) break;
      }
      if (!matches.length) {
        // nothing calls through it (a field holding data, say): leave the diagram as it was, point at the field
        state.expanded = expandedBefore;
        const decl = field ? (await this.cache.fetchClassInfo(from))?.fields.find((f) => f.name === field)?.declaration : undefined;
        return { diagram: await this.render(), messageIds: [], ...(decl ? { fieldDeclaration: decl } : {}) };
      }
      return { diagram: await this.render(), messageIds: matches };
    });
  }

  /**
   * FR-3.6 Smart expand: expands the most valuable calls first — own importance plus what the
   * call's body reveals (see smart-expand.ts) — until nothing worth opening is left or the diagram, or with
   * `messageId` that message's subtree, would exceed the cap (FR-3.10: then the next render carries a notice;
   * `more` = continue, another cap's worth of messages). Calls on an error path (FR-3.9) stay folded. Afterwards
   * every message carries its importance (low ones are dimmed by the view) until Collapse all.
   */
  smartExpand(messageId?: string, more = false, view?: 'changes'): Promise<SequenceDiagram | undefined> {
    if (view === 'changes') return this.showChanges(messageId);
    return this.serialized(async () => {
      const state = this.state;
      if (!state) return this.render();
      // FR-3.12 Continue goes on; any other run starts from closed (the same result whatever was open)
      if (!more) this.resetBelow(state, messageId);
      // a build is undefined only without a state
      let build = (await this.build())!;
      const config = compileSmartConfig(this.classifier.smartExpandConfig?.());
      const prefix = messageId && messageId !== 'root' ? `${messageId}/` : undefined;
      if (prefix) {
        const start = build.nodes.get(messageId!);
        if (!start?.expandable && !start?.expanded) return this.render();
        state.expanded.add(messageId!);
        build = (await this.build())!;
      }
      state.smart = true;
      // F8b score with what a fresh open knows — the bodies the I/O scan reads from this start, and the calls drawn —
      // not with what an earlier expansion left in the cache: the same Overview whatever was opened before
      const horizon = (await this.ioReach(build))!;
      let drawnIn: BuildResult | undefined;
      let drawn = new Set<string>();
      const drawnNow = () => {
        if (drawnIn !== build) [drawnIn, drawn] = [build, new Set([...build.nodes.values()].flatMap((n) => [n.effective?.key, n.declared?.key].filter((k): k is string => !!k)))];
        return drawn;
      };
      // a body, or an interface method's implementations (`impls`)
      const known = (m: MethodRef, impls = false) => (impls ? horizon.impls : horizon.seen).has(m.key) || drawnNow().has(m.key);
      const inScope = (id: string) => !prefix || id.startsWith(prefix);
      const count = (b: BuildResult) => b.messages.filter((m) => inScope(m.id)).length;
      const cap = more ? count(build) + config.budget : config.budget;
      const rejected = new Set<string>();
      // FR-3.10 calls worth opening that the cap left folded
      let folded = 0;
      for (let step = 0; step < MAX_EXPAND_MESSAGES; step++) {
        // FR-1.11 a closure the open method invokes is that method's own logic: opened first, within the budget
        await this.prefetchExits(build);
        const off = this.offPathOf(build, known);
        const closure = [...build.nodes.values()].find((n) => n.lambdaCalls && n.expandable && !n.expanded && !n.noExpand && n.depth < MAX_EXPAND_DEPTH && inScope(n.id) && (prefix || inFlow(n.id)) && !rejected.has(n.id) && !off.has(n.id));
        if (closure) {
          state.expanded.add(closure.id);
          const after = (await this.build())!;
          if (count(after) > cap) {
            state.expanded.delete(closure.id);
            rejected.add(closure.id);
          } else build = after;
          continue;
        }
        const candidates = [...build.nodes.values()].filter(
          (n) => n.expandable && !n.expanded && !n.noExpand && n.effective && n.depth < MAX_EXPAND_DEPTH && inScope(n.id) && (prefix || inFlow(n.id)) && !rejected.has(n.id) && !off.has(n.id),
        );
        if (!candidates.length) break;
        await this.prefetchForScoring(candidates.map((n) => n.effective!));
        const importance = this.importanceOf(build, config, known);
        const ranked = candidates
          .map((n) => ({ n, priority: importance.get(n.id)?.expand?.score }))
          .filter((c): c is { n: typeof c.n; priority: number } => c.priority !== undefined)
          // breadth before depth at equal value; message order breaks ties (stable sort)
          .sort((a, b) => b.priority - 0.5 * b.n.depth - (a.priority - 0.5 * a.n.depth));
        const before = count(build);
        const next = ranked.find((c) => before + this.visibleChildren(c.n.effective!) <= cap);
        if (!next) {
          folded = ranked.length;
          break;
        }
        state.expanded.add(next.n.id);
        const after = (await this.build())!;
        if (count(after) > cap) {
          // the estimate missed (a delegate drawn as the method it runs): undo and try the next candidate — `build`
          // is still the diagram without it
          state.expanded.delete(next.n.id);
          rejected.add(next.n.id);
          folded = Math.max(folded, 1);
        } else build = after;
      }
      if (folded) {
        const depth = Math.max(0, ...[...build.nodes.values()].filter((n) => n.expanded).map((n) => n.depth));
        this.pendingNotice = { reason: 'smart', messages: count(build), depth, folded, limit: cap };
      }
      return this.render();
    });
  }

  /**
   * FR-3.12 a view starts from closed: the calls below `messageId` (without: the whole flow — the steps before the
   * root, FR-8.7, stay as they are) collapse and the error branches shown again there fold.
   */
  private resetBelow(state: ViewState, messageId?: string): void {
    const scope = messageId ?? 'root';
    for (const id of [...state.expanded]) if (id.startsWith(`${scope}/`)) state.expanded.delete(id);
    for (const key of [...(state.shownErrorPaths ?? [])]) if (key.startsWith(`${scope}/`) || key.startsWith(`${scope}#`)) state.shownErrorPaths!.delete(key);
  }

  /**
   * FR-3.12 a call opened on purpose (a found call, a change, a path) inside an error branch ↯ folds: that branch is
   * shown (as ⊕ on its marker would) — again for a branch inside a shown one.
   */
  private async showBranchesHolding(ids: Iterable<string>): Promise<void> {
    // called with a state
    const state = this.state!;
    const targets = [...ids];
    for (let round = 0; round <= MAX_EXPAND_DEPTH; round++) {
      // a build is undefined only without a state
      const { foldedCalls } = (await this.build())!;
      const keys = new Set([...foldedCalls].filter(([call]) => targets.some((id) => id === call || id.startsWith(`${call}/`))).map(([, key]) => key));
      if (!keys.size) return;
      for (const k of keys) (state.shownErrorPaths ??= new Set()).add(k);
    }
  }

  /**
   * FR-3.12 *Changes* (during a review, FR-24): only the paths to the branch's changed methods open — below the
   * root, or below `messageId` — each path walked as the review tour walks it (FR-24.10). A path that needs another
   * implementation of a call than an earlier one stays closed (that call counts its changes, FR-24.15).
   */
  private showChanges(messageId?: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      if (!state) return this.render();
      this.resetBelow(state, messageId);
      state.smart = false;
      const below = this.changesBelow();
      if (!messageId || messageId === 'root') {
        for (const steps of below.get(state.root.key)?.values() ?? []) await this.walkPath(state, steps);
        // a change in an error branch: that branch shown, also with ↯ on
        await this.showBranchesHolding(state.expanded);
        return this.render();
      }
      const node = (await this.nodes()).get(messageId);
      const method = node?.effective;
      const paths = node && method ? [...this.changesUnder(node, below).values()].filter((p) => p[0]?.methodKey === method.key) : [];
      if (!method || !paths.length) return this.render();
      state.expanded.add(messageId);
      for (const steps of paths) await this.walkPath(state, steps, { id: messageId, method });
      await this.showBranchesHolding(state.expanded);
      return this.render();
    });
  }

  /** FR-3.9 early exits of the opened bodies (to judge their branches) — usually cached by the build. */
  private async prefetchExits(build: BuildResult): Promise<void> {
    await Promise.all([...build.nodes.values()].filter((n) => n.expanded && n.effective).map((n) => this.cache.fetchEarlyExits(n.effective!)));
  }

  /**
   * FR-3.9 off-path branches of a body (cached data only; exits not fetched yet count as none). The body is cached:
   * it is an opened call's (built) or a candidate's (prefetched for scoring).
   */
  private offPathBranches(method: MethodRef, memo: Map<string, Map<string, string>>, known?: (m: MethodRef) => boolean): Map<string, string> {
    let off = memo.get(method.key);
    // F8b a callee that only builds a failure counts when Overview may know its body
    const { peek } = this.scoringPeeks(known);
    const callee = (c: CallSite) => peek(c.target!) ?? [];
    if (!off) memo.set(method.key, (off = offPathOperands(this.cache.peekOutgoing(method)!, this.cache.peekEarlyExits(method) ?? [], (c) => onlyBuildsFailure(callee(c)))));
    return off;
  }

  /** FR-3.9 the calls of a build that are on an error path of their body: message id → why. */
  private offPathOf(build: BuildResult, known?: (m: MethodRef) => boolean): Map<string, string> {
    const out = new Map<string, string>();
    const memo = new Map<string, Map<string, string>>();
    for (const n of build.nodes.values()) {
      if (!n.call?.fragments?.length) continue;
      // (an invoked closure's calls, FR-1.11, have no body method: its exits are not known)
      const owner = build.nodes.get(n.id.slice(0, n.id.lastIndexOf('/')))?.effective;
      if (!owner) continue;
      const why = offPathReason(n.call.fragments, this.offPathBranches(owner, memo, known));
      if (why) out.set(n.id, why);
    }
    return out;
  }

  /** Bodies, exits and class infos the scoring of the candidates' children reads (usually cached by the look-ahead). */
  private async prefetchForScoring(methods: MethodRef[]): Promise<void> {
    await Promise.all(methods.flatMap((m) => [this.cache.fetchOutgoing(m), this.cache.fetchEarlyExits(m)]));
    const owners = new Set<string>();
    for (const m of methods) {
      owners.add(m.owner.key);
      // fetched just above (a failed request rejects)
      for (const c of this.cache.peekOutgoing(m)!) {
        const ref = c.target?.owner ?? c.receiverType;
        if (ref && !c.isLibrary) owners.add(ref.key);
      }
    }
    await Promise.all([...owners].map((k) => this.cache.fetchClassInfo(k)));
  }

  /** Calls of a body that will be drawn (library calls only when shown); the body is prefetched for scoring. */
  private visibleChildren(method: MethodRef): number {
    return this.cache.peekOutgoing(method)!.filter((c) => this.options.showLibraryCalls || !c.isLibrary).length;
  }

  /**
   * Importance of each call site of a body, seen from the body's class (cached data only: the body of an expandable
   * call was read by the build, to know it has calls to draw).
   */
  private childImportance(method: MethodRef, config: CompiledSmartConfig, memo = new Map<string, Map<string, string>>(), known?: (m: MethodRef, impls?: boolean) => boolean): { name: string; importance: Importance }[] {
    // F8b only the bodies and implementations Overview may know (all cached ones when shown after the fact)
    const { peek, peekImpls } = this.scoringPeeks(known);
    const ownerEnd = this.callEnd(method.owner);
    // FR-3.9 what a body does on its error paths is not worth opening it for
    const off = this.offPathBranches(method, memo, known);
    return this.cache.peekOutgoing(method)!
      .filter((c) => (this.options.showLibraryCalls || !c.isLibrary) && !offPathReason(c.fragments, off))
      .map((c) => {
        const ref = c.kind === 'create' ? (c.receiverType ?? c.target?.owner) : (c.target?.owner ?? c.receiverType);
        const to = ref ? this.callEnd(ref) : undefined;
        const self = !!to && to.id === ownerEnd.id;
        const io = this.options.showSideEffects === false ? [] : this.callIo(c, peek, peekImpls);
        const importance = scoreCall(
          {
            methodName: c.methodName,
            kind: c.kind === 'create' ? 'create' : self ? 'self' : 'call',
            argCount: c.args.length,
            isLibrary: c.isLibrary,
            from: ownerEnd,
            to,
            childCount: c.target ? (peek(c.target)?.length ?? 0) : 0,
            expandable: !!c.target?.hasBody,
            ...(io.length ? { io } : {}),
          },
          config,
        );
        return { name: c.kind === 'create' ? `new ${ref?.name ?? c.methodName}` : c.methodName, importance };
      });
  }

  /** F8b the bodies and implementations scoring may read: those Overview knows (`known`), else every cached one. */
  private scoringPeeks(known?: (m: MethodRef, impls?: boolean) => boolean): { peek: (m: MethodRef) => CallSite[] | undefined; peekImpls: (m: MethodRef) => MethodRef[] | undefined } {
    return {
      peek: (x) => (!known || known(x) ? this.cache.peekOutgoing(x) : undefined),
      peekImpls: (x) => (!known || known(x, true) ? this.cache.peekImplementations(x) : undefined),
    };
  }

  /**
   * FR-17 I/O kinds of a call site: a library I/O call itself, or what it runs — its target's cached body and
   * the cached bodies below, through a port into its implementations (FR-17.6). Smart expand scores the calls a
   * collapsed call reveals with it: the I/O the background scan found deeper down opens the path to it (FR-17.3).
   */
  private callIo(c: CallSite, peek: (m: MethodRef) => CallSite[] | undefined, peekImpls: (m: MethodRef) => MethodRef[] | undefined): SideEffectKind[] {
    const own = ioKindOfCall(c);
    if (own) return [own];
    return toSideEffects(ioOfCall(c, peek, peekImpls))?.kinds ?? [];
  }

  private callEnd(ref: ClassRef): CallEnd {
    const c = this.cache.classify(ref, {});
    return { id: ref.key, className: ref.name, layer: c.layer, stereotypes: c.stereotypes, kind: ref.kind };
  }

  /**
   * FR-3.6 importance of every message of a build (cached data only, no adapter requests): its own
   * score and, for collapsed expandable calls, the value of expanding it (`expand`).
   */
  private importanceOf(build: BuildResult, config = compileSmartConfig(this.classifier.smartExpandConfig?.()), known?: (m: MethodRef, impls?: boolean) => boolean): Map<string, Importance & { expand?: Importance }> {
    const byId = new Map(build.participants.map((p) => [p.id, p]));
    const out = new Map<string, Importance & { expand?: Importance }>();
    const memo = new Map<string, Map<string, string>>();
    const offPath = this.offPathOf(build, known);
    for (const m of build.messages) {
      if (m.kind === 'found') continue;
      const effective = build.nodes.get(m.id)?.effective;
      const children = effective && m.expandable ? this.childImportance(effective, config, memo, known) : [];
      // a call has a sender (only the found message has none)
      const facts = messageFacts(m, byId.get(m.from!), byId.get(m.to), children.length);
      // F8b its I/O badge reads every cached body: Overview scores with the known ones only
      const call = known && build.nodes.get(m.id)?.call;
      if (call && this.options.showSideEffects !== false) {
        const { peek, peekImpls } = this.scoringPeeks(known);
        const io = this.callIo(call, peek, peekImpls);
        if (io.length) facts.io = io;
        else delete facts.io;
      }
      const own = scoreCall(facts, config);
      const off = offPath.get(m.id);
      if (off) {
        // FR-3.9 on an error path: dimmed, never opened by Smart
        out.set(m.id, { score: own.score - 4, reasons: [...own.reasons, `↓ error path: ${off}`], low: true });
        continue;
      }
      const reveal = revealValue(children);
      const expand = m.expandable && !m.expanded ? expansionPriority(own, reveal) : undefined;
      const reasons = reveal.value > 0 && !own.reasons.some((r) => r.startsWith('↑ reveals')) ? [...own.reasons, `↑ reveals ${reveal.top.join(', ')}`] : own.reasons;
      out.set(m.id, { score: own.score, reasons, low: own.low && reveal.value <= 0, expand });
    }
    return out;
  }

  /** FR-3.3: back to depth 1 (also ends a smart expand and forgets the error paths shown again, FR-3.11). */
  collapseAll(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.state?.expanded.clear();
      if (this.state) this.state.smart = false;
      delete this.state?.shownErrorPaths;
      return this.render();
    });
  }

  /** FR-1.12: minimize a combined fragment to a one-row stub (its calls leave both diagrams). */
  collapseFragment(fragmentId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      // the fragments of the diagram on screen
      const build = this.lastBuild;
      if (state && build?.fragments.some((f) => f.id === fragmentId)) {
        (state.collapsedFragments ??= new Set()).add(fragmentId);
      }
      return this.render();
    });
  }

  /** FR-1.12: restore a minimized fragment. */
  expandFragment(fragmentId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.state?.collapsedFragments?.delete(fragmentId);
      return this.render();
    });
  }

  /** FR-1.22: follow one case of an alt on screen — its other cases leave both diagrams. */
  followCase(fragmentId: string, operand: number): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const f = this.lastBuild?.fragments.find((x) => x.id === fragmentId);
      if (this.state && f?.kind === 'alt' && f.operands.some((op) => op.case === operand)) (this.state.followedCases ??= new Map()).set(fragmentId, operand);
      return this.render();
    });
  }

  /** FR-1.22: all cases of a followed alt again. */
  showAllCases(fragmentId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.state?.followedCases?.delete(fragmentId);
      return this.render();
    });
  }

  /** FR-3.11: show an error branch Smart expand folded (its calls, folded themselves). */
  showErrorPath(key: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (this.state) (this.state.shownErrorPaths ??= new Set()).add(key);
      return this.render();
    });
  }

  /**
   * One level of the collapsed calls (within `scope`: a message and its subtree), up to the message
   * budget. `changed`: something was expanded; `capped`: the budget stopped it.
   */
  private async expandLevel(scope?: string, depthLimit = MAX_EXPAND_DEPTH): Promise<{ changed: boolean; capped: boolean }> {
    const state = this.state;
    const build = await this.build();
    if (!state || !build) return { changed: false, capped: false };
    const inScope = (id: string) => !scope || id === scope || id.startsWith(`${scope}/`);
    // FR-3.7 the depth limit counts from the clicked message, not from the diagram's root
    const maxDepth = (scope ? build.nodes.get(scope)?.depth ?? 0 : 0) + depthLimit;
    // calls into methods, and invoked closures (FR-1.11: `$request()` runs the closure the caller passed); a call
    // under a "don't expand" rule stays folded (FR-11.7) unless it is the one the user expands everything below
    const candidates = [...build.nodes.values()].filter(
      (node) => node.expandable && !node.expanded && (!node.noExpand || node.id === scope) && node.depth < maxDepth && (node.effective || node.lambdaCalls) && (scope ? inScope(node.id) : inFlow(node.id)),
    );
    // the budget check needs the size of each candidate's body: fetch them in parallel
    await Promise.all(candidates.map((node) => (node.effective ? this.cache.fetchOutgoing(node.effective) : undefined)));
    // below one message (FR-3.7) the budget is that subtree's: a huge diagram around it (a method with
    // hundreds of calls) must not leave nothing to expand; the whole diagram stays under the render limit
    let total = scope ? build.messages.filter((m) => inScope(m.id)).length : build.messages.length;
    let overall = build.messages.length;
    let changed = false;
    for (const node of candidates) {
      const extra = node.lambdaCalls?.length ?? this.cache.outgoing(node.effective!).length;
      if (total + extra > MAX_EXPAND_MESSAGES || overall + extra > MAX_RENDER_MESSAGES) return { changed, capped: true };
      state.expanded.add(node.id);
      total += extra;
      overall += extra;
      changed = true;
    }
    return { changed, capped: false };
  }

  /** One more level: asked for by hand, so the depth limit does not hold it back (the render limit still does). */
  private async expandOneLevel(): Promise<boolean> {
    return (await this.expandLevel(undefined, Number.POSITIVE_INFINITY)).changed;
  }

  private collapseSubtree(state: ViewState, messageId: string): void {
    const prefix = `${messageId}/`;
    for (const id of [...state.expanded]) {
      if (id === messageId || id.startsWith(prefix)) state.expanded.delete(id);
    }
  }

  // ───────────── polymorphism (FR-8) ─────────────

  selectImplementation(messageId: string, classKey: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      const node = (await this.nodes()).get(messageId);
      if (!state || !node?.declared || !node.implementations?.some((i) => i.owner.key === classKey)) {
        return this.render();
      }
      const levels = this.openLevels(state, messageId);
      this.collapseSubtree(state, messageId);
      state.choices.set(messageId, classKey);
      this.interfaceChoices.set(node.declared.owner.key, classKey);
      await this.reopenLevels(messageId, levels);
      return this.render();
    });
  }

  /** how many levels are open below a call (itself open: 1; a call open inside it: 2 …). */
  private openLevels(state: ViewState, messageId: string): number {
    const prefix = `${messageId}/`;
    let levels = 0;
    for (const id of state.expanded) {
      if (id === messageId) levels = Math.max(levels, 1);
      else if (id.startsWith(prefix)) levels = Math.max(levels, id.slice(prefix.length).split('/').length + 1);
    }
    return levels;
  }

  /**
   * another implementation of a call opens as deep as the one before was open, so two can be compared
   * without opening each again (its calls differ, so the old ids cannot be kept).
   */
  private async reopenLevels(messageId: string, levels: number): Promise<void> {
    for (let i = 0; i < levels; i++) {
      const r = await this.expandLevel(messageId);
      if (!r.changed || r.capped) return;
    }
  }

  revertImplementation(messageId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      const node = (await this.nodes()).get(messageId);
      // only an interface call has a choice to revert (else a "none chosen" would be kept for a plain call)
      if (!state || !node?.declared || !node.implementations) return this.render();
      const levels = this.openLevels(state, messageId);
      this.collapseSubtree(state, messageId);
      state.choices.set(messageId, null);
      this.interfaceChoices.delete(node.declared.owner.key);
      await this.reopenLevels(messageId, levels);
      return this.render();
    });
  }

  // ───────────── callers / reroot (FR-4) ─────────────

  getCallers(messageId: string): Promise<CallerInfo[]> {
    return this.serialized(() => this.doGetCallers(messageId));
  }

  private async doGetCallers(messageId: string): Promise<CallerInfo[]> {
    const node = (await this.nodes()).get(messageId);
    const method = node?.effective ?? node?.declared;
    if (!method || method.owner.kind === 'external') return [];
    const callers = await this.adapter.getCallers(method);
    this.callersCache.set(messageId, callers);
    return callers;
  }

  /** FR-4.2: re-root at the caller's enclosing method, expanding the path to the previous root. */
  /**
   * FR-4.6 Focus: the message's target (the chosen implementation if any) becomes the root — the
   * opposite of re-rooting at a caller. What was expanded, chosen or minimized below the message
   * is kept; a new history entry (Back returns to the wider diagram).
   */
  focus(messageId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const prev = this.state;
      const node = (await this.nodes()).get(messageId);
      const target = node?.effective ?? node?.declared;
      if (!prev || !node || messageId === 'root' || !target?.hasBody) return this.render();
      const root = (await this.adapter.getMethod(target.key)) ?? target;
      const next: ViewState = { root, expanded: new Set(), choices: new Map(), ...(prev.smart ? { smart: true } : {}) };
      const moved = (id: string) => `root${id.slice(messageId.length)}`;
      const below = (id: string) => id.startsWith(`${messageId}/`) || id.startsWith(`${messageId}#`);
      for (const id of prev.expanded) if (below(id)) next.expanded.add(moved(id));
      for (const [id, choice] of prev.choices) if (below(id)) next.choices.set(moved(id), choice);
      for (const id of prev.collapsedFragments ?? []) if (below(id)) (next.collapsedFragments ??= new Set()).add(moved(id));
      for (const [id, c] of prev.followedCases ?? []) if (below(id)) (next.followedCases ??= new Map()).set(moved(id), c);
      for (const id of prev.shownErrorPaths ?? []) if (below(id)) (next.shownErrorPaths ??= new Set()).add(moved(id));
      this.push(next);
      const d = await this.render();
      // zoomed to layers, a method whose calls all stay in its own layer would be one call into a folded layer
      // (an empty picture): its object comes out of the layer, so its calls are drawn
      const own = d?.messages.length === 1 && d.messages[0].folded ? this.lastBuild!.participants.find((p) => p.classKey === root.owner.key) : undefined;
      if (!own) return d;
      this.options = { ...this.options, openObjects: [...(this.options.openObjects ?? []), own.id] };
      return this.render();
    });
  }

  reroot(messageId: string, callerId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const prev = this.state;
      const node = (await this.nodes()).get(messageId);
      const callers = this.callersCache.get(messageId) ?? (await this.doGetCallers(messageId));
      const caller = callers.find((c) => c.id === callerId);
      if (!prev || !caller) return this.render();
      const previousTarget = node?.effective ?? node?.declared;

      const root = (await this.adapter.getMethod(caller.enclosing.key)) ?? caller.enclosing;
      const next: ViewState = { root, expanded: new Set(), choices: new Map() };
      this.push(next);
      const anchor = await this.expandCallTo(next, 'root', root, caller, previousTarget);
      if (anchor) {
        // keep the developer's context: transplant the previous exploration below the call
        const prefix = `${messageId}/`;
        for (const id of prev.expanded) if (id.startsWith(prefix)) next.expanded.add(anchor + id.slice(messageId.length));
        for (const [id, choice] of prev.choices) {
          if (id.startsWith(prefix)) next.choices.set(anchor + id.slice(messageId.length), choice);
        }
        const transplanted = (id: string) => id.startsWith(prefix) || id.startsWith(`${messageId}#`);
        for (const id of prev.collapsedFragments ?? []) {
          if (transplanted(id)) (next.collapsedFragments ??= new Set()).add(anchor + id.slice(messageId.length));
        }
        for (const [id, c] of prev.followedCases ?? []) if (transplanted(id)) (next.followedCases ??= new Map()).set(anchor + id.slice(messageId.length), c);
        for (const id of prev.shownErrorPaths ?? []) if (transplanted(id)) (next.shownErrorPaths ??= new Set()).add(anchor + id.slice(messageId.length));
      }
      return this.render();
    });
  }

  /**
   * FR-4.2 / FR-22 one step down a call path: in the view `state`, expands the call at `at` in
   * `method` (shown as message `parentId`) so that `callee` appears below it — choosing `callee`'s
   * class when the call goes through an interface, and for a method passed as an argument (FR-4.5)
   * also the invocation through the parameter. Returns the id of the message that runs `callee`
   * (whose children are `callee`'s calls), or undefined when the call is not found. `state` must be
   * the current view (its build is used for passed methods).
   */
  private async expandCallTo(state: ViewState, parentId: string, method: MethodRef, at: { range: SourceRange; passed?: boolean }, callee: MethodRef | undefined, opts: { keepChoices?: boolean } = {}): Promise<string | undefined | null> {
    const call = callAt(await this.cache.fetchOutgoing(method), at.range);
    if (!call) return undefined;
    const callId = `${parentId}/${call.ordinal}:${call.methodName}`;
    if (call.target && !call.target.hasBody && callee) {
      const impls = await this.cache.fetchImplementations(call.target);
      if (impls.some((i) => i.key === callee.key)) {
        // FR-24.15 another implementation is chosen here already: this path belongs to another view
        const chosen = state.choices.get(callId);
        if (opts.keepChoices && chosen && chosen !== callee.owner.key) return null;
        state.choices.set(callId, callee.owner.key);
      }
    }
    state.expanded.add(callId);
    // FR-4.5: passed as an argument — the receiving call invokes it through a parameter
    // (FR-1.13): expand that invocation too
    if (at.passed && callee) {
      // `state` is the current view: it has a build
      const nodes = (await this.build())!.nodes;
      const depth = callId.split('/').length + 1;
      const invoked = [...nodes.values()].find((n) => n.id.startsWith(`${callId}/`) && n.id.split('/').length === depth && n.effective?.key === callee.key);
      if (invoked) {
        state.expanded.add(invoked.id);
        return invoked.id;
      }
    }
    return callId;
  }

  // ───────────── find (FR-23) ─────────────

  /**
   * FR-23.2 calls matching `query` below the collapsed messages of the current diagram (nearest first,
   * bounded; `deeper` = the larger limits). Not serialized: it only reads the analysis cache, and a new
   * query cancels the previous one through `cancelled`. Undefined when cancelled.
   */
  async searchCollapsed(query: string, opts: { deeper?: boolean; cancelled?(): boolean; onProgress?(methods: number): void } = {}): Promise<{ hits: SearchHit[]; methods: number; truncated: boolean } | undefined> {
    // the diagram on screen (none yet: nothing to search)
    const build = this.lastBuild;
    const shown = new Set([...(this.lastDiagram?.messages.map((m) => m.id) ?? []), ...[...this.lastFolded.values()].flat()]);
    const anchors: SearchAnchor[] = [];
    for (const n of build?.nodes.values() ?? []) {
      if (n.expanded || !shown.has(n.id)) continue;
      // a collapsed call (the root is expanded, or has no body and no implementations to run)
      if (n.effective?.hasBody) anchors.push({ id: n.id, methods: [n.effective], call: n.call });
      else if (n.declared && !n.declared.hasBody && n.implementations?.length) anchors.push({ id: n.id, methods: n.implementations, call: n.call });
    }
    // diagram order: hits below earlier messages first (anchors are shown messages)
    const order = new Map([...shown].map((id, i) => [id, i]));
    anchors.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return searchBelow(
      anchors,
      query,
      {
        outgoing: (m) => this.cache.fetchOutgoing(m),
        implementations: (m) => this.cache.fetchImplementations(m),
        parameterNames: (m) => this.cache.fetchParameterNames(m),
        libraryCalls: this.options.showLibraryCalls === true,
        cancelled: opts.cancelled,
        onProgress: opts.onProgress,
      },
      opts.deeper ? SEARCH_DEEPER_LIMITS : SEARCH_LIMITS,
    );
  }

  /**
   * FR-23.3 expands the path from a hit's collapsed message down to the found call (choosing the
   * implementations on it) and returns the diagram with the call's message id. Expanding is not a
   * history step (as ⊕). Undefined when the message is gone (the diagram changed since the search).
   */
  revealSearchHit(hit: SearchHit): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      const anchor = (await this.nodes()).get(hit.anchorId);
      const first = hit.steps.length ? await this.adapter.getMethod(hit.steps[0].methodKey) : undefined;
      if (!state || !anchor || !first) return undefined;
      if (anchor.declared && !anchor.declared.hasBody && anchor.effective?.key !== first.key) {
        state.choices.set(hit.anchorId, first.owner.key);
        this.interfaceChoices.delete(anchor.declared.owner.key);
      }
      state.expanded.add(hit.anchorId);
      let id = hit.anchorId;
      let method = first;
      let reached = true;
      for (let i = 0; i + 1 < hit.steps.length; i++) {
        const callee = await this.adapter.getMethod(hit.steps[i + 1].methodKey);
        const at = hit.steps[i].call;
        const next = callee && at ? await this.expandCallTo(state, id, method, at, callee) : undefined;
        if (!next || !callee) {
          reached = false;
          break;
        }
        id = next;
        method = callee;
      }
      const at = hit.steps[hit.steps.length - 1].call?.range;
      const call = reached && at ? callAt(await this.cache.fetchOutgoing(method), at) : undefined;
      const target = call ? `${id}/${call.ordinal}:${call.methodName}` : id;
      await this.showBranchesHolding([target]);
      const diagram = await this.render();
      return { diagram, messageId: diagram?.messages.some((m) => m.id === target) ? target : id };
    });
  }

  // ───────────── paths to here (FR-22) ─────────────

  /**
   * FR-22 the call paths leading to the method of `messageId`, up to the entry points (a reverse
   * tree). Not serialized: the walk can take seconds and user operations interleave; references are
   * cached per method until refresh. Undefined when cancelled or the message has no project method.
   */
  async findPathsToHere(messageId: string, opts: { cancelled?(): boolean; onProgress?(methods: number): void } = {}): Promise<PathsResult | undefined> {
    const node = (await this.nodes()).get(messageId);
    const method = node?.effective ?? node?.declared;
    if (!method || method.owner.kind === 'external') return undefined;
    let entryPoints: EntryPoint[] = [];
    try {
      entryPoints = await this.getEntryPoints();
    } catch {
      // without entry points the paths end where nothing calls them
    }
    return findPathsToHere(method, { entryPoints, callers: (m) => this.cachedCallers(m), ...opts });
  }

  /** References of a method for walks up the callers (FR-22, FR-24), cached until refresh. */
  private cachedCallers(m: MethodRef): Promise<CallerInfo[]> {
    let list = this.pathCallers.get(m.key);
    if (!list) {
      list = this.adapter.getCallers(m);
      this.pathCallers.set(m.key, list);
      list.catch(() => this.pathCallers.delete(m.key));
    }
    return list;
  }

  // ───────────── the editor's hover (FR-33) ─────────────

  /** FR-33 parts of hovers worked out (or still running), by part and method, until the code changes. */
  private readonly codeInfoParts = new Map<string, Promise<unknown>>();

  private codeInfoPart<T>(key: string, work: () => Promise<T>): Promise<T> {
    let p = this.codeInfoParts.get(key) as Promise<T> | undefined;
    if (!p) {
      p = work();
      this.codeInfoParts.set(key, p);
      p.catch(() => this.codeInfoParts.delete(key));
    }
    return p;
  }

  /**
   * FR-33 what the editor's hover says at `position` of `file`: the call there (`word`, the name under the cursor: only
   * a call of that name, so a hover on an argument is none) — what runs and its I/O — or, on a method's name, the entry
   * points its callers lead to, whether the unreachable-code scan lists it, and its I/O. A part that takes longer than
   * `budgetMs` goes on in the background (kept until the code changes) and is named in `pending`. Never changes the
   * diagram; undefined when there is nothing to say.
   */
  async describeAt(file: string, position: Position, opts: { word?: string; budgetMs?: number } = {}): Promise<CodeInfo | undefined> {
    const method = await this.adapter.findEnclosingCallable(file, position);
    if (!method) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), opts.budgetMs ?? 400)));
    const inTime = <T>(p: Promise<T>): Promise<{ value: T } | undefined> => Promise.race([p.then((value) => ({ value }), () => ({ value: undefined as T })), budget]);
    try {
      const calls = await this.cache.fetchOutgoing(method).catch(() => [] as CallSite[]);
      const call = callUnderCursor(calls, position, opts.word);
      if (call) return { method, call: await this.describeCall(method, calls, call, inTime) };
      const d = method.declaration;
      const onName = !!d && d.start.line === position.line && (opts.word === undefined ? position.character >= d.start.character && position.character <= d.end.character : opts.word === method.name);
      if (!onName) return undefined;
      const reach = inTime(
        this.codeInfoPart(`reach|${method.key}`, async () => {
          const entryPoints = await this.getEntryPoints().catch(() => [] as EntryPoint[]);
          const r = await findPathsToHere(method, { entryPoints, callers: (m) => this.cachedCallers(m) });
          return r && reachOf(r.tree, r.truncated);
        }),
      );
      const io = inTime(this.codeInfoPart(`io|${method.key}`, () => this.ioOfMethod(method)));
      const [r, i] = await Promise.all([reach, io]);
      const listed = this.unreachable && this.unreachableAt === this.codeGeneration ? this.unreachable.methods.find((u) => u.method.key === method.key) : undefined;
      const pending = [...(r ? [] : (['reach'] as const)), ...(i ? [] : (['io'] as const))];
      return {
        method,
        ...(r?.value ? { reach: r.value } : {}),
        ...(listed ? { unreachable: unreachableGroup(listed) } : {}),
        ...(i?.value ? { io: i.value } : {}),
        ...(pending.length ? { pending } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** FR-33 a call under the cursor: what runs there (as the diagram would choose it) and the I/O it does. */
  private async describeCall(enclosing: MethodRef, calls: CallSite[], call: CallSite, inTime: <T>(p: Promise<T>) => Promise<{ value: T } | undefined>): Promise<CodeCallInfo> {
    const target = call.target;
    const lib = ioKindOfCall(call);
    if (lib) return { ...(target ? { target } : {}), io: toSideEffects([{ kind: lib, call: ioCallName(call) }]) };
    if (!target || call.isLibrary) return target ? { target } : {};
    const impls = target.hasBody || call.kind !== 'call' ? [] : await this.cache.fetchImplementations(target).catch(() => [] as MethodRef[]);
    await this.ensureBindings();
    const bindings = this.bindingList?.length ? bindingLookup(this.bindingList, await this.rootHosts(enclosing)) : undefined;
    const runs = whatRuns(call, enclosing, calls, impls, { bindings, autoSelect: this.autoSelect });
    const ran = runs.runs?.method ?? (target.hasBody ? target : undefined);
    const work = ran
      ? this.codeInfoPart(`io|${ran.key}`, () => this.ioOfMethod(ran))
      : this.codeInfoPart(`impls-io|${target.key}`, async () => {
          const bodies = impls.filter((m) => m.hasBody);
          if (!bodies.length || bodies.length > MAX_IO_IMPLEMENTATIONS) return undefined;
          await this.fetchBodiesBelow(new Map(bodies.map((m) => [m.key, m])), new Set());
          return toSideEffects([], ioOfImplementations(bodies, (x) => this.cache.peekOutgoing(x), (x) => this.cache.peekImplementations(x)));
        });
    const io = (await inTime(work))?.value;
    return { target, ...runs, ...(io ? { io } : {}) };
  }

  /** FR-33 the I/O a method's body does, itself or below (its bodies fetched first, as the diagram's background scan does). */
  private async ioOfMethod(m: MethodRef): Promise<SideEffects | undefined> {
    await this.fetchBodiesBelow(new Map([[m.key, m]]), new Set());
    const peek = (x: MethodRef) => this.cache.peekOutgoing(x);
    const peekImpls = (x: MethodRef) => this.cache.peekImplementations(x);
    return toSideEffects(directIo(peek(m) ?? []), ioBelow(m, peek, peekImpls));
  }

  // ───────────── review of a branch (FR-24) ─────────────

  /** FR-24.4 the reviewed branch's changes, marked on every rendered diagram until `endReview`. */
  private reviewMarks: ReviewMarks | undefined;
  private readonly createBaseAdapter: (() => LanguageAdapter) | undefined;
  /** FR-24.6 the project at the merge base (adapter + its own cache) while a review is on. */
  private base: { adapter: LanguageAdapter; cache: AnalysisCache } | undefined;
  /** FR-24.11 per review: class key → what the branch did to it (null = unchanged), and the computation itself. */
  private classChangeMemo = new Map<string, Promise<ClassChange | undefined>>();
  /** FR-24.15 per review: the changes of each flow (root, entry, filters, options) as one fixed list. */
  private flowChangesMemo = new Map<string, Promise<FlowChanges | undefined>>();
  /** FR-24.15 per review: the base version's text of a file (project-relative, its base path), for removed calls' cards. */
  private baseTextMemo = new Map<string, string>();
  /** FR-24.15 the last render's placement of its flow's changes (▶ reveals what a call holds). */
  private lastPlaced: PlacedChanges | undefined;

  /**
   * FR-24.11 what the reviewed branch did to a class: `new` (its file is new, or the base version has no such
   * class), else `changed` with its members — methods added / removed (by signature, against the base version),
   * changed (the review's changed methods), fields added / removed / retyped, base types changed.
   */
  private classChange(key: string): Promise<ClassChange | undefined> {
    let memo = this.classChangeMemo.get(key);
    if (!memo) {
      memo = this.computeClassChange(key).catch(() => undefined);
      this.classChangeMemo.set(key, memo);
    }
    return memo;
  }

  private async computeClassChange(key: string): Promise<ClassChange | undefined> {
    const g = this.reviewGit;
    const file = fileOfClassKey(key);
    const fc = g && file !== undefined ? g.files.find((f) => f.file === file) : undefined;
    if (!g || !fc || fc.status === 'deleted') return undefined;
    if (fc.status === 'added') return { kind: 'new', members: [] };
    const now = await this.cache.fetchClassInfo(key);
    if (!now) return undefined;
    // a class of a renamed file: at its old path in the base version
    const baseKey = fc.from === undefined ? key : `${fc.from}${key.slice(file!.length)}`;
    const base = this.base ? await this.base.cache.fetchClassInfo(baseKey) : undefined;
    if (this.base && !base) return { kind: 'new', members: [] };
    // (asked during a review only: its result is there)
    const reviewed = this.lastReview!.result.methods.filter((m) => m.method.key.startsWith(`${key}.`));
    const at = (name: string) => reviewed.find((m) => m.method.name === name)?.lines[0];
    const withHunk = (c: MemberChange): MemberChange => {
      const around = c.line ? hunkAround(g.hunks.get(file!), c.line, 'new') : undefined;
      return around ? { ...c, hunk: around.lines } : c;
    };
    const members: MemberChange[] = [];
    if (base) {
      const baseSigs = new Set(base.methods.map((m) => m.signature));
      const nowSigs = new Set(now.methods.map((m) => m.signature));
      for (const m of now.methods) if (!baseSigs.has(m.signature)) members.push(withHunk({ kind: 'method', name: m.name, change: 'added', text: m.signature, ...(at(m.name) ? { line: at(m.name) } : {}) }));
      for (const m of base.methods) if (!nowSigs.has(m.signature)) members.push({ kind: 'method', name: m.name, change: 'removed', text: m.signature });
      const fieldText = (f: { name: string; type?: ClassRef; collection?: boolean }) => `${f.name}${f.type ? `: ${f.type.name}${f.collection ? '[]' : ''}` : ''}`;
      for (const f of now.fields) {
        const was = base.fields.find((b) => b.name === f.name);
        const line = f.declaration ? f.declaration.start.line + 1 : undefined;
        if (!was) members.push(withHunk({ kind: 'field', name: f.name, change: 'added', text: fieldText(f), ...(line ? { line } : {}) }));
        else if (was.type?.key !== f.type?.key || !!was.collection !== !!f.collection) members.push(withHunk({ kind: 'field', name: f.name, change: 'changed', text: `${fieldText(f)} (was ${fieldText(was)})`, ...(line ? { line } : {}) }));
      }
      for (const f of base.fields) if (!now.fields.some((x) => x.name === f.name)) members.push({ kind: 'field', name: f.name, change: 'removed', text: fieldText(f) });
      // base types: extends / implements
      const types = (c: ClassInfo) => [...(c.extends ? [c.extends] : []), ...c.implements];
      const gained = types(now).filter((t) => !types(base).some((b) => b.key === t.key));
      const lost = types(base).filter((t) => !types(now).some((b) => b.key === t.key));
      if (gained.length || lost.length) {
        const line = now.ref.declaration ? now.ref.declaration.start.line + 1 : undefined;
        const text = gained.length ? `now ${gained.map((t) => t.name).join(', ')}${lost.length ? ` (was ${lost.map((t) => t.name).join(', ')})` : ''}` : `no longer ${lost.map((t) => t.name).join(', ')}`;
        members.push(withHunk({ kind: 'declaration', name: now.ref.name, change: 'changed', text, ...(line ? { line } : {}) }));
      }
    }
    // bodies changed (and, without a base version, the review's added methods)
    for (const m of reviewed) {
      if (members.some((x) => x.kind === 'method' && x.name === m.method.name)) continue;
      if (m.status === 'added' && base) continue;
      const sig = now.methods.find((x) => x.name === m.method.name)?.signature ?? m.method.name;
      members.push(withHunk({ kind: 'method', name: m.method.name, change: m.status, text: sig, ...(m.lines[0] ? { line: m.lines[0] } : {}) }));
    }
    return members.length ? { kind: 'changed', members } : undefined;
  }

  /** FR-24.8 the last review, shown again while nothing changed (its base version stays loaded too). */
  private lastReview: { result: ReviewResult; marks: ReviewMarks; changes: BranchChanges } | undefined;
  /** FR-24.7 the reviewed branch's diff (merge base, hunks) for the hover hunks and the side-by-side diff. */
  private reviewGit: (BranchChanges & { root: string }) | undefined;

  private async setBase(base: { adapter: LanguageAdapter; cache: AnalysisCache } | undefined): Promise<void> {
    const old = this.base;
    this.base = base;
    await old?.adapter.dispose().catch(() => undefined);
  }

  /** Disposes what the session started itself (the base version's adapter of a review); the host disposes its adapter. */
  async dispose(): Promise<void> {
    await this.setBase(undefined);
  }

  // ───────────── memory (FR-34) ─────────────

  /** FR-34.1 the memory of the processes the analysis runs in (the C# sidecar; during a review also the base version's), while they run. */
  async processMemory(): Promise<{ analysis?: ProcessMemory; base?: ProcessMemory }> {
    const [analysis, base] = await Promise.all([this.adapter.getMemory?.(), this.base?.adapter.getMemory?.()]);
    return { ...(analysis ? { analysis } : {}), ...(base ? { base } : {}) };
  }

  /**
   * FR-34.2 gives memory back: drops the caches and kept scans (as a refresh without changed files) and stops the
   * analysis processes; the next request starts them again. The diagram on screen stays as it is.
   */
  freeMemory(): Promise<void> {
    return this.serialized(async () => {
      await this.invalidate();
      await Promise.all([this.adapter.release?.(), this.base?.adapter.release?.()]);
    });
  }

  /**
   * FR-24 reviews the current branch against `base` (default `develop`): changed methods, the entry points
   * they affect, issues on changed lines; then marks the changes on
   * the diagrams. Not serialized (seconds; cancellable); flows are scanned in a separate session, so the
   * user's diagram and history stay. Undefined when cancelled.
   */
  /** FR-24.13 the branches, tags and commits a review can compare with. */
  gitRefs(): Promise<GitRefs> {
    return gitRefs(this.classifier.projectRoot?.() ?? this.adapter.projectRoot);
  }

  async reviewChanges(opts: { base?: string; force?: boolean; mode?: 'split' | 'direct'; cancelled?(): boolean; onProgress?(phase: string, done: number, total: number): void } = {}): Promise<ReviewResult | undefined> {
    const root = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
    // FR-24.8 nothing changed since the last review (same base, HEAD, diff, untracked files): show it again
    opts.onProgress?.('Reading the changes (git)', 0, 1);
    const changes = await branchChanges(root, opts.base || 'develop', opts.mode ?? 'split');
    const last = this.lastReview;
    this.classChangeMemo.clear();
    this.flowChangesMemo.clear();
    this.baseTextMemo.clear();
    if (!opts.force && last && last.changes.fingerprint === changes.fingerprint) {
      this.reviewMarks = last.marks;
      this.reviewGit = { ...last.changes, root };
      return { ...last.result, reused: true };
    }
    const tests = new TestFileMatcher(root);
    let entryPoints: EntryPoint[] = [];
    try {
      entryPoints = await this.getEntryPoints();
    } catch {
      // without entry points the review lists the changed methods only
    }
    const scan = new DiagramSession({
      adapter: this.adapter,
      classifier: this.classifier,
      internal: true,
      // issues never count type uses: the same rule as a flow, the scan and the map
      initialState: { options: { ...this.options, showLibraryCalls: false, showFindings: true, showSideEffects: true, scanSideEffects: true, showTypeUses: false, layerZoom: false, foldedLayers: [], foldErrors: false } },
    });
    const r = await reviewBranch(
      {
        root,
        adapter: this.adapter,
        entryPoints: async () => entryPoints,
        paths: (m) => findPathsToHere(m, { entryPoints, callers: (x) => this.cachedCallers(x), maxDepth: 10, maxMethods: 200, maxLeaves: 200 }),
        scan: async (start) => {
          // a start is an entry point or a changed method
          if (start.entryPoint) await scan.openMethodByKey(start.entryPoint.method.key, start.entryPoint);
          else await scan.openMethodByKey(start.methodKey!);
          await scan.expandEverything();
          await scan.scanSideEffects();
          return { diagram: scan.current(), classDiagram: await scan.getClassDiagram() };
        },
        isTest: (file) => tests.isTest(file),
        cancelled: opts.cancelled,
        onProgress: opts.onProgress,
      },
      opts.base,
      changes,
    );
    if (!r) return undefined;
    r.result.computedAt = new Date().toISOString();
    this.lastReview = { result: r.result, marks: r.marks, changes: r.changes };
    this.reviewMarks = r.marks;
    this.reviewGit = { ...r.changes, root };
    // FR-24.6 the base version, to compare the flows with (loaded now: the review is the slow step anyway)
    if (this.createBaseAdapter && !opts.cancelled?.()) {
      opts.onProgress?.('Loading the base version', 0, 1);
      try {
        const adapter = await createBaseAdapter(this.createBaseAdapter, root, r.changes);
        await this.setBase({ adapter, cache: new AnalysisCache(adapter, this.classifier) });
        // warm it up on the open flow (a C# base loads its solution now, not on the next click)
        if (this.state && this.lastBuild) await this.flowDiff(this.state, this.lastBuild).catch(() => undefined);
      } catch {
        await this.setBase(undefined); // the diff marks still work without it
      }
      // FR-29 Level 0: what the branch did to the shape — both versions as the codebase map sees them
      // (cancelled: the structure's walk stops at once)
      if (this.base) {
        const structure = await this.compareStructure(r.changes, opts).catch(() => undefined);
        if (structure) r.result.structure = structure;
      }
    }
    return r.result;
  }

  /** FR-29 affected entry points analysed on the base version per review (the others are the same in both). */
  private static readonly MAX_STRUCTURE_SCANS = 40;

  /**
   * FR-29 the structural delta of the branch: the codebase map's walk (FR-26.1, cached per entry point) on this
   * version, and on the base version only for the entry points whose flows touch a changed file — or exist only
   * there; every other flow is identical in both versions and is taken from this version's scan. Undefined when
   * cancelled or without a base version.
   */
  private async compareStructure(changes: BranchChanges, opts: { cancelled?(): boolean; onProgress?(phase: string, done: number, total: number): void }): Promise<ReviewStructure | undefined> {
    // asked with the base version loaded
    const base = this.base!;
    const progress = (phase: string) => (done: number, total: number) => opts.onProgress?.(phase, done, total);
    const branchScans = await this.scanEntryPoints({ cancelled: opts.cancelled, onProgress: progress('Comparing the structure: this version') }, true);
    if (!branchScans) return undefined;
    const branchEps = (await this.getEntryPoints()).filter((e) => e.kind !== 'test');
    const baseSession = new DiagramSession({ adapter: base.adapter, classifier: this.classifier, internal: true, initialState: { options: { ...this.options, layerZoom: false, foldedLayers: [], foldErrors: false } } });
    const baseEps = (await baseSession.getEntryPoints().catch(() => [] as EntryPoint[])).filter((e) => e.kind !== 'test');
    const baseByIdentity = new Map(baseEps.map((e) => [entryIdentity(e), e]));
    const branchIdentities = new Set(branchEps.map(entryIdentity));
    const changed = new Set(changes.files.flatMap((f) => [f.file, ...(f.from ? [f.from] : [])]));
    // on the base: the affected flows that exist there too, and the entry points only the base has
    const affected = affectedScans(branchScans, changed)
      .map((s) => baseByIdentity.get(entryIdentity(s.entry)))
      .filter((e): e is EntryPoint => !!e);
    const toScan = [...affected, ...baseEps.filter((e) => !branchIdentities.has(entryIdentity(e)))];
    const notCompared = Math.max(0, toScan.length - DiagramSession.MAX_STRUCTURE_SCANS);
    const only = new Set(toScan.slice(0, DiagramSession.MAX_STRUCTURE_SCANS).map(appMapEntryKey));
    // (none to scan: an empty walk)
    const baseScans = await baseSession.scanEntryPoints({ cancelled: opts.cancelled, onProgress: progress('Comparing the structure: the base version'), only }, true);
    if (!baseScans) return undefined;
    const scanned = new Set(baseScans.map((s) => entryIdentity(s.entry)));
    const copied = branchScans.filter((s) => !scanned.has(entryIdentity(s.entry)) && baseByIdentity.has(entryIdentity(s.entry)));
    const baseSide = [...baseScans, ...copied];
    // FR-29.7 the I/O kinds of every class of each side, from that version's own file facts (a scan's classes carry
    // none, and the facts of a followed implementation may not be cached yet)
    const [baseIo, branchIo] = await Promise.all([baseSession.ioOfClasses(baseSide), this.ioOfClasses(branchScans)]);
    if (opts.cancelled?.()) return undefined;
    const renames = new Map(changes.files.flatMap((f) => (f.from ? [[f.from, f.file] as const] : [])));
    const rows = diffStructure({ scans: baseSide, entryPoints: baseEps, io: baseIo }, { scans: branchScans, entryPoints: branchEps, io: branchIo }, { renames });
    return { rows, compared: baseScans.length, copied: copied.length, notCompared };
  }

  /** FR-29.7 / 28.10 class key → the I/O clients of its file's libraries (the class box's badge, FR-17.2), fetched when not cached. */
  private async ioOfClasses(scans: EntryPointScan[]): Promise<Map<string, IoUse[]>> {
    const keys = new Set(scans.flatMap((s) => s.classes.filter((c) => c.kind !== 'interface' && !c.group).map((c) => c.key)));
    const out = new Map<string, IoUse[]>();
    await Promise.all(
      [...keys].map(async (k) => {
        const facts = await this.cache.fetchModuleFacts(k).catch(() => undefined);
        const uses = facts ? libraryClients(facts.libraries) : [];
        if (uses.length) out.set(k, uses);
      }),
    );
    return out;
  }

  /**
   * FR-29 opens the flow behind a structure row: its entry point expanded fully and I/O scanned (as the scan saw
   * it), zoomed to layers for a layer-level row (FR-28), the first call of the first class pair found for
   * highlighting. Undefined for a row with nothing to open (an entry point the branch removed).
   */
  async openReviewStructure(row: StructureRow): Promise<{ diagram: SequenceDiagram | undefined; messageId?: string } | undefined> {
    if (!row.entryPoint || row.kind === 'entry-removed') return undefined;
    if (!(await this.openFinding(row.entryPoint))) return undefined;
    if (row.level === 'layer' && !this.options.layerZoom) await this.setOption('layerZoom', true);
    else if (row.level === 'package' && this.options.layerZoom) await this.setOption('layerZoom', false);
    // (opened: a diagram)
    const diagram = this.current()!;
    const pair = row.pairs?.[0];
    if (!pair) return { diagram };
    const site = pair.call?.callSite;
    const same = (a: SourceRange | undefined) => !!site && !!a && a.file === site.file && a.start.line === site.start.line && a.start.character === site.start.character;
    const byClass = (m: Message) => diagram.participants.find((p) => p.id === m.from)?.classKey === pair.from && diagram.participants.find((p) => p.id === m.to)?.classKey === pair.to;
    // a creation and the call on it share one call site (`new Db().save()`): the one the row names
    const called = pair.call?.label.split(' → ').pop();
    const atSite = diagram.messages.filter((m) => same(m.callSite));
    const hit = atSite.find((m) => m.methodName === called) ?? atSite[0] ?? diagram.messages.find(byClass);
    return { diagram, ...(hit ? { messageId: hit.id } : {}) };
  }

  /**
   * FR-24.7 where a reviewed call is in the diff: its file now (a removed call: the file it was in, by its
   * current path), the 0-based line now, and the hunk lines around it.
   */
  /**
   * FR-24.15 may a call of today's flow stand for a base call (FR-24.6 pairing)? Not when today's lines are all new
   * while the base call's lines are all still there (the base call moved elsewhere — into a new method): two calls.
   */
  private sameCall(cur: Message, old: Message): boolean {
    const g = this.reviewGit;
    // asked during a review, for the calls below drawn calls: each has its call site (flow-changes pairs only those)
    /* v8 ignore start -- what another module guarantees (see the comment); kept as a fallback: if that ever changes, a worse answer instead of a crash */
    if (!g || !cur.callSite || !old.callSite) return true;
    /* v8 ignore stop */
    const rel = (f: string) => f.replace(/\\/g, '/').replace(`${g.root.replace(/\\/g, '/')}/`, '');
    const lines = (r: SourceRange) => Array.from({ length: r.end.line - r.start.line + 1 }, (_, i) => r.start.line + 1 + i);
    const now = rel(cur.callSite.file);
    const was = g.files.find((f) => f.from === rel(old.callSite!.file))?.file ?? rel(old.callSite.file);
    const allNew = lines(cur.callSite).every((l) => isChangedLine(g.hunks.get(now), 'new', l));
    const oldKept = lines(old.callSite).every((l) => !isChangedLine(g.hunks.get(was), 'old', l));
    return !(allNew && oldKept);
  }

  /** FR-24.15 the base version's text of the files of the removed calls in `messages` (cached per review). */
  private async prefetchBaseTexts(messages: Message[]): Promise<void> {
    const g = this.reviewGit;
    if (!g) return;
    const root = g.root.replace(/\\/g, '/');
    for (const m of messages) {
      if (m.diff?.status !== 'removed' || !m.callSite) continue;
      const rel = m.callSite.file.replace(/\\/g, '/').replace(`${root}/`, '');
      if (this.baseTextMemo.has(rel)) continue;
      this.baseTextMemo.set(rel, await git(g.root, ['show', `${g.mergeBase}:${g.prefix}${rel}`]).catch(() => ''));
    }
  }

  /**
   * FR-24.15 where a removed call was, in today's file: at the call that follows it now (what replaced it), else
   * after the call before it, else at its caller's declaration.
   */
  private ghostLine(m: Message, messages: Message[]): number | undefined {
    const siblings = messages.filter((x) => x.parentId === m.parentId);
    const i = siblings.findIndex((x) => x.id === m.id);
    const next = siblings.slice(i + 1).find((x) => x.diff?.status !== 'removed' && x.callSite);
    if (next) return next.callSite!.start.line;
    const prev = siblings.slice(0, i).reverse().find((x) => x.diff?.status !== 'removed' && x.callSite);
    if (prev) return prev.callSite!.end.line + 1;
    return messages.find((x) => x.id === m.parentId)?.targetDeclaration?.start.line;
  }

  private diffPlace(m: Message, ctx: { baseSite?: NonNullable<Message['callSite']>; messages: Message[] }): { file: string; from?: string; line: number; hunk?: DiffLine[] } | undefined {
    const g = this.reviewGit;
    // a call whose method changed (not the call): the method's own declaration
    const site = m.diff?.method && !m.diff.status && !m.diff.call ? (m.targetDeclaration ?? m.callSite) : m.callSite;
    if (!g || !site) return undefined;
    const root = g.root.replace(/\\/g, '/');
    const rel = site.file.replace(/\\/g, '/').replace(`${root}/`, '');
    const lineRange = (r: SourceRange) => Array.from({ length: Math.min(16, r.end.line - r.start.line + 1) }, (_, i) => r.start.line + i);
    if (m.diff?.status === 'removed') {
      // the ghost's location is in the base version: the file may have been renamed since
      const renamed = g.files.find((f) => f.from === rel);
      const file = renamed?.file ?? rel;
      // FR-24.15 its own lines, from the base version (not the diff lines around them; read before, by
      // prefetchBaseTexts — empty when git could not show it)
      const base = this.baseTextMemo.get(rel)!.split('\n');
      const own: DiffLine[] = lineRange(site).map((l, k) => ({ kind: '-' as const, text: (base[l] ?? '').replace(/\r$/, ''), ...(k === 0 ? { at: true } : {}) }));
      return { file, ...(renamed ? { from: rel } : {}), line: this.ghostLine(m, ctx.messages) ?? site.start.line, hunk: own };
    }
    const from = g.files.find((f) => f.file === rel)?.from;
    if (m.diff?.status === 'added' && site === m.callSite) {
      // FR-24.15 a new call: its own lines (today's file), all new — also when git lined them up as unchanged (a
      // method's body moved into a new method)
      let text: string[] | undefined;
      try {
        text = readFileSync(path.join(g.root, rel), 'utf8').split('\n');
      } catch {
        text = undefined;
      }
      if (text) return { file: rel, ...(from ? { from } : {}), line: site.start.line, hunk: lineRange(site).map((l, k) => ({ kind: '+' as const, text: (text![l] ?? '').replace(/\r$/, ''), ...(k === 0 ? { at: true } : {}) })) };
    }
    // FR-24.15 a call both versions make (same file): its own old lines against its new ones, not whatever diff
    // lines sit around it
    const baseSite = ctx.baseSite;
    const own = baseSite && baseSite.file.replace(/\\/g, '/') === site.file.replace(/\\/g, '/') && m.diff?.status !== 'added' ? callChangeLines(g.hunks.get(rel), [baseSite.start.line + 1, baseSite.end.line + 1], [site.start.line + 1, site.end.line + 1]) : undefined;
    // (a base site is given by the render only, which takes the hunk)
    if (own) return { file: rel, line: site.start.line, hunk: own };
    const around = hunkAround(g.hunks.get(rel), site.start.line + 1, 'new');
    return { file: rel, ...(from ? { from } : {}), line: site.start.line, ...(around ? { hunk: around.lines } : {}) };
  }


  /** FR-24.11 the side-by-side diff of a changed class: at the member (its first changed line), else at the class. */
  async classDiffTarget(classKey: string, member?: string): Promise<DiffTarget | undefined> {
    const g = this.reviewGit;
    const file = fileOfClassKey(classKey);
    if (!g || file === undefined || !g.files.some((f) => f.file === file || f.from === file)) return undefined;
    const change = await this.classChange(classKey);
    const m = member ? change?.members.find((x) => x.name === member && x.line) : change?.members.find((x) => x.line);
    const decl = (await this.cache.fetchClassInfo(classKey).catch(() => undefined))?.ref.declaration;
    const line = m?.line ? m.line - 1 : (decl?.start.line ?? 0);
    const fc = g.files.find((f) => f.file === file);
    // (a file the branch added has no base text: git cannot show it)
    const baseText = await git(g.root, ['show', `${g.mergeBase}:${g.prefix}${fc?.from ?? file}`]).catch(() => '');
    return { file: `${g.root.replace(/\\/g, '/')}/${file}`, line, baseText, title: `${file.replace(/^.*\//, '')} (${g.base} ↔ ${g.branch ?? 'working tree'})` };
  }

  /** FR-24.7 the side-by-side diff of a reviewed call: its file now and at the merge base, at the call's line. */
  async diffTarget(messageId: string, part?: { method?: boolean }): Promise<DiffTarget | undefined> {
    const g = this.reviewGit;
    const m = this.lastDiagram?.messages.find((x) => x.id === messageId);
    // FR-24.15 the method's change (a tour step): at its declaration, as for a call whose method alone changed
    if (m) await this.prefetchBaseTexts([m]);
    // (a message found: the diagram is there)
    const at = m && this.diffPlace(part?.method ? { ...m, diff: { method: m.diff?.method ?? 'changed' } } : m, { messages: this.lastDiagram!.messages });
    if (!g || !at) return undefined;
    // (a file the branch added has no base text: git cannot show it)
    const baseText = await git(g.root, ['show', `${g.mergeBase}:${g.prefix}${at.from ?? at.file}`]).catch(() => '');
    const name = at.file.replace(/^.*\//, '');
    return { file: `${g.root.replace(/\\/g, '/')}/${at.file}`, line: at.line, baseText, title: `${name} (${g.base} ↔ ${g.branch ?? 'working tree'})` };
  }

  /**
   * FR-24.9 the review's paths below each method: method key → the changed methods reached through it, each
   * with the rest of a path from it (the shortest). From the paths to here the review found (entry points down).
   */
  private changesBelow(): Map<string, Map<string, CallPathStep[]>> {
    const out = new Map<string, Map<string, CallPathStep[]>>();
    for (const m of this.lastReview?.result.methods ?? []) {
      for (const r of m.reachedFrom) {
        r.steps.forEach((s, i) => {
          if (i === r.steps.length - 1) return;
          const below = out.get(s.methodKey) ?? new Map<string, CallPathStep[]>();
          const rest = r.steps.slice(i);
          const known = below.get(m.method.key);
          if (!known || rest.length < known.length) below.set(m.method.key, rest);
          out.set(s.methodKey, below);
        });
      }
    }
    return out;
  }

  /** FR-24.9 the changed methods below a collapsed message (its method, or the implementations of an interface call). */
  private changesUnder(node: BuildResult['nodes'] extends Map<string, infer N> ? N : never, below: Map<string, Map<string, CallPathStep[]>>): Map<string, CallPathStep[]> {
    const out = new Map<string, CallPathStep[]>();
    // (a path below a method ends at another method: the method itself is never below it)
    const keys = [node.effective?.key, ...(node.effective?.hasBody ? [] : (node.implementations ?? []).map((i) => i.key))].filter((k): k is string => !!k);
    for (const k of keys) for (const [m, rest] of below.get(k) ?? []) if (!out.has(m)) out.set(m, rest);
    return out;
  }

  /** FR-24.9 expands a collapsed call down to the first changed method below it (on the review's paths). */
  revealChange(messageId: string): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    const held = this.lastPlaced ? firstHeldBy(this.lastPlaced, messageId) : undefined;
    if (held && this.state) return this.revealHeld(messageId, held.path, held.needs);
    return (async () => {
      const node = (await this.nodes()).get(messageId);
      if (!node) return undefined;
      const paths = [...this.changesUnder(node, this.changesBelow()).values()].sort((a, b) => a.length - b.length);
      if (!paths.length) return undefined;
      return this.revealSearchHit({ anchorId: messageId, steps: paths[0], labels: [], hit: { label: '', range: { file: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } });
    })();
  }

  /**
   * FR-24.15 ▶ on a call holding changes (collapsed, or showing another implementation): opens the way to the first
   * of them — the implementations it needs chosen, the calls on the way expanded, zoomed: the layer of its sender
   * opened — and lands on the first change after the call in reading order (none skipped).
   */
  private revealHeld(holderId: string, path: string[], needs: Map<string, string>): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    return this.serialized(async () => {
      // asked with a diagram open
      const state = this.state!;
      const nodes = await this.nodes();
      for (const [i, id] of path.entries()) {
        const need = needs.get(id);
        if (need && nodes.get(id)?.effective?.owner.key !== need) {
          // another implementation: what was open below belongs to the one shown now (same ids)
          this.collapseSubtree(state, id);
          state.choices.set(id, need);
          const declared = nodes.get(id)?.declared;
          if (declared) this.interfaceChoices.delete(declared.owner.key);
        }
        if (id !== 'root' && i < path.length - 1) state.expanded.add(id);
      }
      const target = path[path.length - 1];
      // rendered from a state: a diagram
      const diagram = (await this.renderShowing(path))!;
      const messages = diagram.messages;
      const weight = (m: Message) => (m.diff?.count ?? 0) + (m.diff?.folded ?? 0);
      const at = messages.findIndex((m) => m.id === holderId);
      const hit = messages.find((m) => m.id === target && weight(m) > 0) ?? messages.slice(at + 1).find((m) => weight(m) > 0);
      return { diagram, messageId: hit?.id ?? holderId };
    });
  }

  /**
   * Renders; zoomed to layers and the call at the end of `path` folded into a layer: its sender's layer opened (a
   * removed call's sender is its parent's target), so the call is drawn.
   */
  private async renderShowing(path: string[]): Promise<SequenceDiagram | undefined> {
    const target = path[path.length - 1];
    await this.showBranchesHolding([target]);
    let diagram = await this.render();
    if (!this.layerFold() || !diagram || diagram.messages.some((m) => m.id === target)) return diagram;
    // a target not drawn is not the root: it has a sender — its own (drawn in the object view), or (a removed call) its
    // parent's target
    const build = this.lastBuild!;
    const byId = new Map(build.messages.map((m) => [m.id, m]));
    const own = byId.get(target);
    const parent = byId.get(path[path.length - 2]);
    /* v8 ignore start -- what another module guarantees (see the comment); kept as a fallback: if that ever changes, a worse answer instead of a crash */
    const senderId = own ? own.from : parent?.to;
    const sender = build.participants.find((p) => p.id === senderId);
    // (and its layer is folded: an opened layer draws its objects, so the target would be drawn)
    if (!sender || this.isLayerOpen(zoomKey(sender))) return diagram;
    /* v8 ignore stop */
    this.options = this.withLayer(this.options, zoomKey(sender), true);
    return this.render();
  }

  /**
   * FR-24.15 the review tour: shows the flow's change number `n` (1-based, the fixed order of `reviewTotal`) — the
   * implementations it needs chosen, the calls on the way expanded, its layer opened when zoomed — and returns the
   * message to highlight. So ◀ ▶ walk the same list forwards and back whatever the view is.
   */
  showChange(n: number): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    return this.serialized(async () => {
      const state = this.state;
      const placed = this.lastPlaced;
      const p = placed ? changeAt(placed, n) : undefined;
      if (!state || !p) return undefined;
      let path: string[];
      let needs = new Map<string, string>();
      if (p.kind === 'own') {
        // drawn in the object view (perhaps folded into a layer): the path to it
        path = [];
        // placed by the last render: its build is there
        const byId = new Map(this.lastBuild!.messages.map((m) => [m.id, m]));
        const ghost = !byId.has(p.id);
        let x = byId.get(ghost ? p.id.slice(0, p.id.lastIndexOf('/')) : p.id);
        for (; x; x = x.parentId ? byId.get(x.parentId) : undefined) path.unshift(x.id);
        if (ghost) path.push(p.id);
      } else {
        ({ path, needs } = p.occurrence);
        const nodes = await this.nodes();
        for (const [i, id] of path.entries()) {
          const need = needs.get(id);
          if (need && nodes.get(id)?.effective?.owner.key !== need) {
            // another implementation: what was open below belongs to the one shown now (same ids)
            this.collapseSubtree(state, id);
            state.choices.set(id, need);
            const declared = nodes.get(id)?.declared;
            if (declared) this.interfaceChoices.delete(declared.owner.key);
          }
          if (id !== 'root' && i < path.length - 1) state.expanded.add(id);
        }
      }
      // rendered from a state: a diagram
      const diagram = (await this.renderShowing(path))!;
      // the message holding number n now (drawn, or the call it is folded / collapsed into)
      const holder = diagram.messages.find((m) => m.diff?.positions?.some((x) => x.n === n)) ?? diagram.messages.find((m) => m.diff?.held?.includes(n));
      // (every placed change is on a drawn message — its own, or the call it is folded / collapsed into: layer zoom
      // keeps `held`)
      /* v8 ignore start -- what another module guarantees (see the comment); kept as a fallback: if that ever changes, a worse answer instead of a crash */
      return { diagram, messageId: holder?.id ?? path[path.length - 1] };
      /* v8 ignore stop */
    });
  }

  /** Expands `state` along a path from its root; false when the path needs another implementation of a call chosen already. */
  private async walkPath(state: ViewState, steps: CallPathStep[], from?: { id: string; method: MethodRef }): Promise<boolean> {
    let id = from?.id ?? 'root';
    let method = from?.method ?? state.root;
    for (let i = 0; i + 1 < steps.length; i++) {
      const at = steps[i].call;
      const callee = await this.adapter.getMethod(steps[i + 1].methodKey);
      if (!at || !callee) return true;
      const next = await this.expandCallTo(state, id, method, at, callee, { keepChoices: true });
      if (next === null) return false;
      if (!next) return true;
      id = next;
      method = callee;
    }
    return true;
  }

  /** FR-24.15 the changes of the flow of `state` as one fixed list (cached per review, root, filters and options). */
  private flowChanges(state: ViewState): Promise<FlowChanges | undefined> {
    const { layerZoom: _z, openLayers: _l, openObjects: _o, foldedLayers: _f, foldErrors: _e, ...options } = this.options;
    const key = JSON.stringify([state.root.key, state.entry?.method.key ?? '', this.filters.map((f) => f.id), options]);
    let memo = this.flowChangesMemo.get(key);
    if (!memo) {
      memo = this.computeFlowChanges(state).catch(() => undefined);
      this.flowChangesMemo.set(key, memo);
    }
    return memo;
  }

  /**
   * The flow expanded along every path to a changed method below its root; a path needing another implementation
   * of a call than an earlier path goes to another variant of the flow. Each variant built and compared with the
   * base version, the changes collected by identity (a call site, a changed method).
   */
  private async computeFlowChanges(state: ViewState): Promise<FlowChanges | undefined> {
    // asked by a render during a review
    const marks = this.reviewMarks!;
    const root = state.root;
    const fresh = (): ViewState => ({ root, expanded: new Set(), choices: new Map(), ...(state.entry ? { entry: state.entry } : {}) });
    const variants: ViewState[] = [];
    // (each path below the root starts at the root)
    for (const steps of this.changesBelow().get(root.key)?.values() ?? []) {
      let placed = false;
      for (const v of variants) {
        const trial: ViewState = { ...v, expanded: new Set(v.expanded), choices: new Map(v.choices) };
        if (!(await this.walkPath(trial, steps))) continue;
        Object.assign(v, { expanded: trial.expanded, choices: trial.choices });
        placed = true;
        break;
      }
      if (placed) continue;
      const v = fresh();
      await this.walkPath(v, steps);
      variants.push(v);
    }
    if (!variants.length) variants.push(fresh());
    const flow: FlowChanges = { changes: new Map(), order: [] };
    const first = variants[0];
    for (const v of variants) {
      // a later variant: where its path takes another implementation than the first one's
      const divergeAt = v === first ? undefined : (path: string[]) => path.find((id) => first.choices.has(id) && v.choices.has(id) && first.choices.get(id) !== v.choices.get(id));
      // no remembered interface choices: a variant shows exactly the implementations its paths need; the error branches
      // unfolded (FR-3.12): the list is the same with ↯ on or off
      const build = await this.buildFor(v, new Map(), { ...this.options, foldErrors: false });
      this.markChangedLines(build, marks);
      const d = { messages: build.messages, participants: build.participants, groups: build.groups };
      await this.compareWithBase(v, build, d);
      collectChanges(flow, d.messages, v.choices as Map<string, string | null>, divergeAt);
    }
    interfaceChangesLast(flow);
    return flow;
  }

  /** FR-24.4 marks the calls on the branch's changed lines and the calls of methods it added / changed. */
  private markChangedLines(build: BuildResult, marks: ReviewMarks): void {
    const root = (this.classifier.projectRoot?.() ?? this.adapter.projectRoot).replace(/\\/g, '/');
    for (const m of build.messages) {
      const site = m.callSite;
      const file = site ? site.file.replace(/\\/g, '/').replace(`${root}/`, '') : undefined;
      const call = m.kind !== 'found' && !!file && !!site && marks.lines.get(file)?.has(site.start.line + 1);
      const node = build.nodes.get(m.id);
      const method = marks.methods.get(node?.effective?.key ?? m.methodKey ?? '');
      // through an interface: its method changed while the implementation drawn did not
      const declared = !method && node?.declared && node.effective && node.declared.key !== node.effective.key ? marks.methods.get(node.declared.key) : undefined;
      if (call || method || declared) m.diff = { ...(call ? { call: true } : {}), ...(method ? { method } : {}), ...(declared ? { declared } : {}) };
    }
  }

  /** FR-24.10 a flow of the review tour: opened from its first method, expanded along each path to a changed method. */
  openChangeFlow(paths: CallPathStep[][], entry?: EntryPoint): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    return this.serialized(async () => {
      const first = paths.find((p) => p.length);
      const root = first ? await this.adapter.getMethod(first[0].methodKey) : undefined;
      if (!root) return undefined;
      const state: ViewState = { root, expanded: new Set(), choices: new Map(), ...(entry?.method.key === root.key ? { entry } : {}) };
      this.push(state);
      // FR-24.15 paths through another implementation of a call opened already stay closed: that call says how
      // many changes its other implementations have (▶ shows them)
      for (const steps of paths) if (steps[0]?.methodKey === root.key) await this.walkPath(state, steps);
      await this.showBranchesHolding(state.expanded);
      // the first change in diagram order
      // rendered from the state just pushed: a diagram
      const diagram = (await this.render())!;
      const marked = diagram.messages.find((m) => (m.diff?.count ?? (hasOwnChange(m) ? 1 : 0)) > 0);
      return { diagram, messageId: marked?.id ?? 'root' };
    });
  }

  /** Renders the current view again (no analysis is redone) — e.g. after the review marks changed. */
  redraw(): Promise<SequenceDiagram | undefined> {
    return this.serialized(() => this.render());
  }

  /** FR-24.4 stop marking the reviewed changes; re-renders. */
  endReview(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.reviewMarks = undefined;
      this.reviewGit = undefined;
      this.classChangeMemo.clear();
      this.flowChangesMemo.clear();
      this.baseTextMemo.clear();
      // the base version stays loaded: reviewing again without changes reuses it (FR-24.8)
      return this.render();
    });
  }

  /** FR-24.3 an issue's flow, as the review saw it (expanded fully, I/O scanned) — from its entry point or its changed method. */
  openReviewFlow(issue: ReviewIssue): Promise<SequenceDiagram | undefined> {
    if (issue.entryPoint) return this.openFinding(issue.entryPoint);
    const key = issue.methodKey;
    if (!key) return Promise.resolve(this.current());
    return this.openMethodByKey(key).then(async (d) => {
      if (!d) return undefined;
      await this.expandEverything();
      return (await this.scanSideEffects()) ?? this.current();
    });
  }

  /**
   * FR-22 opens a path top-down: its first step is the root (with the entry point's tag when it is
   * one), each call along the path is expanded down to the target. Returns the diagram and the id of
   * the message that runs the target (for highlighting); a step that no longer matches the code ends
   * the expansion there. Undefined when the start method no longer exists.
   */
  openPath(steps: CallPathStep[], entry?: EntryPoint): Promise<{ diagram: SequenceDiagram | undefined; messageId: string } | undefined> {
    return this.serialized(async () => {
      const root = steps.length ? await this.adapter.getMethod(steps[0].methodKey) : undefined;
      if (!root) return undefined;
      const state: ViewState = { root, expanded: new Set(), choices: new Map(), ...(entry?.method.key === root.key ? { entry } : {}) };
      this.push(state);
      let id = 'root';
      let method = root;
      for (let i = 0; i + 1 < steps.length; i++) {
        const at = steps[i].call;
        const callee = await this.adapter.getMethod(steps[i + 1].methodKey);
        const next = at && callee ? await this.expandCallTo(state, id, method, at, callee) : undefined;
        if (!next || !callee) break;
        id = next;
        method = callee;
      }
      return { diagram: await this.render(), messageId: id };
    });
  }

  // ───────────── hide filters (FR-11) ─────────────

  hide(spec: HideFilterSpec): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const filter = toFilter(spec);
      // FR-11.7 one rule per target: hiding replaces "don't expand" and the other way round
      const target = filterTarget(filter.id);
      this.filters = this.filters.filter((f) => f.id === filter.id || filterTarget(f.id) !== target);
      if (!this.filters.some((f) => f.id === filter.id)) this.filters.push(filter);
      // FR-11.7 a "don't expand" rule folds every open call it matches (what the rule says the diagram should look like)
      if (filter.noExpand && this.state) {
        const build = (await this.build())!;
        for (const m of build.messages) if (m.noExpand === filter.id && m.expanded) this.collapseSubtree(this.state, m.id);
      }
      return this.render();
    });
  }

  unhide(filterId: string): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.filters = this.filters.filter((f) => f.id !== filterId);
      return this.render();
    });
  }

  unhideAll(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.filters = [];
      return this.render();
    });
  }

  setOption<K extends keyof DiagramOptions>(option: K, value: DiagramOptions[K]): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      // FR-28.11 ◫ Layers folds every layer, off opens every layer: the exceptions (opened / folded layers) are dropped
      const all = option === 'layerZoom' ? { openLayers: [], openObjects: [], foldedLayers: [] } : {};
      this.options = { ...this.options, ...all, [option]: value };
      // FR-3.12 ↯ Fold errors on / off: the branches shown one by one are forgotten (what is expanded stays)
      if (option === 'foldErrors') delete this.state?.shownErrorPaths;
      return this.render();
    });
  }

  /**
   * FR-28.7 layer zoom: open a layer in place (its objects drawn) or fold it again; `layer` is the lifeline key.
   * FR-28.8 a participant id pulls that object out of its layer / puts it back; a class key every object of the class.
   */
  setLayerOpen(layer: string, open: boolean): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      // the objects of the diagram on screen (none yet: only the layer keys count)
      const participants = this.lastBuild?.participants ?? [];
      const keyOf = (id: string) => {
        const p = participants.find((x) => x.id === id);
        return p ? zoomKey(p) : undefined;
      };
      if (layer.startsWith('layer:')) {
        // folding a layer puts its pulled-out objects back too: one lifeline for all of them
        const objects = open ? (this.options.openObjects ?? []) : (this.options.openObjects ?? []).filter((id) => keyOf(id) !== layer);
        this.options = { ...this.withLayer(this.options, layer, open), openObjects: objects };
        return this.render();
      }
      const ids = participants.some((p) => p.id === layer) ? [layer] : participants.filter((p) => p.classKey === layer).map((p) => p.id);
      let options = this.options;
      const objects = (this.options.openObjects ?? []).filter((id) => !ids.includes(id));
      if (!open) {
        // FR-28.8 one object of an opened layer put back: the layer is "all of its objects out" — it closes and the
        // others stay out, so ⊖ on an object always means this object
        for (const key of new Set(ids.map(keyOf))) {
          if (!key || !this.isLayerOpen(key, options)) continue;
          options = this.withLayer(options, key, false);
          for (const p of participants) if (zoomKey(p) === key && !ids.includes(p.id) && !objects.includes(p.id)) objects.push(p.id);
        }
      }
      this.options = { ...options, openObjects: open ? [...objects, ...ids] : objects };
      return this.render();
    });
  }

  /** FR-28.9 every layer folded (FR-28.11 also from the object view: the zoom turns on), every pulled-out object put back. */
  foldAllLayers(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      this.options = { ...this.options, layerZoom: true, openLayers: [], openObjects: [], foldedLayers: [] };
      return this.render();
    });
  }

  /**
   * FR-28 / FR-28.11 which layers the diagrams fold: zoomed, every layer but the opened ones; in the object view only
   * the folded ones (`folded`). Undefined = nothing folded: the object view as built.
   */
  private layerFold(): { open: Set<string>; folded?: Set<string> } | undefined {
    if (this.options.layerZoom) return { open: new Set(this.options.openLayers) };
    const folded = this.options.foldedLayers ?? [];
    return folded.length ? { open: new Set(), folded: new Set(folded) } : undefined;
  }

  /** FR-28.11 whether a layer (lifeline key) is drawn as its objects: zoomed when opened, in the object view unless folded. */
  private isLayerOpen(key: string, options: DiagramOptions = this.options): boolean {
    return options.layerZoom ? (options.openLayers ?? []).includes(key) : !(options.foldedLayers ?? []).includes(key);
  }

  /** FR-28.11 the options with a layer opened / folded: zoomed in `openLayers`, in the object view in `foldedLayers`. */
  private withLayer(options: DiagramOptions, key: string, open: boolean): DiagramOptions {
    if (options.layerZoom) {
      const layers = (options.openLayers ?? []).filter((l) => l !== key);
      return { ...options, openLayers: open ? [...layers, key] : layers };
    }
    const layers = (options.foldedLayers ?? []).filter((l) => l !== key);
    return { ...options, foldedLayers: open ? layers : [...layers, key] };
  }

  /** FR-28.8 the classes of the objects pulled out of their layer (for the class diagram's projection). */
  private openClasses(build: BuildResult): Set<string> {
    const out = new Set(this.options.openObjects ?? []);
    return new Set(build.participants.filter((p) => out.has(p.id)).map((p) => p.classKey));
  }

  // ───────────── refresh (FR-13.1) ─────────────

  refresh(changedFiles?: string[]): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      await this.invalidate(changedFiles);
      const state = this.state;
      if (!state) return undefined;
      const root = await this.adapter.getMethod(state.root.key);
      if (!root) {
        // the root method is gone: no diagram until it is back (the state is kept for that)
        this.lastBuild = undefined;
        this.lastDiagram = undefined;
        return undefined;
      }
      state.root = root;
      // FR-18.14 the middleware's `handle` methods may have moved too (their rows open the declaration)
      if (state.entry?.middleware?.some((m) => m.method)) {
        // a handle deleted meanwhile: the middleware stays as a name (nothing to open)
        const middleware = await Promise.all(
          state.entry.middleware.map(async ({ method, ...m }) => {
            const now = method && (await this.adapter.getMethod(method.key));
            return now ? { ...m, method: now } : m;
          }),
        );
        state.entry = { ...state.entry, middleware };
      }
      return this.render();
    });
  }

  /** Forgets what the changed files (all: undefined; the layer config: its path) may have changed. */
  private async invalidate(changedFiles?: string[]): Promise<void> {
    for (const file of changedFiles ?? []) {
      if (isConfigFile(file)) {
        this.classifier.reloadConfig();
        this.lastReview = undefined; // layers / findings settings change the review's issues
      }
      else await this.adapter.updateFile(file);
    }
    // background steps of the diagram before (they read the caches cleared here) are stale from now on
    this.renderGeneration++;
    this.codeGeneration++;
    this.cache.clear();
    this.callersCache.clear();
    this.pathCallers.clear();
    this.codeInfoParts.clear();
    this.classChangeMemo.clear();
    this.flowChangesMemo.clear();
    this.baseTextMemo.clear();
    this.entryPoints = undefined;
    this.bindingList = undefined; // FR-8.6 a provider may have changed (read again at the next build)
    this.hostsByFile.clear();
    // the last scan keeps tagging diagrams (FR-16.3) until the list is scanned again (⌂ Entry points):
    // re-scanning after every save would cost seconds on a large project
    this.projectFindings = undefined;
    // FR-26.4 only the entry points whose flows touched a changed file are scanned again; the layer
    // configuration (or a refresh without a list) changes them all
    if (!changedFiles || changedFiles.some((f) => isConfigFile(f))) {
      this.dropScans();
      // FR-31.4 `unreachable.ignore` may have changed: the kept list no longer holds
      this.unreachable = undefined;
    } else this.dropScansTouching(changedFiles);
    this.purityMemo.clear();
    this.fileLines.clear();
    this.deepIssues.clear();
    this.deepOutcomes.clear();
    this.openedOutcomes.clear();
    this.deepSession = undefined; // its cache holds the old code
  }

  /** FR-26.4 forgets the scans of the entry points whose flows reached one of the files. */
  private dropScansTouching(changed: string[]): void {
    const norm = changed.map((f) => f.replace(/\\/g, '/'));
    const touches = (files: Iterable<string>) => [...files].some((rel) => norm.some((f) => f === rel || f.endsWith(`/${rel}`)));
    for (const [k, scan] of this.unreachedScans) if (touches(scan.files)) this.unreachedScans.delete(k);
    for (const file of [...this.fileTypes.keys()]) if (touches([file])) this.fileTypes.delete(file);
    for (const [k, scan] of this.epScans) {
      if (![...scan.files].some((rel) => norm.some((f) => f === rel || f.endsWith(`/${rel}`)))) continue;
      this.epScans.delete(k);
      this.appModel = undefined;
      this.appModelSelected = undefined;
    }
  }

  // ───────────── outputs ─────────────

  /**
   * FR-12: class diagram derived from the currently visible sequence diagram. With the option
   * `showTypeUses` (FR-12.12) also the types the shown methods reference — requested here only,
   * never for the sequence diagram.
   */
  getClassDiagram(): Promise<ClassDiagram | undefined> {
    return this.serialized(async () => {
      // the classes of the diagram on screen: none while the root method is gone
      if (!this.lastDiagram) return undefined;
      // a diagram on screen means a state (never cleared once set), and a state always builds
      const build = (await this.build())!;
      const withUses = this.options.showTypeUses === true;
      // FR-24.6 during a review with a base version: the removed calls and the participants only they reach join in (a
      // build means a state)
      const fd = await this.flowDiff(this.state!, build);
      const removedIds = new Set(fd?.diff.removed.map((r) => r.message.id) ?? []);
      const flow = fd
        ? {
            participants: [...build.participants, ...fd.diff.removedParticipants],
            messages: mergeRemoved(build.messages, fd.diff.removed),
            // (a removed participant is one of the last base build's)
            participantMeta: new Map([...build.participantMeta, ...fd.diff.removedParticipants.map((p) => [p.id, fd.baseMeta.get(p.id)!] as const)]),
          }
        : build;
      const derive = () => this.cache.resolve(() => {
        const diagram = this.deriveClasses(build, flow);
        // FR-7.10 «adapter» / «port» also on boxes the sequence diagram has no object for (an interface behind its implementation)
        for (const c of diagram.classes) applyRoles(c, this.roles.get(c.key));
        // FR-17.2 I/O badges as on the participants: the I/O libraries of the class's file (cached facts only)
        if (this.options.showSideEffects !== false) {
          for (const c of diagram.classes) {
            if (c.kind === 'interface' || c.group) continue;
            const facts = this.cache.peekModuleFacts(c.key);
            const effects = facts && libraryIo(facts.libraries);
            if (effects) c.sideEffects = effects;
          }
        }
        if (fd) {
          // classes only today's / only the base flow reaches; relations whose calls are all new / all removed
          const now = new Set(build.participants.map((p) => p.classKey));
          const added = new Set(build.participants.filter((p) => fd.diff.addedParticipants.has(p.id)).map((p) => p.classKey));
          const removed = new Set(fd.diff.removedParticipants.map((p) => p.classKey));
          for (const c of diagram.classes) {
            if (added.has(c.key)) c.diff = 'added';
            else if (removed.has(c.key) && !now.has(c.key)) c.diff = 'removed';
          }
          for (const r of diagram.relations) {
            const ids = (r.calls ?? []).map((c) => c.messageId);
            if (!ids.length) continue;
            if (ids.every((id) => removedIds.has(id))) r.diff = 'removed';
            else if (ids.every((id) => fd.diff.added.has(id))) r.diff = 'added';
          }
        }
        return diagram;
      });
      let diagram = await derive();
      // FR-7.7: classes that joined through type uses are judged by their whole file too
      if (withUses) {
        const pending = diagram.classes.filter((c) => c.usedOnly && c.layer === 'Application' && !this.purityMemo.has(c.key));
        if (pending.length) {
          await this.prefetchPurity(pending.map((c) => ({ ref: this.cache.peekClassInfo(c.key)?.ref ?? { key: c.key, name: c.name, kind: c.kind }, layer: c.layer })));
          diagram = await derive();
        }
      }
      // FR-19.17 the flow's issues, the same list as the sequence diagram's
      const issues = await this.issuesOf(build);
      if (issues.length) diagram.findings = issues;
      const below = this.issuesBelow(issues);
      if (below) diagram.issuesBelow = below;
      const ignored = this.ignoredPatterns();
      if (ignored) diagram.ignored = ignored;
      // violations only type uses make are drawn (dotted red), counted apart — never issues
      if (withUses) {
        // a layer violation's classes are its relation's two ends
        const counted = new Set(issues.flatMap((f) => (f.kind === 'layer-violation' ? [f.classKeys!.join('|')] : [])));
        const extra = new Set(diagram.relations.filter((r) => r.violation && !counted.has(`${r.from}|${r.to}`)).map((r) => `${r.from}|${r.to}`));
        if (extra.size) diagram.typeUseViolations = extra.size;
      }
      // FR-24.11 what the branch did to each class, its listed methods marked
      if (this.reviewMarks && this.options.showReviewMarks !== false) {
        for (const c of diagram.classes) {
          if (c.diff === 'removed') continue;
          const change = await this.classChange(c.key);
          if (!change) continue;
          c.change = change;
          if (change.kind === 'new') continue; // all of it is new: the tag says so
          for (const row of c.methods) {
            const m = change.members.find((x) => x.kind === 'method' && x.name === row.name && x.change !== 'removed');
            if (m) row.diff = m.change === 'added' ? 'added' : 'changed';
          }
          // the box lists the changes first: changed rows, then removed methods and changed fields, then the rest
          const extra: ClassMember[] = change.members
            .filter((x) => (x.kind === 'method' && x.change === 'removed') || x.kind === 'field')
            .map((x) => ({ name: x.name, isStatic: false, signature: x.text, diff: x.change, ...(x.kind === 'field' ? { field: true } : {}) }));
          c.methods = [...c.methods.filter((r) => r.diff), ...extra, ...c.methods.filter((r) => !r.diff)];
        }
      }
      // FR-28 zoomed to layers: one package per layer, as the sequence diagram's lifelines
      const fold = this.layerFold();
      const projected = fold ? projectClassLayers(diagram, this.classifier.layerOrder(), fold.open, this.openClasses(build), fold.folded) : diagram;
      // FR-28.11 in the object view each class can fold its layer
      return this.options.layerZoom ? projected : markFoldableClasses(projected);
    });
  }

  /** FR-12.12: the root and the effective target of every visible message, once per method and class. */
  private typeUsesOf(build: BuildResult): MethodTypeUses[] {
    const out = new Map<string, MethodTypeUses>();
    const classOf = new Map(build.participants.map((p) => [p.id, p.classKey]));
    // the method is listed under the class of the participant that runs it; an inherited one under its base class (FR-5.11)
    // a library's method (a library call) is keyed `lib:` by every adapter (its owner is «external»)
    const add = (method: MethodRef | undefined, messageId: string, participantId: string, inheritedFrom?: string): void => {
      /* v8 ignore start -- what another module guarantees (see the comment); kept as a fallback: if that ever changes, a worse answer instead of a crash */
      if (!method || method.owner.kind === 'external' || method.key.startsWith('lib:')) return;
      // a message's target is a participant of the build
      const classKey = inheritedFrom ?? classOf.get(participantId) ?? method.owner.key;
      /* v8 ignore stop */
      const key = `${classKey}|${method.key}`;
      if (!out.has(key)) out.set(key, { method, classKey, messageId, uses: this.cache.typeUses(method) });
    };
    for (const m of build.messages) add(build.nodes.get(m.id)?.effective, m.id, m.to, m.inheritedFrom?.key); // the found message's id is 'root'
    return [...out.values()];
  }

  getPersistentState(): SessionPersistentState {
    return { filters: this.filters.map((f) => ({ ...f })), options: { ...this.options } };
  }

  // ───────────── shared state (FR-25.2) ─────────────

  /** FR-25.2 the receiver's own filters / options, kept while an opened state replaced them. */
  private settingsBeforeState: SessionPersistentState | undefined;
  /** FR-25.3 the layer config of the state opened last (undefined text: the sender had none). */
  private sharedConfig: { text: string | undefined; source: string } | undefined;
  /** FR-25.3 that config is in use instead of the project's file. */
  private borrowed: BorrowedConfig | undefined;

  /** FR-25.3 the layer config in use is a shared diagram's: hosts do not write the project's file meanwhile. */
  configBorrowed(): boolean {
    return this.borrowed !== undefined;
  }

  /**
   * FR-25.3 uses the layer config of the state opened last instead of the project's file (on) — in memory, for
   * this session only — or the file again (off); what depends on the config is computed again. Throws when
   * there is no shared config or it is refused (invalid, a risky pattern).
   */
  useSharedConfig(on: boolean): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (on) {
        const shared = this.sharedConfig;
        if (!shared) throw new Error('No shared diagram with a layer config was opened.');
        if (!this.classifier.setConfigOverride) throw new Error('This project cannot use another layer config.');
        this.classifier.setConfigOverride(shared.text ?? '{}');
        this.borrowed = { source: shared.source };
      } else await this.dropBorrowedConfig();
      await this.invalidate([this.configPath()]);
      return this.render();
    });
  }

  private configPath(): string {
    return configFileOf(this.classifier.projectRoot?.() ?? this.adapter.projectRoot);
  }

  /** The project's file again (no recomputation); nothing borrowed: the same file read again. */
  private async dropBorrowedConfig(): Promise<void> {
    this.borrowed = undefined;
    this.classifier.setConfigOverride?.(undefined);
  }

  /**
   * FR-25.2 the current diagram's state to share: what makes it (root, expanded calls, choices, filters,
   * options) and what the code was (git, layer config). Undefined without a diagram.
   */
  async exportState(host: { language: string; tool?: { version?: string; host?: string }; positions?: ParticipantPositions }): Promise<DiagramStateSnapshot | undefined> {
    const { state, diagram } = await this.serialized(async () => ({ state: this.state, diagram: this.lastDiagram }));
    if (!state || !diagram) return undefined;
    const projectRoot = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
    const g = await gitState(projectRoot);
    const config = readConfigText(projectRoot);
    const { followCursor: _host, ...options } = this.options;
    // (a review's result always says how it compared)
    const review = this.reviewMarks && this.lastReview ? { base: this.lastReview.result.base, mode: this.lastReview.result.compare!.mode } : undefined;
    return {
      format: STATE_FORMAT,
      schemaVersion: STATE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      ...(host.tool ? { tool: host.tool } : {}),
      project: { name: path.basename(projectRoot), language: host.language, ...(g ? { dir: g.dir } : {}) },
      ...(g ? { git: { commit: g.commit, ...(g.branch ? { branch: g.branch } : {}), changed: limitChanged(g.changed) } } : {}),
      ...(config !== undefined ? { config } : {}),
      root: { key: state.root.key, label: `${state.root.owner.name}.${state.root.name}` },
      ...(state.entry ? { entry: { kind: state.entry.kind, label: state.entry.label } } : {}),
      expanded: [...state.expanded],
      choices: Object.fromEntries(state.choices),
      ...(state.collapsedFragments?.size ? { collapsedFragments: [...state.collapsedFragments] } : {}),
      ...(state.followedCases?.size ? { followedCases: Object.fromEntries(state.followedCases) } : {}),
      ...(state.shownErrorPaths?.size ? { shownErrorPaths: [...state.shownErrorPaths] } : {}),
      ...(state.smart ? { smart: true } : {}),
      interfaceChoices: Object.fromEntries(this.interfaceChoices),
      autoSelectSingleImplementation: this.autoSelect,
      filters: this.filters.map((f) => ({ ...f })),
      options,
      ...(host.positions && Object.keys(host.positions).length ? { positions: host.positions } : {}),
      ...(review ? { review } : {}),
      seen: seenOf(diagram),
    };
  }

  /**
   * FR-25.2 opens a shared state: its root (a new history step — Back returns to the diagram before), expanded
   * calls, choices, filters and options (the receiver's are kept for `restoreSettings`), then says what differs
   * from the sender (code, config, calls not found, message counts). Throws when the root method is not here.
   */
  restoreState(snap: DiagramStateSnapshot, host: { language: string; toolVersion?: string }): Promise<{ diagram: SequenceDiagram | undefined; report: DiagramStateReport }> {
    return this.serialized(async () => {
      const method = await this.adapter.getMethod(snap.root.key);
      if (!method) throw new Error(`${snap.root.label} is not in this project (${snap.root.key}). Open the state in the same project, on the same code.`);
      // FR-25.3 another state: the project's own config again (this state's can be chosen in its notice)
      if (this.borrowed) {
        await this.dropBorrowedConfig();
        await this.invalidate([this.configPath()]);
      }
      // FR-16.3 / FR-8.7 the entry-point list decides the root's entry tag and the container step: load it first
      await this.ensureEntryPoints();
      const entry = snap.entry ? this.entryPointList?.find((e) => e.kind === snap.entry!.kind && e.label === snap.entry!.label && e.method.key === method.key) : undefined;
      const settings: SessionPersistentState = { filters: snap.filters.map((f) => ({ ...f })), options: { ...DEFAULT_OPTIONS, ...snap.options, followCursor: this.options.followCursor } };
      const before = this.getPersistentState();
      const replaced = JSON.stringify(before) !== JSON.stringify(settings);
      if (replaced) this.settingsBeforeState ??= before;
      this.filters = settings.filters;
      this.options = settings.options;
      this.interfaceChoices.clear();
      for (const [k, v] of Object.entries(snap.interfaceChoices)) if (typeof v === 'string') this.interfaceChoices.set(k, v);
      this.push({
        root: method,
        expanded: new Set(snap.expanded),
        choices: new Map(Object.entries(snap.choices)),
        ...(snap.collapsedFragments?.length ? { collapsedFragments: new Set(snap.collapsedFragments) } : {}),
        ...(snap.followedCases && Object.keys(snap.followedCases).length ? { followedCases: new Map(Object.entries(snap.followedCases)) } : {}),
        ...(snap.shownErrorPaths?.length ? { shownErrorPaths: new Set(snap.shownErrorPaths) } : {}),
        ...(snap.smart ? { smart: true } : {}),
        ...(entry ? { entry } : {}),
      });
      // rendered from the state just pushed: a build and a diagram
      const diagram = (await this.render())!;
      const nodes = this.lastBuild!.nodes;
      const fragments = new Set(this.lastBuild!.fragments.map((f) => f.id));
      const missing = [
        ...snap.expanded.filter((id) => !nodes.has(id)).map((id) => `expanded call ${id}`),
        ...Object.keys(snap.choices).filter((id) => !nodes.has(id)).map((id) => `implementation chosen at ${id}`),
        ...(snap.collapsedFragments ?? []).filter((id) => !fragments.has(id)).map((id) => `minimized fragment ${id}`),
        ...Object.keys(snap.followedCases ?? {}).filter((id) => !fragments.has(id)).map((id) => `followed case of ${id}`),
      ];
      const projectRoot = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
      const differences = codeDifferences(snap, { git: await gitState(projectRoot), config: readConfigText(projectRoot), language: host.language, toolVersion: host.toolVersion, autoSelect: this.autoSelect });
      if (snap.entry && !entry) differences.push(`The sender opened it from the entry point ${snap.entry.label}, which is not found here.`);
      const now = seenOf(diagram);
      if (now.messages !== snap.seen.messages || now.participants !== snap.seen.participants) {
        differences.push(`The sender saw ${snap.seen.messages} messages and ${snap.seen.participants} objects, you see ${now.messages} and ${now.participants}.`);
      }
      const commit = snap.git ? ` · ${snap.git.commit.slice(0, 7)}` : '';
      const source = `${snap.root.label} · ${snap.project.name}${commit} · ${snap.createdAt.slice(0, 10)}`;
      const configDiffers = (snap.config ?? '') !== (readConfigText(projectRoot) ?? '') && !!this.classifier.setConfigOverride;
      this.sharedConfig = { text: snap.config, source };
      const report: DiagramStateReport = {
        source,
        differences,
        missing,
        seen: snap.seen,
        now,
        settingsReplaced: this.settingsBeforeState !== undefined,
        ...(configDiffers ? { configDiffers } : {}),
      };
      return { diagram, report };
    });
  }

  /** FR-25.2 takes back the filters and options an opened state replaced. */
  restoreSettings(): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      const before = this.settingsBeforeState;
      this.settingsBeforeState = undefined;
      if (before) {
        this.filters = before.filters;
        this.options = { ...before.options, followCursor: this.options.followCursor };
      }
      return this.render();
    });
  }

  /** FR-8.6 the container's registrations, read once per refresh; the hosts that run a file, per file. */
  private bindingList: ContainerBinding[] | undefined;
  private hostsByFile = new Map<string, string[] | undefined>();

  private async ensureBindings(): Promise<void> {
    if (this.bindingList || !this.adapter.getBindings) return;
    try {
      this.bindingList = await this.adapter.getBindings();
    } catch {
      this.bindingList = []; // no bindings: every implementation is offered
    }
  }

  /** FR-8.6 the applications the root's code can run in (C#: executable projects referencing its project). */
  private async rootHosts(root: MethodRef): Promise<string[] | undefined> {
    if (!this.adapter.getHostsOf) return undefined;
    const projectRoot = this.classifier.projectRoot?.() ?? this.adapter.projectRoot;
    const file = root.declaration?.file ?? `${projectRoot}/${root.key.slice(0, root.key.indexOf('#'))}`;
    if (!this.hostsByFile.has(file)) {
      let hosts: string[] | undefined;
      try {
        hosts = await this.adapter.getHostsOf(file);
      } catch {
        hosts = undefined;
      }
      this.hostsByFile.set(file, hosts);
    }
    return this.hostsByFile.get(file);
  }

  /** FR-18.14 the middleware the root's entry point runs first, as far as the View option and `pipeline` config show it. */
  private pipelineOf(entry: EntryPoint | undefined): RouteMiddleware[] {
    if (!entry?.middleware?.length || this.options.showPipeline === false) return [];
    // FR-18.14 each source has its switch: the global stack is the same on every route, so off unless asked for
    const cfg = this.classifier.pipelineConfig?.() ?? {};
    return entry.middleware.filter((m) => (m.source === 'global' ? cfg.global === true : m.source === 'controller' ? cfg.controller !== false : cfg.route !== false));
  }

  private async build(): Promise<BuildResult | undefined> {
    const state = this.state;
    if (!state) return undefined;
    const build = await this.buildFor(state);
    this.lastBuild = build;
    await this.prefetchPurity(build.participants.map((p) => ({ ref: build.participantMeta.get(p.id)?.ref, layer: p.layer })));
    await this.prefetchParticipantFacts(build);
    await this.prefetchRoleEvidence(build);
    this.annotateRoles(build);
    await this.prefetchDomainAncestors(build);
    this.annotateLayerHints(build);
    this.annotateSideEffects(build);
    return build;
  }

  /** The DI facts a build of `state` uses: the container step and pipeline (FR-18.14) at an entry point, the bound / keyed implementations. */
  private async buildContext(state: ViewState): Promise<Pick<Parameters<typeof buildDiagram>[0], 'containerStep' | 'pipeline' | 'boundImplementation' | 'keyedImplementations' | 'serviceLifetime'>> {
    await this.ensureBindings();
    const bindings = this.bindingList ? bindingLookup(this.bindingList, await this.rootHosts(state.root)) : undefined;
    // the entry point the view was opened from comes first (a method behind two routes: that route's middleware)
    const entry = this.rootEntryPoints(state).find((e) => e.kind !== 'test');
    const pipeline = this.pipelineOf(entry);
    return { containerStep: !!entry, ...(pipeline.length ? { pipeline } : {}), boundImplementation: bindings?.bound, keyedImplementations: bindings?.keyed, serviceLifetime: bindings?.lifetime };
  }

  /** The diagram of a view state, without the annotations (roles, hints, I/O) `build` adds. */
  private async buildFor(state: ViewState, interfaceChoices: Map<string, string> = this.interfaceChoices, options = this.options): Promise<BuildResult> {
    const context = await this.buildContext(state);
    return this.cache.resolve(() =>
      buildDiagram({
        state,
        cache: this.cache,
        classifier: this.classifier,
        filters: this.filters,
        options,
        interfaceChoices,
        ...context,
        autoSelectSingleImplementation: this.autoSelect,
        maxMessages: MAX_RENDER_MESSAGES,
      }),
    );
  }

  /**
   * FR-17.5 background scan: analyses the bodies below the collapsed calls of the current diagram
   * (up to MAX_IO_DEPTH levels, MAX_IO_METHODS methods, a few requests at a time) so that their I/O
   * badges do not depend on what was explored. Not serialized with the user's operations: it
   * stops as soon as another render happened. Resolves to the re-rendered diagram when badges
   * changed, else undefined. Hosts call it after posting a render and post the result.
   */
  async scanSideEffects(): Promise<SequenceDiagram | undefined> {
    const generation = this.renderGeneration;
    const io = await (this.ioScan = this.scanIo());
    // the I/O scan's own re-render (also one that changed nothing visible) is no user step; any other render since: stop
    if (!io && generation !== this.renderGeneration && this.renderGeneration !== this.stepRender) return undefined;
    const deep = await this.scanIssuesBelow(this.renderGeneration);
    return deep ?? io;
  }

  /**
   * FR-25.4 resolves when the I/O part of the background scan that runs now has ended (at once when none runs): Copy as
   * text waits for it, so the text does not say "none found" before the scan looked below the folded calls.
   */
  async ioScanned(): Promise<void> {
    await Promise.allSettled([this.ioScan]);
  }

  /**
   * ⚠ N counts the issues of the shown calls; the issues inside folded calls are found by opening the same
   * root in a background session, expanded fully (as the project scan sees the flow), once per flow until the code
   * changes. Resolves to the re-rendered diagram when the count below changed.
   */
  private async scanIssuesBelow(generation: number): Promise<SequenceDiagram | undefined> {
    const state = this.state;
    const stale = () => generation !== this.renderGeneration;
    if (this.internal || !state || stale()) return undefined;
    const key = this.deepKey(state);
    if (!this.deepIssues.has(key)) {
      // the same options and hide filters as the user's view: a hidden call's issues are no "+n" (Expand all cannot show them)
      const options: DiagramOptions = { ...this.options, showLibraryCalls: false, showSideEffects: true, scanSideEffects: true, showTypeUses: false, layerZoom: false, foldedLayers: [], foldErrors: false };
      const filters = [...this.filters];
      const sig = JSON.stringify([options, filters]);
      if (sig !== this.deepSessionFor) {
        this.deepSession = undefined;
        this.deepSessionFor = sig;
      }
      const deep = (this.deepSession ??= new DiagramSession({ adapter: this.adapter, classifier: this.classifier, internal: true, initialState: { options, filters } }));
      try {
        // stop as soon as the user moved on (another render): the next flow asks again
        if (!(await deep.openMethodByKey(state.root.key, state.entry)) || stale()) return undefined;
        await deep.expandEverything();
        if (stale()) return undefined;
        await deep.scanSideEffects();
        if (stale()) return undefined;
        this.deepIssues.set(key, deep.current()?.findings ?? []);
        const outcome = deep.flowOutcome()!;
        this.deepOutcomes.set(key, outcome);
        // the same flow for each entry point of its root (FR-32.4: the lists show it); none from code with I/O off
        if (this.options.showSideEffects !== false) for (const e of this.lastDiagram?.entryPoints ?? []) this.openedOutcomes.set(appMapEntryKey(e), outcome);
      } catch {
        return undefined;
      }
    }
    // (no wait since the last check: still the same render)
    // nothing new below: keep the diagram as it is (no re-render)
    const now = this.lastDiagram;
    if (JSON.stringify(this.issuesBelow(now?.findings) ?? null) === JSON.stringify(now?.issuesBelow ?? null) && JSON.stringify(this.outcomeShown(now!)) === JSON.stringify(now!.outcome)) return undefined;
    return this.reRenderIfChanged(stale);
  }

  /**
   * FR-32.1 the I/O of the current flow by the classes doing it — meant for a session that opened a flow fully expanded
   * and I/O scanned (the background session, a project scan). Undefined before a diagram is open.
   */
  flowOutcome(): FlowOutcome | undefined {
    const build = this.lastBuild;
    if (!build) return undefined;
    const peek = (x: MethodRef) => this.cache.peekOutgoing(x);
    return outcomeOfFlow(build, notDrawnCalls(build, peek), peek, (x) => this.cache.peekImplementations(x));
  }

  /** FR-32.2 the outcome a diagram shows: its root is an entry point, I/O is on, the background session has it. */
  private outcomeShown(d: SequenceDiagram): FlowOutcome | undefined {
    if (!d.entryPoints?.length || this.options.showSideEffects === false) return undefined;
    return this.deepOutcomes.get(this.deepKey(this.state!));
  }

  private deepKey(state: ViewState): string {
    return `${state.root.key}|${state.entry ? `${state.entry.kind}|${state.entry.label}` : ''}|${this.options.showFindings !== false}|${this.filters.map((f) => f.id).join(',')}`;
  }

  /** FR-19.22 what the project's config silences, for the ⚠ menu's Stop ignoring. */
  private ignoredPatterns(): IgnoredPatterns | undefined {
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string' && g.length > 0) : []);
    const findings = strings(this.classifier.findingsConfig?.()?.ignore);
    const layerHints = this.classifier.layerHintIgnores?.() ?? [];
    if (!findings.length && !layerHints.length) return undefined;
    return { ...(findings.length ? { findings } : {}), ...(layerHints.length ? { layerHints } : {}) };
  }

  /** the issues of the fully expanded flow that the shown calls do not have (by kind and title). */
  private issuesBelow(shown: Finding[] | undefined): { count: number; titles: string[] } | undefined {
    const state = this.state;
    const deep = state && this.deepIssues.get(this.deepKey(state));
    if (!deep) return undefined;
    const have = new Set((shown ?? []).map((f) => `${f.kind}|${f.title}`));
    const below = deep.filter((f) => !have.has(`${f.kind}|${f.title}`));
    return below.length ? { count: below.length, titles: below.map((f) => f.title) } : undefined;
  }

  /** FR-17.5 the I/O part of the background scan (see `scanSideEffects`). */
  private async scanIo(): Promise<SequenceDiagram | undefined> {
    const generation = this.renderGeneration;
    const build = this.lastBuild;
    const before = this.lastDiagram;
    if (!build || !before) return undefined;
    // FR-16.3 a diagram opened at the cursor learns that its root is an entry point (the list scanned once)
    const entries = await this.ensureEntryPoints();
    const stale = () => generation !== this.renderGeneration;
    // the code changed while the lists loaded: the build (and the bodies it read) are not the current ones
    if (stale()) return undefined;
    if (this.options.showSideEffects === false || this.options.scanSideEffects === false) return entries ? this.reRenderIfChanged(stale) : undefined;
    const reach = await this.ioReach(build, stale);
    if (!reach) return undefined;
    if (!(entries || reach.fetched) || stale()) return undefined;
    return this.reRenderIfChanged(stale);
  }

  /**
   * FR-17.5 the bodies the I/O scan reads: from the calls drawn collapsed (and the bodies behind hidden calls of the
   * expanded ones), MAX_IO_DEPTH levels down, through the implementations of interface calls. F8b: also what Overview
   * may score with — the same set whatever was opened before. Undefined when `stale` turned true meanwhile.
   */
  private async ioReach(build: BuildResult, stale: () => boolean = () => false): Promise<{ seen: Set<string>; impls: Set<string>; fetched: boolean } | undefined> {
    // the interface methods whose implementations the walk followed
    const impls = new Set<string>();
    const roots = new Map<string, MethodRef>();
    const notDrawn = notDrawnCalls(build, (x) => this.cache.peekOutgoing(x));
    for (const m of build.messages) {
      const effective = build.nodes.get(m.id)?.effective;
      if (!m.isLibrary && effective?.hasBody && !m.expanded) roots.set(effective.key, effective);
      // an interface call with no implementation chosen: its implementations decide its badge
      const implsOf = build.nodes.get(m.id)?.implementations;
      if (!m.isLibrary && !effective?.hasBody && !m.expanded && implsOf && implsOf.length <= MAX_IO_IMPLEMENTATIONS) for (const t of implsOf) if (t.hasBody) roots.set(t.key, t);
      // expanded: the bodies behind its calls hidden by a rule still count for its badge (FR-11)
      if (m.expanded) {
        for (const c of notDrawn(m.id)) {
          if (c.isLibrary || !c.target) continue;
          if (!c.target.hasBody && !this.cache.peekImplementations(c.target)) await this.cache.fetchImplementations(c.target).catch(() => []);
          for (const t of followTargets(c, (x) => this.cache.peekImplementations(x))) roots.set(t.key, t);
        }
      }
    }
    return this.fetchBodiesBelow(roots, impls, stale);
  }

  /**
   * FR-17.5 fetches the bodies below `roots` (MAX_IO_DEPTH levels, MAX_IO_METHODS methods, through the implementations of
   * interface calls), so the cache-only I/O walk (`ioBelow`) sees them. `impls` collects the interface methods followed.
   * Undefined when `stale` turned true meanwhile.
   */
  private async fetchBodiesBelow(roots: Map<string, MethodRef>, impls: Set<string>, stale: () => boolean = () => false): Promise<{ seen: Set<string>; impls: Set<string>; fetched: boolean } | undefined> {
    const seen = new Set(roots.keys());
    let level = [...roots.values()];
    let fetched = false;
    for (let depth = 0; depth <= MAX_IO_DEPTH && level.length; depth++) {
      const next: MethodRef[] = [];
      for (let i = 0; i < level.length; i += SCAN_BATCH) {
        if (stale()) return undefined;
        const batch = level.slice(i, i + SCAN_BATCH);
        fetched ||= batch.some((m) => !this.cache.peekOutgoing(m));
        const bodies = await Promise.all(batch.map((m) => this.cache.fetchOutgoing(m).catch(() => [] as CallSite[])));
        if (depth === MAX_IO_DEPTH) continue;
        const calls = bodies.flatMap(withLambdaCalls).filter((c) => !c.isLibrary && c.target);
        // interface / abstract members: the implementations decide whether there is one body to follow
        const open = calls.filter((c) => !c.target!.hasBody && !this.cache.peekImplementations(c.target!));
        if (open.length) {
          fetched = true;
          await Promise.all(open.map((c) => this.cache.fetchImplementations(c.target!).catch(() => [])));
        }
        for (const call of calls) {
          if (!call.target!.hasBody) impls.add(call.target!.key);
          for (const t of followTargets(call, (x) => this.cache.peekImplementations(x))) {
            if (seen.has(t.key) || seen.size >= MAX_IO_METHODS) continue;
            seen.add(t.key);
            next.push(t);
          }
        }
      }
      level = next;
    }
    return { seen, impls, fetched };
  }

  /** Re-renders after a background step; resolves to the diagram only when its badges / markers changed. */
  private reRenderIfChanged(stale: () => boolean): Promise<SequenceDiagram | undefined> {
    return this.serialized(async () => {
      if (stale()) return undefined;
      const signature = (d: SequenceDiagram | undefined) =>
        // the entry-point tags too: the list may arrive with this step (FR-16.3)
        JSON.stringify([d?.messages.map((m) => m.sideEffects ?? null), d?.issuesBelow?.count ?? 0, d?.entryPoints?.length ?? 0, d?.outcome ?? null]);
      const old = signature(this.lastDiagram);
      const notice = this.lastDiagram?.expandNotice; // the same view, refreshed badges: keep the expand notice
      const after = await this.render();
      this.stepRender = this.renderGeneration;
      if (after && notice) after.expandNotice = notice;
      return signature(after) === old ? undefined : after;
    });
  }

  /** FR-17.2: whole-file facts of every participant's class, in parallel (cached; TS: in-process, C#: one request per type). */
  /** FR-7.10 evidence-based «adapter» / «port» of the last build (class key → stereotypes with reasons). */
  private roles = new Map<string, StereotypeReason[]>();

  /** Class infos and module facts of the classes to judge: the concrete objects and the known implementations. */
  private roleCandidates(build: BuildResult): string[] {
    const keys = new Set<string>();
    for (const p of build.participants) if (p.kind === 'class' && p.classKey.includes('#') && !p.classKey.startsWith('lib:')) keys.add(p.classKey);
    for (const m of build.messages) for (const i of m.polymorphic?.implementations ?? []) keys.add(i.key);
    return [...keys];
  }

  private async prefetchRoleEvidence(build: BuildResult): Promise<void> {
    if (!this.adapter.getModuleFacts) return;
    const fetch = (keys: string[]) => Promise.all(keys.flatMap((k) => [this.cache.fetchClassInfo(k).catch(() => undefined), this.cache.fetchModuleFacts(k).catch(() => undefined)]));
    // their project base classes, level by level (I/O inherited from a base class counts)
    const withBases = async (keys: string[]) => {
      await fetch(keys);
      let level = keys;
      for (let depth = 0; depth < 4 && level.length; depth++) {
        level = [...new Set(level.flatMap((k) => { const b = this.cache.peekClassInfo(k)?.extends; return b && b.key.includes('#') && !b.key.startsWith('lib:') ? [b.key] : []; }))];
        await fetch(level);
      }
    };
    let level = this.roleCandidates(build);
    await withBases(level);
    // the concrete classes they hold, MAX_DELEGATE_DEPTH levels (a delegating adapter's client does the I/O)
    const seen = new Set(level);
    for (let depth = 0; depth < MAX_DELEGATE_DEPTH && level.length; depth++) {
      level = [...new Set(level.flatMap((k) => heldClasses(this.cache.peekClassInfo(k)).map((c) => c.key)))].filter((k) => !seen.has(k));
      for (const k of level) seen.add(k);
      await withBases(level);
    }
  }

  private annotateRoles(build: BuildResult): void {
    this.roles = portsAndAdapters({
      candidates: this.roleCandidates(build),
      classInfo: (k) => this.cache.peekClassInfo(k),
      moduleFacts: (k) => this.cache.peekModuleFacts(k),
    });
    for (const p of build.participants) applyRoles(p, this.roles.get(p.classKey));
  }

  private async prefetchParticipantFacts(build: BuildResult): Promise<void> {
    if (this.options.showSideEffects === false || !this.adapter.getModuleFacts) return;
    const keys = new Set<string>();
    for (const p of build.participants) if (p.kind !== 'interface' && p.kind !== 'external' && p.kind !== 'unknown') keys.add(p.classKey);
    await Promise.all([...keys].map((k) => this.cache.fetchModuleFacts(k).catch(() => undefined)));
  }

  /**
   * FR-17 I/O badges from cached data only (no adapter requests). A message shows the I/O of the
   * called method's own body — its library calls are hidden by default — unless library calls are
   * shown and the message is expanded (then they are visible below it); while collapsed it also
   * shows the I/O of the already analysed bodies below. A visible library call shows its own kind.
   * A participant shows the I/O libraries of its whole file / type.
   */
  private annotateSideEffects(build: BuildResult): void {
    const on = this.options.showSideEffects !== false;
    const notDrawn = notDrawnCalls(build, (x) => this.cache.peekOutgoing(x));
    for (const m of build.messages) {
      delete m.sideEffects;
      if (!on) continue;
      const node = build.nodes.get(m.id);
      if (m.isLibrary) {
        const kind = node?.call && ioKindOfCall(node.call);
        if (kind) m.sideEffects = toSideEffects([{ kind, call: ioCallName(node!.call!) }]);
        continue;
      }
      const effective = node?.effective;
      if (!effective?.hasBody) {
        // an interface call with no implementation chosen: the I/O all of its implementations do
        if (!m.expanded && node?.implementations?.length) {
          const effects = toSideEffects([], ioOfImplementations(node.implementations, (x) => this.cache.peekOutgoing(x), (x) => this.cache.peekImplementations(x)));
          if (effects) m.sideEffects = effects;
        }
        continue;
      }
      let own: IoFinding[];
      let below: IoFinding[];
      if (m.expanded) {
        // expanded: its drawn children carry their own badges; the calls not drawn under it — library calls
        // while they are off, calls hidden by a rule — keep their I/O here, or it would vanish (FR-17, FR-11)
        const hidden = notDrawn(m.id);
        own = directIo(hidden.filter((c) => c.isLibrary));
        below = hidden.filter((c) => !c.isLibrary).flatMap((c) => ioOfCall(c, (x) => this.cache.peekOutgoing(x), (x) => this.cache.peekImplementations(x)));
      } else {
        // read by the build: to know the call has calls to draw, or (a recursive call) to walk the same method above it
        own = directIo(this.cache.peekOutgoing(effective)!);
        below = ioBelow(effective, (x) => this.cache.peekOutgoing(x), (x) => this.cache.peekImplementations(x));
      }
      const effects = toSideEffects(own, below);
      if (effects) m.sideEffects = effects;
    }
    for (const p of build.participants) {
      delete p.sideEffects;
      if (!on) continue;
      const facts = this.cache.peekModuleFacts(p.classKey);
      const effects = facts && libraryIo(facts.libraries);
      if (effects) p.sideEffects = effects;
    }
  }

  /** FR-19.11 non-blank lines per file (until refresh). */
  private readonly fileLines = new Map<string, number | undefined>();

  /** FR-19.11 what a god-class check needs: the files' sizes and the `extends` chains (Active Record models are exempt). */
  private async prefetchSizes(build: BuildResult): Promise<void> {
    const root = this.classifier.projectRoot?.();
    const keys = [...new Set(build.participants.map((p) => p.classKey))];
    await Promise.all(
      keys.map(async (key) => {
        const file = fileOfClassKey(key);
        if (root && file && !this.fileLines.has(file)) {
          const text = await fs.readFile(path.join(root, file), 'utf8').catch(() => undefined);
          this.fileLines.set(file, text === undefined ? undefined : text.split('\n').reduce((n, l) => n + (l.trim() ? 1 : 0), 0));
        }
        let next: string | undefined = key;
        for (let depth = 0; next && depth < 8; depth++) next = (await this.cache.fetchClassInfo(next).catch(() => undefined))?.extends?.key;
      }),
    );
  }

  /** FR-19.11 the size of a class (cached data only). */
  private classSize(key: string, models: boolean): ClassSize | undefined {
    const info = this.cache.peekClassInfo(key);
    if (!info || info.synthetic) return undefined;
    return {
      methods: info.methods.filter((m) => !m.isStatic).length,
      // a class without a file (a library's: undefined) has no lines counted
      lines: this.fileLines.get(fileOfClassKey(key)!),
      fields: info.fields.length,
      dependencies: info.constructorParams.length,
      ...(!models && this.isActiveRecord(key) ? { exempt: true } : {}),
    };
  }

  /** FR-19: class infos up the `extends` chain of Domain participants (for the Active Record check; cached). */
  private async prefetchDomainAncestors(build: BuildResult): Promise<void> {
    if (this.options.showFindings === false) return;
    const start = new Set(build.participants.filter((p) => p.layer?.toLowerCase() === 'domain').map((p) => p.classKey));
    await Promise.all(
      [...start].map(async (key) => {
        let next: string | undefined = key;
        for (let depth = 0; next && depth < 8; depth++) next = (await this.cache.fetchClassInfo(next).catch(() => undefined))?.extends?.key;
      }),
    );
  }

  /** FR-19 an Active Record model (Eloquent, Rails-style): its I/O is by design, not a Domain flaw. Cached data only. */
  private isActiveRecord(classKey: string): boolean {
    return isModel(activeRecordBase(classKey, (k) => this.cache.peekClassInfo(k), this.cache.peekLibraryBase));
  }

  /** FR-7.7: purity of the Application classes / modules (only they can be hinted to Domain). */
  private async prefetchPurity(items: { ref?: ClassRef; layer?: string }[]): Promise<void> {
    if (!this.adapter.getModuleFacts) return;
    for (const { ref, layer } of items) {
      if (ref && layer === 'Application' && ref.kind !== 'interface' && !this.purityMemo.has(ref.key)) await this.purityOf(ref, 0, new Set());
    }
  }

  /**
   * FR-7.7 pure = takes no ports, uses no I/O library, and every project dependency is Domain or
   * itself pure (transitively; a cycle counts as pure). Outer-layer dependencies make it impure.
   * Undefined when the adapter cannot tell or the dependency chain is too deep.
   */
  private async purityOf(ref: ClassRef, depth: number, visiting: Set<string>): Promise<Purity | undefined> {
    const known = this.purityMemo.get(ref.key);
    if (known || this.purityMemo.has(ref.key)) return known;
    if (visiting.has(ref.key)) return { pure: true, reasons: [] };
    if (depth > 4) return undefined;
    visiting.add(ref.key);
    const facts = await this.cache.fetchModuleFacts(ref.key);
    let result: Purity | undefined;
    if (!facts) result = undefined;
    else if (facts.ports.length) result = { pure: false, reasons: [`takes ports: ${facts.ports.slice(0, 3).join(', ')}`] };
    else if (facts.libraries.some(isIoLibrary)) result = { pure: false, reasons: [`does I/O: ${facts.libraries.filter(isIoLibrary).slice(0, 3).join(', ')}`] };
    else {
      const names: string[] = [];
      // a dependency whose purity cannot be told (no facts, a chain too deep): neither can this one's
      let unknown = false;
      for (const dep of facts.dependsOn) {
        if (dep.key.startsWith('lib:') || dep.key === ref.key) continue;
        const layer = this.classifier.classify(dep, this.cache.peekClassInfo(dep.key)).layer;
        if (layer === 'Presentation' || layer === 'Infrastructure') {
          result = { pure: false, reasons: [`depends on ${dep.name} (${layer})`] };
          break;
        }
        names.push(dep.name);
        if (layer === 'Domain') continue;
        const sub = await this.purityOf(dep, depth + 1, visiting);
        if (!sub) {
          unknown = true;
          break;
        }
        if (!sub.pure) {
          result = { pure: false, reasons: [`depends on ${dep.name}, which ${sub.reasons[0]}`] };
          break;
        }
      }
      if (!result && !unknown) {
        const deps = [...new Set(names)];
        result = {
          pure: true,
          reasons: [
            'pure (whole file): takes no ports, no I/O',
            deps.length ? `depends only on Domain or pure code: ${deps.slice(0, 4).join(', ')}${deps.length > 4 ? ` (+${deps.length - 4})` : ''}` : 'no project dependencies',
          ],
        };
      }
    }
    visiting.delete(ref.key);
    if (depth === 0 || result) this.purityMemo.set(ref.key, result);
    return result;
  }

  /**
   * Layer suggestions from cached data only (class infos, already analysed calls and type uses):
   * no adapter requests, so no runtime cost beyond a small in-memory pass.
   */
  private annotateLayerHints(build: BuildResult): void {
    const ctx = this.hintContext(build);
    const memo = new Map<string, LayerHint | undefined>();
    for (const p of build.participants) {
      if (!memo.has(p.classKey)) {
        // every participant of a build has its meta
        const ref = build.participantMeta.get(p.id)!.ref;
        memo.set(p.classKey, ctx.hint(ref, p.layer));
      }
      const hint = memo.get(p.classKey);
      if (hint) p.layerHint = hint;
      else delete p.layerHint;
    }
    // FR-7.8 the dependency-rule violations each object takes part in (as the class diagram's relations)
    const ring = (layer: string | undefined) => (layer ? this.classifier.layerRing?.(layer) : undefined);
    const byId = new Map(build.participants.map((p) => [p.id, p]));
    const violations = new Map<string, Set<string>>();
    const note = (id: string, text: string) => violations.set(id, (violations.get(id) ?? new Set()).add(text));
    const messageById = new Map(build.messages.map((m) => [m.id, m]));
    for (const m of build.messages) {
      // FR-1.13 a function handed in with an inline type: the sender depends on its own parameter only, the writer of a
      // method reference on the method's class (FR-19.18, as the class diagram)
      const inline = m.viaParameter !== undefined && !m.port;
      const a = inline ? methodGroupWriter(m, (id) => messageById.get(id), (id) => byId.get(id)) : m.from ? byId.get(m.from) : undefined;
      const b = byId.get(m.to);
      if (!a || !b || a.classKey === b.classKey) continue;
      // through an interface (a chosen implementation, a function port): the caller depends on the abstraction,
      // as in the class diagram — its own layer decides, not the implementation's
      const via = m.port?.key ?? b.implementsInterface?.key;
      const viaName = m.port?.name ?? b.implementsInterface?.name ?? '';
      const target = via ? { ...this.classifier.classify({ key: via, name: viaName, kind: 'interface' }, undefined), className: viaName } : b;
      const ra = ring(a.layer);
      const rb = ring(target.layer);
      if (ra === undefined || rb === undefined || rb <= ra) continue;
      // FR-7.16 resting on a guessed layer: only possible (as the class diagram's relation)
      const guessed = guessedLayers([{ ...a, name: a.className }, { ...target, name: target.className }]);
      const possible = guessed.length ? ` (possible: ${guessed.join('; ')})` : '';
      note(a.id, `depends on ${target.layer}: ${target.className}${possible}`);
      if (!via) note(b.id, `${a.layer} depends on it: ${a.className}${possible}`);
    }
    for (const p of build.participants) {
      const v = violations.get(p.id);
      if (v) p.layerViolations = [...v];
      else delete p.layerViolations;
    }
  }

  /** FR-12.12: hints for classes that are in the class diagram only because they are used. */
  private annotateUsedOnlyHints(build: BuildResult, diagram: ClassDiagram): void {
    const ctx = this.hintContext(build);
    for (const n of diagram.classes) {
      if (!n.usedOnly) continue;
      const hint = ctx.hint(this.cache.peekClassInfo(n.key)?.ref ?? { key: n.key, name: n.name, kind: n.kind }, n.layer);
      if (hint) n.layerHint = hint;
    }
  }

  /**
   * Shared inputs of the layer hints of one build: known types by name, and which Domain
   * classes of the diagram use each class (visible calls / creations, cached type uses).
   */
  /** Known project types by name, rebuilt only when the cache knows new ones (else twice per build of a long scan). */
  private typeByName(): Map<string, ClassRef> {
    const known = this.cache.knownClassRefs();
    if (this.typesByName?.known !== known) {
      const byName = new Map<string, ClassRef>();
      for (const ref of known) byName.set(cutFrom(ref.name, '<'), ref);
      this.typesByName = { known, byName };
    }
    return this.typesByName.byName;
  }
  private typesByName: { known: ClassRef[]; byName: Map<string, ClassRef> } | undefined;

  private hintContext(build: BuildResult): { hint(ref: ClassRef, layer: string | undefined): LayerHint | undefined } {
    const typeByName = this.typeByName();
    const classify = (ref: ClassRef) => this.cache.peekClassify(ref);
    const byId = new Map(build.participants.map((p) => [p.id, p]));
    const usedBy = new Map<string, Set<string>>();
    const note = (from: { key: string; name: string; layer?: string }, to: string) => {
      if (from.layer !== 'Domain' || from.key === to) return;
      let set = usedBy.get(to);
      if (!set) usedBy.set(to, (set = new Set()));
      set.add(from.name);
    };
    const domainClasses = new Map<string, { key: string; name: string; layer?: string }>();
    for (const p of build.participants) if (p.layer === 'Domain') domainClasses.set(p.classKey, { key: p.classKey, name: p.className, layer: p.layer });
    for (const m of build.messages) {
      const from = m.from ? byId.get(m.from) : undefined;
      const to = byId.get(m.to);
      if (from && to) note({ key: from.classKey, name: from.className, layer: from.layer }, to.classKey);
    }
    for (const d of domainClasses.values()) for (const u of this.cache.typeUsesOfClass(d.key)) note(d, u.type.key);
    return {
      hint: (ref, layer) => {
        // FR-7.11 silenced in .seqcall.json (`layerHints.ignore`)
        const rel = ref.key.includes('#') && !ref.key.startsWith('lib:') ? ref.key.slice(0, ref.key.indexOf('#')) : undefined;
        if (rel && this.classifier.layerHintIgnored?.(rel)) return undefined;
        const { calls, analysedMethods } = this.cache.callsOfClass(ref.key);
        return suggestLayer({
          ref,
          layer,
          info: this.cache.peekClassInfo(ref.key),
          calls,
          analysedMethods,
          component: !!this.cache.peekModuleFacts(ref.key)?.jsx,
          classify,
          typeByName,
          typeUses: this.cache.typeUsesOfClass(ref.key).map((u) => u.type),
          usedByDomain: [...(usedBy.get(ref.key) ?? [])],
          purity: this.purityMemo.get(ref.key),
          activeRecord: this.isActiveRecord(ref.key),
        });
      },
    };
  }

  private async nodes(): Promise<BuildResult['nodes']> {
    return (this.lastBuild ?? (await this.build()))?.nodes ?? new Map();
  }

  /**
   * FR-24.6 the flow at the merge base, expanded like this one: calls only today's flow makes are `added`, calls
   * only the base flow made come back as ghosts (`removed`) with the participants only they reach.
   */
  private async compareWithBase(state: ViewState, build: BuildResult, diagram: Pick<SequenceDiagram, 'messages' | 'participants' | 'groups'>): Promise<FlowDiff | undefined> {
    const diff = (await this.flowDiff(state, build))?.diff;
    if (!diff) return undefined;
    const byId = new Map(build.messages.map((m) => [m.id, m]));
    for (const m of build.messages) {
      const before = diff.retargeted.get(m.id);
      // FR-24.15 the calls of a method the branch added, reached by a new call, are new too (parents come first)
      const parent = m.parentId ? byId.get(m.parentId) : undefined;
      if (parent?.diff?.status === 'added' && parent.diff.method === 'added') diff.added.add(m.id);
      if (diff.added.has(m.id)) m.diff = { ...m.diff, status: 'added' };
      else if (before !== undefined) {
        // FR-24.15 the same class's method (or the interface's), only the signature changed: no "was" of itself
        const reached = m.methodKey?.includes('#') ? cutFrom(m.methodKey.slice(m.methodKey.indexOf('#') + 1), '(') : undefined;
        // (a built message always names its class: the target's, else «unknown»)
        const same = before === reached || before === `${m.className}.${m.methodName}`;
        const { before: _was, ...rest } = m.diff ?? {};
        m.diff = same ? { ...rest, status: 'changed', signature: true } : { ...m.diff, status: 'changed', before };
      } else if (m.diff?.call) m.diff = { ...m.diff, status: 'changed' };
    }
    // FR-24.15 a new object: one the base flow does not have, reached by a new call (not one below a call the base
    // flow did not open the same way — a call moved into a new method)
    const reachedNew = new Set(build.messages.filter((m) => m.diff?.status === 'added').map((m) => m.to));
    for (const p of build.participants) if (diff.addedParticipants.has(p.id) && reachedNew.has(p.id)) p.diff = 'added';
    diagram.messages = mergeRemoved(build.messages, diff.removed);
    if (diff.removedParticipants.length) {
      const participants = [...build.participants];
      for (const p of diff.removedParticipants) {
        // next to its group's participants, else at the end
        let at = -1;
        participants.forEach((x, i) => {
          if (x.groupId === p.groupId) at = i;
        });
        participants.splice(at < 0 ? participants.length : at + 1, 0, p);
      }
      diagram.participants = participants;
      diagram.groups = [...build.groups, ...diff.removedGroups];
    }
    return diff;
  }

  /** FR-24.6 the flow compared with its base version (undefined: no review with a base, or a new root method). */
  private async flowDiff(state: ViewState, build: BuildResult): Promise<{ diff: FlowDiff; baseMeta: BuildResult['participantMeta'] } | undefined> {
    const base = this.base;
    if (!base || !this.reviewMarks || this.options.showReviewMarks === false) return undefined;
    // a renamed file: its methods at the old path in the base version (review marks and the git diff are set together)
    const renames = new Map(this.reviewGit!.files.flatMap((f) => (f.from ? [[f.from, f.file] as const] : [])));
    const back = new Map([...renames].map(([from, to]) => [to, from]));
    const root = await base.adapter.getMethod(movedKey(state.root.key, back)).catch(() => undefined);
    if (!root) return undefined; // the root method is new: its mark says so
    let baseMeta: BuildResult['participantMeta'] = new Map();
    // the same DI facts as today's build (the container step, bindings): else its participants show as new
    const context = await this.buildContext(state);
    const diff = await diffFlow({
      current: build,
      choices: state.choices,
      sameCall: (cur, old) => this.sameCall(cur, old),
      renames,
      buildBase: async (expanded, choices) => {
        const b = await base.cache.resolve(() =>
          buildDiagram({
            // FR-3.12 the error branches folded and shown as in today's build
            state: { root, expanded, choices, shownErrorPaths: state.shownErrorPaths },
            cache: base.cache,
            classifier: this.classifier,
            filters: this.filters,
            options: { ...this.options, foldErrors: build.foldErrors },
            interfaceChoices: this.interfaceChoices,
            ...context,
            autoSelectSingleImplementation: this.autoSelect,
            maxMessages: MAX_RENDER_MESSAGES,
          }),
        );
        baseMeta = b.participantMeta;
        return b;
      },
    }).catch(() => undefined);
    return diff ? { diff, baseMeta } : undefined;
  }

  /** The class diagram of a flow (of the build, or of `flow` — the build with the base version's removed calls). */
  private deriveClasses(build: BuildResult, flow: Pick<BuildResult, 'participants' | 'messages' | 'participantMeta'> = build): ClassDiagram {
    const withUses = this.options.showTypeUses === true;
    const hiddenClasses = new Set(this.filters.flatMap((f) => (f.kind === 'class' && !f.noExpand ? [f.classKey] : [])));
    // FR-11.8 a hidden category's classes (not in the flow: their calls are hidden) stay out when a type use names them
    const categories = this.filters.filter((f) => !f.noExpand && (f.kind === 'classPattern' || f.kind === 'stereotype'));
    const classifyRef = (ref: ClassRef) => this.cache.classify(this.cache.classInfo(ref.key)?.ref ?? ref, {});
    const typeUses = withUses ? this.typeUsesOf(build) : undefined;
    // type uses are evidence for layer hints (FR-7.4): recompute from the now cached data
    if (withUses) this.annotateLayerHints(build);
    const diagram = deriveClassDiagram({
      participants: flow.participants,
      messages: flow.messages,
      participantMeta: flow.participantMeta,
      classInfo: (key) => this.cache.classInfo(key),
      classify: (key) => {
        // a type alias (a function-typed port, FR-1.13) has no class info: classify it by its path
        const ref = this.cache.classInfo(key)?.ref ?? { key, name: key.slice(key.indexOf('#') + 1), kind: 'interface' as const };
        return this.cache.classify(ref, {});
      },
      classifyRef,
      isHiddenClass: (key, ref) => hiddenClasses.has(key) || categories.some((f) => classInCategory(f, ref.name, classifyRef(ref).stereotypes)),
      layerOrder: this.classifier.layerOrder(),
      layerRing: this.classifier.layerRing ? (l) => this.classifier.layerRing!(l) : undefined,
      associationNames: this.classifier.associationNames?.(),
      typeUses,
    });
    if (withUses) this.annotateUsedOnlyHints(build, diagram);
    return diagram;
  }

  /**
   * FR-19.17 the issues of a flow, one list for both diagrams: its layer violations (always, as the class diagram's red
   * relations) and its design findings (flow and class checks, unless switched off) — each with the evidence of both
   * diagrams: messages for the sequence diagram, classes and relations for the class diagram.
   */
  private async issuesOf(build: BuildResult): Promise<Finding[]> {
    const findings = this.options.showFindings !== false;
    if (findings) await this.prefetchSizes(build);
    const cd = withoutTypeUses(await this.cache.resolve(() => this.deriveClasses(build)));
    const out: Finding[] = layerViolationFindings(cd.classes, cd.relations);
    if (!findings) return out;
    const cfg = this.classifier.findingsConfig?.();
    const localFunctions = (key: string) => !!this.cache.classInfo(key)?.localFunctions;
    const ignored = ignoreMatcher(cfg?.ignore);
    const disabled = new Set(cfg?.disable ?? []);
    // loops over a collection (foreach / for…of / each-callbacks: guard "each x of xs"); polling and retry
    // `while` loops repeat I/O by design and are no N+1
    // `return await save(x)` inside the loop runs once (FR-19.1 leavesLoop)
    const inLoop = new Set([...build.nodes.values()].filter((n) => n.call?.fragments?.some((f) => f.kind === 'loop' && !f.leavesLoop && /^each\b/.test(f.guard ?? ''))).map((n) => n.id));
    // calls in a branch that runs only while a field is unset (lazy load / memoized cache): their I/O runs once
    const loadOnce = new Set([...build.nodes.values()].filter((n) => n.call?.fragments?.some((f) => (f.kind === 'opt' || f.kind === 'alt') && isLoadOnceGuard(f.guard))).map((n) => n.id));
    // FR-1.20 calls in a JSX handler (scope `jsx@…`) that is inside the loop of their body, or with no loop: on a user action
    const onAction = new Set([...build.nodes.values()].filter((n) => {
      const scopes = n.call?.fragments ?? [];
      const last = (test: (f: FragmentScope) => boolean) => scopes.reduce((at, f, i) => (test(f) ? i : at), -1);
      const handler = last((f) => f.id.startsWith('jsx@'));
      return handler >= 0 && handler > last((f) => f.kind === 'loop' && /^each\b/.test(f.guard ?? ''));
    }).map((n) => n.id));
    const flow = flowFindings({
      messages: build.messages,
      participants: build.participants,
      inLoop,
      loadOnce,
      onAction,
      activeRecord: (key) => this.isActiveRecord(key),
      localFunctions,
      ignored,
      disabled,
    });
    const byMessage = new Map(build.messages.map((m) => [m.id, m]));
    const classLevel = classFindings({
      classes: cd.classes,
      relations: cd.relations,
      // injected collaborators with a class type, library services (logger, HTTP client …) included
      injected: (key) => (this.cache.classInfo(key)?.fields ?? []).filter((f) => f.injected && f.type && f.type.kind !== 'unknown').map((f) => f.type!.name),
      maxDependencies: typeof cfg?.maxDependencies === 'number' ? cfg.maxDependencies : undefined,
      size: (key) => this.classSize(key, cfg?.godClass?.models === true),
      godClass: Object.fromEntries(Object.entries(cfg?.godClass ?? {}).filter(([k, v]) => k !== 'models' && typeof v === 'number' && v > 0)),
      ignored,
      callbackOnly: (r) => !!r.calls?.length && r.calls.every((c) => byMessage.get(c.messageId)?.viaParameter !== undefined),
      localFunctions,
      disabled,
    });
    out.push(...mergeCycles(flow.map((f) => withClassEvidence(f, cd.classes, cd.relations)), classLevel.map((f) => withMessageEvidence(f, cd.relations))));
    return out;
  }

  private async render(): Promise<SequenceDiagram | undefined> {
    this.renderGeneration++;
    const state = this.state;
    if (!state) {
      this.lastDiagram = undefined;
      return undefined;
    }
    // a build is undefined only without a state
    const build = (await this.build())!;
    if (state.smart) {
      const importance = this.importanceOf(build);
      for (const m of build.messages) {
        const imp = importance.get(m.id);
        if (imp) m.importance = { score: imp.score, reasons: imp.reasons, low: imp.low };
      }
    }
    this.lastDiagram = {
      root: state.root,
      participants: build.participants,
      groups: build.groups,
      messages: build.messages,
      hiddenFilters: build.hiddenFilters,
      options: { ...this.options },
      canGoBack: this.index > 0,
      layerChoices: this.classifier.layerOrder(),
      canGoForward: this.index < this.history.length - 1,
      ...(this.options.showFragments !== false ? { fragments: build.fragments, ...(build.exits.length ? { exits: build.exits } : {}) } : {}),
    };
    const entries = this.rootEntryPoints(state);
    if (entries.length) this.lastDiagram.entryPoints = entries;
    if (this.borrowed) this.lastDiagram.borrowedConfig = { ...this.borrowed };
    // FR-24.4 the reviewed branch's changes: calls on changed lines, methods added / changed (View ▾ Show changes)
    if (this.reviewMarks && this.options.showReviewMarks !== false) {
      this.markChangedLines(build, this.reviewMarks);
      const flowDiff = await this.compareWithBase(state, build, this.lastDiagram);
      // FR-24.11 what the branch did to each object's class (new / changed members)
      for (const p of this.lastDiagram.participants) {
        if (p.diff === 'removed') continue;
        const change = await this.classChange(p.classKey);
        if (change) p.change = change;
      }
      // FR-24.15 the flow's changes as one fixed list, placed in this view: drawn, below a collapsed call, or in
      // another implementation — the counts add up to the same total whatever is expanded, chosen or zoomed
      const flow = await this.flowChanges(state);
      this.lastPlaced = flow ? placeChanges(flow, { messages: this.lastDiagram.messages, implOf: (id) => build.nodes.get(id)?.effective?.owner.key }) : undefined;
      if (this.lastPlaced) {
        for (const m of this.lastDiagram.messages) {
          const at = this.lastPlaced.at.get(m.id);
          if (!at && !hasOwnChange(m)) continue;
          const impls = build.nodes.get(m.id)?.implementations ?? [];
          // (another implementation of this interface call: one of its implementations, as flow-changes chooses them)
          /* v8 ignore start -- what another module guarantees (see the comment); kept as a fallback: if that ever changes, a worse answer instead of a crash */
          const elsewhere = [...(at?.elsewhere ?? [])].map(([classKey, count]) => ({ classKey, className: impls.find((i) => i.owner.key === classKey)?.owner.name ?? classKey.slice(classKey.lastIndexOf('#') + 1), count }));
          /* v8 ignore stop */
          const { inside: _inside, ...rest } = m.diff ?? {};
          const count = (at?.own ?? 0) + (at?.inside ?? 0) + elsewhere.reduce((n, e) => n + e.count, 0);
          m.diff = { ...rest, count, ...(at?.inside ? { inside: at.inside } : {}), ...(elsewhere.length ? { elsewhere } : {}), ...(at?.positions.length ? { positions: at.positions } : {}), ...(at?.held.length ? { held: at.held } : {}) };
        }
        this.lastDiagram.reviewTotal = this.lastPlaced.total;
      } else {
        // FR-24.9 collapsed calls with changed methods below them (on the review's paths)
        const below = this.changesBelow();
        for (const m of this.lastDiagram.messages) {
          const node = m.expanded ? undefined : build.nodes.get(m.id);
          const n = node ? this.changesUnder(node, below).size : 0;
          if (n) m.diff = { ...m.diff, inside: n };
        }
      }
      // FR-24.7 the diff lines around each marked call (a removed call: in the base version)
      await this.prefetchBaseTexts(this.lastDiagram.messages);
      for (const m of this.lastDiagram.messages) {
        if (!m.diff?.status && !m.diff?.call) continue;
        const at = this.diffPlace(m, { baseSite: flowDiff?.baseSites.get(m.id), messages: this.lastDiagram.messages });
        if (at?.hunk) m.diff = { ...m.diff, hunk: at.hunk };
      }
    }
    // FR-19.17 the flow's issues (layer violations, design findings), the same list as the class diagram's
    const issues = await this.issuesOf(build);
    if (issues.length) this.lastDiagram.findings = issues;
    const below = this.issuesBelow(issues);
    if (below) this.lastDiagram.issuesBelow = below;
    const outcome = this.outcomeShown(this.lastDiagram);
    if (outcome) this.lastDiagram.outcome = outcome;
    const ignored = this.ignoredPatterns();
    if (ignored) this.lastDiagram.ignored = ignored;
    if (this.pendingNotice) this.lastDiagram.expandNotice = this.pendingNotice;
    this.pendingNotice = undefined;
    // FR-28 layer zoom: the flow one level up, a projection of everything computed above (ids stay the call paths)
    this.lastFolded = new Map();
    // FR-28.11 in the object view only the folded layers fold (none: the diagram as built), and each band can fold its layer
    const fold = this.layerFold();
    if (fold) {
      const zoomed = projectLayers(this.lastDiagram, fold.open, new Set(this.options.openObjects), fold.folded);
      this.lastFolded = zoomed.folded;
      this.lastDiagram = zoomed.diagram;
    }
    if (!this.options.layerZoom) this.lastDiagram = markFoldableBands(this.lastDiagram);
    return this.lastDiagram;
  }
}

function toFilter(spec: HideFilterSpec): HideFilter {
  // FR-11.7 a "don't expand" rule: the same target, its own id
  const p = spec.noExpand ? 'noExpand:' : '';
  switch (spec.kind) {
    case 'methodName':
      return { id: `${p}methodName:${spec.methodName}`, ...spec };
    case 'classMethod':
      return { id: `${p}classMethod:${spec.classKey}.${spec.methodName}`, ...spec };
    case 'class':
      return { id: `${p}class:${spec.classKey}`, ...spec };
    case 'classPattern':
      return { id: `${p}classPattern:${spec.pattern}`, ...spec };
    case 'stereotype':
      return { id: `${p}stereotype:${spec.stereotype}`, ...spec };
  }
}

/** The target of a filter rule, whichever it does (hide / don't expand). */
function filterTarget(id: string): string {
  return id.replace(/^noExpand:/, '');
}

/**
 * The call at `range`: the exact range first — chained calls (`Db.get().query()`) start at the same
 * position — else the first call starting there (an adapter may report a slightly different end).
 */
function callAt(calls: CallSite[], range: SourceRange): CallSite | undefined {
  const starts = (c: CallSite) => c.range.file === range.file && c.range.start.line === range.start.line && c.range.start.character === range.start.character;
  return calls.find((c) => starts(c) && c.range.end.line === range.end.line && c.range.end.character === range.end.character) ?? calls.find(starts);
}

/**
 * FR-19.1 a guard that tests whether a field is still unset — the branch fills a cache / loads lazily, so
 * what runs inside runs once: `!self::$loaded`, `!isset(static::$cache[$k])`, `empty($this->rates)`,
 * `$this->client === null`, `is_null(self::$x)`, `!this.cache`, `this.x == undefined`, `_client is null`,
 * `!_loaded`. A field tested positively (`$this->debug`) is a switch, not a cache.
 */
export function isLoadOnceGuard(guard: string | undefined): boolean {
  if (!guard) return false;
  const field = String.raw`(?:(?:self|static|parent)::\$\w+|\$this->\w+|this\.\w+|\b[A-Z]\w*\.\w+|\b_\w+)`;
  const negated = new RegExp(String.raw`(?:^|[^\w$])(?:!\s*|!\s*isset\(\s*|empty\(\s*|is_null\(\s*)${field}`);
  const nullTest = new RegExp(String.raw`${field}(?:\[[^\]]*\])?\s*(?:===?|is)\s*(?:null|undefined)\b`);
  return negated.test(guard) || nullTest.test(guard);
}

/**
 * FR-17 / FR-11 the calls in an expanded message's body that are not drawn under it — hidden by a rule, or
 * library calls while they are off — by the message's id (from the drawn children's `<parent>/<ordinal>:…` ids).
 */
function notDrawnCalls(build: BuildResult, outgoing: (m: MethodRef) => CallSite[] | undefined): (messageId: string) => CallSite[] {
  const drawn = new Map<string, Set<number>>();
  for (const m of build.messages) {
    if (!m.parentId) continue;
    // a message id is `<parent>/<ordinal>:<name>`
    const ordinal = Number(m.id.slice(m.parentId.length + 1).split(':')[0]);
    drawn.set(m.parentId, (drawn.get(m.parentId) ?? new Set()).add(ordinal));
  }
  return (messageId) => {
    // an opened closure (FR-1.11) has no method of its own: its calls are all drawn
    const effective = build.nodes.get(messageId)?.effective;
    if (!effective) return [];
    const shown = drawn.get(messageId) ?? new Set<number>();
    // asked for expanded calls only: their bodies were read to draw them
    return outgoing(effective)!.filter((c) => !shown.has(c.ordinal));
  };
}


// ───────────── FR-26 / FR-19.9 entry-point scans ─────────────

/** An entry point's identity across scans (the same method can be several entry points). */
function entryKey(e: EntryPoint): string {
  return appMapEntryKey(e);
}

/** FR-26.8 how a selection names an entry point (the views build the same key). */
export function appMapEntryKey(e: EntryPoint): string {
  return `${e.kind}|${e.label}|${e.method.key}`;
}

/**
 * FR-26.2 one method's direct calls (its classes and relations), shared by the entry points that reach
 * it: an implementation behind an interface call with several, or a call the expand limit left folded.
 */
interface SubFlow {
  classes: ClassNode[];
  relations: ClassRelation[];
  /** Where it stops in turn (followed too). */
  next: FollowUp[];
}

/** A call a flow stopped at: an interface call with several implementations and none chosen, or a folded call. */
interface FollowUp {
  methodKey: string;
  /** Set for an interface call: its implementations are followed, each drawn realizing it. */
  interfaceKey?: string;
}

/** FR-26.2 methods newly opened per entry point (others come from the shared memo; bounds the cost of one entry point). */
const MAX_SUB_FLOWS = 400;
/** FR-26.2 method flows merged into one entry point at most (memo hits included). */
const MAX_FOLLOWED = 4000;

/** Class data the map keeps: no flow-specific message ids, no per-render marks. */
function mapClass(c: ClassNode): ClassNode {
  return {
    key: c.key,
    name: c.name,
    kind: c.kind,
    stereotypes: c.stereotypes,
    ...(c.layer ? { layer: c.layer } : {}),
    namespace: c.namespace,
    methods: c.methods.map((m) => ({ name: m.name, isStatic: m.isStatic, signature: m.signature, ...(m.declaration ? { declaration: m.declaration } : {}) })),
    ...(c.declaration ? { declaration: c.declaration } : {}),
    ...(c.layerReason ? { layerReason: c.layerReason } : {}),
    // FR-29.11 which stereotypes only this flow gives (`inThisDiagram`): a review compares the others
    ...(c.stereotypeReasons?.length ? { stereotypeReasons: c.stereotypeReasons } : {}),
  };
}

function mapRelation(r: ClassRelation): ClassRelation {
  return {
    id: r.id,
    kind: r.kind,
    from: r.from,
    to: r.to,
    ...(r.label ? { label: r.label } : {}),
    ...(r.labelObvious ? { labelObvious: true } : {}),
    ...(r.violation ? { violation: r.violation } : {}),
    ...(r.possible ? { possible: r.possible } : {}),
    ...(r.aggregation ? { aggregation: true, multiplicity: r.multiplicity } : {}),
    // a relation's calls are drawn messages: each has its place in the code
    calls: (r.calls ?? []).map((c) => ({ messageId: '', label: c.label, callSite: c.callSite })),
  };
}

/** Where a flow stops (FR-26.2): interface calls with several implementations and none chosen, calls left folded. */
function followUps(d: SequenceDiagram): FollowUp[] {
  return d.messages.flatMap((m): FollowUp[] => {
    if (!m.methodKey) return [];
    if (m.polymorphic && m.polymorphic.implementations.length > 1 && !m.polymorphic.selectedKey) return [{ methodKey: m.methodKey, interfaceKey: m.polymorphic.interfaceKey }];
    return m.expandable && !m.expanded ? [{ methodKey: m.methodKey }] : [];
  });
}

/** One entry point: its flow expanded fully, I/O scanned, its findings, classes and relations, where it stops (FR-19.9, FR-26.1). */
async function scanEntryPoint(scan: DiagramSession, adapter: LanguageAdapter, e: EntryPoint): Promise<EntryPointScan> {
  const result: EntryPointScan = { entry: e, files: new Set(), classes: [], relations: [], findings: [], truncated: false };
  try {
    if (!(await scan.openMethodByKey(e.method.key, e.unreached ? undefined : e))) return { ...result, failed: true };
    await scan.expandEverything();
    await scan.scanSideEffects();
    // opened: a diagram and its class diagram
    const d = scan.current()!;
    const cd = (await scan.getClassDiagram())!;
    // FR-19.17 both diagrams carry the same issues, layer violations included (as the flow's ⚠, the map and Review)
    for (const f of d.findings ?? []) {
      // FR-19.9 the classes of the evidence: named ones, and the senders / receivers of its messages (messages and
      // participants of this diagram; the found message has no sender)
      const classKeys = new Set(f.classKeys ?? []);
      for (const id of f.messageIds ?? []) {
        const m = d.messages.find((x) => x.id === id)!;
        for (const pid of [m.from, m.to]) if (pid) classKeys.add(d.participants.find((x) => x.id === pid)!.classKey);
      }
      result.findings.push({ finding: f, classKeys: [...classKeys] });
    }
    result.classes.push(...cd.classes.map(mapClass));
    result.relations.push(...cd.relations.map(mapRelation));
    result.outcome = scan.flowOutcome();
    result.pending = followUps(d);
    result.truncated = result.pending.some((f) => !f.interfaceKey);
  } catch {
    result.failed = true;
  }
  addFiles(result);
  return result;
}

function addFiles(result: EntryPointScan): void {
  for (const c of result.classes) {
    const file = fileOfClassKey(c.key);
    if (file) result.files.add(file);
  }
}

/**
 * FR-26.2 where an entry point's flow stopped — interface calls with several implementations and none
 * chosen, calls the expand limit left folded — the methods behind it are opened (one level: their own
 * calls are followed in turn, each method once, shared between entry points) and their classes and
 * relations added; the implementations are drawn realizing the interface.
 */
async function followStops(scan: DiagramSession, adapter: LanguageAdapter, result: EntryPointScan, subFlows: Map<string, SubFlow>): Promise<void> {
  // called for a scan with stops only
  const queue: FollowUp[] = [...result.pending!];
  result.truncated = false;
  try {
    const seen = new Set<string>();
    let fresh = 0;
    let merged = 0;
    const follow = async (methodKey: string): Promise<SubFlow | undefined> => {
      const known = subFlows.get(methodKey);
      if (known) return known;
      if (fresh >= MAX_SUB_FLOWS) return undefined;
      fresh++;
      let flow: SubFlow = { classes: [], relations: [], next: [] };
      try {
        // one level is enough: every call it makes is followed in turn (each method once, shared)
        if (await scan.openMethodByKey(methodKey)) {
          // opened: a diagram and its class diagram
          const scd = (await scan.getClassDiagram())!;
          flow = { classes: scd.classes.map(mapClass), relations: scd.relations.map(mapRelation), next: followUps(scan.current()!) };
        }
      } catch {
        // a method that cannot be analysed is left out
      }
      subFlows.set(methodKey, flow);
      return flow;
    };
    while (queue.length && merged < MAX_FOLLOWED) {
      const call = queue.shift()!;
      let targets: { key: string; owner?: string }[] = [{ key: call.methodKey }];
      if (call.interfaceKey) {
        const method = await adapter.getMethod(call.methodKey);
        targets = method ? (await adapter.getImplementations(method)).map((m) => ({ key: m.key, owner: m.owner.key })) : [];
      }
      for (const t of targets) {
        if (seen.has(t.key)) continue;
        const flow = await follow(t.key);
        if (!flow) {
          result.truncated = true; // more to follow than this entry point may expand
          continue;
        }
        seen.add(t.key);
        merged++;
        result.classes.push(...flow.classes);
        result.relations.push(...flow.relations);
        queue.push(...flow.next);
        if (t.owner && call.interfaceKey) result.relations.push({ id: `impl:${t.owner}`, kind: 'realization', from: t.owner, to: call.interfaceKey, calls: [] });
      }
    }
    if (queue.length) result.truncated = true;
  } catch {
    result.truncated = true;
  }
  result.pending = undefined;
  addFiles(result);
}

/** FR-25.2 what a diagram shows, to compare the sender's with the receiver's (removed ghosts of a review not counted). */
function seenOf(d: SequenceDiagram): { messages: number; participants: number } {
  return { messages: d.messages.filter((m) => m.diff?.status !== 'removed').length, participants: d.participants.filter((p) => p.diff !== 'removed').length };
}
