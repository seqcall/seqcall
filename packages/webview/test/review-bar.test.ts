// @vitest-environment jsdom
import type { Message } from '@seqcall/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowChooser, reviewBar, type ReviewBarState } from '../src/sequence/review-bar';
import type { TourFlow } from '../src/sequence/review-tour';
import { cloneSequence } from '../dev/mock-data';

afterEach(() => vi.useRealTimers());

const flow = (label: string, methods: string[], entryPoint = true): TourFlow => ({ label, methods, paths: [], alsoFrom: [], ...(entryPoint ? { entryPoint: { kind: 'http', label } as never } : {}) });
const noop = { prevFlow: () => {}, nextFlow: () => {}, prevChange: () => {}, nextChange: () => {}, openPanel: () => {}, chooseFlow: () => {} };
const msg = (diff: Message['diff']): Message => ({ ...cloneSequence().messages[1], diff });
const bar = (stop: Message) => reviewBar({ branch: 'feat', base: 'main', flows: [flow('GET /a', ['A.b'])], flowIndex: 0, stops: [stop], current: 0, atEnd: false, text: 'x' } as ReviewBarState, noop);

describe('FR-24.9 the review bar: the kind of the current change', () => {
  it('FR-24.9 a changed call or method without a status counts as changed; neither: a change inside', () => {
    expect(bar(msg({ call: true })).querySelector('.rb-change')!.getAttribute('class')).toBe('rb-change st-changed');
    expect(bar(msg({ method: 'changed' })).querySelector('.rb-change')!.getAttribute('class')).toBe('rb-change st-changed');
    expect(bar(msg({ inside: 2 })).querySelector('.rb-change')!.getAttribute('class')).toBe('rb-change st-inside');
  });
});

describe('a flow without changed calls', () => {
  it('says "no changed calls in this flow"; its tooltip says what a Δ on a box counts', () => {
    const el = reviewBar({ branch: 'feat', base: 'main', flows: [flow('GET /a', ['A.b'])], flowIndex: 0, stops: [], current: 0, atEnd: false } as unknown as ReviewBarState, noop).querySelector('.rb-change') as HTMLElement;
    expect(el.textContent).toContain('no changed calls in this flow');
    expect(el.title).toBe('no changed calls in this flow\nA Δn on a box counts the members of its class the branch changed — also those this flow does not call');
    expect((bar(msg({ call: true })).querySelector('.rb-change') as HTMLElement).title).toBe('x');
    // the counter says its unit: steps; the flow's changed methods beside it
    expect((bar(msg({ call: true })).querySelector('.rb-change .rb-count') as HTMLElement).title).toBe('Steps of the tour: each changed call, and each changed method it reaches (1 changed method in this flow)');
    const two = reviewBar({ branch: 'feat', base: 'main', flows: [flow('GET /a', ['A.b', 'A.c'])], flowIndex: 0, stops: [], current: 0, atEnd: false } as unknown as ReviewBarState, noop);
    expect((two.querySelector('.rb-change .rb-count') as HTMLElement).title).toContain('(2 changed methods in this flow)');
    const none = reviewBar({ branch: 'feat', base: 'main', flows: [flow('GET /a', ['A.b'])], flowIndex: -1, stops: [], current: 0, atEnd: false } as unknown as ReviewBarState, noop);
    expect((none.querySelector('.rb-change .rb-count') as HTMLElement).title).toBe('Steps of the tour: each changed call, and each changed method it reaches');
  });
});

describe('FR-24.12 the list of the review\'s flows', () => {
  function setup(flows: TourFlow[]) {
    const picked: [number, number | undefined][] = [];
    const panel = flowChooser(flows, 0, (i, also) => picked.push([i, also]));
    document.body.replaceChildren(panel);
    const input = panel.querySelector('input')!;
    const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const type = (q: string) => {
      input.value = q;
      input.dispatchEvent(new Event('input'));
    };
    const active = () => panel.querySelector('.fc-row.active')?.getAttribute('data-flow-index') ?? null;
    return { panel, picked, key, type, active };
  }

  it('FR-24.12 a flow that shows nothing new says so', () => {
    const s = setup([flow('GET /a', ['A.b']), flow('GET /c', [])]);
    expect(s.panel.querySelectorAll('.fc-methods')[1].textContent).toBe('0 changed: nothing new (reaches changes shown before)');
  });

  it('FR-24.12 ↓ ↑ move through the rows (wrapping), Enter opens the active one, other keys type', () => {
    const s = setup([flow('GET /a', ['A.b']), flow('GET /c', ['C.d']), flow('GET /e', ['E.f'])]);
    expect(s.active()).toBe('0');
    s.key('ArrowUp');
    expect(s.active()).toBe('2');
    s.key('ArrowDown');
    expect(s.active()).toBe('0');
    s.key('ArrowDown');
    expect(s.active()).toBe('1');
    expect(s.key('x')).toBe(true); // not taken
    expect(s.key('Enter')).toBe(false);
    expect(s.picked).toEqual([[1, undefined]]);
  });

  it('FR-24.12 a filter that matches nothing: no rows, the keys do nothing', () => {
    const s = setup([flow('GET /a', ['A.b'])]);
    s.type('zzz');
    expect(s.panel.querySelector('.fc-status')!.textContent).toBe('0 of 1 flows');
    s.key('ArrowDown');
    s.key('Enter');
    expect(s.active()).toBeNull();
    expect(s.picked).toEqual([]);
  });

  it('FR-24.12 the filter has the focus once the list is open', () => {
    vi.useFakeTimers();
    const s = setup([flow('GET /a', ['A.b'])]);
    vi.runAllTimers();
    expect(document.activeElement).toBe(s.panel.querySelector('input'));
  });
});
