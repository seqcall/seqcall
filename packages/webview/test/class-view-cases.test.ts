// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS } from '../src/dom';
import dagre from '@dagrejs/dagre';
import type { ClassDiagram, ClassNode, ClassRelation, ClassViewToHost, Finding, HostToClassView, SourceRange } from '@seqcall/protocol';
import { CLASS_EMPTY_TEXT, startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { SHARE_TITLE } from '../src/sequence/share-state';
import { mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

/** Class view cases: host messages in odd orders, unusual diagrams, the less common clicks and menus. */
const at = (line: number, file = '/p/src/shop/order.ts'): SourceRange => ({ file, start: { line, character: 4 }, end: { line, character: 20 } });
const cls = (key: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name: key.replace(/^.*#/, ''), kind: 'class', stereotypes: [], namespace: 'src/shop', methods: [], ...extra });

const item = (root: HTMLElement, id: string) => root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const menuIds = (root: HTMLElement) => [...root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'));

function setup(diagram?: ClassDiagram, extra: Partial<Extract<HostToClassView, { type: 'render' }>> = {}) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  if (diagram) bridge.send({ type: 'render', diagram, ...extra });
  bridge.posted.length = 0;
  const node = (key: string) => view.canvas.querySelector(`.class-node[data-class-key="${key}"]`) as SVGElement;
  const rel = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"] .rel-hit`) as SVGElement;
  const posted = () => bridge.posted.filter((m) => m.type !== 'log');
  return { bridge, view, node, rel, posted };
}

const click = (el: Element, x = 30, y = 30) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
const contextMenu = (el: Element) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  el.dispatchEvent(e);
  return e;
};

/** Exceptions in event handlers (jsdom reports them on window, the test would not see them otherwise). */
let errors: unknown[] = [];
const onError = (e: ErrorEvent) => void errors.push(e.error ?? e.message);
beforeEach(() => {
  errors = [];
  window.addEventListener('error', onError);
});

afterEach(() => {
  window.removeEventListener('error', onError);
  expect(errors).toEqual([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
});

describe('class view: host messages and state', () => {
  it('FR-12.5 without an injected measure the view measures text on a canvas (as in a browser)', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/126');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ font: '', measureText: (t: string) => ({ width: t.length * 20 }) }) as unknown as CanvasRenderingContext2D);
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    const { view: estimated } = setup(mockClassDiagram);
    const wide = view.geometry!.nodes.map((n) => n.width);
    estimated.geometry!.nodes.forEach((n, i) => expect(wide[i]).toBeGreaterThan(n.width));
  });

  it('FR-12.1 an empty message without a reason shows the default text', () => {
    const { bridge, view } = setup(mockClassDiagram);
    bridge.send({ type: 'empty', reason: '' });
    expect(view.root.querySelector('.placeholder')!.hasAttribute('hidden')).toBe(false);
    expect(view.root.querySelector('.placeholder-title')!.textContent).toBe(CLASS_EMPTY_TEXT);
    expect(view.canvas.querySelector('svg')).toBeNull();
  });

  it('FR-12.1 a flow without classes says so', () => {
    const { view } = setup({ classes: [], relations: [] });
    expect(view.root.querySelector('.placeholder')!.hasAttribute('hidden')).toBe(false);
    expect(view.root.querySelector('.placeholder-title')!.textContent).toBe('No classes in the current sequence diagram');
  });

  it('FR-25.2 a state report without an error shows no card', () => {
    const { bridge, view } = setup(mockClassDiagram);
    bridge.send({ type: 'stateReport' });
    expect(view.root.querySelector('.state-card')).toBeNull();
    bridge.send({ type: 'stateReport', error: 'not a Seqcall diagram' });
    expect(view.root.querySelector('.state-card')!.textContent).toContain('not a Seqcall diagram');
  });

  it('FR-23.4 the host opens the find bar with a query (from the sequence diagram)', () => {
    const { bridge, view } = setup(mockClassDiagram);
    bridge.send({ type: 'openFind', query: 'charge' });
    expect((view.root.querySelector('.find-bar') as HTMLElement).hidden).toBe(false);
    expect((view.root.querySelector('.find-input') as HTMLInputElement).value).toBe('charge');
    expect([...view.canvas.querySelectorAll('.class-node.find-hit')].map((e) => e.getAttribute('data-class-key'))).toEqual(['PaymentGateway', 'StripeGateway']);
  });

  it('FR-7.12 Move to layer from the class diagram: the scopes the host counted fill the card', () => {
    const order = cls('src/shop/order.ts#Order', { layer: 'Domain' });
    const { bridge, view, node } = setup({ classes: [order], relations: [] }, { layerChoices: ['Application', 'Domain', 'Infrastructure'] });
    contextMenu(node(order.key));
    item(view.root, 'layer:Infrastructure')!.click();
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: order.key, className: 'Order' });
    bridge.send({ type: 'layerScopes', classKey: order.key, scopes: [{ kind: 'file', glob: 'src/shop/order.ts', files: 1 }, { kind: 'folder', glob: 'src/shop/**', files: 4 }] });
    const rows = [...view.root.querySelectorAll('.popup-layer .layer-scope-card .ls-row')].map((r) => r.textContent);
    expect(rows).toEqual(['this file order.ts', 'folder src/shop/ — 4 files']);
  });

  it('FR-12.1 a state with zoom but no diagram (a panel restored before any flow): placeholder, the zoom applies to the first diagram', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    bridge.setState({ zoom: 1.5, positions: {} });
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(view.canvas.querySelector('svg')).toBeNull();
    expect(view.root.querySelector('.placeholder-title')!.textContent).toBe(CLASS_EMPTY_TEXT);
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    expect(Number(view.canvas.querySelector('svg')!.getAttribute('width'))).toBeCloseTo(view.geometry!.width * 1.5, 0);
  });

  it('FR-14.2 View ▾ before any diagram: Layers off and another edge style are kept for the first diagram', () => {
    const { bridge, view } = setup();
    fire(view.root.querySelector('[data-cmd="view"]')!, 'click');
    item(view.root, 'view:lanes')!.click();
    item(view.root, 'view:edges:straight')!.click();
    expect(view.canvas.querySelector('svg')).toBeNull();
    expect(bridge.getState<{ lanes: boolean; edgeStyle: string }>()).toMatchObject({ lanes: false, lanesChosen: true, edgeStyle: 'straight' });
    bridge.send({ type: 'render', diagram: { ...mockClassDiagram, classes: mockClassDiagram.classes.map((c) => ({ ...c, layer: 'Application' })) } });
    expect(view.canvas.querySelector('.lane-band')).toBeNull(); // on by default
    expect((view.root.querySelector('[data-cmd="view"]') as HTMLElement).title).toContain('Changed: Layers off, Straight edges');
  });

  it('FR-12.5 a layout that fell back is reported once per diagram, not on every redraw', () => {
    vi.spyOn(dagre, 'layout').mockImplementation(() => {
      throw new Error('Not possible to find intersection inside of the rectangle');
    });
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    view.relayout();
    view.toggleMethods('OrderController');
    const errors = bridge.posted.filter((m) => m.type === 'log' && m.level === 'error');
    expect(errors).toHaveLength(1);
    expect(view.canvas.querySelectorAll('.class-node')).toHaveLength(mockClassDiagram.classes.length);
  });

  it('FR-14.5 Fit without a diagram keeps the zoom; Fit with one fits the width, never below 60 %', () => {
    const { bridge, view } = setup();
    view.fit();
    expect(view.zoom).toBe(1);
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: view.geometry!.width / 2 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: view.geometry!.height });
    view.scroll.scrollLeft = 120;
    const fit = () => fire(view.zoomControls.element.querySelector('[data-cmd="zoomFit"]')!, 'click');
    fit();
    // half the width would be 50 %: unreadable, 60 % and scroll
    expect(view.zoom).toBe(0.6);
    expect(view.scroll.scrollLeft).toBe(0);
    // a low, wide window: the width decides, not the height (it was 25 %)
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: view.geometry!.width * 0.8 });
    Object.defineProperty(view.scroll, 'clientHeight', { configurable: true, value: view.geometry!.height / 4 });
    fit();
    expect(view.zoom).toBeCloseTo(0.8);
  });

  it('FR-14.5 − zooms out, 100% resets; 100% at 100% leaves the saved state alone', () => {
    const { bridge, view } = setup(mockClassDiagram);
    const btn = (cmd: string) => view.zoomControls.element.querySelector(`[data-cmd="${cmd}"]`) as HTMLElement;
    const writes = vi.spyOn(bridge, 'setState');
    fire(btn('zoomReset'), 'click');
    expect(writes).not.toHaveBeenCalled();
    fire(btn('zoomOut'), 'click');
    expect(view.zoom).toBeLessThan(1);
    fire(btn('zoomReset'), 'click');
    expect(view.zoom).toBe(1);
    expect(writes).toHaveBeenCalledTimes(2);
  });
});

