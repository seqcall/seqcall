/** Class diagram view controller (FR-12). */
import { categoryMenu } from '../hide-category';
import { backgroundOf, blobToBase64, copyPng, download, hostSaves, imageName, standaloneSvg, svgToPng } from '../export-image';
import type { AppMapLevel, AppMapViolation, BorrowedConfig, ClassDiagram, ClassMember, ClassRelation, ClassNode, ClassViewToHost, DiagramOptions, Finding, HiddenFilterInfo, HideFilterSpec, HostToClassView, RelationCall } from '@seqcall/protocol';
import { PopupLayer, type MenuItem } from '../menu';
import { formatLocation } from '../sequence/labels';
import { filtersMenu, noExpand } from '../filters-menu';
import type { HostBridge } from '../bridge';
import { closestWithData, FLASH_MS, html, revealElements } from '../dom';
import { findingCard, violationCard, type ViolationSide } from '../finding-guide';
import { classDiagramMarks } from '../finding-marks';
import { issuesButton, issuesMenu, updateIssuesButton } from '../issues-ui';
import { markItems } from '../view-options';
import { changedClasses, classReviewBar } from './review-steps';
import { createCanvasMeasure, type MeasureText } from '../measure';
import { CLASS_LAYOUT, layoutClassDiagram, type ClassGeometry, type ClassPositions, type MethodDisplay } from './layout';
import { renderClassDiagram } from './render';
import { installDiagnostics } from '../diagnostics';
import { layerHintMenu, layerMenuItems } from '../layer-hint';
import { layerReasonCard, whyLabel } from '../layer-reason';
import { LayerScopeChooser } from '../layer-scope';
import { EDGE_STYLES, type EdgeStyle } from './edges';
import { observeCompact } from '../compact';
import { ClassFind } from './find';
import { bindFindKeys } from '../find-bar';
import { borrowedConfigBar, CONFIG_WRITES, onDiagramState, pasteStateCard, shareIcon, SHARE_TITLE, stateMenuItems, writeBlockedCard } from '../sequence/share-state';

const CLASS_VIEW_TITLE = 'View options: layer lanes, type uses, edge style';
/** FR-14.3: icons only below this toolbar width. */
const CLASS_COMPACT_BELOW = 640;
import { assembleElk, elkAutoLayout, routingFor, type ElkAutoResult, type ElkRouting } from './elk';
import { layerClass, openLayerCount, sortLayers } from '../layers';
import { CLICK_SLOP, enablePan } from '../pan';
import { clampZoom, fitWidthZoom, scaleSvg, scrollForZoom, stepZoom, wheelZoomFactor, ZoomControls, type ZoomCommand } from '../zoom';
import { cutFrom } from '../text';

export type ClassBridge = HostBridge<HostToClassView, ClassViewToHost>;

export const CLASS_EMPTY_TEXT = 'Open a sequence diagram to see the classes involved';

interface SavedState {
  diagram?: ClassDiagram;
  positions?: ClassPositions;
  zoom?: number;
  lanes?: boolean;
  /** The developer toggled Layers (FR-12.7); otherwise the default (on) applies. */
  lanesChosen?: boolean;
  edgeStyle?: EdgeStyle;
  /** Classes expanded to all their methods (FR-12.11). */
  expandedMethods?: string[];
  /** FR-12.18 classes whose private / protected methods are shown. */
  privateShown?: string[];
  /** FR-19.10 the reader folded the finding card last time: the next one opens folded. */
  findingCardFolded?: boolean;
  /** FR-26 the codebase map was shown, at this folder. */
  appPath?: string;
  /** FR-26.8 the map shows these entry points only. */
  appSelection?: string[];
  /** FR-26.7 packages open in place, per folder of the map. */
  appOpen?: Record<string, string[]>;
}

/** FR-26 the codebase map shown instead of the flow's classes. */
interface AppState {
  path: string;
  state: 'running' | 'done' | 'cancelled' | 'error';
  level?: AppMapLevel;
  done?: number;
  total?: number;
  error?: string;
}

export class ClassView {
  readonly scroll: HTMLElement;
  readonly canvas: HTMLElement;
  readonly placeholder: HTMLElement;
  /** FR-23.4 the find bar. */
  readonly find: ClassFind;
  readonly toolbar: HTMLElement;
  readonly zoomControls: ZoomControls;
  readonly relayoutButton: HTMLButtonElement;
  private readonly legend: HTMLElement;
  private readonly viewButton: HTMLButtonElement;
  /** FR-12.7: grouped by layer by default. */
  private lanes = true;
  private lanesChosen = false;
  private edgeStyle: EdgeStyle = 'curved';
  private focus = '';
  /** Layout engine: ELK (better routing, async) with dagre as synchronous fallback. */
  private engine: LayoutEngine;
  private elkCache?: { diagram: ClassDiagram; lanes: boolean; routing: ElkRouting; sizeKey: string; result: ElkAutoResult };
  private layoutToken = 0;
  private readonly hiddenButton: HTMLButtonElement;
  private readonly popups: PopupLayer;
  /** FR-7.12 Move to layer: what the rule covers (file / folder / name). */
  private readonly layerScope: LayerScopeChooser;
  private readonly issuesButton: HTMLButtonElement;
  private hiddenFilters: HiddenFilterInfo[] = [];
  /** the session's display options (for the marks of both diagrams in View ▾). */
  private options: DiagramOptions | undefined;
  private rootClassKey: string | undefined;
  private layerChoices: string[] = [];
  private maxMethods = 5;
  private expandedMethods = new Set<string>();
  /** FR-12.18 classes whose private / protected methods are shown (the rest list only their public ones). */
  private privateShown = new Set<string>();
  private shownCache: { source: ClassDiagram; key: string; diagram: ClassDiagram } | undefined;
  diagram: ClassDiagram | null = null;
  geometry: ClassGeometry | null = null;
  positions: ClassPositions = {};
  zoom = 1;
  private svgEl: SVGSVGElement | null = null;
  private drag: { key: string; startX: number; startY: number; cx: number; cy: number; moved: boolean } | null = null;
  private suppressClick = false;
  private readonly measure: MeasureText;
  /** FR-26 the codebase map (null: the flow's classes). */
  private app: AppState | null = null;
  /** FR-26.8 the map's entry points when only some were selected (`kind|label|methodKey`); undefined = all. */
  private appSelection: string[] | undefined;
  /** FR-26.7 packages open in place, per folder of the map. */
  private appOpen = new Map<string, Set<string>>();
  /** FR-26 the flow's last render (or empty) while the map is shown, and its positions. */
  private flowMsg: HostToClassView | null = null;
  private flowPositions: ClassPositions = {};
  private readonly appButton: HTMLButtonElement;
  /** FR-26 the map's breadcrumb, totals and Rescan (under the toolbar). */
  readonly appBar: HTMLElement;
  /** the changed classes of a review, stepped through (hidden without a review). */
  readonly reviewBarEl: HTMLElement;
  private reviewAt = -1;
  private reviewKeys = '';

  /** Messages to the host; FR-25.3 config writes are held back while a shared diagram's config is in use. */
  private readonly bridge: ClassBridge;
  /** FR-25.3 a shared diagram's layer config is in use (from the last render). */
  private borrowed: BorrowedConfig | undefined;
  readonly borrowEl: HTMLElement;
  private shareButton!: HTMLButtonElement;

