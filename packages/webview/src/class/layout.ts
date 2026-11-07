/** Class diagram auto-layout with dagre; pure (no DOM). */
import dagre from '@dagrejs/dagre';
import type { ClassDiagram, ClassNode, ClassRelation, RelationKind, RelationUse } from '@seqcall/protocol';
import { sortLayers } from '../layers';
import { spreadAttachments } from './edges';
import { estimateTextWidth, fitStereotypes, fitText, shownStereotypes, stereotypeText, type MeasureText } from '../measure';
import { IO_PILL_PAD, sideEffectText } from '../side-effects';

export interface Point {
  x: number;
  y: number;
}

export type MarkerKind = 'triangle-hollow' | 'arrow-open';

export interface RelationStyle {
  dashed: boolean;
  marker: MarkerKind;
}

/** UML notation per relation kind. */
export function relationStyle(kind: RelationKind): RelationStyle {
  switch (kind) {
    case 'realization':
      return { dashed: true, marker: 'triangle-hollow' };
    case 'generalization':
      return { dashed: false, marker: 'triangle-hollow' };
    case 'association':
      return { dashed: false, marker: 'arrow-open' };
    case 'dependency':
      return { dashed: true, marker: 'arrow-open' };
    case 'use':
      // FR-12.12: a dependency without a call — drawn lighter (dotted, styles.css `.rel-use`)
      return { dashed: true, marker: 'arrow-open' };
  }
}

export const CLASS_LAYOUT = {
  padX: 12,
  padY: 6,
  stereoH: 14,
  nameH: 18,
  methodH: 17,
  /**
   * Compact boxes: the class name decides the width; very short names get this minimum text
   * width. Stereotypes and method signatures never widen a box; they are truncated (tooltip).
   */
  minTextWidth: 96,
  margin: 24,
};

export interface ClassNodeGeom {
  key: string;
  node: ClassNode;
  /** Top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** All «stereotypes» on one (possibly truncated) line. */
  stereoLine?: string;
  /** Untruncated stereotype line (tooltip when `stereoLine` is truncated). */
  stereoFull?: string;
  /** Method lines as displayed (truncated to the box), parallel to `node.methods`. */
  memberLines: string[];
  /** The same split into the emphasised method name and the de-emphasised rest "(params): type". */
  memberParts: MemberParts[];
  /** Set when the class has more methods than shown ("… +k more") or is expanded ("fewer"). */
  more?: { expanded: boolean; hidden: string[]; total: number };
  /** Height of the name compartment. */
  headerHeight: number;
  /** FR-17.2 text width of the I/O pill. */
  ioWidth?: number;
}

export interface ClassEdgeGeom {
  id: string;
  kind: RelationKind;
  from: string;
  to: string;
  /** From the source class towards the target (marker at the last point). */
  points: Point[];
  label?: string;
  /** Full label for the tooltip (also when the drawn label is omitted as obvious). */
  title?: string;
  labelPos?: Point;
  /** FR-12.12: where the type is referenced (use relations; tooltip). */
  uses?: RelationUse[];
  style: RelationStyle;
  /** Dependency-rule violation (inner layer depending on an outer one). */
  violation?: string;
  /** FR-7.16 the violation rests on a guessed layer: why. */
  possible?: string[];
  /** Points are cubic Bézier control points (start, c1, c2, end, c1, c2, end, …) from ELK splines. */
  bezier?: boolean;
  /** FR-12.15 a collection field: hollow diamond at the source, `multiplicity` at the target. */
  aggregation?: boolean;
  multiplicity?: string;
  /** FR-26 an application-map edge merging this many relations (drawn thicker). */
  count?: number;
  /** FR-24.6 all its calls are new on the branch / were removed by it. */
  diff?: 'added' | 'removed';
}