describe('class view: hover, drag and clicks', () => {
  const diagram: ClassDiagram = {
    classes: [cls('A', { declaration: at(1) }), cls('B', { declaration: at(2) }), cls('C', { declaration: at(3) })],
    relations: [
      { id: 'ab', kind: 'dependency', from: 'A', to: 'B', calls: [{ messageId: 'root/0:b', label: 'run → b', callSite: at(10) }] },
      { id: 'bc', kind: 'dependency', from: 'B', to: 'C', calls: [{ messageId: 'root/1:c', label: 'run → c', callSite: at(11) }] },
    ],
  };

  it('FR-12.6 hovering a relation focuses it and its two classes; the same class twice keeps its focus', () => {
    const { view, node, rel } = setup(diagram);
    fire(rel('ab'), 'mouseover');
    const focused = () => [...view.canvas.querySelectorAll('.focused')].map((e) => e.getAttribute('data-class-key') ?? e.getAttribute('data-relation-id')).sort();
    expect(focused()).toEqual(['A', 'B', 'ab']);
    fire(node('C'), 'mouseover');
    fire(node('C'), 'mouseover');
    expect(focused()).toEqual(['B', 'C', 'bc']);
  });

  it('FR-12.7 while a class is dragged, hovering another does not refocus; the click after the drop does not navigate', () => {
    const { bridge, view, node } = setup(diagram);
    fire(node('A'), 'mouseover');
    fire(node('A'), 'mousedown', { clientX: 50, clientY: 50 });
    fire(document.body, 'mousemove', { clientX: 120, clientY: 90 });
    fire(node('C'), 'mouseover');
    expect(node('C').classList.contains('focused')).toBe(false);
    fire(document.body, 'mouseup');
    click(node('A'));
    expect(bridge.posted.filter((m) => m.type === 'navigate')).toEqual([]);
  });

  it('FR-12.7 a right button press on a class starts no drag', () => {
    const { bridge, view, node } = setup(diagram);
    const x = view.geometry!.nodes.find((n) => n.key === 'A')!.x;
    fire(node('A'), 'mousedown', { button: 2, clientX: 50, clientY: 50 });
    fire(document.body, 'mousemove', { clientX: 150, clientY: 90 });
    fire(document.body, 'mouseup');
    expect(view.geometry!.nodes.find((n) => n.key === 'A')!.x).toBe(x);
    expect(bridge.getState<{ positions: object }>()!.positions).toEqual({});
  });

  it('FR-12.5 a click on the empty view before any diagram does nothing', () => {
    const { bridge, view } = setup();
    click(view.root.querySelector('.placeholder')!);
    expect(bridge.posted).toEqual([]);
  });

  it('FR-12.4 a right-click outside the classes opens no menu and keeps the browser menu', () => {
    const { view } = setup(diagram);
    const e = contextMenu(view.canvas.querySelector('svg')!);
    expect(e.defaultPrevented).toBe(false);
    expect(view.root.querySelector('.popup-layer .menu-item')).toBeNull();
  });

  it('FR-12.13 a method row with neither its own nor a class declaration only shows its calls', () => {
    const plain = cls('P', { methods: [{ name: 'run', isStatic: false, signature: 'run()', calls: [{ messageId: 'root', label: 'run' }] }] });
    const { bridge, view } = setup({ classes: [plain], relations: [] });
    click(view.canvas.querySelector('[data-member="run"]')!);
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root'] }]);
  });

  it('FR-12.13 Focus on a method with several calls: a call without a call site has no line in the submenu', () => {
    const m = { name: 'run', isStatic: false, signature: 'run()', calls: [{ messageId: 'root/0:run', label: 'Shop → run', callSite: at(41) }, { messageId: 'root/1:run', label: 'Cart → run' }] };
    const { view } = setup({ classes: [cls('P', { methods: [m] })], relations: [] });
    contextMenu(view.canvas.querySelector('[data-member="run"]')!);
    fire(item(view.root, 'focus-method')!, 'mouseenter');
    fire(item(view.root, 'focus-method')!, 'click');
    expect([...view.root.querySelectorAll('.popup-layer [data-menu-id^="focus-call:"]')].map((e) => e.textContent)).toEqual(['Shop → run · line 42', 'Cart → run']);
  });

  it('FR-12.11 ▴ fewer folds the methods of a class again', () => {
    const methods = Array.from({ length: 8 }, (_, i) => ({ name: `step${i}`, isStatic: false, signature: `step${i}()` }));
    const { view } = setup({ classes: [cls('P', { methods })], relations: [] });
    const rows = () => view.canvas.querySelectorAll('[data-member]').length;
    const folded = rows();
    click(view.canvas.querySelector('[data-more-toggle="P"]')!);
    expect(rows()).toBe(8);
    click(view.canvas.querySelector('[data-more-toggle="P"]')!);
    expect(rows()).toBe(folded);
  });

  it('FR-24.11 a changed member that runs in the flow: its calls are shown and the class opens side by side at it', () => {
    const changed = cls('P', { methods: [{ name: 'pay', isStatic: false, signature: 'pay()', diff: 'changed', calls: [{ messageId: 'root/2:pay', label: 'pay' }] }] });
    const { bridge, view } = setup({ classes: [changed], relations: [] });
    click(view.canvas.querySelector('[data-member-diff]')!);
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/2:pay'] }, { type: 'openDiff', classKey: 'P', member: 'pay' }]);
  });
});