  constructor(
    readonly root: HTMLElement,
    bridge: ClassBridge,
    opts: ClassViewOptions = {},
  ) {
    this.bridge = Object.create(bridge) as ClassBridge;
    this.bridge.post = (msg) => {
      if (CONFIG_WRITES.has(msg.type) && this.borrowed) {
        const r = this.root.getBoundingClientRect();
        this.popups.show(writeBlockedCard(() => this.useOwnConfig()), Math.max(8, r.left + 40), Math.max(8, r.top + 40));
        return;
      }
      bridge.post(msg);
    };
    this.measure = opts.measureText ?? createCanvasMeasure(root.ownerDocument);
    this.engine = opts.engine ?? (globalThis as { __SEQCALL_ENGINE?: LayoutEngine }).__SEQCALL_ENGINE ?? 'elk';
    root.classList.add('seqcall', 'seqcall-class');
    root.textContent = '';
    this.canvas = html('div', { class: 'class-canvas' });
    this.placeholder = html('div', { class: 'placeholder empty', role: 'status' }, [html('div', { class: 'placeholder-title' }, [CLASS_EMPTY_TEXT])]);
    this.scroll = html('div', { class: 'class-scroll' }, [this.canvas, this.placeholder]);
    this.zoomControls = new ZoomControls((cmd) => this.onZoomCommand(cmd), 'Fit the diagram width into the view (not below 60 %: scroll for the rest)');
    this.relayoutButton = html('button', { type: 'button', class: 'tb-btn', 'data-cmd': 'relayout', title: 'Drop manual positions and lay out again', 'aria-label': 'Re-layout' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, ['⟲']),
      html('span', { class: 'tb-label' }, ['Re-layout']),
    ]);
    this.relayoutButton.addEventListener('click', () => this.relayout());
    this.legend = html('div', { class: 'layer-legend', 'aria-label': 'Layers' });
    // FR-14.2: Layers, Uses and the edge style are view options in View ▾ (not buttons)
    this.viewButton = html('button', { type: 'button', class: 'tb-btn keep-label', 'data-cmd': 'view', title: CLASS_VIEW_TITLE, 'aria-label': 'View', 'aria-haspopup': 'menu' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, ['☷']),
      html('span', { class: 'tb-label' }, ['View']),
      html('span', { class: 'tb-dot', 'aria-hidden': 'true' }),
      html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, ['▾']),
    ]);
    this.viewButton.addEventListener('click', () => {
      const r = this.viewButton.getBoundingClientRect();
      this.popups.showMenu(this.viewMenu(), r.left, r.bottom + 2, 'view');
    });
    this.hiddenButton = html('button', { type: 'button', class: 'tb-btn', 'data-cmd': 'hidden', title: 'Filters: hidden classes and calls, calls not expanded (shared with the sequence diagram)', 'aria-label': 'Filters', 'aria-haspopup': 'menu' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, ['⊘']),
      html('span', { class: 'tb-label' }, ['Filters']),
      html('span', { class: 'tb-badge' }),
      html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, ['▾']),
    ]);
    this.hiddenButton.addEventListener('click', () => {
      const r = this.hiddenButton.getBoundingClientRect();
      this.popups.showMenu(this.hiddenMenu(), r.left, r.bottom + 2);
    });
    this.issuesButton = issuesButton();
    this.issuesButton.addEventListener('click', () => {
      const r = this.issuesButton.getBoundingClientRect();
      const menu = this.app ? issuesMenu(this.mapIssues(), (f) => this.showMapIssue(f)) : issuesMenu(this.diagram?.findings, (f) => this.showIssue(f), this.diagram?.typeUseViolations, this.diagram?.issuesBelow ? { issues: this.diagram.issuesBelow } : undefined, {
            patterns: this.diagram?.ignored,
            stop: (section, pattern) => this.bridge.post({ type: section === 'findings' ? 'unignoreFinding' : 'unignoreLayerHint', pattern }),
          });
      this.popups.showMenu(menu, r.left, r.bottom + 2);
    });
    const findButton = html('button', { type: 'button', class: 'tb-btn icon-only', 'data-cmd': 'find', title: 'Find a class or method (Ctrl+F or /)', 'aria-label': 'Find' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, ['⌕']),
    ]);
    findButton.addEventListener('click', () => this.find.open());
    // FR-25 the whole diagram as an image, FR-25.2 as text to reopen elsewhere
    const imageButton = html('button', { type: 'button', class: 'tb-btn', 'data-cmd': 'image', title: SHARE_TITLE, 'aria-label': 'Share', 'aria-haspopup': 'menu' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, [shareIcon()]),
      html('span', { class: 'tb-label' }, ['Share']),
      html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, ['▾']),
    ]);
    this.shareButton = imageButton;
    imageButton.addEventListener('click', () => {
      const r = imageButton.getBoundingClientRect();
      this.popups.showMenu(
        [
          { id: 'image:copy', label: 'Copy as image (PNG)', hint: 'paste into chat or a document', action: () => void this.copyImage(imageButton) },
          // FR-25.4 the classes of the shown flow as text (layers, methods, relations with their calls) — for an AI chat
          {
            id: 'text:copy',
            label: 'Copy as text',
            hint: 'the classes, for an AI chat',
            ...(this.app || !this.diagram ? { disabled: true, title: this.app ? 'The codebase map cannot be copied as text: go ← Flow' : 'No diagram to copy' } : { action: () => this.bridge.post({ type: 'copyText' }) }),
          },
          { id: 'image:png', label: 'Save as PNG…', action: () => void this.saveImage('png') },
          { id: 'image:svg', label: 'Save as SVG…', hint: 'sharp at any size', action: () => void this.saveImage('svg') },
          // the text is the flow's (the class diagram is derived from it); the codebase map is not part of it
          ...stateMenuItems(
            this.app || !this.diagram ? undefined : (save) => this.bridge.post({ type: 'copyState', ...(save ? { save } : {}) }),
            () => this.openStatePrompt(),
            this.app ? 'The codebase map cannot be shared as text: go ← Flow to share the flow' : !this.diagram ? 'No diagram to share' : undefined,
          ),
        ],
        r.left,
        r.bottom + 2,
      );
    });
    // FR-26 the classes of the whole codebase (every entry point's flow), folder by folder
    this.appButton = html('button', { type: 'button', class: 'tb-btn', 'data-cmd': 'app-map', title: 'Codebase map: the classes every entry point reaches, folder by folder', 'aria-label': 'Codebase map', 'aria-pressed': 'false' }, [
      html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, ['⛶']),
      html('span', { class: 'tb-label' }, ['Codebase']),
    ]);
    this.appButton.addEventListener('click', () => (this.app ? this.leaveApp() : this.enterApp('')));
    this.appBar = html('div', { class: 'app-bar', hidden: '' });
    this.borrowEl = html('div', { class: 'expand-notice borrowed-config', role: 'status', hidden: '' });
    this.reviewBarEl = html('div', { class: 'class-review', hidden: '' });
    this.appBar.addEventListener('click', (e) => this.onAppBarClick(e));
    this.toolbar = html('div', { class: 'toolbar', role: 'toolbar' }, [
      html('div', { class: 'toolbar-group' }, [this.appButton]),
      html('div', { class: 'toolbar-group' }, [this.relayoutButton, this.viewButton, this.issuesButton]),
      html('div', { class: 'toolbar-group' }, [findButton, this.hiddenButton, imageButton]),
      this.legend,
    ]);
    root.append(this.toolbar, this.borrowEl, this.reviewBarEl, this.appBar, this.scroll, this.zoomControls.element);
    this.bindReviewKeys(root.ownerDocument);
    observeCompact(this.toolbar, CLASS_COMPACT_BELOW);
    this.popups = new PopupLayer(root);
    this.layerScope = new LayerScopeChooser(this.popups, (m) => this.bridge.post(m));
    // FR-23.4 find bar (Ctrl+F, /, ⌕)
    this.find = new ClassFind({
      root,
      scroll: this.scroll,
      diagram: () => this.shown(),
      svg: () => this.svgEl,
      post: (msg) => this.bridge.post(msg),
    });
    bindFindKeys(root.ownerDocument, () => this.find.open());
    this.scroll.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.scroll.addEventListener('scroll', () => this.popups.closeOnViewChange());
    this.updateToolbar();
    this.scroll.addEventListener('click', (e) => this.onClick(e));
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    enablePan(this.scroll, { isDraggable: (t) => !!this.nodeAt(t) });
    this.canvas.addEventListener('mouseover', (e) => this.focusOn(e.target));
    this.canvas.addEventListener('mouseleave', () => this.focusOn(null));
    const win = root.ownerDocument.defaultView!;
    win.addEventListener('mousemove', (e) => this.onMouseMove(e));
    win.addEventListener('mouseup', () => this.onMouseUp());
  }

  handle(msg: HostToClassView): void {
    if (msg.type === 'render') this.renderBorrowed(msg.borrowedConfig);
    // FR-25.4 the text comes back like the state: copied by the host (VS Code) or here
    if (msg.type === 'diagramState' || msg.type === 'diagramText') return void onDiagramState(msg, { flash: (t) => this.flashShare(t), card: (el) => this.showCard(el, true) });
    if (msg.type === 'stateReport') {
      if (msg.error) this.showCard(html('div', { class: 'callers-panel layer-reason-card state-card', role: 'alert' }, [html('div', { class: 'callers-title' }, ['Could not open the shared diagram']), html('div', { class: 'lr-note' }, [msg.error])]));
      return;
    }
    if (msg.type === 'showAppMap') {
      // FR-26.8 another selection (or all again): its map starts at the top, nothing open
      const selection = msg.entryPoints?.length ? [...msg.entryPoints] : undefined;
      const changed = (selection ?? []).join('\n') !== (this.appSelection ?? []).join('\n');
      this.appSelection = selection;
      if (changed) this.appOpen.clear();
      return this.enterApp(changed ? '' : this.app?.path ?? '');
    }
    if (msg.type === 'appMap') return this.onAppMap(msg);
    // the flow's classes while the map is shown: kept for ← Flow
    if (this.app && (msg.type === 'render' || msg.type === 'empty' || msg.type === 'busy')) {
      if (msg.type === 'busy') return; // the map stays; the flow's classes come with the render after it
      this.flowMsg = msg;
      this.save();
      return;
    }
    if (msg.type === 'openFind') {
      this.find.open(msg.query);
      return;
    }
    if (msg.type === 'layerScopes') {
      this.layerScope.onScopes(msg.classKey, msg.scopes);
      return;
    }
    if (msg.type === 'focusClass') {
      this.focusedClass = msg.classKey;
      // not drawn yet (ELK lays out asynchronously): scrolled to when it is
      this.focusScrollPending = !this.applyFocusedClass(true);
      return;
    }
    if (msg.type === 'render') {
      this.hiddenFilters = msg.hiddenFilters ?? [];
      this.options = msg.options;
      this.rootClassKey = msg.rootClassKey;
      this.layerChoices = msg.layerChoices ?? [];
      this.maxMethods = msg.maxMethods ?? 5;
      // the View menu stays open across the re-render its own option (Uses) caused
      if (this.popups.openKey !== 'view') this.popups.closeOnViewChange();
      const before = this.diagram ? classSet(this.diagram) : '';
      this.diagram = msg.diagram;
      // Keep manual positions only for classes that are still present.
      const keys = new Set(msg.diagram.classes.map((c) => c.key));
      this.positions = Object.fromEntries(Object.entries(this.positions).filter(([k]) => keys.has(k)));
      this.save();
      this.render();
      // A different set of classes is a new picture: show its top-left corner.
      if (before !== classSet(msg.diagram)) this.scrollTo(0, 0);
    } else {
      this.diagram = null;
      this.geometry = null;
      this.svgEl = null;
      this.canvas.textContent = '';
      if (msg.type === 'busy') this.showPlaceholder(msg.text, true);
      else this.showPlaceholder(msg.reason || CLASS_EMPTY_TEXT);
      this.save();
      this.updateToolbar();
    }
  }

  restore(state: SavedState | undefined): void {
    if (!state) return;
    this.positions = state.positions ?? {};
    if (state.zoom !== undefined) this.zoom = clampZoom(state.zoom);
    this.lanesChosen = !!state.lanesChosen;
    this.lanes = this.lanesChosen ? !!state.lanes : true;
    this.expandedMethods = new Set(state.expandedMethods ?? []);
    this.privateShown = new Set(state.privateShown ?? []);
    this.cardFolded = !!state.findingCardFolded;
    if (state.edgeStyle && EDGE_STYLES.some((s) => s.value === state.edgeStyle)) this.edgeStyle = state.edgeStyle;
    if (state.diagram) this.handle({ type: 'render', diagram: state.diagram });
    for (const [path, open] of Object.entries(state.appOpen ?? {})) this.appOpen.set(path, new Set(open));
    if (state.appSelection?.length) this.appSelection = state.appSelection;
    if (state.appPath !== undefined) this.enterApp(state.appPath);
  }

  private save(): void {
    // the map is asked for again when the view comes back (FR-26): the flow's diagram is what is kept
    const flow = this.app ? (this.flowMsg?.type === 'render' ? this.flowMsg.diagram : undefined) : (this.diagram ?? undefined);
    this.bridge.setState<SavedState>({ diagram: flow, positions: this.app ? this.flowPositions : this.positions, ...(this.app ? { appPath: this.app.path } : {}), ...(this.app && this.appSelection ? { appSelection: this.appSelection } : {}), ...(this.appOpen.size ? { appOpen: Object.fromEntries([...this.appOpen].filter(([, s]) => s.size).map(([p, s]) => [p, [...s]])) } : {}), zoom: this.zoom, lanes: this.lanes, lanesChosen: this.lanesChosen, edgeStyle: this.edgeStyle, expandedMethods: [...this.expandedMethods], ...(this.privateShown.size ? { privateShown: [...this.privateShown] } : {}), ...(this.cardFolded ? { findingCardFolded: true } : {}) });
  }

  /** FR-19.10 the finding card opens folded / unfolded as the reader left the last one. */
  private cardFolded = false;

  render(): void {
    const diagram = this.shown();
    if (!diagram) return;
    if (this.engine === 'elk') return this.renderElk(diagram);
    this.draw(
      layoutClassDiagram(diagram, this.measure, this.positions, {
        viewportWidth: this.scroll.clientWidth,
        viewportHeight: this.scroll.clientHeight,
        lanes: this.lanesFor(diagram),
        methods: this.methodDisplay(),
      }),
    );
  }

  /** FR-28.5 the lanes apply zoomed too: a folded layer is one package in its lane, an opened one its classes. */
  private lanesFor(_diagram: ClassDiagram): boolean {
    return this.lanes;
  }

  /**
   * ELK lays out asynchronously: the automatic layout is cached per diagram + lanes and only
   * re-assembled (synchronously) for drags; a stale result is dropped. On failure: dagre.
   */
  private renderElk(diagram: ClassDiagram): void {
    const c = this.elkCache;
    const routing = routingFor(this.edgeStyle);
    const sizeKey = this.sizeKey();
    const lanes = this.lanesFor(diagram);
    if (c && c.diagram === diagram && c.lanes === lanes && c.routing === routing && c.sizeKey === sizeKey) {
      this.draw(assembleElk(diagram, c.result, this.positions, lanes));
      return;
    }
    const token = ++this.layoutToken;
    elkAutoLayout(diagram, this.measure, lanes, routing, this.methodDisplay()).then(
      (result) => {
        if (token !== this.layoutToken || diagram !== this.shown()) return;
        this.elkCache = { diagram, lanes, routing, sizeKey, result };
        this.render();
      },
      (e) => {
        if (token !== this.layoutToken) return;
        this.bridge.post({ type: 'log', level: 'error', message: `ELK layout failed, using dagre: ${e instanceof Error ? e.message : String(e)}` });
        this.engine = 'dagre';
        this.render();
      },
    );
  }

  /** Resolves when a pending asynchronous layout has been drawn (tests). */
  async settled(): Promise<void> {
    for (let i = 0; i < 50 && this.engine === 'elk' && this.diagram && !(this.elkCache?.diagram === this.shown() && this.elkCache.lanes === this.lanes && this.elkCache.routing === routingFor(this.edgeStyle) && this.elkCache.sizeKey === this.sizeKey()); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private draw(geometry: ClassGeometry): void {
    // render() draws only a shown diagram: shown() is null without one
    const diagram = this.diagram!;
    const { scrollTop, scrollLeft } = this.scroll;
    this.geometry = geometry;
    if (diagram.classes.length) this.placeholder.hidden = true;
    else this.showPlaceholder(this.app ? 'No classes reached from the entry points' : 'No classes in the current sequence diagram');
    this.reportFallback();
    // the design issues marked on their classes (the same list as the sequence diagram's)
    this.svgEl = renderClassDiagram(this.geometry, { edgeStyle: this.edgeStyle, marks: classDiagramMarks(this.diagram!.findings, this.diagram!.relations) });
    this.focus = '';
    this.applyScale();
    this.canvas.replaceChildren(this.svgEl);
    this.updateToolbar();
    this.updateReviewBar();
    this.scrollTo(scrollLeft, scrollTop);
    this.find.onDraw();
    if (this.applyFocusedClass(this.focusScrollPending)) this.focusScrollPending = false;
    // Reported after drawing (ELK lays out asynchronously), so hosts/tests see real renders.
    if (diagram !== this.lastReported) {
      this.lastReported = diagram;
      this.bridge.post({ type: 'log', level: 'info', message: `class view rendered ${diagram.classes.length} classes, ${geometry.edges.length} relations (${this.engine})` });
    }
  }

  private lastReported: ClassDiagram | null = null;

  /** the bar for the changed classes drawn (another set of them: from the start). */
  private updateReviewBar(): void {
    // (drawn: the geometry is there)
    const changed = changedClasses(this.geometry!.nodes);
    const keys = changed.map((n) => n.key).join('|');
    if (keys !== this.reviewKeys) [this.reviewKeys, this.reviewAt] = [keys, -1];
    this.reviewBarEl.hidden = !changed.length;
    this.reviewBarEl.replaceChildren(...(changed.length ? [classReviewBar(changed, this.reviewAt, (by) => this.stepReview(by))] : []));
  }

  /** the next / previous changed class: scrolled to and outlined (round the end). */
  private stepReview(by: 1 | -1): void {
    // only from the bar or its keys: shown with changed classes drawn
    const changed = changedClasses(this.geometry!.nodes);
    const n = changed.length;
    this.reviewAt = this.reviewAt < 0 ? (by === 1 ? 0 : n - 1) : (this.reviewAt + by + n) % n;
    this.highlightFinding([changed[this.reviewAt].key], []);
    this.updateReviewBar();
  }

  /** N / P step through the changed classes, as in the sequence view's review. */
  private bindReviewKeys(doc: Document): void {
    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.root.isConnected || this.reviewBarEl.hidden || e.ctrlKey || e.metaKey || e.altKey || this.popups.element) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const by = e.key === 'n' ? 1 : e.key === 'p' ? -1 : 0;
      if (!by) return;
      e.preventDefault();
      this.stepReview(by);
    });
  }

  /** FR-12.17 the class of the object last clicked in the sequence diagram: outlined until a click here. */
  private focusedClass: string | undefined;
  private focusScrollPending = false;

  /** Outlines the focused class (and scrolls it into view); false when it is not drawn. */
  private applyFocusedClass(scroll: boolean): boolean {
    if (!this.svgEl) return false;
    for (const el of this.svgEl.querySelectorAll('.class-focused')) el.classList.remove('class-focused');
    if (!this.focusedClass) return false;
    const node = [...this.svgEl.querySelectorAll('.class-node[data-class-key]')].find((el) => el.getAttribute('data-class-key') === this.focusedClass);
    if (!node) return false;
    node.classList.add('class-focused');
    if (scroll) revealElements(this.scroll, [node]);
    return true;
  }

  private lastFallbackReport = '';

  /** Tells the host (output channel) when the layout had to fall back, with the data to reproduce it. */
  private reportFallback(): void {
    const fb = this.geometry?.fallback;
    if (!fb || !this.diagram) return;
    const data = JSON.stringify(this.diagram);
    if (data === this.lastFallbackReport) return;
    this.lastFallbackReport = data;
    this.bridge.post({
      type: 'log',
      level: 'error',
      message: `class layout fell back to the ${fb.kind} layout after: ${fb.reason}\nclass diagram (for a bug report): ${data.slice(0, 50_000)}`,
    });
  }

  // ───────────────────────── zoom ─────────────────────────

  private applyScale(): void {
    if (this.svgEl && this.geometry) scaleSvg(this.svgEl, this.geometry.width, this.geometry.height, this.zoom);
  }

  /**
   * Hover highlight: a class (or relation) and everything directly related stay fully visible,
   * the rest fades — the main aid for following edges in dense diagrams.
   */
  private focusOn(target: EventTarget | null): void {
    const svgEl = this.svgEl;
    if (!svgEl || this.drag) return;
    const nodeKey = closestWithData(target, 'class-key')?.getAttribute('data-class-key') ?? null;
    const relId = nodeKey ? null : closestWithData(target, 'relation-id')?.getAttribute('data-relation-id') ?? null;
    const focus = nodeKey ? `n:${nodeKey}` : relId ? `r:${relId}` : '';
    if (focus === this.focus) return;
    this.focus = focus;
    for (const el of svgEl.querySelectorAll('.focused')) el.classList.remove('focused');
    svgEl.classList.toggle('has-focus', !!focus);
    if (!focus) return;
    // an SVG is drawn only with its geometry (draw sets both; empty and the map clear both)
    const rels = this.geometry!.edges.filter((e) => (nodeKey ? e.from === nodeKey || e.to === nodeKey : e.id === relId));
    const keys = new Set(rels.flatMap((e) => [e.from, e.to]));
    if (nodeKey) keys.add(nodeKey);
    for (const el of svgEl.querySelectorAll<SVGElement>('[data-class-key]')) if (keys.has(el.getAttribute('data-class-key')!)) el.classList.add('focused');
    const ids = new Set(rels.map((e) => e.id));
    for (const el of svgEl.querySelectorAll<SVGElement>('[data-relation-id]')) if (ids.has(el.getAttribute('data-relation-id')!)) el.classList.add('focused');
  }

  /** FR-19: outline a finding's classes and relations (until the next click on the canvas or render). */
  highlightFinding(classKeys: string[], relationIds: string[]): void {
    const svgEl = this.svgEl;
    if (!svgEl) return;
    for (const el of svgEl.querySelectorAll('.finding-hl')) el.classList.remove('finding-hl');
    const keys = new Set(classKeys);
    const rels = new Set(relationIds);
    for (const el of svgEl.querySelectorAll<SVGElement>('[data-class-key]')) if (keys.has(el.getAttribute('data-class-key')!)) el.classList.add('finding-hl');
    for (const el of svgEl.querySelectorAll<SVGElement>('[data-relation-id]')) if (rels.has(el.getAttribute('data-relation-id')!)) el.classList.add('finding-hl');
    // FR-19.8: move the diagram to the finding (its classes, else its relations), zoomed out when it does not fit
    const nodes = [...svgEl.querySelectorAll('.class-node.finding-hl')];
    revealElements(this.scroll, nodes.length ? nodes : [...svgEl.querySelectorAll('.relation.finding-hl')], { zoom: { current: this.zoom, set: (z) => this.setZoom(z) } });
  }

  /**
   * FR-12.14 a relation whose calls are not drawn (inside collapsed calls): the host expands the
   * sequence diagram until they appear and highlights them; nothing found → the source's declaration.
   */
  private revealRelation(r: ClassRelation): void {
    const fallback = this.diagram?.classes.find((c) => c.key === r.from)?.declaration;
    this.bridge.post({ type: 'revealRelation', from: r.from, to: r.to, ...(r.kind === 'association' && r.label ? { field: r.label } : {}), ...(fallback ? { fallback } : {}) });
  }

  /** FR-12.16 a layer violation: outline both classes, show its calls (expanded when collapsed), explain it. */
  private showViolation(r: ClassRelation): void {
    // never on the codebase map: its clicks go to onAppClick, its ⚠ list to showMapIssue
    const show = () => {
      this.highlightFinding([r.from, r.to], [r.id]);
      // a use relation's evidence: the methods referencing the type; the others: their calls
      const ids = r.kind === 'use' ? (r.uses ?? []).flatMap((u) => (u.messageId ? [u.messageId] : [])) : (r.calls ?? []).map((c) => c.messageId);
      if (ids.length) this.bridge.post({ type: 'highlightMessages', messageIds: [...new Set(ids)] });
      else if (r.kind !== 'use') this.revealRelation(r);
    };
    show();
    const sideOf = (key: string): ViolationSide => {
      const c = this.diagram?.classes.find((x) => x.key === key);
      return { key, name: c?.name ?? key.replace(/^.*#/, ''), ...(c?.layer ? { layer: c.layer } : {}), ...(c?.layerHint ? { suggested: c.layerHint.suggested, reasons: c.layerHint.reasons, ...(c.layerHint.noMove ? { noMove: true } : {}) } : {}) };
    };
    const card = violationCard(sideOf(r.from), sideOf(r.to), r.violation ?? '', {
      show,
      move: (s) => this.layerScope.choose({ classKey: s.key, className: s.name }, s.suggested!, 120, 120),
      adjustRule: () => this.bridge.post({ type: 'openDependencyRule' }),
      close: () => this.popups.close(),
    }, this.fold(), this.diagram?.findings?.find((f) => f.kind === 'layer-violation' && f.relationIds?.includes(r.id))?.evidence, r.possible);
    this.showGuide(card);
  }

  /**
   * FR-19.10 a finding / violation card at the top right of the canvas (below the find bar); FR-19.20 while it is
   * open, what the issue is not about is dimmed (its outlined classes and relations stay).
   */
  private showGuide(card: HTMLElement, dim = true): void {
    const r = this.scroll.getBoundingClientRect();
    const findBar = this.root.querySelector('.find-bar:not([hidden])');
    const top = Math.max(r.top + 8, findBar ? findBar.getBoundingClientRect().bottom + 6 : 0);
    // sticky: revealing the evidence scrolls / zooms the view right after (asynchronous scroll event)
    this.popups.show(card, Math.max(r.left + 8, r.right - 452), top, { sticky: true, onClose: () => this.root.classList.remove('evidence-dimmed') });
    if (dim) this.root.classList.add('evidence-dimmed');
  }

  /** FR-19.10 a card opens folded as the reader left the last one, and remembers their choice. */
  private fold(): { folded: boolean; changed(folded: boolean): void } {
    return {
      folded: this.cardFolded,
      changed: (folded) => {
        this.cardFolded = folded;
        this.save();
      },
    };
  }

  /** FR-19.17 an issue picked from ⚠ N: a layer violation as its relation (outline, calls, card), else the finding. */
  private showIssue(f: Finding): void {
    const r = f.kind === 'layer-violation' ? this.diagram?.relations.find((x) => x.id === f.relationIds?.[0]) : undefined;
    if (r) return this.showViolation(r);
    this.highlightFinding(f.classKeys ?? [], f.relationIds ?? []);
    this.showFindingGuide(f);
  }

  /** FR-19.10 the finding's card at the top right of the canvas; `show` defaults to outlining its classes here. */
  private showFindingGuide(f: Finding, show = () => this.highlightFinding(f.classKeys ?? [], f.relationIds ?? [])): void {
    const card = findingCard(f, {
      show,
      ignore: (pattern) => {
        this.popups.close();
        this.bridge.post({ type: 'ignoreFinding', pattern });
      },
      close: () => this.popups.close(),
    }, this.fold());
    this.showGuide(card, !!(f.classKeys?.length || f.relationIds?.length));
  }

  private methodDisplay(): MethodDisplay {
    return { maxMethods: this.maxMethods, expanded: this.expandedMethods };
  }

  /** Box sizes depend on the method limit and the expanded classes (ELK cache key). */
  private sizeKey(): string {
    return `${this.maxMethods}|${[...this.expandedMethods].sort().join(',')}`;
  }

  /**
   * FR-12.18 the diagram as drawn: private / protected rows left out, except in the classes they are shown for. The
   * same object while nothing changes (the ELK cache and its stale check compare by identity).
   */
  private shown(): ClassDiagram | null {
    const source = this.diagram;
    if (!source) return null;
    const key = [...this.privateShown].sort().join(',');
    if (this.shownCache?.source === source && this.shownCache.key === key) return this.shownCache.diagram;
    const diagram = { ...source, classes: source.classes.map((c) => (this.privateShown.has(c.key) || !c.methods.some((m) => m.visibility) ? c : { ...c, methods: c.methods.filter((m) => !m.visibility) })) };
    this.shownCache = { source, key, diagram };
    return diagram;
  }

  /** FR-12.18 show / hide the private and protected methods of one class. */
  togglePrivateMethods(classKey: string): void {
    if (this.privateShown.has(classKey)) this.privateShown.delete(classKey);
    else this.privateShown.add(classKey);
    this.save();
    this.render();
  }

  /** FR-12.11: "… +k more" / "▴ fewer" toggles all methods of one class. */
  toggleMethods(classKey: string): void {
    if (this.expandedMethods.has(classKey)) this.expandedMethods.delete(classKey);
    else this.expandedMethods.add(classKey);
    this.save();
    this.render();
  }

  setEdgeStyle(style: EdgeStyle): void {
    if (style === this.edgeStyle) return;
    this.edgeStyle = style;
    this.save();
    this.render();
  }

  /** Group by layer on/off: lanes change every position, so manual positions are dropped. */
  setLanes(on: boolean): void {
    if (on === this.lanes) return;
    this.lanes = on;
    this.lanesChosen = true;
    this.positions = {};
    this.save();
    this.render();
    this.scrollTo(0, 0);
  }

  /** FR-28.9 *Fold all layers* (as the sequence view's), when more layers are open than the one at hand (`ownOpen`: 1 for a class of an opened layer). */
  private foldAllItem(ownOpen: number): MenuItem[] {
    const open = openLayerCount(this.diagram!.classes); // a context menu of a flow's class: there is a diagram
    return open > ownOpen ? [{ separator: true, label: '' }, { id: 'fold-all-layers', label: 'Fold all layers', hint: `${open} open`, action: () => this.bridge.post({ type: 'foldLayers' }) }] : [];
  }

  // ───────────────────────── hiding (shared with the sequence view, FR-11) ─────────────────────────

  private onContextMenu(e: MouseEvent): void {
    const n = this.nodeAt(e.target);
    if (!n) return;
    e.preventDefault();
    if (this.app) return this.appMenu(n.node, e);
    const c = n.node;
    // FR-28 a layer of the zoomed flow is no class: nothing to hide or move — it opens in place (FR-28.7)
    if (c.group?.zoom) {
      this.popups.showMenu(
        [
          { id: 'open-layer', label: 'Show its classes here', hint: '⊕', action: () => this.bridge.post({ type: 'setLayerOpen', layer: c.key, open: true }) },
          { separator: true, label: '' },
          // FR-28.8 one class pulled out beside the package (every object of it in the sequence diagram)
          ...c.methods.filter((m) => m.key).map((m, i): MenuItem => ({ id: `class:${i}`, label: m.name, hint: 'pull out', action: () => this.bridge.post({ type: 'setLayerOpen', layer: m.key!, open: true }) })),
          ...this.foldAllItem(0),
        ],
        e.clientX,
        e.clientY,
      );
      return;
    }
    const member = closestWithData(e.target, 'member')?.getAttribute('data-member') ?? undefined;
    const isRoot = c.key === this.rootClassKey;
    const hide = (filter: HideFilterSpec) => () => this.bridge.post({ type: 'hide', filter });
    const items: MenuItem[] = [];
    // FR-28.11 the object view: fold the class's layer into one package
    if (c.layerFold)
      items.push(
        ...(c.usedOnly ? [] : [{ id: 'fold-object', label: `Fold into ${c.layerFold.name}`, hint: '⊖', title: 'Only this class: the layer\'s other classes stay out', action: () => this.bridge.post({ type: 'setLayerOpen', layer: c.key, open: false }) }]),
        { id: 'fold-layer', label: `Fold ${c.layerFold.name}`, hint: 'one package', action: () => this.bridge.post({ type: 'setLayerOpen', layer: c.layerFold!.key, open: false }) },
        ...this.foldAllItem(1),
        { separator: true, label: '' },
      );
    // FR-28.7 a class of a layer opened in place
    if (c.inLayer)
      items.push(
        { id: 'fold-object', label: `Put it back into ${c.inLayer.name}`, hint: '⊖', action: () => this.bridge.post({ type: 'setLayerOpen', layer: c.key, open: false }) },
        { id: 'fold-layer', label: `Fold ${c.inLayer.name} (all its classes)`, action: () => this.bridge.post({ type: 'setLayerOpen', layer: c.inLayer!.key, open: false }) },
        ...this.foldAllItem(1),
        { separator: true, label: '' },
      );
    const row = member ? c.methods.find((m) => m.name === member) : undefined;
    if (row) items.push(...this.memberMenu(c.name, row));
    // the class's Go to near the top, as an object's in the sequence diagram (a method row has its own above)
    else if (c.declaration) items.push({ id: 'open', label: 'Go to declaration', action: () => this.bridge.post({ type: 'navigate', range: c.declaration! }) }, { separator: true, label: '' });
    if (member && member !== 'constructor') {
      // the same words, order and submenu as the sequence diagram's message menu
      const rules: MenuItem[] = [
        { id: 'hide-method', label: `Hide every call named ${member}`, hint: 'any class', action: hide({ kind: 'methodName', methodName: member }) },
        { id: 'hide-class-method', label: `Hide calls to ${c.name}.${member} only`, action: hide({ kind: 'classMethod', classKey: c.key, className: c.name, methodName: member }) },
        { separator: true, label: '' },
        // FR-11.7 the calls stay in the sequence diagram, folded on Expand all / Overview
        { id: 'no-expand-method', label: `Don't expand calls named ${member}`, hint: 'any class', action: hide(noExpand({ kind: 'methodName', methodName: member })) },
        { id: 'no-expand-class-method', label: `Don't expand calls to ${c.name}.${member} only`, action: hide(noExpand({ kind: 'classMethod', classKey: c.key, className: c.name, methodName: member })) },
      ];
      items.push({ id: 'hide-menu', label: "Hide / don't expand", submenu: rules }, { separator: true, label: '' });
    }
    // FR-12.18 the class's private / protected methods, counted on the diagram as received (the box may leave them out)
    // the box is drawn from this diagram (shown() only leaves methods out): its class is there
    const notPublic = this.diagram!.classes.find((x) => x.key === c.key)!.methods.filter((m) => m.visibility).length;
    if (notPublic) {
      const shown = this.privateShown.has(c.key);
      items.push(
        { id: 'private-methods', label: shown ? 'Hide private / protected methods' : `Show ${notPublic} private / protected method${notPublic === 1 ? '' : 's'}`, action: () => this.togglePrivateMethods(c.key) },
        { separator: true, label: '' },
      );
    }
    items.push({
      id: 'hide-class',
      label: `Hide class ${c.name}`,
      hint: isRoot ? 'root of the diagram' : undefined,
      disabled: isRoot,
      action: hide({ kind: 'class', classKey: c.key, className: c.name }),
    });
    items.push(...categoryMenu(c.name, c.stereotypes, (f) => hide(f)()));
    const stopId = `noExpand:class:${c.key}`;
    items.push(
      this.hiddenFilters.some((f) => f.filter.id === stopId)
        ? { id: 'allow-expand-class', label: `Let Expand all open calls to ${c.name} again`, action: () => this.bridge.post({ type: 'unhide', filterId: stopId }) }
        : { id: 'no-expand-class', label: `Don't expand calls to class ${c.name}`, action: hide(noExpand({ kind: 'class', classKey: c.key, className: c.name })) },
    );
    const layerItems = layerMenuItems({ classKey: c.key, className: c.name, layer: c.layer, layerHint: c.layerHint }, this.layerChoices, (layer) =>
      this.layerScope.choose({ classKey: c.key, className: c.name }, layer, e.clientX, e.clientY),
    );
    const why = whyLabel(c);
    if (why) items.push({ separator: true, label: '' }, { id: 'why-layer', label: why, action: () => this.showLayerReason(c, e.clientX, e.clientY) });
    if (layerItems.length) items.push(...(why ? [] : [{ separator: true, label: '' }]), ...layerItems);
    this.popups.showMenu(items, e.clientX, e.clientY);
  }

  /** FR-7.8 the card: which rule placed the class in its layer, what the code suggests, how to change it. */
  private showLayerReason(c: ClassNode, x: number, y: number): void {
    const setLayer = (layer: string) => this.layerScope.choose({ classKey: c.key, className: c.name }, layer, x, y);
    const d = this.diagram!; // the menu of a drawn class
    // the other end of a relation may be a class the diagram does not draw: its name from the key
    const end = (key: string) => {
      const n = d.classes.find((x) => x.key === key);
      return { name: n?.name ?? key.replace(/^.*#/, ''), layer: n?.layer ?? 'another layer' };
    };
    const violations = d.relations.flatMap((r) => {
      if (!r.violation) return [];
      // FR-7.16 as the sequence diagram's object card says it
      const possible = r.possible ? ` (possible: ${r.possible.join('; ')})` : '';
      if (r.from === c.key) return [`depends on ${end(r.to).layer}: ${end(r.to).name}${possible}`];
      return r.to === c.key ? [`${end(r.from).layer} depends on it: ${end(r.from).name}${possible}`] : [];
    });
    const card = layerReasonCard(
      { classKey: c.key, className: c.name, layer: c.layer, layerReason: c.layerReason, stereotypeReasons: c.stereotypeReasons, layerHint: c.layerHint, violations: [...new Set(violations)] },
      {
        applyHint: setLayer,
        ignoreHint: (pattern) => {
          this.popups.close();
          this.bridge.post({ type: 'ignoreLayerHint', pattern });
        },
        moveTo: (mx, my) => this.popups.showMenu(this.layerChoices.filter((l) => l !== c.layer).map((l) => ({ id: `layer:${l}`, label: l, action: () => setLayer(l) })), mx, my),
      },
    );
    this.popups.show(card, x, y);
  }

  /** FR-25 everything drawn, at scale 1, with the panel's colours. */
  private diagramImage(): { svg: string; width: number; height: number; name: string } | undefined {
    if (!this.svgEl || !this.diagram?.classes.length) return undefined;
    const v = this.svgEl.viewBox.baseVal;
    const root = this.app ? `application${this.app.path ? `-${this.app.path.split('/').pop()}` : ''}` : `${this.diagram.classes.find((c) => c.key === this.rootClassKey)?.name ?? 'classes'}-classes`;
    return { ...standaloneSvg([{ svg: this.svgEl, y: 0 }], v.width, v.height, backgroundOf(this.canvas)), name: imageName(root) };
  }

  // ───────────────────────── FR-25.2 / FR-25.3 shared diagrams ─────────────────────────

  private showCard(card: HTMLElement, sticky = false): void {
    const r = this.root.getBoundingClientRect();
    this.popups.show(card, Math.max(8, r.left + 40), Math.max(8, r.top + 40), { sticky });
  }

  private openStatePrompt(): void {
    this.showCard(
      pasteStateCard(
        (text) => {
          this.popups.close();
          this.bridge.post({ type: 'openState', text });
        },
        () => this.popups.close(),
      ),
      true,
    );
  }

  private flashShare(t: string): void {
    this.shareButton.title = t;
    this.shareButton.dataset.flash = t;
    setTimeout(() => {
      this.shareButton.title = SHARE_TITLE;
      delete this.shareButton.dataset.flash;
    }, FLASH_MS);
  }

  private useOwnConfig(): void {
    this.popups.close();
    this.bridge.post({ type: 'useSharedConfig', on: false });
  }

  private renderBorrowed(cfg: BorrowedConfig | undefined): void {
    this.borrowed = cfg;
    this.borrowEl.hidden = !cfg;
    this.borrowEl.replaceChildren(...(cfg ? borrowedConfigBar(cfg, () => this.useOwnConfig()).childNodes : []));
  }

  private async copyImage(btn: HTMLButtonElement): Promise<void> {
    const img = this.diagramImage();
    if (!img) return;
    const ok = await copyPng(svgToPng(img.svg, img.width, img.height));
    btn.title = ok ? 'Copied ✓' : 'Copy not allowed here — use Save as PNG';
    btn.dataset.flash = btn.title;
    setTimeout(() => {
      btn.title = SHARE_TITLE;
      delete btn.dataset.flash;
    }, FLASH_MS);
  }

  private async saveImage(format: 'png' | 'svg'): Promise<void> {
    const img = this.diagramImage();
    if (!img) return;
    const name = `${img.name}.${format}`;
    if (format === 'svg') {
      if (hostSaves()) this.bridge.post({ type: 'saveImage', name, format, data: img.svg });
      else download(name, img.svg, 'image/svg+xml');
      return;
    }
    const png = await svgToPng(img.svg, img.width, img.height);
    if (hostSaves()) this.bridge.post({ type: 'saveImage', name, format, data: await blobToBase64(png) });
    else download(name, png, 'image/png');
  }

  private hiddenMenu(): MenuItem[] {
    return filtersMenu(this.hiddenFilters, (msg) => this.bridge.post(msg));
  }

  /** Colour legend for the layers present in the diagram, plus the dependency-rule violations. */
  private updateLegend(): void {
    const classes = this.diagram?.classes ?? [];
    const layers = this.diagram?.layers?.length ? this.diagram.layers : sortLayers(classes.flatMap((c) => (c.layer ? [c.layer] : [])));
    const chips: HTMLElement[] = layers.map((l) => html('span', { class: `layer-chip ${layerClass(l)}` }, [l]));
    this.legend.replaceChildren(...chips);
    // FR-19.17 ⚠ N: the same button and list as the sequence diagram's (the codebase map has its own)
    // the codebase map too — its violations (wherever drawn) and the design issues of its flows
    if (this.app) updateIssuesButton(this.issuesButton, this.app.level ? this.mapIssues() : undefined, !!this.app.level, 0, undefined, 'the flows of this map');
    else updateIssuesButton(this.issuesButton, this.diagram?.findings, !!this.diagram, this.diagram?.typeUseViolations, this.diagram?.issuesBelow);
    this.hiddenButton.querySelector('.tb-badge')!.textContent = this.hiddenFilters.length ? String(this.hiddenFilters.length) : '';
    this.hiddenButton.classList.toggle('has-filters', this.hiddenFilters.length > 0);
    // Filters ▾ only once there is a filter, as in the sequence diagram
    this.hiddenButton.hidden = this.hiddenFilters.length === 0;
    // FR-14.2: a dot on View ▾ when an option differs from its default (Layers on, Uses off, curved edges)
    const changed = [!this.lanes && 'Layers off', !!this.diagram?.typeUses && 'Uses on', this.edgeStyle !== 'curved' && `${EDGE_STYLES.find((e) => e.value === this.edgeStyle)?.label} edges`].filter(Boolean);
    this.viewButton.classList.toggle('changed', changed.length > 0);
    this.viewButton.title = changed.length ? `${CLASS_VIEW_TITLE}\nChanged: ${changed.join(', ')}` : CLASS_VIEW_TITLE;
    this.popups.refresh('view', this.viewMenu());
  }

  /** FR-14.2 View ▾ of the class view: Layers and Uses (check boxes), then the edge style (one of three). */
  private viewMenu(): MenuItem[] {
    const uses = !!this.diagram?.typeUses;
    return [
      { id: 'view:lanes', label: '☰ Layers', hint: 'one lane per layer', role: 'checkbox', checked: this.lanes, keepOpen: true, action: () => this.setLanes(!this.lanes) },
      {
        id: 'view:uses',
        label: '⇢ Uses',
        hint: 'types referenced, not only called',
        role: 'checkbox',
        checked: uses,
        disabled: !this.diagram || !!this.app,
        keepOpen: true,
        action: () => this.bridge.post({ type: 'setTypeUses', value: !uses }),
      },
      // the marks of both diagrams, the same section as in the sequence view's View ▾
      ...(this.options ? [{ separator: true, label: '' }, ...markItems(this.options, (option, value) => this.bridge.post({ type: 'setOption', option, value }), !!this.app)] : []),
      { separator: true, label: '' },
      ...EDGE_STYLES.map((e): MenuItem => ({ id: `view:edges:${e.value}`, label: `${e.label} edges`, role: 'radio', checked: this.edgeStyle === e.value, keepOpen: true, action: () => this.setEdgeStyle(e.value) })),
    ];
  }

  private updateToolbar(): void {
    this.updateLegend();
    this.appButton.classList.toggle('active', !!this.app);
    this.appButton.setAttribute('aria-pressed', String(!!this.app));
    this.hiddenButton.disabled = !!this.app;
    const has = !!this.diagram && this.diagram.classes.length > 0;
    this.zoomControls.update(this.zoom, has);
    this.relayoutButton.disabled = !has || Object.keys(this.positions).length === 0;
    // Re-layout only when a class was dragged (there is nothing to undo before)
    this.relayoutButton.hidden = this.relayoutButton.disabled;
  }

  private scrollTo(left: number, top: number): void {
    this.scroll.scrollLeft = left;
    this.scroll.scrollTop = top;
  }

  /** Sets the zoom, keeping the content point at (`px`,`py`) of the viewport in place. */
  setZoom(z: number, px = 0, py = 0): void {
    const to = clampZoom(z);
    const from = this.zoom;
    if (to === from) return;
    const next = scrollForZoom(this.scroll.scrollLeft, this.scroll.scrollTop, px, py, from, to);
    this.zoom = to;
    this.applyScale();
    this.scrollTo(next.left, next.top);
    this.updateToolbar();
    this.save();
  }

  fit(): void {
    if (!this.geometry) return;
    this.setZoom(fitWidthZoom(this.geometry.width, this.scroll.clientWidth));
    this.scrollTo(0, 0);
  }

  private onZoomCommand(cmd: ZoomCommand): void {
    if (cmd === 'zoomIn') this.setZoom(stepZoom(this.zoom, 1));
    else if (cmd === 'zoomOut') this.setZoom(stepZoom(this.zoom, -1));
    else if (cmd === 'zoomReset') this.setZoom(1);
    else this.fit();
  }

  private onWheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey) || !this.geometry) return;
    e.preventDefault();
    const r = this.scroll.getBoundingClientRect();
    this.setZoom(this.zoom * wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top);
  }

  /** Drops manual positions and lays out again. */
  relayout(): void {
    this.positions = {};
    this.save();
    this.render();
    this.scrollTo(0, 0);
  }

  private nodeAt(target: EventTarget | null) {
    const key = closestWithData(target, 'class-key')?.getAttribute('data-class-key');
    return key ? this.geometry?.nodes.find((n) => n.key === key) : undefined;
  }

  /** The method row under the target (FR-12.13). */
  private memberAt(node: ClassNode, target: EventTarget | null): ClassMember | undefined {
    const name = closestWithData(target, 'member')?.getAttribute('data-member');
    return name ? node.methods.find((m) => m.name === name) : undefined;
  }

  /**
   * FR-12.13 method menu: focus the sequence diagram on a call of the method (a submenu when several
   * calls in the diagram run it), show its calls there, go to its definition.
   */
  private memberMenu(className: string, m: ClassMember): MenuItem[] {
    const calls = m.calls ?? [];
    const title = `${className}.${m.name}`;
    const line = (c: RelationCall) => (c.callSite ? ` · line ${c.callSite.start.line + 1}` : '');
    const focus = (id: string) => () => this.bridge.post({ type: 'focus', messageId: id });
    const items: MenuItem[] = [];
    if (calls.length === 1) items.push({ id: 'focus-method', label: `Focus sequence diagram on ${title}`, action: focus(calls[0].messageId) });
    else if (calls.length > 1) {
      items.push({
        id: 'focus-method',
        label: `Focus sequence diagram on ${title}`,
        hint: `${calls.length} calls`,
        submenu: calls.map((c, i) => ({ id: `focus-call:${i}`, label: `${c.label}${line(c)}`, action: focus(c.messageId) })),
      });
    }
    if (calls.length) {
      items.push({ id: 'show-calls', label: 'Show calls in sequence diagram', action: () => this.bridge.post({ type: 'highlightMessages', messageIds: calls.map((c) => c.messageId) }) });
      // as on a message of the sequence diagram (any call of the method names it)
      const open = (panel: 'callers' | 'paths') => () => this.bridge.post({ type: 'openInSequence', panel, messageId: calls[0].messageId });
      items.push({ id: 'show-callers', label: 'Show callers', hint: 'sequence diagram', action: open('callers') }, { id: 'paths-to-here', label: 'Paths to here…', hint: 'sequence diagram', action: open('paths') });
    }
    if (m.declaration) items.push({ id: 'goto-method', label: 'Go to declaration', action: () => this.bridge.post({ type: 'navigate', range: m.declaration! }) });
    if (items.length) items.push({ separator: true, label: '' });
    return items;
  }

  private onClick(e: MouseEvent): void {
    if (this.suppressClick) return;
    // FR-12.17 a click here ends the focus that came from the sequence diagram
    if (this.focusedClass) {
      this.focusedClass = undefined;
      this.applyFocusedClass(false);
    }
    this.highlightFinding([], []);
    // a design issue's mark: its card, its classes outlined (as picked from ⚠ N)
    const markId = closestWithData(e.target, 'finding-id')?.getAttribute('data-finding-id');
    const marked = markId ? this.diagram?.findings?.find((f) => f.id === markId) : undefined;
    if (marked) return this.showIssue(marked);
    const toggle = closestWithData(e.target, 'more-toggle')?.getAttribute('data-more-toggle');
    if (toggle) {
      this.toggleMethods(toggle);
      return;
    }
    if (this.app) return this.onAppClick(e);
    // FR-28.7 ⊕ on a layer package opens it in place; ⊖ ‹layer› above a class folds it again
    const openLayer = closestWithData(e.target, 'open-layer')?.getAttribute('data-open-layer');
    if (openLayer) return void this.bridge.post({ type: 'setLayerOpen', layer: openLayer, open: true });
    const foldLayer = closestWithData(e.target, 'fold-layer')?.getAttribute('data-fold-layer');
    if (foldLayer) return void this.bridge.post({ type: 'setLayerOpen', layer: foldLayer, open: false });
    const hinted = closestWithData(e.target, 'layer-hint') ? this.nodeAt(e.target) : undefined;
    if (hinted?.node.layerHint) {
      const c = hinted.node;
      this.popups.showMenu(layerHintMenu({ classKey: c.key, className: c.name, layer: c.layer, layerHint: c.layerHint }, (layer) => this.layerScope.choose({ classKey: c.key, className: c.name }, layer, e.clientX, e.clientY)), e.clientX, e.clientY);
      return;
    }
    const n = this.nodeAt(e.target);
    // FR-24.11 the NEW / Δn tag, and a member the branch changed: the class side by side (at the member)
    if (n && closestWithData(e.target, 'class-diff')) return void this.bridge.post({ type: 'openDiff', classKey: n.key });
    const changed = n && closestWithData(e.target, 'member-diff') ? closestWithData(e.target, 'member')?.getAttribute('data-member') : undefined;
    if (n && changed) {
      const m = n.node.methods.find((x) => x.name === changed);
      if (m?.calls?.length) this.bridge.post({ type: 'highlightMessages', messageIds: m.calls.map((c) => c.messageId) });
      return void this.bridge.post({ type: 'openDiff', classKey: n.key, member: changed });
    }
    // FR-12.13: a method row goes to the method (and shows where it runs in the sequence diagram)
    const member = n && this.memberAt(n.node, e.target);
    if (member) {
      if (member.calls?.length) this.bridge.post({ type: 'highlightMessages', messageIds: member.calls.map((c) => c.messageId) });
      const range = member.declaration ?? n!.node.declaration;
      if (range) this.bridge.post({ type: 'navigate', range });
      return;
    }
    if (n?.node.declaration) {
      this.bridge.post({ type: 'navigate', range: n.node.declaration }); // FR-12.5
      return;
    }
    const relId = closestWithData(e.target, 'relation-id')?.getAttribute('data-relation-id');
    if (relId) this.onRelationClick(relId, e.clientX, e.clientY);
  }

  /**
   * FR-12.9: a relation summarises possibly many calls. All of them are highlighted in the
   * sequence diagram; one call → jump to it; several → pick one from a list (jump + narrow the
   * highlight); realization/generalization (no call) → the subtype's declaration.
   */
  private onRelationClick(relId: string, x: number, y: number): void {
    // every drawn relation is one of the diagram's (the layout keeps the ids)
    const r = this.diagram!.relations.find((rel) => rel.id === relId)!;
    // FR-12.16 a layer violation: its calls shown, and the card that explains it
    if (r.violation) return this.showViolation(r);
    if (r.kind === 'use') return this.onUseClick(r.uses ?? [], x, y);
    const calls = r.calls ?? [];
    if (!calls.length) {
      // a dependency / association with its calls collapsed: reveal them (FR-12.14); inheritance has none
      if (r.kind === 'dependency' || r.kind === 'association') return this.revealRelation(r);
      const decl = this.diagram!.classes.find((c) => c.key === r.from)?.declaration;
      if (decl) this.bridge.post({ type: 'navigate', range: decl });
      return;
    }
    this.bridge.post({ type: 'highlightMessages', messageIds: calls.map((c) => c.messageId) });
    if (calls.length === 1) {
      if (calls[0].callSite) this.bridge.post({ type: 'navigate', range: calls[0].callSite });
      return;
    }
    const items: MenuItem[] = [
      { label: `${calls.length} calls — highlighted in the sequence diagram`, disabled: true },
      { separator: true, label: '' },
      ...calls.map((c, i) => ({
        id: `relation-call:${i}`,
        label: c.label,
        hint: c.callSite ? formatLocation(c.callSite) : undefined,
        action: () => {
          this.bridge.post({ type: 'highlightMessages', messageIds: [c.messageId] });
          if (c.callSite) this.bridge.post({ type: 'navigate', range: c.callSite });
        },
      })),
    ];
    this.popups.showMenu(items, x, y);
  }

  /** FR-12.12: a use relation → the methods that reference the type (highlight + jump, or a list). */
  private onUseClick(uses: NonNullable<ClassDiagram['relations'][number]['uses']>, x: number, y: number): void {
    if (!uses.length) return;
    const highlight = (list: typeof uses) => {
      const ids = list.flatMap((u) => (u.messageId ? [u.messageId] : []));
      if (ids.length) this.bridge.post({ type: 'highlightMessages', messageIds: ids });
    };
    highlight(uses);
    if (uses.length === 1) {
      this.bridge.post({ type: 'navigate', range: uses[0].range });
      return;
    }
    const items: MenuItem[] = [
      { label: `${uses.length} methods reference the type`, disabled: true },
      { separator: true, label: '' },
      ...uses.map((u, i) => ({
        id: `relation-use:${i}`,
        label: u.method,
        hint: formatLocation(u.range),
        action: () => {
          highlight([u]);
          this.bridge.post({ type: 'navigate', range: u.range });
        },
      })),
    ];
    this.popups.showMenu(items, x, y);
  }

  // ───────────────────────── FR-26 codebase map ─────────────────────────

  /** Shows the map at a folder ('' = the top); the flow's classes wait behind it. */
  enterApp(path: string): void {
    if (!this.app) {
      this.flowMsg = this.diagram
        ? { type: 'render', diagram: this.diagram, hiddenFilters: this.hiddenFilters, rootClassKey: this.rootClassKey, layerChoices: this.layerChoices, maxMethods: this.maxMethods }
        : { type: 'empty', reason: this.placeholder.querySelector('.placeholder-title')!.textContent! }; // an element's text is never null
      this.flowPositions = this.positions;
      this.positions = {};
      this.diagram = null;
      this.geometry = null;
      this.svgEl = null;
      this.canvas.textContent = '';
      this.root.classList.add('app-mode');
    }
    this.app = { ...(this.app ?? {}), path, state: 'running' };
    this.popups.close();
    this.updateToolbar(); // ⛶ pressed, the flow's ⚠ / ⇄ / Filters gone while the first map is scanned
    this.showAppProgress();
    this.requestAppMap(path);
    this.save();
  }

  /** Asks for the map at a folder with the packages open there (FR-26.7). */
  private requestAppMap(path: string, rescan = false): void {
    const open = [...(this.appOpen.get(path) ?? [])];
    const entryPoints = this.appSelection;
    this.bridge.post({ type: 'requestAppMap', path, ...(open.length ? { open } : {}), ...(rescan ? { rescan: true } : {}), ...(entryPoints ? { entryPoints } : {}) });
  }

  /** FR-26.7 a package opens in place: its folders and classes take its place in the picture. */
  expandPackage(pkg: string): void {
    const app = this.app;
    if (!app?.level) return;
    const open = this.appOpen.get(app.level.path) ?? new Set<string>();
    open.add(pkg);
    this.appOpen.set(app.level.path, open);
    this.reloadApp();
  }

  /** FR-26.7 folds an open package again (and everything opened inside it). */
  collapsePackage(pkg: string | null): void {
    const app = this.app;
    if (!app?.level) return;
    const open = this.appOpen.get(app.level.path);
    if (!open) return;
    for (const p of [...open]) if (pkg === null || p === pkg || p.startsWith(`${pkg}/`)) open.delete(p);
    this.reloadApp();
  }

  /** The same folder again with other packages open: the picture stays where it is. */
  private reloadApp(): void {
    const app = this.app!;
    app.state = 'running';
    this.popups.close();
    this.updateAppBar();
    this.requestAppMap(app.level!.path);
    this.save();
  }

  /** FR-26.6 a violation picked from the legend: its folder opens (if it is not this one), its edge is outlined. */
  private pendingViolation: AppMapViolation | undefined;

  /**
   * the map's issues as a flow's: its design issues (project-wide, from the same walk), then every
   * dependency-rule violation of the map (FR-26.6) — the same ⚠ N button and list instead of a legend chip.
   */
  private mapIssues(): Finding[] {
    const level = this.app?.level;
    const design = (level?.findings ?? []).map((pf) => pf.finding);
    const violations = (level?.violationList ?? []).map((v, i): Finding => ({ id: `app-violation:${i}`, kind: 'layer-violation', title: `Layer violation: ${v.fromName} → ${v.toName}`, detail: v.violation, ...(v.possible ? { possible: v.possible } : {}) }));
    return [...design, ...violations];
  }

  /** FR-19.17 an issue picked from the map's ⚠ N: the same card as in a flow's class diagram. */
  private showMapIssue(f: Finding): void {
    const level = this.app?.level;
    if (f.kind === 'layer-violation') {
      const v = level?.violationList?.[Number(f.id.slice('app-violation:'.length))];
      if (v) this.showAppViolationCard(v);
      return;
    }
    // a design issue: its card here; Show in diagram opens its flow in the sequence diagram (as ⌂ ⚠ Design issues does)
    const pf = level?.findings?.find((x) => x.finding === f);
    if (!pf) return;
    this.highlightFinding(f.classKeys ?? [], f.relationIds ?? []);
    this.showFindingGuide(f, () => this.bridge.post({ type: 'openFinding', entryPoint: pf.entryPoint, finding: pf.finding }));
  }

  /** FR-12.16 a map violation: outlined at its folder, explained by the violation card (move a class, adjust the rule). */
  private showAppViolationCard(v: AppMapViolation): void {
    const show = () => this.showAppViolation(v);
    show();
    const side = (key: string, name: string, layer?: string, hint?: AppMapViolation['fromHint']): ViolationSide => ({
      key, name, ...(layer ? { layer } : {}), ...(hint ? { suggested: hint.suggested, reasons: hint.reasons, ...(hint.noMove ? { noMove: true } : {}) } : {}),
    });
    const card = violationCard(side(v.from, v.fromName, v.fromLayer, v.fromHint), side(v.to, v.toName, v.toLayer, v.toHint), v.violation, {
      show,
      move: (s) => this.layerScope.choose({ classKey: s.key, className: s.name }, s.suggested!, 120, 120),
      adjustRule: () => this.bridge.post({ type: 'openDependencyRule' }),
      close: () => this.popups.close(),
    }, this.fold(), undefined, v.possible);
    this.showGuide(card);
  }

  private showAppViolation(v: AppMapViolation): void {
    if (this.app?.level?.path === v.folder) return this.outlineAppViolation(v);
    this.pendingViolation = v;
    this.enterApp(v.folder);
  }

  /** The nodes drawn for the violation's two classes (the classes, or the packages holding them) and the edge between them. */
  private outlineAppViolation(v: AppMapViolation): void {
    const classes = this.diagram!.classes; // on the map, once its folder is drawn
    const nodeOf = (key: string) => classes.find((c) => c.key === key) ?? classes.find((c) => c.group && !c.group.external && key.startsWith(`${c.group.path}/`));
    const a = nodeOf(v.from);
    const b = nodeOf(v.to);
    const r = a && b ? this.diagram!.relations.find((x) => x.from === a.key && x.to === b.key) : undefined;
    this.highlightFinding([a?.key, b?.key].filter((k): k is string => !!k), r ? [r.id] : []);
  }

  /** ← Flow: the flow's classes again. */
  leaveApp(): void {
    if (!this.app) return;
    if (this.app.state === 'running') this.bridge.post({ type: 'cancelAppMap' });
    this.app = null;
    this.root.classList.remove('app-mode');
    this.appBar.hidden = true;
    this.positions = this.flowPositions;
    this.diagram = null;
    const msg = this.flowMsg!; // enterApp keeps the flow's message whenever the map opens
    this.flowMsg = null;
    this.handle(msg);
    this.updateToolbar();
  }

  private onAppMap(msg: Extract<HostToClassView, { type: 'appMap' }>): void {
    if (!this.app) return; // left the map meanwhile
    const app = this.app;
    app.state = msg.state;
    app.done = msg.done;
    app.total = msg.total;
    app.error = msg.error;
    if (msg.state === 'done' && msg.level) {
      const moved = msg.level.path !== app.level?.path;
      app.level = msg.level;
      app.path = msg.level.path;
      // what is open there, as the host found it (a folder that disappeared is dropped)
      this.appOpen.set(msg.level.path, new Set(msg.level.open ?? []));
      if (moved) this.positions = {};
      this.diagram = msg.level.diagram;
      this.placeholder.hidden = true;
      this.render();
      // another level of the map: fitted, not left at the last diagram's zoom
      if (moved) void this.settled().then(() => this.fit());
      if (moved) this.scrollTo(0, 0);
      this.save();
      const v = this.pendingViolation;
      this.pendingViolation = undefined;
      // drawn asynchronously (ELK): outlined once it is there
      if (v) void this.settled().then(() => this.outlineAppViolation(v));
    } else this.showAppProgress(); // it keeps the map of this folder while that folder is scanned again
    this.updateAppBar();
  }

  /** The placeholder while the entry points are scanned (or why the map is not there). */
  private showAppProgress(): void {
    const app = this.app!;
    if (app.level && app.level.path === app.path && this.diagram) return this.updateAppBar();
    this.canvas.textContent = '';
    this.svgEl = null;
    const text =
      app.state === 'error' ? `Codebase map: ${app.error ?? 'failed'}` :
      app.state === 'cancelled' ? 'Scan stopped — ↻ Rescan continues where it stopped' :
      app.total ? `Following every entry point… ${app.done ?? 0} / ${app.total}` : 'Finding the entry points…';
    this.showPlaceholder(text, app.state === 'running');
    this.updateAppBar();
  }

  /** The text in place of the diagram; FR-16.14 `busy` = a wait, with a spinner. */
  private showPlaceholder(text: string, busy = false): void {
    this.placeholder.hidden = false;
    this.placeholder.classList.toggle('busy', busy);
    const spinner = this.placeholder.querySelector('.spinner');
    if (busy && !spinner) this.placeholder.prepend(html('div', { class: 'spinner', 'aria-hidden': 'true' }));
    if (!busy) spinner?.remove();
    this.placeholder.querySelector('.placeholder-title')!.textContent = text;
  }

  /** Breadcrumb · totals · Rescan (or Stop while scanning) · ← Flow. */
  private updateAppBar(): void {
    const app = this.app!; // only on the map (leaveApp hides the bar)
    this.appBar.hidden = false;
    const level = app.level;
    const crumbs = (level?.crumbs ?? [{ label: 'Codebase', path: '' }]).flatMap((c, i, all) => {
      const last = i === all.length - 1 && level?.path === c.path;
      const el = last
        ? html('span', { class: 'app-crumb current' }, [c.label])
        : html('button', { type: 'button', class: 'app-crumb', 'data-app-path': c.path, title: `Open ${c.path || 'the top'}` }, [c.label]);
      return i ? [html('span', { class: 'app-sep', 'aria-hidden': 'true' }, ['›']), el] : [el];
    });
    const running = app.state === 'running';
    const stats = level
      ? `${level.entryPoints} entry point${level.entryPoints === 1 ? '' : 's'} · ${level.classes} classes · ${level.relations} relations${level.violations ? ` · ${level.violations} layer violation${level.violations === 1 ? '' : 's'}${level.possibleViolations ? ` (${level.possibleViolations} possible)` : ''}` : ''}`
      : '';
    const statsTitle = level
      ? [
          `The classes ${level.entryPoints === 1 ? 'the flow of 1 entry point reaches' : `the flows of ${level.entryPoints} entry points reach`} (tests excluded), each flow expanded fully; interfaces with several implementations: all of them.`,
          level.truncated ? `${level.truncated} flow${level.truncated > 1 ? 's' : ''} hit the expand limit (some calls stayed folded).` : '',
          level.failed ? `${level.failed} entry point${level.failed > 1 ? 's' : ''} could not be analysed.` : '',
          `Scanned ${new Date(level.computedAt).toLocaleString()}${level.rescanned ? ` (${level.rescanned} again now)` : ''}; a saved file re-scans the entry points that reach it.`,
        ].filter(Boolean).join('\n')
      : '';
    // FR-26.7 the packages open in place: ⊖ folds one (or all)
    const open = level?.open ?? [];
    // open packages come with a level and lie inside its folder
    const label = (p: string) => p.slice(level!.path ? level!.path.length + 1 : 0);
    const folds = open.length
      ? html('span', { class: 'app-open' }, [
          ...open.map((p) => html('button', { type: 'button', class: 'app-fold', 'data-app-fold': p, title: `Fold ${p} again` }, [`⊖ ${label(p)}`])),
          ...(open.length > 1 ? [html('button', { type: 'button', class: 'app-fold', 'data-app-fold': '*', title: 'Fold every open package' }, ['⊖ all'])] : []),
        ])
      : null;
    // FR-26.8 a map of some entry points only says so; ✕ All maps every entry point again
    const n = this.appSelection?.length ?? 0;
    const selection = n
      ? html('span', { class: 'app-selection', title: 'The map of the entry points selected in the ⌂ Entry points list' }, [
          `Map of ${n} entry point${n === 1 ? '' : 's'} `,
          html('button', { type: 'button', class: 'app-action', 'data-app-action': 'all', title: 'The map of every entry point' }, ['✕ All']),
        ])
      : null;
    this.appBar.replaceChildren(
      ...(selection ? [selection] : []),
      html('span', { class: 'app-crumbs' }, crumbs),
      ...(folds ? [folds] : []),
      html('span', { class: 'app-stats', title: statsTitle }, [running && app.total ? `scanning ${app.done ?? 0} / ${app.total}…` : stats]),
      running
        ? html('button', { type: 'button', class: 'app-action', 'data-app-action': 'stop', title: 'Stop scanning (what was scanned is kept)' }, ['■ Stop'])
        : html('button', { type: 'button', class: 'app-action', 'data-app-action': 'rescan', title: n ? 'Scan the selected entry points again' : 'Scan every entry point again' }, ['↻ Rescan']),
      html('button', { type: 'button', class: 'app-action', 'data-app-action': 'flow', title: "Back to the classes of the sequence diagram" }, ['← Flow']),
    );
  }

  private onAppBarClick(e: MouseEvent): void {
    const fold = closestWithData(e.target, 'app-fold')?.getAttribute('data-app-fold');
    if (fold) return this.collapsePackage(fold === '*' ? null : fold);
    const path = closestWithData(e.target, 'app-path')?.getAttribute('data-app-path');
    if (path !== null && path !== undefined) return this.enterApp(path);
    const action = closestWithData(e.target, 'app-action')?.getAttribute('data-app-action');
    if (action === 'flow') return this.leaveApp();
    if (action === 'all') {
      this.appSelection = undefined;
      this.appOpen.clear();
      return this.enterApp('');
    }
    if (action === 'stop') return this.bridge.post({ type: 'cancelAppMap' });
    if (action === 'rescan' && this.app) {
      this.app.state = 'running';
      this.updateAppBar();
      this.requestAppMap(this.app.path, true);
    }
  }

  /** On the map: a package opens (its header) or shows a class (its row); a class goes to its code; an edge lists its relations. */
  private onAppClick(e: MouseEvent): void {
    // FR-26.7 ⊖ on a box shown from an open package: fold it
    const fold = closestWithData(e.target, 'app-fold')?.getAttribute('data-app-fold');
    if (fold) return this.collapsePackage(fold);
    const n = this.nodeAt(e.target);
    if (n) {
      const member = this.memberAt(n.node, e.target);
      const range = member?.declaration ?? (n.node.group ? undefined : n.node.declaration);
      if (member && range) return this.bridge.post({ type: 'navigate', range });
      // FR-26.7 a package opens here; a folder beside this one (dashed) opens as its own map
      if (n.node.group) return n.node.group.external ? this.enterApp(n.node.group.path) : this.expandPackage(n.node.group.path);
      if (range) this.bridge.post({ type: 'navigate', range });
      return;
    }
    const relId = closestWithData(e.target, 'relation-id')?.getAttribute('data-relation-id');
    const r = relId ? this.diagram?.relations.find((x) => x.id === relId) : undefined;
    if (r) {
      this.highlightFinding([r.from, r.to], [r.id]);
      this.appRelationMenu(r, e.clientX, e.clientY);
    }
  }

  /** The relations an edge of the map stands for (one: straight to its code). */
  private appRelationMenu(r: ClassRelation, x: number, y: number): void {
    const calls = r.calls ?? [];
    if (calls.length === 1 && !r.count) {
      if (calls[0].callSite) this.bridge.post({ type: 'navigate', range: calls[0].callSite });
      return;
    }
    if (!calls.length) {
      const decl = this.diagram?.classes.find((c) => c.key === r.from)?.declaration;
      if (decl) this.bridge.post({ type: 'navigate', range: decl });
      return;
    }
    const more = (r.count ?? calls.length) - calls.length;
    this.popups.showMenu(
      [
        { label: r.count ? `${r.count} relation${r.count > 1 ? 's' : ''}${r.violation ? ` — ${cutFrom(r.violation, ':')}` : ''}` : `${calls.length} calls`, disabled: true },
        { separator: true, label: '' },
        ...calls.map((c, i): MenuItem => ({
          id: `app-relation:${i}`,
          label: c.label,
          hint: c.callSite ? formatLocation(c.callSite) : undefined,
          disabled: !c.callSite,
          action: () => c.callSite && this.bridge.post({ type: 'navigate', range: c.callSite }),
        })),
        ...(more > 0 ? [{ label: `+${more} more`, disabled: true }] : []),
      ],
      x,
      y,
    );
  }

  private appMenu(c: ClassNode, e: MouseEvent): void {
    const items: MenuItem[] = [];
    if (c.group && !c.group.external) items.push({ id: 'app-expand', label: `Open ${c.name} here`, hint: `${c.group.classes} classes`, action: () => this.expandPackage(c.group!.path) });
    if (c.group) items.push({ id: 'app-open', label: `Open ${c.name} as its own map`, action: () => this.enterApp(c.group!.path) });
    else if (c.declaration) items.push({ id: 'open', label: 'Go to declaration', action: () => this.bridge.post({ type: 'navigate', range: c.declaration! }) });
    // FR-26.7 shown because a package is open: fold it again
    const from = c.group?.in ?? c.inPackage;
    if (from) items.push({ id: 'app-collapse', label: `Fold ${from.split('/').pop()} again`, action: () => this.collapsePackage(from) });
    const up = this.app?.level?.crumbs.at(-2);
    if (up) items.push({ separator: true, label: '' }, { id: 'app-up', label: `Up to ${up.label}`, action: () => this.enterApp(up.path) });
    if (items.length) this.popups.showMenu(items, e.clientX, e.clientY);
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    const n = this.nodeAt(e.target);
    if (!n) return;
    e.preventDefault();
    this.drag = { key: n.key, startX: e.clientX, startY: e.clientY, cx: n.x + n.width / 2, cy: n.y + n.height / 2, moved: false };
  }

  private onMouseMove(e: MouseEvent): void {
    const d = this.drag;
    if (!d || !this.geometry) return;
    const dx = (e.clientX - d.startX) / this.zoom;
    const dy = (e.clientY - d.startY) / this.zoom;
    if (!d.moved && Math.hypot(dx, dy) * this.zoom < CLICK_SLOP) return;
    d.moved = true;
    const n = this.geometry.nodes.find((x) => x.key === d.key)!;
    const m = CLASS_LAYOUT.margin;
    this.positions = { ...this.positions, [d.key]: { x: Math.max(m + n.width / 2, d.cx + dx), y: Math.max(m + n.height / 2, d.cy + dy) } };
    this.render();
  }

  private onMouseUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.moved) return;
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    this.save();
  }
}

function classSet(d: ClassDiagram): string {
  return d.classes
    .map((c) => c.key)
    .sort()
    .join('\n');
}

export type LayoutEngine = 'elk' | 'dagre';

export interface ClassViewOptions {
  measureText?: MeasureText;
  /** Default 'elk'; 'dagre' lays out synchronously (also the fallback when ELK fails). */
  engine?: LayoutEngine;
}

export function startClassView(root: HTMLElement, bridge: ClassBridge, opts?: ClassViewOptions): ClassView {
  const view = new ClassView(root, bridge, opts);
  const guard = installDiagnostics(bridge, 'class view');
  const fail = (message: string) => view.handle({ type: 'empty', reason: `Rendering failed: ${message}` });
  bridge.onMessage((msg) =>
    guard(() => {
      view.handle(msg);
    }, fail),
  );
  guard(() => view.restore(bridge.getState<SavedState>()), fail);
  bridge.post({ type: 'ready' });
  return view;
}
