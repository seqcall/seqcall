// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';
import { enablePan } from '../src/pan';

/** Press at (100,100), move by (dx,dy), release; optionally click the target like a real mouseup would. */
function drag(target: Element, dx: number, dy: number, click = true): void {
  fire(target, 'mousedown', { clientX: 100, clientY: 100 });
  fire(target, 'mousemove', { clientX: 100 + dx / 2, clientY: 100 + dy / 2 });
  fire(target, 'mousemove', { clientX: 100 + dx, clientY: 100 + dy });
  fire(target, 'mouseup', { clientX: 100 + dx, clientY: 100 + dy });
  if (click) fire(target, 'click', { clientX: 100 + dx, clientY: 100 + dy });
}

describe('drag-to-pan: sequence view', () => {
  let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
  let view: SequenceView;
  beforeEach(() => {
    bridge = testBridge();
    view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    view.scroll.scrollLeft = 200;
    view.scroll.scrollTop = 150;
    bridge.posted.length = 0;
  });

  it('dragging the background scrolls the diagram in the opposite direction of the mouse', () => {
    drag(view.body.querySelector('svg')!, 60, 40);
    expect(view.scroll.scrollLeft).toBe(140);
    expect(view.scroll.scrollTop).toBe(110);
    expect(view.scroll.classList.contains('panning')).toBe(false);
  });

  it('a pan that starts on a message does not navigate, a plain click still does', () => {
    const name = view.body.querySelector('[data-msg-id] .seg-name')!;
    drag(name, 50, 0);
    expect(view.scroll.scrollLeft).toBe(150);
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
    fire(name, 'click');
    expect(bridge.last()?.type).toBe('navigate');
  });

  it('dragging a participant head in the header moves the participant, not the view (FR-10.1)', () => {
    const box = view.header.querySelector('[data-participant-id] rect')!;
    drag(box, 80, 0, false);
    expect(view.scroll.scrollLeft).toBe(200);
    expect(bridge.posted.some((m) => m.type === 'savePositions')).toBe(true);
  });

  it('small jitter below the threshold is not a pan', () => {
    drag(view.body.querySelector('svg')!, 2, 1, false);
    expect(view.scroll.scrollLeft).toBe(200);
  });
});

describe('drag-to-pan: class view', () => {
  it('pans on the background, drags on a class box', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    view.scroll.scrollLeft = 100;
    view.scroll.scrollTop = 100;
    drag(view.canvas.querySelector('svg')!, 30, 20);
    expect([view.scroll.scrollLeft, view.scroll.scrollTop]).toEqual([70, 80]);

    drag(view.canvas.querySelector('[data-class-key] rect')!, 40, 40, false);
    expect([view.scroll.scrollLeft, view.scroll.scrollTop]).toEqual([70, 80]);
  });
});

describe('clicks with a little hand jitter still count as clicks', () => {
  it('FR-12.5 a class box clicked with a 4px wobble opens its declaration (no drag)', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    bridge.posted.length = 0;
    drag(view.canvas.querySelector('[data-class-key] rect')!, 3, 3);
    expect(bridge.posted.map((m) => m.type)).toEqual(['navigate']);
  });

  it('FR-2.1 a message clicked with a 4px wobble navigates (no pan)', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.posted.length = 0;
    drag(view.body.querySelector('[data-msg-id] .seg-name')!, 4, 0);
    expect(bridge.posted.map((m) => m.type)).toEqual(['navigate']);
  });
});

describe('enablePan on its own (buttons, scrollbars, cleanup)', () => {
  function setup() {
    const scroll = mount();
    Object.defineProperty(scroll, 'clientWidth', { value: 400 });
    Object.defineProperty(scroll, 'clientHeight', { value: 300 });
    const off = enablePan(scroll, { isDraggable: () => false });
    const press = (button: number, x: number, y: number) => {
      const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
      scroll.dispatchEvent(e);
      fire(scroll, 'mousemove', { clientX: x - 50, clientY: y - 40 });
      fire(scroll, 'mouseup', { clientX: x - 50, clientY: y - 40 });
      return e;
    };
    return { scroll, off, press };
  }

  it('the middle button pans too, without the browser\'s autoscroll widget', () => {
    const s = setup();
    const e = s.press(1, 100, 100);
    expect(e.defaultPrevented).toBe(true);
    expect([s.scroll.scrollLeft, s.scroll.scrollTop]).toEqual([50, 40]);
  });

  it('a left press pans and keeps the default (focus, text selection elsewhere)', () => {
    const s = setup();
    expect(s.press(0, 100, 100).defaultPrevented).toBe(false);
    expect(s.scroll.scrollLeft).toBe(50);
  });

  it('the right button does not pan (context menu)', () => {
    const s = setup();
    s.press(2, 100, 100);
    expect(s.scroll.scrollLeft).toBe(0);
  });

  it('presses on the vertical or horizontal scrollbar keep their native behaviour', () => {
    const s = setup();
    s.press(0, 405, 100); // right of the content: the vertical scrollbar
    s.press(0, 100, 305); // below the content: the horizontal scrollbar
    expect([s.scroll.scrollLeft, s.scroll.scrollTop]).toEqual([0, 0]);
  });

  it('after the returned cleanup, dragging no longer pans', () => {
    const s = setup();
    s.off();
    s.press(0, 100, 100);
    expect(s.scroll.scrollLeft).toBe(0);
    expect(s.press(1, 100, 100).defaultPrevented).toBe(false); // the middle button's autoscroll is back
  });
});
