// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, startSequenceView, type SequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge, viewOptionRow } from './helpers';

let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;

/** The mock flow zoomed to layers, as the core sends it (ids unchanged, lifelines per layer). */
function zoomed(): SequenceDiagram {
  const d = cloneSequence();
  d.options.layerZoom = true;
  d.participants = [
    { id: 'layer:Presentation', classKey: 'layer:Presentation', className: 'Presentation', label: 'Presentation', kind: 'module', stereotypes: [], layer: 'Presentation', namespace: '', groupId: 'layer:Presentation', objects: [{ id: 'p-ctrl', label: ':OrderController', classKey: 'src/controllers/order-controller.ts#OrderController', className: 'OrderController', declaration: range('controllers/order-controller.ts', 8, 13, 15) }] },
    { id: 'layer:Application', classKey: 'layer:Application', className: 'Application', label: 'Application', kind: 'module', stereotypes: ['2 objects'], layer: 'Application', namespace: '', groupId: 'layer:Application', objects: [{ id: 'p-svc', label: ':OrderService', classKey: 'src/services/order-service.ts#OrderService', className: 'OrderService' }, { id: 'p-price', label: 'PriceCalculator', classKey: 'src/services/price-calculator.ts#PriceCalculator', className: 'PriceCalculator' }] },
    { id: 'layer:Infrastructure', classKey: 'layer:Infrastructure', className: 'Infrastructure', label: 'Infrastructure', kind: 'module', stereotypes: [], layer: 'Infrastructure', namespace: '', groupId: 'layer:Infrastructure', objects: [{ id: 'p-repo1', label: 'primary:CustomerRepository', classKey: 'src/infrastructure/customer-repository.ts#CustomerRepository', className: 'CustomerRepository' }] },
  ];
  d.groups = [
    { id: 'layer:Presentation', label: 'Presentation', layer: 'Presentation', namespace: '' },
    { id: 'layer:Application', label: 'Application', layer: 'Application', namespace: '' },
    { id: 'layer:Infrastructure', label: 'Infrastructure', layer: 'Infrastructure', namespace: '' },
  ];
  const root = d.messages.find((m) => m.id === 'root')!;
  const place = d.messages.find((m) => m.id === 'root/1:placeOrder')!;
  const find = d.messages.find((m) => m.id === 'root/1:placeOrder/0:findById')!;
  root.to = 'layer:Presentation';
  root.folded = { count: 2, names: ['OrderController.validate', 'OrderController.checkItems'], expandable: 1, calls: [{ id: 'root/0:validate', name: 'OrderController.validate', participant: 'p-ctrl' }, { id: 'root/0:validate/0:checkItems', name: 'OrderController.checkItems', participant: 'p-ctrl' }] };
  place.from = 'layer:Presentation';
  place.to = 'layer:Application';
  place.folded = { count: 1, names: ['PriceCalculator.total'], expandable: 0, calls: [{ id: 'root/1:placeOrder/2:total', name: 'PriceCalculator.total', participant: 'p-price' }] };
  find.from = 'layer:Application';
  find.to = 'layer:Infrastructure';
  d.messages = [root, place, find];
  delete d.fragments;
  return d;
}

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
});

