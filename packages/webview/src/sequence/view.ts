/** Sequence view controller: host messages in, DOM + intents out. */
import { categoryMenu } from '../hide-category';
import { backgroundOf, blobToBase64, copyPng, download, hostSaves, imageName, standaloneSvg, svgToPng, type ImagePart } from '../export-image';
import type {
  CallerInfo,
  EntryOutcome,
  ExitMarker,
  FlowOutcome,
  DiagramStateReport,
  DiagramOptions,
  HideFilterSpec,
  HostToSequenceView,
  Message,
  Participant,
  ParticipantPositions,
  SequenceDiagram,
  SequenceViewToHost,
  SourceRange,
  Finding,
  ZoomEnd,
} from '@seqcall/protocol';
import type { HostBridge } from '../bridge';
import { closestWithData, FLASH_MS, html, revealElements } from '../dom';
import { createCanvasMeasure, type MeasureText } from '../measure';
import { PopupLayer, type MenuItem } from '../menu';
import { HoverCard } from '../hover-card';
import { displayRoute, entryKey, entryPointsPanel, type EntryPointsState } from './entry-points';
import { designIssuesPanel, type DesignIssuesState } from './design-issues';
import { unreachablePanel, type UnreachableState } from './unreachable-panel';
import { pathsPanel, type PathsState } from './paths-panel';
import { SequenceFind } from './find';
import { reviewPanel, type ReviewState } from './review-panel';
import { flowChooser, reviewBar } from './review-bar';
import { changeStops, firstNumber, hasNumber, numbered, numberText, ownChange, reviewTour, type TourFlow } from './review-tour';
import { guardGhosts, renderGuardGhosts } from './guard-ghosts';
import { labelShift } from './sliding-labels';
import { bindFindKeys } from '../find-bar';
import { keysCard, legendCard } from './legend';
import { FINDING_ICON, findingCard, guideCard, guideOf, issueTitle, violationCard, type ViolationSide } from '../finding-guide';
import { issuesMenu } from '../issues-ui';
import { callerTitle, describeHideFilter, formatLocation, fullCallText, normalizeSource } from './labels';
import { filtersMenu, noExpand, noExpandRule } from '../filters-menu';
import { borrowedConfigBar, CONFIG_WRITES, copyText, onDiagramState, pasteStateCard, stateDetailsCard, stateMenuItems, stateSummary, writeBlockedCard } from './share-state';
import { layoutSequence, positionsOf, tidyPositions, type MessageGeom, type SequenceGeometry, type SequenceLayoutOptions } from './layout';
import { renderBody, renderHeader, rootDeclarationRange } from './render';
import { changedViewOptions, optionEnabled, Toolbar, VIEW_OPTIONS, type ToolbarCommand } from './toolbar';
import { markItems } from '../view-options';
import { installDiagnostics } from '../diagnostics';
import { layerHintMenu, layerMenuItems } from '../layer-hint';
import { layerReasonCard, whyLabel } from '../layer-reason';
import { LayerScopeChooser } from '../layer-scope';
import { SIDE_EFFECT_TAG, sideEffectLines } from '../side-effects';
import { layerClass, layerObjectRows, openLayerCount } from '../layers';
import { CLICK_SLOP, enablePan } from '../pan';
import { clampZoom, fitZoom, scaleSvg, scrollForZoom, stepZoom, wheelZoomFactor, ZoomControls, type ZoomCommand } from '../zoom';

export const EMPTY_TEXT = 'Pick an entry point to start, or place the cursor in a method and run Show Sequence Diagram';

export type SequenceBridge = HostBridge<HostToSequenceView, SequenceViewToHost>;

export interface SequenceViewOptions {
  measureText?: MeasureText;
  layout?: Partial<SequenceLayoutOptions>;
}

interface SavedState {
  lastRender?: { diagram: SequenceDiagram; positions?: ParticipantPositions };
  zoom?: number;
  /** FR-19.10 the reader folded the finding card last time: the next one opens folded. */
  findingCardFolded?: boolean;
  /** FR-24 the base branch of the last review. */
  reviewBase?: string;
  /** FR-24.13 the review's compare mode (absent: since the split). */
  reviewMode?: 'split' | 'direct';
}

interface DragState {
  id: string;
  startX: number;
  origX: number;
  frozen: ParticipantPositions;
  moved: boolean;
}

export class SequenceView {
  readonly toolbar: Toolbar;
  readonly scroll: HTMLElement;
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly placeholder: HTMLElement;
  /** FR-3.3 notice strip under the toolbar (Expand all stopped at a limit). */
  readonly noticeEl: HTMLElement;
  /** FR-25.3 a shared diagram's layer config is in use. */
  readonly borrowEl: HTMLElement;
  /** FR-24.9 the review bar (flows and changes) and the change ruler at the right edge. */
  readonly reviewBarEl: HTMLElement;
  readonly rulerEl: HTMLElement;
  /** FR-24.10 the review tour: its flows, the one opened last (and its root), the change the reviewer is at. */
  private tour: { key: string; flows: TourFlow[]; flowIndex: number; flowRoot?: string; currentId: string | null; pending?: 'flow' | 'change'; /** P at the first change opened the previous flow: its last change, not its first. */ toLast?: boolean; atEnd: boolean; /** FR-24.15 the number of the change shown (of the diagram's `reviewTotal`). */ position?: number; /** FR-24.9 a layer was opened for the changes folded into this call: select the first stop after it when the diagram arrives. */ afterId?: string } | null = null;
  readonly popups: PopupLayer;
  /** FR-7.12 Move to layer: what the rule covers (file / folder / name), asked after choosing the layer. */
  private readonly layerScope: LayerScopeChooser;
  readonly hoverCard: HoverCard;
  /** FR-9.7 scroll positions before each jump to a sender / receiver (Backspace returns). */
  private jumpBack: { left: number; top: number }[] = [];
  /** FR-9.7 the message under the mouse (the arrow keys jump to its receiver / sender). */
  private hoveredMessageId: string | null = null;
  /**
   * FR-9.7 after a jump the keys stay with the message jumped along (marked), though the scroll put something
   * else under the pointer — until the mouse really moves (from where it was at the jump).
   */
  private jumped: { messageId: string; x: number; y: number } | null = null;
  /** FR-9.9 the message the keyboard walks from (↓ ↑, Enter, Space, + / −): outlined, kept across renders while drawn. */
  private selectedId: string | null = null;
  private pointer = { x: 0, y: 0 };
  readonly zoomControls: ZoomControls;
  zoom = 1;
  private lastRender: SavedState['lastRender'];
  private headerSvg: SVGSVGElement | null = null;
  private bodySvg: SVGSVGElement | null = null;

  diagram: SequenceDiagram | null = null;
  geometry: SequenceGeometry | null = null;
  positions: ParticipantPositions = {};
  /** Highlighted messages (one from the editor cursor, or several from a class-diagram relation). */
  private highlightIds: string[] = [];
  private callers: { messageId: string; x: number; y: number } | null = null;
  /** FR-4.4: the callers panel survives the re-render that answers "Include tests". */
  private reopenCallers: { messageId: string; callers: CallerInfo[] } | null = null;
  /** FR-25.2 the report of the shared state opened last, shown while its root is the diagram's. */
  private stateNotice: { report: DiagramStateReport; rootKey: string } | null = null;
  /** FR-23 the find bar and its matches. */
  readonly find: SequenceFind;
  /** FR-22 the last paths-to-here search (its panel, where it was opened). */
  private paths: (PathsState & { x: number; y: number }) | null = null;
  private drag: DragState | null = null;
  /** FR-16.2 entry-point list (kept while the panel lives; refreshed on every open). */
  private entryPoints: EntryPointsState | null = null;
  /** FR-32.4 the outcomes known by `entryKey` (the flows opened, the project scan), for the entry-point list. */
  private outcomes: Record<string, EntryOutcome> = {};
  /** FR-19.9 the last project-wide design-issue scan (shown by the panel). */
  private designIssues: DesignIssuesState | null = null;
  /** FR-31 the unreachable-code scan as the panel shows it. */
  private unreachable: UnreachableState | null = null;
  private entryPointsAt = { x: 40, y: 40 };
  private suppressClick = false;
  private renderPending = false;
  private readonly measure: MeasureText;

  constructor(
    readonly root: HTMLElement,
    private readonly bridge: SequenceBridge,
    private readonly opts: SequenceViewOptions = {},
  ) {
    this.measure = opts.measureText ?? createCanvasMeasure(root.ownerDocument);
    root.classList.add('seqcall', 'seqcall-sequence');
    root.textContent = '';
    this.toolbar = new Toolbar((cmd, btn) => this.onToolbar(cmd, btn));
    this.zoomControls = new ZoomControls((cmd) => this.onZoomCommand(cmd), 'Fit the diagram width into the view');
    this.zoomControls.update(this.zoom, false);
    this.header = html('div', { class: 'seq-header' });
    this.body = html('div', { class: 'seq-body' });
    this.placeholder = html('div', { class: 'placeholder', role: 'status' });
    this.noticeEl = html('div', { class: 'expand-notice', role: 'status' });
    this.noticeEl.hidden = true;
    this.borrowEl = html('div', { class: 'expand-notice borrowed-config', role: 'status' });
    this.borrowEl.hidden = true;
    this.reviewBarEl = html('div', { class: 'review-bar-host' });
    this.reviewBarEl.hidden = true;
    this.rulerEl = html('div', { class: 'change-ruler', 'aria-label': 'Changes in this diagram' });
    this.rulerEl.hidden = true;
    this.scroll = html('div', { class: 'seq-scroll', tabindex: 0 }, [this.header, this.body, this.placeholder]);
    root.append(this.toolbar.element, this.reviewBarEl, this.borrowEl, this.noticeEl, this.scroll, this.zoomControls.element, this.rulerEl);
    this.bindReviewKeys(root.ownerDocument);
    this.popups = new PopupLayer(root);
    this.layerScope = new LayerScopeChooser(this.popups, (m) => this.post(m));
    // FR-23 find bar (Ctrl+F, /, ⌕)
    this.find = new SequenceFind({
      root,
      body: this.body,
      header: this.header,
      scroll: this.scroll,
      diagram: () => this.diagram,
      geometry: () => this.geometry,
      zoom: () => this.zoom,
      post: (msg) => this.post(msg),
      highlight: (ids) => this.setHighlight(ids),
    });
    bindFindKeys(root.ownerDocument, () => this.find.open());
    this.hoverCard = new HoverCard(root);
    this.hoverCard.attach(this.body, (t) => {
      // no card over an open menu or panel (it would cover the menu the user is reading)
      if (this.popups.element) return null;
      // glyphs and badges keep their own short native tooltips
      if (t.closest('.expand-glyph, .poly-badge, .finding-mark')) return null;
      const exitEl = t.closest('[data-exit-id]');
      const exit = exitEl && this.diagram?.exits?.find((x) => x.id === exitEl.getAttribute('data-exit-id'));
      if (exitEl && exit) return { anchor: exitEl, body: exitCard(exit, root.ownerDocument) };
      const anchor = t.closest('[data-msg-id]');
      const m = anchor && this.message(anchor.getAttribute('data-msg-id'));
      // a drawn message: there is a diagram
      return anchor && m ? { anchor, body: messageCard(m, root.ownerDocument, this.diagram!) } : null;
    }, {
      // FR-9.6: while a message's card is shown, its sender and receiver are marked in the frozen header
      shown: (anchor) => {
        const m = this.message(msgIdOf(anchor));
        for (const id of [m?.from, m?.to]) if (id) this.headerBox(id)?.classList.add('hover-end');
      },
      hidden: () => this.header.querySelectorAll('.hover-end').forEach((el) => el.classList.remove('hover-end')),
      // FR-9.7 a click on a chip scrolls to that object
      interactive: true,
    });
    this.hoverCard.element.addEventListener('click', (e) => {
      // FR-28.10 an object behind a layer lifeline: pull it out onto its own lifeline (FR-28.8)
      const pull = (e.target as Element | null)?.closest?.('[data-pull]')?.getAttribute('data-pull');
      if (pull) {
        this.hoverCard.hide();
        this.post({ type: 'setLayerOpen', layer: pull, open: true });
        return;
      }
      // FR-32.2 a call of the entry point's outcome: open its line
      const nav = (e.target as Element | null)?.closest?.('[data-nav]')?.getAttribute('data-nav');
      if (nav) {
        this.hoverCard.hide();
        this.post({ type: 'navigate', range: JSON.parse(nav) });
        return;
      }
      const chip = (e.target as Element | null)?.closest?.('[data-jump]');
      const id = chip?.getAttribute('data-participant-id');
      // a chip is clicked on a shown card (the tour's card hangs on the message's label)
      if (id) this.jumpTo(id, msgIdOf(this.hoverCard.anchor));
    });
    this.body.addEventListener('mouseover', (e) => {
      this.hoveredMessageId = (e.target as Element).closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null;
    });
    this.body.addEventListener('mouseleave', () => (this.hoveredMessageId = null));
    root.ownerDocument.defaultView!.addEventListener('mousemove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      // a scroll can report a move without one: only a real move (a few pixels) lets go of the jumped message
      if (this.jumped && Math.hypot(e.clientX - this.jumped.x, e.clientY - this.jumped.y) > 4) this.releaseJumped();
    });
    this.bindJumpKeys(root.ownerDocument);
    // before the history keys: an Escape that closes Find does not also clear the selection
    this.bindWalkKeys(root.ownerDocument);
    this.bindHistoryKeys(root.ownerDocument);
    this.showPlaceholder('empty', EMPTY_TEXT);

