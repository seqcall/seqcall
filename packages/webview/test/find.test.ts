// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, SearchHit, SequenceViewToHost } from '@seqcall/protocol';
import { messageFocusBox, startSequenceView, type SequenceView } from '../src/sequence/view';
import type { MessageGeom } from '../src/sequence/layout';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { nameMatches } from '../src/find-match';
import { nameMatches as coreNameMatches } from '../../core/src/search';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

const P = 'root/1:placeOrder';
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
const bar = () => view.root.querySelector('.find-bar') as HTMLElement;
const input = () => view.root.querySelector('.find-input') as HTMLInputElement;
const count = () => view.root.querySelector('.find-count')!.textContent;
const type = (q: string) => {
  input().value = q;
  fire(input(), 'input');
};
const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const marked = () => [...view.body.querySelectorAll('.message.find-hit')].map((e) => e.getAttribute('data-msg-id'));
const current = () => [...view.body.querySelectorAll('.message.highlighted')].map((e) => e.getAttribute('data-msg-id'));

const hit: SearchHit = {
  anchorId: `${P}/2:total`,
  steps: [{ methodKey: 'src/services/price-calculator.ts#PriceCalculator.total', call: { range: { file: 'src/services/price-calculator.ts', start: { line: 9, character: 4 }, end: { line: 9, character: 30 } } } }],
  labels: ['PriceCalculator.total'],
  hit: { label: 'TaxTable.lookup', range: { file: 'src/services/price-calculator.ts', start: { line: 9, character: 4 }, end: { line: 9, character: 30 } } },
};

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: cloneSequence() });
  bridge.posted.length = 0;
});

