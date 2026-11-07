import dagre from '@dagrejs/dagre';
import type { ClassDiagram, ClassNode } from '@seqcall/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeScore, layoutClassDiagram, laneOrder, type ClassGeometry } from '../src/class/layout';
import { estimateTextWidth } from '../src/measure';

afterEach(() => vi.restoreAllMocks());

const cls = (key: string, layer?: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], namespace: 'src', methods: [], ...(layer ? { layer } : {}), ...extra }) as ClassNode;
const finite = (g: ClassGeometry) => JSON.stringify(g).match(/null|NaN/) === null;

describe('class layout: unusual diagrams', () => {
  it('FR-12.4 an empty diagram (nothing drawn yet) has an empty, finite geometry', () => {
    const g = layoutClassDiagram({ classes: [], relations: [] }, estimateTextWidth);
    expect([g.nodes, g.edges]).toEqual([[], []]);
    expect(finite(g)).toBe(true);
  });

  it('FR-12.5 two classes dragged onto the same spot: their relation is a point, not NaN', () => {
    const d: ClassDiagram = { classes: [cls('Shop'), cls('Order')], relations: [{ id: 'r', kind: 'association', from: 'Shop', to: 'Order' }] };
    const g = layoutClassDiagram(d, estimateTextWidth, { Shop: { x: 100, y: 100 }, Order: { x: 100, y: 100 } });
    const shop = g.nodes.find((n) => n.key === 'Shop')!;
    const order = g.nodes.find((n) => n.key === 'Order')!;
    expect(shop.width).toBe(order.width);
    expect(g.edges[0].points).toEqual([
      { x: shop.x + shop.width / 2, y: shop.y + shop.height / 2 },
      { x: shop.x + shop.width / 2, y: shop.y + shop.height / 2 },
    ]);
  });

  it('FR-26.5 a package lists all its classes without a row limit: as wide as the longest name', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'AVeryLongClassNameAtTheEnd'];
    const pkg = cls('pkg', undefined, { name: 'shop', group: { path: 'src/shop', classes: 7 }, methods: names.map((n) => ({ name: n, isStatic: false, signature: n })) });
    const limited = layoutClassDiagram({ classes: [pkg], relations: [] }, estimateTextWidth, {}, { methods: { maxMethods: 5, expanded: new Set() } });
    const all = layoutClassDiagram({ classes: [pkg], relations: [] }, estimateTextWidth, {}, { methods: { maxMethods: 0, expanded: new Set() } });
    expect(all.nodes[0].width).toBe(Math.ceil(estimateTextWidth('AVeryLongClassNameAtTheEnd', 'method') + 2 * 12));
    expect(limited.nodes[0].width).toBeLessThan(all.nodes[0].width);
  });

  it('FR-12.7 lanes follow the host\'s layer order; a layer it does not know comes after them; No layer last', () => {
    const d: ClassDiagram = { classes: [cls('C'), cls('A', 'Reporting'), cls('B', 'Domain')], relations: [], layers: ['Domain', 'Application'] };
    expect(laneOrder(d)).toEqual(['Domain', 'Reporting', '']);
    expect(laneOrder({ ...d, classes: d.classes.slice(1) })).toEqual(['Domain', 'Reporting']);
  });
});

describe('class layout: lanes (group by layer)', () => {
  it('FR-12.7 two relations between the same classes in different lanes are spread sideways; labels staggered', () => {
    const d: ClassDiagram = {
      classes: [cls('Shop', 'Application'), cls('Order', 'Domain')],
      relations: [
        { id: 'r1', kind: 'association', from: 'Shop', to: 'Order', label: 'orders' },
        { id: 'r2', kind: 'dependency', from: 'Shop', to: 'Order' },
      ],
    };
    const g = layoutClassDiagram(d, estimateTextWidth, {}, { lanes: true });
    const one = layoutClassDiagram({ ...d, relations: [d.relations[0]] }, estimateTextWidth, {}, { lanes: true });
    const [a, b] = g.edges;
    const base = one.edges[0].labelPos!;
    expect(a.labelPos).toEqual({ x: base.x - 8, y: base.y - 7.5 }); // half a step left, half a label up
    expect(b.labelPos).toBeUndefined();
    expect(b.points[0].x).toBeGreaterThan(a.points[0].x); // the two lines apart (the ends then spread along the boxes)
  });

  it('FR-12.7 a cross-lane relation that would cut through a class goes round it on the closer side (left here)', () => {
    const d: ClassDiagram = {
      classes: [cls('Ctrl', 'Presentation'), cls('Svc', 'Application'), cls('Far', 'Application'), cls('Repo', 'Infrastructure')],
      relations: [{ id: 'r', kind: 'dependency', from: 'Ctrl', to: 'Repo' }],
    };
    // dragged: Ctrl, Svc and Repo in a column, Far far to the right
    const manual = { Ctrl: { x: 100, y: 0 }, Svc: { x: 100, y: 150 }, Far: { x: 1500, y: 150 }, Repo: { x: 100, y: 300 } };
    const g = layoutClassDiagram(d, estimateTextWidth, manual, { lanes: true });
    const pts = g.edges[0].points;
    expect(pts).toHaveLength(6);
    const svc = g.nodes.find((n) => n.key === 'Svc')!;
    expect(pts[2].x).toBe(svc.x - 20); // the corridor left of the column
    expect(edgeScore(g)).toBeLessThan(10_000);
  });

  it('FR-12.7 a corridor that would leave the canvas on the left goes right instead', () => {
    const d: ClassDiagram = {
      classes: [cls('Ctrl', 'Presentation'), cls('Svc', 'Application'), cls('Far', 'Application'), cls('Repo', 'Infrastructure')],
      relations: [{ id: 'r', kind: 'dependency', from: 'Ctrl', to: 'Repo' }],
    };
    // the column at the left edge of the canvas
    const manual = { Ctrl: { x: 60, y: 0 }, Svc: { x: 60, y: 150 }, Far: { x: 1500, y: 150 }, Repo: { x: 60, y: 300 } };
    const g = layoutClassDiagram(d, estimateTextWidth, manual, { lanes: true });
    const far = g.nodes.find((n) => n.key === 'Far')!;
    expect(g.edges[0].points[2].x).toBe(far.x + far.width + 20);
  });
});