    this.scroll.addEventListener('click', (e) => this.onClick(e));
    this.scroll.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.header.addEventListener('mousedown', (e) => this.onHeaderMouseDown(e));
    const win = root.ownerDocument.defaultView!;
    win.addEventListener('mousemove', (e) => this.onMouseMove(e));
    win.addEventListener('mouseup', () => this.onMouseUp());
    this.scroll.addEventListener('scroll', () => {
      this.popups.closeOnViewChange();
      this.hoverCard.hide();
      this.scheduleGhosts();
    });
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // Participant heads in the frozen header have their own horizontal drag (FR-10.1).
    enablePan(this.scroll, { isDraggable: (t) => !!closestWithData(t, 'participant-id') && this.header.contains(t as Node) });
    // FR-24.9 the change ruler follows the panel's right edge (sidebar closed, split moved); FR-1.16 the guard
    // copies too — a wider panel shows the real guard, so its copy must go
    if (win.ResizeObserver) {
      new win.ResizeObserver(() => {
        this.placeRuler();
        this.scheduleGhosts();
      }).observe(this.scroll);
    }
  }

  /** the calls drawn and opened when ✦ Overview was asked for (undefined: not asked). */
  private overviewFrom: string | undefined;

  private post(msg: SequenceViewToHost): void {
    // FR-25.3 the shared diagram's config is in use: the project's file is not written meanwhile
    if (CONFIG_WRITES.has(msg.type) && this.diagram?.borrowedConfig) {
      const r = this.root.getBoundingClientRect();
      this.popups.show(writeBlockedCard(() => this.useOwnConfig()), Math.max(8, r.left + 40), Math.max(8, r.top + 40));
      return;
    }
    // FR-10.3 an expand / collapse: tidy up when its diagram arrives
    if (EXPANDING.has(msg.type)) this.tidyAfterRender = true;
    // Overview of the whole flow: say so when it changes nothing
    if (msg.type === 'smartExpand' && !msg.more && !msg.view && !msg.messageId && this.diagram) this.overviewFrom = openedCalls(this.diagram);
    // FR-3.8 an expand the user started: remember what was shown, to bring the new calls into view
    if (OPENING.has(msg.type) && this.diagram) this.shownBefore = new Set(this.diagram.messages.map((m) => m.id));
    // another implementation: the call it swapped is brought into view and marked a moment
    if (msg.type === 'selectImplementation' || msg.type === 'revertImplementation') this.swapped = msg.messageId;
    this.bridge.post(msg);
  }

  /** the call whose implementation was just switched (until its diagram arrives). */
  private swapped: string | null = null;

  /** the switched call: scrolled to when off screen, and marked for a moment (the interface lifeline went away). */
  private revealSwapped(): void {
    const id = this.swapped;
    this.swapped = null;
    const mg = id ? this.geometry?.messages.find((m) => m.id === id) : undefined;
    if (!mg) return;
    const box = messageFocusBox(mg, this.scroll.clientWidth / this.zoom);
    if (!this.onScreen(box)) this.scrollIntoView(box);
    const el = [...this.body.querySelectorAll('.message[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
    el.classList.add('just-swapped');
    setTimeout(() => el.classList.remove('just-swapped'), 1500);
  }

  /** FR-3.8 the calls shown before the user's last expand (until its diagram arrives). */
  private shownBefore: Set<string> | null = null;

  /**
   * FR-3.8 after an expand: when none of the new calls is on screen (they opened below the fold or far to the right),
   * scroll to the first of them, sideways too. A new call already in sight: nothing moves (the ⊕ stays under the mouse).
   */
  private revealNewCalls(): void {
    const before = this.shownBefore;
    this.shownBefore = null;
    const g = this.geometry;
    if (!before || !g) return;
    const added = g.messages.filter((mg) => !before.has(mg.message.id));
    if (!added.length) return;
    const width = this.scroll.clientWidth / this.zoom;
    if (added.some((mg) => this.onScreen(messageFocusBox(mg, width)))) return;
    this.scrollIntoView(messageFocusBox(added[0], width));
    this.updateGhosts();
  }

  /** Whether any part of a body box (diagram units) is in the scrolled view, below the sticky header. */
  private onScreen(box: { x: number; y: number; width: number; height: number }): boolean {
    const s = this.scroll;
    const z = this.zoom;
    const viewH = s.clientHeight - this.geometry!.headerHeight * z; // after a render (revealNewCalls)
    if (viewH <= 0 || s.clientWidth <= 0) return true; // not laid out (hidden panel): nothing to judge
    const [x, y, w, h] = [box.x * z, box.y * z, box.width * z, box.height * z];
    return x + w > s.scrollLeft && x < s.scrollLeft + s.clientWidth && y + h > s.scrollTop && y < s.scrollTop + viewH;
  }

  /** FR-10.3 the next render of the same root comes from an expand / collapse: tidy it up. */
  private tidyAfterRender = false;

  /**
   * FR-10.5 the ⊕ / ⊖ just clicked and where it was on screen: when the diagram comes back (expanded, tidied),
   * the view scrolls so that the same glyph is at the same place — under the mouse, ready for the next click.
   */
  private anchor: { messageId?: string; fragmentId?: string; x: number; y: number } | null = null;

  private glyphOf(target: { messageId?: string; fragmentId?: string }): Element | null {
    if (target.messageId) {
      const el = [...this.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === target.messageId);
      return el?.querySelector('.expand-glyph') ?? el?.querySelector('.msg-label') ?? null;
    }
    const frag = [...this.body.querySelectorAll('[data-fragment-id]')].find((e) => e.getAttribute('data-fragment-id') === target.fragmentId);
    return frag?.querySelector('.frag-toggle') ?? null;
  }

  private anchorAt(target: { messageId?: string; fragmentId?: string }, el?: Element | null): void {
    // a fragment's toggle is passed; a call's menu offers Expand / Collapse only where its ⊕ / ⊖ is drawn
    const g = (el ?? this.glyphOf(target))!;
    const r = g.getBoundingClientRect();
    this.anchor = { ...target, x: r.left, y: r.top };
  }

  /** Scrolls so that the anchored glyph is where it was (twice: sliding labels may move it after the first scroll). */
  private restoreAnchor(): void {
    const a = this.anchor;
    this.anchor = null;
    if (!a) return;
    for (let i = 0; i < 2; i++) {
      const g = this.glyphOf(a);
      if (!g) return;
      const r = g.getBoundingClientRect();
      const dx = r.left - a.x;
      const dy = r.top - a.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      this.scroll.scrollLeft += dx;
      this.scroll.scrollTop += dy;
      this.updateGhosts();
    }
  }

  // ───────────────────────── host messages ─────────────────────────

  handle(msg: HostToSequenceView): void {
    switch (msg.type) {
      case 'render': {
        const sameRoot = this.diagram?.root.key === msg.diagram.root.key;
        // Fold layers on / off changes the width by far: the old fit's zoom no longer fits
        const refit = sameRoot && optionEnabled(this.diagram!.options, 'layerZoom') !== optionEnabled(msg.diagram.options, 'layerZoom');
        // FR-10.3 the hide rules changed (here or in the class diagram): participants come and go
        const rules = (d: SequenceDiagram) => d.hiddenFilters.map((h) => h.filter.id).sort((a, b) => Number(a > b) - Number(a < b)).join('|');
        const hidingChanged = !!this.diagram && rules(this.diagram) !== rules(msg.diagram);
        // FR-10.3 the objects at the top changed, whatever caused it (an expand by the host for a review, the class
        // diagram, Back / Forward, an implementation, an option…); switching to another root: when its saved arrangement
        // lacks some of them (the first render of a panel shows what was saved)
        const lineup = (d: SequenceDiagram | null) => d?.participants.map((p) => p.id).join('|');
        const lineupChanged = sameRoot ? lineup(this.diagram) !== lineup(msg.diagram) : !!this.diagram && !!msg.positions && msg.diagram.participants.some((p) => msg.positions![p.id] === undefined);
        this.positions = msg.positions ?? (sameRoot ? this.positions : {});
        this.diagram = msg.diagram;
        // FR-32.4 the outcome of an entry point opened: its row in the lists shows it
        if (msg.diagram.outcome) for (const e of msg.diagram.entryPoints ?? []) this.outcomes[entryKey(e)] = { kinds: msg.diagram.outcome.io.map((k) => k.kind), ...(msg.diagram.outcome.atLeast ? { atLeast: true as const } : {}) };
        this.highlightIds = this.highlightIds.filter((id) => msg.diagram.messages.some((m) => m.id === id));
        this.lastRender = { diagram: msg.diagram, positions: msg.positions ?? this.positions };
        this.persist();
        // FR-14.2: the View menu stays open while options are toggled (its check marks follow the render)
        // (a guide card stays: a background re-render, e.g. new I/O badges, must not close it)
        if (!this.popups.refresh('view', this.viewMenu())) this.popups.closeOnViewChange();
        this.hoverCard.hide();
        this.render();
        if (refit) this.fit();
        // another flow: the last flow's query goes
        if (!sameRoot) this.find.bar.close();
        this.find.onDiagram();
        // FR-10.3 tidy up after expand / collapse, after hiding and whenever the objects changed (keeps their order, packs them together)
        const tidy = (sameRoot && (this.tidyAfterRender || hidingChanged)) || lineupChanged;
        this.tidyAfterRender = false;
        if (tidy && optionEnabled(msg.diagram.options, 'autoTidy')) this.tidyUp();
        // FR-10.5 the clicked ⊕ / ⊖ stays under the mouse
        if (sameRoot) this.restoreAnchor();
        else this.anchor = null;
        // FR-3.8 … unless that leaves every new call off screen
        if (sameRoot) this.revealNewCalls();
        else this.shownBefore = null;
        this.revealSwapped();
        if (this.overviewFrom !== undefined) {
          if (sameRoot && openedCalls(msg.diagram) === this.overviewFrom) this.flash(this.toolbar.button('smartExpand'), 'Nothing changed: Overview already shows the important calls');
          this.overviewFrom = undefined;
        }
        this.updateReviewBar();
        if (this.reopenCallers) {
          const { messageId, callers } = this.reopenCallers;
          this.reopenCallers = null;
          const m = this.message(messageId);
          if (m) this.popups.show(this.callersPanel(m, callers), this.callers?.x ?? 40, this.callers?.y ?? 40);
        }
        break;
      }
      case 'empty':
        this.clearDiagram();
        this.showPlaceholder('empty', EMPTY_TEXT, msg.reason && msg.reason !== EMPTY_TEXT ? msg.reason : undefined);
        break;
      case 'error':
        this.clearDiagram();
        this.showPlaceholder('error', 'Could not draw the sequence diagram', msg.message);
        break;
      case 'openPanel': {
        // from a class method row: the same panel as from the message's own menu, in the corner
        const m = this.message(msg.messageId);
        if (!m) break;
        if (msg.panel === 'callers') this.requestCallers(m, 40, 40);
        else this.requestPaths(m, 40, 40);
        break;
      }
      case 'busy':
        // FR-16.14 over the previous diagram (if any) until the next render, empty or error
        this.showPlaceholder('busy', msg.text);
        break;
      case 'highlight':
        // FR-24.9 / FR-24.10 the change a step of the review tour revealed, or the first change of the flow it opened
        if (this.tour?.pending && !msg.finding && msg.messageId) {
          if (this.tour.pending === 'flow') this.tour.flowRoot = this.diagram?.root.key;
          this.tour.pending = undefined;
          if (this.tour.toLast) {
            this.tour.toLast = false;
            this.lastChange(msg.messageId);
          } else this.selectChange(msg.messageId);
          break;
        }
        if (!msg.finding && this.find.onHighlight(msg.messageId)) break; // FR-23.3 a revealed match
        // FR-28.4 zoomed to layers, the host's copy of an issue names folded calls and classes: the diagram's own copy
        // (same id) has the evidence as drawn (the calls folded into, the lifelines)
        if (msg.finding) this.revealFinding(this.diagram?.findings?.find((f) => f.id === msg.finding!.id) ?? msg.finding);
        else this.setHighlight(msg.messageIds ?? (msg.messageId ? [msg.messageId] : []));
        break;
      case 'callers':
        this.showCallers(msg.messageId, msg.callers);
        break;
      case 'searchResults':
        this.find.onResults(msg);
        break;
      case 'openFind':
        this.find.open(msg.query);
        break;
      case 'layerScopes':
        this.layerScope.onScopes(msg.classKey, msg.scopes);
        break;
      case 'diagramState':
      case 'diagramText': { // FR-25.4 the same answer: copied by the host (VS Code) or here
        const btn = this.toolbar.element.querySelector<HTMLButtonElement>('[data-cmd=image]');
        void onDiagramState(msg, { flash: (t) => btn && this.flash(btn, t), card: (el) => this.showStateCard(el) });
        break;
      }
      case 'stateReport':
        this.onStateReport(msg.report, msg.error);
        break;
      case 'openStatePrompt':
        this.openStatePrompt();
        break;
      case 'paths': {
        // FR-22 progress / result of the walk the panel asked for
        const p = this.paths;
        if (!p || p.messageId !== msg.messageId) break;
        Object.assign(p, { state: msg.state, methods: msg.methods ?? p.methods, tree: msg.tree, truncated: msg.truncated, error: msg.error, open: undefined });
        if (this.root.querySelector('.paths-panel')) this.renderPaths();
        break;
      }
      case 'gitRefs':
        // FR-24.13 the picker's lists (an open list keeps its typed filter: only an idle panel is redrawn)
        this.review = { ...this.review, refs: msg.refs, refsError: msg.error };
        if (this.root.querySelector('.review-panel') && !this.root.querySelector('.review-panel .rv-picker:not([hidden])')) this.renderReview();
        break;
      case 'review':
        // FR-24 progress / result of the review (also started by the host's command)
        this.review = { ...this.review, state: msg.state, phase: msg.phase, done: msg.done, total: msg.total, error: msg.error, result: msg.state === 'done' ? msg.result : undefined };
        if (msg.show || this.root.querySelector('.review-panel')) this.renderReview();
        // FR-24.10 a (new) result: its tour; the same result shown again keeps where the reviewer is
        if (msg.state === 'done' && msg.result?.files.length) {
          const key = msg.result.computedAt ?? JSON.stringify(msg.result.methods.map((m) => m.method.key));
          if (this.tour?.key !== key) this.tour = { key, flows: reviewTour(msg.result), flowIndex: -1, currentId: null, atEnd: false };
        } else if (msg.state !== 'running') this.tour = null;
        this.updateReviewBar();
        break;
      case 'unreachable':
        // FR-31 progress / result of the unreachable-code scan; the filter stays
        this.unreachable = { state: msg.state, phase: msg.phase, done: msg.done, total: msg.total, result: msg.result, project: msg.project ?? this.unreachable?.project, error: msg.error, filter: this.unreachable?.filter };
        if (msg.show || this.root.querySelector('.unreachable-panel')) this.renderUnreachable();
        break;
      case 'projectFindings': {
        // FR-19.9 progress / result of the project-wide scan
        // FR-19.23 the entry points' findings stay on while the methods none reaches are scanned
        const kept = msg.state === 'running' && this.designIssues?.state === 'running' ? this.designIssues.findings : undefined;
        // FR-32.4 every scanned flow's outcome (and the ones opened): pills and `has:` in the entry-point list
        if (msg.outcomes) this.outcomes = { ...this.outcomes, ...msg.outcomes };
        this.designIssues = { state: msg.state, done: msg.done, total: msg.total, findings: msg.findings ?? kept, ...(msg.walking ? { walking: true } : {}), project: msg.project ?? this.designIssues?.project, error: msg.error, ...(msg.truncated ? { truncated: msg.truncated } : {}), ...(msg.unreached ? { unreached: msg.unreached } : {}), ...(msg.changed ? { changed: true } : {}) };
        if (msg.show || this.root.querySelector('.design-issues-panel')) this.renderDesignIssues();
        break;
      }
      case 'entryPoints': {
        const state = this.entryPoints ?? { filter: '', open: {} };
        this.entryPoints = { ...state, entryPoints: msg.error ? undefined : msg.entryPoints, project: msg.project, error: msg.error, canSwitchProject: msg.canSwitchProject, tree: msg.tree };
        if (msg.show || this.root.querySelector('.entry-points-panel')) this.renderEntryPoints();
        break;
      }
      case 'methodResults':
        // FR-16.15 the ⌂ filter's methods: shown when the filter still asks for them (an older answer is dropped)
        if (this.entryPoints?.methods?.query !== msg.query) break;
        this.entryPoints.methods = { query: msg.query, methods: msg.methods, more: msg.more };
        this.root.querySelector('.ep-search')?.closest('.entry-points-panel')?.dispatchEvent(new Event('methods'));
        break;
    }
  }

  private clearDiagram(): void {
    this.diagram = null;
    this.geometry = null;
    this.highlightIds = [];
    this.dimFor = null;
    this.popups.close();
    this.lastRender = undefined;
    this.persist();
    this.header.textContent = '';
    this.body.textContent = '';
    this.headerSvg = this.bodySvg = null;
    this.toolbar.update(null);
    this.noticeEl.hidden = true;
    this.zoomControls.update(this.zoom, false);
  }

  private persist(): void {
    this.bridge.setState<SavedState>({ lastRender: this.lastRender, zoom: this.zoom, ...(this.cardFolded ? { findingCardFolded: true } : {}), ...(this.baseChosen ? { reviewBase: this.review.base } : {}), ...(this.review.mode === 'direct' ? { reviewMode: 'direct' as const } : {}) });
  }

  /** FR-19.10 the finding card opens folded / unfolded as the reader left the last one. */
  private cardFolded = false;

  restoreCardFolded(folded: boolean | undefined, reviewBase?: string, reviewMode?: 'split' | 'direct'): void {
    this.cardFolded = !!folded;
    if (reviewBase) this.review.base = reviewBase;
    if (reviewMode) this.review.mode = reviewMode;
    this.baseChosen = !!reviewBase;
  }

  // ───────────────────────── review of a branch (FR-24) ─────────────────────────

  private review: ReviewState = { state: 'idle', base: 'develop' };

  /** a base was picked here once (a review ran): opening the panel reviews against it right away. */
  private baseChosen = false;

  /**
   * FR-24 the review panel; opened from ⌂ it starts a review right away against the remembered base — the first
   * time (no base picked yet) it waits with the picker open, so a long review against a guessed base is not started.
   */
  showReview(run = true): void {
    // FR-24.13 the picker's lists, read once per panel opening (branches change)
    this.post({ type: 'requestGitRefs' });
    if (run && this.baseChosen && this.review.state !== 'running') this.runReview(this.review.base, false, this.review.mode);
    else this.renderReview();
  }

  private runReview(base: string, force = false, mode = this.review.mode ?? 'split'): void {
    this.baseChosen = true;
    this.review = { state: 'running', base, mode, refs: this.review.refs, refsError: this.review.refsError, phase: 'Reading the changes (git)' };
    this.persist();
    this.post({ type: 'requestReview', base, mode, ...(force ? { force: true } : {}) });
    this.renderReview();
  }

  private renderReview(): void {
    const panel = reviewPanel(this.review, {
      run: (base, force, mode) => this.runReview(base, force, mode),
      cancel: () => this.post({ type: 'cancelReview' }),
      end: () => {
        this.review = { state: 'idle', base: this.review.base, mode: this.review.mode, refs: this.review.refs };
        this.tour = null;
        this.updateReviewBar();
        this.popups.close();
        this.post({ type: 'endReview' });
      },
      openIssue: (issue) => {
        this.popups.close();
        this.post({ type: 'openReviewIssue', issue });
      },
      openStructure: (row) => {
        if (!row.entryPoint || row.kind === 'entry-removed') return;
        this.popups.close();
        this.post({ type: 'openReviewStructure', row });
      },
      openPath: (steps, entryPoint) => {
        this.popups.close();
        this.post(entryPoint ? { type: 'openPath', steps, entryPoint } : { type: 'openPath', steps });
      },
      copy: (text) => copyText(text),
    });
    const before = this.root.querySelector('.review-panel .ep-list')?.scrollTop ?? 0;
    // sticky: the host redraws the diagram with the change marks right after the result (FR-24.4)
    this.popups.show(panel, this.entryPointsAt.x, this.entryPointsAt.y, { sticky: true });
    const list = panel.querySelector('.ep-list');
    if (list) list.scrollTop = before;
  }

  /** Restores the persisted zoom (before the first render). */
  restoreZoom(z: number | undefined): void {
    if (z !== undefined) this.zoom = clampZoom(z);
  }

  private showPlaceholder(kind: 'empty' | 'error' | 'busy' | 'none', title?: string, detail?: string): void {
    this.placeholder.className = `placeholder ${kind}`;
    this.placeholder.textContent = '';
    this.placeholder.hidden = kind === 'none';
    if (kind === 'none') return;
    // FR-16.14 a wait shows a spinner (still with reduced motion) and is announced
    if (kind === 'busy') this.placeholder.appendChild(html('div', { class: 'spinner', 'aria-hidden': 'true' }));
    this.placeholder.appendChild(html('div', { class: 'placeholder-title' }, [title!])); // every shown placeholder has a title
    if (detail) this.placeholder.appendChild(html('div', { class: 'placeholder-detail' }, [detail]));
    if (kind === 'empty') {
      const find = html('button', { type: 'button', class: 'placeholder-action', 'data-cmd': 'find-entry-points' }, ['⌂ Find entry points']);
      find.addEventListener('click', () => {
        const r = find.getBoundingClientRect();
        this.showEntryPoints(r.left, r.bottom + 4);
      });
      this.placeholder.appendChild(find);
      // FR-25.2 someone sent a diagram: open it without drawing one first
      const shared = html('button', { type: 'button', class: 'placeholder-action', 'data-cmd': 'open-state' }, ['Open a shared diagram…']);
      shared.addEventListener('click', () => this.openStatePrompt());
      this.placeholder.appendChild(shared);
    }
  }

  /** FR-16.2: opens the entry-point list (asks the host every time; the last list shows meanwhile). */
  showEntryPoints(x: number, y: number): void {
    this.entryPointsAt = { x, y };
    this.entryPoints ??= { filter: '', open: {} };
    if (this.entryPoints.error) this.entryPoints = { filter: this.entryPoints.filter, open: this.entryPoints.open };
    this.post({ type: 'requestEntryPoints' });
    this.renderEntryPoints();
  }

  private renderEntryPoints(): void {
    const state = this.entryPoints!;
    state.outcomes = this.outcomes;
    const panel = entryPointsPanel(state, {
      open: (e) => {
        this.popups.close();
        this.post({ type: 'openMethod', methodKey: e.method.key, entryPoint: e });
        // the first diagram of a project takes seconds; without this the click looks lost
        this.showPlaceholder('busy', `Building the diagram of ${e.kind === 'http' ? displayRoute(e.label) : e.label}…`);
      },
      changed: () => undefined,
      searchMethods: (query) => this.post({ type: 'searchMethods', query }),
      openMethod: (m) => {
        this.popups.close();
        this.post({ type: 'openMethod', methodKey: m.key });
        this.showPlaceholder('busy', `Building the diagram of ${m.owner.kind === 'module' ? m.name : `${m.owner.name}.${m.name}`}…`);
      },
      designIssues: () => this.showDesignIssues(),
      unreachable: () => this.showUnreachable(),
      review: () => this.showReview(),
      appMap: (entryPoints) => {
        this.popups.close();
        this.post({ type: 'openAppMap', ...(entryPoints?.length ? { entryPoints } : {}) });
      },
      switchProject: () => this.post({ type: 'switchEntryPointsProject' }),
    });
    this.popups.show(panel, this.entryPointsAt.x, this.entryPointsAt.y);
    // opened low on the page (the empty state's button): the list scrolls inside the window, its last rows reachable
    panel.style.maxHeight = `${Math.max(160, Math.min(520, window.innerHeight - Number.parseFloat(panel.style.top) - 8))}px`;
    (panel.querySelector('.ep-search') as HTMLInputElement | null)?.focus();
  }

  /**
   * FR-19.9: asks the host for the project-wide scan (cached there) and shows the panel.
   */
  showDesignIssues(rescan = false): void {
    if (rescan || this.designIssues?.state !== 'done') this.designIssues = { state: 'running', project: this.designIssues?.project ?? this.entryPoints?.project };
    this.post(rescan ? { type: 'requestProjectFindings', rescan } : { type: 'requestProjectFindings' });
    this.renderDesignIssues();
  }

  /** FR-31: asks the host for the unreachable-code scan (cached there until a file changes) and shows the panel. */
  showUnreachable(rescan = false): void {
    if (rescan || this.unreachable?.state !== 'done') this.unreachable = { state: 'running', project: this.unreachable?.project ?? this.entryPoints?.project, filter: this.unreachable?.filter };
    this.post(rescan ? { type: 'requestUnreachable', rescan } : { type: 'requestUnreachable' });
    this.renderUnreachable();
  }

  private renderUnreachable(): void {
    const state = this.unreachable!; // showUnreachable and the host's answer set it first
    const panel = unreachablePanel(state, {
      copy: (text) => copyText(text),
      open: (u) => {
        this.popups.close();
        if (u.method.declaration) this.post({ type: 'navigate', range: u.method.declaration });
      },
      cancel: () => this.post({ type: 'cancelUnreachable' }),
      rescan: () => this.showUnreachable(true),
      filter: (text) => {
        state.filter = text;
        this.renderUnreachable();
        // typing goes on in the new box
        const box = this.root.querySelector('.unreachable-panel .ep-search') as HTMLInputElement | null;
        box?.focus();
        box?.setSelectionRange(text.length, text.length);
      },
    });
    this.popups.show(panel, this.entryPointsAt.x, this.entryPointsAt.y);
  }

  private renderDesignIssues(): void {
    const state = this.designIssues!; // showDesignIssues and the host's answer set it first
    const panel = designIssuesPanel(state, {
      copy: (text) => copyText(text),
      open: (f) => {
        this.popups.close();
        this.post({ type: 'openFinding', entryPoint: f.entryPoint, finding: f.finding });
      },
      cancel: () => this.post({ type: 'cancelProjectFindings' }),
      rescan: () => this.showDesignIssues(true),
    });
    this.popups.show(panel, this.entryPointsAt.x, this.entryPointsAt.y);
  }

  // ───────────────────────── rendering ─────────────────────────

  render(): void {
    const d = this.diagram;
    if (!d) return;
    const { scrollTop, scrollLeft } = this.scroll;
    const geom = layoutSequence(d, this.opts.layout, this.positions, this.measure);
    this.geometry = geom;
    this.showPlaceholder('none');
    this.headerSvg = renderHeader(geom);
    // FR-19.17 calls that break the dependency rule: red, as their relation in the class diagram
    // FR-7.16 resting on a guessed layer: only possible (amber), unless a certain violation shares the call
    const violating = new Map<string, true | 'possible'>();
    for (const f of d.findings ?? []) {
      if (f.kind !== 'layer-violation') continue;
      for (const id of f.messageIds ?? []) if (violating.get(id) !== true) violating.set(id, f.possible ? 'possible' : true);
    }
    this.bodySvg = renderBody(geom, new Set(this.highlightIds), violating);
    this.applyScale();
    this.header.replaceChildren(this.headerSvg);
    this.body.replaceChildren(this.bodySvg);
    this.root.classList.toggle('dragging', !!this.drag?.moved);
    this.toolbar.update(d);
    this.renderExpandNotice(d);
    this.renderBorrowed(d);
    this.zoomControls.update(this.zoom, true);
    this.scroll.scrollTop = scrollTop;
    this.scroll.scrollLeft = scrollLeft;
    this.find.onRender();
    if (this.selectedId && !d.messages.some((m) => m.id === this.selectedId)) this.selectedId = null;
    this.markSelected();
    this.applyDim();
    this.updateGhosts();
  }

  private ghostsPending = false;

  /** FR-10.4 the label groups of the current render, by message id (filled lazily). */
  private labelEls: Map<string, Element> | undefined;

  private slideLabels(g: SequenceGeometry, body: SVGSVGElement, view: { left: number; right: number; top: number; bottom: number }): void {
    if (!this.labelEls || !body.contains(this.labelEls.values().next().value ?? null)) {
      this.labelEls = new Map([...body.querySelectorAll('[data-msg-id] > .msg-label')].map((el) => [el.parentElement!.getAttribute('data-msg-id')!, el]));
    }
    for (const mg of g.messages) {
      const el = this.labelEls.get(mg.id)!; // every message is drawn with a label
      const dx = labelShift(mg, view);
      if (dx) el.setAttribute('transform', `translate(${dx} 0)`);
      else el.removeAttribute('transform');
    }
  }

  private scheduleGhosts(): void {
    if (this.ghostsPending) return;
    this.ghostsPending = true;
    const win = this.root.ownerDocument.defaultView;
    const run = () => {
      this.ghostsPending = false;
      this.updateGhosts();
    };
    if (win?.requestAnimationFrame) win.requestAnimationFrame(run);
    else run();
  }

  /** FR-1.16 copies of the guards scrolled out of view; FR-10.4 labels slid along their long arrows into view. */
  private updateGhosts(): void {
    const g = this.geometry;
    const body = this.bodySvg;
    if (!g || !body) return;
    body.querySelector('.guard-ghosts')?.remove();
    const s = this.scroll;
    const z = this.zoom;
    if (!s.clientWidth || !s.clientHeight) return;
    const view = { left: s.scrollLeft / z, right: (s.scrollLeft + s.clientWidth) / z, top: s.scrollTop / z, bottom: (s.scrollTop + s.clientHeight - g.headerHeight * z) / z };
    this.slideLabels(g, body, view);
    const ghosts = guardGhosts(g, view, this.measure);
    if (!ghosts.length) return;
    const el = renderGuardGhosts(ghosts);
    el.addEventListener('click', (e) => {
      const x = Number((e.target as Element).closest?.('[data-ghost-x]')?.getAttribute('data-ghost-x'));
      if (Number.isNaN(x)) return;
      e.stopPropagation();
      s.scrollLeft = Math.max(0, x * z - s.clientWidth / 3);
    });
    body.appendChild(el);
  }

  // ───────────────────────── zoom ─────────────────────────

  /** Header and body scale together, so the sticky header stays aligned with the lifelines. */
  private applyScale(): void {
    const g = this.geometry;
    if (!g || !this.headerSvg || !this.bodySvg) return;
    scaleSvg(this.headerSvg, g.width, g.headerHeight, this.zoom);
    scaleSvg(this.bodySvg, g.width, g.bodyHeight, this.zoom);
    const w = `${Math.round(g.width * this.zoom * 10) / 10}px`;
    this.header.style.width = w;
    this.body.style.width = w;
  }

  /** Sets the zoom, keeping the content point at (`px`,`py`) of the viewport in place. */
  setZoom(z: number, px = 0, py = 0): void {
    const to = clampZoom(z);
    const from = this.zoom;
    if (to === from) return;
    const next = scrollForZoom(this.scroll.scrollLeft, this.scroll.scrollTop, px, py, from, to);
    this.zoom = to;
    this.applyScale();
    this.scroll.scrollLeft = next.left;
    this.scroll.scrollTop = next.top;
    this.updateGhosts();
    this.zoomControls.update(this.zoom, !!this.geometry);
    this.placeRuler();
    this.persist();
  }

  /** Fit to width: a sequence diagram is read top-down, so only the width has to fit. */
  fit(): void {
    if (!this.geometry) return;
    this.setZoom(fitZoom(this.geometry.width, 0, this.scroll.clientWidth, 0));
    this.scroll.scrollLeft = 0;
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
    this.popups.closeOnViewChange();
    const r = this.scroll.getBoundingClientRect();
    this.setZoom(this.zoom * wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - r.left, e.clientY - r.top);
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    const raf = this.root.ownerDocument.defaultView?.requestAnimationFrame;
    if (!raf) return this.render();
    this.renderPending = true;
    raf(() => {
      this.renderPending = false;
      this.render();
    });
  }

  // ───────────────────────── review tour (FR-24.9 / FR-24.10) ─────────────────────────

  /** The bar and the ruler for the open diagram (hidden without a review). */
  private updateReviewBar(): void {
    const t = this.tour;
    const r = this.review.state === 'done' ? this.review.result : undefined;
    const d = this.diagram;
    if (!t || !r || !d) {
      this.reviewBarEl.hidden = true;
      this.rulerEl.hidden = true;
      return;
    }
    const stops = changeStops(d);
    // FR-24.9 a layer opened for the changes folded into a call: on to the first of them
    if (t.pending === 'change' && t.afterId) {
      // the opened call is no stop any more (its fold is gone): the first stop after it in reading order
      const order = new Map(d.messages.map((m, i) => [m.id, i]));
      const at = order.get(t.afterId);
      const next = at === undefined ? undefined : stops.find((m) => order.get(m.id)! > at); // stops are messages of d
      t.pending = undefined;
      t.afterId = undefined;
      if (next) return this.stepTo(next);
    }
    // FR-24.15 numbered: the stop showing (or holding) the current number
    const holding = numbered(d) && t.position ? stops.findIndex((m) => hasNumber(m, t.position)) : -1;
    const current = holding >= 0 ? holding : t.currentId ? stops.findIndex((m) => m.id === t.currentId) : -1;
    const stop = stops[current];
    const foldedIn = stop?.diff?.folded ? d.participants.find((p) => p.id === stop.to)?.label : undefined;
    // the flow opened by the tour, else a tour flow starting at this diagram's root (opened another way)
    const rootOf = (f: TourFlow) => f.paths[0]?.[0]?.methodKey;
    let flowIndex = t.flowRoot === d.root.key ? t.flowIndex : t.flows.findIndex((f) => rootOf(f) === d.root.key || f.alsoFrom.some((a) => a.entryPoint.method.key === d.root.key));
    if (flowIndex >= 0 && t.flowRoot !== d.root.key) Object.assign(t, { flowIndex, flowRoot: d.root.key });
    if (flowIndex < 0) flowIndex = -1;
    // FR-24.12 an entry point the flow covers, opened on its own: named in the bar, counted as that flow
    const also = flowIndex >= 0 && rootOf(t.flows[flowIndex]) !== d.root.key ? t.flows[flowIndex].alsoFrom.find((a) => a.entryPoint.method.key === d.root.key) : undefined;
    this.reviewBarEl.replaceChildren(
      reviewBar(
        { branch: r.branch ?? 'this branch', base: r.resolvedBase, flows: t.flows, flowIndex, stops, current, atEnd: t.atEnd, ...(numbered(d) ? { total: d.reviewTotal, position: t.position ?? null, ...(stop && t.position ? { text: numberText(stop, t.position, foldedIn) } : {}) } : {}), ...(also ? { also } : {}), ...(foldedIn ? { foldedIn } : {}) },
        {
          prevFlow: () => this.openTourFlow(Math.max(0, t.flowIndex - 1)),
          nextFlow: () => this.openTourFlow(t.flowIndex + 1),
          prevChange: () => this.prevChange(),
          nextChange: () => this.nextChange(),
          openPanel: () => this.showReview(false),
          // FR-24.12 every flow of the tour, filtered by entry point or changed method
          chooseFlow: (anchor) => {
            const r = anchor.getBoundingClientRect();
            const panel = flowChooser(t.flows, flowIndex, (i, j) => {
              this.popups.close();
              this.openTourFlow(i, j);
            });
            this.popups.show(panel, r.left, r.bottom + 2);
          },
        },
      ),
    );
    this.reviewBarEl.hidden = false;
    this.renderRuler(stops, current);
  }

  /** FR-24.9 B: a tick per change at its height in the diagram (like an editor's scrollbar marks); click = go there. */
  private renderRuler(stops: Message[], current: number): void {
    const g = this.geometry;
    if (!g || !stops.length) {
      this.rulerEl.hidden = true;
      return;
    }
    const total = Math.max(1, g.bodyHeight);
    const y = new Map(g.messages.map((m) => [m.id, m.y]));
    this.rulerEl.replaceChildren(
      ...stops.map((m, i) => {
        const tick = html('button', { type: 'button', class: `ruler-tick st-${m.diff!.status ?? (m.diff!.call || m.diff!.method ? 'changed' : 'inside')}${i === current ? ' current' : ''}`, title: `${m.className ? `${m.className}.` : ''}${m.methodName}` });
        tick.style.top = `${Math.min(97, (100 * y.get(m.id)!) / total)}%`; // every stop is drawn
        tick.addEventListener('click', () => (ownChange(m) ? this.selectChange(m.id) : this.stepTo(m)));
        return tick;
      }),
    );
    this.rulerEl.hidden = false;
    this.placeRuler();
  }

  /** The ruler is `position: fixed` at the scroll area's right edge, below the header: re-placed on resize and zoom. */
  private placeRuler(): void {
    const g = this.geometry;
    if (!g || this.rulerEl.hidden) return;
    const s = this.scroll.getBoundingClientRect();
    const head = g.headerHeight * this.zoom;
    const span = Math.max(1, s.height - head);
    Object.assign(this.rulerEl.style, { top: `${Math.round(s.top + head)}px`, height: `${Math.round(span)}px`, left: `${Math.round(s.right - 10)}px` });
  }

  /** Go to a change: highlighted, scrolled to, its card (what happened, the diff lines) shown. */
  private selectChange(id: string): void {
    const t = this.tour!; // only while a review tour is on (its bar, keys, ruler, badges)
    t.currentId = id;
    t.atEnd = false;
    // FR-24.15 the number of the change: kept when this message shows it, else its first
    const m0 = this.message(id);
    if (numbered(this.diagram) && m0 && !hasNumber(m0, t.position)) t.position = firstNumber(m0);
    // FR-24.15 each step shows its code diff beside the diagram, as a click on the changed call does (the diagram
    // keeps the focus); not for a call that only holds changes (below it, folded)
    const step = numbered(this.diagram) && t.position !== undefined ? m0?.diff?.positions?.find((x) => x.n === t.position) : undefined;
    if (step) this.post({ type: 'openDiff', messageId: id, keepFocus: true, ...(step.method ? { method: true as const } : {}) });
    this.setHighlight([id]);
    this.updateReviewBar();
    const m = this.message(id);
    const doc = this.root.ownerDocument;
    // after the scroll settled (a scroll hides cards)
    setTimeout(() => {
      const el = [...this.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id);
      const anchor = el?.querySelector('.msg-label') ?? el;
      // the anchor is drawn: there is a diagram (an empty one clears the body)
      if (!anchor || !m || this.tour?.currentId !== id) return;
      this.hoverCard.showAt(anchor, messageCard(m, doc, this.diagram!));
      // a card shown without the mouse goes after a while, unless it is read
      setTimeout(() => {
        if (this.hoverCard.anchor === anchor && !this.hoverCard.element.matches(':hover')) this.hoverCard.hide();
      }, TOUR_CARD_MS);
    }, 150);
  }

  /** A collapsed call with changes below: the host expands down to the first one and highlights it. */
  private revealChange(id: string): void {
    const t = this.tour!; // only while a review tour is on (its bar, keys, ruler, badges)
    if (numbered(this.diagram)) {
      // FR-24.15 the first change it holds, by number
      const n = firstNumber(this.message(id));
      if (n !== undefined) return this.goToChange(n);
    }
    t.pending = 'change';
    t.currentId = id;
    this.post({ type: 'revealChange', messageId: id });
  }

  /**
   * FR-24.15 the tour by number: the flow's changes in one fixed order (`reviewTotal`), whatever is drawn. A change
   * drawn now is selected here; otherwise the host opens the way to it (implementation, expansions, layer) and
   * highlights it — so ◀ ▶ walk the same list forwards and back.
   */
  private goToChange(n: number): void {
    const t = this.tour!; // only while a review tour is on (its bar, keys, ruler, badges)
    Object.assign(t, { position: n, atEnd: false });
    const drawn = this.diagram?.messages.find((m) => m.diff?.positions?.some((x) => x.n === n));
    if (drawn) return this.selectChange(drawn.id);
    t.pending = 'change';
    this.post({ type: 'showChange', n });
  }

  /**
   * FR-24.9 zoomed to layers, a call with changes folded into it: the host opens its layer in place; the first of
   * them is selected when the diagram arrives (`afterId`).
   */
  private openFoldedChanges(m: Message): void {
    Object.assign(this.tour!, { pending: 'change', currentId: m.id, afterId: m.id });
    this.post({ type: 'setLayerOpen', layer: m.to, open: true });
  }

  /** On to a stop: its own change selected; changes below a collapsed call revealed; changes folded into a layer opened. */
  private stepTo(m: Message): void {
    if (numbered(this.diagram)) {
      const n = firstNumber(m);
      if (n !== undefined) return this.goToChange(n);
    }
    if (ownChange(m)) return this.selectChange(m.id);
    if (m.diff?.inside && !m.expanded) return this.revealChange(m.id);
    if (m.diff?.folded) return this.openFoldedChanges(m);
    this.selectChange(m.id);
  }

  private nextChange(): void {
    const t = this.tour!; // only while a review tour is on (its bar, keys, ruler, badges)
    const d = this.diagram;
    if (numbered(d)) {
      const n = (t.position ?? 0) + 1;
      if (n <= d!.reviewTotal!) return this.goToChange(n);
      // the last change: say so once, then on to the next flow
      if (t.atEnd) return this.openTourFlow(t.flowIndex + 1);
      t.atEnd = true;
      return this.updateReviewBar();
    }
    const stops = changeStops(d);
    const i = t.currentId ? stops.findIndex((m) => m.id === t.currentId) : -1;
    const cur = stops[i];
    // first the changes below the current call, then the ones folded into it (zoomed)
    if (cur?.diff?.inside && !cur.expanded) return this.revealChange(cur.id);
    if (cur?.diff?.folded) return this.openFoldedChanges(cur);
    const next = stops[i + 1];
    if (!next) {
      // the last change here: say so once, then on to the next flow
      if (t.atEnd || !stops.length) return this.openTourFlow(t.flowIndex + 1);
      t.atEnd = true;
      return this.updateReviewBar();
    }
    this.stepTo(next);
  }

  private prevChange(): void {
    const t = this.tour!; // only while a review tour is on (its bar, keys, ruler, badges)
    const d = this.diagram;
    if (numbered(d)) {
      const n = (t.position ?? d!.reviewTotal! + 1) - 1;
      if (n >= 1) return this.goToChange(n);
    } else {
      const stops = changeStops(d);
      // none selected (or gone from the diagram): from the end
      const i = stops.findIndex((m) => m.id === t.currentId);
      for (let k = (i < 0 ? stops.length : i) - 1; k >= 0; k--) if (ownChange(stops[k])) return this.selectChange(stops[k].id);
    }
    // before the first change: the previous flow's last one (as ▶ after the last goes on to the next flow)
    if (t.flowIndex > 0) {
      this.openTourFlow(t.flowIndex - 1);
      t.toLast = true;
    }
  }

  /** the last change of the flow just opened (`first`: the one the host selected). */
  private lastChange(first: string): void {
    const d = this.diagram;
    if (numbered(d)) return this.goToChange(d!.reviewTotal!);
    const last = changeStops(d).filter(ownChange).at(-1);
    this.selectChange(last?.id ?? first);
  }

  /**
   * FR-24.10 open a flow of the tour, expanded to its changes; the first change is selected when it arrives.
   * FR-24.12 `also`: one of the entry points the flow covers instead — its own flow, down to the same changes.
   */
  private openTourFlow(index: number, also?: number): void {
    const t = this.tour;
    const flow = t?.flows[index];
    if (!t || !flow) return;
    Object.assign(t, { flowIndex: index, pending: 'flow', currentId: null, position: undefined, atEnd: false, toLast: false });
    const a = also !== undefined ? flow.alsoFrom[also] : undefined;
    if (a) this.post({ type: 'openChangeFlow', paths: a.paths, entryPoint: a.entryPoint });
    else this.post({ type: 'openChangeFlow', paths: flow.paths, ...(flow.entryPoint ? { entryPoint: flow.entryPoint } : {}) });
  }

  /**
   * FR-9.7 scrolls sideways to a participant's lifeline (centred), keeping the rows where they are, and marks
   * its head for a moment; the position before is kept for Backspace.
   */
  jumpTo(participantId: string, messageId?: string | null): void {
    const g = this.geometry?.participants.find((p) => p.id === participantId);
    if (!g) return;
    if (messageId) {
      this.releaseJumped();
      this.jumped = { messageId, ...this.pointer };
      for (const el of this.body.querySelectorAll('[data-msg-id]')) if (el.getAttribute('data-msg-id') === messageId) el.classList.add('jump-active');
    }
    const s = this.scroll;
    this.jumpBack.push({ left: s.scrollLeft, top: s.scrollTop });
    if (this.jumpBack.length > 20) this.jumpBack.shift();
    s.scrollLeft = Math.max(0, g.x * this.zoom - s.clientWidth / 2);
    this.hoverCard.hide();
    const box = this.headerBox(participantId)!; // every participant of the geometry has its box in the header
    this.header.querySelectorAll('.jump-target').forEach((el) => el.classList.remove('jump-target'));
    box.classList.add('jump-target');
    setTimeout(() => box.classList.remove('jump-target'), 1200);
  }

  /** FR-9.7 the keys follow the mouse again. */
  private releaseJumped(): void {
    this.jumped = null;
    this.body.querySelectorAll('.jump-active').forEach((el) => el.classList.remove('jump-active'));
  }

  /** FR-9.7 back to where the last jump started. */
  jumpBackTo(): boolean {
    const at = this.jumpBack.pop();
    if (!at) return false;
    this.scroll.scrollLeft = at.left;
    this.scroll.scrollTop = at.top;
    return true;
  }

  /** FR-9.7 → / ← over a message (or the one jumped along last): to its receiver / sender; Backspace: back. */
  private bindJumpKeys(doc: Document): void {
    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.root.isConnected || e.ctrlKey || e.metaKey || e.altKey || this.popups.element) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Backspace') {
        if (this.jumpBackTo()) e.preventDefault();
        return;
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      // FR-9.9 the selected message (clicked, or walked to with ↓ ↑) before the one under the mouse
      const m = this.message(this.jumped?.messageId ?? this.selectedId ?? this.hoveredMessageId ?? msgIdOf(this.hoverCard.anchor));
      const id = m && (e.key === 'ArrowRight' ? m.to : m.from);
      if (!id) return;
      e.preventDefault();
      this.jumpTo(id, m.id);
    });
  }

  /**
   * FR-9.9 walking the diagram with the keyboard: ↓ / ↑ the next / previous message as drawn (Shift: skip the calls inside),
   * Enter its code (as a click), Space / + / − expand or collapse it, Escape lets go. Not in a field; Enter and Space
   * not on a focused button (they press it).
   */
  private bindWalkKeys(doc: Document): void {
    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.root.isConnected || e.ctrlKey || e.metaKey || e.altKey || this.popups.element || !this.geometry) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const next = this.walk(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
        if (!next) return;
        e.preventDefault();
        return this.select(next);
      }
      const m = this.message(this.selectedId);
      if (!m || t?.closest('button, a, [role="button"], [role="menuitem"]')) return;
      if (e.key === 'Escape') {
        if (this.find.bar.isOpen) return;
        return this.select(null);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        return this.openMessage(m);
      }
      const toggle =
        e.key === ' ' ? (m.expanded ? 'collapse' : m.expandable ? 'expand' : undefined)
          : e.key === '+' ? (m.expandable && !m.expanded ? 'expand' : undefined)
            : e.key === '-' ? (m.expanded ? 'collapse' : undefined)
              : undefined;
      if (!toggle) return;
      e.preventDefault();
      // the call stays where it is on screen, as after a click on its ⊕ / ⊖
      this.anchorAt({ messageId: m.id });
      this.post({ type: toggle, messageId: m.id });
    });
  }

  /** FR-9.9 the next / previous message as drawn; nothing selected: the first / last one on screen. */
  private walk(dir: 1 | -1, sameLevel: boolean): string | undefined {
    const ms = [...this.geometry!.messages].sort((a, b) => a.y - b.y);
    const at = ms.findIndex((g) => g.id === this.selectedId);
    if (at < 0) {
      const on = ms.filter((g) => this.onScreen(g.box));
      return (dir === 1 ? on[0] : on[on.length - 1])?.id;
    }
    const depth = ms[at].message.depth;
    for (let i = at + dir; i >= 0 && i < ms.length; i += dir) if (!sameLevel || ms[i].message.depth <= depth) return ms[i].id;
    return undefined;
  }

  /** FR-9.9 selects a message (null: none): outlined and scrolled into view; the → / ← keys start from it. */
  private select(id: string | null): void {
    this.selectedId = id;
    this.releaseJumped();
    this.markSelected();
    const mg = id ? this.geometry?.messages.find((g) => g.id === id) : undefined;
    if (mg) this.scrollIntoView(messageFocusBox(mg, this.scroll.clientWidth / this.zoom));
  }

  private markSelected(): void {
    for (const el of this.body.querySelectorAll('.message.kb-selected')) el.classList.remove('kb-selected');
    for (const el of this.body.querySelectorAll('.message[data-msg-id]')) if (el.getAttribute('data-msg-id') === this.selectedId) el.classList.add('kb-selected');
  }

  /** A click on a call (or Enter on the selected one): its code, or its change side by side during a review. */
  private openMessage(m: Message): void {
    // FR-24.7 a reviewed call opens its change side by side (a removed one exists only in the base version)
    if (m.diff?.status || m.diff?.call || m.diff?.method) this.post({ type: 'openDiff', messageId: m.id });
    else this.navigate(this.messageRange(m)); // FR-2.1 / FR-2.2
  }

  /** Alt+← / Alt+→: back / forward (as the toolbar's arrows); "?": the key map. */
  private bindHistoryKeys(doc: Document): void {
    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.root.isConnected || e.ctrlKey || e.metaKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const d = this.diagram;
      // the browser's own Back / Forward (a browser host: Vim, the dev host) would leave the page, also with nowhere to go
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft' && d?.canGoBack) this.post({ type: 'back' });
        if (e.key === 'ArrowRight' && d?.canGoForward) this.post({ type: 'forward' });
      } else if (!e.altKey && e.key === '?' && !this.popups.element) {
        e.preventDefault();
        this.showKeys();
      } else if (e.key === 'Escape' && !this.popups.element && this.find.bar.isOpen) {
        // the Find bar closes from anywhere, not only from its field
        e.preventDefault();
        this.find.bar.close();
      }
    });
  }

  /** N / P: next / previous change; Shift+N / Shift+P: next / previous flow (while a review is on). */
  private bindReviewKeys(doc: Document): void {
    doc.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.tour || this.reviewBarEl.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const run = { n: () => this.nextChange(), p: () => this.prevChange(), N: () => this.openTourFlow(this.tour!.flowIndex + 1), P: () => this.openTourFlow(Math.max(0, this.tour!.flowIndex - 1)) }[e.key];
      if (!run) return;
      e.preventDefault();
      run();
    });
  }

  private setHighlight(ids: string[]): void {
    this.highlightIds = ids;
    for (const el of this.body.querySelectorAll('.message.highlighted')) el.classList.remove('highlighted');
    if (!ids.length || !this.geometry) return;
    const wanted = new Set(ids);
    for (const el of this.body.querySelectorAll('[data-msg-id]')) if (wanted.has(el.getAttribute('data-msg-id')!)) el.classList.add('highlighted');
    // Scroll the first (in diagram order) highlighted message into view.
    const mg = this.geometry.messages.find((m) => wanted.has(m.id));
    if (mg) this.scrollIntoView(messageFocusBox(mg, this.scroll.clientWidth / this.zoom));
  }

  private scrollIntoView(box: { x: number; y: number; width: number; height: number }): void {
    const s = this.scroll;
    const z = this.zoom;
    box = { x: box.x * z, y: box.y * z, width: box.width * z, height: box.height * z };
    const headerH = this.geometry!.headerHeight * z; // only after a render (a highlight, new calls)
    const viewH = s.clientHeight - headerH;
    if (viewH > 0 && (box.y < s.scrollTop || box.y + box.height > s.scrollTop + viewH)) {
      s.scrollTop = Math.max(0, box.y - viewH / 3);
    }
    if (s.clientWidth > 0 && (box.x < s.scrollLeft || box.x + box.width > s.scrollLeft + s.clientWidth)) {
      // centred when it fits: the boxes at both ends show, not half of the one at the edge
      s.scrollLeft = Math.max(0, box.width + 48 <= s.clientWidth ? box.x + box.width / 2 - s.clientWidth / 2 : box.x - 24);
    }
  }

  // ───────────────────────── lookup helpers ─────────────────────────

  private message(id: string | null | undefined): Message | undefined {
    return id ? this.diagram?.messages.find((m) => m.id === id) : undefined;
  }

  private participant(id: string | null | undefined): Participant | undefined {
    return id ? this.diagram?.participants.find((p) => p.id === id) : undefined;
  }

  private navigate(range: SourceRange | undefined): void {
    if (range) this.post({ type: 'navigate', range });
  }

  private messageRange(m: Message): SourceRange | undefined {
    if (m.kind === 'found') return m.callSite ?? rootDeclarationRange(this.diagram!); // a drawn message: there is a diagram
    return m.callSite;
  }

  // ───────────────────────── mouse interaction ─────────────────────────

  private onClick(e: MouseEvent): void {
    if (this.suppressClick) return;
    // a design issue's mark: its evidence shown, its card (as picked from ⚠ N)
    const markId = closestWithData(e.target, 'finding-id')?.getAttribute('data-finding-id');
    const marked = markId ? this.diagram?.findings?.find((f) => f.id === markId) : undefined;
    if (marked) return void this.revealFinding(marked);
    // FR-7.5: the ⚑ on a participant opens the hint (reasons + apply) instead of navigating.
    if (closestWithData(e.target, 'layer-hint')) {
      // the ⚑ is drawn only on a participant with a hint
      const p = this.participant(closestWithData(e.target, 'participant-id')?.getAttribute('data-participant-id'))!;
      e.stopPropagation();
      this.popups.showMenu(layerHintMenu(p, (layer) => this.layerScope.choose(p, layer, e.clientX, e.clientY)), e.clientX, e.clientY);
      return;
    }
    // FR-1.12: minimize / restore a fragment
    const fragAction = closestWithData(e.target, 'fragment-action');
    const fragId = fragAction && closestWithData(fragAction, 'fragment-id')?.getAttribute('data-fragment-id');
    if (fragAction && fragId) {
      e.stopPropagation();
      const kind = fragAction.getAttribute('data-fragment-action');
      this.anchorAt({ fragmentId: fragId }, fragAction);
      this.post(
        kind === 'expand'
          ? { type: 'expandFragment', fragmentId: fragId }
          : kind === 'all-cases'
            ? { type: 'showAllCases', fragmentId: fragId }
            : { type: 'collapseFragment', fragmentId: fragId },
      );
      return;
    }
    // FR-3.11 "⊕ 2 calls": show an error branch Smart folded
    const errorPath = closestWithData(e.target, 'error-path')?.getAttribute('data-error-path');
    if (errorPath) {
      e.stopPropagation();
      this.post({ type: 'showErrorPath', key: errorPath });
      return;
    }
    // FR-1.15: an exit marker reveals its return / throw statement
    const exitId = closestWithData(e.target, 'exit-id')?.getAttribute('data-exit-id');
    const exit = exitId ? this.diagram?.exits?.find((x) => x.id === exitId) : undefined;
    if (exit) {
      e.stopPropagation();
      this.navigate(exit.range);
      return;
    }
    // FR-1.10: a fragment's tag / guard reveals the condition in the code
    const fragPart = closestWithData(e.target, 'fragment-part');
    if (fragPart) {
      // a drawn frame is one of the diagram's fragments
      const f = this.diagram!.fragments!.find((x) => x.id === closestWithData(fragPart, 'fragment-id')?.getAttribute('data-fragment-id'))!;
      e.stopPropagation();
      const operand = fragPart.getAttribute('data-operand');
      const k = Number(operand);
      // FR-1.17 rows after the operands are catch clauses without visible calls
      this.navigate(operand !== null ? (f.operands[k]?.range ?? f.catches?.[k - f.operands.length]?.range ?? f.range) : f.range);
      return;
    }
    // FR-2.5: an activation bar → the definition of the method it executes
    const actId = closestWithData(e.target, 'activation-for')?.getAttribute('data-activation-for');
    const actMsg = this.message(actId);
    if (actMsg?.targetDeclaration) {
      e.stopPropagation();
      this.navigate(actMsg.targetDeclaration);
      return;
    }
    const action = closestWithData(e.target, 'action');
    const msgEl = closestWithData(e.target, 'msg-id');
    const m = this.message(msgEl?.getAttribute('data-msg-id'));
    if (m && action) {
      e.stopPropagation();
      const kind = action.getAttribute('data-action');
      if (kind === 'expand' || kind === 'collapse') this.anchorAt({ messageId: m.id }, action);
      // FR-3.7: Shift+click expands everything below the call
      if (kind === 'expand') this.post(e.shiftKey ? { type: 'expandAll', messageId: m.id } : { type: 'expand', messageId: m.id });
      else if (kind === 'collapse') this.post({ type: 'collapse', messageId: m.id });
      // FR-24.9 the ▲n badge: down to the first changed method below
      else if (kind === 'reveal-change') {
        if (this.tour) this.revealChange(m.id);
        else this.post({ type: 'revealChange', messageId: m.id });
      }
      else {
        // the badge of a polymorphic call (implementations): the last of the actions drawn on a message
        const r = (action as Element).getBoundingClientRect();
        this.popups.showMenu(this.implementationItems(m), r.left, r.bottom + 2);
      }
      return;
    }
    if (m) {
      // FR-9.9 the clicked call is where the keys go on from
      this.selectedId = m.id;
      this.markSelected();
      this.openMessage(m);
      return;
    }
    // FR-24.11 the NEW / Δn tag: the class side by side
    const classDiff = closestWithData(e.target, 'class-diff')?.getAttribute('data-class-diff');
    if (classDiff) return void this.post({ type: 'openDiff', classKey: classDiff });
    // FR-28.7 ⊕ on a layer lifeline opens it in place; ⊖ ‹layer› above an object folds it again
    const layerAction = closestWithData(e.target, 'action');
    const layer = layerAction?.getAttribute('data-layer');
    if (layer && layerAction?.getAttribute('data-action') === 'open-layer') return void this.post({ type: 'setLayerOpen', layer, open: true });
    if (layer && layerAction?.getAttribute('data-action') === 'fold-layer') return void this.post({ type: 'setLayerOpen', layer, open: false });
    const p = this.participant(closestWithData(e.target, 'participant-id')?.getAttribute('data-participant-id'));
    // FR-23.5 Shift+click on its box or its lifeline: step through the object's messages
    const line = e.shiftKey ? this.participant(closestWithData(e.target, 'lifeline')?.getAttribute('data-lifeline')) : undefined;
    if ((p || line) && e.shiftKey) return void this.find.openObject((p ?? line)!);
    if (p) {
      this.navigate(p.declaration); // FR-2.3
      // FR-12.17 the class diagram (if open) shows its class
      if (p.classKey.includes('#') && !p.classKey.startsWith('lib:')) this.post({ type: 'focusClass', classKey: p.classKey });
    }
  }

  private onContextMenu(e: MouseEvent): void {
    // FR-1.22 the guard of an alternative: follow this case / show all cases
    const guard = closestWithData(e.target, 'fragment-part')?.getAttribute('data-fragment-part') === 'guard' ? (e.target as Element).closest('[data-operand]') : null;
    const frag = guard ? this.diagram?.fragments?.find((f) => f.id === closestWithData(guard, 'fragment-id')?.getAttribute('data-fragment-id')) : undefined;
    const op = frag?.operands[Number(guard!.getAttribute('data-operand'))];
    if (frag?.kind === 'alt' && op?.case !== undefined && (frag.operands.length > 1 || frag.followed)) {
      e.preventDefault();
      const items: MenuItem[] = frag.followed
        ? [{ id: 'all-cases', label: 'Show all cases', action: () => this.post({ type: 'showAllCases', fragmentId: frag.id }) }]
        : [{ id: 'follow-case', label: 'Follow this case', title: 'Show only this case: the other cases leave both diagrams', action: () => this.post({ type: 'followCase', fragmentId: frag.id, case: op.case! }) }];
      this.popups.showMenu(items, e.clientX, e.clientY);
      return;
    }
    const m = this.message(closestWithData(e.target, 'msg-id')?.getAttribute('data-msg-id'));
    const p = m ? undefined : this.participant(closestWithData(e.target, 'participant-id')?.getAttribute('data-participant-id'));
    if (!m && !p) {
      if (!this.diagram || (e.target as Element).closest?.('[data-exit-id], .fragment, .entry-points')) return;
      e.preventDefault();
      this.popups.showMenu(this.canvasMenu(e.clientX, e.clientY), e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    this.hoverCard.hide();
    this.popups.showMenu(m ? this.messageMenu(m, e.clientX, e.clientY) : this.participantMenu(p!, e.clientX, e.clientY), e.clientX, e.clientY);
  }

  private onHeaderMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !this.geometry) return;
    const id = closestWithData(e.target, 'participant-id')?.getAttribute('data-participant-id');
    const pg = this.geometry.participants.find((p) => p.id === id);
    if (!pg) return;
    e.preventDefault();
    this.drag = { id: pg.id, startX: e.clientX, origX: pg.x, frozen: positionsOf(this.geometry), moved: false };
  }

  private onMouseMove(e: MouseEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / this.zoom;
    if (!drag.moved && Math.abs(dx) * this.zoom < CLICK_SLOP) return;
    drag.moved = true;
    this.positions = { ...drag.frozen, [drag.id]: Math.round(drag.origX + dx) };
    this.scheduleRender();
  }

  private onMouseUp(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.moved) return;
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    this.render(); // the last move may still wait for its frame
    // FR-10.3 with auto-tidy on, a dropped object only changes the order: packed again at once (off: placed by hand)
    if (this.diagram && optionEnabled(this.diagram.options, 'autoTidy')) return this.tidyUp();
    this.savePositions(); // FR-10.1
  }

  private savePositions(): void {
    if (!this.diagram || !this.geometry) return;
    this.positions = positionsOf(this.geometry);
    this.lastRender = { diagram: this.diagram, positions: this.positions };
    this.persist();
    this.post({ type: 'savePositions', rootKey: this.diagram.root.key, positions: this.positions });
  }

  tidyUp(): void {
    if (!this.diagram || !this.geometry) return;
    this.positions = tidyPositions(this.diagram, this.measure, positionsOf(this.geometry), this.opts.layout);
    this.render();
    this.savePositions();
  }

  // ───────────────────────── menus ─────────────────────────

  private implementationItems(m: Message): MenuItem[] {
    const poly = m.polymorphic!;
    // FR-8.6 what the DI container gives here comes first, with where it is bound; the others are not bound here
    const bound = poly.bound;
    const where = bound ? `${bound.at.file.split('/').pop()}:${bound.at.start.line + 1}` : '';
    const ordered = bound ? [...poly.implementations.filter((i) => i.key === bound.classKey), ...poly.implementations.filter((i) => i.key !== bound.classKey)] : poly.implementations;
    // FR-8.6 keyed registrations (C#): the key picks one at run time — each shows its key, none is chosen
    const keyedOf = (key: string) => poly.keyed?.find((k) => k.classKey === key);
    const at = (r: SourceRange) => `${r.file.split('/').pop()}:${r.start.line + 1}`;
    const items: MenuItem[] = ordered.map((impl) => {
      const keyed = keyedOf(impl.key);
      const hint = bound ? (impl.key === bound.classKey ? `bound · ${where}` : 'not bound here') : keyed ? `${keyed.kind === 'condition' ? 'when' : 'keyed'} ${keyed.key} · ${at(keyed.at)}` : undefined;
      return {
        id: `impl:${impl.key}`,
        label: impl.name,
        checked: impl.key === poly.selectedKey,
        ...(hint ? { hint } : {}),
        action: () => this.post({ type: 'selectImplementation', messageId: m.id, classKey: impl.key }),
      };
    });
    if (!items.length) items.push({ label: 'No implementations found', disabled: true });
    if (bound) {
      items.push({ separator: true, label: '' });
      items.push({ id: 'open-binding', label: `Open the binding (${where})`, hint: bound.contextual ? 'for this class' : 'for every class', action: () => this.navigate(bound.at) });
    }
    items.push({ separator: true, label: '' });
    items.push({
      id: 'back-to-interface',
      label: `Back to interface ${poly.interfaceName}`,
      disabled: !poly.selectedKey,
      action: () => this.post({ type: 'revertImplementation', messageId: m.id }),
    });
    return items;
  }

  private messageMenu(m: Message, x: number, y: number): MenuItem[] {
    const found = m.kind === 'found';
    // the root cannot be hidden; the DI container step (FR-8.7, drawn as a found message too) can, like any call (FR-11)
    const unhideable = found && m.id !== 'container';
    const diff: MenuItem[] = m.diff?.status || m.diff?.call || m.diff?.method ? [{ id: 'show-diff', label: 'Show the change (diff)', action: () => this.post({ type: 'openDiff', messageId: m.id }) }] : [];
    // FR-24.6 a call the branch removed: only its change can be shown
    if (m.diff?.status === 'removed') return diff;
    const hide = (filter: HideFilterSpec) => () => this.post({ type: 'hide', filter });
    const items: MenuItem[] = [
      { id: 'show-callers', label: 'Show callers', action: () => this.requestCallers(m, x, y) },
      { id: 'paths-to-here', label: 'Paths to here…', action: () => this.requestPaths(m, x, y) },
      { id: 'goto', label: found ? 'Go to declaration' : 'Go to call site', disabled: !this.messageRange(m), action: () => this.navigate(this.messageRange(m)) },
      ...diff,
    ];
    if (m.expandable || m.expanded) {
      if (m.id !== 'root') items.push(
        m.expanded
          ? { id: 'collapse', label: 'Collapse', action: () => (this.anchorAt({ messageId: m.id }), this.post({ type: 'collapse', messageId: m.id })) }
          : { id: 'expand', label: 'Expand', action: () => (this.anchorAt({ messageId: m.id }), this.post({ type: 'expand', messageId: m.id })) },
      );
      // FR-3.12 the ways to open calls, below this call only (the rest of the diagram unchanged)
      items.push({ id: 'show-from-here', label: 'Show from here', submenu: this.viewItems(this.diagram!, m.id) });
      if (!found) items.push({ id: 'focus', label: 'Focus on this call', action: () => this.post({ type: 'focus', messageId: m.id }) });
    } else {
      // a call with nothing to open says why (its menu is shorter than elsewhere)
      const why = m.unresolved ? 'target not found' : m.classKey?.startsWith('lib:') ? 'library call' : m.recursive ? 'calls itself again' : 'no body to open';
      items.push({ id: 'expand', label: 'Expand', hint: why, disabled: true, title: `Nothing to open: ${why}` });
    }
    if (m.polymorphic) {
      const poly = m.polymorphic;
      items.push({ separator: true, label: '' });
      items.push({ id: 'choose-impl', label: 'Choose implementation', submenu: this.implementationItems(m).filter((i) => i.id?.startsWith('impl:') || i.disabled) });
      items.push({ id: 'back-to-interface', label: 'Back to interface', disabled: !poly.selectedKey, action: () => this.post({ type: 'revertImplementation', messageId: m.id }) });
    }
    items.push({ separator: true, label: '' });
    // FR-25.5 a prompt about this call and the flow, for an AI chat or agent (a review question for a changed call)
    items.push({ id: 'ask-ai', label: 'Ask AI about this call', hint: 'copies a prompt', title: 'Copy a question about this call, with the shown flow and its file:line places, to paste into an AI chat or agent', action: () => this.post({ type: 'copyText', messageId: m.id }) });
    // the hide and don't-expand rules in one submenu (four rows would be a third of the menu)
    const rules: MenuItem[] = [];
    rules.push({ id: 'hide-name', label: `Hide every call named ${m.methodName}`, hint: 'any class', disabled: unhideable, action: hide({ kind: 'methodName', methodName: m.methodName }) });
    if (m.classKey && m.className) {
      rules.push({
        id: 'hide-class-method',
        label: `Hide calls to ${m.className}.${m.methodName} only`,
        disabled: unhideable,
        action: hide({ kind: 'classMethod', classKey: m.classKey, className: m.className, methodName: m.methodName }),
      });
    }
    // FR-11.7 keep the call, but Expand all / Smart expand leave it folded
    const rule = noExpandRule(this.diagram!.hiddenFilters, m.noExpand);
    if (!rule && !found) {
      rules.push({ separator: true, label: '' });
      rules.push({ id: 'no-expand-name', label: `Don't expand calls named ${m.methodName}`, hint: 'any class', action: hide(noExpand({ kind: 'methodName', methodName: m.methodName })) });
      if (m.classKey && m.className) {
        rules.push({ id: 'no-expand-class-method', label: `Don't expand calls to ${m.className}.${m.methodName} only`, action: hide(noExpand({ kind: 'classMethod', classKey: m.classKey, className: m.className, methodName: m.methodName })) });
      }
    }
    items.push({ id: 'hide-menu', label: "Hide / don't expand", disabled: unhideable, submenu: rules });
    // a rule in force stays one click away
    if (rule) items.push({ id: 'allow-expand', label: 'Let Expand all open it again', hint: describeHideFilter(rule), action: () => this.post({ type: 'unhide', filterId: rule.id }) });
    return items;
  }

  /** FR-7.8 the card: which rule placed the object in its layer, what the code suggests, how to change it. */
  private showLayerReason(p: Participant, x: number, y: number): void {
    const setLayer = (layer: string) => this.layerScope.choose(p, layer, x, y);
    const card = layerReasonCard(
      { ...p, violations: p.layerViolations },
      {
        applyHint: setLayer,
        ignoreHint: (pattern) => {
          this.popups.close();
          this.post({ type: 'ignoreLayerHint', pattern });
        },
        moveTo: (mx, my) => {
          const others = (this.diagram?.layerChoices ?? []).filter((l) => l !== p.layer);
          this.popups.showMenu(others.map((l) => ({ id: `layer:${l}`, label: l, action: () => setLayer(l) })), mx, my);
        },
      },
    );
    this.popups.show(card, x, y);
  }

  private participantMenu(p: Participant, x = 40, y = 40): MenuItem[] {
    const d = this.diagram!;
    // FR-28 a layer lifeline: its objects (go to one), its messages; no class to hide or move
    if (p.objects) {
      return [
        { id: 'open-layer', label: `Show its ${p.objects.length === 1 ? 'object' : 'objects'} here`, hint: '⊕', action: () => this.post({ type: 'setLayerOpen', layer: p.id, open: true }) },
        { separator: true, label: '' },
        // FR-28.8 an object pulled out onto its own lifeline (click its box afterwards to go to the code); one row per
        // class — a layer can hold dozens of result objects of one class — which pulls out all of its objects
        ...layerObjectRows(p.objects).map((r, i): MenuItem => ({
          id: `object:${i}`,
          label: r.count > 1 ? `${r.label} ×${r.count}` : r.label,
          hint: r.count > 1 ? 'pull out all' : 'pull out',
          ...(r.count > 1 ? { title: `${r.count} objects of ${r.label}:\n${[...new Set(r.labels)].join('\n')}` } : {}),
          action: () => this.post({ type: 'setLayerOpen', layer: r.pull, open: true }),
        })),
        { separator: true, label: '' },
        { id: 'find-messages', label: 'Find its messages', hint: 'Shift+click', action: () => this.find.openObject(p) },
        { id: 'show-objects', label: 'Open all layers', ...(optionEnabled(d.options, 'layerZoom') ? { hint: '◫ Open layers' } : {}), action: () => this.post({ type: 'setOption', option: 'layerZoom', value: false }) },
        ...this.foldAllItem(d, 0),
      ];
    }
    // FR-28.11 the object view: the band names the layer the object can fold into one lifeline
    const band = d.groups.find((g) => g.id === p.groupId)?.fold;
    const items: MenuItem[] = [
      ...(band && !p.inLayer
        ? [
            // the object alone (its ⊖), the others stay out
            { id: 'fold-object', label: `Fold into ${band.name}`, hint: '⊖', title: 'Only this object: the layer\'s other objects stay out', action: () => this.post({ type: 'setLayerOpen', layer: p.id, open: false }) } as MenuItem,
            { id: 'fold-layer', label: `Fold ${band.name}`, hint: 'one lifeline', action: () => this.post({ type: 'setLayerOpen', layer: band.key, open: false }) } as MenuItem,
            ...this.foldAllItem(d, 1),
            { separator: true, label: '' } as MenuItem,
          ]
        : []),
      // FR-28.7 an object of a layer opened in place
      ...(p.inLayer
        ? [
            { id: 'fold-object', label: `Put it back into ${p.inLayer.name}`, hint: '⊖', action: () => this.post({ type: 'setLayerOpen', layer: p.id, open: false }) } as MenuItem,
            { id: 'fold-layer', label: `Fold ${p.inLayer.name} (all its objects)`, action: () => this.post({ type: 'setLayerOpen', layer: p.inLayer!.key, open: false }) } as MenuItem,
            ...this.foldAllItem(d, 1),
            { separator: true, label: '' } as MenuItem,
          ]
        : []),
      { id: 'goto', label: 'Go to declaration', disabled: !p.declaration, action: () => this.navigate(p.declaration) },
      { id: 'find-messages', label: 'Find its messages', hint: 'Shift+click', action: () => this.find.openObject(p) },
      ...(whyLabel(p) ? [{ id: 'why-layer', label: whyLabel(p)!, action: () => this.showLayerReason(p, x, y) }] : []),
    ];
    const layerItems = layerMenuItems(p, d.layerChoices ?? [], (layer) => this.layerScope.choose(p, layer, x, y));
    if (layerItems.length) items.push({ separator: true, label: '' }, ...layerItems);
    const polys = d.messages.filter((m) => m.to === p.id && m.polymorphic);
    if (polys.length) {
      const first = polys[0];
      items.push({ separator: true, label: '' });
      items.push({ id: 'choose-impl', label: 'Choose implementation', submenu: this.implementationItems(first).filter((i) => i.id?.startsWith('impl:') || i.disabled) });
      const selected = polys.find((m) => m.polymorphic!.selectedKey);
      items.push({
        id: 'back-to-interface',
        label: 'Back to interface',
        disabled: !selected,
        action: () => selected && this.post({ type: 'revertImplementation', messageId: selected.id }),
      });
    }
    items.push({ separator: true, label: '' });
    const isRoot = d.messages.find((m) => m.id === 'root')?.to === p.id;
    items.push({
      id: 'hide-class',
      label: `Hide class ${p.className}`,
      disabled: isRoot,
      action: () => this.post({ type: 'hide', filter: { kind: 'class', classKey: p.classKey, className: p.className } }),
    });
    items.push(...categoryMenu(p.className, p.stereotypes, (filter) => this.post({ type: 'hide', filter })));
    // FR-11.7 its calls stay, folded on Expand all / Smart expand
    const stopId = `noExpand:class:${p.classKey}`;
    const stopping = d.hiddenFilters.some((f) => f.filter.id === stopId);
    items.push(
      stopping
        ? { id: 'allow-expand-class', label: `Let Expand all open calls to ${p.className} again`, action: () => this.post({ type: 'unhide', filterId: stopId }) }
        : { id: 'no-expand-class', label: `Don't expand calls to class ${p.className}`, action: () => this.post({ type: 'hide', filter: noExpand({ kind: 'class', classKey: p.classKey, className: p.className }) }) },
    );
    return items;
  }

  /**
   * FR-19.7: move the diagram to a finding — its messages highlighted and its classes' participants
   * outlined (for a cyclic collaboration: the objects and the calls between them), the view scrolled
   * so the evidence is seen as a whole (zoomed out when it does not fit). A finding with only classes as evidence (I/O in Domain of a
   * whole file) outlines their participants and scrolls to their columns.
   */
  private revealFinding(f: Finding, guide = true): void {
    this.header.querySelectorAll('.finding-hl').forEach((el) => el.classList.remove('finding-hl'));
    const ids = f.messageIds ?? [];
    this.setHighlight(ids);
    // the rest dims while the finding's card is open (its calls, the calls leading to them, their objects stay)
    this.dimFor = guide && ids.length ? f : this.dimFor === f ? f : null;
    this.applyDim();
    const keys = new Set(f.classKeys ?? []);
    // with messages: only the participants that send / receive them (not every instance of the class)
    const involved = new Set<string>();
    for (const id of ids) {
      const m = this.message(id);
      if (m?.from) involved.add(m.from);
      if (m) involved.add(m.to);
    }
    const boxes = [...this.header.querySelectorAll('[data-participant-id]')].filter((el) => {
      const id = el.getAttribute('data-participant-id')!;
      const p = this.diagram?.participants.find((x) => x.id === id);
      return !!p && keys.has(p.classKey) && (!ids.length || involved.has(id));
    });
    boxes.forEach((el) => el.classList.add('finding-hl'));
    const messages = [...this.body.querySelectorAll('.message.highlighted')];
    // a finding's card sits at the top right: its calls are fitted left of it (an unfolded card in a
    // wide enough view), and not below 60 % (lower is unreadable) — then its first calls are shown
    const card = !this.cardFolded && this.scroll.clientWidth - FINDING_CARD_ROOM >= 320 ? FINDING_CARD_ROOM : 0;
    const zoom = { current: this.zoom, set: (z: number) => this.setZoom(z), min: 0.6 };
    if (messages.length) revealElements(this.scroll, messages, { top: this.geometry!.headerHeight * this.zoom, zoom, right: card }); // highlighted: drawn
    else revealElements(this.scroll, boxes, { horizontalOnly: true, zoom });
    if (guide) this.showFindingGuide(f);
  }

  /** FR-19.10 the finding's card (why, consequences, how to fix, when it's OK) at the top right of the view. */
  private showFindingGuide(f: Finding): void {
    const fold = {
      folded: this.cardFolded,
      changed: (folded: boolean) => {
        this.cardFolded = folded;
        this.persist();
      },
    };
    // FR-19.17 a layer violation: the class diagram's card (move a misclassified side, adjust the rule)
    const card = f.kind === 'layer-violation' ? this.violationGuide(f, fold) : findingCard(f, {
      show: () => this.revealFinding(f, false),
      ignore: (pattern) => {
        this.popups.close();
        this.post({ type: 'ignoreFinding', pattern });
      },
      close: () => this.popups.close(),
    }, fold);
    const r = this.scroll.getBoundingClientRect();
    // below the frozen header — and below the find bar when it is open (both sit at the top right)
    const findBar = this.root.querySelector('.find-bar:not([hidden])');
    const top = Math.max(r.top + (this.geometry?.headerHeight ?? 0) * this.zoom + 8, findBar ? findBar.getBoundingClientRect().bottom + 6 : 0);
    this.cardFor = f;
    // sticky: revealing the evidence scrolls / zooms the view right after (asynchronous scroll event)
    this.popups.show(card, Math.max(r.left + 8, r.right - 452), top, {
      sticky: true,
      onClose: () => {
        if (this.cardFor !== f) return; // another finding took over
        this.cardFor = null;
        this.dimFor = null;
        this.applyDim();
        // the finding's marks go with its card
        this.setHighlight([]);
        this.header.querySelectorAll('.finding-hl').forEach((el) => el.classList.remove('finding-hl'));
      },
    });
  }

  /** the finding whose card is open (its marks are cleared when the card closes). */
  private cardFor: Finding | null = null;

  /** FR-19.20 the finding whose card is open: everything but its evidence is dimmed. */
  private dimFor: Pick<Finding, 'messageIds'> | null = null;

  /**
   * FR-19.20 dims what the open finding is not about. Kept: its calls, the calls leading to them (message ids are
   * call paths), their activations and participants, and the fragments around them (the loop of an N+1).
   */
  private applyDim(): void {
    const ids = this.dimFor?.messageIds?.filter((id) => this.message(id)) ?? [];
    const on = ids.length > 0 && !!this.geometry;
    this.root.classList.toggle('evidence-dimmed', on);
    for (const el of this.root.querySelectorAll('.evidence-keep')) el.classList.remove('evidence-keep');
    if (!on) return;
    const keep = new Set<string>();
    for (const id of ids) {
      const parts = id.split('/');
      for (let i = 1; i <= parts.length; i++) keep.add(parts.slice(0, i).join('/'));
    }
    const participants = new Set<string>();
    for (const id of keep) {
      const m = this.message(id);
      if (m?.from) participants.add(m.from);
      if (m) participants.add(m.to);
    }
    const ys = this.geometry!.messages.filter((m) => ids.includes(m.id)).map((m) => m.y);
    const frames = new Set(this.geometry!.fragments.filter((fg) => ys.some((y) => y >= fg.y1 && y <= fg.y2)).map((fg) => fg.fragment.id));
    const mark = (selector: string, attr: string, wanted: Set<string>) => {
      for (const el of this.root.querySelectorAll(selector)) if (wanted.has(el.getAttribute(attr)!)) el.classList.add('evidence-keep');
    };
    mark('.message[data-msg-id]', 'data-msg-id', keep);
    mark('.activation[data-activation-for]', 'data-activation-for', keep);
    mark('.participant[data-participant-id]', 'data-participant-id', participants);
    mark('.lifeline[data-lifeline]', 'data-lifeline', participants);
    mark('.fragment[data-fragment-id]', 'data-fragment-id', frames);
  }

  /** FR-19.17 a layer violation's card in the sequence diagram: its two sides from the participants (layer, ⚑ hint). */
  private violationGuide(f: Finding, fold: { folded: boolean; changed(folded: boolean): void }): HTMLElement {
    const [fromKey, toKey] = f.classKeys ?? [];
    const names = f.title.replace(/^Layer violation: /, '').split(' → ');
    const side = (key: string | undefined, i: number): ViolationSide => {
      const p = this.diagram?.participants.find((x) => x.classKey === key);
      // a side without an object (the interface a call goes through): its layer from the evidence
      const layer = p?.layer ?? f.evidence?.find((e) => e.startsWith(`${names[i]}: `))?.slice(names[i].length + 2);
      return {
        key: key ?? '',
        name: p?.className ?? names[i] ?? '?',
        ...(layer ? { layer } : {}),
        ...(p?.layerHint ? { suggested: p.layerHint.suggested, reasons: p.layerHint.reasons, ...(p.layerHint.noMove ? { noMove: true } : {}) } : {}),
      };
    };
    return violationCard(side(fromKey, 0), side(toKey, 1), f.detail ?? '', {
      show: () => this.revealFinding(f, false),
      move: (s) => this.layerScope.choose({ classKey: s.key, className: s.name }, s.suggested!, 120, 120),
      adjustRule: () => this.post({ type: 'openDependencyRule' }),
      close: () => this.popups.close(),
    }, fold, f.evidence, f.possible);
  }

  /** FR-28.9 *Fold all layers* in a layer's / opened object's menu, when more is open than the one at hand (`ownOpen`). */
  private foldAllItem(d: SequenceDiagram, ownOpen: number): MenuItem[] {
    const open = openLayerCount([...d.participants, ...d.groups]);
    return open > ownOpen ? [{ id: 'fold-all-layers', label: 'Fold all layers', hint: `${open} open`, action: () => this.post({ type: 'foldLayers' }) }] : [];
  }

  /**
   * FR-3.12 how to open the calls — the whole diagram, or below `messageId` (Show from here). Each starts from closed.
   * *Changes* only during a review with changes here.
   */
  private viewItems(d: SequenceDiagram, messageId?: string): MenuItem[] {
    const at = messageId ? { messageId } : {};
    const id = (view: string) => (messageId ? `from-here:${view}` : `show:${view}`);
    return [
      { id: id('overview'), label: '✦ Overview', hint: 'important calls', action: () => this.post({ type: 'smartExpand', ...at }) },
      { id: id('expand-all'), label: '⊞ Expand all', hint: messageId ? 'Shift+click ⊕' : 'every call, up to 500', action: () => this.post({ type: 'expandAll', ...at }) },
      ...(d.reviewTotal ? [{ id: id('changes'), label: '◆ Changes', hint: `${d.reviewTotal} in this flow`, action: () => this.post({ type: 'smartExpand', ...at, view: 'changes' as const }) }] : []),
    ];
  }

  /** FR-3.12 the ▾ next to ✦: the views, then One more level and Collapse all (no own buttons). */
  private expandMenu(d: SequenceDiagram): MenuItem[] {
    return [
      ...this.viewItems(d),
      { separator: true, label: '' },
      { id: 'expand-one-level', label: 'One more level', hint: 'expand the next ⊕ of every call', action: () => this.post({ type: 'expandAll', oneLevel: true }) },
      { id: 'collapse-all', label: '⊟ Collapse all', hint: 'back to depth 1', action: () => this.post({ type: 'collapseAll' }) },
    ];
  }

  /**
   * FR-3.3 notice after an "Expand all" that stopped before everything was open (message budget or
   * depth limit): what happened and what to do next. Closable; replaced by the next render.
   */
  private renderExpandNotice(d: SequenceDiagram): void {
    this.noticeEl.replaceChildren();
    const n = d.expandNotice;
    const button = (label: string, onClick: () => void, cls = 'notice-btn') => {
      const b = html('button', { type: 'button', class: cls }, [label]);
      b.addEventListener('click', onClick);
      return b;
    };
    if (this.stateNotice && this.stateNotice.rootKey !== d.root.key) this.stateNotice = null;
    if (!n && this.stateNotice) {
      // FR-25.2 how far the opened state matches the sender's (until another root is drawn or ✕)
      const report = this.stateNotice.report;
      this.noticeEl.hidden = false;
      const details = button('Details', () => {
        const r = details.getBoundingClientRect();
        this.popups.show(stateDetailsCard(report), r.left, r.bottom + 4);
      });
      this.noticeEl.append(
        html('span', { class: 'notice-text', 'data-state-notice': '' }, [stateSummary(report)]),
        details,
        // FR-25.3 the sender's layer config, for this session only
        ...(report.configDiffers && !d.borrowedConfig ? [button('Use the sender\'s layer config', () => this.post({ type: 'useSharedConfig', on: true }))] : []),
        ...(report.settingsReplaced
          ? [
              button('Back to my view settings', () => {
                this.stateNotice = { report: { ...report, settingsReplaced: false }, rootKey: d.root.key };
                this.post({ type: 'restoreSettings' });
              }),
            ]
          : []),
        button('✕', () => {
          this.stateNotice = null;
          this.noticeEl.hidden = true;
        }, 'notice-close'),
      );
      return;
    }
    this.noticeEl.hidden = !n;
    if (!n) return;
    if (n.reason === 'smart') {
      // FR-3.10 Smart reached its cap with calls still worth opening
      this.noticeEl.append(
        html('span', { class: 'notice-text' }, [`ⓘ Overview stopped at ${n.messages} messages (limit ${n.limit}) — ${n.folded} important call${n.folded === 1 ? '' : 's'} still folded (⊕).`]),
        button('Continue', () => this.post({ type: 'smartExpand', more: true })),
        button('Collapse all', () => this.post({ type: 'collapseAll' })),
        button('✕', () => {
          this.noticeEl.hidden = true;
        }, 'notice-close'),
      );
      return;
    }
    const why = n.reason === 'messages' ? `Stopped at ${n.messages} messages (limit ${n.limit})` : `Reached the depth limit (${n.limit} levels)`;
    this.noticeEl.append(
      html('span', { class: 'notice-text' }, [`ⓘ ${why} — ${n.folded} call${n.folded === 1 ? '' : 's'} still folded (⊕).`]),
      button('One more level', () => this.post({ type: 'expandAll', oneLevel: true })),
      button('Overview instead', () => this.post({ type: 'smartExpand' })),
      button('Collapse all', () => this.post({ type: 'collapseAll' })),
      button('✕', () => {
        this.noticeEl.hidden = true;
      }, 'notice-close'),
    );
  }

  /** FR-14.2 View ▾: display options as check boxes (the menu stays open), then behaviour, then reset. */
  private viewMenu(): MenuItem[] {
    const d = this.diagram!; // opened from the toolbar / canvas of a drawn diagram, refreshed on a render
    // I/O badges on and none drawn — say where they come from, so "none" is not read as "broken"
    const noIo = optionEnabled(d.options, 'showSideEffects') && !d.participants.some((p) => p.sideEffects) && !d.messages.some((m) => m.sideEffects);
    const item = (o: (typeof VIEW_OPTIONS)[number]): MenuItem => {
      const on = optionEnabled(d.options, o.option);
      const none = noIo && o.option === 'showSideEffects' ? { hint: 'none found', title: `${o.title}\n${NO_IO}` } : {};
      return { id: `view:${o.option}`, label: o.label, title: o.title, role: 'checkbox', checked: on, keepOpen: true, action: () => this.post({ type: 'setOption', option: o.option, value: !on }), ...none };
    };
    const changed = changedViewOptions(d.options);
    return [
      ...VIEW_OPTIONS.filter((o) => !o.behaviour && !o.mark).map(item),
      { separator: true, label: '' },
      // the marks of both diagrams, the same section as in the class view's View ▾
      ...markItems(d.options, (option, value) => this.post({ type: 'setOption', option, value })),
      { separator: true, label: '' },
      ...VIEW_OPTIONS.filter((o) => o.behaviour).map(item),
      // Tidy up by hand, beside its automatic twin (no own toolbar button)
      { id: 'view:tidy', label: 'Tidy up now', title: 'Place the participants close together (keeps their order)', action: () => this.tidyUp() },
      { separator: true, label: '' },
      // what the boxes, bars, arrows and marks mean
      { id: 'view:legend', label: 'How to read this…', title: 'What each box, bar, arrow and mark of the diagram means', action: () => this.showLegend() },
      { id: 'view:keys', label: 'Keyboard shortcuts…', hint: '?', title: 'Every key of this view in one list', action: () => this.showKeys() },
      {
        id: 'view:reset',
        label: 'Reset to defaults',
        disabled: !changed.length,
        keepOpen: true,
        action: () => changed.forEach((o) => this.post({ type: 'setOption', option: o.option, value: o.default })),
      },
    ];
  }

  /** the key map ("?" or View ▾). */
  private showKeys(): void {
    const r = this.root.getBoundingClientRect();
    this.popups.show(keysCard(() => this.popups.close()), Math.max(8, r.left + 40), Math.max(8, r.top + 40));
  }

  /** the legend card, at the top left of the diagram. */
  private showLegend(): void {
    const r = this.root.getBoundingClientRect();
    this.popups.show(legendCard(() => this.popups.close()), Math.max(8, r.left + 40), Math.max(8, r.top + 40));
  }

  /** FR-14.4 right-click on the empty canvas: the diagram-wide commands and the View options. */
  private canvasMenu(x: number, y: number): MenuItem[] {
    return [
      // FR-3.12 the same items as the ▾ next to ✦, and ↯
      ...this.expandMenu(this.diagram!),
      { id: 'canvas:foldErrors', label: '↯ Fold errors', role: 'checkbox', checked: optionEnabled(this.diagram!.options, 'foldErrors'), action: () => this.post({ type: 'setOption', option: 'foldErrors', value: !optionEnabled(this.diagram!.options, 'foldErrors') }) },
      { separator: true, label: '' },
      { id: 'canvas:tidy', label: '⇔ Tidy up', action: () => this.tidyUp() },
      // the review one click away, not only inside ⌂ (two clicks, and hard to find)
      { id: 'canvas:review', label: '⎇ Review changes…', title: 'What this branch changes, against a base you choose', action: () => this.showReview() },
      { separator: true, label: '' },
      { id: 'canvas:view', label: '☷ View options…', action: () => this.popups.showMenu(this.viewMenu(), x, y, 'view') },
    ];
  }

  private hiddenMenu(): MenuItem[] {
    return filtersMenu(this.diagram!.hiddenFilters, (msg) => this.post(msg), "right-click a call ▸ Hide… / Don't expand…");
  }

  // ───────────────────────── callers (FR-4) ─────────────────────────

  private requestCallers(m: Message, x: number, y: number): void {
    this.callers = { messageId: m.id, x, y };
    this.post({ type: 'requestCallers', messageId: m.id });
    this.popups.show(this.callersPanel(m, null), x, y);
  }

  private showCallers(messageId: string, callers: CallerInfo[]): void {
    const m = this.message(messageId);
    if (!m) return;
    const pos = this.callers?.messageId === messageId ? this.callers : { x: 40, y: 40 };
    this.popups.show(this.callersPanel(m, callers), pos.x, pos.y);
  }

  // ───────────────────────── paths to here (FR-22) ─────────────────────────

  private requestPaths(m: Message, x: number, y: number): void {
    const root = this.diagram!.root; // a menu of a drawn message
    const owner = m.kind === 'found' ? (root.owner.kind !== 'module' ? root.owner.name : undefined) : m.className;
    const title = owner ? `${owner}.${m.methodName}` : m.methodName;
    this.paths = { messageId: m.id, title, state: 'running', methods: 0, x, y };
    this.post({ type: 'requestPaths', messageId: m.id });
    this.renderPaths();
  }

  private renderPaths(): void {
    const p = this.paths!; // requestPaths sets it first
    const panel = pathsPanel(p, {
      open: (steps, entryPoint) => {
        this.popups.close();
        this.post(entryPoint ? { type: 'openPath', steps, entryPoint } : { type: 'openPath', steps });
      },
      cancel: () => this.post({ type: 'cancelPaths' }),
      changed: () => this.renderPaths(),
      copy: (text) => copyText(text),
    });
    const list = this.root.querySelector('.paths-panel .paths-list');
    const scrollTop = list?.scrollTop ?? 0;
    this.popups.show(panel, p.x, p.y);
    const next = panel.querySelector('.paths-list');
    if (next) next.scrollTop = scrollTop;
  }

  private callersPanel(m: Message, callers: CallerInfo[] | null): HTMLElement {
    const title = m.className && m.kind !== 'found' ? `${m.className}.${m.methodName}` : m.methodName;
    const panel = html('div', { class: 'callers-panel', role: 'dialog', 'aria-label': `Callers of ${title}` }, [
      html('div', { class: 'callers-title' }, ['Callers of ', html('span', { class: 'code' }, [title])]),
    ]);
    if (!callers) {
      panel.appendChild(html('div', { class: 'callers-status' }, ['Searching references…']));
      return panel;
    }
    // FR-4.4: callers in test files only on request
    const withTests = this.diagram?.options.includeTestCallers === true;
    const tests = callers.filter((c) => c.inTest).length;
    const shown = withTests ? callers : callers.filter((c) => !c.inTest);
    const testToggle = (): HTMLElement => {
      const box = html('input', { type: 'checkbox', class: 'callers-tests-toggle' }) as HTMLInputElement;
      box.checked = withTests;
      box.addEventListener('change', () => {
        this.reopenCallers = { messageId: m.id, callers };
        this.post({ type: 'setOption', option: 'includeTestCallers', value: box.checked });
        // re-render the open panel right away (the option arrives with the next render)
        // the panel closes with the diagram (clearDiagram): there is one
        this.diagram = { ...this.diagram!, options: { ...this.diagram!.options, includeTestCallers: box.checked } };
        this.popups.show(this.callersPanel(m, callers), this.callers?.x ?? 40, this.callers?.y ?? 40);
      });
      return html('label', { class: 'callers-tests', title: 'Also list references in test files (testFiles globs)' }, [box, ` Include tests (${tests})`]);
    };
    if (!shown.length) {
      panel.appendChild(html('div', { class: 'callers-status' }, [tests ? 'No callers outside tests' : 'No callers found']));
      if (tests) panel.appendChild(testToggle());
      return panel;
    }
    const list = html('div', { class: 'callers-list', role: 'listbox' });
    for (const c of shown) {
      const item = html('button', { type: 'button', class: `caller-item${c.inTest ? ' in-test' : ''}`, role: 'option', 'data-caller-id': c.id, title: `${c.range.file}:${c.range.start.line + 1}` }, [
        html('span', { class: 'caller-head' }, [
          html('span', { class: 'caller-name' }, [callerTitle(c)]),
          c.passed ? html('span', { class: 'caller-tag', title: 'Passed as an argument to this call, which invokes it' }, ['passed']) : null,
          c.inTest ? html('span', { class: 'caller-tag' }, ['test']) : null,
          html('span', { class: 'caller-loc' }, [formatLocation(c.range)]),
        ]),
        html('span', { class: 'caller-preview' }, [normalizeSource(c.preview)]),
      ]);
      item.addEventListener('click', () => {
        this.popups.close();
        this.post({ type: 'reroot', messageId: m.id, callerId: c.id });
      });
      list.appendChild(item);
    }
    panel.appendChild(list);
    if (tests) panel.appendChild(testToggle());
    // FR-22: the whole way up, not just one level
    const more = html('button', { type: 'button', class: 'callers-paths', title: 'Walk the callers up to the entry points (routes, jobs, tests)' }, ['Paths to here…']);
    more.addEventListener('click', () => this.requestPaths(m, this.callers?.x ?? 40, this.callers?.y ?? 40));
    panel.appendChild(more);
    return panel;
  }

  private headerBox(participantId: string): Element | undefined {
    return [...this.header.querySelectorAll('[data-participant-id]')].find((el) => el.getAttribute('data-participant-id') === participantId);
  }

  // ───────────────────────── FR-25 the diagram as an image ─────────────────────────

  private imageMenu(btn: HTMLButtonElement): MenuItem[] {
    return [
      { id: 'image:copy', label: 'Copy as image (PNG)', hint: 'paste into chat or a document', action: () => void this.copyImage(btn) },
      // FR-25.4 the shown calls as an indented text tree with file:line — for an AI chat or agent, an issue, a PR
      { id: 'text:copy', label: 'Copy as text', hint: 'the shown calls, for an AI chat', action: () => this.post({ type: 'copyText' }) },
      { id: 'image:png', label: 'Save as PNG…', action: () => void this.saveImage('png') },
      { id: 'image:svg', label: 'Save as SVG…', hint: 'sharp at any size', action: () => void this.saveImage('svg') },
      // an expanded flow is thousands of pixels tall: what the panel shows, at scale 1
      { id: 'image:copy-visible', label: 'Copy the visible area (PNG)', hint: 'what the panel shows', action: () => void this.copyImage(btn, true) },
      { id: 'image:png-visible', label: 'Save the visible area as PNG…', action: () => void this.saveImage('png', true) },
      // FR-25.2 the state, to open the same diagram elsewhere (a bug report, a colleague)
      ...stateMenuItems((save) => this.post({ type: 'copyState', ...(save ? { save } : {}) }), () => this.openStatePrompt()),
    ];
  }

  // ───────────────────────── FR-25.2 the diagram's state to share ─────────────────────────

  /** FR-25.3 the project's own config again. */
  private useOwnConfig(): void {
    this.popups.close();
    this.post({ type: 'useSharedConfig', on: false });
  }

  /** FR-25.3 the bar while a shared diagram's config is in use (every render says whether it is). */
  private renderBorrowed(d: SequenceDiagram | null): void {
    const cfg = d?.borrowedConfig;
    this.borrowEl.hidden = !cfg;
    this.borrowEl.replaceChildren(...(cfg ? borrowedConfigBar(cfg, () => this.useOwnConfig()).childNodes : []));
  }

  /** The paste card; Open sends the text to the host. */
  openStatePrompt(): void {
    const card = pasteStateCard(
      (text) => {
        this.popups.close();
        this.post({ type: 'openState', text });
      },
      () => this.popups.close(),
    );
    const r = this.root.getBoundingClientRect();
    this.popups.show(card, Math.max(8, r.left + 40), Math.max(8, r.top + 40), { sticky: true });
  }

  private showStateCard(card: HTMLElement): void {
    const r = this.root.getBoundingClientRect();
    this.popups.show(card, Math.max(8, r.left + 40), Math.max(8, r.top + 40), { sticky: true });
  }

  /** A state was opened: the notice says how far it matches (the render came first); an error in a card. */
  private onStateReport(report: DiagramStateReport | undefined, error: string | undefined): void {
    if (!report) {
      const r = this.root.getBoundingClientRect();
      const card = html('div', { class: 'callers-panel layer-reason-card state-card', role: 'alert' }, [
        html('div', { class: 'callers-title' }, ['Could not open the shared diagram']),
        html('div', { class: 'lr-note' }, [error ?? 'Unknown error']),
      ]);
      this.popups.show(card, Math.max(8, r.left + 40), Math.max(8, r.top + 40));
      return;
    }
    if (!this.diagram) return;
    this.stateNotice = { report, rootKey: this.diagram.root.key };
    this.renderExpandNotice(this.diagram);
  }

  /** Everything drawn (`visible`: the part the panel shows), header above body, at scale 1, with the panel's colours. */
  private diagramImage(visible = false): { svg: string; width: number; height: number; name: string } {
    // Share ▾ works only on a drawn diagram (the toolbar is disabled without one; an empty one closes the menu)
    const [header, body] = [this.headerSvg!, this.bodySvg!];
    const hv = header.viewBox.baseVal;
    const bv = body.viewBox.baseVal;
    let parts: ImagePart[] = [{ svg: header, y: 0 }, { svg: body, y: hv.height }];
    let width = Math.max(hv.width, bv.width);
    let height = hv.height + bv.height;
    if (visible) {
      // the scrolled window at scale 1: the header over its columns, the body's rows below
      const x = this.scroll.scrollLeft / this.zoom;
      const y = this.scroll.scrollTop / this.zoom;
      width = Math.max(1, Math.min(this.scroll.clientWidth / this.zoom, width - x));
      const rows = Math.max(1, Math.min(this.scroll.clientHeight / this.zoom - hv.height, bv.height - y));
      parts = [{ svg: header, y: 0, view: { x, y: 0, width, height: hv.height } }, { svg: body, y: hv.height, view: { x, y, width, height: rows } }];
      height = hv.height + rows;
    }
    const image = standaloneSvg(parts, width, height, backgroundOf(this.body));
    const root = this.diagram!.root;
    return { ...image, name: imageName(`${root.owner.name}.${root.name}`) };
  }

  private async copyImage(btn: HTMLButtonElement, visible = false): Promise<void> {
    const img = this.diagramImage(visible);
    const ok = await copyPng(svgToPng(img.svg, img.width, img.height));
    this.flash(btn, ok ? 'Copied ✓' : 'Copy not allowed here — use Save as PNG');
    if (!ok) this.post({ type: 'log', level: 'info', message: 'copy image: the clipboard refused the image' });
  }

  private async saveImage(format: 'png' | 'svg', visible = false): Promise<void> {
    const img = this.diagramImage(visible);
    const name = `${img.name}.${format}`;
    if (format === 'svg') {
      if (hostSaves()) this.post({ type: 'saveImage', name, format, data: img.svg });
      else download(name, img.svg, 'image/svg+xml');
      return;
    }
    const png = await svgToPng(img.svg, img.width, img.height);
    if (hostSaves()) this.post({ type: 'saveImage', name, format, data: await blobToBase64(png) });
    else download(name, png, 'image/png');
  }

  /** A short confirmation on the toolbar button (its tooltip and a transient label). */
  private flash(btn: HTMLButtonElement, text: string): void {
    const before = btn.title;
    btn.title = text;
    btn.dataset.flash = text;
    setTimeout(() => {
      btn.title = before;
      delete btn.dataset.flash;
    }, FLASH_MS);
  }

  // ───────────────────────── toolbar ─────────────────────────

  private onToolbar(cmd: ToolbarCommand, btn: HTMLButtonElement): void {
    if (cmd === 'entryPoints') {
      const r = btn.getBoundingClientRect();
      return this.showEntryPoints(r.left, r.bottom + 4);
    }
    const d = this.diagram;
    if (!d) return;
    switch (cmd) {
      case 'view': {
        const r = btn.getBoundingClientRect();
        this.popups.showMenu(this.viewMenu(), r.left, r.bottom + 2, 'view');
        return;
      }
      case 'back':
        return this.post({ type: 'back' });
      case 'forward':
        return this.post({ type: 'forward' });
      case 'findings': {
        const r = btn.getBoundingClientRect();
        const ignored = { patterns: d.ignored, stop: (section: 'findings' | 'layerHints', pattern: string) => this.post({ type: section === 'findings' ? 'unignoreFinding' : 'unignoreLayerHint', pattern }) };
        this.popups.showMenu(issuesMenu(d.findings, (f) => this.revealFinding(f), 0, d.issuesBelow ? { issues: d.issuesBelow, expand: () => this.post({ type: 'expandAll' }) } : undefined, ignored), r.left, r.bottom + 2);
        return;
      }
      case 'expandMenu': {
        const r = btn.getBoundingClientRect();
        this.popups.showMenu(this.expandMenu(d), r.left, r.bottom + 2);
        return;
      }
      case 'smartExpand':
        return this.post({ type: 'smartExpand' });
      case 'foldErrors':
        return this.post({ type: 'setOption', option: 'foldErrors', value: !optionEnabled(d.options, 'foldErrors') });
      case 'layerZoom':
        // FR-28 a session option, so it is saved, shared with the diagram and seen by the class view
        return this.post({ type: 'setOption', option: 'layerZoom', value: !optionEnabled(d.options, 'layerZoom') });
      case 'classDiagram':
        return this.post({ type: 'openClassDiagram' });
      case 'find':
        return this.find.open();
      case 'image': {
        const r = btn.getBoundingClientRect();
        this.popups.showMenu(this.imageMenu(btn), r.left, r.bottom + 2);
        return;
      }
      case 'hidden': {
        const r = btn.getBoundingClientRect();
        this.popups.showMenu(this.hiddenMenu(), r.left, r.bottom + 2);
        return;
      }
    }
  }
}

