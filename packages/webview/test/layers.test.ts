// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { layerClass, layerSlot, sortLayers } from '../src/layers';
import { startClassView } from '../src/class/view';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

describe('layer colours', () => {
  it('well-known layers have fixed slots (case-insensitive); others are stable; no layer = no colour', () => {
    expect(layerSlot('Presentation')).toBe(1);
    expect(layerSlot('infrastructure')).toBe(5);
    expect(layerSlot('Gateways')).toBe(layerSlot('Gateways'));
    expect([6, 7]).toContain(layerSlot('Gateways'));
    expect(layerClass(undefined)).toBe('');
  });

  it('sorts layers architecturally, unknown ones alphabetically after', () => {
    expect(sortLayers(['Infrastructure', 'Zeta', 'Domain', 'Alpha', 'Application', 'Domain'])).toEqual(['Application', 'Domain', 'Infrastructure', 'Alpha', 'Zeta']);
  });

  it('class boxes carry their layer colour and the toolbar shows a legend', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    const layered = mockClassDiagram.classes.filter((c) => c.layer);
    expect(layered.length).toBeGreaterThan(0);
    for (const c of layered) {
      const g = view.canvas.querySelector(`[data-class-key="${c.key}"]`)!;
      expect(g.classList.contains(layerClass(c.layer))).toBe(true);
      expect(g.querySelector('.cls-layer-bar')).not.toBeNull();
    }
    const chips = [...view.root.querySelectorAll('.layer-legend .layer-chip')].map((e) => e.textContent);
    expect(chips).toEqual(sortLayers(layered.map((c) => c.layer!)));
  });

  it('sequence group bands carry the same layer colour', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    const g = d.groups.find((x) => x.layer)!;
    expect(view.header.querySelector(`[data-group-id="${g.id}"]`)!.classList.contains(layerClass(g.layer))).toBe(true);
  });
});

describe('layer hints in the views', () => {
  it('a participant / class with a layerHint shows a ⚑ in the suggested layer colour with the reasons', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const p = d.participants[1];
    p.layerHint = { suggested: 'Domain', reasons: ['no injected dependencies'] };
    bridge.send({ type: 'render', diagram: d });
    const badge = view.header.querySelector(`[data-participant-id="${p.id}"] [data-layer-hint="Domain"]`)!;
    expect(badge.classList.contains(layerClass('Domain'))).toBe(true);
    expect(badge.querySelector('title')!.textContent).toContain('Suggested layer: Domain');
    expect(badge.querySelector('title')!.textContent).toContain('• no injected dependencies');

    const cb = testBridge<HostToClassView, ClassViewToHost>();
    const cv = startClassView(mount(), cb, { measureText: estimateTextWidth, engine: 'dagre' });
    const cd = structuredClone(mockClassDiagram);
    cd.classes[0].layerHint = { suggested: 'Infrastructure', reasons: ['does I/O: HttpClient.GetAsync'] };
    cb.send({ type: 'render', diagram: cd });
    expect(cv.canvas.querySelector(`[data-class-key="${cd.classes[0].key}"] [data-layer-hint="Infrastructure"]`)).not.toBeNull();
  });
});
