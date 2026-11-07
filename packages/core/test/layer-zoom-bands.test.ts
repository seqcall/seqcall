import { describe, expect, it } from 'vitest';
import type { Message, Participant, SequenceDiagram } from '@seqcall/protocol';
import { projectLayers } from '../src/layer-zoom';

// FR-28.7 the bands of a zoomed diagram when a layer is opened in place.
const P = (id: string, layer: string | undefined, groupId: string): Participant =>
  ({ id, classKey: `k#${id}`, className: id.toUpperCase(), label: `:${id.toUpperCase()}`, kind: 'class', stereotypes: [], ...(layer ? { layer } : {}), namespace: 'src', groupId }) as Participant;
const M = (id: string, parentId: string | null, from: string | null, to: string): Message =>
  ({ id, parentId, depth: id === 'root' ? 0 : id.split('/').length - 1, kind: from === null ? 'found' : 'call', from, to, methodName: id.slice(id.lastIndexOf(':') + 1), args: [], expandable: false, expanded: true }) as unknown as Message;

describe('FR-28.7 bands of an opened layer', () => {
  it('FR-28.7 a folded lifeline whose band id is already an opened layer\'s band shares it: every band id once', () => {
    // a layer literally named "layer" in folder src has the band `layer::src` — the zoom key of the objects without a
    // layer in src
    const d = {
      root: { key: 'k', name: 'run', owner: { key: 'k#a', name: 'A', kind: 'class' }, isStatic: false, hasBody: true },
      participants: [P('a', 'layer', 'layer::src'), P('b', undefined, '::src')],
      groups: [
        { id: 'layer::src', label: 'layer · src', layer: 'layer', namespace: 'src' },
        { id: '::src', label: 'src', namespace: 'src' },
      ],
      messages: [M('root', null, null, 'a'), M('root/0:x', 'root', 'a', 'b')],
      hiddenFilters: [],
    } as unknown as SequenceDiagram;
    const z = projectLayers(d, new Set(['layer:layer'])).diagram;
    expect(z.groups.map((g) => g.id)).toEqual(['layer::src']);
    expect(z.participants.map((p) => `${p.id} in ${p.groupId}`)).toEqual(['a in layer::src', 'layer::src in layer::src']);
  });
});
