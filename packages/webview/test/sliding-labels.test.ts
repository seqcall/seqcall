// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { labelShift } from '../src/sequence/sliding-labels';
import type { MessageGeom } from '../src/sequence/layout';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

// a long arrow from x 2400 (sender) to 100, the label next to the sender
const long = { x1: 2400, x2: 100, labelX: 2250, labelY: 300, label: { width: 120 }, kind: 'call' } as unknown as MessageGeom;
const view = (left: number, right: number) => ({ left, right, top: 0, bottom: 1000 });

describe('FR-10.4 sliding labels', () => {
  it('a label in view stays; scrolled away along its arrow, it slides to just inside the view', () => {
    expect(labelShift(long, view(2000, 2600))).toBe(0); // its place is in view
    const dx = labelShift(long, view(500, 1100)); // the middle of the arrow
    const left = long.labelX - 3 + dx;
    expect(left).toBeGreaterThanOrEqual(500);
    expect(left + long.label.width + 6).toBeLessThanOrEqual(1100);
    expect(left + long.label.width + 6).toBe(1100 - 6); // moved as little as possible: at the right edge
    // near the arrowhead end: it stops before the head
    const atHead = labelShift(long, view(0, 400));
    expect(long.labelX - 3 + atHead).toBeGreaterThanOrEqual(100 + 6);
  });

  it('never moves: the arrow out of view, self calls, the found message, rows out of view; with too little arrow in view it stays on its end', () => {
    expect(labelShift(long, view(2600, 3000))).toBe(0);
    // only 40 of the arrow visible: the label stays at that end of the arrow, partly visible (does not vanish)
    const end = labelShift(long, view(-500, 140));
    expect(long.labelX - 3 + end).toBe(100 + 6);
    expect(labelShift({ ...long, loopX: 2450 } as MessageGeom, view(500, 1100))).toBe(0);
    expect(labelShift({ ...long, kind: 'found' } as MessageGeom, view(500, 1100))).toBe(0);
    expect(labelShift(long, { left: 500, right: 1100, top: 400, bottom: 900 })).toBe(0);
  });

  it('in the view: scrolled sideways, the labels of long arrows are moved (all their pieces), back in place they are not', async () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const v = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const s = v.root.querySelector('.seq-scroll') as HTMLElement;
    Object.defineProperty(s, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(s, 'clientHeight', { configurable: true, value: 3000 });
    const d = cloneSequence();
    // spread the participants so that calls from OrderService to the repositories are long
    bridge.send({ type: 'render', diagram: d, positions: { 'p-ctrl': 100, 'p-svc': 300, 'p-repo1': 2500, 'p-repo2': 2700 } });
    const label = (id: string) => [...v.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!.querySelector(':scope > .msg-label')!;
    const id = 'root/1:placeOrder/0:findById';
    expect(label(id).querySelector('.seg-name')!.textContent).toBe('findById');
    expect(label(id).hasAttribute('transform')).toBe(false);
    const frame = () => new Promise((r) => setTimeout(r, 50));
    s.scrollLeft = 1300; // the middle of the arrow
    s.dispatchEvent(new Event('scroll'));
    await frame();
    expect(label(id).getAttribute('transform')).toMatch(/^translate\(\d+ 0\)$/);
    s.scrollLeft = 0;
    s.dispatchEvent(new Event('scroll'));
    await frame();
    expect(label(id).hasAttribute('transform')).toBe(false);
  });
});
