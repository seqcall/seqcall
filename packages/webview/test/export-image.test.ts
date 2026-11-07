// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { imageName, portableColor, standaloneSvg } from '../src/export-image';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const item = (root: HTMLElement, id: string) => root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;

describe('FR-25 the diagram as an image', () => {
  afterEach(() => {
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  });

  it('FR-25 one standalone SVG: the header above the body, styles inlined (no classes), on the background', () => {
    const view = startSequenceView(mount(), testBridge<HostToSequenceView, SequenceViewToHost>(), { measureText: estimateTextWidth });
    view.handle({ type: 'render', diagram: cloneSequence() });
    const header = view.header.querySelector('svg')!;
    const body = view.body.querySelector('svg')!;
    const h = header.viewBox.baseVal.height;
    const { svg: text, width } = standaloneSvg([{ svg: header, y: 0 }, { svg: body, y: h }], 800, h + body.viewBox.baseVal.height, 'rgb(30, 30, 30)');
    expect(width).toBe(800); // jsdom has no layout: the given size
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    expect(root.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(root.querySelector('rect')!.getAttribute('fill')).toBe('rgb(30, 30, 30)');
    const parts = [...root.children].filter((c) => c.tagName === 'svg');
    expect(parts.map((p) => p.getAttribute('y'))).toEqual(['0', String(Math.round(h))]);
    expect(root.querySelector('[class]')).toBeNull(); // classes do not travel: styles are inlined
    expect(text).toContain('placeOrder'); // the content is there
  });

  it('FR-25 VS Code: Save as SVG goes to the host (webviews cannot download), named after the root', () => {
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({});
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    (view.root.querySelector('[data-cmd="image"]') as HTMLElement).click();
    expect(item(view.root, 'image:copy')).not.toBeNull();
    item(view.root, 'image:svg')!.click();
    const msg = bridge.last() as Extract<SequenceViewToHost, { type: 'saveImage' }>;
    expect(msg).toMatchObject({ type: 'saveImage', format: 'svg', name: `${imageName(`${d.root.owner.name}.${d.root.name}`)}.svg` });
    expect(msg.data.startsWith('<svg')).toBe(true);
  });

  it('FR-25 colours from color-mix() leave as rgb(): SVG tools outside the browser draw them (not black)', () => {
    expect(portableColor('color(srgb 0.94 0.88 0.98)')).toEqual({ color: 'rgb(240, 224, 250)' });
    expect(portableColor('color(srgb 1 0 0.5 / 0.04)')).toEqual({ color: 'rgb(255, 0, 128)', alpha: 0.04 });
    expect(portableColor('color(srgb 0 0 0 / 50%)')).toEqual({ color: 'rgb(0, 0, 0)', alpha: 0.5 });
    expect(portableColor('color(srgb 1.2 -0.1 0 / 1)')).toEqual({ color: 'rgb(255, 0, 0)' }); // clamped; opaque has no alpha
    expect(portableColor('rgb(1, 2, 3)')).toEqual({ color: 'rgb(1, 2, 3)' });
    expect(portableColor('none')).toEqual({ color: 'none' });
  });

  it('FR-25 a translucent fill keeps its look: the colour opaque, the alpha in fill-opacity', () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg') as SVGSVGElement;
    const box = document.createElementNS(ns, 'rect');
    box.setAttribute('style', 'fill: color(srgb 0 0.5 1 / 0.25); fill-opacity: 0.8; stroke: color(srgb 1 1 1 / 0.5)');
    svg.appendChild(box);
    document.body.appendChild(svg);
    const { svg: text } = standaloneSvg([{ svg, y: 0 }], 100, 100, 'color(srgb 0 0 0 / 0.5)');
    svg.remove();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const [bg, rect] = [...doc.querySelectorAll('rect')];
    expect([bg.getAttribute('fill'), bg.getAttribute('fill-opacity')]).toEqual(['rgb(0, 0, 0)', '0.5']);
    const style = rect.getAttribute('style')!;
    expect(style).toContain('fill:rgb(0, 128, 255)');
    expect(style).toContain('fill-opacity:0.2');
    expect(style).toContain('stroke:rgb(255, 255, 255)');
    expect(style).toContain('stroke-opacity:0.5');
    expect(text).not.toContain('color(srgb');
  });

  it('FR-25 file names are safe', () => {
    expect(imageName('OrderController.store')).toBe('OrderController.store');
    expect(imageName('<module>.main')).toBe('module-.main');
  });
});
