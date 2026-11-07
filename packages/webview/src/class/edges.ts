/** Edge shapes for the class diagram and endpoint spreading; pure (no DOM). */
import { round } from '../dom';

export type EdgeStyle = 'curved' | 'orthogonal' | 'straight';
export const EDGE_STYLES: { value: EdgeStyle; label: string }[] = [
  { value: 'curved', label: 'Curved' },
  { value: 'orthogonal', label: 'Right-angled' },
  { value: 'straight', label: 'Straight' },
];

interface Point {
  x: number;
  y: number;
}

interface Box {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Edge {
  from: string;
  to: string;
  points: Point[];
}

const fmt = (p: Point) => `${round(p.x)},${round(p.y)}`;
const isAxisAligned = (pts: Point[]) => pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 0.5 || Math.abs(p.y - pts[i - 1].y) < 0.5);

/** SVG path data for an edge's routed points in the given style. */
export function edgePathData(points: Point[], style: EdgeStyle, bezier = false): string {
  if (points.length < 2) return '';
  if (bezier && style === 'curved') {
    let d = `M${fmt(points[0])}`;
    for (let i = 1; i + 2 < points.length; i += 3) d += ` C${fmt(points[i])} ${fmt(points[i + 1])} ${fmt(points[i + 2])}`;
    return d;
  }
  const a = points[0];
  const b = points[points.length - 1];
  if (style === 'straight') return `M${fmt(a)} L${fmt(b)}`;
  if (style === 'orthogonal') return roundedPolyline(isAxisAligned(points) ? points : elbow(a, b), 6);
  return smooth(points);
}

/** One elbow route: vertical–horizontal–vertical for mostly vertical edges, else horizontal–vertical–horizontal. */
function elbow(a: Point, b: Point): Point[] {
  if (Math.abs(b.y - a.y) >= Math.abs(b.x - a.x)) {
    const my = (a.y + b.y) / 2;
    return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
  }
  const mx = (a.x + b.x) / 2;
  return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
}

function roundedPolyline(pts: Point[], radius: number): string {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 0.5);
  let d = `M${fmt(p[0])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1];
    const c = p[i];
    const next = p[i + 1];
    const l1 = Math.hypot(c.x - prev.x, c.y - prev.y);
    const l2 = Math.hypot(next.x - c.x, next.y - c.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const s = { x: c.x - ((c.x - prev.x) / l1) * r, y: c.y - ((c.y - prev.y) / l1) * r };
    const e = { x: c.x + ((next.x - c.x) / l2) * r, y: c.y + ((next.y - c.y) / l2) * r };
    d += ` L${fmt(s)} Q${fmt(c)} ${fmt(e)}`;
  }
  return `${d} L${fmt(p[p.length - 1])}`;
}

/**
 * Smooth curve: two points get an S-curve leaving/entering along the dominant axis (so the
 * arrowhead points into the box); longer routes become a Catmull-Rom spline through them.
 */
function smooth(pts: Point[]): string {
  if (pts.length === 2) {
    const [a, b] = pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const [c1, c2] =
      Math.abs(dy) >= Math.abs(dx)
        ? [{ x: a.x, y: a.y + dy / 2 }, { x: b.x, y: b.y - dy / 2 }]
        : [{ x: a.x + dx / 2, y: a.y }, { x: b.x - dx / 2, y: b.y }];
    return `M${fmt(a)} C${fmt(c1)} ${fmt(c2)} ${fmt(b)}`;
  }
  let d = `M${fmt(pts[0])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`;
  }
  return d;
}

type Side = 'top' | 'bottom' | 'left' | 'right';

function sideOf(b: Box, p: Point): Side {
  const d: [Side, number][] = [
    ['top', Math.abs(p.y - b.y)],
    ['bottom', Math.abs(p.y - (b.y + b.height))],
    ['left', Math.abs(p.x - b.x)],
    ['right', Math.abs(p.x - (b.x + b.width))],
  ];
  return d.reduce((m, c) => (c[1] < m[1] ? c : m), d[0])[0];
}

/**
 * Several edges meeting one side of a class at (nearly) the same point are spread along that
 * side, ordered by where they come from, so each arrow keeps its own attachment point. The
 * neighbouring route point moves along when the segment was axis-aligned (keeps right angles).
 */
export function spreadAttachments(boxes: Box[], edges: Edge[]): void {
  const byKey = new Map(boxes.map((b) => [b.key, b]));
  const groups = new Map<string, { edge: Edge; atStart: boolean }[]>();
  for (const edge of edges) {
    if (edge.points.length < 2) continue;
    for (const atStart of [true, false]) {
      const box = byKey.get(atStart ? edge.from : edge.to);
      if (!box) continue;
      const p = atStart ? edge.points[0] : edge.points[edge.points.length - 1];
      const k = `${box.key}\0${sideOf(box, p)}`;
      groups.set(k, [...(groups.get(k) ?? []), { edge, atStart }]);
    }
  }
  for (const [k, members] of groups) {
    if (members.length < 2) continue;
    const [key, side] = k.split('\0') as [string, Side];
    const box = byKey.get(key)!;
    const horizontal = side === 'top' || side === 'bottom';
    const other = (m: { edge: Edge; atStart: boolean }) => {
      const pts = m.edge.points;
      const q = m.atStart ? pts[Math.min(1, pts.length - 1)] : pts[Math.max(0, pts.length - 2)];
      return horizontal ? q.x : q.y;
    };
    members.sort((a, b) => other(a) - other(b));
    const len = horizontal ? box.width : box.height;
    const start = (horizontal ? box.x : box.y) + len * 0.2;
    const span = len * 0.6;
    members.forEach((m, i) => {
      const pts = m.edge.points;
      const idx = m.atStart ? 0 : pts.length - 1;
      const nIdx = m.atStart ? 1 : pts.length - 2;
      const pos = start + (span * (i + 0.5)) / members.length;
      const old = pts[idx];
      const neighbour = pts[nIdx];
      if (horizontal) {
        if (neighbour && pts.length > 2 && Math.abs(neighbour.x - old.x) < 0.5) pts[nIdx] = { x: pos, y: neighbour.y };
        pts[idx] = { x: pos, y: side === 'top' ? box.y : box.y + box.height };
      } else {
        if (neighbour && pts.length > 2 && Math.abs(neighbour.y - old.y) < 0.5) pts[nIdx] = { x: neighbour.x, y: pos };
        pts[idx] = { x: side === 'left' ? box.x : box.x + box.width, y: pos };
      }
    });
  }
}
