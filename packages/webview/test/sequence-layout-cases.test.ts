import { describe, expect, it } from 'vitest';
import type { ExitMarker, SequenceDiagram } from '@seqcall/protocol';
import { DEFAULT_LAYOUT, layoutSequence, positionsOf } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';

/** Layout cases of unusual diagram shapes: no bands, a creation to the left, a bare rethrow, stale choices. */
const P = 'root/1:placeOrder';
const CREATE = `${P}/3:constructor`;

const layout = (d: SequenceDiagram, positions = {}) => layoutSequence(d, {}, positions, estimateTextWidth);
const msg = (d: SequenceDiagram, id: string) => d.messages.find((m) => m.id === id)!;

describe('sequence layout: unusual shapes', () => {
  it('FR-1.15 a throw without a known exception type shows only ↯ and its guard', () => {
    const d = cloneSequence();
    const rethrow: ExitMarker = { id: `${P}!exit0`, ownerMessageId: P, kind: 'throw', guard: '!order.isValid', range: range('services/order-service.ts', 25, 6), beforeId: `${P}/4:charge` };
    d.exits = [rethrow];
    const g = layout(d);
    expect(g.exits.map((e) => e.text)).toEqual(['↯ [!order.isValid]']);
  });

  it('FR-8.2 a chosen implementation the diagram no longer lists shows a generic “impl ▾” badge', () => {
    const d = cloneSequence();
    msg(d, `${P}/4:charge`).polymorphic!.selectedKey = 'src/infrastructure/invoice-gateway.ts#InvoiceGateway';
    const g = layout(d);
    const poly = g.messages.find((m) => m.id === `${P}/4:charge`)!.label.segments.find((s) => s.kind === 'poly');
    expect(poly?.text).toBe('impl ▾');
  });

  it('FR-10.6 a creation with some room keeps the start of the class name, cut with …', () => {
    const d = cloneSequence();
    msg(d, CREATE).className = 'OrderAggregateRootWithAVeryLongDomainName';
    const base = positionsOf(layout(d));
    // the created box 240px right of its creator: room for «create», part of the name and ⊕
    const g = layout(d, { ...base, 'p-order': base['p-svc'] + 240 });
    const m = g.messages.find((x) => x.id === CREATE)!;
    expect(m.label.segments.map((s) => s.text)).toEqual(['«create»', 'OrderAggregate…', '⊖']);
    expect(m.labelX + m.label.width).toBeLessThanOrEqual(m.x2 - DEFAULT_LAYOUT.labelPad);
  });

  it('FR-5.1 a creation to the left of its creator points at the right edge of the new box', () => {
    const d = cloneSequence();
    const base = positionsOf(layout(d));
    const g = layout(d, { ...base, 'p-order': 60 });
    const order = g.participants.find((p) => p.id === 'p-order')!;
    const svc = g.participants.find((p) => p.id === 'p-svc')!;
    const m = g.messages.find((x) => x.id === CREATE)!;
    expect(order.x).toBeLessThan(svc.x);
    expect(m.x2).toBe(order.x + order.halfWidth);
    expect(m.x1).toBeGreaterThan(m.x2);
  });

  it('FR-6.4 without bands (no groups) the boxes start at the header top', () => {
    const banded = layout(cloneSequence());
    const d = cloneSequence();
    d.groups = [];
    const g = layout(d);
    expect(g.groups).toEqual([]);
    expect(g.participants.map((p) => p.headerY)).toEqual(d.participants.map(() => DEFAULT_LAYOUT.headerTop));
    expect(banded.participants[0].headerY).toBe(DEFAULT_LAYOUT.headerTop + DEFAULT_LAYOUT.groupBandH);
    expect(g.headerHeight).toBe(banded.headerHeight - DEFAULT_LAYOUT.groupBandH);
  });

  it('FR-6.4 a band of the root folder says “(root)” in its tooltip, with and without a layer', () => {
    const d = cloneSequence();
    d.groups = d.groups.map((g) => (g.id === 'g-ext' ? { id: g.id, label: 'vendor', namespace: '' } : g.id === 'g-dom' ? { ...g, namespace: '' } : g));
    const g = layout(d);
    expect(g.groups.find((b) => b.id === 'g-ext')!.title).toBe('(root)');
    expect(g.groups.find((b) => b.id === 'g-dom')!.title).toBe('Domain · (root)');
  });

  it('FR-1.10 a fragment without operands draws no frame; the others are drawn', () => {
    const d = cloneSequence();
    d.fragments = [
      { id: `${P}#if@1`, kind: 'opt', ownerMessageId: P, operands: [] },
      { id: `${P}#loop@2`, kind: 'loop', ownerMessageId: P, operands: [{ guard: 'each item', firstMessageId: `${P}/2:total`, lastMessageId: `${P}/2:total` }] },
    ];
    expect(layout(d).fragments.map((f) => f.id)).toEqual([`${P}#loop@2`]);
  });
});
