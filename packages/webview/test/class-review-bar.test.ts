// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { changedClasses } from '../src/class/review-steps';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// the class view during a review: the changed classes, stepped through

function opened(d: ClassDiagram) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram: d });
  return view;
}
const reviewed = (): ClassDiagram => {
  const d = structuredClone(mockClassDiagram);
  d.classes[1] = { ...d.classes[1], change: { kind: 'changed', members: [{ kind: 'method', name: 'a', change: 'changed', text: 'a()' }, { kind: 'field', name: 'f', change: 'added', text: 'f: X' }] } };
  d.classes[2] = { ...d.classes[2], change: { kind: 'new', members: [] } };
  return d;
};
const key = (k: string, init: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

describe('the class view\'s review bar', () => {
  it('reading order: top to bottom, then left to right on one row', () => {
    const node = (key: string, x: number, y: number) => ({ key, x, y, node: { change: { kind: 'new', members: [] } } }) as never;
    expect(changedClasses([node('c', 50, 10), node('b', 90, 0), node('a', 10, 10), { key: 'x', x: 0, y: 0, node: {} } as never]).map((n: { key: string }) => n.key)).toEqual(['b', 'a', 'c']);
  });

  it('no changed class: no bar; changed ones: how many, ▶ / N step through them in reading order (round the end), each outlined', () => {
    expect(opened(structuredClone(mockClassDiagram)).reviewBarEl.hidden).toBe(true);
    const view = opened(reviewed());
    const bar = () => view.reviewBarEl;
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector('.rb-title')!.textContent).toBe('⎇ 2 classes changed on this branch (1 new)');
    expect(bar().querySelector('.rb-change')!.textContent).toBe('Class –/2 ▶ for the first');
    const order = [...view.geometry!.nodes].filter((n) => n.node.change).sort((a, b) => a.y - b.y || a.x - b.x);
    const outlined = () => [...view.canvas.querySelectorAll('.class-node.finding-hl')].map((e) => e.getAttribute('data-class-key'));
    const [next, prev] = [() => fire(bar().querySelectorAll('.rb-btn')[1], 'click'), () => fire(bar().querySelectorAll('.rb-btn')[0], 'click')];
    next();
    expect(outlined()).toEqual([order[0].key]);
    const text = (n: (typeof order)[number]) => (n.node.change!.kind === 'new' ? 'new' : 'Δ2 members');
    expect(bar().querySelector('.rb-change')!.textContent).toBe(`Class 1/2 ${order[0].node.name} — ${text(order[0])}`);
    key('n');
    expect(outlined()).toEqual([order[1].key]);
    key('n'); // round the end
    expect(outlined()).toEqual([order[0].key]);
    key('p');
    expect(outlined()).toEqual([order[1].key]);
    prev();
    expect(outlined()).toEqual([order[0].key]);
  });

  it('P first goes to the last; keys with a modifier, in a field, or without a review do nothing; a single new class reads in the singular', () => {
    const view = opened(reviewed());
    const outlined = () => [...view.canvas.querySelectorAll('.class-node.finding-hl')].map((e) => e.getAttribute('data-class-key'));
    key('n', { ctrlKey: true });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    key('x');
    expect(outlined()).toEqual([]);
    key('p');
    expect(outlined()).toHaveLength(1);
    const one = structuredClone(mockClassDiagram);
    one.classes[0] = { ...one.classes[0], change: { kind: 'changed', members: [] } };
    expect(opened(one).reviewBarEl.querySelector('.rb-title')!.textContent).toBe('⎇ 1 class changed on this branch');
  });
});