export function startSequenceView(root: HTMLElement, bridge: SequenceBridge, opts?: SequenceViewOptions): SequenceView {
  const view = new SequenceView(root, bridge, opts);
  const guard = installDiagnostics(bridge, 'sequence view');
  const fail = (message: string) => view.handle({ type: 'error', message: `Rendering failed: ${message}` });
  bridge.onMessage((msg) =>
    guard(() => {
      view.handle(msg);
      if (msg.type === 'render') {
        bridge.post({ type: 'log', level: 'info', message: `sequence view rendered ${msg.diagram.messages.length} messages, ${msg.diagram.participants.length} participants` });
      }
    }, fail),
  );
  const saved = bridge.getState<SavedState>();
  view.restoreZoom(saved?.zoom);
  view.restoreCardFolded(saved?.findingCardFolded, saved?.reviewBase, saved?.reviewMode);
  if (saved?.lastRender) guard(() => view.handle({ type: 'render', ...saved.lastRender! }), fail);
  bridge.post({ type: 'ready' });
  return view;
}

/** Longest participant label shown in a hover-card chip (the full label is its tooltip). */
/** The message a card's anchor belongs to: the message group itself or an element inside it (the tour's label). */
function msgIdOf(anchor: Element | null | undefined): string | null {
  return anchor?.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? null;
}

