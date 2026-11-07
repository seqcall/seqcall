// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { edgePathData, spreadAttachments } from '../src/class/edges';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge, fire, viewOptionRow } from './helpers';

describe('edge styles', () => {
  const pts = [{ x: 0, y: 0 }, { x: 40, y: 50 }, { x: 100, y: 120 }];

  it('straight: one segment from source to target', () => {
    expect(edgePathData(pts, 'straight')).toBe('M0,0 L100,120');
  });

  it('right-angled: only horizontal/vertical runs (rounded corners as quadratic curves)', () => {
    const d = edgePathData(pts, 'orthogonal');
    expect(d).toMatch(/^M0,0 L0,\d+ Q/);
    const coords = [...d.matchAll(/[LM](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(coords.at(-1)).toEqual([100, 120]);
  });

  it('curved: cubic curves, a two-point edge leaves and enters along the dominant axis', () => {
    expect(edgePathData([{ x: 0, y: 0 }, { x: 50, y: 100 }], 'curved')).toBe('M0,0 C0,50 50,50 50,100');
    expect(edgePathData(pts, 'curved').match(/C/g)).toHaveLength(2);
  });
});

describe('edge styles: unusual routes', () => {
  it('FR-14.2 a relation without a route draws nothing', () => {
    expect(edgePathData([{ x: 5, y: 5 }], 'curved')).toBe('');
  });

  it('FR-14.2 right-angled: a mostly horizontal diagonal route becomes horizontal–vertical–horizontal', () => {
    expect(edgePathData([{ x: 0, y: 0 }, { x: 30, y: 20 }, { x: 100, y: 40 }], 'orthogonal')).toBe('M0,0 L44,0 Q50,0 50,6 L50,34 Q50,40 56,40 L100,40');
  });
});

describe('attachment spreading: unusual edges', () => {
  it('FR-12.5 edges meeting a left side are spread along it; an axis-aligned last segment moves along (right angles kept)', () => {
    const boxes = [{ key: 'T', x: 100, y: 100, width: 100, height: 50 }];
    const edges = [
      { from: 'A', to: 'T', points: [{ x: 0, y: 0 }, { x: 0, y: 125 }, { x: 100, y: 125 }] },
      { from: 'B', to: 'T', points: [{ x: 0, y: 300 }, { x: 50, y: 300 }, { x: 100, y: 125 }] },
      { from: 'C', to: 'T', points: [{ x: 100, y: 140 }] }, // no route (one point on the same side): left alone
    ];
    spreadAttachments(boxes, edges);
    expect(edges[0].points).toEqual([{ x: 0, y: 0 }, { x: 0, y: 117.5 }, { x: 100, y: 117.5 }]); // upper slot, the horizontal run moved along
    expect(edges[1].points).toEqual([{ x: 0, y: 300 }, { x: 50, y: 300 }, { x: 100, y: 132.5 }]); // lower slot, the slanted run kept
    expect(edges[2].points).toEqual([{ x: 100, y: 140 }]);
  });
});

describe('attachment spreading', () => {
  it('edges meeting the same side of a class get distinct, ordered attachment points', () => {
    const boxes = [
      { key: 'T', x: 100, y: 100, width: 100, height: 50 },
      { key: 'A', x: 0, y: 0, width: 40, height: 20 },
      { key: 'B', x: 260, y: 0, width: 40, height: 20 },
    ];
    const edges = [
      { from: 'B', to: 'T', points: [{ x: 280, y: 20 }, { x: 150, y: 100 }] },
      { from: 'A', to: 'T', points: [{ x: 20, y: 20 }, { x: 150, y: 100 }] },
    ];
    spreadAttachments(boxes, edges);
    const [fromB, fromA] = edges.map((e) => e.points.at(-1)!);
    expect(fromA.y).toBe(100);
    expect(fromB.y).toBe(100);
    expect(fromA.x).toBeLessThan(fromB.x); // ordered by where they come from
    expect(fromA.x).toBeGreaterThan(100);
    expect(fromB.x).toBeLessThan(200);
  });
});

describe('class view: edge style selector and hover highlight', () => {
  function setup() {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    return { bridge, view };
  }

  it('defaults to curved, switching re-renders and is remembered', () => {
    const { bridge, view } = setup();
    expect(viewOptionRow(view, 'edges:curved').getAttribute('aria-checked')).toBe('true');
    expect(view.canvas.querySelector('.rel-line')!.getAttribute('d')).toContain('C');
    fire(viewOptionRow(view, 'edges:straight'), 'click');
    expect(view.canvas.querySelector('.rel-line')!.getAttribute('d')).not.toContain('C');
    expect(bridge.getState<{ edgeStyle?: string }>()!.edgeStyle).toBe('straight');
    // the menu stayed open with the new choice; the View button says an option differs from its default
    expect(viewOptionRow(view, 'edges:straight').getAttribute('aria-checked')).toBe('true');
    expect(view.root.querySelector('[data-cmd="view"]')!.classList.contains('changed')).toBe(true);
    const again = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(viewOptionRow(again, 'edges:straight').getAttribute('aria-checked')).toBe('true');
  });

  it('hovering a class keeps it and its relations in focus and fades the rest', () => {
    const { view } = setup();
    const rel = mockClassDiagram.relations[0];
    view.canvas.querySelector(`[data-class-key="${rel.from}"] rect`)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const svg = view.canvas.querySelector('svg')!;
    expect(svg.classList.contains('has-focus')).toBe(true);
    expect(svg.querySelector(`[data-class-key="${rel.from}"]`)!.classList.contains('focused')).toBe(true);
    expect(svg.querySelector(`[data-class-key="${rel.to}"]`)!.classList.contains('focused')).toBe(true);
    expect(svg.querySelector(`[data-relation-id="${rel.id}"]`)!.classList.contains('focused')).toBe(true);
    const unrelated = mockClassDiagram.classes.find((c) => !mockClassDiagram.relations.some((r) => (r.from === rel.from || r.to === rel.from) && (r.from === c.key || r.to === c.key)) && c.key !== rel.from);
    if (unrelated) expect(svg.querySelector(`[data-class-key="${unrelated.key}"]`)!.classList.contains('focused')).toBe(false);
    view.canvas.dispatchEvent(new MouseEvent('mouseleave'));
    expect(svg.classList.contains('has-focus')).toBe(false);
  });
});