describe('class view: relation clicks without the usual evidence', () => {
  const two = (r: ClassRelation, a: Partial<ClassNode> = {}) => setup({ classes: [cls('A', a), cls('B')], relations: [r] });

  it('FR-12.14 a dependency whose calls are all collapsed asks the host to reveal them', () => {
    const { bridge, rel } = two({ id: 'r', kind: 'dependency', from: 'A', to: 'B' }, { declaration: at(5) });
    click(rel('r'));
    expect(bridge.posted).toEqual([{ type: 'revealRelation', from: 'A', to: 'B', fallback: at(5) }]);
  });

  it('FR-12.9 inheritance from a class without a declaration goes nowhere', () => {
    const { bridge, rel } = two({ id: 'r', kind: 'generalization', from: 'A', to: 'B' });
    click(rel('r'));
    expect(bridge.posted).toEqual([]);
  });

  it('FR-12.9 one call without a call site is only highlighted', () => {
    const { bridge, rel } = two({ id: 'r', kind: 'dependency', from: 'A', to: 'B', calls: [{ messageId: 'root/0:b', label: 'run → b' }] });
    click(rel('r'));
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:b'] }]);
  });

  it('FR-12.9 several calls: a row without a call site has no location and only narrows the highlight', () => {
    const { bridge, view, rel } = two({ id: 'r', kind: 'dependency', from: 'A', to: 'B', calls: [{ messageId: 'root/0:b', label: 'run → b', callSite: at(9) }, { messageId: 'root/1:b', label: 'stop → b' }] });
    click(rel('r'));
    const row = item(view.root, 'relation-call:1')!;
    expect(row.textContent).toBe('stop → b');
    bridge.posted.length = 0;
    row.click();
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/1:b'] }]);
  });

  it('FR-12.12 a use relation without listed methods does nothing', () => {
    const { bridge, view, rel } = two({ id: 'r', kind: 'use', from: 'A', to: 'B' });
    click(rel('r'));
    expect(bridge.posted).toEqual([]);
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
  });

  it('FR-12.12 several methods use the type: the list, a pick highlights its call (when drawn) and jumps', () => {
    const uses = [
      { method: 'Shop.checkout', range: at(20), messageId: 'root/0:checkout' },
      { method: 'Shop.quote', range: at(30) },
    ];
    const { bridge, view, rel } = two({ id: 'r', kind: 'use', from: 'A', to: 'B', uses });
    click(rel('r'));
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:checkout'] }]);
    expect(view.root.querySelector('.popup-layer .menu-item.disabled')!.textContent).toBe('2 methods reference the type');
    bridge.posted.length = 0;
    item(view.root, 'relation-use:1')!.click();
    expect(bridge.posted).toEqual([{ type: 'navigate', range: at(30) }]);
    click(rel('r'));
    bridge.posted.length = 0;
    item(view.root, 'relation-use:0')!.click();
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:checkout'] }, { type: 'navigate', range: at(20) }]);
  });

  it('FR-12.12 one method that is not drawn: straight to its code', () => {
    const { bridge, rel } = two({ id: 'r', kind: 'use', from: 'A', to: 'B', uses: [{ method: 'Shop.quote', range: at(30) }] });
    click(rel('r'));
    expect(bridge.posted).toEqual([{ type: 'navigate', range: at(30) }]);
  });
});

