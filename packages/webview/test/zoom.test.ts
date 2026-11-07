// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { clampZoom, fitWidthZoom, fitZoom, formatZoom, MAX_ZOOM, MIN_ZOOM, scrollForZoom, stepZoom, wheelZoomFactor } from '../src/zoom';
import { CLASS_LAYOUT, layoutClassDiagram } from '../src/class/layout';
import { startClassView } from '../src/class/view';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

describe('zoom math', () => {
  it('clamps to the supported range and rejects nonsense', () => {
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });

  it('steps by a factor and snaps to 100% when crossing it', () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.2);
    expect(stepZoom(1, -1)).toBeCloseTo(1 / 1.2, 3);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it('fit never enlarges and fits the larger overflow', () => {
    expect(fitZoom(500, 300, 1000, 800)).toBe(1);
    expect(fitZoom(2000, 400, 1000, 800)).toBe(0.5);
    expect(fitZoom(1000, 3200, 1000, 800)).toBe(0.25);
    expect(fitZoom(2000, 99999, 1000, 0)).toBe(0.5); // height ignored when 0 (fit to width)
    expect(fitZoom(1000, 1000, 0, 500)).toBe(0.5); // width ignored when 0 (a hidden panel's width)
  });

  it('keeps the content point under the pointer while zooming', () => {
    const { left, top } = scrollForZoom(100, 50, 200, 100, 1, 2);
    // content point (300,150) at 1× → at 2× it is at (600,300); pointer stays at (200,100)
    expect(left).toBe(400);
    expect(top).toBe(200);
    expect(scrollForZoom(0, 0, 10, 10, 2, 1)).toEqual({ left: 0, top: 0 });
  });

  it('wheel up zooms in, down zooms out; formats as percent', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48)); // lines
    expect(wheelZoomFactor(-1, 2)).toBeCloseTo(wheelZoomFactor(-400)); // pages
    expect(formatZoom(0.333)).toBe('33%');
  });
});

function star(n: number, leafName = (i: number) => `leaf${i}`): ClassDiagram {
  const cls = (key: string, sig = `${key}(input: string): void`): ClassNode =>
    ({ key, name: key, kind: 'module', namespace: 'src', stereotypes: ['module'], methods: [{ name: key, signature: sig, isStatic: false }] }) as unknown as ClassNode;
  const leaves = Array.from({ length: n }, (_, i) => leafName(i));
  return {
    classes: [cls('hub'), ...leaves.map((k) => cls(k))],
    relations: leaves.map((k, i) => ({ id: `r${i}`, kind: 'dependency', from: 'hub', to: k })),
  } as unknown as ClassDiagram;
}

describe('class layout: adaptive direction and tight bounds', () => {
  it('lays a star graph out left-to-right when top-to-bottom would be far wider than the viewport', () => {
    // Boxes are as wide as their names: long module names make the single TB rank very wide.
    const g = layoutClassDiagram(star(25, (i) => `someRatherLongModuleName${i}`), estimateTextWidth, {}, { viewportWidth: 1600, viewportHeight: 900 });
    expect(g.direction).toBe('LR');
    expect(g.height).toBeGreaterThan(g.width);
    const hub = g.nodes.find((n) => n.key === 'hub')!;
    for (const n of g.nodes) if (n !== hub) expect(n.x).toBeGreaterThan(hub.x + hub.width);
  });

  it('keeps top-to-bottom for small graphs and the mock diagram', () => {
    expect(layoutClassDiagram(star(3), estimateTextWidth, {}, { viewportWidth: 1600 }).direction).toBe('TB');
    expect(layoutClassDiagram(mockClassDiagram, estimateTextWidth).direction).toBe('TB');
  });

  it('bounds are tight: the content starts at the margin', () => {
    for (const d of [star(25), mockClassDiagram]) {
      const g = layoutClassDiagram(d, estimateTextWidth, {}, { viewportWidth: 1600 });
      expect(Math.min(...g.nodes.map((n) => n.x))).toBeGreaterThanOrEqual(CLASS_LAYOUT.margin - 0.5);
      expect(Math.min(...g.nodes.map((n) => n.y))).toBeCloseTo(CLASS_LAYOUT.margin, 0);
      expect(g.width - Math.max(...g.nodes.map((n) => n.x + n.width))).toBeLessThanOrEqual(CLASS_LAYOUT.margin + 1);
    }
  });

  it('class boxes are as wide as the name (min width for short names); signatures are truncated', () => {
    const d = star(1);
    (d.classes[0].methods[0] as { signature: string }).signature = `run(options: { ${'verbose: boolean; '.repeat(40)} }): void`;
    const g = layoutClassDiagram(d, estimateTextWidth);
    const hub = g.nodes.find((n) => n.key === 'hub')!;
    expect(hub.width).toBe(CLASS_LAYOUT.minTextWidth + 2 * CLASS_LAYOUT.padX); // 'hub' is short
    expect(hub.memberParts[0].name).toBe('run');
    expect(hub.memberLines[0].endsWith('…')).toBe(true);

    const long = layoutClassDiagram(star(1, () => 'AVeryLongClassNameThatSetsTheWidth'), estimateTextWidth);
    const leaf = long.nodes.find((n) => n.key.startsWith('AVery'))!;
    expect(leaf.width).toBe(Math.ceil(estimateTextWidth('AVeryLongClassNameThatSetsTheWidth', 'className')) + 2 * CLASS_LAYOUT.padX);
  });
});

