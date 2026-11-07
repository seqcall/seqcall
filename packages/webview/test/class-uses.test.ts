// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView, SourceRange } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { layoutClassDiagram } from '../src/class/layout';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge, viewOptionRow, withViolations } from './helpers';

const at = (line: number): SourceRange => ({ file: '/p/src/a.cs', start: { line, character: 4 }, end: { line, character: 20 } });
const cls = (key: string, layer: string, over: Partial<ClassNode> = {}): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], layer, namespace: 'src', methods: [], declaration: at(1), ...over });

/** Service → Rule (call); Rule ⇢ Enums (use, violation, two methods); Service ⇢ Order (use, used-only class). */
const withUses: ClassDiagram = {
  classes: [cls('Service', 'Application'), cls('Rule', 'Domain'), cls('Enums', 'Application'), cls('Order', 'Domain', { usedOnly: true })],
  relations: [
    { id: 'dep', kind: 'dependency', from: 'Service', to: 'Rule', calls: [{ messageId: 'root/0:Check', label: 'Run → Check', callSite: at(10) }] },
    {
      id: 'use:Rule->Enums',
      kind: 'use',
      from: 'Rule',
      to: 'Enums',
      violation: 'Domain → Application: an inner layer depends on an outer layer',
      uses: [
        { method: 'Rule.Check', range: at(20), messageId: 'root/0:Check' },
        { method: 'Rule.Other', range: at(30), messageId: 'root/0:Check/1:Other' },
      ],
    },
    { id: 'use:Service->Order', kind: 'use', from: 'Service', to: 'Order', uses: [{ method: 'Service.Run', range: at(5), messageId: 'root' }] },
  ],
  layers: ['Application', 'Domain'],
  typeUses: true,
};
const withoutUses: ClassDiagram = { ...withUses, classes: withUses.classes.slice(0, 3), relations: withUses.relations.slice(0, 1), typeUses: undefined };

function setup(diagram: ClassDiagram) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
  const click = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"] .rel-hit`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
  return { bridge, view, click };
}

describe('FR-12.12 class view: Uses toggle and use relations', () => {
  it('FR-12.12 View ▾ "Uses" reflects the session option and posts setTypeUses; the menu stays open', () => {
    const { bridge, view } = setup(withoutUses);
    expect(viewOptionRow(view, 'uses').getAttribute('aria-checked')).toBe('false');
    expect(viewOptionRow(view, 'uses').textContent).toMatch(/types referenced/);
    fire(viewOptionRow(view, 'uses'), 'click');
    expect(bridge.posted).toEqual([{ type: 'setTypeUses', value: true }]);
    bridge.send({ type: 'render', diagram: withUses });
    expect(viewOptionRow(view, 'uses').getAttribute('aria-checked')).toBe('true');
    expect(view.root.querySelector('[data-cmd="view"]')!.classList.contains('changed')).toBe(true);
    fire(viewOptionRow(view, 'uses'), 'click');
    expect(bridge.posted.at(-1)).toEqual({ type: 'setTypeUses', value: false });
  });

  it('FR-12.12 use edges are drawn dotted with an open arrow, without a label; violations red; used-only classes marked', () => {
    const { view } = setup(withViolations(withUses));
    const use = view.canvas.querySelector('[data-relation-id="use:Rule->Enums"]')!;
    expect(use.classList.contains('rel-use')).toBe(true);
    expect(use.classList.contains('violation')).toBe(true);
    expect(use.getAttribute('data-marker')).toBe('arrow-open');
    expect(use.querySelector('.rel-label')).toBeNull();
    expect(use.querySelector('title')!.textContent).toBe('Rule uses the type Enums, no call (in a signature or a local) — «use»\nRule.Check (a.cs:21)\nRule.Other (a.cs:31)\n⚠ Domain → Application: an inner layer depends on an outer layer');
    expect(view.canvas.querySelector('[data-class-key="Order"]')!.classList.contains('used-only')).toBe(true);
    expect(view.canvas.querySelector('[data-class-key="Order"] title')!.textContent).toContain('only referenced by the shown methods');
    expect(view.root.querySelector('[data-cmd="findings"] .tb-badge')!.textContent).toBe('1');
  });

  it('FR-12.12 without uses: no use edges, no used-only classes', () => {
    const { view } = setup(withoutUses);
    expect(view.canvas.querySelectorAll('.rel-use')).toHaveLength(0);
    expect(view.canvas.querySelector('[data-class-key="Order"]')).toBeNull();
  });

  it('FR-12.12 clicking a use relation: one method → highlight + jump; several → pick one', () => {
    const { bridge, view, click } = setup(withUses);
    click('use:Service->Order');
    expect(bridge.posted).toEqual([
      { type: 'highlightMessages', messageIds: ['root'] },
      { type: 'navigate', range: at(5) },
    ]);
    bridge.posted.length = 0;
    // a use relation that breaks the dependency rule: its methods highlighted, and the layer-violation card (FR-12.16)
    click('use:Rule->Enums');
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:Check', 'root/0:Check/1:Other'] }]);
    expect(view.root.querySelector('.popup-layer .guide-card .gc-title')!.textContent).toContain('Layer violation: Rule');
  });

  it('FR-12.12 hover focus includes use relations', () => {
    const { view } = setup(withUses);
    view.canvas.querySelector('[data-class-key="Enums"] .cls-box')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(view.canvas.querySelector('[data-relation-id="use:Rule->Enums"]')!.classList.contains('focused')).toBe(true);
    expect(view.canvas.querySelector('[data-class-key="Rule"]')!.classList.contains('focused')).toBe(true);
    expect(view.canvas.querySelector('[data-class-key="Order"]')!.classList.contains('focused')).toBe(false);
  });

  it('FR-12.12 lanes layout (dagre) keeps used-only classes in their layer lane', () => {
    const g = layoutClassDiagram(withUses, estimateTextWidth, {}, { lanes: true });
    const lane = g.lanes!.find((l) => l.layer === 'Domain')!;
    const order = g.nodes.find((n) => n.key === 'Order')!;
    expect(order.y).toBeGreaterThanOrEqual(lane.y);
    expect(order.y + order.height).toBeLessThanOrEqual(lane.y + lane.height);
    expect(g.edges.find((e) => e.id === 'use:Service->Order')!.points.length).toBeGreaterThanOrEqual(2);
  });

  it('FR-12.12 ELK lays out use relations (lanes on by default)', async () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: withUses });
    await view.settled();
    expect(view.canvas.querySelectorAll('.rel-use')).toHaveLength(2);
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(2);
    expect(bridge.posted.some((m) => m.type === 'log' && m.message.includes('3 relations (elk)'))).toBe(true);
  });
});
