// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

const P = 'root/1:placeOrder';
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
let diagram: SequenceDiagram;

const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  diagram = cloneSequence();
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
});

describe('sequence view: smart expand (FR-3.6)', () => {
  it('FR-3.6 the Smart toolbar button posts smartExpand for the whole diagram', () => {
    fire(view.toolbar.button('smartExpand'), 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand' });
  });

  it('FR-3.6 / FR-3.12 Show from here ▸ Overview / Expand all in the message menu post the message id', () => {
    fire(msgEl(P).querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    fire(menuItem('show-from-here')!, 'click');
    // no review: no Changes
    expect(menuItem('from-here:changes')).toBeNull();
    fire(menuItem('from-here:overview')!, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand', messageId: P });
    // not offered for calls without a body
    fire(msgEl(`${P}/5:info`).querySelector('.msg-hit')!, 'contextmenu');
    expect(menuItem('show-from-here')).toBeNull();
  });

  it('FR-3.12 ✦ always shows the Overview; its ▾ has Changes only during a review with changes, also from here', () => {
    const button = view.toolbar.button('smartExpand');
    expect([button.querySelector('.tb-label')!.textContent, button.title]).toEqual(['Overview', expect.stringContaining('success path')]);
    fire(button, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand' });
    fire(view.toolbar.button('expandMenu'), 'click');
    expect(menuItem('show:changes')).toBeNull();
    bridge.send({ type: 'render', diagram: { ...view.diagram!, reviewTotal: 3 } });
    fire(view.toolbar.button('expandMenu'), 'click');
    expect(menuItem('show:changes')!.textContent).toContain('3 in this flow');
    fire(menuItem('show:changes')!, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand', view: 'changes' });
    fire(msgEl(P).querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    fire(menuItem('show-from-here')!, 'click');
    fire(menuItem('from-here:changes')!, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand', messageId: P, view: 'changes' });
  });

  it('FR-3.12 ↯ Fold errors is a toggle (pressed while on, on when absent); the canvas menu and View ▾ have it too', () => {
    const fold = view.toolbar.button('foldErrors');
    expect(fold.getAttribute('aria-pressed')).toBe('true');
    fire(fold, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'foldErrors', value: false });
    bridge.send({ type: 'render', diagram: { ...view.diagram!, options: { ...view.diagram!.options, foldErrors: false } } });
    expect([fold.getAttribute('aria-pressed'), fold.classList.contains('active')]).toEqual(['false', false]);
    fire(view.body, 'contextmenu', { clientX: 300, clientY: 300 });
    expect(menuItem('canvas:foldErrors')!.classList.contains('checked')).toBe(false);
    fire(menuItem('canvas:foldErrors')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'foldErrors', value: true });
    fire(view.toolbar.button('view'), 'click');
    expect(menuItem('view:foldErrors')!.textContent).toContain('Fold errors');
  });

  it('FR-9.6 no hover card while a context menu is open (it would cover the menu)', async () => {
    const hit = msgEl(P).querySelector('.msg-hit')!;
    fire(hit, 'mousedown');
    fire(hit, 'contextmenu', { clientX: 30, clientY: 40 });
    fire(hit, 'mouseover', { clientX: 32, clientY: 42 }); // the mouse moves on over the message
    await new Promise((r) => setTimeout(r, 400));
    expect(menuItem('show-from-here')).not.toBeNull();
    expect(view.hoverCard.element.hidden).toBe(true);
  });

  it('FR-3.6 hovering a message shows the card after a short delay; leaving hides it', async () => {
    const hit = msgEl(P).querySelector('.msg-hit')!;
    fire(hit, 'mouseover', { clientX: 30, clientY: 40 });
    expect(view.hoverCard.element.hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(view.hoverCard.element.hidden).toBe(false);
    expect(view.hoverCard.element.querySelector('.hc-call')!.textContent).toContain('placeOrder(');
    fire(view.body, 'mouseleave');
    await new Promise((r) => setTimeout(r, 350)); // FR-9.7 a short grace: the mouse may be on its way to the card
    expect(view.hoverCard.element.hidden).toBe(true);
  });

  it('FR-3.6 low-importance messages are dimmed and every scored message explains its importance', () => {
    const d = cloneSequence();
    const info = d.messages.find((m) => m.id === `${P}/5:info`)!;
    info.importance = { score: -3, reasons: ['↓ logging'], low: true };
    d.messages.find((m) => m.id === P)!.importance = { score: 6, reasons: ['↑ crosses Presentation → Application', '↑ «service»'], low: false };
    bridge.send({ type: 'render', diagram: d });
    expect(msgEl(`${P}/5:info`).classList.contains('low')).toBe(true);
    expect(msgEl(P).classList.contains('low')).toBe(false);
    // the importance is in the hover card (small, muted lines), not in a native tooltip
    expect(msgEl(P).querySelector(':scope > title')).toBeNull();
    const card = messageCard(d.messages.find((m) => m.id === P)!, document);
    expect(card.map((n) => [(n as HTMLElement).className, n.textContent])).toEqual([
      ['hc-call', expect.stringContaining('placeOrder(')],
      ['hc-imp-head', 'How ✦ Overview weighs this call (score 6)'],
      ['hc-imp', '↑ crosses Presentation → Application'],
      ['hc-imp', '↑ «service»'],
    ]);
  });
});

describe('Overview that changes nothing says so', () => {
  const overview = (after: SequenceDiagram) => {
    const b = testBridge<HostToSequenceView, SequenceViewToHost>();
    const v = startSequenceView(mount(), b, { measureText: estimateTextWidth });
    b.send({ type: 'render', diagram: cloneSequence() });
    fire(v.toolbar.button('smartExpand'), 'click');
    expect(b.posted.at(-1)).toEqual({ type: 'smartExpand' });
    b.send({ type: 'render', diagram: after });
    const flash = v.toolbar.button('smartExpand').dataset.flash;
    // only the answer to that request: the next render says nothing
    b.send({ type: 'render', diagram: after });
    expect(v.toolbar.button('smartExpand').dataset.flash).toBe(flash);
    return flash;
  };

  it('the same calls open after ✦ Overview: the button says why nothing changed; another result or another flow: no note', () => {
    expect(overview(cloneSequence())).toBe('Nothing changed: Overview already shows the important calls');
    const fewer = cloneSequence();
    fewer.messages = fewer.messages.filter((m) => m.id === 'root' || m.parentId === 'root').map((m) => ({ ...m, expanded: m.id === 'root' }));
    expect(overview(fewer)).toBeUndefined();
    const other = cloneSequence();
    other.root = { ...other.root, key: 'other#X.y' };
    expect(overview(other)).toBeUndefined();
  });
});