describe('FR-28 layer zoom in the sequence view', () => {
  it('FR-28.6 ◫ Layers on the toolbar switches the session option; the button shows the mode and View ▾ has the same row', () => {
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const btn = view.toolbar.button('layerZoom');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fire(btn, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: true });
    bridge.send({ type: 'render', diagram: zoomed() });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('active')).toBe(true);
    expect(viewOptionRow(view, 'layerZoom').getAttribute('aria-checked')).toBe('true');
    fire(btn, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: false });
  });

  it('FR-28.1 one box per layer with its band; the tooltip lists the objects; the menu offers them and no class to hide', () => {
    bridge.send({ type: 'render', diagram: zoomed() });
    const labels = [...view.header.querySelectorAll('.p-label')].map((t) => t.textContent);
    expect(labels).toEqual(['Presentation', 'Application', 'Infrastructure']);
    expect([...view.header.querySelectorAll('.group-label')].map((t) => t.textContent)).toEqual(['Presentation', 'Application', 'Infrastructure']);
    expect([...view.header.querySelectorAll('.p-stereo')].map((t) => t.textContent)).toEqual(['«2 objects»']);
    const app = view.header.querySelector('[data-participant-id="layer:Application"]')!;
    expect(app.querySelector(':scope > title')!.textContent).toContain('2 objects of the flow');
    expect(app.querySelector(':scope > title')!.textContent).toContain(':OrderService\nPriceCalculator');
    fire(app, 'contextmenu', { clientX: 10, clientY: 10 });
    const items = [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    expect(items).toEqual(['open-layer', 'object:0', 'object:1', 'find-messages', 'show-objects']);
    expect(view.root.querySelector('.popup-layer [data-menu-id="object:0"]')!.textContent).toContain(':OrderService');
    // FR-28.8 an object of the list is pulled out onto its own lifeline
    fire(view.root.querySelector('.popup-layer [data-menu-id="object:0"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: true });
    fire(app, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(view.root.querySelector('.popup-layer [data-menu-id="show-objects"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: false });
  });

  it('FR-28.1 a layer with many objects of one class lists one row per class (×n) that pulls out all of them; the tooltip groups them too', () => {
    const d = zoomed();
    const result = (i: number, label = ':Outcome<T>') => ({ id: `p-res${i}`, label, classKey: 'src/domain/outcome.cs#Outcome`1', className: 'Outcome<T>' });
    const app = d.participants.find((p) => p.id === 'layer:Application')!;
    app.objects = [result(0), app.objects![0], result(1), result(2, 'error:Outcome<T>'), app.objects![1]];
    bridge.send({ type: 'render', diagram: d });
    const box = view.header.querySelector('[data-participant-id="layer:Application"]')!;
    expect(box.querySelector(':scope > title')!.textContent).toContain('5 objects of the flow');
    expect(box.querySelector(':scope > title')!.textContent).toContain('Outcome<T> ×3\n:OrderService\nPriceCalculator');
    fire(box, 'contextmenu', { clientX: 10, clientY: 10 });
    const rows = [...view.root.querySelectorAll('.popup-layer [data-menu-id^="object:"]')] as HTMLElement[];
    expect(rows.map((r) => r.textContent)).toEqual(['Outcome<T> ×3pull out all', ':OrderServicepull out', 'PriceCalculatorpull out']);
    expect(rows[0].title).toBe('3 objects of Outcome<T>:\n:Outcome<T>\nerror:Outcome<T>');
    fire(rows[0], 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'src/domain/outcome.cs#Outcome`1', open: true });
  });

  it('FR-28.2 a crossing call shows +n for the calls folded inside the layer; the hover card and the pill list them; ⊕ while some are collapsed', () => {
    bridge.send({ type: 'render', diagram: zoomed() });
    const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
    const place = msgEl('root/1:placeOrder');
    expect(place.querySelector('.seg-folded')!.textContent).toBe('+1');
    expect(place.querySelector('.folded-badge title')!.textContent).toBe('1 call inside the layer, folded:\nPriceCalculator.total');
    expect(place.querySelector('.folded-badge')!.classList.contains('has-collapsed')).toBe(false);
    const root = msgEl('root');
    expect(root.querySelector('.seg-folded')!.textContent).toBe('+2');
    expect(root.querySelector('.folded-badge')!.classList.contains('has-collapsed')).toBe(true);
    expect(root.querySelector('.folded-badge title')!.textContent).toContain('1 still collapsed — ⊕ opens them');
    // no pill on a call that folds nothing
    expect(msgEl('root/1:placeOrder/0:findById').querySelector('.seg-folded')).toBeNull();
    const card = messageCard(zoomed().messages[0], document).map((n) => n.textContent);
    expect(card).toContain('Folded inside the layer (2)');
    expect(card).toContain('OrderController.validate');
    expect(card).toContain('1 of them still collapsed — ⊕ opens them');
  });
});

describe('FR-28.8 an object pulled out of its layer, in the sequence view', () => {
  it('sits beside its layer’s lifeline in the same band; ⊖ / the menu put it back by its id', () => {
    const d = zoomed();
    const plain = cloneSequence();
    const svc = { ...plain.participants.find((p) => p.id === 'p-svc')!, groupId: 'layer:Application', inLayer: { key: 'layer:Application', name: 'Application', alone: true as const } };
    const app = d.participants[1];
    app.objects = app.objects!.filter((o) => o.id !== 'p-svc');
    app.stereotypes = [];
    d.participants = [d.participants[0], app, svc, d.participants[2]];
    d.options.openObjects = ['p-svc'];
    const place = d.messages.find((m) => m.id === 'root/1:placeOrder')!;
    place.to = 'p-svc';
    const total = { ...plain.messages.find((m) => m.id === 'root/1:placeOrder/2:total')!, from: 'p-svc', to: 'layer:Application' };
    d.messages = [d.messages[0], place, d.messages[2], total];
    bridge.send({ type: 'render', diagram: d });
    expect([...view.header.querySelectorAll('.p-label')].map((t) => t.textContent)).toEqual(['Presentation', 'Application', ':OrderService', 'Infrastructure']);
    expect([...view.header.querySelectorAll('.group-label')].map((t) => t.textContent)).toEqual(['Presentation', 'Application', 'Infrastructure']);
    const box = view.header.querySelector('[data-participant-id="p-svc"]')!;
    const fold = box.querySelector('[data-action="fold-layer"]')!;
    expect(fold.getAttribute('data-layer')).toBe('p-svc');
    expect(fold.querySelector('title')!.textContent).toContain('put it back');
    bridge.posted.length = 0;
    fire(fold, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: false });
    fire(box, 'contextmenu', { clientX: 10, clientY: 10 });
    const first = view.root.querySelector('.popup-layer [data-menu-id]')!;
    expect(first.textContent).toContain('Put it back into Application');
    fire(first, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: false });
  });
});

describe('FR-23.6 Find while zoomed: the calls folded into layers', () => {
  const input = () => view.root.querySelector('.find-input') as HTMLInputElement;
  const type = (q: string) => {
    input().value = q;
    fire(input(), 'input');
  };

  it('lists the folded matches under the query, says so in the count, marks the drawn call on hover and pulls the object out on click', () => {
    bridge.send({ type: 'render', diagram: zoomed() });
    view.find.open();
    type('total');
    expect(view.root.querySelector('.find-count')!.textContent).toBe('None drawn · 1 folded');
    const rows = [...view.root.querySelectorAll('.find-folded-item')];
    expect(rows.map((r) => r.textContent)).toEqual(['PriceCalculator.totalin placeOrder · Application']);
    const place = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === 'root/1:placeOrder')!;
    fire(rows[0], 'mouseenter');
    expect(place.classList.contains('find-hit')).toBe(true);
    expect(view.header.querySelector('[data-participant-id="layer:Application"]')!.classList.contains('find-hit')).toBe(true);
    fire(rows[0], 'mouseleave');
    expect(place.classList.contains('find-hit')).toBe(false);
    bridge.posted.length = 0;
    fire(rows[0], 'click');
    expect(bridge.posted.some((m) => m.type === 'setLayerOpen' && m.layer === 'p-price' && m.open)).toBe(true);
    // a drawn match too: the count counts the drawn ones, the folded list stays
    type('validate');
    expect(view.root.querySelector('.find-count')!.textContent).toBe('None drawn · 1 folded');
    type('findById');
    expect(view.root.querySelector('.find-count')!.textContent).toBe('1 of 1');
    expect(view.root.querySelector('.find-folded-item')).toBeNull();
  });
});

