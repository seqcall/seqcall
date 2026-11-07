// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HiddenFilterInfo, HostToClassView, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const P = 'root/1:placeOrder';
const FIND = `${P}/0:findById`;
const REPO = 'src/infrastructure/customer-repository.ts#CustomerRepository';
const RULE: HiddenFilterInfo = { filter: { id: `noExpand:classMethod:${REPO}.findById`, kind: 'classMethod', classKey: REPO, className: 'CustomerRepository', methodName: 'findById', noExpand: true }, hiddenCount: 1 };

function sequence(edit?: (d: SequenceDiagram) => void) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  const diagram = cloneSequence();
  edit?.(diagram);
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
  const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
  const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  return { bridge, view, msgEl, menuItem };
}

const withRule = (d: SequenceDiagram) => {
  d.hiddenFilters = [...d.hiddenFilters, RULE];
  d.messages.find((m) => m.id === FIND)!.noExpand = RULE.filter.id;
};

describe("FR-11.7 don't expand (sequence view)", () => {
  it('a call under the rule shows ⊡ instead of ⊕; a click still expands it', () => {
    const { bridge, msgEl } = sequence(withRule);
    const glyph = msgEl(FIND).querySelector('.expand-glyph')!;
    expect(glyph.classList.contains('no-expand')).toBe(true);
    expect(glyph.querySelector('rect')).not.toBeNull();
    expect(glyph.querySelector('title')!.textContent).toContain('Not expanded by Overview / Expand all');
    fire(glyph, 'click');
    expect(bridge.last()).toEqual({ type: 'expand', messageId: FIND });
    // other calls keep their ⊕
    expect(msgEl(P).querySelector('.expand-glyph')!.classList.contains('no-expand')).toBe(false);
  });

  it("right-click a call → Don't expand calls to Class.method / named method posts a noExpand rule", () => {
    const { bridge, msgEl, menuItem } = sequence();
    fire(msgEl(FIND).querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    expect(menuItem('no-expand-class-method')!.textContent).toContain("Don't expand calls to CustomerRepository.findById only");
    fire(menuItem('no-expand-class-method')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'classMethod', classKey: REPO, className: 'CustomerRepository', methodName: 'findById', noExpand: true } });
    fire(msgEl(FIND).querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    fire(menuItem('no-expand-name')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'methodName', methodName: 'findById', noExpand: true } });
  });

  it('a call under the rule offers to remove it instead', () => {
    const { bridge, msgEl, menuItem } = sequence(withRule);
    fire(msgEl(FIND).querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    expect(menuItem('no-expand-name')).toBeNull();
    fire(menuItem('allow-expand')!, 'click');
    expect(bridge.last()).toEqual({ type: 'unhide', filterId: RULE.filter.id });
  });

  it("right-click an object → Don't expand calls to class X", () => {
    const { bridge, view, menuItem } = sequence();
    fire(view.header.querySelector('[data-participant-id="p-repo1"] rect')!, 'contextmenu');
    fire(menuItem('no-expand-class')!, 'click');
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'class', classKey: REPO, className: 'CustomerRepository', noExpand: true } });
  });

  it('Filters ▾ lists Hidden and Not expanded rules in two sections; a click removes one', () => {
    const { bridge, view, menuItem } = sequence(withRule);
    const btn = view.toolbar.button('hidden');
    expect(btn.textContent).toContain('Filters');
    fire(btn, 'click');
    const ids = [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    expect(ids.indexOf('filters:hidden')).toBeLessThan(ids.indexOf('unhide:f1'));
    expect(ids.indexOf('unhide:f1')).toBeLessThan(ids.indexOf('filters:no-expand'));
    expect(ids.indexOf('filters:no-expand')).toBeLessThan(ids.indexOf(`unhide:${RULE.filter.id}`));
    expect(menuItem(`unhide:${RULE.filter.id}`)!.textContent).toContain('1 call · remove');
    fire(menuItem(`unhide:${RULE.filter.id}`)!, 'click');
    expect(bridge.last()).toEqual({ type: 'unhide', filterId: RULE.filter.id });
  });
});

describe("FR-11.7 don't expand (class view, shared rules)", () => {
  const c = mockClassDiagram.classes.find((x) => x.methods.some((m) => m.name !== 'constructor'))!;
  const method = c.methods.find((m) => m.name !== 'constructor')!;
  function setup(filters: HiddenFilterInfo[] = []) {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram, hiddenFilters: filters });
    bridge.posted.length = 0;
    return { bridge, view };
  }
  const item = (view: { root: HTMLElement }, id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));

  it("right-click a class / method row → Don't expand… posts the same rules as the sequence view", () => {
    const { bridge, view } = setup();
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    item(view, 'no-expand-class')!.click();
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'class', classKey: c.key, className: c.name, noExpand: true } });
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] [data-member="${method.name}"]`)!);
    item(view, 'no-expand-class-method')!.click();
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'classMethod', classKey: c.key, className: c.name, methodName: method.name, noExpand: true } });
  });

  it('a class under a rule offers to remove it; the toolbar button is Filters', () => {
    const { bridge, view } = setup([{ filter: { id: `noExpand:class:${c.key}`, kind: 'class', classKey: c.key, className: c.name, noExpand: true }, hiddenCount: 2 }]);
    expect(view.root.querySelector('[data-cmd="hidden"]')!.textContent).toContain('Filters');
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    expect(item(view, 'no-expand-class')).toBeNull();
    item(view, 'allow-expand-class')!.click();
    expect(bridge.last()).toEqual({ type: 'unhide', filterId: `noExpand:class:${c.key}` });
  });
});
