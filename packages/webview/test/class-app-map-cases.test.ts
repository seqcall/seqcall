// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMapLevel, AppMapViolation, ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

/** The codebase map (FR-26) in odd orders and shapes: scan states, stale picks, nested open packages, sparse data. */
const range = (file: string, line = 1) => ({ file, start: { line, character: 0 }, end: { line, character: 5 } });

const flow: ClassDiagram = { classes: [{ key: 'src/shop/cart.ts#Cart', name: 'Cart', kind: 'class', stereotypes: [], namespace: 'src/shop', methods: [] }], relations: [] };

const pkg = (path: string, classes: number, extra: object = {}) => ({ key: `package:${path}`, name: path.split('/').pop()!, kind: 'module' as const, stereotypes: [], namespace: path, methods: [], group: { path, classes, ...extra } });

const level = (over: Partial<AppMapLevel> = {}): AppMapLevel => ({
  path: 'src',
  crumbs: [{ label: 'Codebase', path: 'src' }],
  entryPoints: 1,
  failed: 0,
  truncated: 0,
  classes: 3,
  relations: 0,
  violations: 0,
  computedAt: '2026-10-09T10:00:00.000Z',
  diagram: { classes: [pkg('src/orders', 2), pkg('src/billing', 1)], relations: [] },
  ...over,
});

function setup(withFlow = true) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  if (withFlow) bridge.send({ type: 'render', diagram: flow });
  bridge.posted.length = 0;
  const posted = () => bridge.posted.filter((m) => m.type !== 'log');
  const title = () => view.root.querySelector('.placeholder-title')!.textContent;
  const bar = () => view.appBar.textContent;
  const node = (key: string) => view.root.querySelector(`.class-node[data-class-key="${key}"]`) as SVGElement | null;
  const item = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  const open = (l: AppMapLevel = level()) => {
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'done', level: l });
    bridge.posted.length = 0;
  };
  return { bridge, view, posted, title, bar, node, item, open };
}

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
  delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
});

describe('codebase map: the numbers in the bar (FR-26.5)', () => {
  it('FR-26.5 one entry point is named in the singular, in the bar and in its tooltip', () => {
    const { view, open } = setup();
    const stats = () => view.appBar.querySelector('.app-stats') as HTMLElement;
    open(level({ entryPoints: 1 }));
    expect(stats().textContent).toBe('1 entry point · 3 classes · 0 relations');
    expect(stats().title.split('\n')[0]).toMatch(/^The classes the flow of 1 entry point reaches \(tests excluded\)/);
    open(level({ entryPoints: 4 }));
    expect(stats().textContent).toBe('4 entry points · 3 classes · 0 relations');
    expect(stats().title.split('\n')[0]).toMatch(/^The classes the flows of 4 entry points reach \(tests excluded\)/);
  });
});

