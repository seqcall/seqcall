// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AppMapLevel, ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

const range = (file: string, line = 1) => ({ file, start: { line, character: 0 }, end: { line, character: 5 } });

const flow: ClassDiagram = {
  classes: [{ key: 'src/a.ts#Flow', name: 'Flow', kind: 'class', stereotypes: [], namespace: 'src', methods: [] }],
  relations: [],
};

const top: AppMapLevel = {
  path: 'src',
  crumbs: [{ label: 'Codebase', path: 'src' }],
  entryPoints: 3,
  failed: 0,
  truncated: 1,
  classes: 4,
  relations: 3,
  violations: 1,
  computedAt: '2026-10-09T10:00:00.000Z',
  diagram: {
    layers: ['Application', 'Infrastructure'],
    classes: [
      {
        key: 'package:src/services',
        name: 'services',
        kind: 'module',
        stereotypes: [],
        layer: 'Application',
        namespace: 'src/services',
        methods: [{ name: 'OrderService', isStatic: false, signature: 'OrderService', declaration: range('src/services/order.ts', 3) }],
        group: { path: 'src/services', classes: 1 },
      },
      {
        key: 'package:src/repos',
        name: 'repos',
        kind: 'module',
        stereotypes: [],
        layer: 'Infrastructure',
        namespace: 'src/repos',
        methods: [
          { name: 'OrderRepo', isStatic: false, signature: 'OrderRepo' },
          { name: 'UserRepo', isStatic: false, signature: 'UserRepo' },
        ],
        group: { path: 'src/repos', classes: 2, violations: 1 },
      },
      { key: 'src/main.ts#Main', name: 'Main', kind: 'class', stereotypes: [], namespace: 'src', methods: [], declaration: range('src/main.ts', 7) },
    ],
    relations: [
      {
        id: 'rel:services→repos',
        kind: 'dependency',
        from: 'package:src/services',
        to: 'package:src/repos',
        label: '2',
        count: 2,
        calls: [
          { messageId: '', label: 'OrderService → OrderRepo', callSite: range('src/services/order.ts', 10) },
          { messageId: '', label: 'OrderService → UserRepo', callSite: range('src/services/order.ts', 12) },
        ],
      },
    ],
  },
};

function setup() {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram: flow });
  return { bridge, view, posted: () => bridge.posted.filter((m) => m.type !== 'log') };
}

describe('the map opens fitted', () => {
  it('a new level of the map is fitted to the width (the last diagram\'s zoom was kept); the same level keeps the zoom', async () => {
    const { bridge, view } = setup();
    Object.defineProperty(view.scroll, 'clientWidth', { configurable: true, value: 100_000 });
    view.setZoom(0.3);
    fire(view.root.querySelector('[data-cmd="app-map"]')!, 'click');
    bridge.send({ type: 'appMap', state: 'done', level: top });
    await view.settled();
    await Promise.resolve();
    expect(view.zoom).toBe(1);
    view.setZoom(0.7);
    bridge.send({ type: 'appMap', state: 'done', level: top });
    await view.settled();
    await Promise.resolve();
    expect(view.zoom).toBe(0.7);
  });
});

