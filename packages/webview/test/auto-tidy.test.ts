// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// Collapse all is in the Expand ▾ menu
const collapseAll = (v: { root: HTMLElement; toolbar: { button(c: 'expandMenu'): HTMLButtonElement } }) => {
  fire(v.toolbar.button('expandMenu'), 'click');
  fire(v.root.querySelector('.popup-layer [data-menu-id="collapse-all"]')!, 'click');
};

describe('FR-10.3 tidy up after every expand / collapse', () => {
  const setup = (autoTidy?: boolean) => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    if (autoTidy !== undefined) d.options = { ...d.options, autoTidy };
    // participants spread far apart by an earlier drag
    const spread = Object.fromEntries(d.participants.map((p, i) => [p.id, 200 + i * 400]));
    bridge.send({ type: 'render', diagram: d, positions: spread });
    bridge.posted.length = 0;
    return { bridge, view, d, spread };
  };
  const saved = (posted: SequenceViewToHost[]) => posted.find((m) => m.type === 'savePositions') as Extract<SequenceViewToHost, { type: 'savePositions' }> | undefined;

  it('FR-10.3 the diagram of an expand comes back tidied (order kept, packed together) and the positions are saved', () => {
    const { bridge, view, d, spread } = setup();
    const collapsed = d.messages.find((m) => m.expandable && !m.expanded)!;
    fire([...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === collapsed.id)!.querySelector('.expand-glyph')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: collapsed.id });
    bridge.send({ type: 'render', diagram: d, positions: spread });
    const s = saved(bridge.posted)!;
    expect(s).toBeDefined();
    const xs = d.participants.map((p) => s.positions[p.id]);
    const before = d.participants.map((p) => spread[p.id]);
    expect(xs[xs.length - 1]).toBeLessThan(before[before.length - 1]); // packed
    const order = (v: number[]) => d.participants.map((p, i) => [p.id, v[i]] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
    expect(order(xs)).toEqual(order(before)); // the order stays
  });

  it('FR-10.3 a dropped object is packed again at once: its new order stays, the gaps go', () => {
    const { bridge, view, d, spread } = setup();
    const ids = d.participants.map((p) => p.id);
    // two objects of the same band (a band keeps its members together): drag the first to just right of the second
    const [first, second] = ['p-svc', 'p-price'];
    const head = view.header.querySelector(`[data-participant-id="${first}"] rect`)!;
    fire(head, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 100 + (spread[second] - spread[first]) + 50 });
    fire(document.body, 'mouseup');
    const s = saved(bridge.posted)!;
    expect(s).toBeDefined();
    const order = [...ids].sort((a, b) => s.positions[a] - s.positions[b]);
    expect(order.slice(0, 3)).toEqual(['p-ctrl', second, first]); // the new order is kept
    // packed: closer together than the 400 px spread
    expect(s.positions[first] - s.positions[second]).toBeLessThan(400);
    expect(s.positions[second] - s.positions['p-ctrl']).toBeLessThan(400);
    // with Tidy up after expanding off, the object stays where it was dropped
    const off = setup(false);
    fire(off.view.header.querySelector(`[data-participant-id="${first}"] rect`)!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 180 });
    fire(document.body, 'mouseup');
    expect(saved(off.bridge.posted)!.positions[first]).toBe(off.spread[first] + 80);
  });

  it('FR-10.3 also after Collapse all and Smart; not after a render that is no expand (the I/O scan, a refresh), not when switched off', () => {
    const { bridge, view, d, spread } = setup();
    bridge.send({ type: 'render', diagram: d, positions: spread }); // e.g. background I/O badges
    expect(saved(bridge.posted)).toBeUndefined();
    collapseAll(view);
    bridge.send({ type: 'render', diagram: d, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
    bridge.posted.length = 0;
    fire(view.toolbar.button('smartExpand'), 'click');
    bridge.send({ type: 'render', diagram: d, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
    const off = setup(false);
    collapseAll(off.view);
    off.bridge.send({ type: 'render', diagram: off.d, positions: off.spread });
    expect(saved(off.bridge.posted)).toBeUndefined();
  });

  it('FR-10.3 also after hiding / unhiding (from this view or the class diagram: the rules in the diagram changed)', () => {
    const { bridge, d, spread } = setup();
    const hidden = { ...d, hiddenFilters: [{ filter: { id: 'name:info', kind: 'methodName' as const, methodName: 'info' }, hiddenCount: 1 }] };
    bridge.send({ type: 'render', diagram: hidden, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
    bridge.posted.length = 0;
    bridge.send({ type: 'render', diagram: hidden, positions: spread }); // same rules: no tidy
    expect(saved(bridge.posted)).toBeUndefined();
    bridge.send({ type: 'render', diagram: d, positions: spread }); // unhidden
    expect(saved(bridge.posted)).toBeDefined();
  });

  it('FR-10.3 whenever the objects at the top change, whatever caused it (a review revealing a change, the class diagram, Back)', () => {
    const { bridge, d, spread } = setup();
    // the host expanded on its own (no expand intent from this view): one object less, then the old line-up again
    const fewer = { ...d, participants: d.participants.slice(0, -1), messages: d.messages.filter((m) => m.to !== d.participants.at(-1)!.id && m.from !== d.participants.at(-1)!.id) };
    bridge.send({ type: 'render', diagram: fewer, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
    bridge.posted.length = 0;
    bridge.send({ type: 'render', diagram: d, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
    bridge.posted.length = 0;
    // reordered objects are another line-up too
    bridge.send({ type: 'render', diagram: { ...d, participants: [...d.participants].reverse() }, positions: spread });
    expect(saved(bridge.posted)).toBeDefined();
  });

  it('FR-10.3 another root: its saved arrangement is kept when it places every object, tidied when objects are new', () => {
    const { bridge, d, spread } = setup();
    const other = { ...d, root: { ...d.root, key: `${d.root.key}#other` } };
    bridge.send({ type: 'render', diagram: other, positions: spread });
    expect(saved(bridge.posted)).toBeUndefined();
    const partial = { ...spread };
    delete partial[d.participants.at(-1)!.id];
    bridge.send({ type: 'render', diagram: { ...other, root: { ...d.root, key: `${d.root.key}#third` } }, positions: partial });
    expect(saved(bridge.posted)).toBeDefined();
  });

  it('FR-10.5 the clicked ⊕ stays under the mouse: the view scrolls by as much as the tidy moved it', () => {
    const { bridge, view, d, spread } = setup();
    const scroll = view.root.querySelector('.seq-scroll') as HTMLElement;
    const collapsed = d.messages.find((m) => m.expandable && !m.expanded)!;
    // jsdom has no layout: the glyph is at x 500 on screen before; after the expand + tidy its message is drawn
    // 200 further right (minus whatever the view is scrolled)
    let moved = 0;
    const proto = SVGElement.prototype as unknown as { getBoundingClientRect(): DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: Element) {
      const inside = this.closest('[data-msg-id]')?.getAttribute('data-msg-id') === collapsed.id && this.classList.contains('expand-glyph');
      return inside ? new DOMRect(500 + moved - scroll.scrollLeft, 300 - scroll.scrollTop, 13, 13) : new DOMRect(0, 0, 0, 0);
    };
    try {
      const glyph = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === collapsed.id)!.querySelector('.expand-glyph')!;
      fire(glyph, 'click');
      moved = 200;
      bridge.send({ type: 'render', diagram: d, positions: spread });
      expect(scroll.scrollLeft).toBe(200);
      expect(scroll.scrollTop).toBe(0);
    } finally {
      proto.getBoundingClientRect = original;
    }
  });
});

