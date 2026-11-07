// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
let d: SequenceDiagram;
const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  d = cloneSequence();
  bridge.send({ type: 'render', diagram: d });
  bridge.posted.length = 0;
});

describe('FR-3.3 / FR-3.7 Expand all opens everything; one level and per-call variants', () => {
  it('FR-3.3 / FR-3.12 Expand all in the ▾ next to ✦ expands everything (the ✦ click stays Overview); the ▾ offers one more level', () => {
    fire(view.toolbar.button('expandMenu'), 'click');
    fire(menuItem('show:expand-all')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll' });
    expect(view.toolbar.button('smartExpand').querySelector('.tb-label')!.textContent).toBe('Overview');
    fire(view.toolbar.button('smartExpand'), 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand' });
    fire(view.toolbar.button('expandMenu'), 'click');
    fire(menuItem('expand-one-level')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll', oneLevel: true });
  });

  it('FR-3.7 Shift+click on ⊕ and Show from here ▸ Expand all expand everything below that call; a plain click one level', () => {
    const collapsed = d.messages.find((m) => m.expandable && !m.expanded)!;
    const glyph = msgEl(collapsed.id).querySelector('.expand-glyph')!;
    fire(glyph, 'click');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: collapsed.id });
    glyph.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(bridge.last()).toEqual({ type: 'expandAll', messageId: collapsed.id });
    fire(msgEl(collapsed.id).querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    fire(menuItem('show-from-here')!, 'click');
    expect(menuItem('from-here:expand-all')!.textContent).toContain('Shift+click ⊕');
    fire(menuItem('from-here:expand-all')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll', messageId: collapsed.id });
  });

  it('FR-3.3 a capped expansion shows a notice with the next steps; it can be closed and is gone on the next render', () => {
    expect(view.noticeEl.hidden).toBe(true);
    const capped = cloneSequence();
    capped.expandNotice = { reason: 'messages', messages: 498, depth: 4, folded: 37, limit: 500 };
    bridge.send({ type: 'render', diagram: capped });
    expect(view.noticeEl.hidden).toBe(false);
    expect(view.noticeEl.querySelector('.notice-text')!.textContent).toBe('ⓘ Stopped at 498 messages (limit 500) — 37 calls still folded (⊕).');
    const buttons = [...view.noticeEl.querySelectorAll('button')];
    fire(buttons.find((b) => b.textContent === 'Overview instead')!, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand' });
    fire(buttons.find((b) => b.textContent === 'One more level')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll', oneLevel: true });
    fire(buttons.find((b) => b.textContent === '✕')!, 'click');
    expect(view.noticeEl.hidden).toBe(true);
    bridge.send({ type: 'render', diagram: capped });
    expect(view.noticeEl.hidden).toBe(false);
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.noticeEl.hidden).toBe(true);
  });
  it('FR-3.1 the root call is always expanded: no ⊖ and no Collapse item, the expand variants stay', () => {
    expect(msgEl('root').querySelector('.expand-glyph')).toBeNull();
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    expect(menuItem('collapse')).toBeNull();
    expect(menuItem('from-here:expand-all')).not.toBeNull();
    const inner = d.messages.find((m) => m.id !== 'root' && m.expanded)!;
    expect(msgEl(inner.id).querySelector('[data-action="collapse"]')).not.toBeNull();
  });
});
