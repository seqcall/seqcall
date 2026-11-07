// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ExitMarker, Fragment, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { layoutSequence } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { startSequenceView } from '../src/sequence/view';
import { cloneSequence, range } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// FR-3.11 what is left of the error paths Smart expand folded, FR-1.22 a followed case — on the mock diagram's
// placeOrder (findById ×2, total, constructor, charge, info).
const P = 'root/1:placeOrder';
const SRC = 'services/order-service.ts';
const fold = (key: string, calls: number, reason: string) => ({ key, calls, reason });

function diagram(edit: (d: SequenceDiagram) => void): SequenceDiagram {
  const d = cloneSequence();
  edit(d);
  return d;
}
function view(d: SequenceDiagram) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const v = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: d });
  const menuItem = (id: string) => v.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
  return { bridge, v, menuItem };
}

const throwing: ExitMarker = {
  id: `${P}!exit0`, ownerMessageId: P, kind: 'throw', guard: '!order.isValid', exception: 'ValidationException', range: range(SRC, 25, 6), beforeId: `${P}/4:charge`,
  errorPath: fold(`${P}#opt0@x0#0`, 2, 'throws ValidationException'),
};
const tryFrame = (catches: Fragment['catches']): Fragment => ({
  id: `${P}#try0@4`, kind: 'try', ownerMessageId: P, range: range(SRC, 28, 4, 7),
  operands: [{ firstMessageId: `${P}/4:charge`, lastMessageId: `${P}/4:charge` }],
  catches,
});
const alt = (extra: Partial<Fragment> = {}): Fragment => ({
  id: `${P}#alt0@0`, kind: 'alt', ownerMessageId: P,
  operands: [
    { guard: 'customer', case: 0, range: range(SRC, 20, 8, 8), firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` },
    { guard: 'else', case: 1, firstMessageId: `${P}/1:findById`, lastMessageId: `${P}/1:findById` },
  ],
  ...extra,
});

describe('FR-3.11 folded error paths', () => {
  it('FR-3.11 an exit marker of a folded branch says how many calls it hides, after its text; a click shows them', () => {
    const d = diagram((x) => (x.exits = [throwing, { ...throwing, id: `${P}!exit1`, errorPath: fold('k1', 1, 'throws X') }]));
    const g = layoutSequence(d, {}, {}, estimateTextWidth);
    expect(g.exits.map((e) => e.fold?.text)).toEqual(['⊕ 2 calls', '⊕ 1 call']);
    expect(g.exits[0].fold!.x).toBeGreaterThan(g.exits[0].x + g.exits[0].width);
    const { bridge, v } = view(d);
    const el = v.body.querySelector('.error-fold')!;
    expect(el.firstChild!.textContent).toBe('⊕ 2 calls');
    expect(el.querySelector('title')!.textContent).toBe('Error path (throws ValidationException), folded (↯ Fold errors). Click to show its calls; ↯ off shows them all');
    fire(el, 'click');
    expect(bridge.last()).toEqual({ type: 'showErrorPath', key: `${P}#opt0@x0#0` });
  });

  it('FR-3.11 a folded catch row: the fold after the guard (a rethrow has no outcome) or after the outcome; the frame encloses it', () => {
    const rethrows = diagram((x) => (x.fragments = [tryFrame([{ guard: 'catch DbError', outcome: '', swallowed: false, errorPath: fold(`${P}#try0@4#1`, 1, 'catch DbError') }])]));
    const g = layoutSequence(rethrows, {}, {}, estimateTextWidth);
    const row = g.fragments[0].operands[1];
    expect(row).toMatchObject({ guard: '[catch DbError]', fold: { text: '⊕ 1 call' } });
    expect(row.outcome).toBeUndefined();
    expect(row.fold!.x).toBe(row.guardX + row.guardWidth + 6);
    expect(g.fragments[0].x2).toBeGreaterThanOrEqual(row.fold!.x + row.fold!.width + 6);
    const logged = diagram((x) => (x.fragments = [tryFrame([{ guard: 'catch DbError', outcome: 'logged, swallowed', swallowed: true, errorPath: fold(`${P}#try0@4#1`, 3, 'catch DbError') }])]));
    const row2 = layoutSequence(logged, {}, {}, estimateTextWidth).fragments[0].operands[1];
    expect(row2.fold!.x).toBeGreaterThan(row2.outcomeX!);
    const { bridge, v } = view(logged);
    fire(v.body.querySelector('.fragment .error-fold')!, 'click');
    expect(bridge.last()).toEqual({ type: 'showErrorPath', key: `${P}#try0@4#1` });
  });

  it('FR-3.11 a branch marker (an error branch without an exit of its own): ⤷ and its guard, then the folded calls', () => {
    const branch: ExitMarker = { id: `${P}!branch0`, ownerMessageId: P, kind: 'branch', guard: 'credentials is null', range: range(SRC, 40, 8), beforeId: `${P}/4:charge`, errorPath: fold(`${P}#alt0@3#0`, 1, 'the other branch succeeds') };
    const g = layoutSequence(diagram((x) => (x.exits = [branch])), {}, {}, estimateTextWidth);
    expect(g.exits.map((e) => `${e.text} ${e.fold!.text}`)).toEqual(['⤷ [credentials is null] ⊕ 1 call']);
  });

  it('FR-3.11 a catch marker (its try frame dropped) says what the catch does; a swallowing one is a warning', () => {
    const swallow: ExitMarker = { id: `${P}!branch1`, ownerMessageId: P, kind: 'branch', guard: 'catch Exception', outcome: 'logged, swallowed', swallowed: true, range: range(SRC, 44, 8), beforeId: `${P}/4:charge` };
    const d = diagram((x) => (x.exits = [swallow]));
    expect(layoutSequence(d, {}, {}, estimateTextWidth).exits.map((e) => e.text)).toEqual(['⤷ [catch Exception] logged, swallowed']);
    const { v } = view(d);
    expect(v.body.querySelector('.exit-marker')!.classList.contains('swallowed')).toBe(true);
    expect(v.body.querySelector('.error-fold')).toBeNull();
  });
});