describe('class view: Share ▾ image (FR-25)', () => {
  const share = (view: { root: HTMLElement }, id: string) => {
    fire(view.root.querySelector('[data-cmd="image"]')!, 'click');
    item(view.root, id)!.click();
  };
  /** jsdom has no image decoding and no canvas: a fake that gives the PNG blob. */
  function fakeCanvas() {
    vi.stubGlobal('Image', class { src = ''; decode = async () => undefined; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: () => undefined }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => cb(new Blob(['png'])));
  }
  function fakeDownload() {
    const files: string[] = [];
    URL.createObjectURL = () => 'blob:1';
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push(this.download);
    });
    return files;
  }

  it('FR-25 VS Code saves through the host: SVG and PNG (base64), named after the root class', async () => {
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    fakeCanvas();
    const { bridge, view } = setup(mockClassDiagram, { rootClassKey: 'OrderController' });
    share(view, 'image:svg');
    expect(bridge.last()).toMatchObject({ type: 'saveImage', format: 'svg', name: 'OrderController-classes.svg' });
    share(view, 'image:png');
    await vi.waitFor(() => expect(bridge.last()).toEqual({ type: 'saveImage', format: 'png', name: 'OrderController-classes.png', data: btoa('png') }));
  });

  it('FR-25.1 a browser downloads the file; without a drawn root class the name says “classes”', async () => {
    fakeCanvas();
    const files = fakeDownload();
    const { bridge, view } = setup(mockClassDiagram);
    share(view, 'image:svg');
    share(view, 'image:png');
    await vi.waitFor(() => expect(files).toEqual(['classes-classes.svg', 'classes-classes.png']));
    expect(bridge.posted).toEqual([]);
  });

  it('FR-25.1 Copy as image: the button says whether the clipboard took it, then goes back', async () => {
    fakeCanvas();
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, unknown>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async () => undefined } });
    const { view } = setup(mockClassDiagram);
    const btn = view.root.querySelector('[data-cmd="image"]') as HTMLElement;
    share(view, 'image:copy');
    await vi.waitFor(() => expect(btn.title).toBe('Copied ✓'));
    expect(btn.dataset.flash).toBe('Copied ✓');
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    share(view, 'image:copy');
    // only promises to settle (no timer runs: the flash must not end early)
    for (let i = 0; i < 50 && btn.title !== 'Copy not allowed here — use Save as PNG'; i++) await vi.advanceTimersByTimeAsync(0);
    expect(btn.title).toBe('Copy not allowed here — use Save as PNG');
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(btn.title).toBe('Copy not allowed here — use Save as PNG');
    vi.advanceTimersByTime(1);
    expect(btn.title).toBe(SHARE_TITLE);
    expect(btn.dataset.flash).toBeUndefined();
  });

  it('FR-25 nothing to save: no diagram, or a diagram without classes', async () => {
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    const { bridge, view } = setup();
    share(view, 'image:svg');
    expect(item(view.root, 'state:copy')).toBeNull(); // the menu closed
    bridge.send({ type: 'render', diagram: { classes: [], relations: [] } });
    bridge.posted.length = 0;
    share(view, 'image:svg');
    share(view, 'image:png');
    share(view, 'image:copy');
    await new Promise((r) => setTimeout(r, 10));
    expect(bridge.posted).toEqual([]);
  });

  it('FR-25.2 the host’s answer flashes on Share for 2.5 s; the paste card’s Cancel closes it', () => {
    vi.useFakeTimers();
    const { bridge, view } = setup(mockClassDiagram);
    const btn = view.root.querySelector('[data-cmd="image"]') as HTMLElement;
    bridge.send({ type: 'diagramState', done: true, save: true });
    expect(btn.title).toBe('Saved ✓');
    expect(btn.dataset.flash).toBe('Saved ✓');
    vi.advanceTimersByTime(FLASH_MS);
    expect(btn.title).toBe(SHARE_TITLE);
    expect(btn.dataset.flash).toBeUndefined();
    fire(btn, 'click');
    item(view.root, 'state:open')!.click();
    fire(view.root.querySelector('.popup-layer [data-cmd="state-cancel"]')!, 'click');
    expect(view.root.querySelector('.popup-layer [data-cmd="state-cancel"]')).toBeNull();
    expect(bridge.posted).toEqual([]);
  });

  it('FR-25.2 without a diagram there is nothing to share as text', () => {
    const { view } = setup();
    fire(view.root.querySelector('[data-cmd="image"]')!, 'click');
    const copy = item(view.root, 'state:copy')!;
    expect(copy.classList.contains('disabled')).toBe(true);
    expect(copy.title).toBe('No diagram to share');
  });
});

