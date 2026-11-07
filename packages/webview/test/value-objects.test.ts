// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

describe('FR-5.12 values on one lifeline', () => {
  it('FR-5.12 the lifeline says ×n and, in its tooltip, why its objects are one: values (FR-5.10 keeps its own reason)', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    Object.assign(d.participants.find((p) => p.id === 'p-gw')!, { instances: 3, instancesWhy: 'value' });
    Object.assign(d.participants.find((p) => p.id === 'p-svc')!, { instances: 2 });
    bridge.send({ type: 'render', diagram: d });
    const title = (id: string) => view.header.querySelector(`[data-participant-id="${id}"] > title`)!.textContent!;
    expect(title('p-gw')).toContain('3 objects created in the drawn calls, shown as one: values — their class cannot change once built');
    expect(title('p-svc')).toContain('2 objects created in the drawn calls, shown as one: built the same way');
    expect(view.header.querySelector('[data-participant-id="p-gw"]')!.textContent).toContain('×3');
  });
});
