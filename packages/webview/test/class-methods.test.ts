// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mount, testBridge } from './helpers';

const cls = (key: string, n: number, other?: number): ClassNode => ({
  key, name: key, kind: 'class', stereotypes: [], namespace: 'src',
  methods: Array.from({ length: n }, (_, i) => ({ name: `m${i}`, isStatic: false, signature: `m${i}(): void` })),
  otherMethodCount: other,
});

function setup(classes: ClassNode[], maxMethods?: number) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  const diagram: ClassDiagram = { classes, relations: [] };
  bridge.send({ type: 'render', diagram, maxMethods });
  const box = (key: string) => view.canvas.querySelector(`[data-class-key="${key}"]`)!;
  const rows = (key: string) => [...box(key).querySelectorAll('.cls-member')].map((e) => e.getAttribute('data-member'));
  const more = (key: string) => box(key).querySelector('.cls-more');
  return { bridge, view, box, rows, more };
}

describe('FR-12.11 classes list up to N methods, then "… +k more"', () => {
  it('shows the first N in call order and a muted row with the count; hover lists the rest', () => {
    const { rows, more } = setup([cls('Big', 8)], 5);
    expect(rows('Big')).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(more('Big')!.textContent).toContain('… +3 more');
    expect(more('Big')!.querySelector('title')!.textContent).toContain('m5\nm6\nm7');
  });

  it('a single extra method is simply shown (the row would take the same space)', () => {
    const { rows, more } = setup([cls('Six', 6)], 5);
    expect(rows('Six')).toHaveLength(6);
    expect(more('Six')).toBeNull();
  });

  it('clicking expands that class to all methods ("▴ fewer" collapses); remembered per class', () => {
    const { bridge, view, rows, more } = setup([cls('Big', 8), cls('Other', 8)], 5);
    (more('Big') as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(rows('Big')).toHaveLength(8);
    expect(more('Big')!.textContent).toContain('▴ fewer');
    expect(rows('Other')).toHaveLength(5);
    expect(bridge.getState<{ expandedMethods?: string[] }>()!.expandedMethods).toEqual(['Big']);
    const again = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(again.canvas.querySelectorAll('[data-class-key="Big"] .cls-member')).toHaveLength(8);
    void view;
  });

  it('maxMethods 0 = no limit; the setting is configurable', () => {
    expect(setup([cls('Big', 12)], 0).rows('Big')).toHaveLength(12);
    expect(setup([cls('Big', 12)], 2).rows('Big')).toHaveLength(2);
  });

  it('the class tooltip mentions methods that are not part of the interaction', () => {
    const { box } = setup([cls('Svc', 2, 12)], 5);
    expect(box('Svc').querySelector(':scope > title')!.textContent).toContain('12 other methods not used in this interaction');
  });
});
