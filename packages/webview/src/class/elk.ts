/**
 * Class diagram layout with ELK (Eclipse Layout Kernel, layered algorithm): proper edge
 * routing with channel allocation, spread ports, and partitions for "group by layer" lanes.
 * Asynchronous (ELK's API returns a promise); the result goes through the same `assemble`
 * step as the dagre layout.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ClassDiagram, ClassRelation } from '@seqcall/protocol';
import { estimateTextWidth, type MeasureText } from '../measure';
import type { EdgeStyle } from './edges';
import {
  assemble,
  isInheritance,
  LANE_LAYOUT,
  laneOf,
  laneOrder,
  prepare,
  type AutoLayout,
  type ClassGeometry,
  type ClassPositions,
  type ClassSizes,
  type MethodDisplay,
} from './layout';

interface Point {
  x: number;
  y: number;
}

type ElkLike = { layout(graph: unknown): Promise<ElkGraph> };
let elk: ElkLike | undefined;

interface ElkGraph {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkGraph[];
  edges?: {
    id: string;
    sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
    labels?: { x?: number; y?: number; width?: number; height?: number }[];
  }[];
}

export interface ElkLayoutOptions {
  lanes?: boolean;
  routing?: ElkRouting;
}

export interface ElkAutoResult {
  sizes: ClassSizes;
  relations: ClassRelation[];
  auto: AutoLayout;
}

/** The (expensive, async) automatic part; the view caches it and re-assembles on drags. */
export type ElkRouting = 'ORTHOGONAL' | 'SPLINES';

/** ELK routing that suits an edge style: real splines for curves, orthogonal otherwise. */
export const routingFor = (style: EdgeStyle): ElkRouting => (style === 'curved' ? 'SPLINES' : 'ORTHOGONAL');

export async function elkAutoLayout(
  diagram: ClassDiagram,
  measure: MeasureText,
  lanes: boolean,
  routing: ElkRouting = 'ORTHOGONAL',
  methods?: MethodDisplay,
): Promise<ElkAutoResult> {
  const { sizes, relations } = prepare(diagram, measure, methods);
  return { sizes, relations, auto: await elkAuto(diagram, relations, sizes, measure, lanes, routing) };
}

/** Final geometry from a cached ELK result. ELK routes every edge (also across lanes): no corridor routing. */
export function assembleElk(diagram: ClassDiagram, r: ElkAutoResult, manual: ClassPositions, lanes: boolean): ClassGeometry {
  return assemble(diagram, r.sizes, r.relations, r.auto, manual, 'TB', lanes, false, false).geom;
}

export async function layoutClassDiagramElk(
  diagram: ClassDiagram,
  measure: MeasureText = estimateTextWidth,
  manual: ClassPositions = {},
  opts: ElkLayoutOptions = {},
): Promise<ClassGeometry> {
  return assembleElk(diagram, await elkAutoLayout(diagram, measure, !!opts.lanes, opts.routing), manual, !!opts.lanes);
}

async function elkAuto(
  diagram: ClassDiagram,
  relations: ClassRelation[],
  sizes: ClassSizes,
  measure: MeasureText,
  lanes: boolean,
  routing: ElkRouting,
): Promise<AutoLayout> {
  elk ??= new (ELK as unknown as new () => ElkLike)();
  const order = laneOrder(diagram);
  const lane = new Map(diagram.classes.map((c) => [c.key, order.indexOf(laneOf(c))]));
  // Lane headers need room between partitions.
  const betweenLayers = lanes ? LANE_LAYOUT.head + 2 * LANE_LAYOUT.pad + LANE_LAYOUT.gap + 16 : 56;
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': routing,
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(betweenLayers),
      'elk.spacing.edgeNode': '16',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.semiInteractive': 'false',
      'elk.edgeLabels.inline': 'false',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
      ...(lanes ? { 'elk.partitioning.activate': 'true' } : {}),
    },
    children: diagram.classes.map((c) => {
      const s = sizes.get(c.key)!;
      return {
        id: c.key,
        width: s.width,
        height: s.height,
        layoutOptions: lanes ? { 'elk.partitioning.partition': String(lane.get(c.key)) } : {},
      };
    }),
    edges: relations.map((r) => {
      // Inheritance points from the super type down to the subtype for ranking (super types on top).
      const [source, target] = isInheritance(r.kind) ? [r.to, r.from] : [r.from, r.to];
      return {
        id: r.id,
        sources: [source],
        targets: [target],
        labels: r.label && !r.labelObvious ? [{ text: r.label, width: measure(r.label, 'stereotype') + 8, height: 14 }] : [],
      };
    }),
  };
  let out = await elk.layout(graph);
  // ELK keeps a later partition after only part of an earlier one: when a lane needs several rows (two
  // folders calling each other), the next lane's boxes land between them and the lanes overlap. Then again, with
  // hidden edges from every class of a lane to every class of the next (only then: they change the picture).
  if (lanes && lanesInterleave(out, lane)) {
    const keys = diagram.classes.map((c) => c.key);
    const hidden = keys.flatMap((a) => keys.filter((b) => lane.get(b) === lane.get(a)! + 1).map((b) => ({ id: `lane-order:${a}>${b}`, sources: [a], targets: [b] })));
    out = await elk.layout({ ...graph, edges: [...graph.edges, ...hidden] });
  }
  const pos = new Map((out.children ?? []).map((n) => [n.id, { x: (n.x ?? 0) + (n.width ?? 0) / 2, y: (n.y ?? 0) + (n.height ?? 0) / 2 }]));
  const routed = new Map(
    (out.edges ?? []).map((e) => {
      const sec = e.sections?.[0];
      const points = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y })) : undefined;
      const l = e.labels?.[0];
      const label = l && l.x !== undefined && l.y !== undefined ? { x: l.x + (l.width ?? 0) / 2, y: l.y + (l.height ?? 0) / 2 } : undefined;
      // Spline sections come as Bézier control points (start, c1, c2, end, …).
      const bezier = routing === 'SPLINES' && !!points && (points.length - 1) % 3 === 0 && points.length > 2;
      return [e.id, { points, x: label?.x, y: label?.y, bezier }];
    }),
  );
  return {
    center: (key) => pos.get(key) ?? { x: 0, y: 0 },
    // `assemble` reverses inheritance points itself (dagre convention: laid out super → sub).
    edge: (r) => routed.get(r.id),
    // only dagre's TB / LR choice reads the auto size (layoutClassDiagram); ELK always lays out top-down
    autoWidth: 0,
    autoHeight: 0,
  };
}

/** Whether a class of a lane reaches below the top of a class of a later lane (ELK partitions out of order). */
function lanesInterleave(out: ElkGraph, lane: Map<string, number>): boolean {
  const top = new Map<number, number>();
  const bottom = new Map<number, number>();
  // ELK places every child
  for (const n of out.children!) {
    const l = lane.get(n.id)!;
    top.set(l, Math.min(top.get(l) ?? Infinity, n.y!));
    bottom.set(l, Math.max(bottom.get(l) ?? -Infinity, n.y! + n.height!));
  }
  return [...bottom].some(([l, b]) => [...top].some(([k, t]) => k > l && t < b));
}