describe('class layout: quality score', () => {
  it('FR-12.5 an edge through a class costs 10 000 px on top of its length', () => {
    const node = (key: string, x: number) => ({ key, node: cls(key), x, y: 0, width: 100, height: 50, memberLines: [], memberParts: [], headerHeight: 30 });
    const g = {
      width: 500, height: 50, direction: 'TB' as const,
      nodes: [node('A', 0), node('B', 200), node('C', 400)],
      edges: [{ id: 'e', kind: 'dependency' as const, from: 'A', to: 'C', points: [{ x: 100, y: 25 }, { x: 400, y: 25 }], style: { dashed: true, head: 'open' as const } }],
    } as unknown as ClassGeometry;
    expect(edgeScore(g)).toBe(300 + 10_000);
  });
});

describe('class layout: dagre problems', () => {
  it('FR-12.5 dagre throwing something that is not an Error: the fallback says what', () => {
    vi.spyOn(dagre, 'layout').mockImplementation(() => {
      throw 'bad graph';
    });
    const g = layoutClassDiagram({ classes: [cls('A')], relations: [] }, estimateTextWidth);
    expect(g.fallback).toEqual({ kind: 'grid', reason: 'bad graph' });
  });

  it('FR-12.5 the simplified retry (left to right) has one edge per class pair and no UL alignment', () => {
    const real = dagre.layout;
    const seen: { align?: string; edges: number }[] = [];
    let calls = 0;
    vi.spyOn(dagre, 'layout').mockImplementation((g, opts) => {
      seen.push({ align: (g.graph() as { align?: string }).align, edges: g.edgeCount() });
      if (calls++ === 0) throw new Error('Not possible to find intersection inside of the rectangle');
      return real(g, opts);
    });
    const d: ClassDiagram = {
      classes: [cls('Shop'), cls('Order')],
      relations: [
        { id: 'r1', kind: 'association', from: 'Shop', to: 'Order', label: 'orders' },
        { id: 'r2', kind: 'dependency', from: 'Order', to: 'Shop' }, // the other way round: still one pair
      ],
    };
    const g = layoutClassDiagram(d, estimateTextWidth, {}, { direction: 'LR' });
    expect(seen).toEqual([{ align: 'UL', edges: 2 }, { align: undefined, edges: 1 }]);
    expect(g.fallback?.kind).toBe('simplified');
    expect(g.edges.map((e) => e.points.length)).toEqual([2, 2]); // straight
  });

  it('FR-12.5 a dagre that reports no positions or size: classes at the origin, nothing NaN', () => {
    vi.spyOn(dagre, 'layout').mockImplementation((g) => g); // positions and size never set
    const g = layoutClassDiagram({ classes: [cls('Shop'), cls('Order')], relations: [{ id: 'r', kind: 'dependency', from: 'Shop', to: 'Order' }] }, estimateTextWidth);
    expect(g.direction).toBe('TB');
    expect(finite(g)).toBe(true);
  });

  it('FR-12.5 a text measure that fails (NaN, 0) does not break dagre: no fallback', () => {
    const g = layoutClassDiagram({ classes: [cls('Shop'), cls('Order')], relations: [{ id: 'r', kind: 'dependency', from: 'Shop', to: 'Order' }] }, () => NaN);
    expect(g.fallback).toBeUndefined();
    // the boxes have no size, but dagre's route of the relation is not shifted by NaN
    expect(g.edges[0].points.length).toBeGreaterThan(2);
    expect(g.edges[0].points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});
