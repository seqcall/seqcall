// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

function setup(rootClassKey?: string) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({
    type: 'render',
    diagram: mockClassDiagram,
    rootClassKey,
    hiddenFilters: [{ filter: { id: 'f1', kind: 'methodName', methodName: 'log' }, hiddenCount: 3 }],
  });
  bridge.posted.length = 0;
  return { bridge, view };
}
const item = (view: { root: HTMLElement }, id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));

describe('FR-11 hiding from the class diagram (shared filters with the sequence diagram)', () => {
  const c = mockClassDiagram.classes.find((x) => x.methods.some((m) => m.name !== 'constructor'))!;
  const method = c.methods.find((m) => m.name !== 'constructor')!;

  it('right-click a class → Hide class posts a class filter', () => {
    const { bridge, view } = setup();
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    item(view, 'hide-class')!.click();
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'class', classKey: c.key, className: c.name } });
  });

  it('right-click a method row → hide calls to Class.method or to any method of that name', () => {
    const { bridge, view } = setup();
    const row = view.canvas.querySelector(`[data-class-key="${c.key}"] [data-member="${method.name}"]`)!;
    rightClick(row);
    item(view, 'hide-class-method')!.click();
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'classMethod', classKey: c.key, className: c.name, methodName: method.name } });
    rightClick(row);
    item(view, 'hide-method')!.click();
    expect(bridge.last()).toEqual({ type: 'hide', filter: { kind: 'methodName', methodName: method.name } });
  });

  it('the root class cannot be hidden', () => {
    const { bridge, view } = setup(c.key);
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    item(view, 'hide-class')!.click();
    expect(bridge.posted.filter((m) => m.type === 'hide')).toEqual([]);
  });

  it('Hidden ▾ lists the shared filters with counts; unhide one or all', () => {
    const { bridge, view } = setup();
    const btn = view.root.querySelector('[data-cmd="hidden"]') as HTMLButtonElement;
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('1');
    btn.click();
    expect(item(view, 'unhide:f1')!.textContent).toContain('3 hidden');
    item(view, 'unhide:f1')!.click();
    expect(bridge.last()).toEqual({ type: 'unhide', filterId: 'f1' });
    btn.click();
    item(view, 'unhide-all')!.click();
    expect(bridge.last()).toEqual({ type: 'unhideAll' });
  });
});