/** A horizontal lane of the "group by layer" layout. */
export interface LaneGeom {
  layer?: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const LANE_LAYOUT = { head: 20, pad: 10, gap: 12, inset: 12 };

export type LayoutDirection = 'TB' | 'LR';

export interface ClassGeometry {
  width: number;
  height: number;
  /** Rank direction actually used (adaptive, see `layoutClassDiagram`). */
  direction: LayoutDirection;
  nodes: ClassNodeGeom[];
  edges: ClassEdgeGeom[];
  /** Set when dagre failed and a simpler layout was used (see `autoLayout`). */
  fallback?: LayoutFallback;
  /** Lanes, top to bottom, when laid out grouped by layer. */
  lanes?: LaneGeom[];
}

export interface LayoutFallback {
  kind: 'simplified' | 'grid';
  /** The layout error that caused the fallback. */
  reason: string;
}

export type ClassPositions = Record<string, Point>;

export interface MemberParts {
  name: string;
  rest: string;
}

/**
 * Splits "name(params): type" into the method name (styled like a sequence message name)
 * and the rest (styled like arguments), fitting both into `avail` px: the name wins, the
 * rest is truncated, down to "(…)" or nothing.
 */
export function fitMember(signature: string, avail: number, measure: MeasureText): MemberParts {
  const sig = signature.replace(/\s+/g, ' ').trim();
  const open = sig.indexOf('(');
  const fullName = open > 0 ? sig.slice(0, open) : sig;
  const fullRest = open > 0 ? sig.slice(open) : '';
  const name = fitText(fullName, avail, 'method', measure);
  const left = avail - measure(name, 'method') - 2;
  let rest = '';
  if (fullRest && name === fullName) {
    if (measure(fullRest, 'args') <= left) rest = fullRest;
    else if (measure('(…)', 'args') <= left) {
      // "(…" fits (it is narrower than "(…)"), so the cut keeps at least the "("
      rest = fitText(fullRest, left, 'args', measure);
    }
  }
  return { name, rest };
}

/** How many method rows a class box shows (FR-12.11). */
export interface MethodDisplay {
  /** Rows before the "… +k more" row; 0 = no limit. */
  maxMethods: number;
  /** Classes the user expanded to all their methods. */
  expanded: ReadonlySet<string>;
}
export const DEFAULT_METHOD_DISPLAY: MethodDisplay = { maxMethods: 5, expanded: new Set() };

/** FR-26 widest class-name column of a package box. */
const PACKAGE_MAX_TEXT = 240;

/** FR-26 the line under a package's tab: `12 classes · ⚠ 2 inside`. */
export function packageLine(g: NonNullable<ClassNode['group']>): string {
  const inside = g.in ? ` · in ${g.in.split('/').pop()}` : '';
  return `${g.classes} class${g.classes === 1 ? '' : 'es'}${g.violations ? ` · ⚠ ${g.violations} inside` : ''}${inside}`;
}

function nodeSize(n: ClassNode, measure: MeasureText, display: MethodDisplay = DEFAULT_METHOD_DISPLAY) {
  const o = CLASS_LAYOUT;
  // FR-26 a package (codebase map): how many classes it holds instead of stereotypes
  const stereotypes = shownStereotypes(n.stereotypes, n.name);
  const stereoFull = n.group ? packageLine(n.group) : stereotypeText(stereotypes);
  // a package lists class names: as wide as the longest (within reason; longer ones are cut with …)
  const classesW = n.group ? Math.min(PACKAGE_MAX_TEXT, Math.max(0, ...n.methods.slice(0, display.maxMethods || undefined).map((m) => measure(m.name, 'method')))) : 0;
  // FR-28.7 ⊖ in the corner of an opened class: room on both sides, so the centred name clears it
  const corner = n.inLayer ? 2 * 14 : 0;
  const textW = Math.max(o.minTextWidth, measure(n.name, 'className') + corner, n.group ? measure(stereoFull!, 'stereotype') : 0, classesW);
  // FR-17.2 the I/O pill sits on the name compartment's lower edge: the box is at least as wide
  // FR-28.5 a layer package carries the union of its classes' I/O (a folder of the codebase map does not)
  const ioWidth = n.sideEffects && (!n.group || n.group.zoom) ? Math.ceil(measure(sideEffectText(n.sideEffects), 'tag')) : undefined;
  const width = Math.max(Math.ceil(textW + 2 * o.padX), ioWidth ? ioWidth + 2 * IO_PILL_PAD + 12 : 0);
  const stereoLine = n.group ? stereoFull : fitStereotypes(stereotypes, width - 2 * o.padX, measure);
  // Beyond maxMethods a muted "… +k more" row replaces the rest (a single extra method is
  // simply shown: the row would take the same space); expanded classes show all + "fewer".
  const total = n.methods.length;
  const collapsible = display.maxMethods > 0 && total > display.maxMethods + 1;
  const expanded = collapsible && display.expanded.has(n.key);
  const shownMethods = collapsible && !expanded ? display.maxMethods : total;
  const hiddenMethods = n.methods.slice(shownMethods).map((m) => m.name);
  const memberParts = n.methods.slice(0, shownMethods).map((m) => fitMember(m.signature, width - 2 * o.padX, measure));
  const memberLines = memberParts.map((p) => p.name + p.rest);
  const headerHeight = o.padY + (stereoLine ? o.stereoH : 0) + o.nameH + o.padY;
  const rows = shownMethods + (collapsible ? 1 : 0);
  const methodsH = rows ? o.padY + rows * o.methodH + o.padY : 12;
  const more = collapsible ? { expanded, hidden: hiddenMethods, total } : undefined;
  return { width, height: headerHeight + methodsH, stereoLine, stereoFull, memberLines, memberParts, headerHeight, more, ioWidth };
}

/** Intersection of the segment centre→`toward` with the border of a node box. */
function clip(n: ClassNodeGeom, toward: Point): Point {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? n.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? n.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export const isInheritance = (k: RelationKind) => k === 'realization' || k === 'generalization';

export interface ClassLayoutOptions {
  /** Size of the visible area; wide TB layouts beyond it may switch to LR. Default 1200×800. */
  viewportWidth?: number;
  viewportHeight?: number;
  /** Forces a direction instead of choosing adaptively. */
  direction?: LayoutDirection;
  /** Group by layer: one horizontal lane per layer, in architectural order. */
  lanes?: boolean;
  /** Method rows per class (default: 5, none expanded). */
  methods?: MethodDisplay;
}

/** A top-to-bottom layout that is much wider than tall (star graphs: one hub, many leaves). */
export function isTooWide(width: number, height: number, viewportWidth: number): boolean {
  return width > 2 * height && width > viewportWidth;
}

/** How far a layout has to be scaled down to fit the viewport (bigger is better). */
export function fitScore(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  return Math.min(1, viewportWidth / Math.max(1, width), viewportHeight / Math.max(1, height));
}

/**
 * Lays out top-to-bottom (super types above subtypes). When that is much wider than tall
 * and wider than the viewport (star graphs: one hub, many leaves) it re-runs left-to-right,
 * which stacks the leaves in a column (hub aligned to the top), and keeps that when it fits
 * the viewport clearly better (≥ 1.5×). The choice ignores manual positions, so dragging
 * never flips it.
 */
export function layoutClassDiagram(
  diagram: ClassDiagram,
  measure: MeasureText = estimateTextWidth,
  manual: ClassPositions = {},
  opts: ClassLayoutOptions = {},
): ClassGeometry {
  const md = opts.methods ?? DEFAULT_METHOD_DISPLAY;
  if (opts.lanes) return layoutDirected(diagram, measure, manual, 'TB', true, md).geom;
  if (opts.direction) return layoutDirected(diagram, measure, manual, opts.direction, false, md).geom;
  const tb = layoutDirected(diagram, measure, manual, 'TB', false, md);
  const vw = opts.viewportWidth || 1200;
  const vh = opts.viewportHeight || 800;
  if (!isTooWide(tb.autoWidth, tb.autoHeight, vw)) return tb.geom;
  const lr = layoutDirected(diagram, measure, manual, 'LR', false, md);
  return fitScore(lr.autoWidth, lr.autoHeight, vw, vh) >= 1.5 * fitScore(tb.autoWidth, tb.autoHeight, vw, vh) ? lr.geom : tb.geom;
}

function layoutDirected(
  diagram: ClassDiagram,
  measure: MeasureText,
  manual: ClassPositions,
  rankdir: LayoutDirection,
  lanes = false,
  methods: MethodDisplay = DEFAULT_METHOD_DISPLAY,
): { geom: ClassGeometry; autoWidth: number; autoHeight: number } {
  const { sizes, relations } = prepare(diagram, measure, methods);
  const auto = lanes ? laneLayout(diagram, relations, sizes, measure) : autoLayout(diagram, relations, sizes, measure, rankdir);
  return assemble(diagram, sizes, relations, auto, manual, rankdir, lanes, lanes);
}

export type ClassSizes = Map<string, ReturnType<typeof nodeSize>>;

/** Box sizes and the relations that can be drawn (both ends present, no self relations). */
export function prepare(diagram: ClassDiagram, measure: MeasureText, methods: MethodDisplay = DEFAULT_METHOD_DISPLAY): { sizes: ClassSizes; relations: ClassRelation[] } {
  const sizes = new Map(diagram.classes.map((c) => [c.key, nodeSize(c, measure, methods)]));
  const relations = diagram.relations.filter((r) => sizes.has(r.from) && sizes.has(r.to) && r.from !== r.to);
  return { sizes, relations };
}

/**
 * Turns an automatic layout (dagre or ELK) into the final geometry: bounds shift, manual
 * positions, edge points (straight for dragged classes), corridor routing for lanes (only
 * when the engine does not route cross-lane edges itself), attachment spreading, lane rects.
 */
export function assemble(
  diagram: ClassDiagram,
  sizes: ClassSizes,
  relations: ClassRelation[],
  auto: AutoLayout,
  manual: ClassPositions,
  rankdir: LayoutDirection,
  lanes: boolean,
  routeLanes: boolean,
  /** dagre layouts get spread attachment points; ELK allocates its own ports. */
  spread = true,
): { geom: ClassGeometry; autoWidth: number; autoHeight: number } {
  const o = CLASS_LAYOUT;
  // Lanes need room above their first row of classes for the lane header.
  const topReserve = lanes ? LANE_LAYOUT.head + LANE_LAYOUT.pad : 0;
  const { autoWidth, autoHeight } = auto;

  // Tight bounds: the automatic layout is shifted so its content starts at the margin. The
  // shift depends on the automatic layout only — manual positions are already in display
  // coordinates and must stay exactly where the user dropped them (applying the shift to them
  // would make dragged classes run away on every render, e.g. in the lane layout).
  const autoPoints = relations.flatMap((r) => auto.edge(r)?.points ?? []);
  const autoMinX = Math.min(...diagram.classes.map((c) => auto.center(c.key).x - sizes.get(c.key)!.width / 2), ...autoPoints.map((p) => p.x));
  const autoMinY = Math.min(...diagram.classes.map((c) => auto.center(c.key).y - sizes.get(c.key)!.height / 2 - topReserve), ...autoPoints.map((p) => p.y));
  const shiftX = Number.isFinite(autoMinX) ? o.margin - autoMinX : 0;
  const shiftY = Number.isFinite(autoMinY) ? o.margin - autoMinY : 0;
  const shifted = (p: Point): Point => ({ x: p.x + shiftX, y: p.y + shiftY });

  const nodes: ClassNodeGeom[] = diagram.classes.map((c) => {
    const s = sizes.get(c.key)!;
    const n = shifted(auto.center(c.key));
    const m = manual[c.key];
    const cx = m ? m.x : n.x;
    const cy = m ? m.y : n.y;
    return { key: c.key, node: c, x: cx - s.width / 2, y: cy - s.height / 2, width: s.width, height: s.height, stereoLine: s.stereoLine, stereoFull: s.stereoFull, memberLines: s.memberLines, memberParts: s.memberParts, more: s.more, headerHeight: s.headerHeight, ...(s.ioWidth !== undefined ? { ioWidth: s.ioWidth } : {}) };
  });
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  const edges: ClassEdgeGeom[] = relations.map((r) => {
    const inh = isInheritance(r.kind);
    const e = auto.edge(r);
    const a = byKey.get(r.from)!;
    const b = byKey.get(r.to)!;
    let points: Point[];
    let labelPos: Point | undefined;
    let bezier = false;
    if (manual[r.from] || manual[r.to] || !e?.points?.length) {
      const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
      const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      points = [clip(a, cb), clip(b, ca)];
      labelPos = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    } else {
      points = e.points.map((p: Point) => shifted(p));
      bezier = !!e.bezier;
      if (inh) points.reverse();
      labelPos = e.x !== undefined && e.y !== undefined ? shifted({ x: e.x, y: e.y }) : undefined;
    }
    // Obvious names (`_coupon: Coupon`) are not drawn; they stay in the tooltip.
    const shown = r.labelObvious ? undefined : r.label;
    return { id: r.id, kind: r.kind, from: r.from, to: r.to, points, label: shown, title: r.label, labelPos: shown ? labelPos : undefined, style: relationStyle(r.kind), violation: r.violation, ...(r.possible ? { possible: r.possible } : {}), bezier: bezier || undefined, ...(r.uses ? { uses: r.uses } : {}), ...(r.aggregation ? { aggregation: true } : {}), ...(r.multiplicity ? { multiplicity: r.multiplicity } : {}), ...(r.diff ? { diff: r.diff } : {}), ...(r.count ? { count: r.count } : {}) };
  });

  if (lanes && routeLanes) routeAroundLanes(diagram, nodes, edges);
  if (spread) spreadAttachments(nodes, edges);

  const maxX = Math.max(0, ...nodes.map((n) => n.x + n.width), ...edges.flatMap((e) => e.points.map((p) => p.x)));
  const maxY = Math.max(0, ...nodes.map((n) => n.y + n.height), ...edges.flatMap((e) => e.points.map((p) => p.y)));
  const width = Math.ceil(maxX + o.margin);
  return {
    geom: {
      width,
      height: Math.ceil(maxY + o.margin),
      direction: rankdir,
      nodes,
      edges,
      fallback: auto.fallback,
      lanes: lanes ? laneRects(diagram, nodes, width) : undefined,
    },
    autoWidth,
    autoHeight,
  };
}

export const laneOf = (c: ClassNode): string => c.layer ?? '';

/**
 * Lane order: the layers architecturally, then classes without a layer (composition roots, shared code, a project no
 * rule places) last — on top they would sit above Presentation and read as the outermost layer.
 */
export function laneOrder(diagram: ClassDiagram): string[] {
  const present = new Set(diagram.classes.map(laneOf));
  const layers = diagram.layers?.length ? diagram.layers : sortLayers([...present].filter(Boolean));
  const order = layers.filter((l) => present.has(l));
  for (const l of present) if (l && !order.includes(l)) order.push(l);
  return present.has('') ? [...order, ''] : order;
}

/**
 * Group by layer: each lane is laid out on its own (dagre, top-to-bottom) and the lanes are
 * stacked in architectural order. Each lane is shifted horizontally towards the classes it is
 * connected to in the lanes above (median offset), which keeps cross-lane edges short.
 * Cross-lane edges are straight, or routed around classes by `routeAroundLanes`.
 *
 * (Why not one dagre run with invisible lane-anchor nodes: it routes cross-lane edges, but
 * with long detours and still across boxes.)
 */
function laneLayout(
  diagram: ClassDiagram,
  relations: ClassRelation[],
  sizes: Map<string, { width: number; height: number }>,
  measure: MeasureText,
): AutoLayout {
  const L = LANE_LAYOUT;
  const lane = new Map(diagram.classes.map((c) => [c.key, laneOf(c)]));
  const centers = new Map<string, Point>();
  const edgeOf = new Map<string, { points?: Point[]; x?: number; y?: number }>();
  let fallback: LayoutFallback | undefined;
  let y = 0;
  for (const l of laneOrder(diagram)) {
    const classes = diagram.classes.filter((c) => laneOf(c) === l);
    const inner = relations.filter((r) => lane.get(r.from) === l && lane.get(r.to) === l);
    const a = autoLayout({ classes, relations: inner }, inner, sizes, measure, 'TB');
    fallback ??= a.fallback;
    const local = new Map(classes.map((c) => [c.key, a.center(c.key)]));
    const shifts = relations.flatMap((r) => {
      const [mine, other] = local.has(r.from) && centers.has(r.to) ? [r.from, r.to] : local.has(r.to) && centers.has(r.from) ? [r.to, r.from] : [];
      return mine ? [centers.get(other!)!.x - local.get(mine)!.x] : [];
    });
    const dx = shifts.length ? median(shifts) : 0;
    const top = Math.min(...classes.map((c) => local.get(c.key)!.y - finiteSize(sizes.get(c.key)!.height) / 2));
    const bottom = Math.max(...classes.map((c) => local.get(c.key)!.y + finiteSize(sizes.get(c.key)!.height) / 2));
    const dy = y + L.head + L.pad - top;
    for (const [k, p] of local) centers.set(k, { x: p.x + dx, y: p.y + dy });
    for (const r of inner) {
      const e = a.edge(r);
      if (e?.points) {
        edgeOf.set(r.id, {
          points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          x: e.x !== undefined ? e.x + dx : undefined,
          y: e.y !== undefined ? e.y + dy : undefined,
        });
      }
    }
    y = dy + bottom + L.pad + L.gap;
  }
  return {
    center: (key) => centers.get(key)!, // every class is in a lane
    edge: (r) => edgeOf.get(r.id),
    // only the TB / LR choice reads the auto size, and lanes are always top-down (layoutClassDiagram)
    autoWidth: 0,
    autoHeight: 0,
    fallback,
  };
}

/**
 * Per-lane layouts draw cross-lane edges straight, which can cut through classes in the
 * lanes in between. Such edges are re-routed orthogonally: into the gap next to the source
 * lane, along a free corridor right of everything they would pass, and into the target lane.
 */
function routeAroundLanes(diagram: ClassDiagram, nodes: ClassNodeGeom[], edges: ClassEdgeGeom[]): void {
  const order = laneOrder(diagram);
  const laneIdx = new Map(nodes.map((n) => [n.key, order.indexOf(laneOf(n.node))]));
  const rects = laneRects(diagram, nodes, 0);
  const rectOf = (i: number) => rects.find((r) => (r.layer ?? '') === order[i])!;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const half = LANE_LAYOUT.gap / 2;
  // Parallel straight edges between the same two classes (e.g. two fields of one type) are
  // spread sideways so they and their labels don't sit on top of each other.
  const pairs = new Map<string, ClassEdgeGeom[]>();
  for (const e of edges) {
    if (e.points.length !== 2) continue;
    const k = [e.from, e.to].sort().join('\0');
    pairs.set(k, [...(pairs.get(k) ?? []), e]);
  }
  for (const group of pairs.values()) {
    if (group.length < 2) continue;
    group.forEach((e, i) => {
      const k = i - (group.length - 1) / 2;
      e.points = e.points.map((p) => ({ x: p.x + k * 16, y: p.y }));
      // Labels are wider than the 16 px spread: stagger them vertically too.
      if (e.labelPos) e.labelPos = { x: (e.points[0].x + e.points[1].x) / 2, y: (e.points[0].y + e.points[1].y) / 2 + k * 15 };
    });
  }
  const TRACK = 14;
  const tracks = { left: 0, right: 0 };
  for (const e of edges) {
    const ia = laneIdx.get(e.from)!;
    const ib = laneIdx.get(e.to)!;
    if (ia === ib || e.points.length !== 2) continue;
    const blocked = nodes.some((n) => n.key !== e.from && n.key !== e.to && segmentHitsRect(e.points[0], e.points[1], n.x + 2, n.y + 2, n.width - 4, n.height - 4));
    if (!blocked) continue;
    const a = byKey.get(e.from)!;
    const b = byKey.get(e.to)!;
    const down = ib > ia;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const passing = nodes.filter((n) => laneIdx.get(n.key)! >= lo && laneIdx.get(n.key)! <= hi);
    // Corridor on the closer side of everything passed (left only while it stays on the canvas);
    // each corridor edge gets its own track.
    const rightBase = Math.max(...passing.map((n) => n.x + n.width)) + 20;
    const leftBase = Math.min(...passing.map((n) => n.x)) - 20;
    const mid = (a.x + a.width / 2 + b.x + b.width / 2) / 2;
    const leftX = leftBase - TRACK * tracks.left;
    const useLeft = leftX >= 8 && mid - leftBase < rightBase - mid;
    const cx = useLeft ? leftX : rightBase + TRACK * tracks.right;
    if (useLeft) tracks.left++;
    else tracks.right++;
    const ra = rectOf(ia);
    const rb = rectOf(ib);
    const y1 = down ? ra.y + ra.height + half : ra.y - half;
    const y2 = down ? rb.y - half : rb.y + rb.height + half;
    const start = { x: a.x + a.width / 2, y: down ? a.y + a.height : a.y };
    const end = { x: b.x + b.width / 2, y: down ? b.y : b.y + b.height };
    e.points = [start, { x: start.x, y: y1 }, { x: cx, y: y1 }, { x: cx, y: y2 }, { x: end.x, y: y2 }, end];
    if (e.label) e.labelPos = { x: cx, y: (y1 + y2) / 2 };
  }
}

/** Lane rectangles around their (possibly dragged) member classes, spanning the diagram width. */
function laneRects(diagram: ClassDiagram, nodes: ClassNodeGeom[], width: number): LaneGeom[] {
  const L = LANE_LAYOUT;
  return laneOrder(diagram).flatMap((l) => {
    const members = nodes.filter((n) => laneOf(n.node) === l); // never empty: laneOrder lists the layers present
    const y1 = Math.min(...members.map((n) => n.y)) - L.head - L.pad;
    const y2 = Math.max(...members.map((n) => n.y + n.height)) + L.pad;
    return [{ layer: l || undefined, label: l || 'No layer', x: L.inset, y: y1, width: width - 2 * L.inset, height: y2 - y1 }];
  });
}

const CROSSING_PENALTY = 10_000;

/** Layout quality: each edge segment passing through another class weighs 10 000 px, plus total edge length. */
export function edgeScore(geom: ClassGeometry): number {
  let score = 0;
  for (const e of geom.edges) {
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1];
      const b = e.points[i];
      score += Math.hypot(b.x - a.x, b.y - a.y);
      for (const n of geom.nodes) {
        if (n.key === e.from || n.key === e.to) continue;
        if (segmentHitsRect(a, b, n.x + 2, n.y + 2, n.width - 4, n.height - 4)) score += CROSSING_PENALTY;
      }
    }
  }
  return score;
}

