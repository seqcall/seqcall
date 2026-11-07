// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mount, testBridge } from './helpers';

describe('FR-12.15 aggregation in the class view', () => {
  it('a collection field is drawn with a hollow diamond at the owner and * at the element; a single object is not', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    const diagram: ClassDiagram = {
      classes: [node('Order'), node('Line'), node('Customer')],
      relations: [
        { id: 'a1', kind: 'association', from: 'Order', to: 'Line', label: 'lines', aggregation: true, multiplicity: '*' },
        { id: 'a2', kind: 'association', from: 'Order', to: 'Customer', label: 'customer' },
      ],
    };
    bridge.send({ type: 'render', diagram });
    const rel = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"]`)!;
    expect(rel('a1').querySelector('.rel-line')!.getAttribute('marker-start')).toBe('url(#seqcall-cls-diamond)');
    expect(rel('a1').querySelector('.rel-mult')!.textContent).toBe('*');
    expect(rel('a1').querySelector('title')!.textContent).toContain('aggregation — the field holds a collection (*)');
    expect(rel('a2').querySelector('.rel-line')!.hasAttribute('marker-start')).toBe(false);
    expect(rel('a2').querySelector('.rel-mult')).toBeNull();
    expect(view.canvas.querySelector('marker#seqcall-cls-diamond')).not.toBeNull();
  });
});
