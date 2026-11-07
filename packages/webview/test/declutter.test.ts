// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, EntryPoint, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// (2026-10-16): fewer controls on the first screen; rarely used ones in menus, shown when they apply

const P = 'root/1:placeOrder';

function sequence(filters = true) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  const diagram = cloneSequence();
  if (!filters) diagram.hiddenFilters = [];
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
  const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  const msg = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
  return { bridge, view, menuItem, msg };
}

describe('a quieter toolbar and menus', () => {
  it('FR-14.1 / FR-3.12 no Expand all / Collapse all / Tidy up buttons: Expand all and Collapse all are in ✦ ▾, Tidy up now in View ▾', () => {
    const { bridge, view, menuItem } = sequence();
    expect(view.toolbar.element.querySelector('[data-cmd="collapseAll"]')).toBeNull();
    expect(view.toolbar.element.querySelector('[data-cmd="tidy"]')).toBeNull();
    expect(view.toolbar.element.querySelector('[data-cmd="expandAll"]')).toBeNull();
    fire(view.toolbar.button('expandMenu'), 'click');
    expect([...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'))).toEqual(['show:overview', 'show:expand-all', 'expand-one-level', 'collapse-all']);
    fire(menuItem('collapse-all')!, 'click');
    expect(bridge.last()).toEqual({ type: 'collapseAll' });
    fire(view.toolbar.button('view'), 'click');
    expect(menuItem('view:tidy')!.textContent).toContain('Tidy up now');
    expect(view.toolbar.button('smartExpand').textContent).toContain('Overview');
  });

  it('FR-11.3 Filters ▾ shows only while there is a filter', () => {
    expect(sequence(false).view.toolbar.button('hidden').hidden).toBe(true);
    const { view } = sequence(true);
    expect(view.toolbar.button('hidden').hidden).toBe(false);
    expect(view.toolbar.button('hidden').textContent).toContain('3');
  });

  it('FR-11.1 / FR-11.7 the hide and don\'t-expand rules of a call are one submenu', () => {
    const { bridge, view, menuItem, msg } = sequence();
    fire(msg(`${P}/0:findById`).querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    const top = [...view.root.querySelector('.popup-layer .menu:not(.submenu)')!.children].map((r) => r.getAttribute('data-menu-id'));
    expect(top).toContain('hide-menu');
    for (const id of ['hide-name', 'hide-class-method', 'no-expand-name', 'no-expand-class-method']) {
      expect(top).not.toContain(id);
      expect(menuItem('hide-menu')!.querySelector(`.submenu [data-menu-id="${id}"]`)).not.toBeNull();
    }
    fire(menuItem('no-expand-class-method')!, 'click');
    expect(bridge.last()).toMatchObject({ type: 'hide', filter: { kind: 'classMethod', methodName: 'findById', noExpand: true } });
    // the found message cannot be hidden: the submenu is disabled
    fire(msg('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    expect(menuItem('hide-menu')!.classList.contains('disabled')).toBe(true);
  });

  it('FR-8.7 / FR-11 the DI container step is a found message too, but hides like any call', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    d.messages.unshift({ id: 'container', parentId: null, depth: 0, kind: 'found', from: null, to: d.participants[0].id, methodName: 'GetRequiredService', classKey: 'lib:di#IServiceProvider', className: 'IServiceProvider', args: ['OrdersController'], isAsync: false, isLibrary: false, expandable: true, expanded: false, recursive: false });
    bridge.send({ type: 'render', diagram: d });
    bridge.posted.length = 0;
    const step = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === 'container')!;
    fire(step.querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    const hideMenu = view.root.querySelector('.popup-layer [data-menu-id="hide-menu"]')!;
    expect(hideMenu.classList.contains('disabled')).toBe(false);
    fire(hideMenu.querySelector('.submenu [data-menu-id="hide-name"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'methodName', methodName: 'GetRequiredService' } });
  });

  it('FR-11.3 the class view: Filters ▾ only with a filter', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const btn = () => view.root.querySelector('[data-cmd="hidden"]') as HTMLButtonElement;
    bridge.send({ type: 'render', diagram: mockClassDiagram, hiddenFilters: [] });
    expect(btn().hidden).toBe(true);
    bridge.send({ type: 'render', diagram: mockClassDiagram, hiddenFilters: [{ filter: { id: 'f1', kind: 'methodName', methodName: 'log' }, hiddenCount: 3 }] });
    expect(btn().hidden).toBe(false);
  });

  it('FR-26.8 entry points: tick boxes only after Select for map; Cancel unticks and hides them', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const ep = (name: string): EntryPoint => ({
      kind: 'http', label: `GET /${name}`, verb: 'GET', method: { key: `src/C.cs#C.${name}()`, name, owner: { key: 'src/C.cs#C', name: 'C', kind: 'class' }, isStatic: false, hasBody: true },
    });
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: [ep('a'), ep('b')], project: 'p' });
    const panel = () => view.root.querySelector('.entry-points-panel')!;
    const select = () => panel().querySelector('.ep-select-btn') as HTMLButtonElement;
    expect(panel().querySelectorAll('.ep-check')).toHaveLength(0);
    expect(select().textContent).toBe('☐ Select for map');
    fire(select(), 'click');
    expect(select().textContent).toBe('Cancel');
    fire(panel().querySelector('.ep-item .ep-check')!, 'click');
    expect(panel().querySelector('.ep-appmap-btn')!.textContent).toBe('⛶ Map of selected (1)');
    fire(select(), 'click');
    expect(panel().querySelectorAll('.ep-check')).toHaveLength(0);
    expect(panel().querySelector('.ep-appmap-btn')!.textContent).toBe('⛶ Codebase map');
  });
});