describe('codebase map in the class view (FR-26)', () => {
  it('FR-26.5 ⛶ Codebase asks for the map and shows the scan\'s progress, then the packages with a tab and how many classes they hold', () => {
    const { bridge, view, posted } = setup();
    fire(view.root.querySelector('[data-cmd="app-map"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: '' });
    bridge.send({ type: 'appMap', state: 'running', done: 1, total: 3 });
    expect(view.placeholder.hidden).toBe(false);
    expect(view.placeholder.textContent).toContain('1 / 3');
    expect(view.appBar.textContent).toContain('■ Stop');
    bridge.send({ type: 'appMap', state: 'done', level: top });
    const pkgs = [...view.root.querySelectorAll('.class-node.package')];
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0].querySelector('.pkg-tab')).not.toBeNull();
    expect(view.root.querySelector('[data-class-key="package:src/repos"] .pkg-count')!.textContent).toBe('2 classes · ⚠ 1 inside');
    expect(view.root.querySelector('[data-relation-id="rel:services→repos"] .rel-label')!.textContent).toBe('2');
    // the flow's class is not drawn while the map is shown
    expect(view.root.querySelector('[data-class-key="src/a.ts#Flow"]')).toBeNull();
    expect(view.appBar.textContent).toContain('3 entry points · 4 classes · 3 relations · 1 layer violation'); // in words: ⚠ N is the button's
    expect(view.root.querySelector('[data-cmd="app-map"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('FR-26.5 a package opens as its own map from its menu, one of its classes goes to the class; a merged edge lists its relations', () => {
    const { bridge, view, posted } = setup();
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'done', level: top });
    fire(view.root.querySelector('[data-class-key="package:src/services"] .pkg-name')!, 'contextmenu', { clientX: 20, clientY: 20 });
    fire(view.root.querySelector('.popup-layer [data-menu-id="app-open"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src/services' });
    bridge.send({ type: 'appMap', state: 'done', level: top });
    fire(view.root.querySelector('[data-class-key="package:src/services"] [data-member="OrderService"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'navigate', range: range('src/services/order.ts', 3) });
    fire(view.root.querySelector('[data-class-key="src/main.ts#Main"] .cls-name')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'navigate', range: range('src/main.ts', 7) });
    fire(view.root.querySelector('[data-relation-id="rel:services→repos"] .rel-hit')!, 'click', { clientX: 50, clientY: 50 });
    const rows = [...view.root.querySelectorAll('.popup-layer [data-menu-id^="app-relation:"]')].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('OrderService → UserRepo');
    fire(view.root.querySelector('.popup-layer [data-menu-id="app-relation:1"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'navigate', range: range('src/services/order.ts', 12) });
  });

  it('FR-26.5 the breadcrumb opens a parent folder; ↻ Rescan scans again; ← Flow brings back the flow\'s classes, also those rendered meanwhile', () => {
    const { bridge, view, posted } = setup();
    view.enterApp('');
    const deeper: AppMapLevel = { ...top, path: 'src/repos', crumbs: [...top.crumbs, { label: 'repos', path: 'src/repos' }] };
    bridge.send({ type: 'appMap', state: 'done', level: deeper });
    fire(view.appBar.querySelector('[data-app-path="src"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src' });
    bridge.send({ type: 'appMap', state: 'done', level: top });
    fire(view.appBar.querySelector('[data-app-action="rescan"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src', rescan: true });
    // the flow changes meanwhile: kept, drawn on return
    const next: ClassDiagram = { classes: [{ ...flow.classes[0], key: 'src/b.ts#Next', name: 'Next' }], relations: [] };
    bridge.send({ type: 'render', diagram: next });
    expect(view.root.querySelector('[data-class-key="src/b.ts#Next"]')).toBeNull();
    fire(view.appBar.querySelector('[data-app-action="flow"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'cancelAppMap' }); // the rescan was still running
    expect(view.root.querySelector('[data-class-key="src/b.ts#Next"]')).not.toBeNull();
    expect(view.appBar.hidden).toBe(true);
  });

  it('FR-26.7 a click opens a package in place, ⊖ in the bar folds it again; what is open is remembered per folder', () => {
    const { bridge, view, posted } = setup();
    view.enterApp('');
    bridge.send({ type: 'appMap', state: 'done', level: top });
    fire(view.root.querySelector('[data-class-key="package:src/repos"] .pkg-expand')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src', open: ['src/repos'] });
    const opened: AppMapLevel = {
      ...top,
      open: ['src/repos'],
      diagram: {
        ...top.diagram,
        classes: [
          top.diagram.classes[0],
          { key: 'src/repos/order.ts#OrderRepo', name: 'OrderRepo', kind: 'class', stereotypes: [], namespace: 'src/repos', methods: [], inPackage: 'src/repos' },
          { key: 'package:src/repos/sql', name: 'sql', kind: 'module', stereotypes: [], namespace: 'src/repos/sql', methods: [{ name: 'UserRepo', isStatic: false, signature: 'UserRepo' }], group: { path: 'src/repos/sql', classes: 1, in: 'src/repos' } },
        ],
        relations: [],
      },
    };
    bridge.send({ type: 'appMap', state: 'done', level: opened });
    expect(view.root.querySelector('[data-class-key="package:src/repos"]')).toBeNull();
    expect(view.root.querySelector('[data-class-key="package:src/repos/sql"] .pkg-count')!.textContent).toBe('1 class · in repos');
    const fold = view.appBar.querySelector('[data-app-fold="src/repos"]')!;
    expect(fold.textContent).toBe('⊖ repos');
    // remembered: asking again (another view, a restore) opens the same packages
    expect(bridge.getState<{ appOpen?: Record<string, string[]> }>()!.appOpen).toEqual({ src: ['src/repos'] });
    // right-click on something shown from it: fold it there
    fire(view.root.querySelector('[data-class-key="src/repos/order.ts#OrderRepo"] .cls-name')!, 'contextmenu', { clientX: 20, clientY: 20 });
    expect(view.root.querySelector('.popup-layer [data-menu-id="app-collapse"]')!.textContent).toContain('Fold repos again');
    // ⊖ on the boxes that came out of it, where one looks
    const tag = view.root.querySelector('[data-class-key="src/repos/order.ts#OrderRepo"] .fold-tag')!;
    expect(tag.textContent).toContain('⊖ repos');
    expect(view.root.querySelector('[data-class-key="package:src/repos/sql"] .fold-tag')).not.toBeNull();
    fire(tag, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src' });
    bridge.send({ type: 'appMap', state: 'done', level: opened });
    fire(view.appBar.querySelector('[data-app-fold="src/repos"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src' });
  });

  it('FR-26.6 a package with a violation inside is outlined red; ⚠ N lists every violation of the map (as a flow\'s), a pick opens its folder and outlines it', async () => {
    const { bridge, view, posted } = setup();
    view.enterApp('');
    const withList: AppMapLevel = { ...top, violationList: [{ from: 'src/repos/order.ts#OrderRepo', to: 'src/repos/user.ts#UserRepo', fromName: 'OrderRepo', toName: 'UserRepo', violation: 'Infrastructure must not …', folder: 'src/repos', fromLayer: 'Infrastructure', toLayer: 'Infrastructure', fromHint: { suggested: 'Domain', reasons: ['no I/O'] } }] };
    bridge.send({ type: 'appMap', state: 'done', level: withList });
    expect(view.root.querySelector('[data-class-key="package:src/repos"]')!.classList.contains('has-violations')).toBe(true);
    expect(view.root.querySelector('.layer-violations')).toBeNull(); // no legend chip any more
    const btn = view.root.querySelector('[data-cmd="findings"]') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('1');
    expect(btn.title).toBe('1 layer violation in the flows of this map — click for the list');
    fire(btn, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: 'src/repos' });
    // FR-19.17 the same violation card as in a flow's class diagram
    const card = view.root.querySelector('.guide-card')!;
    expect(card.textContent).toContain('OrderRepo');
    expect([...card.querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Show in diagram', 'Move OrderRepo to Domain', 'Adjust the rule', 'Copy as Markdown', 'Ask AI', 'Close']);
    fire([...card.querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === 'Adjust the rule')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'openDependencyRule' });
    const repos: AppMapLevel = {
      ...withList,
      path: 'src/repos',
      crumbs: [...top.crumbs, { label: 'repos', path: 'src/repos' }],
      diagram: {
        classes: [
          { key: 'src/repos/order.ts#OrderRepo', name: 'OrderRepo', kind: 'class', stereotypes: [], namespace: 'src/repos', methods: [] },
          { key: 'src/repos/user.ts#UserRepo', name: 'UserRepo', kind: 'class', stereotypes: [], namespace: 'src/repos', methods: [] },
        ],
        relations: [{ id: 'rel:x', kind: 'dependency', from: 'src/repos/order.ts#OrderRepo', to: 'src/repos/user.ts#UserRepo', violation: 'Infrastructure must not …', calls: [] }],
      },
    };
    bridge.send({ type: 'appMap', state: 'done', level: repos });
    await view.settled();
    expect(view.root.querySelector('[data-relation-id="rel:x"]')!.classList.contains('finding-hl')).toBe(true);
    expect(view.root.querySelectorAll('.class-node.finding-hl')).toHaveLength(2);
  });

  it('/ FR-19.17 the map\'s ⚠ N lists the design issues of its flows too; a pick shows the same card as a flow\'s, Show in diagram opens the flow', () => {
    const { bridge, view, posted } = setup();
    view.enterApp('');
    const entryPoint = { kind: 'http' as const, label: 'GET /orders', verb: 'GET', method: { key: 'src/a.ts#A.get', name: 'get', owner: { key: 'src/a.ts#A', name: 'A', kind: 'class' as const }, isStatic: false, hasBody: true } };
    const finding = { id: 'f1', kind: 'io-in-loop' as const, title: 'I/O in a loop: Repo.find (DB)', messageIds: ['root/0:x'], ignoreKey: 'Repo.find' };
    bridge.send({ type: 'appMap', state: 'done', level: { ...top, findings: [{ finding, entryPoint }] } });
    const btn = view.root.querySelector('[data-cmd="findings"]') as HTMLButtonElement;
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('1');
    fire(btn, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
    const card = view.root.querySelector('.guide-card')!;
    expect(card.textContent).toContain('How to fix');
    const button = (label: string) => [...card.querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === label)!;
    expect([...card.querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Show in diagram', 'Ignore Repo.find', 'Copy as Markdown', 'Ask AI', 'Close']);
    fire(button('Show in diagram'), 'click');
    expect(posted().at(-1)).toEqual({ type: 'openFinding', entryPoint, finding });
    fire(button('Ignore Repo.find'), 'click');
    expect(posted().at(-1)).toEqual({ type: 'ignoreFinding', pattern: 'Repo.find' });
  });

  it('FR-26.8 a map of selected entry points: asked for with the selection, labelled, ✕ All maps every entry point again', () => {
    const { bridge, view, posted } = setup();
    const keys = ['http|GET /a|src/a.ts#A.get', 'http|POST /b|src/b.ts#B.post'];
    bridge.send({ type: 'showAppMap', entryPoints: keys });
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: '', entryPoints: keys });
    bridge.send({ type: 'appMap', state: 'done', level: { ...top, entryPoints: 2 } });
    const bar = view.root.querySelector('.app-selection')!;
    expect(bar.textContent).toBe('Map of 2 entry points ✕ All');
    // other folders keep the selection
    fire(view.root.querySelector('.app-crumb, [data-app-path]') ?? bar, 'click');
    expect(bridge.getState<{ appSelection?: string[] }>()!.appSelection).toEqual(keys);
    fire(bar.querySelector('[data-app-action="all"]')!, 'click');
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: '' });
    bridge.send({ type: 'appMap', state: 'done', level: top });
    expect(view.root.querySelector('.app-selection')).toBeNull();
  });

  it('FR-26.5 the host can open the map (command / entry-point list); the view remembers it and asks again when restored', () => {
    const { bridge, view, posted } = setup();
    bridge.send({ type: 'showAppMap' });
    expect(posted().at(-1)).toEqual({ type: 'requestAppMap', path: '' });
    bridge.send({ type: 'appMap', state: 'done', level: top });
    const saved = bridge.getState<{ appPath?: string; diagram?: ClassDiagram }>()!;
    expect(saved.appPath).toBe('src');
    expect(saved.diagram?.classes[0].key).toBe('src/a.ts#Flow'); // the flow's diagram, not the map
    const again = testBridge<HostToClassView, ClassViewToHost>();
    again.setState(saved);
    startClassView(mount(), again, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(again.posted.filter((m) => m.type !== 'log')).toContainEqual({ type: 'requestAppMap', path: 'src' });
    expect(view.root.isConnected).toBe(false);
  });
});
