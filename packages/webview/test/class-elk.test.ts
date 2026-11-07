// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { layoutClassDiagramElk } from '../src/class/elk';
import { edgeScore } from '../src/class/layout';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge, fire, viewOptionRow } from './helpers';

const cls = (key: string, layer?: string): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], layer, namespace: 'src', methods: [{ name: 'run', isStatic: false, signature: 'run(): void' }] });
const diagram: ClassDiagram = {
  classes: [cls('Controller', 'Presentation'), cls('Service', 'Application'), cls('Repo', 'Ports'), cls('Dto', 'Domain'), cls('Sql', 'Infrastructure'), cls('main')],
  relations: [
    { id: 'r1', kind: 'association', from: 'Controller', to: 'Service', label: 'service' },
    { id: 'r2', kind: 'dependency', from: 'Controller', to: 'Dto', label: '«create»' },
    { id: 'r3', kind: 'association', from: 'Service', to: 'Repo', label: 'primary' },
    { id: 'r4', kind: 'association', from: 'Service', to: 'Repo', label: 'replica' },
    { id: 'r5', kind: 'realization', from: 'Sql', to: 'Repo' },
    { id: 'r6', kind: 'dependency', from: 'main', to: 'Controller' },
  ],
  layers: ['Presentation', 'Application', 'Ports', 'Domain', 'Infrastructure'],
};

describe('ELK class layout', () => {
  it('lanes: partitions in architectural order, every class inside its lane, no edge through a class', async () => {
    const g = await layoutClassDiagramElk(diagram, estimateTextWidth, {}, { lanes: true, routing: 'ORTHOGONAL' });
    expect(g.lanes!.map((l) => l.label)).toEqual(['Presentation', 'Application', 'Ports', 'Domain', 'Infrastructure', 'No layer']);
    for (let i = 1; i < g.lanes!.length; i++) expect(g.lanes![i].y).toBeGreaterThanOrEqual(g.lanes![i - 1].y + g.lanes![i - 1].height);
    for (const n of g.nodes) {
      const lane = g.lanes!.find((l) => (l.layer ?? undefined) === n.node.layer)!;
      expect(n.y).toBeGreaterThan(lane.y);
      expect(n.y + n.height).toBeLessThanOrEqual(lane.y + lane.height);
    }
    expect(edgeScore(g)).toBeLessThan(10_000);
  });

  it('FR-12.7 lanes never overlap when a lane needs several rows (two classes calling each other): the next lane comes after all of them', async () => {
    const tall = { ...cls('Routes', 'Presentation'), methods: Array.from({ length: 6 }, (_, i) => ({ name: `route${i}`, isStatic: false, signature: `route${i}()` })) };
    const dep = (from: string, to: string) => ({ id: `${from}>${to}`, kind: 'dependency' as const, from, to });
    const d: ClassDiagram = {
      classes: [tall, cls('Server', 'Presentation'), cls('Jobs', 'Infrastructure'), cls('Utils', 'Infrastructure'), cls('Config', 'Infrastructure'), cls('Schemas')],
      relations: [dep('Routes', 'Schemas'), dep('Jobs', 'Utils'), dep('Jobs', 'Config'), dep('Utils', 'Jobs'), dep('Server', 'Utils')],
      layers: ['Presentation', 'Infrastructure'],
    };
    const g = await layoutClassDiagramElk(d, estimateTextWidth, {}, { lanes: true, routing: 'ORTHOGONAL' });
    expect(g.lanes!.map((l) => l.label)).toEqual(['Presentation', 'Infrastructure', 'No layer']);
    for (let i = 1; i < g.lanes!.length; i++) expect(g.lanes![i].y).toBeGreaterThanOrEqual(g.lanes![i - 1].y + g.lanes![i - 1].height);
    for (const n of g.nodes) {
      const lane = g.lanes!.find((l) => (l.layer ?? undefined) === n.node.layer)!;
      expect(n.y).toBeGreaterThan(lane.y);
      expect(n.y + n.height).toBeLessThanOrEqual(lane.y + lane.height);
    }
    // the hidden edges that order the lanes are not drawn
    expect(g.edges.map((e) => e.id).sort()).toEqual(d.relations.map((r) => r.id).sort());
  });

  it('parallel relations get separate routes', async () => {
    const g = await layoutClassDiagramElk(diagram, estimateTextWidth, {}, { routing: 'ORTHOGONAL' });
    const [a, b] = ['r3', 'r4'].map((id) => g.edges.find((e) => e.id === id)!);
    expect(JSON.stringify(a.points)).not.toEqual(JSON.stringify(b.points));
  });

  it('curved style uses ELK splines (Bézier control points), right-angled uses orthogonal routes', async () => {
    const curved = await layoutClassDiagramElk(diagram, estimateTextWidth, {}, { routing: 'SPLINES' });
    expect(curved.edges.some((e) => e.bezier)).toBe(true);
    const ortho = await layoutClassDiagramElk(diagram, estimateTextWidth, {}, { routing: 'ORTHOGONAL' });
    expect(ortho.edges.every((e) => !e.bezier)).toBe(true);
    for (const e of ortho.edges)
      for (let i = 1; i < e.points.length; i++) {
        const [p, q] = [e.points[i - 1], e.points[i]];
        expect(Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5).toBe(true);
      }
  });
});

describe('class view with the default (ELK) engine', () => {
  it('renders asynchronously, re-routes on edge-style change, and keeps dragged classes put', async () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    await view.settled();
    expect(view.canvas.querySelectorAll('.class-node')).toHaveLength(mockClassDiagram.classes.length);
    expect(view.canvas.querySelector('.rel-line')!.getAttribute('d')).toContain('C'); // splines

    fire(viewOptionRow(view, 'edges:orthogonal'), 'click');
    await view.settled();
    expect([...view.canvas.querySelectorAll('.rel-line')].every((p) => !/C/.test(p.getAttribute('d')!))).toBe(true);
    expect(bridge.posted.filter((m) => m.type === 'log' && m.level === 'error')).toEqual([]);
  });
});
