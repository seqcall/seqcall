// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const item = (root: HTMLElement, id: string) => root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const contextMenu = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));

describe('FR-7.5 moving a class to a layer from the sequence diagram', () => {
  function setup() {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const p = d.participants.find((x) => x.classKey.includes('#') && !x.classKey.startsWith('lib:'))!;
    p.layerHint = { suggested: 'Domain', reasons: ['no injected dependencies'] };
    d.layerChoices = ['Presentation', 'Application', 'Domain', 'Infrastructure'];
    bridge.send({ type: 'render', diagram: d });
    bridge.posted.length = 0;
    return { bridge, view, p };
  }

  it('participant menu: apply the suggestion or pick any layer', () => {
    const { bridge, view, p } = setup();
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    item(view.root, 'apply-layer-hint')!.click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain' });
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    expect(item(view.root, 'move-layer')).not.toBeNull();
    expect(item(view.root, `layer:${p.layer}`)).toBeNull(); // current layer is not offered
    item(view.root, 'layer:Infrastructure')!.click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Infrastructure' });
  });

  it('clicking the ⚑ shows the reasons and applies the suggestion', () => {
    const { bridge, view, p } = setup();
    view.header.querySelector(`[data-participant-id="${p.id}"] [data-layer-hint] text`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 20 }));
    expect(view.root.querySelector('.popup-layer')!.textContent).toContain('• no injected dependencies');
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
    item(view.root, 'apply-layer-hint')!.click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toMatchObject({ type: 'setLayer', layer: 'Domain' });
  });
});

describe('FR-7.5 moving a class to a layer from the class diagram', () => {
  it('context menu and ⚑ both post setLayer', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const cd = structuredClone(mockClassDiagram);
    const c = cd.classes.find((x) => x.key.includes('#') && !x.key.startsWith('lib:')) ?? cd.classes[0];
    c.key = c.key.includes('#') ? c.key : `src/x.ts#${c.name}`;
    c.layerHint = { suggested: 'Infrastructure', reasons: ['does I/O: HttpClient.GetAsync'] };
    bridge.send({ type: 'render', diagram: cd, layerChoices: ['Application', 'Domain', 'Infrastructure'] });
    bridge.posted.length = 0;
    contextMenu(view.canvas.querySelector(`[data-class-key="${c.key}"] rect`)!);
    item(view.root, 'apply-layer-hint')!.click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: c.key, className: c.name, layer: 'Infrastructure' });
    view.canvas.querySelector(`[data-class-key="${c.key}"] [data-layer-hint] text`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 60, clientY: 30 }));
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
    expect(item(view.root, 'apply-layer-hint')).not.toBeNull();
  });
});