describe('codebase map: scan states (FR-26.5)', () => {
  it('FR-26.5 finding the entry points, an error without a message, a stopped scan', () => {
    const { bridge, view, title } = setup();
    view.enterApp('');
    expect(title()).toBe('Finding the entry points…');
    bridge.send({ type: 'appMap', state: 'error' });
    expect(title()).toBe('Codebase map: failed');
    bridge.send({ type: 'appMap', state: 'error', error: 'no project' });
    expect(title()).toBe('Codebase map: no project');
    bridge.send({ type: 'appMap', state: 'cancelled' });
    expect(title()).toBe('Scan stopped — ↻ Rescan continues where it stopped');
    expect(view.appBar.querySelector('[data-app-action="rescan"]')).not.toBeNull();
  });

  it('FR-26.5 a progress message without a count yet says 0; ■ Stop cancels the scan', () => {
    const { bridge, view, title, posted } = setup();
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'running', total: 3 });
    expect(title()).toBe('Following every entry point… 0 / 3');
    expect(view.appBar.querySelector('.app-stats')!.textContent).toBe('scanning 0 / 3…');
    fire(view.appBar.querySelector('[data-app-action="stop"]')!, 'click');
    expect(posted()).toEqual([{ type: 'requestAppMap', path: '' }, { type: 'cancelAppMap' }]);
  });

  it('FR-26.5 rescanning the folder on screen keeps the map; the bar counts the scan', () => {
    const { bridge, view, node, open } = setup();
    open();
    fire(view.appBar.querySelector('[data-app-action="rescan"]')!, 'click');
    bridge.send({ type: 'appMap', state: 'running', done: 1, total: 4 });
    expect(node('package:src/orders')).not.toBeNull();
    expect(view.placeholder.hidden).toBe(true);
    expect(view.appBar.querySelector('.app-stats')!.textContent).toBe('scanning 1 / 4…');
  });

  it('FR-26.5 the host asks for the map again while it is shown: the map stays until the answer', () => {
    const { bridge, view, node, posted, open } = setup();
    open();
    bridge.send({ type: 'showAppMap' });
    expect(posted()).toEqual([{ type: 'requestAppMap', path: 'src' }]);
    expect(node('package:src/orders')).not.toBeNull();
    expect(view.placeholder.hidden).toBe(true);
  });

  it('FR-26.5 a map message after leaving the map is ignored', () => {
    const { bridge, view, node, open } = setup();
    open();
    fire(view.root.querySelector('[data-cmd="app-map"]')!, 'click'); // ⛶ again: back to the flow
    expect(node('src/shop/cart.ts#Cart')).not.toBeNull();
    bridge.send({ type: 'appMap', state: 'done', level: level() });
    expect(node('src/shop/cart.ts#Cart')).not.toBeNull();
    expect(node('package:src/orders')).toBeNull();
    expect(view.appBar.hidden).toBe(true);
  });

  it('FR-26.5 ← Flow after a finished scan cancels nothing', () => {
    const { view, posted, open } = setup();
    open();
    fire(view.appBar.querySelector('[data-app-action="flow"]')!, 'click');
    expect(posted()).toEqual([]);
    view.leaveApp(); // not on the map any more: nothing
    expect(posted()).toEqual([]);
  });

  it('FR-26.5 a map without classes says so', () => {
    const { bridge, view, title } = setup();
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'done', level: level({ diagram: { classes: [], relations: [] } }) });
    expect(title()).toBe('No classes reached from the entry points');
  });
});

