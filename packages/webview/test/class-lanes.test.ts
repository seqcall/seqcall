// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { edgeScore, layoutClassDiagram } from '../src/class/layout';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mount, testBridge, fire, viewOptionRow, withViolations } from './helpers';
import { cloneSequence } from '../dev/mock-data';

const cls = (key: string, layer?: string): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], layer, namespace: 'src', methods: [{ name: 'run', isStatic: false, signature: 'run(): void' }] });

/** Controller (Presentation) creates a Dto (Domain) straight through a Service (Application) in between. */
const diagram: ClassDiagram = {
  classes: [cls('Controller', 'Presentation'), cls('Service', 'Application'), cls('Dto', 'Domain'), cls('Db', 'Infrastructure'), cls('main')],
  relations: [
    { id: 'r1', kind: 'association', from: 'Controller', to: 'Service', label: 'service' },
    { id: 'r2', kind: 'dependency', from: 'Controller', to: 'Dto', label: '«create»' },
    { id: 'r3', kind: 'dependency', from: 'Dto', to: 'Db', violation: 'Domain → Infrastructure: an inner layer depends on an outer layer' },
    { id: 'r4', kind: 'dependency', from: 'main', to: 'Controller' },
  ],
  layers: ['Presentation', 'Application', 'Domain', 'Infrastructure'],
};

describe('class diagram grouped by layer (lanes)', () => {
  const g = layoutClassDiagram(diagram, estimateTextWidth, {}, { lanes: true });

  it('FR-12.7 one lane per layer in architectural order; classes without a layer last', () => {
    expect(g.lanes!.map((l) => l.label)).toEqual(['Presentation', 'Application', 'Domain', 'Infrastructure', 'No layer']);
    for (let i = 1; i < g.lanes!.length; i++) expect(g.lanes![i].y).toBeGreaterThanOrEqual(g.lanes![i - 1].y + g.lanes![i - 1].height);
  });

  it('every class sits inside its lane', () => {
    for (const n of g.nodes) {
      const lane = g.lanes!.find((l) => (l.layer ?? undefined) === n.node.layer)!;
      expect(n.y).toBeGreaterThan(lane.y);
      expect(n.y + n.height).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it('cross-lane edges never cut through other classes (blocked ones are routed around)', () => {
    expect(edgeScore(g)).toBeLessThan(10_000);
    expect(g.edges.find((e) => e.id === 'r2')!.points.length).toBeGreaterThan(2);
  });

  it('violations are carried to the edge geometry', () => {
    expect(g.edges.find((e) => e.id === 'r3')!.violation).toContain('Domain → Infrastructure');
  });
});

describe('class view: the marks of both diagrams', () => {
  it('FR-14.2 the class View ▾ has the same Marks section as the sequence view: same labels, state from the session, setOption', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram, options: { ...cloneSequence().options, showFindings: false } });
    fire(view.root.querySelector('[data-cmd="view"]')!, 'click');
    const ids = [...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'));
    expect(ids).toEqual(expect.arrayContaining(['view:marks-head', 'view:showFindings', 'view:showReviewMarks']));
    const findings = viewOptionRow(view, 'showFindings');
    expect(findings.getAttribute('aria-checked')).toBe('false');
    expect(findings.getAttribute('title')).toMatch(/I\/O in loops/);
    fire(findings, 'click');
    expect(bridge.posted.at(-1)).toEqual({ type: 'setOption', option: 'showFindings', value: true });
  });
});

describe('class view: Layers toggle and violations', () => {
  it('FR-12.7 Layers is the default; toggling persists the choice and violations are counted under ⚠ N (FR-19.17)', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: withViolations(diagram) });
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(5);
    expect(viewOptionRow(view, 'lanes').getAttribute('aria-checked')).toBe('true');
    expect(view.canvas.querySelectorAll('.relation.violation')).toHaveLength(1);
    expect(view.root.querySelector('[data-cmd="findings"] .tb-badge')!.textContent).toBe('1');
    expect(view.root.querySelector('[data-cmd="findings"]')!.getAttribute('title')).toBe('1 layer violation in the shown calls — click for the list');
    // Uses on draws more red relations; ⚠ N keeps its count and names them apart
    bridge.send({ type: 'render', diagram: { ...withViolations(diagram), typeUses: true, typeUseViolations: 2 } });
    expect(view.root.querySelector('[data-cmd="findings"] .tb-badge')!.textContent).toBe('1');
    expect(view.root.querySelector('[data-cmd="findings"]')!.getAttribute('title')).toBe('1 layer violation in the shown calls — click for the list\n+ 2 only through type uses (dotted red, not counted)');
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    expect(view.root.querySelector('.popup-layer [data-menu-id="type-use-violations"]')!.textContent).toContain('+ 2 only through type uses');
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    bridge.send({ type: 'render', diagram: withViolations(diagram) });

    fire(viewOptionRow(view, 'lanes'), 'click');
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(0);
    expect(bridge.getState<{ lanes?: boolean; lanesChosen?: boolean }>()).toMatchObject({ lanes: false, lanesChosen: true });

    const again = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(again.canvas.querySelectorAll('.class-lane')).toHaveLength(0); // the choice is kept
  });

  it('FR-12.7 a panel saved before Layers became the default opens with Layers', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    bridge.setState({ diagram, lanes: false }); // older state: no lanesChosen
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(5);
  });
});

describe('dragging classes keeps them under the pointer (regression: lanes view ran away to the right)', () => {
  it('a manual position equal to the current place is a fixed point, in both layouts', () => {
    for (const lanes of [true, false]) {
      const g1 = layoutClassDiagram(diagram, estimateTextWidth, {}, { lanes });
      const n = g1.nodes.find((x) => x.key === 'Service')!;
      const manual = { Service: { x: n.x + n.width / 2, y: n.y + n.height / 2 } };
      const g2 = layoutClassDiagram(diagram, estimateTextWidth, manual, { lanes });
      const g3 = layoutClassDiagram(diagram, estimateTextWidth, manual, { lanes });
      for (const g of [g2, g3]) {
        const m = g.nodes.find((x) => x.key === 'Service')!;
        expect([m.x, m.y]).toEqual([n.x, n.y]);
        // the other classes don't move either
        for (const o of g1.nodes) expect(g.nodes.find((x) => x.key === o.key)!.x).toBeCloseTo(o.x, 6);
      }
    }
  });

  it('in the Layers view a class follows the mouse 1:1 while dragging', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram });
    viewOptionRow(view, 'lanes').click();
    const box = () => view.canvas.querySelector('[data-class-key="Service"]')!;
    const xOf = () => Number(/translate\(([-\d.]+)/.exec(box().getAttribute('transform')!)![1]);
    const start = xOf();
    const fire = (type: string, x: number) => (type === 'mousedown' ? box().querySelector('rect')! : window).dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 50 }));
    fire('mousedown', 100);
    for (let x = 120; x <= 200; x += 20) fire('mousemove', x);
    fire('mouseup', 200);
    expect(xOf() - start).toBeCloseTo(100, 0);
  });
});