describe('FR-28.4 issues in the zoomed sequence view', () => {
  it('a host’s copy of an issue (folded calls, class keys) is shown through the diagram’s own copy: the drawn call and the lifeline marked', () => {
    const d = zoomed();
    const drawn = { id: 'f1', kind: 'io-in-loop' as const, title: 'I/O in a loop: PriceCalculator.total', messageIds: ['root/1:placeOrder'], classKeys: ['layer:Application'] };
    d.findings = [drawn];
    bridge.send({ type: 'render', diagram: d });
    // as the ⌂ Design issues list / the class view send it: the folded call, the class
    bridge.send({ type: 'highlight', messageId: 'root/1:placeOrder/2:total', messageIds: ['root/1:placeOrder/2:total'], finding: { ...drawn, messageIds: ['root/1:placeOrder/2:total'], classKeys: ['src/services/price-calculator.ts#PriceCalculator'] } });
    const place = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === 'root/1:placeOrder')!;
    expect(place.classList.contains('highlighted')).toBe(true);
    expect(view.header.querySelector('[data-participant-id="layer:Application"]')!.classList.contains('finding-hl')).toBe(true);
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(view.root.textContent).toContain('I/O in a loop'); // the card
  });
});

describe('FR-28 layer zoom in the class view', () => {
  const diagram: ClassDiagram = {
    classes: [
      { key: 'layer:Application', name: 'Application', kind: 'module', stereotypes: [], layer: 'Application', namespace: '', methods: [{ name: 'OrderService', key: 'src/services/order-service.ts#OrderService', isStatic: false, signature: 'OrderService', declaration: range('services/order-service.ts', 12, 13, 12) }], group: { path: 'layer:Application', classes: 1, zoom: true } },
      { key: 'layer:Infrastructure', name: 'Infrastructure', kind: 'module', stereotypes: [], layer: 'Infrastructure', namespace: '', methods: [{ name: 'CustomerRepository', isStatic: false, signature: 'CustomerRepository' }, { name: 'StripeGateway', isStatic: false, signature: 'StripeGateway' }], group: { path: 'layer:Infrastructure', classes: 2, zoom: true, violations: 1 }, sideEffects: { kinds: ['db', 'http'], evidence: ['DB: pg', 'HTTP: stripe'] } },
    ],
    relations: [{ id: 'rel:layer:Application→layer:Infrastructure', kind: 'dependency', from: 'layer:Application', to: 'layer:Infrastructure', label: '2', count: 2, calls: [{ messageId: 'm1', label: 'OrderService → CustomerRepository (customers)' }, { messageId: 'm2', label: 'OrderService → StripeGateway' }] }],
    layers: ['Application', 'Infrastructure'],
  };

  it('FR-28.5 one package per layer: the classes listed, a class row goes to the class, no class menu (FR-28.7: ⊕ and the menu open the layer in place)', () => {
    const b = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), b, { measureText: estimateTextWidth, engine: 'dagre' });
    b.send({ type: 'render', diagram });
    const names = [...cv.root.querySelectorAll('.pkg-name')].map((t) => t.textContent);
    expect(names).toEqual(['Application', 'Infrastructure']);
    expect(cv.root.querySelector('.pkg-expand[data-open-package]')).toBeNull(); // nothing to open as a folder
    // FR-17.2 the I/O of the layer's classes, as a pill on the package
    const infra = [...cv.root.querySelectorAll('.class-node')].find((n) => n.getAttribute('data-class-key') === 'layer:Infrastructure')!;
    expect(infra.querySelector('.class-io')!.textContent).toContain('DB');
    expect(infra.querySelector('.class-io')!.textContent).toContain('HTTP');
    fire(cv.root.querySelector('[data-open-layer="layer:Application"]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: true });
    expect([...cv.root.querySelectorAll('.pkg-class')].map((t) => t.childNodes[0].textContent)).toEqual(['OrderService', 'CustomerRepository', 'StripeGateway']);
    const app = [...cv.root.querySelectorAll('.class-node')].find((n) => n.getAttribute('data-class-key') === 'layer:Application')!;
    expect(app.querySelector(':scope > title')!.textContent).toContain('1 class of the flow');
    b.posted.length = 0;
    fire(app.querySelector('[data-member="OrderService"]')!, 'click');
    expect(b.last()).toMatchObject({ type: 'navigate', range: range('services/order-service.ts', 12, 13, 12) });
    // the layer lanes apply zoomed too: each package in its layer's lane (an opened layer: its classes there)
    expect([...cv.root.querySelectorAll('.lane-label')].map((t) => t.textContent)).toEqual(['Application', 'Infrastructure']);
    fire(app, 'contextmenu', { clientX: 10, clientY: 10 });
    expect([...cv.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'))).toEqual(['open-layer', 'class:0']);
    // FR-28.8 a class row of the menu pulls that class out (its key travels on the row)
    fire(cv.root.querySelector('.popup-layer [data-menu-id="class:0"]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'src/services/order-service.ts#OrderService', open: true });
    fire(app, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(cv.root.querySelector('.popup-layer [data-menu-id="open-layer"]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: true });
  });

  it('FR-24.11 / FR-28.5 a layer package carries the branch’s Δn / NEW tag merged from its classes, as the lifeline does', () => {
    const b = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), b, { measureText: estimateTextWidth, engine: 'dagre' });
    const [app, infra] = diagram.classes;
    b.send({
      type: 'render',
      diagram: {
        ...diagram,
        classes: [
          { ...app, change: { kind: 'new', members: [] } },
          { ...infra, change: { kind: 'changed', members: [{ kind: 'method', name: 'findById', change: 'changed', text: 'findById(id): Customer' }, { kind: 'field', name: 'client', change: 'added', text: 'client: Stripe' }] } },
        ],
      },
    });
    const node = (key: string) => [...cv.root.querySelectorAll('.class-node')].find((n) => n.getAttribute('data-class-key') === key)!;
    expect(node('layer:Application').querySelector('.change-tag')!.textContent).toContain('NEW');
    expect(node('layer:Infrastructure').querySelector('.change-tag')!.textContent).toContain('Δ2');
    expect(node('layer:Infrastructure').querySelector('.change-tag title')!.textContent).toContain('findById(id): Customer');
  });

  it('FR-28.9 Fold all layers in the class menus while more than the class’s own layer is open', () => {
    const b = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), b, { measureText: estimateTextWidth, engine: 'dagre' });
    const cls = (key: string, layer: string) => ({ key, name: key.replace(/^.*#/, ''), kind: 'class' as const, stereotypes: [], layer, namespace: 'src', methods: [{ name: 'run', isStatic: false, signature: 'run()' }], inLayer: { key: `layer:${layer}`, name: layer } });
    const menuOf = (key: string) => {
      fire([...cv.root.querySelectorAll('.class-node')].find((n) => n.getAttribute('data-class-key') === key)!, 'contextmenu', { clientX: 10, clientY: 10 });
      return [...cv.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    };
    const one: ClassDiagram = { classes: [cls('src/a.ts#OrderService', 'Application'), diagram.classes[1]], relations: [], layers: ['Application', 'Infrastructure'] };
    b.send({ type: 'render', diagram: one });
    expect(menuOf('src/a.ts#OrderService')).not.toContain('fold-all-layers');
    expect(menuOf('layer:Infrastructure')).toContain('fold-all-layers');
    const two: ClassDiagram = { classes: [cls('src/a.ts#OrderService', 'Application'), cls('src/b.ts#Db', 'Infrastructure')], relations: [], layers: ['Application', 'Infrastructure'] };
    b.send({ type: 'render', diagram: two });
    expect(menuOf('src/a.ts#OrderService')).toContain('fold-all-layers');
    fire(cv.root.querySelector('.popup-layer [data-menu-id="fold-all-layers"]')!, 'click');
    expect(b.last()).toEqual({ type: 'foldLayers' });
  });

  it('FR-28.7 a class of an opened layer carries ⊖ ‹layer› (click / menu fold it again); the other layers stay packages', () => {
    const b = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), b, { measureText: estimateTextWidth, engine: 'dagre' });
    const opened: ClassDiagram = {
      classes: [
        { key: 'src/services/order-service.ts#OrderService', name: 'OrderService', kind: 'class', stereotypes: ['service'], layer: 'Application', namespace: 'src/services', methods: [{ name: 'placeOrder', isStatic: false, signature: 'placeOrder()' }], inLayer: { key: 'layer:Application', name: 'Application' } },
        diagram.classes[1],
      ],
      relations: [{ id: 'rel:src/services/order-service.ts#OrderService→layer:Infrastructure', kind: 'dependency', from: 'src/services/order-service.ts#OrderService', to: 'layer:Infrastructure', count: 2, label: '2' }],
      layers: ['Application', 'Infrastructure'],
    };
    b.send({ type: 'render', diagram: opened });
    const svc = [...cv.root.querySelectorAll('.class-node')].find((n) => n.getAttribute('data-class-key') === 'src/services/order-service.ts#OrderService')!;
    // ⊖ on the class puts this class back; the lane's ⊖ folds the whole layer
    expect(svc.querySelector('[data-fold-layer="src/services/order-service.ts#OrderService"] title')!.textContent).toContain('put this class back');
    expect(cv.root.querySelector('.lane-fold')!.getAttribute('data-fold-layer')).toBe('layer:Application');
    // the box leaves room for the ⊖ beside the centred name
    const plainWidth = Number(cv.root.querySelector('.class-node[data-class-key="layer:Infrastructure"] .cls-box')!.getAttribute('width'));
    const openedWidth = Number(svc.querySelector('.cls-box')!.getAttribute('width'));
    expect(openedWidth).toBeGreaterThanOrEqual(Math.ceil(estimateTextWidth('OrderService', 'className')) + 28 + 2 * 10);
    expect(plainWidth).toBeGreaterThan(0);
    expect(svc.querySelector('.cls-member')).not.toBeNull(); // drawn as a class, with its methods
    expect(cv.root.querySelectorAll('.pkg-name').length).toBe(1);
    fire(svc.querySelector('[data-fold-layer]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'src/services/order-service.ts#OrderService', open: false });
    fire(cv.root.querySelector('.lane-fold')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
    fire(svc, 'contextmenu', { clientX: 10, clientY: 10 });
    const items = [...cv.root.querySelectorAll('.popup-layer [data-menu-id]')];
    expect(items.slice(0, 2).map((e) => e.getAttribute('data-menu-id'))).toEqual(['fold-object', 'fold-layer']);
    fire(items[0], 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'src/services/order-service.ts#OrderService', open: false });
    fire(svc, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(cv.root.querySelector('.popup-layer [data-menu-id="fold-layer"]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
  });
});

describe('FR-28.7 a layer opened in place, in the sequence view', () => {
  /** The zoomed mock with Application opened: its two objects back on their own lifelines, the other layers folded. */
  function opened(): SequenceDiagram {
    const d = zoomed();
    const plain = cloneSequence();
    const svc = { ...plain.participants.find((p) => p.id === 'p-svc')!, inLayer: { key: 'layer:Application', name: 'Application' } };
    const price = { ...plain.participants.find((p) => p.id === 'p-price')!, inLayer: { key: 'layer:Application', name: 'Application' } };
    d.participants = [d.participants[0], svc, price, d.participants[2]];
    d.groups = [d.groups[0], plain.groups.find((g) => g.id === 'g-app')!, d.groups[2]];
    d.options.openLayers = ['layer:Application'];
    const place = d.messages.find((m) => m.id === 'root/1:placeOrder')!;
    place.to = 'p-svc';
    delete place.folded;
    const total = { ...plain.messages.find((m) => m.id === 'root/1:placeOrder/2:total')!, from: 'p-svc', to: 'p-price' };
    const find = d.messages.find((m) => m.id === 'root/1:placeOrder/0:findById')!;
    find.from = 'p-svc';
    d.messages = [d.messages[0], place, find, total];
    return d;
  }

  it('FR-28.7 ⊕ on a layer box opens it in place; its objects carry ⊖ ‹layer›, which folds it again; the menus offer both', () => {
    bridge.send({ type: 'render', diagram: zoomed() });
    const app = view.header.querySelector('[data-participant-id="layer:Application"]')!;
    fire(app.querySelector('[data-action="open-layer"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: true });
    bridge.send({ type: 'render', diagram: opened() });
    expect([...view.header.querySelectorAll('.p-label')].map((t) => t.textContent)).toEqual(['Presentation', ':OrderService', 'PriceCalculator', 'Infrastructure']);
    expect([...view.header.querySelectorAll('.group-label')].map((t) => t.textContent)).toEqual(['Presentation', 'Application · src/services', 'Infrastructure']);
    const svc = view.header.querySelector('[data-participant-id="p-svc"]')!;
    // ⊖ on an object puts this object back (the same as on a pulled-out one); the band's ⊖ folds the whole layer
    expect(svc.querySelector('[data-action="fold-layer"] title')!.textContent).toContain('put this object back');
    expect(svc.querySelector('[data-action="fold-layer"]')!.getAttribute('data-layer')).toBe('p-svc');
    const band = view.header.querySelector('[data-group-id="g-app"] .band-fold')!;
    expect(band.getAttribute('data-layer')).toBe('layer:Application');
    expect(band.querySelector('title')!.textContent).toBe('Fold Application: one lifeline for its 2 objects');
    expect(view.header.querySelector('[data-group-id="g-pres"] .band-fold, [data-group-id="g-infra"] .band-fold')).toBeNull();
    expect(view.header.querySelector('[data-participant-id="layer:Presentation"] [data-action="open-layer"]')).not.toBeNull();
    bridge.posted.length = 0;
    fire(svc.querySelector('[data-action="fold-layer"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: false });
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false); // the tag is not a click on the object
    fire(band, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
    fire(svc, 'contextmenu', { clientX: 10, clientY: 10 });
    const items = [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    expect(items.slice(0, 2)).toEqual(['fold-object', 'fold-layer']);
    expect(items).toContain('hide-class'); // an opened object is an object again
    fire(view.root.querySelector('.popup-layer [data-menu-id="fold-layer"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
  });

  it('FR-28.9 Fold all layers in the right-click menus while more than the layer at hand is open; ◫ says what its click does (no ▾)', () => {
    const menuIds = () => [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    const item = (id: string) => view.root.querySelector<HTMLElement>(`.popup-layer [data-menu-id="${id}"]`)!;
    const zoom = view.toolbar.button('layerZoom');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(zoom.title).toMatch(/^Fold all layers/);
    expect([zoom.querySelector('.tb-label')!.textContent, zoom.getAttribute('aria-label')]).toEqual(['Fold layers', 'Fold layers']);
    expect(view.root.querySelector('[data-cmd="layerMenu"]')).toBeNull();
    bridge.send({ type: 'render', diagram: zoomed() });
    expect(zoom.title).toMatch(/^Open all layers/);
    expect([zoom.querySelector('.tb-label')!.textContent, zoom.getAttribute('aria-label')]).toEqual(['Open layers', 'Open layers']);
    // nothing open: a layer's menu has no Fold all
    fire(view.header.querySelector('[data-participant-id="layer:Presentation"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuIds()).not.toContain('fold-all-layers');
    expect(item('show-objects').textContent).toContain('◫ Open layers');
    fire(item('show-objects'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: false });
    // a folded layer's menu offers it while another is open; an object of the only open layer has its own Fold
    bridge.send({ type: 'render', diagram: opened() });
    fire(view.header.querySelector('[data-participant-id="layer:Presentation"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuIds()).toContain('fold-all-layers');
    expect(item('fold-all-layers').textContent).toContain('1 open');
    fire(item('fold-all-layers'), 'click');
    expect(bridge.last()).toEqual({ type: 'foldLayers' });
    fire(view.header.querySelector('[data-participant-id="p-svc"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuIds()).not.toContain('fold-all-layers');
  });
});

describe('FR-28.11 folding a layer from the object view', () => {
  const FOLD: Record<string, { key: string; name: string }> = {
    'g-pres': { key: 'layer:Presentation', name: 'Presentation' },
    'g-app': { key: 'layer:Application', name: 'Application' },
    'g-dom': { key: 'layer:Domain', name: 'Domain' },
    'g-infra': { key: 'layer:Infrastructure', name: 'Infrastructure' },
    'g-ext': { key: 'layer::libraries', name: 'Libraries' },
  };
  /** The object view as the core sends it: every band names the layer its ⊖ folds, every object the layer it folds into. */
  function objectView(): SequenceDiagram {
    const d = cloneSequence();
    d.groups = d.groups.map((g) => ({ ...g, fold: FOLD[g.id] }));
    d.participants = d.participants.map((p) => (FOLD[p.groupId] ? { ...p, layerFold: FOLD[p.groupId] } : p));
    return d;
  }
  /** Infrastructure folded in the object view: one lifeline in its band's place, the other objects as they are. */
  function infraFolded(): SequenceDiagram {
    const d = objectView();
    const objs = d.participants.filter((p) => p.groupId === 'g-infra');
    const lifeline = { id: 'layer:Infrastructure', classKey: 'layer:Infrastructure', className: 'Infrastructure', label: 'Infrastructure', kind: 'module' as const, stereotypes: ['2 objects'], layer: 'Infrastructure', namespace: '', groupId: 'layer:Infrastructure', objects: objs.map((p) => ({ id: p.id, label: p.label, classKey: p.classKey, className: p.className })) };
    const at = d.participants.indexOf(objs[0]);
    d.participants = [...d.participants.slice(0, at), lifeline, ...d.participants.filter((p, i) => i > at && p.groupId !== 'g-infra')];
    d.groups = d.groups.map((g) => (g.id === 'g-infra' ? { id: 'layer:Infrastructure', label: 'Infrastructure', layer: 'Infrastructure', namespace: '' } : g));
    d.options.foldedLayers = ['layer:Infrastructure'];
    for (const m of d.messages) if (m.to === 'p-repo1' || m.to === 'p-repo2') m.to = 'layer:Infrastructure';
    return d;
  }
  const menuIds = () => [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
  const item = (id: string) => view.root.querySelector<HTMLElement>(`.popup-layer [data-menu-id="${id}"]`)!;

  it('FR-28.11 every band carries ⊖ that folds its layer; each object a ⊖ that folds it alone; an object’s menu offers both', () => {
    bridge.send({ type: 'render', diagram: objectView() });
    const folds = [...view.header.querySelectorAll('.band-fold')];
    expect(folds.map((f) => f.getAttribute('data-layer'))).toEqual(['layer:Presentation', 'layer:Application', 'layer:Domain', 'layer:Infrastructure', 'layer::libraries']);
    expect(folds[1].querySelector('title')!.textContent).toBe('Fold Application: one lifeline for its 3 objects');
    expect(folds.every((f) => f.classList.contains('quiet'))).toBe(true); // shown while the band is hovered
    fire(folds[3], 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Infrastructure', open: false });
    // each object's own ⊖, also shown only while its box is hovered, folds just that object
    const own = [...view.header.querySelectorAll('.layer-open:not(.band-fold)')];
    expect(own.length).toBe(view.header.querySelectorAll('.participant').length);
    expect(own.every((f) => f.classList.contains('obj-fold') && f.classList.contains('quiet'))).toBe(true);
    const svcFold = view.header.querySelector('[data-participant-id="p-svc"] .obj-fold')!;
    expect(svcFold.querySelector('title')!.textContent).toBe("Fold into Application — the layer's other objects stay out");
    fire(svcFold, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: false });
    expect(view.header.querySelector('[data-participant-id="p-svc"] > title')!.textContent).toContain('in Application (⊖ folds this object into it');
    fire(view.header.querySelector('[data-participant-id="p-svc"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuIds().slice(0, 3)).toEqual(['fold-object', 'fold-layer', 'fold-all-layers']);
    expect(item('fold-object').textContent).toContain('Fold into Application');
    fire(item('fold-object'), 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'p-svc', open: false });
    fire(view.header.querySelector('[data-participant-id="p-svc"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(item('fold-layer').textContent).toContain('Fold Application');
    fire(item('fold-layer'), 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
  });

  it('FR-28.11 ◫ Layers is not pressed in the object view (its click folds every layer); a folded layer sits in its band’s place, its menu opens all layers, ⊕ opens it', () => {
    bridge.send({ type: 'render', diagram: infraFolded() });
    const zoom = view.toolbar.button('layerZoom');
    expect(zoom.getAttribute('aria-pressed')).toBe('false');
    expect(zoom.title).toMatch(/^Fold all layers/);
    // the folded layer sits where its band stood: between Domain and the libraries
    expect([...view.header.querySelectorAll('[data-group-id]')].map((t) => t.getAttribute('data-group-id'))).toEqual(['g-pres', 'g-app', 'g-dom', 'layer:Infrastructure', 'g-ext']);
    expect(view.header.querySelector('[data-group-id="layer:Infrastructure"] .band-fold')).toBeNull();
    fire(view.header.querySelector('[data-participant-id="layer:Infrastructure"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuIds()).toContain('fold-all-layers');
    expect(item('fold-all-layers').textContent).toContain('4 open');
    // ◫ is already off: no hint pointing at it
    expect(item('show-objects').textContent).toBe('Open all layers');
    fire(item('show-objects'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: false });
    fire(zoom, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'layerZoom', value: true });
    fire(view.header.querySelector('[data-participant-id="layer:Infrastructure"] [data-action="open-layer"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Infrastructure', open: true });
  });

  it('FR-28.11 the class view: each lane’s ⊖ folds its layer, a class’s ⊖ (on hover) and menu fold it alone; the class box keeps its width', () => {
    const b = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), b, { measureText: estimateTextWidth, engine: 'dagre' });
    const svcKey = 'src/services/order-service.ts#OrderService';
    const cd: ClassDiagram = {
      classes: [
        { key: svcKey, name: 'OrderService', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/services', methods: [{ name: 'placeOrder', isStatic: false, signature: 'placeOrder()' }], layerFold: { key: 'layer:Application', name: 'Application' } },
        { key: 'src/infrastructure/repo.ts#Repo', name: 'Repo', kind: 'class', stereotypes: [], layer: 'Infrastructure', namespace: 'src/infrastructure', methods: [], layerFold: { key: 'layer:Infrastructure', name: 'Infrastructure' } },
      ],
      relations: [{ id: 'r1', kind: 'dependency', from: svcKey, to: 'src/infrastructure/repo.ts#Repo' }],
      layers: ['Application', 'Infrastructure'],
    };
    b.send({ type: 'render', diagram: cd });
    expect([...cv.root.querySelectorAll('.lane-fold')].map((f) => f.getAttribute('data-fold-layer'))).toEqual(['layer:Application', 'layer:Infrastructure']);
    const svc = cv.root.querySelector(`.class-node[data-class-key="${svcKey}"]`)!;
    // its own ⊖ while hovered: over the corner, the box no wider
    const own = svc.querySelector('.obj-fold')!;
    expect(own.classList.contains('quiet')).toBe(true);
    expect(own.getAttribute('data-fold-layer')).toBe(svcKey);
    fire(own, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: svcKey, open: false });
    expect(Number(svc.querySelector('.cls-box')!.getAttribute('width'))).toBeLessThan(Math.ceil(estimateTextWidth('OrderService', 'className')) + 28 + 2 * 10);
    fire(cv.root.querySelector('.lane-fold')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
    fire(svc, 'contextmenu', { clientX: 10, clientY: 10 });
    const items = [...cv.root.querySelectorAll('.popup-layer [data-menu-id]')];
    expect(items.slice(0, 3).map((e) => e.getAttribute('data-menu-id'))).toEqual(['fold-object', 'fold-layer', 'fold-all-layers']);
    fire(items[0], 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: svcKey, open: false });
    fire(svc, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(cv.root.querySelector('.popup-layer [data-menu-id="fold-layer"]')!, 'click');
    expect(b.last()).toEqual({ type: 'setLayerOpen', layer: 'layer:Application', open: false });
    // a class only used as a type has no objects to fold: no ⊖, no Fold into
    b.send({ type: 'render', diagram: { ...cd, classes: cd.classes.map((c) => ({ ...c, usedOnly: true })) } });
    const used = cv.root.querySelector(`.class-node[data-class-key="${svcKey}"]`)!;
    expect(used.querySelector('.obj-fold')).toBeNull();
    fire(used, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(cv.root.querySelector('.popup-layer [data-menu-id="fold-object"]')).toBeNull();
  });
});