function segmentHitsRect(a: Point, b: Point, x: number, y: number, w: number, h: number): boolean {
  // Liang–Barsky clipping: does segment ab intersect the rectangle?
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - x], [dx, x + w - a.x], [-dy, a.y - y], [dy, y + h - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface AutoLayout {
  center(key: string): Point;
  /** Routed edge (points + label position), if the layout produced one. */
  edge(r: ClassRelation): { points?: Point[]; x?: number; y?: number; bezier?: boolean } | undefined;
  autoWidth: number;
  autoHeight: number;
  fallback?: LayoutFallback;
}

/**
 * dagre occasionally throws on degenerate geometry ("Not possible to find intersection
 * inside of the rectangle"). The class view must never go blank because of it: retry with a
 * simplified graph (one unlabelled edge per class pair), then fall back to a grid with
 * straight edges. The geometry reports which fallback was used and why.
 */
function autoLayout(
  diagram: ClassDiagram,
  relations: ClassRelation[],
  sizes: Map<string, { width: number; height: number }>,
  measure: MeasureText,
  rankdir: LayoutDirection,
): AutoLayout {
  let firstError: string | undefined;
  for (const simplified of [false, true]) {
    try {
      return { ...runDagre(diagram, relations, sizes, measure, rankdir, simplified), fallback: simplified ? { kind: 'simplified', reason: firstError! } : undefined };
    } catch (e) {
      firstError ??= e instanceof Error ? e.message : String(e);
    }
  }
  return { ...gridLayout(diagram, sizes), fallback: { kind: 'grid', reason: firstError! } };
}

function runDagre(
  diagram: ClassDiagram,
  relations: ClassRelation[],
  sizes: Map<string, { width: number; height: number }>,
  measure: MeasureText,
  rankdir: LayoutDirection,
  simplified: boolean,
): Omit<AutoLayout, 'fallback'> {
  const o = CLASS_LAYOUT;
  const g = new dagre.graphlib.Graph({ multigraph: !simplified });
  g.setGraph(
    rankdir === 'TB'
      ? { rankdir, nodesep: 48, ranksep: 64, edgesep: 16, marginx: o.margin, marginy: o.margin }
      : { rankdir, ...(simplified ? {} : { align: 'UL' }), nodesep: 20, ranksep: 96, edgesep: 12, marginx: o.margin, marginy: o.margin },
  );
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of diagram.classes) {
    const s = sizes.get(c.key)!;
    g.setNode(c.key, { width: finiteSize(s.width), height: finiteSize(s.height) });
  }
  const seenPairs = new Set<string>();
  for (const r of relations) {
    // Inheritance edges are laid out reversed so super types rank above their subtypes.
    const [v, w] = isInheritance(r.kind) ? [r.to, r.from] : [r.from, r.to];
    if (simplified) {
      const pair = [v, w].sort().join('\0');
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      g.setEdge(v, w, {});
    } else {
      const label = r.label && !r.labelObvious ? { width: measure(r.label, 'stereotype') + 8, height: 14, labelpos: 'c' as const } : {};
      g.setEdge(v, w, { ...label }, r.id);
    }
  }
  dagre.layout(g);
  const graph = g.graph();
  return {
    center: (key) => {
      const n = g.node(key); // every class is a node
      return { x: n.x ?? 0, y: n.y ?? 0 };
    },
    // Simplified layouts draw straight edges (the routed edge may belong to another relation).
    edge: (r) => (simplified ? undefined : isInheritance(r.kind) ? g.edge(r.to, r.from, r.id) : g.edge(r.from, r.to, r.id)),
    autoWidth: graph.width ?? 0,
    autoHeight: graph.height ?? 0,
  };
}

/** Last resort: classes in a near-square grid, in diagram order. */
function gridLayout(diagram: ClassDiagram, sizes: Map<string, { width: number; height: number }>): Omit<AutoLayout, 'fallback'> {
  const o = CLASS_LAYOUT;
  const gap = 48;
  const cols = Math.max(1, Math.ceil(Math.sqrt(diagram.classes.length)));
  const colW = Math.max(0, ...diagram.classes.map((c) => finiteSize(sizes.get(c.key)!.width)));
  const centers = new Map<string, Point>();
  let y = o.margin;
  for (let i = 0; i < diagram.classes.length; i += cols) {
    const row = diagram.classes.slice(i, i + cols);
    const rowH = Math.max(...row.map((c) => finiteSize(sizes.get(c.key)!.height)));
    row.forEach((c, j) => centers.set(c.key, { x: o.margin + j * (colW + gap) + colW / 2, y: y + rowH / 2 }));
    y += rowH + gap;
  }
  return {
    center: (key) => centers.get(key)!, // every class has a cell
    edge: () => undefined,
    autoWidth: o.margin * 2 + cols * colW + (cols - 1) * gap,
    autoHeight: y - gap + o.margin,
  };
}

const finiteSize = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 40);
