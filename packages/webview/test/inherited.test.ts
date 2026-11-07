// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const P = 'root/1:placeOrder';
const FIND = `${P}/0:findById`;
const BASE = { key: 'src/infrastructure/base-repository.ts#BaseRepository', name: 'BaseRepository' };

describe('FR-5.11 a method the object inherits from its base class', () => {
  it('the label shows ↑ before the method name; other calls do not', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const diagram = cloneSequence();
    diagram.messages.find((m) => m.id === FIND)!.inheritedFrom = BASE;
    bridge.send({ type: 'render', diagram });
    const el = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
    const marks = el(FIND).querySelectorAll('.seg-inherited');
    expect([...marks].map((t) => t.textContent)).toEqual(['↑']);
    // before the name
    const name = el(FIND).querySelector('.seg-name')!;
    expect(marks[0].querySelector('path')).not.toBeNull();
    expect(Number(marks[0].querySelector('text')!.getAttribute('x'))).toBeLessThan(Number(name.getAttribute('x')));
    expect(el(P).querySelector('.seg-inherited')).toBeNull();
  });

  it('the hover card names the base class', () => {
    const m = cloneSequence().messages.find((x) => x.id === FIND)!;
    const text = (nodes: Node[]) => nodes.map((n) => n.textContent).join('\n');
    expect(text(messageCard(m, document))).not.toContain('inherited');
    expect(text(messageCard({ ...m, inheritedFrom: BASE }, document))).toContain('↑ inherited: declared in BaseRepository');
  });
});
