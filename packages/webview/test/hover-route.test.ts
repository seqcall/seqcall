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
let d: SequenceDiagram;

const route = (id: string, diagram = d) => {
  const row = messageCard(diagram.messages.find((m) => m.id === id)!, document, diagram)[0] as HTMLElement;
  expect(row.className).toBe('hc-route');
  return { text: row.textContent, chips: [...row.querySelectorAll('.hc-chip')] as HTMLElement[] };
};

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  d = cloneSequence();
  bridge.send({ type: 'render', diagram: d });
});

describe('hover card: who calls whom (FR-9.6)', () => {
  it('FR-9.6 a call shows sender ──▶ receiver as chips in their layer colours (async: open arrow)', () => {
    const r = route(P);
    expect(r.text).toBe(':OrderController──▷:OrderService');
    expect(r.chips.map((c) => c.className)).toEqual(['hc-chip layer-1', 'hc-chip layer-2']); // Presentation, Application
    expect(r.chips[0].title).toBe(':OrderController · Presentation');
    expect(route(`${P}/0:findById`).text).toBe(':OrderService──▶primary:CustomerRepository');
  });

  it('FR-9.6 self calls, creations and the root message', () => {
    expect(route('root/0:validate').text).toBe(':OrderController↻ self');
    expect(route(`${P}/3:constructor`).text).toBe(':OrderService┄«create»┄▶:Order');
    expect(route('root').text).toBe('● ──▶:OrderController');
  });

  it('FR-9.6 long participant labels are shortened (full label in the tooltip)', () => {
    const long = cloneSequence();
    long.participants.find((p) => p.id === 'p-svc')!.label = 'orderServiceWithAVeryLongName:OrderService';
    const chip = route(P, long).chips[1];
    expect(chip.textContent).toBe('orderServiceWithAVeryLongNa…');
    expect(chip.title).toBe('orderServiceWithAVeryLongName:OrderService · Application');
  });

  it('FR-9.6 while the card is shown, sender and receiver are marked in the frozen header', async () => {
    const msgEl = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === P)!;
    fire(msgEl.querySelector('.msg-hit')!, 'mouseover', { clientX: 30, clientY: 40 });
    await new Promise((r) => setTimeout(r, 400));
    expect(view.hoverCard.element.querySelector('.hc-route')).not.toBeNull();
    const marked = [...view.header.querySelectorAll('.hover-end')].map((e) => e.getAttribute('data-participant-id'));
    expect(marked.sort()).toEqual(['p-ctrl', 'p-svc']);
    fire(view.body, 'mouseleave');
    await new Promise((r) => setTimeout(r, 350)); // FR-9.7 a short grace: the mouse may be on its way to the card
    expect(view.header.querySelectorAll('.hover-end')).toHaveLength(0);
  });
});

describe('hover card zoomed to layers: the objects behind the lifelines (FR-28.10)', () => {
  /** The mock diagram as if zoomed: the controller and service lifelines stand for layers. */
  const zoomed = () => {
    const z = cloneSequence();
    z.participants.find((p) => p.id === 'p-ctrl')!.label = 'Presentation';
    z.participants.find((p) => p.id === 'p-svc')!.label = 'Application';
    const m = z.messages.find((x) => x.id === P)!;
    m.objects = { from: { id: 'o-ctrl', label: ':OrderController', layer: 'Presentation' }, to: { id: 'o-svc', label: 'orderServiceWithAVeryLongName:OrderService', layer: 'Application' } };
    z.messages.find((x) => x.id === 'root')!.objects = { to: { id: 'o-ctrl', label: ':OrderController', layer: 'Presentation' } };
    return z;
  };

  it('FR-28.10 each end is the object (layer-coloured, shortened) with its lifeline\'s name under it', () => {
    const z = zoomed();
    const row = messageCard(z.messages.find((m) => m.id === P)!, document, z)[0] as HTMLElement;
    const ends = [...row.querySelectorAll('.hc-end')];
    expect(ends.map((e) => [e.querySelector('.hc-chip')!.textContent, e.querySelector('.hc-layer')!.textContent])).toEqual([
      [':OrderController', 'Presentation'],
      ['orderServiceWithAVeryLongNa…', 'Application'],
    ]);
    const chip = ends[1].querySelector('.hc-chip') as HTMLElement;
    expect(chip.className).toBe('hc-chip layer-2');
    expect(chip.title).toBe('orderServiceWithAVeryLongName:OrderService · Application — click: show it on its own lifeline');
    expect(chip.dataset.pull).toBe('o-svc');
    expect((ends[1].querySelector('.hc-layer') as HTMLElement).dataset.participantId).toBe('p-svc');
    // the root: only the receiver; an end without an object (drawn as itself) stays a plain chip
    expect(route('root', z).text).toBe('● ──▶:OrderControllerPresentation');
    expect(route(`${P}/0:findById`, z).text).toBe('Application──▶primary:CustomerRepository');
  });

  it('FR-28.10 a click on the object pulls it out of its layer; on the layer name it scrolls to the lifeline', async () => {
    bridge.send({ type: 'render', diagram: zoomed() });
    const msgEl = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === P)!;
    fire(msgEl.querySelector('.msg-hit')!, 'mouseover', { clientX: 30, clientY: 40 });
    await new Promise((r) => setTimeout(r, 400));
    const card = view.hoverCard.element;
    fire(card.querySelector('.hc-layer')!, 'click');
    expect(bridge.posted.some((m) => m.type === 'setLayerOpen')).toBe(false);
    fire(card.querySelector('[data-pull="o-svc"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'o-svc', open: true });
  });
});

