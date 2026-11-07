// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { EMPTY_TEXT, messageCard, startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockCallers, range } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge, viewOptionRow } from './helpers';

const P = 'root/1:placeOrder';
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
let diagram: SequenceDiagram;

function msgEl(id: string): Element {
  const el = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id);
  if (!el) throw new Error(`message ${id} not rendered`);
  return el;
}
const headerBox = (id: string) => view.header.querySelector(`[data-participant-id="${id}"]`)!;
const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  diagram = cloneSequence();
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
});

describe('sequence view: rendering', () => {
  it('posts ready on start', () => {
    const b = testBridge<HostToSequenceView, SequenceViewToHost>();
    startSequenceView(mount(), b, { measureText: estimateTextWidth });
    expect(b.posted).toEqual([{ type: 'ready' }]);
  });

  it('FR-6.1 header is a separate SVG in a sticky container inside the scroll container', () => {
    expect(view.header.parentElement).toBe(view.scroll);
    expect(view.header.classList.contains('seq-header')).toBe(true);
    expect(view.header.querySelector('svg.seq-header-svg')).not.toBeNull();
    expect(view.body.querySelector('svg.seq-body-svg')).not.toBeNull();
    expect(view.header.style.width).toBe(view.body.style.width);
  });

  it('FR-6.3 / FR-6.2 header shows stereotypes above labels, named participants of the same class', () => {
    const text = view.header.textContent!;
    for (const s of [':OrderController', '«static»', 'PriceCalculator', 'primary:CustomerRepository', 'replica:CustomerRepository', '«interface, port, seam»']) {
      expect(text).toContain(s);
    }
    // «controller» on OrderController says what the name says: left out of the box, kept in its tooltip
    const box = headerBox('p-ctrl');
    expect([...box.querySelectorAll('text')].map((t) => t.textContent)).toEqual([':OrderController']);
    expect(box.querySelector(':scope > title')!.textContent).toContain('«controller»');
    const stat = [...headerBox('p-price').querySelectorAll('text')];
    expect(stat[0].textContent).toBe('«static»');
    expect(Number(stat[0].getAttribute('y'))).toBeLessThan(Number(stat[1].getAttribute('y')));
  });

  it('FR-6.4 header renders group bands with labels', () => {
    const labels = [...view.header.querySelectorAll('.group-label')].map((t) => t.textContent);
    expect(labels).toHaveLength(5);
    expect(labels[1]).toContain('Application');
  });

  it('FR-5.1 / FR-5.2 created participant: head in the body, faded copy in the header', () => {
    expect(headerBox('p-order').classList.contains('faded')).toBe(true);
    expect(view.body.querySelector('.created-head[data-participant-id="p-order"]')).not.toBeNull();
    expect(msgEl(`${P}/3:constructor`).querySelector('.msg-line.dashed')).not.toBeNull();
  });

  it('FR-9.1 labels: name and arguments in separate styled elements, full call in the hover card', () => {
    const el = msgEl(`${P}/2:total`);
    expect(el.querySelector('.seg-name')!.textContent).toBe('total');
    const args = el.querySelector('.seg-args')!.textContent!;
    expect(args).toMatch(/^\(items\.filt.*…, customer\..*\)$/);
    expect(args.length - 2).toBeLessThanOrEqual(diagram.options.maxArgumentLength);
    const m = diagram.messages.find((x) => x.id === `${P}/2:total`)!;
    expect(messageCard(m, document)[0].textContent).toContain('items.filter(i => i.quantity > 0 && !i.isGift)');
  });

  it('FR-9.3 arguments off renders name(…)', () => {
    diagram.options.showArguments = false;
    bridge.send({ type: 'render', diagram });
    expect(msgEl(`${P}/2:total`).querySelector('.seg-args')!.textContent).toBe('(…)');
    expect(msgEl('root/2:toDto').querySelector('.seg-args')!.textContent).toBe('()');
  });

  it('marks library, async, recursive and polymorphic messages', () => {
    expect(msgEl(`${P}/5:info`).classList.contains('library')).toBe(true);
    expect(msgEl(`${P}/4:charge`).classList.contains('async')).toBe(true);
    expect(msgEl(`${P}/6:notifyCustomer/0:notifyCustomer`).querySelector('.seg-recursive')).not.toBeNull();
    expect(msgEl(`${P}/4:charge`).querySelector('.poly-badge')!.textContent).toContain('choose impl (2)');
  });

  it('shows the placeholder for empty and errors', () => {
    bridge.send({ type: 'empty', reason: 'no method' });
    expect(view.placeholder.hidden).toBe(false);
    expect(view.placeholder.textContent).toContain(EMPTY_TEXT);
    expect(view.body.querySelector('svg')).toBeNull();
    bridge.send({ type: 'error', message: 'boom' });
    expect(view.placeholder.classList.contains('error')).toBe(true);
    expect(view.placeholder.textContent).toContain('boom');
  });

  it('highlights a message', () => {
    bridge.send({ type: 'highlight', messageId: `${P}/4:charge` });
    expect(msgEl(`${P}/4:charge`).classList.contains('highlighted')).toBe(true);
    bridge.send({ type: 'render', diagram }); // survives re-render
    expect(msgEl(`${P}/4:charge`).classList.contains('highlighted')).toBe(true);
    bridge.send({ type: 'highlight', messageId: null });
    expect(view.body.querySelector('.highlighted')).toBeNull();
  });

  it('preserves the scroll position across re-renders', () => {
    view.scroll.scrollTop = 120;
    view.scroll.scrollLeft = 40;
    bridge.send({ type: 'render', diagram });
    expect(view.scroll.scrollTop).toBe(120);
    expect(view.scroll.scrollLeft).toBe(40);
  });
});

