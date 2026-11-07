import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { DEFAULT_LAYOUT, layoutSequence, tidyPositions, type SequenceGeometry } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';

const P = 'root/1:placeOrder';

function setup(d: SequenceDiagram = cloneSequence(), positions = {}) {
  const g = layoutSequence(d, {}, positions, estimateTextWidth);
  const part = (id: string) => g.participants.find((p) => p.id === id)!;
  const msg = (id: string) => g.messages.find((m) => m.id === id)!;
  const act = (messageId: string) => g.activations.find((a) => a.messageId === messageId)!;
  return { d, g, part, msg, act };
}

function boxesOverlap(g: SequenceGeometry): boolean {
  const ps = [...g.participants].sort((a, b) => a.x - b.x);
  return ps.some((p, i) => i > 0 && ps[i - 1].x + ps[i - 1].halfWidth > p.x - p.halfWidth);
}

describe('sequence layout', () => {
  it('FR-5.1 places the created participant head at the row of its create message, lifeline starting there', () => {
    const { part, msg } = setup();
    const order = part('p-order');
    const create = msg(`${P}/3:constructor`);
    expect(order.createdHeadY).toBeDefined();
    expect(create.y).toBeGreaterThan(order.createdHeadY!);
    expect(create.y).toBeLessThan(order.createdHeadY! + order.boxHeight);
    expect(order.lifelineTop).toBe(order.createdHeadY! + order.boxHeight);
    // arrow points at the head box edge (created participant is to the right)
    expect(create.x2).toBeCloseTo(order.x - order.halfWidth);
  });

  it('FR-5.2 the created participant is also listed (faded) in the header', () => {
    const { part } = setup();
    expect(part('p-order').faded).toBe(true);
    expect(part('p-svc').faded).toBe(false);
    expect(part('p-svc').lifelineTop).toBe(0);
  });

  it('FR-5.1 messages before the creation row do not overlap the head box', () => {
    const { part, msg } = setup();
    const head = part('p-order').createdHeadY!;
    expect(msg(`${P}/2:total`).y).toBeLessThan(head);
  });

  it('FR-1.5 self calls nest activation bars (one level per open activation on the lifeline)', () => {
    const { act, msg } = setup();
    expect(act('root').level).toBe(0);
    expect(act('root/0:validate').level).toBe(1);
    expect(act('root/0:validate/0:checkItems').level).toBe(2);
    const nested = act('root/0:validate/0:checkItems');
    const outer = act('root/0:validate');
    expect(nested.x).toBeGreaterThan(outer.x);
    expect(nested.y1).toBeGreaterThanOrEqual(outer.y1);
    expect(nested.y2).toBeLessThanOrEqual(outer.y2);
    // self message returns onto the nested bar
    const m = msg('root/0:validate/0:checkItems');
    expect(m.x2).toBeCloseTo(nested.x + DEFAULT_LAYOUT.actW);
  });

  it('FR-1.5 self messages take extra height', () => {
    const { msg } = setup();
    const self = msg('root/0:validate/0:checkItems');
    expect(self.y2).toBe(self.y + DEFAULT_LAYOUT.selfLoopH);
    const next = msg(P);
    const rowAfterSelf = next.y - self.y;
    const normalRow = msg(`${P}/1:findById`).y - msg(`${P}/0:findById`).y;
    expect(rowAfterSelf).toBeGreaterThan(normalRow);
  });

  it('FR-3.1 nested calls are sent from the target activation, which spans its subtree', () => {
    const { act, msg, part } = setup();
    const a = act(P);
    const children = ['0:findById', '1:findById', '2:total', '3:constructor', '4:charge', '5:info', '6:notifyCustomer'].map((s) => msg(`${P}/${s}`));
    for (const c of children) {
      expect(c.y).toBeGreaterThanOrEqual(a.y1);
      expect(c.y).toBeLessThanOrEqual(a.y2);
      expect(c.x1).toBeCloseTo(a.x + DEFAULT_LAYOUT.actW); // right edge of the bar
    }
    expect(a.participantId).toBe('p-svc');
    expect(a.x).toBeCloseTo(part('p-svc').x - DEFAULT_LAYOUT.actW / 2);
    // the root activation encloses everything
    const root = act('root');
    expect(root.y2).toBeGreaterThan(msg('root/2:toDto').y);
  });

  it('FR-1.1 the found message arrives from a gate at the left edge', () => {
    const { msg, part } = setup();
    const f = msg('root');
    expect(f.x1).toBe(DEFAULT_LAYOUT.gateX);
    expect(f.x2).toBeLessThan(part('p-ctrl').x);
    expect(f.labelX + f.label.width).toBeLessThan(part('p-ctrl').x);
  });

  it('messages are in pre-order, top to bottom', () => {
    const { g } = setup();
    const ys = g.messages.map((m) => m.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('FR-6.4 group bands span exactly their participants and do not overlap', () => {
    const { g } = setup();
    for (const band of g.groups) {
      const members = g.participants.filter((p) => p.participant.groupId === band.id);
      expect(members.length).toBeGreaterThan(0);
      for (const p of members) {
        expect(band.x1).toBeLessThanOrEqual(p.x - p.halfWidth);
        expect(band.x2).toBeGreaterThanOrEqual(p.x + p.halfWidth);
      }
    }
    const sorted = [...g.groups].sort((a, b) => a.x1 - b.x1);
    sorted.forEach((b, i) => i > 0 && expect(b.x1).toBeGreaterThanOrEqual(sorted[i - 1].x2));
    expect(g.groups.map((b) => b.id)).toEqual(['g-pres', 'g-app', 'g-dom', 'g-infra', 'g-ext']);
  });

  it('FR-6.3 compact participant boxes: the name sets the width, stereotypes are truncated to fit', () => {
    const { part } = setup();
    const gw = part('p-gw');
    const nameW = estimateTextWidth(':PaymentGateway', 'participant');
    expect(gw.width).toBeGreaterThanOrEqual(nameW);
    expect(gw.width).toBeLessThanOrEqual(Math.ceil(nameW) + 2 * DEFAULT_LAYOUT.boxPadX); // stereotypes don't widen it
    // «seam» left out: the box is itself an «interface» / «port» (2026-10-29)
    expect(gw.stereoFull).toBe('«interface, port»');
    expect(estimateTextWidth(gw.stereoLine!, 'stereotype')).toBeLessThanOrEqual(gw.width - 2 * DEFAULT_LAYOUT.boxPadX);
  });

  it('FR-6.3 stereotypes share one line: uniform compact header height', () => {
    const { g } = setup();
    const heights = new Set(g.participants.map((p) => p.boxHeight));
    expect(heights.size).toBe(1);
    const o = DEFAULT_LAYOUT;
    // the tallest text block: primary:CustomerRepository on two lines (FR-6.2), no «…» line (its name says «repository»)
    const repo = g.participants.find((p) => p.id === 'p-repo1')!;
    expect([repo.nameLine, repo.stereoLine]).toEqual(['primary', undefined]);
    expect(g.participants[0].boxHeight).toBe(2 * o.boxPadY + 2 * o.labelLineH);
  });

  it('FR-6.2 a long name:Class label goes on two lines (narrower box, one line taller); short and unnamed labels stay on one', () => {
    const d = cloneSequence();
    d.participants.find((p) => p.id === 'p-notify')!.label = 'notifier:NotificationService';
    d.participants.find((p) => p.id === 'p-order')!.label = 'o:Order';
    const { part, g } = setup(d);
    const n = part('p-notify');
    expect([n.nameLine, n.classLine]).toEqual(['notifier', ':NotificationService']);
    expect(n.width).toBe(Math.ceil(estimateTextWidth(':NotificationService', 'participant') + 2 * DEFAULT_LAYOUT.boxPadX));
    expect(n.width).toBeLessThan(estimateTextWidth('notifier:NotificationService', 'participant'));
    expect(part('p-order').nameLine).toBeUndefined(); // short: one line
    expect(part('p-svc').nameLine).toBeUndefined(); // no name
    const o = DEFAULT_LAYOUT;
    // all boxes keep one height: the stereotype line plus the two label lines
    expect(new Set(g.participants.map((p) => p.boxHeight))).toEqual(new Set([2 * o.boxPadY + o.stereoLineH + 2 * o.labelLineH]));
  });

  it('FR-6.3 a long stereotype line widens the box up to a cap, then truncates (full text kept)', () => {
    const d = cloneSequence();
    const gw = d.participants.find((p) => p.id === 'p-gw')!;
    gw.stereotypes = ['interface', 'repository', 'port', 'seam', 'singleton', 'adapter', 'gateway', 'external'];
    const { part } = setup(d);
    const geom = part('p-gw');
    const o = DEFAULT_LAYOUT;
    expect(geom.width).toBeLessThanOrEqual(o.stereoMaxWidth + 2 * o.boxPadX);
    expect(geom.stereoLine!.endsWith('…»')).toBe(true);
    expect(estimateTextWidth(geom.stereoLine!, 'stereotype')).toBeLessThanOrEqual(geom.width - 2 * o.boxPadX);
    // the full text leaves out what the name already says (on …Gateway) and «seam» on an «interface» / «port»
    expect(geom.stereoFull).toBe('«interface, repository, port, singleton, adapter, external»');
    expect(gw.className.toLowerCase().endsWith('gateway')).toBe(true);
  });

  it('a box leaves out the stereotype its name says and «seam» beside the port line; the box tooltip keeps them', () => {
    const d = cloneSequence();
    const gw = d.participants.find((p) => p.id === 'p-gw')!;
    gw.stereotypes = ['repository', 'seam', 'adapter'];
    gw.className = 'ApiEventsRepository';
    gw.implementsInterface = { key: 'src/ports.ts#EventsRepositoryPort', name: 'EventsRepositoryPort' };
    expect(setup(d).part('p-gw').stereoLine).toBe('«adapter»');
    // no port line: «seam» is the only hint how it was reached
    delete gw.implementsInterface;
    expect(setup(d).part('p-gw').stereoLine).toBe('«seam, adapter»');
  });

  it('FR-9 labels that fit are centred; labels wider than their span or on very long spans start at the sender', () => {
    const d = cloneSequence();
    const auto = setup(d);
    const o = DEFAULT_LAYOUT;
    for (const m of auto.g.messages) {
      if (m.kind === 'found' || m.loopX !== undefined || m.x2 <= m.x1) continue;
      const free = m.x2 - m.x1 - m.label.width;
      if (free < 2 * o.labelPad || free > o.senderSideFree) expect(m.labelX).toBeCloseTo(m.x1 + o.labelPad);
      else expect(m.labelX).toBeCloseTo((m.x1 + m.x2) / 2 - m.label.width / 2);
    }
    const m = auto.g.messages.find((x) => x.kind === 'call' && x.x2 > x.x1)!;
    const far = setup(cloneSequence(), { [m.message.to]: auto.part(m.message.to).x + 800 }).msg(m.id);
    expect(far.labelX).toBeCloseTo(far.x1 + o.labelPad);
  });

  it('FR-1.5 nested activation bars are offset from their outer bar', () => {
    const { act } = setup();
    expect(act('root/0:validate').x - act('root').x).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.actW / 2);
  });

  it('FR-8.2 a chosen implementation shows the interface hint', () => {
    const d = cloneSequence();
    Object.assign(d.participants.find((p) => p.id === 'p-gw')!, { label: ':StripeGateway', implementsInterface: { key: 'k', name: 'PaymentGateway' } });
    const { part } = setup(d);
    expect(part('p-gw').hintLine).toBe('«PaymentGateway»');
  });

  it('FR-5.10 a lifeline for several interchangeable objects says how many it stands for', () => {
    const d = cloneSequence();
    Object.assign(d.participants.find((p) => p.id === 'p-gw')!, { instances: 3 });
    const { part } = setup(d);
    expect(part('p-gw').hintLine).toBe('×3');
  });

  it('FR-10.1 manual positions are respected; others keep their order to the right', () => {
    const auto = setup();
    const { part, g } = setup(cloneSequence(), { 'p-svc': auto.part('p-svc').x + 200 });
    expect(part('p-svc').x).toBe(auto.part('p-svc').x + 200);
    expect(part('p-price').x).toBeGreaterThan(part('p-svc').x);
    expect(part('p-ctrl').x).toBe(auto.part('p-ctrl').x);
    expect(boxesOverlap(g)).toBe(false);
  });

  it('FR-10.7 call labels do not push participants apart: neighbours keep the small gap, the label runs past the target', () => {
    const d = cloneSequence();
    const call = d.messages.find((m) => m.kind === 'call' && m.from === 'p-ctrl' && m.to === 'p-svc')!;
    call.args = ['aVeryLongArgumentExpressionThatMakesTheLabelWide', 'anotherLongArgument'];
    const { g, part, msg } = setup(d);
    const ctrl = part('p-ctrl');
    const svc = part('p-svc');
    const m = msg(call.id);
    expect(m.label.width).toBeGreaterThan(svc.x - ctrl.x); // wider than the span …
    // … yet the boxes stay as close as the gap (plus band padding between groups) allows
    expect(svc.x - svc.halfWidth - (ctrl.x + ctrl.halfWidth)).toBeLessThanOrEqual(DEFAULT_LAYOUT.participantGap + DEFAULT_LAYOUT.groupGap + 2 * DEFAULT_LAYOUT.bandPad);
    expect(m.labelX).toBeGreaterThan(ctrl.x); // starts after the sender, runs past the target
    // the diagram is wide enough for every label
    expect(Math.max(...g.messages.map((x) => x.labelX + x.label.width))).toBeLessThanOrEqual(g.width);
  });

  it('FR-10.6 a long «create» label does not push the created object away: it is shortened to its span, «create» and ⊕ stay', () => {
    const plain = setup();
    const d = cloneSequence();
    const create = d.messages.find((m) => m.id === `${P}/3:constructor`)!;
    create.result = { kind: 'assign', target: '$orderAggregateWithALongName', operator: '=' };
    create.className = 'OrderAggregateRootWithAVeryLongDomainName';
    create.args = ['customerWithAllTheirDetails', 'itemsOfTheShoppingCart', 'totalIncludingTaxes'];
    const { part, msg } = setup(d);
    // the participants stay where the short label left them
    for (const p of plain.g.participants) expect(part(p.id).x).toBeCloseTo(p.x);
    const m = msg(create.id);
    // the label ends before the box it creates …
    expect(m.labelX + m.label.width).toBeLessThanOrEqual(m.x2 - DEFAULT_LAYOUT.labelPad + 1);
    // … and keeps «create» and the expand glyph; the result goes first
    const kinds = m.label.segments.map((s) => s.kind);
    expect(kinds).toContain('prefix');
    expect(kinds).toContain('glyph');
    expect(kinds).not.toContain('result');
    // a label that fits is not touched
    expect(plain.msg(create.id).label.segments.map((s) => s.text)).toContain('(customer, items, total)');
  });

  it('FR-10.6 dragged close together, a creation still shows «create» ⊕ and never overlaps its box', () => {
    const d = cloneSequence();
    const tidy = tidyPositions(d, estimateTextWidth);
    const { msg } = setup(d, tidy);
    const m = msg(`${P}/3:constructor`);
    expect(m.labelX + m.label.width).toBeLessThanOrEqual(m.x2);
    expect(m.label.segments.find((s) => s.kind === 'prefix')?.text).toBe('«create»');
  });

  it('FR-10.2 tidy up keeps the order and a small gap; call labels may cross lifelines, creations keep room', () => {
    const d = cloneSequence();
    const pos = tidyPositions(d, estimateTextWidth);
    const { g, part } = setup(d, pos);
    const ids = d.participants.map((p) => p.id);
    const xs = ids.map((id) => pos[id]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(boxesOverlap(g)).toBe(false);
    for (let i = 1; i < ids.length; i++) {
      const a = part(ids[i - 1]);
      const b = part(ids[i]);
      expect(b.x - b.halfWidth - (a.x + a.halfWidth)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.tidyGap - 1);
    }
    for (const m of g.messages) {
      // a «create» label never runs into the box it creates (FR-5.1); call labels may run past the target
      if (m.message.kind === 'create') expect(Math.abs(m.x2 - m.x1)).toBeGreaterThanOrEqual(m.label.width);
    }
    // compacter than the default layout
    expect(g.width).toBeLessThanOrEqual(setup().g.width);
  });

  it('FR-10.2 tidy up preserves the current visual order after a drag; a band stays together', () => {
    const d = cloneSequence();
    const auto = setup(d);
    const current = Object.fromEntries(auto.g.participants.map((p) => [p.id, p.x]));
    current['p-notify'] = current['p-svc'] - 1; // dragged left of OrderService, inside its band
    let pos = tidyPositions(d, estimateTextWidth, current);
    expect(pos['p-notify']).toBeLessThan(pos['p-svc']);
    expect(pos['p-notify']).toBeGreaterThan(pos['p-ctrl']);
    // dragged into another band (right of PriceCalculator): its whole band follows the Application band
    current['p-notify'] = auto.g.participants.find((p) => p.id === 'p-notify')!.x;
    current['p-ctrl'] = current['p-price'] + 1;
    pos = tidyPositions(d, estimateTextWidth, current);
    expect(pos['p-ctrl']).toBeGreaterThan(pos['p-notify']);
    expect(pos['p-ctrl']).toBeLessThan(pos['p-order']);
  });

  it('FR-10.2 tidy up never interleaves bands: objects new after an expand join their band (no overlapping bands)', () => {
    const d = cloneSequence();
    const auto = setup(d);
    // positions known for some; the Domain objects are new (no position yet) and come between Application ones in diagram order
    const current = Object.fromEntries(auto.g.participants.filter((p) => p.participant.groupId !== 'g-dom').map((p) => [p.id, p.x]));
    const order = d.participants.map((p) => p.id);
    d.participants = [...d.participants].sort((a, b) => (a.id === 'p-order' ? order.indexOf('p-price') + 0.5 : order.indexOf(a.id)) - (b.id === 'p-order' ? order.indexOf('p-price') + 0.5 : order.indexOf(b.id)));
    const pos = tidyPositions(d, estimateTextWidth, current);
    const byX = [...d.participants].sort((a, b) => pos[a.id] - pos[b.id]).map((p) => p.groupId);
    // each band's members are adjacent
    expect(byX.filter((g, i) => i === 0 || byX[i - 1] !== g)).toEqual([...new Set(byX)]);
    const { g } = setup(d, pos);
    const bands = [...g.groups].sort((a, b) => a.x1 - b.x1);
    for (let i = 1; i < bands.length; i++) expect(bands[i].x1).toBeGreaterThanOrEqual(bands[i - 1].x2);
  });

  it('FR-10.2 tidy spacing grows with longer labels, but only up to the push cap', () => {
    const d = cloneSequence();
    const msg = d.messages.find((m) => m.id === P)!;
    const gap = (name: string) => {
      msg.methodName = name;
      const pos = tidyPositions(d, estimateTextWidth);
      return pos['p-svc'] - pos['p-ctrl'];
    };
    const short = gap('placeOrder');
    expect(gap('placeOrderWithLongerName')).toBeGreaterThanOrEqual(short);
    const capped = gap('placeOrderWithAVeryLongDescriptiveMethodNameIndeed');
    expect(gap('placeOrderWithAnEvenMuchLongerDescriptiveMethodNameThatKeepsGoing')).toBe(capped);
  });
});

describe('band titles', () => {
  const band = (label: string, layer: string | undefined) => {
    const d = cloneSequence();
    d.groups = d.groups.map((g) => (g.id === 'g-app' ? { ...g, label, layer } : g));
    const g = layoutSequence(d, {}, tidyPositions(d, estimateTextWidth), estimateTextWidth);
    return g.groups.find((x) => x.id === 'g-app')!.displayLabel;
  };
  it('the layer said once; a title too long for the band keeps the folder before it is cut (another band of the layer is drawn), else the layer; one that fits stays whole', () => {
    expect(band('Application · application', 'Application')).toBe('Application');
    expect(band('Application · src/services', 'Application')).toBe('Application · src/services');
    // (the next band starts where this one may grow to: a title of 120 letters is cut)
    const folder = `Services${'x'.repeat(120)}`;
    // the only Application band: the folder tells nothing apart, the layer is the title ("src" said less than "Presentation")
    expect(band(`Application · ${folder}`, 'Application')).toBe('Application');
    // two Application bands: the folder tells them apart
    const two = cloneSequence();
    two.groups = [...two.groups.map((g) => (g.id === 'g-app' ? { ...g, label: `Application · ${folder}` } : g)), { id: 'g-app2', label: 'Application · src/jobs', layer: 'Application', namespace: 'src/jobs' }];
    two.participants.find((p) => p.id === 'p-notify')!.groupId = 'g-app2';
    const long = layoutSequence(two, {}, tidyPositions(two, estimateTextWidth), estimateTextWidth).groups.find((x) => x.id === 'g-app')!.displayLabel;
    expect([long.startsWith('Servicesxx'), long.endsWith('…'), long.length < folder.length]).toEqual([true, true, true]);
    // N20 with a ⊖ at the band's end (FR-28.11): the title stops before it
    const d = cloneSequence();
    d.groups = d.groups.map((g) => (g.id === 'g-app' ? { ...g, label: `Application · ${folder}`, fold: { key: 'layer:Application', name: 'Application' } } : g));
    const folded = layoutSequence(d, {}, tidyPositions(d, estimateTextWidth), estimateTextWidth).groups.find((x) => x.id === 'g-app')!;
    expect(estimateTextWidth(folded.displayLabel, 'group')).toBeLessThanOrEqual(folded.x2 - folded.x1 - 16 - 18);
    const plain = band(`No layer ${'y'.repeat(120)}`, undefined);
    expect([plain.startsWith('No layer yy'), plain.endsWith('…')]).toEqual([true, true]);
  });
});
