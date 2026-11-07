// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, viewOptionRow, type TestBridge } from './helpers';

let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;

/** The mock diagram with every view option at its default. */
function defaults(): SequenceDiagram {
  const d = cloneSequence();
  // the core's defaults (no arguments, results or return types)
  d.options = { ...d.options, showArguments: false, showResults: false, showReturnTypes: false, showSideEffects: true, showLibraryCalls: false, showFragments: true, showFindings: true, followCursor: false };
  return d;
}

const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: defaults() });
  bridge.posted.length = 0;
});

describe('toolbar: compact and grouped (FR-14)', () => {
  it('FR-14.2 the display options are not toolbar buttons but check boxes in View ▾', () => {
    const cmds = [...view.toolbar.element.querySelectorAll('[data-cmd]')].map((b) => b.getAttribute('data-cmd'));
    expect(cmds).toEqual(['back', 'forward', 'entryPoints', 'smartExpand', 'expandMenu', 'foldErrors', 'layerZoom', 'view', 'findings', 'find', 'hidden', 'image', 'classDiagram']);
    fire(view.toolbar.button('view'), 'click');
    const rows = [...view.root.querySelectorAll('.popup-layer .menu-item')];
    // the marks of both diagrams under their heading (the class view's View ▾ has the same section)
    expect(rows.map((r) => r.textContent)).toEqual(['Arguments', 'Results', 'Return types', '✓I/O badgesnone found', 'Library calls', 'One lifeline per helper type', '✓Fragments', '✓Pipeline', '✓Fold errors', 'Layer zoom', 'Marks · both diagrams', '✓Design issues', '✓Review changes', '✓Tidy up after expanding', 'Follow cursor', 'Tidy up now', 'How to read this…', 'Keyboard shortcuts…?', 'Reset to defaults']);
    expect(rows.filter((r) => r.getAttribute('data-menu-id') !== 'view:marks-head').slice(0, 13).every((r) => r.getAttribute('role') === 'menuitemcheckbox')).toBe(true);
  });

  it('FR-14.2 View ▾ shows a dot when an option differs from its default; Reset restores the defaults', () => {
    const btn = view.toolbar.button('view');
    expect(btn.classList.contains('changed')).toBe(false);
    expect(viewOptionRow(view, 'reset').classList.contains('disabled')).toBe(true);
    const d = defaults();
    d.options.showLibraryCalls = true;
    d.options.showFragments = false;
    bridge.send({ type: 'render', diagram: d });
    expect(btn.classList.contains('changed')).toBe(true);
    expect(btn.title).toContain('Changed: Library calls on, Fragments off');
    fire(viewOptionRow(view, 'reset'), 'click');
    expect(bridge.posted.filter((m) => m.type === 'setOption')).toEqual([
      { type: 'setOption', option: 'showLibraryCalls', value: false },
      { type: 'setOption', option: 'showFragments', value: true },
    ]);
  });

  it('FR-14.3 a narrow toolbar shows icons only; View keeps its name', () => {
    view.toolbar.fitWidth(456);
    expect(view.toolbar.element.classList.contains('compact')).toBe(true);
    expect(view.toolbar.button('view').classList.contains('keep-label')).toBe(true);
    expect(view.toolbar.button('smartExpand').getAttribute('aria-label')).toBe('Overview'); // the name stays for screen readers / tooltips
    view.toolbar.fitWidth(1500);
    expect(view.toolbar.element.classList.contains('compact')).toBe(false);
  });

  it('FR-14.5 zoom floats over the canvas corner instead of taking toolbar width', () => {
    expect(view.toolbar.element.querySelector('[data-cmd="zoomIn"]')).toBeNull();
    expect(view.zoomControls.element.classList.contains('zoom-float')).toBe(true);
    expect(view.zoomControls.element.parentElement).toBe(view.root);
  });

  it('FR-14.4 right-click on the empty canvas offers the diagram commands and View options', () => {
    fire(view.body, 'contextmenu', { clientX: 300, clientY: 300 });
    const ids = [...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.getAttribute('data-menu-id'));
    expect(ids).toEqual(['show:overview', 'show:expand-all', 'expand-one-level', 'collapse-all', 'canvas:foldErrors', 'canvas:tidy', 'canvas:review', 'canvas:view']);
    fire(view.root.querySelector('[data-menu-id="show:overview"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'smartExpand' });
    fire(view.body, 'contextmenu', { clientX: 300, clientY: 300 });
    fire(view.root.querySelector('[data-menu-id="canvas:view"]')!, 'click');
    expect(view.root.querySelector('.popup-layer [data-menu-id="view:showArguments"]')).not.toBeNull();
  });

  it('FR-14.2 every View ▾ option explains itself in its tooltip (the titles were defined but not shown)', () => {
    fire(view.toolbar.button('view'), 'click');
    const row = (o: string) => view.root.querySelector(`.popup-layer [data-menu-id="view:${o}"]`)!;
    expect(row('showFindings').getAttribute('title')).toMatch(/I\/O in loops/);
    expect(row('followCursor').getAttribute('title')).toMatch(/cursor moves/);
  });

  it('FR-14.6 menus are keyboard operable: arrows move, Space toggles (menu stays), Escape returns focus', () => {
    const btn = view.toolbar.button('view');
    btn.focus();
    fire(btn, 'click');
    const doc = view.root.ownerDocument;
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:showArguments');
    key(doc.activeElement!, 'ArrowDown');
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:showResults');
    key(doc.activeElement!, 'ArrowUp');
    key(doc.activeElement!, 'ArrowUp'); // wraps to the last enabled row (Reset is disabled)
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:keys');
    key(doc.activeElement!, 'ArrowUp');
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:legend');
    key(doc.activeElement!, 'ArrowUp');
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:tidy');
    key(doc.activeElement!, 'ArrowUp');
    expect(doc.activeElement?.getAttribute('data-menu-id')).toBe('view:followCursor');
    key(doc.activeElement!, ' ');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'followCursor', value: true });
    expect(view.root.querySelector('.popup-layer .menu')).not.toBeNull();
    key(doc.activeElement!, 'Escape');
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
    expect(doc.activeElement).toBe(btn);
  });
});