describe('sequence view: intents', () => {
  it('FR-2.1 clicking a message navigates to its call site', () => {
    fire(msgEl(`${P}/0:findById`).querySelector('.seg-name')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: diagram.messages.find((m) => m.id === `${P}/0:findById`)!.callSite });
  });

  it('FR-2.2 clicking the found message navigates to the root declaration', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: diagram.messages[0].callSite });
  });

  it('FR-2.5 clicking an activation bar navigates to the definition of the executed method', () => {
    const d = cloneSequence();
    const target = range('src/services/order-service.ts', 18, 8, 18);
    d.messages.find((m) => m.id === P)!.targetDeclaration = target;
    bridge.send({ type: 'render', diagram: d });
    const bar = (id: string) => view.body.querySelector(`[data-activation-for="${id}"]`)!;
    expect(bar(P).classList.contains('nav')).toBe(true);
    expect(bar(P).querySelector('title')!.textContent).toContain('OrderService.placeOrder');
    fire(bar(P), 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: target });
    // no definition known (e.g. a library target): a plain bar, the click does not navigate
    bridge.posted.length = 0;
    expect(bar(`${P}/0:findById`).classList.contains('nav')).toBe(false);
    fire(bar(`${P}/0:findById`), 'click');
    expect(bridge.posted.filter((m) => m.type === 'navigate')).toEqual([]);
  });

  it('FR-2.3 / FR-12.17 clicking a participant navigates to its declaration and focuses its class in the class diagram', () => {
    const svc = diagram.participants.find((p) => p.id === 'p-svc')!;
    fire(headerBox('p-svc').querySelector('rect')!, 'click');
    expect(bridge.posted.slice(-2)).toEqual([
      { type: 'navigate', range: svc.declaration },
      { type: 'focusClass', classKey: svc.classKey },
    ]);
    // a library object has no class box: only the navigation
    bridge.posted.length = 0;
    const lib = diagram.participants.find((p) => p.classKey.startsWith('lib:'))!;
    fire(headerBox(lib.id).querySelector('rect')!, 'click');
    expect(bridge.posted.some((m) => m.type === 'focusClass')).toBe(false);
  });

  it('FR-3.1 / FR-3.2 expand and collapse glyphs', () => {
    fire(msgEl(`${P}/0:findById`).querySelector('[data-action="expand"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: `${P}/0:findById` });
    fire(msgEl(P).querySelector('[data-action="collapse"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'collapse', messageId: P });
    expect(bridge.posted.filter((m) => m.type === 'navigate')).toHaveLength(0);
  });

  it('FR-11.1 context menu "Hide calls to Class.name" posts a classMethod filter', () => {
    fire(msgEl(`${P}/0:findById`).querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    const item = menuItem('hide-class-method')!;
    expect(item.textContent).toContain('Hide calls to CustomerRepository.findById');
    fire(item, 'click');
    expect(bridge.last()).toEqual({
      type: 'hide',
      filter: { kind: 'classMethod', classKey: 'src/infrastructure/customer-repository.ts#CustomerRepository', className: 'CustomerRepository', methodName: 'findById' },
    });
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
  });

  it('FR-4.6 context menu "Focus on this call" on calls with a body (not the found message)', () => {
    fire(msgEl(P).querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    fire(menuItem('focus')!, 'click');
    expect(bridge.last()).toEqual({ type: 'focus', messageId: P });
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuItem('focus')).toBeNull();
    fire(msgEl(`${P}/5:info`).querySelector('.msg-hit')!, 'contextmenu');
    expect(menuItem('focus')).toBeNull();
  });

  it('FR-11.1 context menu "Hide all calls to name" posts a methodName filter', () => {
    fire(msgEl(`${P}/5:info`).querySelector('.msg-hit')!, 'contextmenu');
    fire(menuItem('hide-name')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'methodName', methodName: 'info' } });
  });

  it('FR-11.4 participant context menu "Hide class"', () => {
    fire(headerBox('p-price').querySelector('rect')!, 'contextmenu');
    fire(menuItem('hide-class')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'class', classKey: 'src/services/price-calculator.ts#PriceCalculator', className: 'PriceCalculator' } });
  });

  it('FR-4.1 / FR-4.2 Show callers requests callers, renders the reply and re-roots on choice', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('show-callers')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestCallers', messageId: 'root' });
    expect(view.root.querySelector('.callers-panel')!.textContent).toContain('Searching');
    bridge.send({ type: 'callers', messageId: 'root', callers: mockCallers });
    const items = view.root.querySelectorAll('.caller-item');
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toContain('ReplayJob.run');
    expect(items[1].textContent).toContain('replay-job.ts:42');
    expect(items[1].textContent).toContain('await this.controller.placeOrder');
    fire(items[1], 'click');
    expect(bridge.last()).toEqual({ type: 'reroot', messageId: 'root', callerId: 'c2' });
    expect(view.root.querySelector('.callers-panel')).toBeNull();
  });

  it('FR-4.4 callers in test files are hidden; "Include tests" shows them tagged and persists the option', () => {
    const withTest = [...mockCallers, { ...mockCallers[1], id: 'c3', preview: 'await controller.placeOrder(req, res); // spec', inTest: true }];
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('show-callers')!, 'click');
    bridge.send({ type: 'callers', messageId: 'root', callers: withTest });
    expect(view.root.querySelectorAll('.caller-item')).toHaveLength(2);
    const toggle = view.root.querySelector('.callers-tests')!;
    expect(toggle.textContent).toContain('Include tests (1)');
    const box = toggle.querySelector('input')! as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.checked = true;
    fire(box, 'change');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'includeTestCallers', value: true });
    const items = view.root.querySelectorAll('.caller-item');
    expect(items).toHaveLength(3);
    expect(items[2].classList.contains('in-test')).toBe(true);
    expect(items[2].querySelector('.caller-tag')!.textContent).toBe('test');
    expect(items[0].querySelector('.caller-tag')).toBeNull();
    // the host answers with a render carrying the option: the panel stays open
    const on = cloneSequence();
    on.options.includeTestCallers = true;
    bridge.send({ type: 'render', diagram: on });
    expect(view.root.querySelectorAll('.caller-item')).toHaveLength(3);
    expect((view.root.querySelector('.callers-tests input') as HTMLInputElement).checked).toBe(true);
    // only test callers: says so, and offers the toggle
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('show-callers')!, 'click');
    bridge.send({ type: 'callers', messageId: 'root', callers: [withTest[2]] });
    expect(view.root.querySelector('.callers-panel')!.textContent).toContain('No callers outside tests');
    expect(view.root.querySelector('.callers-tests')).not.toBeNull();
  });

  it('FR-4.5 a caller that passes the method as an argument is tagged "passed"', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('show-callers')!, 'click');
    bridge.send({ type: 'callers', messageId: 'root', callers: [{ ...mockCallers[0], passed: true }] });
    const tag = view.root.querySelector('.caller-item .caller-tag')!;
    expect(tag.textContent).toBe('passed');
  });

  it('FR-4.1 empty callers reply says so', () => {
    fire(msgEl(`${P}/0:findById`).querySelector('.msg-hit')!, 'contextmenu');
    fire(menuItem('show-callers')!, 'click');
    bridge.send({ type: 'callers', messageId: `${P}/0:findById`, callers: [] });
    expect(view.root.querySelector('.callers-panel')!.textContent).toContain('No callers found');
  });

  it('FR-8.2 / FR-8.3 choose implementation and back to interface', () => {
    fire(msgEl(`${P}/4:charge`).querySelector('.msg-hit')!, 'contextmenu');
    const sub = menuItem('choose-impl')!;
    fire(sub, 'click');
    expect(sub.classList.contains('open')).toBe(true);
    expect(menuItem('back-to-interface')!.classList.contains('disabled')).toBe(true);
    fire(menuItem('impl:src/infrastructure/paypal-gateway.ts#PaypalGateway')!, 'click');
    expect(bridge.last()).toEqual({ type: 'selectImplementation', messageId: `${P}/4:charge`, classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway' });

    diagram.messages.find((m) => m.id === `${P}/4:charge`)!.polymorphic!.selectedKey = 'src/infrastructure/paypal-gateway.ts#PaypalGateway';
    bridge.send({ type: 'render', diagram });
    fire(msgEl(`${P}/4:charge`).querySelector('.msg-hit')!, 'contextmenu');
    expect(menuItem('impl:src/infrastructure/paypal-gateway.ts#PaypalGateway')!.classList.contains('checked')).toBe(true);
    fire(menuItem('back-to-interface')!, 'click');
    expect(bridge.last()).toEqual({ type: 'revertImplementation', messageId: `${P}/4:charge` });
  });

  it('FR-8.6 the implementation the container binds comes first, marked with where; the others are not bound here', () => {
    const charge = diagram.messages.find((m) => m.id === `${P}/4:charge`)!;
    const at = { file: '/p/app/Providers/AppServiceProvider.php', start: { line: 173, character: 8 }, end: { line: 173, character: 60 } };
    charge.polymorphic!.bound = { classKey: 'src/infrastructure/paypal-gateway.ts#PaypalGateway', at, contextual: true };
    bridge.send({ type: 'render', diagram });
    fire(msgEl(`${P}/4:charge`).querySelector('[data-action="implementations"]')!, 'click');
    const impls = [...view.root.querySelectorAll('.popup-layer [data-menu-id^="impl:"]')].map((e) => e.textContent);
    expect(impls).toEqual(['PaypalGatewaybound · AppServiceProvider.php:174', 'StripeGatewaynot bound here']);
    fire(menuItem('open-binding')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: at });
  });

  it('FR-8.2 the polymorphic badge opens the implementation menu; interface participants offer it too', () => {
    fire(msgEl(`${P}/4:charge`).querySelector('[data-action="implementations"]')!, 'click');
    expect(menuItem('impl:src/infrastructure/stripe-gateway.ts#StripeGateway')).not.toBeNull();
    fire(document.body, 'mousedown');
    fire(headerBox('p-gw').querySelector('rect')!, 'contextmenu');
    fire(menuItem('impl:src/infrastructure/stripe-gateway.ts#StripeGateway')!, 'click');
    expect(bridge.last()).toEqual({ type: 'selectImplementation', messageId: `${P}/4:charge`, classKey: 'src/infrastructure/stripe-gateway.ts#StripeGateway' });
  });

  it('FR-14.2 View ▾ options post setOption with the inverted value; the menu stays open', () => {
    fire(viewOptionRow(view, 'showArguments'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showArguments', value: false });
    fire(viewOptionRow(view, 'showLibraryCalls'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showLibraryCalls', value: false });
    fire(viewOptionRow(view, 'followCursor'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'followCursor', value: true });
    expect(viewOptionRow(view, 'showArguments').getAttribute('role')).toBe('menuitemcheckbox');
    expect(viewOptionRow(view, 'showArguments').getAttribute('aria-checked')).toBe('true');
    expect(viewOptionRow(view, 'followCursor').getAttribute('aria-checked')).toBe('false');
  });

  it('FR-14.1 / FR-4.3 / FR-3.3 / FR-12.1 toolbar commands', () => {
    expect(view.toolbar.button('back').disabled).toBe(false);
    expect(view.toolbar.button('forward').disabled).toBe(true);
    for (const cmd of ['back', 'smartExpand', 'classDiagram'] as const) fire(view.toolbar.button(cmd), 'click');
    // Collapse all is in the ▾ menu next to ✦
    fire(view.toolbar.button('expandMenu'), 'click');
    fire(menuItem('collapse-all')!, 'click');
    expect(bridge.posted).toEqual([{ type: 'back' }, { type: 'smartExpand' }, { type: 'openClassDiagram' }, { type: 'collapseAll' }]);
  });

  it('FR-11.3 hidden filters dropdown lists counts and unhides one or all', () => {
    expect(view.toolbar.button('hidden').textContent).toContain('3');
    fire(view.toolbar.button('hidden'), 'click');
    const row = menuItem('unhide:f1')!;
    expect(row.textContent).toContain('All calls to log');
    expect(row.textContent).toContain('3 hidden');
    expect(menuItem('unhide:f3')!.textContent).toContain('2 hidden');
    fire(menuItem('unhide:f2')!, 'click');
    expect(bridge.last()).toEqual({ type: 'unhide', filterId: 'f2' });
    fire(view.toolbar.button('hidden'), 'click');
    fire(menuItem('unhide-all')!, 'click');
    expect(bridge.last()).toEqual({ type: 'unhideAll' });
  });

  it('FR-10.1 dragging a participant posts savePositions for the root (Tidy up after expanding off)', () => {
    diagram.options.autoTidy = false;
    bridge.send({ type: 'render', diagram });
    const before = view.geometry!.participants.find((p) => p.id === 'p-svc')!.x;
    fire(headerBox('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 180 });
    fire(document.body, 'mouseup', { clientX: 180 });
    const save = bridge.last();
    expect(save?.type).toBe('savePositions');
    if (save?.type !== 'savePositions') return;
    expect(save.rootKey).toBe(diagram.root.key);
    expect(save.positions['p-svc']).toBe(Math.round(before + 80));
    expect(Object.keys(save.positions).sort()).toEqual(diagram.participants.map((p) => p.id).sort());
    expect(view.geometry!.participants.find((p) => p.id === 'p-svc')!.x).toBe(Math.round(before + 80));
    // a drag is not a click
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
  });

  it('FR-10.8 re-render of the same root keeps local positions when the host sends none', () => {
    fire(headerBox('p-svc').querySelector('rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 150 });
    fire(document.body, 'mouseup');
    const x = view.geometry!.participants.find((p) => p.id === 'p-svc')!.x;
    bridge.send({ type: 'render', diagram });
    expect(view.geometry!.participants.find((p) => p.id === 'p-svc')!.x).toBe(x);
    bridge.send({ type: 'render', diagram, positions: { 'p-svc': 999 } });
    expect(view.geometry!.participants.find((p) => p.id === 'p-svc')!.x).toBe(999);
  });

  it('FR-10.2 Tidy up re-lays out compactly and saves positions', () => {
    const wide = view.geometry!.width;
    // Tidy up now is in View ▾ (and the canvas menu)
    fire(view.toolbar.button('view'), 'click');
    fire(menuItem('view:tidy')!, 'click');
    const save = bridge.last();
    expect(save?.type).toBe('savePositions');
    expect(view.geometry!.width).toBeLessThanOrEqual(wide);
  });
});
