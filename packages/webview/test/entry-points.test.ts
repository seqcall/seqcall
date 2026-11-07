// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EntryPoint, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { displayRoute, matchesFilter, rowsByFile, sortForDisplay } from '../src/sequence/entry-points';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';
import { cloneSequence } from '../dev/mock-data';

const ep = (kind: EntryPoint['kind'], label: string, cls: string, name: string, verb?: string): EntryPoint => ({
  kind, label, ...(verb ? { verb } : {}), method: { key: `src/${cls}.cs#${cls}.${name}()`, name, owner: { key: `src/${cls}.cs#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true },
});
const EPS: EntryPoint[] = [
  ep('http', 'POST /v{version:apiVersion}/Coupons', 'CouponsController', 'Create', 'POST'),
  ep('http', 'GET /v{version:apiVersion}/Coupons/{publicId}', 'CouponsController', 'Get', 'GET'),
  ep('http', 'GET /v{version:apiVersion}/Coupons', 'CouponsController', 'List', 'GET'),
  ep('cli', 'Program.cs (top-level statements)', 'Program', '<Main>$'),
  ep('job', 'NightlyJobService.ExecuteAsync', 'NightlyJobService', 'ExecuteAsync'),
  ...Array.from({ length: 3 }, (_, i) => ep('test', `CouponTests.Case${i}`, 'CouponTests', `Case${i}`)),
];

function setup() {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.posted.length = 0;
  return { bridge, view };
}

describe('FR-16.2 entry-point list', () => {
  it('FR-16.2 routes are shortened for display and sorted by path, then verb', () => {
    expect(displayRoute('/v{version:apiVersion}/Providers/{providerId:long}/{slug?}/{*rest}')).toBe('/v{version}/Providers/{providerId}/{slug}/{*rest}');
    expect(sortForDisplay(EPS.filter((e) => e.kind === 'http')).map((e) => e.label)).toEqual([
      'GET /v{version:apiVersion}/Coupons',
      'POST /v{version:apiVersion}/Coupons',
      'GET /v{version:apiVersion}/Coupons/{publicId}',
    ]);
    expect(matchesFilter(EPS[0], 'coupons create')).toBe(true); // all words, label or method
    expect(matchesFilter(EPS[0], 'coupons delete')).toBe(false);
    // FR-16.9 the project of a multi-project root matches too
    expect(matchesFilter({ ...EPS[0], project: 'ShopApi' }, 'shopapi coupons')).toBe(true);
    expect(matchesFilter(EPS[0], 'shopapi coupons')).toBe(false);
  });

  it('FR-16.2 the toolbar button works without a diagram: asks the host, shows progress, then the grouped list', () => {
    const { bridge, view } = setup();
    const button = view.toolbar.button('entryPoints');
    expect(button.disabled).toBe(false);
    fire(button, 'click');
    expect(bridge.last()).toEqual({ type: 'requestEntryPoints' });
    expect(view.root.querySelector('.entry-points-panel')!.textContent).toContain('Searching entry points');
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'ShopApi' });
    let panel = view.root.querySelector('.entry-points-panel')!;
    expect(panel.querySelector('.ep-title')!.textContent).toBe('Entry points · ShopApi⚠ Design issues⎇ Review changes⛶ Codebase map∅ Unreachable');
    // FR-26: the codebase map opens in the class view
    fire(panel.querySelector('.ep-appmap-btn')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openAppMap' });
    fire(button, 'click');
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'ShopApi' });
    panel = view.root.querySelector('.entry-points-panel')!;
    // FR-19.9: the project-wide design-issue scan starts from the Entry points panel
    expect(panel.querySelector('.ep-issues-btn')!.textContent).toBe('⚠ Design issues');
    expect([...panel.querySelectorAll('.ep-group')].map((g) => g.textContent)).toEqual([
      '▾ HTTP endpoints 3', '▾ Programs & scripts 1', '▾ Background jobs 1', '▸ Tests 3', // tests start closed
    ]);
    const first = panel.querySelector('.ep-item')!;
    expect(first.querySelector('.ep-verb')!.textContent).toBe('GET');
    expect(first.querySelector('.ep-label')!.textContent).toBe('/v{version}/Coupons');
    expect(first.querySelector('.ep-method')!.textContent).toBe('CouponsController.List');
    fire(first, 'click');
    // FR-16.3: the chosen entry point travels along (shown as the tag at the found message)
    expect(bridge.last()).toEqual({ type: 'openMethod', methodKey: EPS[2].method.key, entryPoint: EPS[2] });
    expect(view.root.querySelector('.entry-points-panel')).toBeNull();
    // says at once that the diagram is being built (the first one of a project takes seconds)
    const busy = view.root.querySelector('.placeholder.busy') as HTMLElement;
    expect(busy.hidden).toBe(false);
    expect(busy.textContent).toBe('Building the diagram of GET /v{version}/Coupons…');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(view.root.querySelector('.placeholder.busy')).toBeNull();
  });

  it('FR-16.2 opened low on the page, the list fits in the window below its top (scrolls inside)', () => {
    const { view } = setup();
    const panel = () => view.root.querySelector('.popup-layer .entry-points-panel') as HTMLElement;
    const height = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
      view.showEntryPoints(10, 100);
      expect(panel().style.maxHeight).toBe('492px'); // 600 − 100 − 8
      view.showEntryPoints(10, 500);
      expect(panel().style.maxHeight).toBe('160px'); // never smaller than a few rows
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 2000 });
      view.showEntryPoints(10, 50);
      expect(panel().style.maxHeight).toBe('520px'); // never taller than its usual size
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    }
  });

  it('FR-16.11 with several projects the project name switches the project; with one it is plain text', () => {
    const { bridge, view } = setup();
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'backend' });
    expect(view.root.querySelector('.ep-switch-project')).toBeNull();
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'backend', canSwitchProject: true });
    const switcher = view.root.querySelector('.ep-switch-project') as HTMLElement;
    expect(switcher.textContent).toBe(' · backend ▾');
    fire(switcher, 'click');
    expect(bridge.last()).toEqual({ type: 'switchEntryPointsProject' });
    // the host answers with the other project's list
    bridge.send({ type: 'entryPoints', entryPoints: EPS.slice(0, 1), project: 'frontend', canSwitchProject: true, show: true });
    expect(view.root.querySelector('.ep-switch-project')!.textContent).toBe(' · frontend ▾');
  });

  it('FR-16.5 module-level calls of one file are listed under the file (closed until clicked); a single one stays a row', () => {
    const file = 'src/entry/desktop/entry.react.js';
    const mod = (f: string, name: string): EntryPoint => ({ ...ep('cli', `${f}: ${name}()`, name, name), detail: 'module-level call', file: f });
    const list = [mod(file, 'initI18n'), mod(file, 'isNodeReady'), mod('src/entry/common/scripts.js', 'capitalize'), ep('cli', 'main', 'Main', 'main')];
    expect(rowsByFile(list).map((r) => ('file' in r ? `${r.file} ×${r.entries.length}` : r.entry.label))).toEqual([
      `${file} ×2`, 'src/entry/common/scripts.js: capitalize()', 'main',
    ]);
    const { bridge, view } = setup();
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: list });
    const panel = () => view.root.querySelector('.entry-points-panel')!;
    const rows = () => [...panel().querySelectorAll('.ep-item')].map((r) => r.querySelector('.ep-label')!.textContent);
    expect(rows()).toEqual(['main', 'src/entry/common/scripts.js: capitalize()', `▸ ${file}`]); // sorted by label
    expect(panel().querySelector('.ep-file .ep-method')!.textContent).toBe('2 calls');
    fire(panel().querySelector('.ep-file')!, 'click');
    expect(rows()).toEqual(['main', 'src/entry/common/scripts.js: capitalize()', `▾ ${file}`, 'initI18n()', 'isNodeReady()']);
    fire(panel().querySelector('.ep-nested')!, 'click');
    expect(bridge.last()).toMatchObject({ type: 'openMethod', methodKey: list[0].method.key });
  });

  it('FR-26.8 ticked entry points (one, a group) or, while filtering, the matching ones get a map of only them', () => {
    const { bridge, view } = setup();
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'ShopApi' });
    const panel = () => view.root.querySelector('.entry-points-panel')!;
    const mapBtn = () => panel().querySelector('.ep-appmap-btn')! as HTMLButtonElement;
    const key = (e: EntryPoint) => `${e.kind}|${e.label}|${e.method.key}`;
    expect(mapBtn().textContent).toBe('⛶ Codebase map');
    // no tick boxes until Select for map
    expect(panel().querySelectorAll('.ep-check')).toHaveLength(0);
    fire(panel().querySelector('.ep-select-btn')!, 'click');
    expect(panel().querySelectorAll('.ep-check').length).toBeGreaterThan(0);
    expect(panel().querySelectorAll('.ep-group[data-group="test"] .ep-check')).toHaveLength(0); // tests are never mapped
    // one entry: ticking does not open its flow
    const before = bridge.posted.length;
    fire(panel().querySelector(`.ep-item[data-method-key="${EPS[4].method.key}"] .ep-check`)!, 'click');
    expect(bridge.posted.length).toBe(before);
    expect(mapBtn().textContent).toBe('⛶ Map of selected (1)');
    // a whole group
    fire(panel().querySelector('.ep-group[data-group="http"] .ep-check')!, 'click');
    expect(mapBtn().textContent).toBe('⛶ Map of selected (4)');
    fire(mapBtn(), 'click');
    expect(bridge.last()).toEqual({ type: 'openAppMap', entryPoints: [EPS[0], EPS[1], EPS[2], EPS[4]].map(key) });
    // ✕ unticks all; the filter then decides
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'ShopApi' });
    fire(panel().querySelector('.ep-clear-sel')!, 'click');
    expect(panel().querySelector('.ep-clear-sel')).toBeNull();
    const search = panel().querySelector('.ep-search') as HTMLInputElement;
    search.value = 'coupons get';
    fire(search, 'input');
    expect(mapBtn().textContent).toBe('⛶ Map of 2 matching');
    fire(mapBtn(), 'click');
    expect(bridge.last()).toEqual({ type: 'openAppMap', entryPoints: [EPS[1], EPS[2]].map(key) });
  });

  it('FR-16.6 FR-16.7 React pages and UI roots are their own groups after HTTP endpoints: the path or container, the component beside it', () => {
    const { view, bridge } = setup();
    const page: EntryPoint = { kind: 'route', label: '/orders/:id', detail: 'client route (src/router.tsx)', method: { key: 'src/pages.tsx#<module>.OrderPage', name: 'OrderPage', owner: { key: 'src/pages.tsx#<module>', name: 'pages', kind: 'module' }, isStatic: false, hasBody: true } };
    const rootEp: EntryPoint = { kind: 'ui', label: '#cart-app', detail: 'render root (src/main.tsx)', method: { key: 'src/header.tsx#<module>.Header', name: 'Header', owner: { key: 'src/header.tsx#<module>', name: 'header', kind: 'module' }, isStatic: false, hasBody: true } };
    bridge.send({ type: 'entryPoints', entryPoints: [EPS[3], rootEp, page, EPS[0]], project: 'shop', show: true });
    const panel = view.root.querySelector('.entry-points-panel')!;
    expect([...panel.querySelectorAll('.ep-group')].map((g) => g.textContent)).toEqual([
      '▾ HTTP endpoints 1', '▾ Pages (client routes) 1', '▾ UI roots 1', '▾ Programs & scripts 1',
    ]);
    const row = panel.querySelector('.ep-item.kind-route')!;
    expect(row.querySelector('.ep-label')!.textContent).toBe('/orders/:id');
    expect(row.getAttribute('title')).toContain('client route (src/router.tsx)');
    expect(panel.querySelector('.ep-item.kind-ui .ep-label')!.textContent).toBe('#cart-app');
  });

  it('FR-16.2 filtering opens matching groups and shows counts; errors are shown; the empty panel offers the list', () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'ShopApi', show: true });
    const search = view.root.querySelector('.ep-search') as HTMLInputElement;
    search.value = 'case1';
    search.dispatchEvent(new Event('input'));
    const panel = view.root.querySelector('.entry-points-panel')!;
    expect([...panel.querySelectorAll('.ep-group')].map((g) => g.textContent)).toEqual(['▾ Tests 1/3']);
    expect([...panel.querySelectorAll('.ep-item')].map((i) => i.querySelector('.ep-label')!.textContent)).toEqual(['CouponTests.Case1']);

    bridge.send({ type: 'entryPoints', entryPoints: [], error: 'C# workspace failed to load', show: true });
    expect(view.root.querySelector('.ep-status.error')!.textContent).toBe('C# workspace failed to load');

    bridge.send({ type: 'empty', reason: 'Nothing yet' });
    bridge.posted.length = 0;
    fire(view.placeholder.querySelector('[data-cmd="find-entry-points"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestEntryPoints' });
  });
});
