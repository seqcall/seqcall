// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { layoutClassDiagram, relationStyle } from '../src/class/layout';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

describe('class diagram layout (FR-12)', () => {
  const g = layoutClassDiagram(mockClassDiagram, estimateTextWidth);
  const node = (k: string) => g.nodes.find((n) => n.key === k)!;

  it('FR-12.5 positions every class without overlaps', () => {
    expect(g.nodes).toHaveLength(mockClassDiagram.classes.length);
    for (const n of g.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(g.width);
      expect(n.y + n.height).toBeLessThanOrEqual(g.height);
    }
    for (const a of g.nodes) {
      for (const b of g.nodes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `${a.key} overlaps ${b.key}`).toBe(false);
      }
    }
  });

  it('FR-12.3 maps relation kinds to UML notation', () => {
    expect(relationStyle('realization')).toEqual({ dashed: true, marker: 'triangle-hollow' });
    expect(relationStyle('generalization')).toEqual({ dashed: false, marker: 'triangle-hollow' });
    expect(relationStyle('association')).toEqual({ dashed: false, marker: 'arrow-open' });
    expect(relationStyle('dependency')).toEqual({ dashed: true, marker: 'arrow-open' });
    expect(g.edges).toHaveLength(mockClassDiagram.relations.length);
  });

  it('FR-12.3 super types are placed above their subtypes; edges point at the target', () => {
    expect(node('PaymentGateway').y).toBeLessThan(node('StripeGateway').y);
    expect(node('OrderController').y).toBeLessThan(node('OrderService').y);
    const real = g.edges.find((e) => e.id === 'r7')!;
    const end = real.points[real.points.length - 1];
    const gw = node('PaymentGateway');
    expect(Math.abs(end.y - (gw.y + gw.height))).toBeLessThan(2);
  });

  it('FR-12.5 manual positions override the auto layout', () => {
    const moved = layoutClassDiagram(mockClassDiagram, estimateTextWidth, { Order: { x: 2000, y: 900 } });
    const o = moved.nodes.find((n) => n.key === 'Order')!;
    expect(o.x + o.width / 2).toBe(2000);
    expect(o.y + o.height / 2).toBe(900);
  });
});

describe('class diagram view', () => {
  function setup() {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    return { bridge, view };
  }

  it('FR-12.2 renders class boxes with stereotypes, names and methods (static underlined)', () => {
    const { view } = setup();
    const price = view.canvas.querySelector('[data-class-key="PriceCalculator"]')!;
    expect(price.textContent).toContain('«static»');
    expect(price.querySelector('.cls-name')!.textContent).toBe('PriceCalculator');
    expect(price.querySelector('.cls-member.static')!.getAttribute('text-decoration')).toBe('underline');
    expect(view.canvas.querySelector('[data-class-key="PaymentGateway"] .cls-name.abstract')).not.toBeNull();
  });

  it('FR-12.17 an object clicked in the sequence diagram: its class is outlined (also across re-renders) until a click here', () => {
    const { bridge, view } = setup();
    const focused = () => [...view.canvas.querySelectorAll('.class-focused')].map((e) => e.getAttribute('data-class-key'));
    bridge.send({ type: 'focusClass', classKey: 'PriceCalculator' });
    expect(focused()).toEqual(['PriceCalculator']);
    bridge.send({ type: 'render', diagram: structuredClone(mockClassDiagram) }); // e.g. after an expand
    expect(focused()).toEqual(['PriceCalculator']);
    view.canvas.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(focused()).toEqual([]);
    // a class not in the diagram: nothing outlined
    bridge.send({ type: 'focusClass', classKey: 'Nope' });
    expect(focused()).toEqual([]);
  });

  it('FR-12.17 a focus that arrives before the (asynchronous) drawing applies once the class is drawn', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'focusClass', classKey: 'PriceCalculator' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    expect(view.canvas.querySelector('.class-focused')?.getAttribute('data-class-key')).toBe('PriceCalculator');
  });

  it('FR-12.3 relations carry the right markers and dash style', () => {
    const { view } = setup();
    const rel = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"]`)!;
    expect(rel('r7').getAttribute('data-marker')).toBe('triangle-hollow');
    expect(rel('r7').querySelector('.rel-line.dashed')).not.toBeNull();
    expect(rel('r8').querySelector('.rel-line.dashed')).toBeNull();
    expect(rel('r1').getAttribute('data-marker')).toBe('arrow-open');
    expect(rel('r1').textContent).toContain('orders');
    expect(rel('r4').querySelector('.rel-line.dashed')).not.toBeNull();
    expect(rel('r4').textContent).toContain('«create»');
  });

  it('FR-12.5 clicking a class navigates to its declaration', () => {
    const { view, bridge } = setup();
    fire(view.canvas.querySelector('[data-class-key="Order"] rect')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: mockClassDiagram.classes.find((c) => c.key === 'Order')!.declaration });
  });

  it('FR-12.5 dragged positions persist across re-renders for classes that remain', () => {
    const { view, bridge } = setup();
    const before = view.geometry!.nodes.find((n) => n.key === 'Order')!;
    fire(view.canvas.querySelector('[data-class-key="Order"] rect')!, 'mousedown', { clientX: 10, clientY: 10 });
    fire(document.body, 'mousemove', { clientX: 70, clientY: 50 });
    fire(document.body, 'mouseup');
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
    bridge.send({ type: 'render', diagram: { ...mockClassDiagram, classes: mockClassDiagram.classes.filter((c) => c.key !== 'BaseGateway') } });
    const after = view.geometry!.nodes.find((n) => n.key === 'Order')!;
    expect(after.x - before.x).toBeCloseTo(60, 0);
    expect(after.y - before.y).toBeCloseTo(40, 0);
  });

  it('shows a placeholder when empty', () => {
    const { view, bridge } = setup();
    bridge.send({ type: 'empty', reason: 'No sequence diagram' });
    expect(view.placeholder.hidden).toBe(false);
    expect(view.placeholder.textContent).toContain('No sequence diagram');
    expect(view.canvas.querySelector('svg')).toBeNull();
  });
});
