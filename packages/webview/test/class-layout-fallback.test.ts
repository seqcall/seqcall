// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { layoutClassDiagram } from '../src/class/layout';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const DAGRE_ERROR = 'Not possible to find intersection inside of the rectangle';

afterEach(() => vi.restoreAllMocks());

describe('class layout survives dagre failures', () => {
  it('retries with a simplified graph when dagre throws once', () => {
    const real = dagre.layout;
    let calls = 0;
    vi.spyOn(dagre, 'layout').mockImplementation((g, opts) => {
      if (calls++ === 0) throw new Error(DAGRE_ERROR);
      return real(g, opts);
    });
    const g = layoutClassDiagram(mockClassDiagram, estimateTextWidth, {}, { direction: 'TB' });
    expect(g.fallback).toEqual({ kind: 'simplified', reason: DAGRE_ERROR });
    expect(g.nodes).toHaveLength(mockClassDiagram.classes.length);
    expect(g.edges.every((e) => e.points.length >= 2 && e.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))).toBe(true);
  });

  it('falls back to a grid without overlaps when dagre always throws', () => {
    vi.spyOn(dagre, 'layout').mockImplementation(() => {
      throw new Error(DAGRE_ERROR);
    });
    const g = layoutClassDiagram(mockClassDiagram, estimateTextWidth);
    expect(g.fallback?.kind).toBe('grid');
    for (const a of g.nodes)
      for (const b of g.nodes)
        if (a !== b) expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
    expect(g.edges).toHaveLength(mockClassDiagram.relations.length);
  });

  it('the class view still renders and reports the fallback to the host', () => {
    vi.spyOn(dagre, 'layout').mockImplementation(() => {
      throw new Error(DAGRE_ERROR);
    });
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: mockClassDiagram });
    expect(view.canvas.querySelectorAll('.class-node')).toHaveLength(mockClassDiagram.classes.length);
    const logs = bridge.posted.filter((m) => m.type === 'log');
    expect(logs.some((l) => l.type === 'log' && l.level === 'error' && l.message.includes(DAGRE_ERROR))).toBe(true);
    expect(view.root.textContent).not.toContain('Rendering failed');
  });
});