describe('FR-23 find in the sequence diagram', () => {
  it('FR-23.1 Ctrl+F, / and ⌕ open the bar; Escape closes it and clears the marks', () => {
    expect(bar().hidden).toBe(true);
    key(document, { key: 'f', ctrlKey: true });
    expect(bar().hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    type('placeOrder');
    expect(marked().length).toBe(2);
    key(input(), { key: 'Escape' });
    expect(bar().hidden).toBe(true);
    expect(marked()).toEqual([]);
    key(document, { key: '/' });
    expect(bar().hidden).toBe(false);
    view.find.bar.close();
    fire(view.toolbar.button('find'), 'click');
    expect(bar().hidden).toBe(false);
  });

  it('FR-23.1 drawn matches by method, Class.method and camelCase initials; Enter / Shift+Enter step through them', () => {
    view.find.open();
    type('findById');
    expect(marked()).toEqual([`${P}/0:findById`, `${P}/1:findById`]);
    expect(count()).toBe('1 of 2');
    expect(current()).toEqual([`${P}/0:findById`]);
    key(input(), { key: 'Enter' });
    expect(count()).toBe('2 of 2');
    expect(current()).toEqual([`${P}/1:findById`]);
    key(input(), { key: 'Enter', shiftKey: true });
    expect(current()).toEqual([`${P}/0:findById`]);
    type('PriceCalculator.total');
    expect(marked()).toEqual([`${P}/2:total`]);
    type('nC'); // notifyCustomer
    expect(marked()).toEqual([`${P}/6:notifyCustomer`, `${P}/6:notifyCustomer/0:notifyCustomer`]); // and its retry
    type('zzz');
    expect(count()).toBe('No matches');
    // the receivers of the matches are outlined in the header too
    type('charge');
    expect([...view.header.querySelectorAll('.find-hit')].map((e) => e.getAttribute('data-participant-id'))).toEqual(['p-gw']);
  });

  it('FR-23.5 an object\'s messages: Shift+click on its box or "Find its messages" → every message it sends or receives, Enter steps', () => {
    const order = view.header.querySelector('[data-participant-id="p-order"]')!;
    fire(order, 'click', { shiftKey: true });
    expect(bar().hidden).toBe(false);
    expect(input().value).toBe('@:Order');
    // received (the creation, toDto) and sent (its self call), top to bottom
    expect(marked()).toEqual([`${P}/3:constructor`, `${P}/3:constructor/0:assertValid`, 'root/2:toDto']);
    expect(count()).toBe('1 of 3');
    key(input(), { key: 'Enter' });
    expect(current()).toEqual([`${P}/3:constructor/0:assertValid`]);
    // the object itself is outlined in the header, not the receivers of its calls
    expect([...view.header.querySelectorAll('.find-hit')].map((e) => e.getAttribute('data-participant-id'))).toEqual(['p-order']);
    // nothing to search below the collapsed calls for an object
    expect(bridge.posted.some((m) => m.type === 'searchCollapsed')).toBe(false);
    // the label picks one object of a class drawn twice; a class name picks all of them
    type('@primary:CustomerRepository');
    expect(marked()).toEqual([`${P}/0:findById`]);
    type('@CustomerRepository');
    expect(marked()).toEqual([`${P}/0:findById`, `${P}/1:findById`]);
    // from the participant's menu
    view.find.bar.close();
    fire(view.header.querySelector('[data-participant-id="p-gw"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(view.root.querySelector('.popup-layer [data-menu-id="find-messages"]')!, 'click');
    expect(input().value).toBe('@:PaymentGateway');
    expect(marked()).toEqual([`${P}/4:charge`]);
  });

  it('FR-23.5 Shift+click names that lifeline (two with one label: only it); also on its dashed line in the body', () => {
    const d = cloneSequence();
    d.participants.find((p) => p.id === 'p-repo2')!.label = 'primary:CustomerRepository';
    bridge.send({ type: 'render', diagram: d });
    fire(view.header.querySelector('[data-participant-id="p-repo1"]')!, 'click', { shiftKey: true });
    expect(input().value).toBe('@primary:CustomerRepository');
    expect(marked()).toEqual([`${P}/0:findById`]);
    // a query typed differently names every lifeline with that label
    type('@primary:customerrepository');
    expect(marked()).toEqual([`${P}/0:findById`, `${P}/1:findById`]);
    // the lifeline below the box; a plain click on it does nothing
    view.find.bar.close();
    fire(view.body.querySelector('.lifeline-hit[data-lifeline="p-repo2"]')!, 'click');
    expect(bar().hidden).toBe(true);
    fire(view.body.querySelector('.lifeline-hit[data-lifeline="p-repo2"]')!, 'click', { shiftKey: true });
    expect(marked()).toEqual([`${P}/1:findById`]);
  });

  it('FR-23.1 Dim others fades what does not match', () => {
    view.find.open();
    type('total');
    fire(view.root.querySelector('.find-dim-toggle')!, 'click');
    expect(view.root.classList.contains('find-dimmed')).toBe(true);
  });

  it('FR-23.2 after a pause the host searches the collapsed calls; the matches are listed and one opens its path', () => {
    vi.useFakeTimers();
    try {
      view.find.open();
      type('lookup');
      expect(bridge.posted.some((m) => m.type === 'searchCollapsed')).toBe(false);
      vi.advanceTimersByTime(400);
      expect(bridge.last()).toEqual({ type: 'searchCollapsed', query: 'lookup' });
      bridge.send({ type: 'searchResults', query: 'lookup', state: 'running', methods: 12 });
      expect(bar().textContent).toContain('Searching the collapsed calls… 12 methods');
      bridge.send({ type: 'searchResults', query: 'lookup', state: 'done', hits: [hit], methods: 30, truncated: true });
      expect(count()).toBe('None drawn');
      const row = bar().querySelector('.find-deep-item')!;
      expect(row.textContent).toBe('TaxTable.lookupin PriceCalculator.totalprice-calculator.ts:10');
      expect(bar().textContent).toContain('In collapsed calls (1+)');
      fire(bar().querySelector('.find-deeper')!, 'click');
      expect(bridge.last()).toEqual({ type: 'searchCollapsed', query: 'lookup', deeper: true });
      bridge.send({ type: 'searchResults', query: 'lookup', state: 'done', hits: [hit], methods: 30, deeper: true });
      fire(bar().querySelector('.find-deep-item')!, 'click');
      expect(bridge.last()).toEqual({ type: 'revealSearchHit', hit });
      // the answer for an older query is ignored
      bridge.send({ type: 'searchResults', query: 'other', state: 'done', hits: [] });
      expect(bar().querySelector('.find-deep-item')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-23.5 an @object not drawn says so and is searched for below the collapsed calls; a found call opens its path', () => {
    vi.useFakeTimers();
    try {
      view.find.open();
      type('@:TaxTable');
      expect(count()).toBe('Not drawn');
      vi.advanceTimersByTime(400);
      expect(bridge.last()).toEqual({ type: 'searchCollapsed', query: '@:TaxTable' });
      expect(count()).toBe('Not drawn');
      bridge.send({ type: 'searchResults', query: '@:TaxTable', state: 'done', hits: [hit], methods: 30 });
      expect(count()).toBe('None drawn');
      fire(bar().querySelector('.find-deep-item')!, 'click');
      expect(bridge.last()).toEqual({ type: 'revealSearchHit', hit });
      // nowhere in the flow: no matches
      type('@:Nowhere');
      vi.advanceTimersByTime(400);
      bridge.send({ type: 'searchResults', query: '@:Nowhere', state: 'done', hits: [], methods: 30 });
      expect(count()).toBe('No matches');
      expect(bar().textContent).toContain('Not in the collapsed calls either');
    } finally {
      vi.useRealTimers();
    }
  });

  it('FR-23.3 the revealed call becomes the current match once its diagram arrives', () => {
    view.find.open();
    type('lookup');
    bridge.send({ type: 'searchResults', query: 'lookup', state: 'done', hits: [hit], methods: 3 });
    fire(bar().querySelector('.find-deep-item')!, 'click');
    const d = cloneSequence();
    const total = d.messages.find((m) => m.id === `${P}/2:total`)!;
    total.expanded = true;
    d.messages.push({ ...total, id: `${P}/2:total/0:lookup`, parentId: total.id, depth: 3, methodName: 'lookup', className: 'TaxTable', expanded: false, expandable: false });
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: `${P}/2:total/0:lookup` });
    expect(count()).toBe('1 of 1');
    expect(current()).toEqual([`${P}/2:total/0:lookup`]);
  });

  it('FR-23.4 the host can open the bar with a query (from the class diagram)', () => {
    bridge.send({ type: 'openFind', query: 'charge' });
    expect(bar().hidden).toBe(false);
    expect(input().value).toBe('charge');
    expect(marked()).toEqual([`${P}/4:charge`]);
  });
});

describe('FR-23.4 find in the class diagram', () => {
  it('classes and method rows match; nothing drawn → Search the flow', () => {
    const cb = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), cb, { measureText: estimateTextWidth, engine: 'dagre' });
    cb.send({ type: 'render', diagram: mockClassDiagram });
    cv.find.open();
    const q = cv.root.querySelector('.find-input') as HTMLInputElement;
    q.value = 'charge';
    fire(q, 'input');
    const nodes = [...cv.canvas.querySelectorAll('.class-node.find-hit')].map((e) => e.getAttribute('data-class-key'));
    expect(nodes).toEqual(['PaymentGateway', 'StripeGateway']);
    expect(cv.canvas.querySelectorAll('.cls-member.find-hit')).toHaveLength(2);
    expect(cv.root.querySelector('.find-count')!.textContent).toBe('1 of 2');
    expect(cv.canvas.querySelector('.class-node.find-current')!.getAttribute('data-class-key')).toBe('PaymentGateway');
    q.value = 'OrderSer';
    fire(q, 'input');
    expect([...cv.canvas.querySelectorAll('.class-node.find-hit')].map((e) => e.getAttribute('data-class-key'))).toEqual(['OrderService']);
    q.value = 'lookup';
    fire(q, 'input');
    fire(cv.root.querySelector('.find-deeper')!, 'click');
    expect(cb.last()).toEqual({ type: 'findInFlow', query: 'lookup' });
  });
});

describe('FR-23.1 the view and core match names the same way', () => {
  it('same answers for the same cases', () => {
    const cases: [string, string][] = [['fU', 'findUser'], ['uf', 'findUser'], ['pcv', 'PayCartViaVoucherAsync'], ['gub', 'get_user_by_id'], ['htmlP', 'HTMLParser'], ['Repo.find', 'UserService.findUser'], ['USER', 'findUser']];
    for (const [q, n] of cases) expect(nameMatches(q, n)).toBe(coreNameMatches(q, n));
  });
});

describe('FR-23.3 a highlighted message scrolls its label into view, not the far end of its arrow', () => {
  it('a long arrow drawn right to left: the label and the sender end are shown', () => {
    // sender far right (x1), receiver far left (x2); the label sits next to the sender
    const mg = { x1: 2400, x2: 60, labelX: 2200, label: { width: 150 }, box: { x: 56, y: 300, width: 2350, height: 24 } } as unknown as MessageGeom;
    expect(messageFocusBox(mg, 1200)).toEqual({ x: 2200, y: 300, width: 2400 - 2200, height: 24 });
    // a view narrower than label + sender end: the label wins
    expect(messageFocusBox(mg, 200).x).toBe(2200);
    // a view the whole call fits in: both ends and the label
    expect(messageFocusBox(mg, 2500)).toEqual({ x: 60, y: 300, width: 2400 - 60, height: 24 });
  });

  it('a call that fits is centred, both ends in view (the box at the edge was cut in half)', () => {
    const s = view.root.querySelector('.seq-scroll') as HTMLElement;
    Object.defineProperty(s, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(s, 'clientHeight', { configurable: true, value: 400 });
    const target = view.geometry!.messages.find((m) => m.id === `${P}/6:notifyCustomer`)!;
    const box = messageFocusBox(target, 1000);
    expect(box.width + 48).toBeLessThanOrEqual(1000);
    s.scrollLeft = 5000;
    view.find.open();
    type('notifyCustomer');
    expect(s.scrollLeft).toBe(Math.max(0, box.x + box.width / 2 - 500));
    expect(s.scrollLeft).toBeLessThanOrEqual(Math.min(target.x1, target.x2));
    expect(s.scrollLeft + 1000).toBeGreaterThanOrEqual(Math.max(target.x1, target.x2));
  });

  it('the view scrolls horizontally to the label of the current match', () => {
    const s = view.root.querySelector('.seq-scroll') as HTMLElement;
    Object.defineProperty(s, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(s, 'clientHeight', { configurable: true, value: 400 });
    const g = view.geometry!;
    const target = g.messages.find((m) => m.id === `${P}/6:notifyCustomer`)!;
    view.find.open();
    type('notifyCustomer');
    expect(s.scrollLeft).toBeGreaterThan(0);
    expect(s.scrollLeft).toBeLessThanOrEqual(Math.min(target.labelX, target.x1));
    expect(s.scrollLeft + 300).toBeGreaterThanOrEqual(target.labelX);
  });
});