describe('class view: toolbar and zoom', () => {
  function setup() {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    const svg = () => view.canvas.querySelector('svg')!;
    const btn = (cmd: string) => (view.toolbar.querySelector(`[data-cmd="${cmd}"]`) ?? view.zoomControls.element.querySelector(`[data-cmd="${cmd}"]`)) as HTMLButtonElement;
    return { bridge, view, svg, btn };
  }

  it('zoom buttons scale the SVG (viewBox unchanged) and persist the zoom', () => {
    const { view, svg, btn, bridge } = setup();
    const w = view.geometry!.width;
    expect(Number(svg().getAttribute('width'))).toBe(w);
    fire(btn('zoomIn'), 'click');
    expect(Number(svg().getAttribute('width'))).toBeCloseTo(w * 1.2, 0);
    expect(svg().getAttribute('viewBox')).toBe(`0 0 ${w} ${view.geometry!.height}`);
    expect(btn('zoomReset').textContent).toBe('120%');
    expect(bridge.getState<{ zoom: number }>()!.zoom).toBeCloseTo(1.2);
    fire(btn('zoomReset'), 'click');
    expect(view.zoom).toBe(1);
  });

  it('Ctrl/Cmd + wheel zooms, a plain wheel scrolls', () => {
    const { view } = setup();
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    expect(view.zoom).toBe(1);
    const e = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    view.scroll.dispatchEvent(e);
    expect(view.zoom).toBeGreaterThan(1);
    expect(e.defaultPrevented).toBe(true);
    view.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, metaKey: true, bubbles: true, cancelable: true }));
    expect(view.zoom).toBeLessThan(1);
  });

  it('restores the persisted zoom', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    bridge.setState({ diagram: mockClassDiagram, positions: {}, zoom: 0.5 });
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    expect(view.zoom).toBe(0.5);
    expect(Number(view.canvas.querySelector('svg')!.getAttribute('width'))).toBeCloseTo(view.geometry!.width / 2, 0);
  });

  it('drags move by screen distance / zoom', () => {
    const { view, btn } = setup();
    fire(btn('zoomIn'), 'click'); // 1.2
    fire(btn('zoomIn'), 'click'); // 1.44
    const before = view.geometry!.nodes.find((n) => n.key === 'Order')!;
    fire(view.canvas.querySelector('[data-class-key="Order"] rect')!, 'mousedown', { clientX: 0, clientY: 0 });
    fire(document.body, 'mousemove', { clientX: 144, clientY: 0 });
    fire(document.body, 'mouseup');
    const after = view.geometry!.nodes.find((n) => n.key === 'Order')!;
    expect(after.x - before.x).toBeCloseTo(100, 0);
  });

  it('Re-layout drops manual positions', () => {
    const { view, btn, bridge } = setup();
    expect(btn('relayout').disabled).toBe(true);
    expect(btn('relayout').hidden).toBe(true); // only shown when there is a manual layout to drop
    const auto = view.geometry!.nodes.find((n) => n.key === 'Order')!.x;
    fire(view.canvas.querySelector('[data-class-key="Order"] rect')!, 'mousedown', { clientX: 0, clientY: 0 });
    fire(document.body, 'mousemove', { clientX: 80, clientY: 30 });
    fire(document.body, 'mouseup');
    expect(btn('relayout').disabled).toBe(false);
    expect(btn('relayout').hidden).toBe(false);
    fire(btn('relayout'), 'click');
    expect(view.positions).toEqual({});
    expect(view.geometry!.nodes.find((n) => n.key === 'Order')!.x).toBeCloseTo(auto);
    expect(bridge.getState<{ positions: object }>()!.positions).toEqual({});
  });
});