describe('class view: issues, violations and their cards', () => {
  const svc = cls('src/shop/order-service.ts#OrderService', { layer: 'Application', declaration: at(3) });
  const repo = cls('src/shop/order-repo.ts#OrderRepo', { layer: 'Infrastructure', layerHint: { suggested: 'Domain', reasons: ['pure'], noMove: true } });
  const pick = (view: { root: HTMLElement }, id: string) => {
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    item(view.root, `finding:${id}`)!.click();
  };
  const card = (root: HTMLElement) => root.querySelector('.popup-layer .guide-card') as HTMLElement;
  const buttons = (root: HTMLElement) => [...card(root).querySelectorAll('.gc-btn')].map((b) => b.textContent);

  it('FR-12.16 a violating use relation: only its drawn methods are highlighted, nothing is revealed', () => {
    const r: ClassRelation = { id: 'u', kind: 'use', from: svc.key, to: repo.key, violation: 'Application → Infrastructure', uses: [{ method: 'OrderService.place', range: at(7), messageId: 'root/0:place' }, { method: 'OrderService.quote', range: at(8) }] };
    const { bridge, view, rel } = setup({ classes: [svc, repo], relations: [r] });
    click(rel('u'));
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:place'] }]);
    // FR-7.11 the hint says the file is in place: no Move for it
    expect(buttons(view.root)).toEqual(['Show in diagram', 'Adjust the rule', 'Copy as Markdown', 'Ask AI', 'Close']);
    expect(card(view.root).querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: OrderService (Application) → OrderRepo (Infrastructure)');
  });

  it('FR-12.16 the card’s Move asks where the misplaced class goes; Close closes it', () => {
    const moved = cls('src/shop/order-repo.ts#OrderRepo', { layer: 'Infrastructure', layerHint: { suggested: 'Domain', reasons: ['pure'] } });
    const r: ClassRelation = { id: 'd', kind: 'dependency', from: svc.key, to: moved.key, violation: 'Application → Infrastructure', calls: [{ messageId: 'root/0:find', label: 'find' }] };
    const { bridge, view, rel } = setup({ classes: [svc, moved], relations: [r] });
    click(rel('d'));
    const btn = (label: string) => [...card(view.root).querySelectorAll('.gc-btn')].find((b) => b.textContent === label) as HTMLElement;
    btn('Move OrderRepo to Domain').click();
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: moved.key, className: 'OrderRepo' });
    click(rel('d'));
    btn('Close').click();
    expect(card(view.root)).toBeNull();
  });

  it('FR-12.16 a violating use relation without drawn methods (or none listed) posts nothing', () => {
    for (const uses of [[{ method: 'OrderService.quote', range: at(8) }], undefined]) {
      const r: ClassRelation = { id: 'u', kind: 'use', from: svc.key, to: repo.key, violation: 'Application → Infrastructure', ...(uses ? { uses } : {}) };
      const { bridge, view, rel } = setup({ classes: [svc, repo], relations: [r] });
      click(rel('u'));
      expect(bridge.posted).toEqual([]);
      expect(card(view.root)).not.toBeNull();
    }
  });

  it('FR-12.16 a violating dependency without listed calls asks the host to reveal them', () => {
    const r: ClassRelation = { id: 'd', kind: 'dependency', from: svc.key, to: repo.key, violation: 'Application → Infrastructure' };
    const { bridge, rel } = setup({ classes: [svc, repo], relations: [r] });
    click(rel('d'));
    expect(bridge.posted).toEqual([{ type: 'revealRelation', from: svc.key, to: repo.key, fallback: at(3) }]);
  });

  it('FR-19.17 a layer violation picked from ⚠ whose class is not drawn: named by its key, without a reason line', () => {
    const r: ClassRelation = { id: 'd', kind: 'dependency', from: svc.key, to: 'src/billing/invoice.ts#Invoice', calls: [{ messageId: 'root/0:bill', label: 'bill' }] };
    const f: Finding = { id: 'v', kind: 'layer-violation', title: 'Layer violation: OrderService → Invoice', classKeys: [svc.key], relationIds: ['d'] };
    const { bridge, view } = setup({ classes: [svc], relations: [r], findings: [f] });
    pick(view, 'v');
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:bill'] }]);
    expect(card(view.root).querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: OrderService (Application) → Invoice');
    expect(card(view.root).querySelector('.gc-detail')).toBeNull();
  });

  it('FR-19.10 a design issue picked from ⚠: its classes outlined, its card; Show outlines again, Ignore writes the pattern', () => {
    const f: Finding = { id: 'g', kind: 'god-class', title: 'OrderService does too much', detail: '14 methods', classKeys: [svc.key], ignoreKey: 'OrderService' };
    const { bridge, view, node } = setup({ classes: [svc, repo], relations: [], findings: [f] });
    pick(view, 'g');
    expect(node(svc.key).classList.contains('finding-hl')).toBe(true);
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(buttons(view.root)).toEqual(['Show in diagram', 'Ignore OrderService', 'Copy as Markdown', 'Ask AI', 'Close']);
    click(view.canvas.querySelector('svg')!); // a click on the canvas ends the outline
    expect(node(svc.key).classList.contains('finding-hl')).toBe(false);
    const btn = (label: string) => [...card(view.root).querySelectorAll('.gc-btn')].find((b) => b.textContent === label) as HTMLElement;
    btn('Show in diagram').click();
    expect(node(svc.key).classList.contains('finding-hl')).toBe(true);
    btn('Ignore OrderService').click();
    expect(bridge.last()).toEqual({ type: 'ignoreFinding', pattern: 'OrderService' });
    expect(card(view.root)).toBeNull();
  });

  it('FR-19.20 an issue about nothing drawn (no classes, no relations) does not dim the diagram; Close closes it', () => {
    const f: Finding = { id: 'g', kind: 'io-in-loop', title: 'I/O in a loop' };
    const { view } = setup({ classes: [svc], relations: [], findings: [f] });
    pick(view, 'g');
    expect(card(view.root)).not.toBeNull();
    expect(view.root.classList.contains('evidence-dimmed')).toBe(false);
    ([...card(view.root).querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Show in diagram') as HTMLElement).click();
    expect(view.canvas.querySelectorAll('.finding-hl')).toHaveLength(0);
    ([...card(view.root).querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Close') as HTMLElement).click();
    expect(card(view.root)).toBeNull();
  });

  it('FR-19.10 with the find bar open the card sits below it', () => {
    const f: Finding = { id: 'g', kind: 'god-class', title: 'OrderService does too much', classKeys: [svc.key] };
    const { view } = setup({ classes: [svc], relations: [], findings: [f] });
    view.find.open();
    (view.root.querySelector('.find-bar') as HTMLElement).getBoundingClientRect = () => ({ bottom: 50 }) as DOMRect;
    pick(view, 'g');
    expect((view.root.querySelector('.popup-layer .guide-card') as HTMLElement).style.top).toBe('56px');
  });

  it('issues inside folded calls are named in ⚠ (the class diagram cannot expand: no action)', () => {
    const { view } = setup({ classes: [svc], relations: [], issuesBelow: { count: 2, titles: ['I/O in a loop', 'God class'] } });
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    const row = item(view.root, 'issues-below')!;
    expect(row.textContent).toBe('+ 2 more inside folded calls — Expand all shows them');
    expect(row.classList.contains('disabled')).toBe(true);
    expect(row.title).toBe('I/O in a loop\nGod class');
  });
});

describe('class view: I/O badges', () => {
  it('FR-17.2 a class whose file does I/O carries the pill on its header, the libraries in its tooltip', () => {
    const { view } = setup({ classes: [cls('src/shop/repo.ts#Repo', { sideEffects: { kinds: ['db', 'http'], evidence: ['pg', 'axios'] } }), cls('src/shop/calc.ts#Calc')], relations: [] });
    const pills = [...view.canvas.querySelectorAll('.class-io')];
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('[data-class-key]')!.getAttribute('data-class-key')).toBe('src/shop/repo.ts#Repo');
    expect(pills[0].textContent).toContain('DB');
  });
});

describe('class view: context menus', () => {
  it('FR-12.18 one private method: “Show 1 private / protected method”', () => {
    const c = cls('P', { methods: [{ name: 'run', isStatic: false, signature: 'run()' }, { name: 'check', isStatic: false, signature: 'check()', visibility: 'private' }] });
    const { view, node } = setup({ classes: [c], relations: [] });
    contextMenu(node('P'));
    expect(item(view.root, 'private-methods')!.textContent).toBe('Show 1 private / protected method');
  });

  it('FR-7.8 with “Why this layer?” the layer choices follow without another separator', () => {
    const c = cls('src/shop/order.ts#Order', { layer: 'Domain', layerReason: { rule: 'role-folder', text: 'role folder `domain/`', strength: 'strong', notApplied: [] } });
    const { view, node } = setup({ classes: [c], relations: [] }, { layerChoices: ['Application', 'Domain'] });
    contextMenu(node(c.key));
    const rows = [...view.root.querySelectorAll('.popup-layer .menu > *')].map((r) => r.getAttribute('data-menu-id') ?? (r.classList.contains('menu-separator') ? '—' : '?'));
    const why = rows.indexOf('why-layer');
    expect(rows[why - 1]).toBe('—');
    expect(rows[why + 1]).toBe('move-layer');
  });

  it('FR-7.8 the card lists the violations both ways; Ignore this hint and Move to layer… act from it', () => {
    const order = cls('src/shop/order.ts#Order', { layer: 'Domain', layerReason: { rule: 'role-folder', text: 'role folder `domain/`', strength: 'strong', notApplied: [] }, layerHint: { suggested: 'Infrastructure', reasons: ['does I/O'] } });
    const ctrl = cls('src/shop/order-controller.ts#OrderController', { layer: 'Presentation' });
    const repo = cls('src/shop/order-repo.ts#OrderRepo', { layer: 'Infrastructure' });
    const relations: ClassRelation[] = [
      { id: 'out', kind: 'dependency', from: order.key, to: repo.key, violation: 'Domain → Infrastructure' },
      { id: 'in', kind: 'dependency', from: ctrl.key, to: order.key, violation: 'Presentation → Domain' },
      { id: 'ok', kind: 'dependency', from: ctrl.key, to: repo.key },
      { id: 'other', kind: 'dependency', from: repo.key, to: ctrl.key, violation: 'Infrastructure → Presentation' },
      // classes the diagram does not draw (no box): named from the key
      { id: 'ghost-out', kind: 'dependency', from: order.key, to: 'src/billing/invoice.ts#Invoice', violation: 'Domain → Application' },
      { id: 'ghost-in', kind: 'dependency', from: 'src/web/api.ts#Api', to: order.key, violation: 'Presentation → Domain' },
    ];
    const { bridge, view, node } = setup({ classes: [order, ctrl, repo], relations }, { layerChoices: ['Presentation', 'Domain', 'Infrastructure'] });
    contextMenu(node(order.key));
    item(view.root, 'why-layer')!.click();
    const lr = () => view.root.querySelector('.popup-layer .layer-reason-card') as HTMLElement;
    expect([...lr().querySelectorAll('.lr-violation')].map((r) => r.textContent)).toEqual(['⚠depends on Infrastructure: OrderRepo', '⚠Presentation depends on it: OrderController', '⚠depends on another layer: Invoice', '⚠another layer depends on it: Api']);
    (lr().querySelector('[data-cmd="lr-ignore-hint"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'ignoreLayerHint', pattern: 'src/shop/order.ts' });
    expect(lr()).toBeNull();
    contextMenu(node(order.key));
    item(view.root, 'why-layer')!.click();
    (lr().querySelector('[data-cmd="lr-move"]') as HTMLElement).click();
    expect(menuIds(view.root)).toEqual(['layer:Presentation', 'layer:Infrastructure']);
    item(view.root, 'layer:Presentation')!.click();
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: order.key, className: 'Order' });
  });

  it('FR-12.7 Layers on while on keeps dragged classes where they are; the current edge style lays nothing out again', () => {
    const { bridge, view, node } = setup(mockClassDiagram);
    fire(node('Order'), 'mousedown', { clientX: 50, clientY: 50 });
    fire(document.body, 'mousemove', { clientX: 150, clientY: 90 });
    fire(document.body, 'mouseup');
    const dragged = bridge.getState<{ positions: Record<string, unknown> }>()!.positions;
    expect(Object.keys(dragged)).toEqual(['Order']);
    view.setLanes(true);
    expect(bridge.getState<{ positions: Record<string, unknown> }>()!.positions).toEqual(dragged);
    const layouts = vi.spyOn(dagre, 'layout');
    fire(view.root.querySelector('[data-cmd="view"]')!, 'click');
    item(view.root, 'view:edges:curved')!.click(); // the default
    expect(layouts).not.toHaveBeenCalled();
  });
});
