// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const P = 'root/1:placeOrder';

/** The mock diagram with placeOrder's calls folded, and the full one (what Expand brings). */
function diagrams(): { folded: SequenceDiagram; open: SequenceDiagram } {
  const open = cloneSequence();
  const folded = cloneSequence();
  folded.messages = folded.messages.filter((m) => !m.id.startsWith(`${P}/`)).map((m) => (m.id === P ? { ...m, expanded: false } : m));
  folded.fragments = [];
  folded.exits = [];
  return { folded, open };
}

function setup(width: number, height: number) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, get: () => height });
  const { folded, open } = diagrams();
  bridge.send({ type: 'render', diagram: folded });
  return { bridge, view, open };
}

/** Whether a message's row is inside the scrolled view (below the sticky header). */
function inView(view: ReturnType<typeof setup>['view'], id: string, width: number, height: number): boolean {
  const g = view.geometry!;
  const mg = g.messages.find((m) => m.message.id === id)!;
  const s = view.scroll;
  const viewH = height - g.headerHeight * view.zoom;
  const y = mg.box.y * view.zoom;
  const x = mg.labelX * view.zoom;
  return y >= s.scrollTop && y < s.scrollTop + viewH && x >= s.scrollLeft && x < s.scrollLeft + width;
}

describe('FR-3.8 after an expand the new calls are brought into view', () => {
  it('FR-3.8 Expand all: the new calls opened off screen, the view scrolls to the first of them', () => {
    const width = 260;
    const height = 140; // a small panel: only the first rows fit
    const { bridge, view, open } = setup(width, height);
    const first = `${P}/0:findById`;
    fire(view.toolbar.button('expandMenu'), 'click');
    fire(view.root.querySelector('[data-menu-id="show:expand-all"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll' });
    bridge.send({ type: 'render', diagram: open });
    expect(view.scroll.scrollTop + view.scroll.scrollLeft).toBeGreaterThan(0);
    expect(inView(view, first, width, height)).toBe(true);
  });

  it('FR-3.8 a new call already in sight: the view does not move', () => {
    const { bridge, view, open } = setup(5000, 5000);
    fire(view.toolbar.button('smartExpand'), 'click');
    bridge.send({ type: 'render', diagram: open });
    expect(view.scroll.scrollTop).toBe(0);
    expect(view.scroll.scrollLeft).toBe(0);
  });

  it('FR-3.8 a render the user did not start (background I/O scan, a refresh) does not scroll', () => {
    const { bridge, view, open } = setup(260, 140);
    bridge.send({ type: 'render', diagram: open });
    expect(view.scroll.scrollTop).toBe(0);
    expect(view.scroll.scrollLeft).toBe(0);
  });
});