describe('FR-1.22 follow this case', () => {
  it('FR-1.22 right-click a case of an alternative → Follow this case', () => {
    const { bridge, v, menuItem } = view(diagram((x) => (x.fragments = [alt()])));
    // the else branch (its kind and guard text are inside the guard element)
    fire(v.body.querySelectorAll('.fragment.kind-alt .frag-guard')[1].querySelector('tspan')!, 'contextmenu', { clientX: 40, clientY: 40 });
    expect(menuItem('follow-case')!.textContent).toContain('Follow this case');
    fire(menuItem('follow-case')!, 'click');
    expect(bridge.last()).toEqual({ type: 'followCase', fragmentId: `${P}#alt0@0`, case: 1 });
  });

  it('FR-1.22 a followed alt: "📌 n other cases" after its guard shows them all, so does the guard\'s menu', () => {
    const followed = alt({ operands: [alt().operands[1]], followed: { otherCases: 2 } });
    const { bridge, v, menuItem } = view(diagram((x) => (x.fragments = [followed])));
    const pin = v.body.querySelector('.frag-summary.followed')!;
    expect(pin.firstChild!.textContent).toBe('📌 2 other cases');
    expect(pin.querySelector('title')!.textContent).toContain('You follow this case');
    fire(pin, 'click');
    expect(bridge.last()).toEqual({ type: 'showAllCases', fragmentId: `${P}#alt0@0` });
    fire(v.body.querySelector('.fragment.kind-alt .frag-guard')!, 'contextmenu', { clientX: 40, clientY: 40 });
    fire(menuItem('all-cases')!, 'click');
    expect(bridge.last()).toEqual({ type: 'showAllCases', fragmentId: `${P}#alt0@0` });
    // one other case, or none with calls
    const one = layoutSequence(diagram((x) => (x.fragments = [{ ...followed, followed: { otherCases: 1 } }])), {}, {}, estimateTextWidth);
    expect(one.fragments[0].summary!.text).toBe('📌 1 other case');
    const none = layoutSequence(diagram((x) => (x.fragments = [{ ...followed, followed: { otherCases: 0 } }])), {}, {}, estimateTextWidth);
    expect(none.fragments[0].summary!.text).toBe('📌 followed');
  });

  it('FR-1.22 no follow menu on an opt\'s guard, nor on an alt with one case left', () => {
    const opt: Fragment = { id: `${P}#opt0@0`, kind: 'opt', ownerMessageId: P, operands: [{ guard: 'customer', firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` }] };
    for (const f of [opt, alt({ operands: [alt().operands[0]] })]) {
      const { v } = view(diagram((x) => (x.fragments = [f])));
      fire(v.body.querySelector('.frag-guard')!, 'contextmenu', { clientX: 40, clientY: 40 });
      expect(v.root.querySelector('.popup-layer [data-menu-id]')).toBeNull();
    }
  });
});
