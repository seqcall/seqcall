// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView, SourceRange } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

const at = (line: number): SourceRange => ({ file: '/p/src/a.ts', start: { line, character: 4 }, end: { line, character: 20 } });
const service: ClassNode = {
  key: 'S',
  name: 'UserService',
  kind: 'class',
  stereotypes: [],
  namespace: 'src',
  declaration: at(1),
  methods: [
    { name: 'findUser', isStatic: false, signature: 'findUser(id)', declaration: at(5), calls: [{ messageId: 'root/0:findUser', label: 'from Controller.get', callSite: at(30) }] },
    {
      name: 'save',
      isStatic: false,
      signature: 'save(u)',
      declaration: at(9),
      calls: [
        { messageId: 'root/1:save', label: 'from Controller.get', callSite: at(31) },
        { messageId: 'root/2:rename/0:save', label: 'from UserService.rename', callSite: at(12) },
      ],
    },
  ],
};
const port: ClassNode = { key: 'R', name: 'UserRepository', kind: 'interface', stereotypes: [], namespace: 'src', declaration: at(40), methods: [{ name: 'findById', isStatic: false, signature: 'findById(id)', calls: [{ messageId: 'root/0:findUser/0:findById', label: 'from UserService.findUser' }] }] };
const diagram: ClassDiagram = { classes: [service, port], relations: [] };

function setup() {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
  const row = (cls: string, name: string) => view.canvas.querySelector(`[data-class-key="${cls}"] [data-member="${name}"]`)!;
  const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  return { bridge, view, row, menuItem };
}

describe('FR-12.13 class-diagram methods: go to the method, focus the sequence diagram on it', () => {
  it('clicking a method row shows its calls in the sequence diagram and goes to the method, not the class', () => {
    const { bridge, row } = setup();
    fire(row('S', 'findUser'), 'click');
    expect(bridge.posted).toEqual([
      { type: 'highlightMessages', messageIds: ['root/0:findUser'] },
      { type: 'navigate', range: at(5) },
    ]);
  });

  it('an interface row (no definition of its own) shows its calls and goes to the interface', () => {
    const { bridge, row } = setup();
    fire(row('R', 'findById'), 'click');
    expect(bridge.posted).toEqual([
      { type: 'highlightMessages', messageIds: ['root/0:findUser/0:findById'] },
      { type: 'navigate', range: at(40) },
    ]);
  });

  it('right-click on a method with one call: Focus, Show calls, Show callers, Paths to here, Go to declaration, then the hide items (in a submenu)', () => {
    const { bridge, view, row, menuItem } = setup();
    fire(row('S', 'findUser'), 'contextmenu', { clientX: 40, clientY: 40 });
    const ids = [...view.root.querySelectorAll('.popup-layer .menu > .menu-item')].map((e) => e.getAttribute('data-menu-id'));
    // as the sequence diagram's message menu: the hide rules in one submenu
    expect(ids.slice(0, 6)).toEqual(['focus-method', 'show-calls', 'show-callers', 'paths-to-here', 'goto-method', 'hide-menu']);
    expect([...menuItem('hide-menu')!.querySelectorAll('.submenu .menu-item')].map((e) => e.getAttribute('data-menu-id'))).toEqual(['hide-method', 'hide-class-method', 'no-expand-method', 'no-expand-class-method']);
    expect(menuItem('focus-method')!.textContent).toContain('Focus sequence diagram on UserService.findUser');
    fire(menuItem('focus-method')!, 'click');
    expect(bridge.last()).toEqual({ type: 'focus', messageId: 'root/0:findUser' });
  });

  it('a method row with calls offers Show callers and Paths to here, opened in the sequence diagram; a row without calls does not', () => {
    const { bridge, view, row, menuItem } = setup();
    fire(row('S', 'findUser'), 'contextmenu', { clientX: 40, clientY: 40 });
    fire(menuItem('show-callers')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openInSequence', panel: 'callers', messageId: 'root/0:findUser' });
    fire(row('S', 'save'), 'contextmenu', { clientX: 40, clientY: 40 });
    fire(menuItem('paths-to-here')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openInSequence', panel: 'paths', messageId: 'root/1:save' });
    view.handle({ type: 'render', diagram: { classes: [{ ...diagram.classes[0], methods: [{ name: 'idle', isStatic: false, signature: 'idle()' }] }], relations: [] } });
    fire(row('S', 'idle'), 'contextmenu', { clientX: 40, clientY: 40 });
    expect(menuItem('show-callers')).toBeNull();
  });

  it('right-click on the class (not a method row): Go to declaration first, as an object\'s menu in the sequence diagram', () => {
    const { bridge, view, menuItem } = setup();
    fire(view.canvas.querySelector('[data-class-key="S"] .cls-box')!, 'contextmenu', { clientX: 40, clientY: 40 });
    const ids = [...view.root.querySelectorAll('.popup-layer .menu > .menu-item')].map((e) => e.getAttribute('data-menu-id'));
    expect(ids[0]).toBe('open');
    expect(ids.filter((id) => id === 'open')).toHaveLength(1);
    fire(menuItem('open')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: at(1) });
  });

  it('several calls run the method: Focus opens a submenu with the callers and lines', () => {
    const { bridge, row, menuItem } = setup();
    fire(row('S', 'save'), 'contextmenu', { clientX: 40, clientY: 40 });
    expect(menuItem('focus-method')!.querySelector('.menu-hint')!.textContent).toBe('2 calls');
    expect(menuItem('focus-call:1')!.textContent).toContain('from UserService.rename · line 13');
    fire(menuItem('focus-call:1')!, 'click');
    expect(bridge.last()).toEqual({ type: 'focus', messageId: 'root/2:rename/0:save' });
    fire(row('S', 'save'), 'contextmenu', { clientX: 40, clientY: 40 });
    fire(menuItem('show-calls')!, 'click');
    expect(bridge.last()).toEqual({ type: 'highlightMessages', messageIds: ['root/1:save', 'root/2:rename/0:save'] });
  });

  it('clicking the class (not a method row) still goes to the class declaration', () => {
    const { bridge, view } = setup();
    fire(view.canvas.querySelector('[data-class-key="S"] .cls-name') ?? view.canvas.querySelector('[data-class-key="S"] rect')!, 'click');
    expect(bridge.posted).toEqual([{ type: 'navigate', range: at(1) }]);
  });
});
