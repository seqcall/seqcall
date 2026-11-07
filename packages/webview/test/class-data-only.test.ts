// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mount, testBridge } from './helpers';

const cls = (key: string, stereotypes: string[]): ClassNode => ({ key, name: key, kind: 'class', stereotypes, layer: 'Domain', namespace: 'src', methods: [] });

describe('FR-7.15 class view: a class that only holds data steps back', () => {
  it('FR-7.15 a «data» class is drawn muted in its layer; a class with logic is not', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const diagram: ClassDiagram = { classes: [cls('OrderDto', ['data']), cls('Order', [])], relations: [], layers: ['Domain'] };
    bridge.send({ type: 'render', diagram });
    const node = (key: string) => view.canvas.querySelector(`[data-class-key="${key}"]`)!;
    expect([node('OrderDto').classList.contains('data-only'), node('Order').classList.contains('data-only')]).toEqual([true, false]);
    expect(node('OrderDto').textContent).toContain('«data»');
  });
});