describe('sequence view: zoom', () => {
  function setup(state?: unknown) {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    if (state) bridge.setState(state);
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    if (!state) bridge.send({ type: 'render', diagram: cloneSequence() });
    const btn = (cmd: string) => view.zoomControls.element.querySelector(`[data-cmd="${cmd}"]`) as HTMLButtonElement;
    const headerSvg = () => view.header.querySelector('svg')!;
    const bodySvg = () => view.body.querySelector('svg')!;
    return { bridge, view, btn, headerSvg, bodySvg };
  }

  it('header and body scale together so the sticky header stays aligned', () => {
    const { view, btn, headerSvg, bodySvg } = setup();
    const g = view.geometry!;
    fire(btn('zoomOut'), 'click');
    const z = view.zoom;
    expect(z).toBeLessThan(1);
    expect(Number(headerSvg().getAttribute('width'))).toBeCloseTo(g.width * z, 0);
    expect(Number(bodySvg().getAttribute('width'))).toBe(Number(headerSvg().getAttribute('width')));
    expect(Number(headerSvg().getAttribute('height'))).toBeCloseTo(g.headerHeight * z, 0);
    expect(view.header.style.width).toBe(view.body.style.width);
    expect(headerSvg().getAttribute('viewBox')).toBe(`0 0 ${g.width} ${g.headerHeight}`);
  });

  it('zoom survives re-renders and is persisted with the last diagram', () => {
    const { view, btn, bridge, headerSvg } = setup();
    fire(btn('zoomIn'), 'click');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(Number(headerSvg().getAttribute('width'))).toBeCloseTo(view.geometry!.width * 1.2, 0);
    const state = bridge.getState<{ zoom: number; lastRender: unknown }>()!;
    expect(state.zoom).toBeCloseTo(1.2);
    expect(state.lastRender).toBeDefined();
    const restored = setup(state);
    expect(restored.view.zoom).toBeCloseTo(1.2);
    expect(Number(restored.headerSvg().getAttribute('width'))).toBeCloseTo(restored.view.geometry!.width * 1.2, 0);
  });

  it('participant drags are converted from screen pixels at the current zoom', () => {
    const { view, btn, bridge } = setup();
    // placed by hand: with Tidy up after expanding on, a drop is packed again (auto-tidy.test.ts)
    const d = cloneSequence();
    d.options = { ...d.options, autoTidy: false };
    bridge.send({ type: 'render', diagram: d });
    fire(btn('zoomIn'), 'click'); // 1.2
    const before = view.geometry!.participants.find((p) => p.id === 'p-svc')!.x;
    fire(view.header.querySelector('[data-participant-id="p-svc"] rect')!, 'mousedown', { clientX: 100 });
    fire(document.body, 'mousemove', { clientX: 220 });
    fire(document.body, 'mouseup');
    const save = bridge.last();
    expect(save?.type === 'savePositions' && save.positions['p-svc']).toBe(Math.round(before + 100));
  });

  it('zoom controls are disabled without a diagram', () => {
    const { view, btn, bridge } = setup();
    expect(btn('zoomFit').disabled).toBe(false);
    bridge.send({ type: 'empty', reason: '' });
    expect(btn('zoomFit').disabled).toBe(true);
    expect(view.geometry).toBeNull();
  });
});

describe('the class view fits the width, readable', () => {
  it('the width, at most 100 %, at least 60 %', () => {
    expect([fitWidthZoom(500, 1000), fitWidthZoom(1250, 1000), fitWidthZoom(5000, 1000), fitWidthZoom(5000, 1000, 0.3)]).toEqual([1, 0.8, 0.6, 0.3]);
  });
});