const CHIP_MAX = 28;

/**
 * FR-9.6 who calls whom: `▌Sender ──▶ ▌Receiver` as small chips with the participants' layer
 * colours (self call `▌Owner ↻`, creation `┄«create»┄▶`, root `● ──▶`). Long arrows often have
 * both ends scrolled out of view; this row names them without scrolling.
 */
export function routeRow(m: Message, d: SequenceDiagram, doc: Document): HTMLElement | undefined {
  const byId = new Map(d.participants.map((p) => [p.id, p]));
  const to = byId.get(m.to);
  if (!to) return undefined;
  const span = (cls: string, text: string, title?: string) => {
    const el = doc.createElement('span');
    el.className = cls;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  };
  const chip = (p: Participant) => {
    const label = p.label.length > CHIP_MAX ? `${p.label.slice(0, CHIP_MAX - 1)}…` : p.label;
    const el = span(['hc-chip', layerClass(p.layer)].filter(Boolean).join(' '), label, `${p.label}${p.layer ? ` · ${p.layer}` : ''}`);
    el.dataset.participantId = p.id;
    el.dataset.jump = '';
    return el;
  };
  /**
   * FR-28.10 zoomed to layers: the object a layer lifeline stands for, with the lifeline's name under it. The object
   * pulls itself out of its layer (FR-28.8); the name scrolls to the lifeline, as a chip does.
   */
  const end = (p: Participant, obj: ZoomEnd | undefined) => {
    if (!obj) return chip(p);
    const box = span('hc-end', '');
    const label = obj.label.length > CHIP_MAX ? `${obj.label.slice(0, CHIP_MAX - 1)}…` : obj.label;
    const objChip = span(['hc-chip', layerClass(obj.layer)].filter(Boolean).join(' '), label, `${obj.label} · ${p.label} — click: show it on its own lifeline`);
    objChip.dataset.pull = obj.id;
    const layer = span('hc-layer', p.label, `${p.label}: scroll to its lifeline`);
    layer.dataset.participantId = p.id;
    layer.dataset.jump = '';
    box.append(objChip, layer);
    return box;
  };
  const row = doc.createElement('div');
  row.className = 'hc-route';
  const from = m.from ? byId.get(m.from) : undefined;
  if (m.kind === 'found' || !from) row.append(span('hc-arrow', '● ──▶'), end(to, m.objects?.to));
  else if (from.id === to.id && !m.objects) row.append(chip(from), span('hc-arrow', '↻ self'));
  else if (m.kind === 'create') row.append(end(from, m.objects?.from), span('hc-arrow', '┄«create»┄▶'), end(to, m.objects?.to));
  else row.append(end(from, m.objects?.from), span('hc-arrow', m.isAsync ? '──▷' : '──▶'), end(to, m.objects?.to));
  return row;
}

