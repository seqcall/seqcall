// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const c = mockClassDiagram.classes[0];
const diagram: ClassDiagram = {
  ...mockClassDiagram,
  classes: [
    {
      ...c,
      methods: [
        { name: 'run', isStatic: false, signature: 'run()' },
        { name: 'check', isStatic: false, signature: 'check()', visibility: 'private' },
        { name: 'format', isStatic: false, signature: 'format()', visibility: 'protected' },
      ],
    },
    ...mockClassDiagram.classes.slice(1),
  ],
};

function setup(state?: unknown) {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  if (state) bridge.setState(state);
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram });
  return { bridge, view };
}
const rows = (view: { canvas: Element }) => [...view.canvas.querySelectorAll(`[data-class-key="${c.key}"] [data-member]`)].map((r) => r.getAttribute('data-member'));
const item = (view: { root: HTMLElement }, id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));

describe('FR-12.18 private and protected methods in the class diagram', () => {
  it('are left out of the box by default', () => {
    const { view } = setup();
    expect(rows(view)).toEqual(['run']);
  });

  it('right-click the class → Show 2 private / protected methods, then Hide them again (per class)', () => {
    const { view } = setup();
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    expect(item(view, 'private-methods')!.textContent).toContain('Show 2 private / protected methods');
    item(view, 'private-methods')!.click();
    expect(rows(view)).toEqual(['run', 'check', 'format']);
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    expect(item(view, 'private-methods')!.textContent).toContain('Hide private / protected methods');
    item(view, 'private-methods')!.click();
    expect(rows(view)).toEqual(['run']);
  });

  it('no menu item for a class with only public methods', () => {
    const { view } = setup();
    const other = diagram.classes.find((x) => x.key !== c.key && !x.methods.some((m) => m.visibility))!;
    rightClick(view.canvas.querySelector(`[data-class-key="${other.key}"] rect`)!);
    expect(item(view, 'hide-class')).not.toBeNull();
    expect(item(view, 'private-methods')).toBeNull();
  });

  it('the choice is kept with the view state', () => {
    const { bridge, view } = setup();
    rightClick(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    item(view, 'private-methods')!.click();
    const again = setup(bridge.getState());
    expect(rows(again.view)).toEqual(['run', 'check', 'format']);
  });
});
