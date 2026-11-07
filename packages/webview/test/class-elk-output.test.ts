import type { ClassDiagram } from '@seqcall/protocol';
import { describe, expect, it, vi } from 'vitest';
import { layoutClassDiagramElk } from '../src/class/elk';

/** ELK's result types leave every position optional: a fake ELK that answers with what the test sets. */
let reply: (graph: { children: { id: string; width: number; height: number }[] }) => unknown = () => ({ id: 'root' });
vi.mock('elkjs/lib/elk.bundled.js', () => ({ default: class { layout = async (g: never) => reply(g); } }));

const diagram: ClassDiagram = {
  classes: [
    { key: 'A', name: 'Shop', kind: 'class', stereotypes: [], namespace: 'src', methods: [] },
    { key: 'B', name: 'Order', kind: 'class', stereotypes: [], namespace: 'src', methods: [] },
  ],
  relations: [{ id: 'r1', kind: 'association', from: 'A', to: 'B', label: 'orders' }],
};
const finite = (v: unknown) => JSON.stringify(v).match(/null|NaN/) === null;

describe('ELK class layout: results with missing parts (a library change must not blank the view)', () => {
  it('FR-12.5 no positions and no routes at all: every class and relation still gets a finite place', async () => {
    reply = () => ({ id: 'root' });
    const g = await layoutClassDiagramElk(diagram);
    expect(g.nodes.map((n) => n.key)).toEqual(['A', 'B']);
    expect(g.edges[0].points).toHaveLength(2); // a straight line between the boxes
    expect(finite(g)).toBe(true);
    reply = (graph) => ({ ...graph, edges: [{ id: 'r1' }] }); // positions, but a relation without a route
    const h = await layoutClassDiagramElk(diagram);
    expect(h.edges[0].points).toHaveLength(2);
    expect(finite(h)).toBe(true);
  });

  it('FR-12.5 nodes without sizes or coordinates, a route without bend points, a label without coordinates', async () => {
    reply = () => ({
      id: 'root',
      children: [{ id: 'A' }, { id: 'B', x: 0, y: 200, width: 80, height: 40 }],
      edges: [{ id: 'r1', sections: [{ startPoint: { x: 40, y: 30 }, endPoint: { x: 40, y: 200 } }], labels: [{ x: 50 }] }],
    });
    const g = await layoutClassDiagramElk(diagram);
    expect(g.edges[0].points.length).toBe(2);
    expect(g.edges[0].label).toBe('orders');
    expect(g.edges[0].labelPos).toBeUndefined(); // ELK did not place it
    expect(finite(g)).toBe(true);
  });

  it('FR-12.5 a label placed without a size is centred on its corner', async () => {
    reply = (graph) => ({
      ...graph,
      children: graph.children.map((c, i) => ({ ...c, x: 0, y: i * 200 })),
      edges: [{ id: 'r1', sections: [{ startPoint: { x: 40, y: 30 }, bendPoints: [], endPoint: { x: 40, y: 200 } }], labels: [{ x: 50, y: 100 }] }],
    });
    const withSize = await layoutClassDiagramElk(diagram);
    reply = (graph) => ({
      ...graph,
      children: graph.children.map((c, i) => ({ ...c, x: 0, y: i * 200 })),
      edges: [{ id: 'r1', sections: [{ startPoint: { x: 40, y: 30 }, bendPoints: [], endPoint: { x: 40, y: 200 } }], labels: [{ x: 40, y: 90, width: 20, height: 20 }] }],
    });
    const sized = await layoutClassDiagramElk(diagram);
    expect(withSize.edges[0].labelPos).toEqual(sized.edges[0].labelPos); // (50,100) either way
  });
});