/** Hover card of a message: who calls whom, the call in UML form, notes, I/O and the importance (small, muted). */
export function messageCard(m: Message, doc: Document, d?: SequenceDiagram): Node[] {
  const div = (cls: string, text: string) => {
    const el = doc.createElement('div');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const [call, ...notes] = fullCallText(m).split('\n');
  const route = d ? routeRow(m, d, doc) : undefined;
  const out: Node[] = [...(route ? [route] : []), div('hc-call', call), ...notes.map((n) => div('hc-note', n))];
  if (m.recursive) out.push(div('hc-note', 'recursive call'));
  // FR-5.11 ↑ the method comes from a base class of the object
  if (m.inheritedFrom) out.push(div('hc-note', `↑ inherited: declared in ${m.inheritedFrom.name}`));
  // FR-1.19 why the target is unknown
  if (m.unresolved) out.push(div('hc-note hc-unresolved', m.unresolved));
  // why the arrow is red (or marked): the issues this call is evidence of, with the rule they break
  for (const f of d?.findings ?? []) {
    if (!f.messageIds?.includes(m.id)) continue;
    // FR-7.16 a possible violation: amber, said so
    out.push(div(`hc-issue${f.kind === 'layer-violation' && !f.possible ? ' violation' : ''}`, `${FINDING_ICON[f.kind]} ${issueTitle(f)}`));
    if (f.detail) out.push(div('hc-note', f.detail));
  }
  // FR-5.6 one of the creations sharing a lifeline: only one of them runs
  if (m.alternative) {
    const why = m.alternative.why === 'return' ? 'each of them is returned, which ends the method' : 'they are in different branches';
    out.push(div('hc-note', `Alternative ${m.alternative.index} of ${m.alternative.count} — ${why}: only one of these objects exists in a run, drawn on one lifeline`));
  }
  // FR-24.4 the called method's body changed on the branch
  if (m.diff?.method && !m.diff.status && !m.diff.call) {
    out.push(div('hc-diff-head changed', m.diff.method === 'added' ? 'Method added on this branch' : 'Method changed on this branch'));
    out.push(div('hc-note', 'Click the call (or right-click → Show the change) to open the method’s file side by side, base ↔ now'));
  }
  // FR-24.6 / FR-24.7 what the branch did to this call, and its lines of the diff
  if (m.diff?.status || m.diff?.call) {
    const what =
      m.diff.status === 'added' ? 'New call on this branch'
        : m.diff.status === 'removed' ? 'Removed on this branch (the base version made this call)'
          : m.diff.before ? `Reaches another method than before: ${m.diff.before}`
            : 'On a changed line';
    out.push(div(`hc-diff-head ${m.diff.status ?? 'changed'}`, what));
    // the same line, another target: the change is elsewhere (a new implementation, a changed signature)
    if (m.diff.before && !m.diff.hunk?.length) {
      const impls = m.polymorphic?.implementations.length ?? 0;
      out.push(div('hc-note', impls > 1 ? `This line was not edited: ${m.polymorphic!.interfaceName} now has ${impls} implementations, so the call is no longer resolved to one` : 'This line was not edited: the called method changed (its signature or its class)'));
    }
    if (m.diff.hunk?.length) {
      const pre = doc.createElement('div');
      pre.className = 'hc-hunk';
      for (const l of m.diff.hunk) pre.appendChild(div(`hc-hunk-line k${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx'}${l.at ? ' at' : ''}`, `${l.kind} ${l.text}`));
      out.push(pre);
    }
    out.push(div('hc-note', 'Click the call (or right-click → Show the change) to open its file side by side, base ↔ now'));
  }
  // the container's step: why it is drawn before the entry point
  if (m.id === 'container') out.push(div('hc-note', 'Setup, not a second entry point: before the entry point runs, the DI container makes its object and the objects it is given. ⊕ shows what it creates.'));
  // FR-16.3: the found message of an entry point: which one(s)
  if (m.id === 'root' && d?.entryPoints?.length) {
    out.push(div('hc-imp-head', d.entryPoints.length > 1 ? `Entry point (${d.entryPoints.length})` : 'Entry point'));
    for (const e of d.entryPoints) out.push(div('hc-imp', `${e.label}${e.detail ? ` · ${e.detail}` : ''}`));
    if (d.outcome) out.push(...outcomeRows(d.outcome, div));
  }
  // FR-28 zoomed to layers: the calls inside the layer this call folds away
  if (m.folded) {
    out.push(div('hc-imp-head', `Folded inside the layer (${m.folded.count})`));
    for (const n of m.folded.names) out.push(div('hc-imp', n));
    if (m.folded.count > m.folded.names.length) out.push(div('hc-imp', `+${m.folded.count - m.folded.names.length} more`));
    if (m.folded.expandable) out.push(div('hc-note', `${m.folded.expandable} of them still collapsed — ⊕ opens them`));
  }
  if (m.sideEffects) {
    const [head, ...lines] = sideEffectLines(m.sideEffects);
    out.push(div('hc-imp-head', head));
    for (const l of lines) out.push(div('hc-imp', l));
  }
  if (m.importance?.reasons.length) {
    // in plain words: what the score is for (a bare "Importance 0" reads as a verdict on the code)
    out.push(div('hc-imp-head', `How ✦ Overview weighs this call (score ${m.importance.score})`));
    for (const r of m.importance.reasons) out.push(div('hc-imp', r));
  }
  // FR-9.7 how to get to the other end without scrolling
  if (route && m.from && m.from !== m.to) out.push(div('hc-keys', 'Click a name to go there · → receiver · ← sender · ⌫ back'));
  return out;
}

/** Calls of one class listed in the outcome card; the rest counted. */
const OUTCOME_CALLS = 3;

/**
 * FR-32.2 the entry point's outcome in its hover card: per I/O kind the classes doing it, each with its calls (a call
 * with its place opens it), why it is "at least", the calls not resolved.
 */
function outcomeRows(o: FlowOutcome, div: (cls: string, text: string) => HTMLElement): Node[] {
  const out: Node[] = [div('hc-imp-head', 'What the whole flow touches (I/O)')];
  if (!o.io.length) out.push(div('hc-imp', 'no I/O found'));
  for (const k of o.io) {
    for (const v of k.via) {
      out.push(div('hc-imp hc-outcome-class', `${SIDE_EFFECT_TAG[k.kind]} · ${v.className}`));
      for (const c of v.calls.slice(0, OUTCOME_CALLS)) {
        const row = div('hc-imp hc-outcome-call', c.at ? `${c.call}  ${formatLocation(c.at)}` : c.call);
        // FR-2 a click opens the call's line
        if (c.at) row.dataset.nav = JSON.stringify(c.at);
        out.push(row);
      }
      if (v.calls.length > OUTCOME_CALLS) out.push(div('hc-imp hc-outcome-call', `+${v.calls.length - OUTCOME_CALLS} more`));
    }
  }
  if (o.atLeast) out.push(div('hc-note', `At least — there may be more: ${o.why}`));
  if (o.unresolved) out.push(div('hc-note', `${o.unresolved} call${o.unresolved > 1 ? 's' : ''} not resolved: what they do is not known`));
  return out;
}

/** Hover card of an early exit (FR-1.15). */
export function exitCard(e: ExitMarker, doc: Document): Node[] {
  const div = (cls: string, text: string) => {
    const el = doc.createElement('div');
    el.className = cls;
    el.textContent = text;
    return el;
  };
  const what = e.kind === 'return' ? 'Returns early' : `Throws${e.exception ? ` ${e.exception}` : ''}`;
  return [
    div('hc-call', e.guard ? `${what} when ${e.guard}` : `${what} here`),
    div('hc-note', `${formatLocation(e.range)} · click to go to the statement`),
  ];
}


/**
 * The part of a message to bring into view: its label and the sender's end of the arrow — not the
 * whole box, whose left edge may be far from the label (a long arrow drawn right to left). When both
 * do not fit into `viewWidth`, the label wins.
 */
export function messageFocusBox(mg: MessageGeom, viewWidth: number): { x: number; y: number; width: number; height: number } {
  const labelLeft = mg.labelX;
  const labelRight = mg.labelX + mg.label.width + 24; // + the ⊕ glyph / badges after the text
  // the whole call when it fits: both ends of the arrow with the label (a step of Find must not show the label while its arrow runs off)
  const wholeLeft = Math.min(labelLeft, mg.x1, mg.x2);
  const wholeRight = Math.max(labelRight, mg.x1, mg.x2);
  if (wholeRight - wholeLeft + 48 <= viewWidth) return { x: wholeLeft, y: mg.box.y, width: wholeRight - wholeLeft, height: mg.box.height };
  const left = Math.min(labelLeft, mg.x1);
  const right = Math.max(labelRight, mg.x1);
  const fits = right - left + 48 <= viewWidth;
  const x = fits ? left : labelLeft;
  return { x, y: mg.box.y, width: (fits ? right : labelRight) - x, height: mg.box.height };
}

/** how long a review stop's card stays without the mouse on it. */
const TOUR_CARD_MS = 8000;

/** the width a finding's card covers at the right of the view (it is placed at `right - 452`). */
const FINDING_CARD_ROOM = 460;

/** why no I/O badge shows (I/O badges on). */
export const NO_IO = 'No I/O found in the shown calls. Badges come from calls into I/O libraries and the runtime (files, fetch / HTTP clients, database drivers, queues, processes): your own data-access classes get one where they call such a library.';

/** FR-3.8 intents that open calls (their new calls are brought into view). */
const OPENING = new Set<SequenceViewToHost['type']>(['expand', 'expandAll', 'smartExpand', 'expandFragment', 'showErrorPath', 'showAllCases']);

/** FR-10.3 intents that expand or collapse the diagram (followed by a tidy up). */
const EXPANDING = new Set<SequenceViewToHost['type']>(['expand', 'collapse', 'expandAll', 'smartExpand', 'collapseAll', 'collapseFragment', 'expandFragment', 'showErrorPath', 'followCase', 'showAllCases']);

/** which calls are drawn and which are open: equal before and after = nothing changed. */
const openedCalls = (d: SequenceDiagram): string => d.messages.map((m) => `${m.id}${m.expanded ? '+' : ''}`).join('|');