describe('codebase map: the flow behind it', () => {
  it('FR-26.5 opened from an empty panel: ← Flow shows the panel’s text again; an empty message meanwhile replaces it', () => {
    const { bridge, view, title } = setup(false);
    bridge.send({ type: 'empty', reason: 'Open a method to start' });
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'done', level: level() });
    expect(bridge.getState<{ diagram?: unknown; appPath?: string }>()).toMatchObject({ appPath: 'src' });
    expect(bridge.getState<{ diagram?: unknown }>()!.diagram).toBeUndefined();
    fire(view.appBar.querySelector('[data-app-action="flow"]')!, 'click');
    expect(title()).toBe('Open a method to start');
    view.enterApp('');
    bridge.send({ type: 'empty', reason: 'The file was closed' });
    fire(view.appBar.querySelector('[data-app-action="flow"]')!, 'click');
    expect(title()).toBe('The file was closed');
  });

  it('FR-26.8 a restored view asks for the map of the same selection', () => {
    const keys = ['http|GET /orders|src/orders/api.ts#Api.list'];
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    bridge.setState({ diagram: flow, positions: {}, appPath: 'src', appSelection: keys, appOpen: { src: ['src/orders'] } });
    startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(bridge.posted.filter((m) => m.type !== 'log')).toEqual([{ type: 'requestAppMap', path: 'src', open: ['src/orders'], entryPoints: keys }, { type: 'ready' }]);
  });

  it('FR-25.2 on the map the flow cannot be shared as text; FR-25 the image is named after the map’s folder', () => {
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    const { bridge, view, item, open } = setup();
    open(level({ path: '' }));
    fire(view.root.querySelector('[data-cmd="image"]')!, 'click');
    expect(item('state:copy')!.title).toBe('The codebase map cannot be shared as text: go ← Flow to share the flow');
    item('image:svg')!.click();
    expect(bridge.last()).toMatchObject({ type: 'saveImage', name: 'application.svg' });
    bridge.send({ type: 'appMap', state: 'done', level: level({ path: 'src/orders' }) });
    fire(view.root.querySelector('[data-cmd="image"]')!, 'click');
    item('image:svg')!.click();
    expect(bridge.last()).toMatchObject({ type: 'saveImage', name: 'application-orders.svg' });
  });

  it('FR-14.5 zooming while the next folder loads applies to that folder’s map', () => {
    const { bridge, view, open } = setup();
    open();
    view.enterApp('src/orders');
    expect(view.canvas.querySelector('svg')).toBeNull();
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true }));
    const z = view.zoom;
    expect(z).toBeGreaterThan(1);
    bridge.send({ type: 'appMap', state: 'done', level: level({ path: 'src/orders' }) });
    expect(Number(view.canvas.querySelector('svg')!.getAttribute('width'))).toBeCloseTo(view.geometry!.width * z, 0);
  });

  it('FR-19.17 while the first map is scanned ⛶ is pressed and the flow’s ⚠ is gone', () => {
    const { view } = setup();
    const issues = view.root.querySelector('[data-cmd="findings"]') as HTMLElement;
    expect(issues.hidden).toBe(false); // the flow's, muted at 0
    view.enterApp('');
    expect(issues.hidden).toBe(true);
    expect(view.root.querySelector('[data-cmd="app-map"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('codebase map: the bar (FR-26.5, FR-26.7, FR-26.8)', () => {
  it('FR-26.5 totals in the singular, failures and limits in the tooltip, a rescan count', () => {
    const { view, open } = setup();
    open(level({ entryPoints: 1, violations: 2, truncated: 1, failed: 1, rescanned: 1 }));
    expect(view.appBar.querySelector('.app-stats')!.textContent).toBe('1 entry point · 3 classes · 0 relations · 2 layer violations');
    const tip = (view.appBar.querySelector('.app-stats') as HTMLElement).title.split('\n');
    expect(tip.slice(1, 3)).toEqual(['1 flow hit the expand limit (some calls stayed folded).', '1 entry point could not be analysed.']);
    expect(tip[3]).toMatch(/ \(1 again now\); a saved file re-scans/);
    open(level({ entryPoints: 2, truncated: 2, failed: 3 }));
    expect((view.appBar.querySelector('.app-stats') as HTMLElement).title.split('\n').slice(1, 3)).toEqual(['2 flows hit the expand limit (some calls stayed folded).', '3 entry points could not be analysed.']);
  });

  it('FR-26.7 nested open packages: ⊖ all folds every one; ⊖ of a parent folds what is open inside it', () => {
    const { bridge, view, posted, open } = setup();
    const opened = level({ path: '', crumbs: [{ label: 'Codebase', path: '' }], open: ['src/orders', 'src/orders/sql', 'src/billing'] });
    open(opened);
    expect([...view.appBar.querySelectorAll('[data-app-fold]')].map((b) => b.textContent)).toEqual(['⊖ src/orders', '⊖ src/orders/sql', '⊖ src/billing', '⊖ all']);
    fire(view.appBar.querySelector('[data-app-fold="src/orders"]')!, 'click');
    expect(posted()).toEqual([{ type: 'requestAppMap', path: '', open: ['src/billing'] }]);
    bridge.send({ type: 'appMap', state: 'done', level: opened });
    bridge.posted.length = 0;
    fire(view.appBar.querySelector('[data-app-fold="*"]')!, 'click');
    expect(posted()).toEqual([{ type: 'requestAppMap', path: '' }]);
  });

  it('FR-26.8 a map of one entry point says so; ✕ All before the answer: opening or folding a package asks for the whole map', () => {
    const { bridge, view, posted } = setup();
    const keys = ['http|GET /orders|src/orders/api.ts#Api.list'];
    bridge.send({ type: 'showAppMap', entryPoints: keys });
    bridge.send({ type: 'appMap', state: 'done', level: level({ path: '', crumbs: [{ label: 'Codebase', path: '' }], open: ['src/billing'] }) });
    expect(view.root.querySelector('.app-selection')!.textContent).toBe('Map of 1 entry point ✕ All');
    fire(view.root.querySelector('[data-app-action="all"]')!, 'click');
    bridge.posted.length = 0;
    // the map of the selection is still drawn: what was open there is forgotten
    fire(view.appBar.querySelector('[data-app-fold="src/billing"]')!, 'click');
    expect(posted()).toEqual([]);
    fire(view.root.querySelector('[data-class-key="package:src/orders"] .pkg-expand')!, 'click');
    expect(posted()).toEqual([{ type: 'requestAppMap', path: '', open: ['src/orders'] }]);
  });

  it('FR-26.7 opening or folding a package outside the map does nothing', () => {
    const { view, posted } = setup();
    view.expandPackage('src/orders');
    view.collapsePackage('src/orders');
    expect(posted()).toEqual([]);
  });
});

describe('codebase map: clicks and menus', () => {
  it('FR-26.5 a folder beside this one (dashed) opens as its own map; a class without code and the empty map go nowhere', () => {
    const { view, node, posted, open } = setup();
    open(level({ diagram: { classes: [pkg('src/orders', 2), pkg('lib/money', 4, { external: true }), { key: 'src/boot.ts#Boot', name: 'Boot', kind: 'class', stereotypes: [], namespace: 'src', methods: [] }], relations: [] } }));
    fire(node('src/boot.ts#Boot')!.querySelector('.cls-name')!, 'click');
    fire(view.canvas.querySelector('svg')!, 'click');
    expect(posted()).toEqual([]);
    fire(node('package:lib/money')!.querySelector('.pkg-name')!, 'click');
    expect(posted()).toEqual([{ type: 'requestAppMap', path: 'lib/money' }]);
  });

  it('FR-26.5 a class menu: Go to declaration and Up to the parent folder; nothing to offer, no menu', () => {
    const { bridge, view, node, item, posted, open } = setup();
    const boot = { key: 'src/boot.ts#Boot', name: 'Boot', kind: 'class' as const, stereotypes: [], namespace: 'src', methods: [], declaration: range('src/boot.ts', 4) };
    const bare = { ...boot, key: 'src/tmp.ts#Tmp', name: 'Tmp', declaration: undefined };
    open(level({ path: 'src/app', crumbs: [{ label: 'Codebase', path: '' }, { label: 'app', path: 'src/app' }], diagram: { classes: [boot, bare], relations: [] } }));
    fire(node(boot.key)!.querySelector('.cls-name')!, 'contextmenu', { clientX: 20, clientY: 20 });
    expect([...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'))).toEqual(['open', 'app-up']);
    item('open')!.click();
    expect(posted()).toEqual([{ type: 'navigate', range: range('src/boot.ts', 4) }]);
    fire(node(boot.key)!.querySelector('.cls-name')!, 'contextmenu', { clientX: 20, clientY: 20 });
    item('app-up')!.click();
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: '' });
    bridge.send({ type: 'appMap', state: 'done', level: level({ path: '', crumbs: [{ label: 'Codebase', path: '' }], diagram: { classes: [bare], relations: [] } }) });
    fire(node(bare.key)!.querySelector('.cls-name')!, 'contextmenu', { clientX: 20, clientY: 20 });
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
  });

  it('FR-26.5 a merged edge: one relation goes straight to its code (or the class), several list their calls', () => {
    const { bridge, view, posted, item } = setup();
    view.enterApp('');
    const rel = (over: object) => {
      const billing = 'calls' in over && !(over as { calls: unknown[] }).calls.length ? pkg('src/billing', 1) : { ...pkg('src/billing', 1), declaration: range('src/billing/index.ts', 2) };
      const diagram = { classes: [pkg('src/orders', 2), billing], relations: [{ id: 'e', kind: 'dependency' as const, from: 'package:src/billing', to: 'package:src/orders', ...over }] };
      bridge.send({ type: 'appMap', state: 'done', level: level({ diagram }) });
      bridge.posted.length = 0;
      fire(view.root.querySelector('[data-relation-id="e"] .rel-hit')!, 'click', { clientX: 50, clientY: 50 });
    };
    rel({ calls: [{ messageId: '', label: 'Invoice → Order', callSite: range('src/billing/invoice.ts', 9) }] });
    expect(posted()).toEqual([{ type: 'navigate', range: range('src/billing/invoice.ts', 9) }]);
    rel({ calls: [{ messageId: '', label: 'Invoice → Order' }] });
    expect(posted()).toEqual([]);
    rel({});
    expect(posted()).toEqual([{ type: 'navigate', range: range('src/billing/index.ts', 2) }]);
    rel({ calls: [] }); // no calls and a package without code
    expect(posted()).toEqual([]);
    rel({ calls: [{ messageId: '', label: 'Invoice → Order' }, { messageId: '', label: 'Refund → Order' }] });
    expect([...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.textContent)).toEqual(['2 calls', 'Invoice → Order', 'Refund → Order']);
    rel({ count: 1, violation: 'Domain: must not depend on Application', calls: [{ messageId: '', label: 'Invoice → Order' }] });
    const rows = () => [...view.root.querySelectorAll('.popup-layer .menu-item')];
    expect(rows().map((r) => r.textContent)).toEqual(['1 relation — Domain', 'Invoice → Order']);
    expect(item('app-relation:0')!.classList.contains('disabled')).toBe(true);
    rel({ count: 5, calls: [{ messageId: '', label: 'Invoice → Order', callSite: range('src/billing/invoice.ts', 9) }, { messageId: '', label: 'Refund → Order', callSite: range('src/billing/refund.ts', 3) }] });
    expect(rows().map((r) => r.textContent)).toEqual(['5 relations', 'Invoice → Orderinvoice.ts:10', 'Refund → Orderrefund.ts:4', '+3 more']);
  });
});

describe('codebase map: issues picked from ⚠ (FR-26.6, FR-19.17)', () => {
  const v: AppMapViolation = { from: 'src/orders/order.ts#Order', to: 'src/billing/invoice.ts#Invoice', fromName: 'Order', toName: 'Invoice', violation: 'Domain → Application', folder: 'src', toHint: { suggested: 'Domain', reasons: ['pure'], noMove: true } };
  const pickFirst = (view: { root: HTMLElement }) => fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');

  it('FR-26.6 a violation at this folder: its two packages and their edge are outlined; a hint that says “keep it there” offers no Move', () => {
    const { view, node, open } = setup();
    const diagram = { classes: [pkg('src/orders', 2), pkg('src/billing', 1), pkg('lib/money', 1, { external: true })], relations: [{ id: 'e', kind: 'dependency' as const, from: 'package:src/orders', to: 'package:src/billing' }] };
    open(level({ diagram, violationList: [v] }));
    pickFirst(view);
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    expect([node('package:src/orders'), node('package:src/billing')].map((n) => n!.classList.contains('finding-hl'))).toEqual([true, true]);
    expect(view.root.querySelector('[data-relation-id="e"]')!.classList.contains('finding-hl')).toBe(true);
    const card = view.root.querySelector('.guide-card')!;
    expect(card.querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: Order → Invoice');
    expect([...card.querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Show in diagram', 'Adjust the rule', 'Copy as Markdown', 'Ask AI', 'Close']);
    // Show again at this folder: outlined in place, no new request
    view.highlightFinding([], []);
    fire([...card.querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === 'Show in diagram')!, 'click');
    expect(node('package:src/orders')!.classList.contains('finding-hl')).toBe(true);
    fire([...card.querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === 'Close')!, 'click');
    expect(view.root.querySelector('.guide-card')).toBeNull();
  });

  it('FR-26.6 Move from a map violation’s card asks where the class goes', () => {
    const { bridge, view, open } = setup();
    open(level({ violationList: [{ ...v, fromLayer: 'Domain', fromHint: { suggested: 'Application', reasons: ['uses ports'] } }] }));
    pickFirst(view);
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    fire([...view.root.querySelectorAll<HTMLElement>('.guide-card .gc-btn')].find((b) => b.textContent === 'Move Order to Application')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: v.from, className: 'Order' });
  });

  it('FR-26.6 a violation to a class this map does not draw (a folder beside it): only the other side is outlined', () => {
    const { view, open } = setup();
    open(level({ diagram: { classes: [pkg('lib/money', 1, { external: true }), pkg('src/orders', 2)], relations: [{ id: 'e', kind: 'dependency', from: 'package:src/orders', to: 'package:lib/money' }] }, violationList: [{ ...v, to: 'lib/money/cash.ts#Cash' }] }));
    pickFirst(view);
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    expect([...view.root.querySelectorAll('.finding-hl')].map((e) => e.getAttribute('data-class-key'))).toEqual(['package:src/orders']);
    expect(view.root.querySelector('.guide-card')).not.toBeNull();
  });

  it('FR-19.17 a pick from a list that a newer map replaced does nothing', () => {
    const { bridge, view, open } = setup();
    const entryPoint = { kind: 'http' as const, label: 'GET /orders', verb: 'GET', method: { key: 'src/orders/api.ts#Api.list', name: 'list', owner: { key: 'src/orders/api.ts#Api', name: 'Api', kind: 'class' as const }, isStatic: false, hasBody: true } };
    const finding = { id: 'f1', kind: 'io-in-loop' as const, title: 'I/O in a loop: Repo.find (DB)' };
    open(level({ violationList: [v], findings: [{ finding, entryPoint }] }));
    pickFirst(view);
    bridge.send({ type: 'appMap', state: 'done', level: level() });
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    pickFirst(view);
    open(level({ violationList: [v], findings: [{ finding, entryPoint }] }));
    pickFirst(view);
    bridge.send({ type: 'appMap', state: 'done', level: level({ findings: [{ finding: { ...finding }, entryPoint }] }) });
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
    expect(view.root.querySelector('.guide-card')).toBeNull();
    expect(bridge.posted.filter((m) => m.type !== 'log')).toEqual([]);
  });
});
