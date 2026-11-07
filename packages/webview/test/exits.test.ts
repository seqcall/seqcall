// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ExitMarker, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { exitCard, startSequenceView } from '../src/sequence/view';
import { exitText, layoutSequence } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const P = 'root/1:placeOrder';
const early: ExitMarker = { id: `${P}!exit0`, ownerMessageId: P, kind: 'return', guard: '!customer', range: range('src/services/order-service.ts', 20, 6), beforeId: `${P}/2:total` };
const thrown: ExitMarker = { id: `${P}!exit1`, ownerMessageId: P, kind: 'throw', exception: 'PaymentDeclined', guard: '!receipt.ok', range: range('src/services/order-service.ts', 26, 6), beforeId: `${P}/5:info` };

function withExits(): SequenceDiagram {
  const d = cloneSequence();
  d.exits = [early, thrown];
  return d;
}

describe('FR-1.15 early-exit markers', () => {
  it('FR-1.15 marker text: ↩ / ↯ with the guard (shortened) and the exception', () => {
    expect(exitText(early, 40)).toBe('↩ [!customer]');
    expect(exitText(thrown, 40)).toBe('↯ [!receipt.ok] PaymentDeclined');
    expect(exitText({ ...early, guard: undefined }, 40)).toBe('↩');
    expect(exitText({ ...early, guard: 'voucherValidationResult.Status != OrderStatus.Ok' }, 20)).toMatch(/^↩ \[voucherValidatio.*…\]$/);
  });

  it("FR-1.15 a marker takes a half-height row on its owner's activation bar, between the right messages", () => {
    const plain = layoutSequence(cloneSequence(), {}, {}, estimateTextWidth);
    const g = layoutSequence(withExits(), {}, {}, estimateTextWidth);
    const y = (id: string) => g.messages.find((m) => m.id === id)!.y;
    const [e0, e1] = g.exits;
    expect(e0.y).toBeGreaterThan(y(`${P}/1:findById`));
    expect(e0.y).toBeLessThan(y(`${P}/2:total`));
    expect(e1.y).toBeGreaterThan(y(`${P}/4:charge`));
    expect(e1.y).toBeLessThan(y(`${P}/5:info`));
    const bar = g.activations.find((a) => a.messageId === P)!;
    expect(e0.x).toBeGreaterThanOrEqual(bar.x + g.options.actW);
    expect(e0.x).toBeLessThan(bar.x + g.options.actW + 10);
    // only a little taller: two half rows
    expect(g.bodyHeight - plain.bodyHeight).toBeLessThanOrEqual(2 * (g.options.exitH + 2));
  });

  it('FR-1.15 a frame whose operand ends with an exit encloses the marker', () => {
    const d = withExits();
    d.fragments = [{ id: `${P}#opt0@4`, kind: 'opt', ownerMessageId: P, operands: [{ guard: '!receipt.ok', firstMessageId: `${P}/4:charge`, lastMessageId: thrown.id }] }];
    d.exits = [{ ...thrown, guard: undefined }];
    const g = layoutSequence(d, {}, {}, estimateTextWidth);
    const f = g.fragments[0];
    expect(g.exits[0].y).toBeGreaterThan(f.y1);
    expect(g.exits[0].y).toBeLessThan(f.y2);
    expect(f.x2).toBeGreaterThanOrEqual(g.exits[0].x + g.exits[0].width);
  });

  it('FR-1.15 / FR-28.4 two exits before the same call (zoomed: the calls between them folded) both get a row, in order, each in its own frame', () => {
    const d = withExits();
    const second: ExitMarker = { ...thrown, kind: 'return', exception: undefined, guard: undefined, beforeId: early.beforeId };
    d.exits = [{ ...early, guard: undefined }, second];
    d.fragments = [
      { id: `${P}#opt0@1`, kind: 'opt', ownerMessageId: P, operands: [{ guard: '!customer', firstMessageId: early.id, lastMessageId: early.id }] },
      { id: `${P}#opt0@2`, kind: 'opt', ownerMessageId: P, operands: [{ guard: '!stock', firstMessageId: second.id, lastMessageId: second.id }] },
    ];
    const g = layoutSequence(d, {}, {}, estimateTextWidth);
    expect(g.exits.length).toBe(2);
    const [e0, e1] = g.exits;
    expect(e0.y).toBeLessThan(e1.y);
    expect(e1.y).toBeLessThan(g.messages.find((m) => m.id === `${P}/2:total`)!.y);
    const [f0, f1] = g.fragments;
    expect([f0.y1 < e0.y && e0.y < f0.y2, f1.y1 < e1.y && e1.y < f1.y2, f0.y2 <= f1.y1]).toEqual([true, true, true]);
  });

  it('FR-1.15 click reveals the statement; the hover card explains it', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: withExits() });
    const marker = view.body.querySelector(`[data-exit-id="${thrown.id}"]`)!;
    expect(marker.textContent).toBe('↯ [!receipt.ok] PaymentDeclined');
    expect(marker.classList.contains('kind-throw')).toBe(true);
    fire(marker.querySelector('.exit-hit')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: thrown.range });
    expect(exitCard(early, document).map((n) => n.textContent)).toEqual(['Returns early when !customer', 'order-service.ts:21 · click to go to the statement']);
    expect(exitCard({ ...thrown, guard: undefined }, document)[0].textContent).toBe('Throws PaymentDeclined here');
  });
});
