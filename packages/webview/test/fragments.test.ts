// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Fragment, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { layoutSequence } from '../src/sequence/layout';
import { guardGhosts } from '../src/sequence/guard-ghosts';
import { estimateTextWidth } from '../src/measure';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { cloneSequence, range } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge, viewOptionRow } from './helpers';

const P = 'root/1:placeOrder';
const N = `${P}/6:notifyCustomer`;
const LONG = 'customer.preferences.notifications.enabled && order.total > customer.limit';

/** alt (two branches) and a loop with a nested opt in placeOrder, an opt inside the expanded notifyCustomer. */
function fragments(): Fragment[] {
  return [
    {
      id: `${P}#if@1`, kind: 'alt', ownerMessageId: P, range: range('services/order-service.ts', 20, 8, 8),
      operands: [
        { guard: 'customer', range: range('services/order-service.ts', 20, 8, 8), firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` },
        { guard: 'else', range: range('services/order-service.ts', 21, 4, 4), firstMessageId: `${P}/1:findById`, lastMessageId: `${P}/1:findById` },
      ],
    },
    {
      id: `${P}#loop@2`, kind: 'loop', ownerMessageId: P, range: range('services/order-service.ts', 22, 8, 20),
      operands: [{ guard: 'each item of items', firstMessageId: `${P}/2:total`, lastMessageId: `${P}/3:constructor` }],
    },
    {
      id: `${P}#if@3`, kind: 'opt', ownerMessageId: P, parentId: `${P}#loop@2`,
      operands: [{ guard: LONG, firstMessageId: `${P}/3:constructor`, lastMessageId: `${P}/3:constructor` }],
    },
    {
      id: `${N}#if@4`, kind: 'opt', ownerMessageId: N,
      operands: [{ guard: 'attempt < 3', firstMessageId: `${N}/0:notifyCustomer`, lastMessageId: `${N}/0:notifyCustomer` }],
    },
  ];
}

function withFragments(): SequenceDiagram {
  const d = cloneSequence();
  d.fragments = fragments();
  return d;
}

describe('sequence layout: combined fragments (FR-1.10)', () => {
  const g = layoutSequence(withFragments(), {}, {}, estimateTextWidth);
  const frag = (id: string) => g.fragments.find((f) => f.id === id)!;
  const msg = (id: string) => g.messages.find((m) => m.id === id)!;
  const act = (id: string) => g.activations.find((a) => a.messageId === id)!;
  const part = (id: string) => g.participants.find((p) => p.id === id)!;

  it('FR-1.10 a frame encloses its messages, their nested activations and the lifelines involved', () => {
    const loop = frag(`${P}#loop@2`);
    expect(loop.y1).toBeLessThan(msg(`${P}/2:total`).box.y);
    // the create's subtree (assertValid) and its activation are inside
    expect(loop.y2).toBeGreaterThan(act(`${P}/3:constructor/0:assertValid`).y2);
    expect(loop.y2).toBeGreaterThanOrEqual(act(`${P}/3:constructor`).y2);
    expect(loop.x1).toBeLessThan(part('p-svc').x);
    expect(loop.x2).toBeGreaterThan(part('p-order').x + part('p-order').halfWidth);
    // following messages are below the frame
    expect(msg(`${P}/4:charge`).box.y).toBeGreaterThan(loop.y2);
  });

  it('FR-1.10 alt operands are separated between their messages', () => {
    const alt = frag(`${P}#if@1`);
    expect(alt.operands.map((o) => o.guard)).toEqual(['[customer]', '[else]']);
    expect(alt.operands[0].y).toBe(alt.y1);
    expect(alt.operands[1].y).toBeGreaterThan(msg(`${P}/0:findById`).y);
    expect(alt.operands[1].y).toBeLessThan(msg(`${P}/1:findById`).box.y);
    expect(alt.y2).toBeLessThan(frag(`${P}#loop@2`).y1);
  });

  it('FR-1.10 nested frames lie inside their parent; guards are abbreviated with the full text kept', () => {
    const loop = frag(`${P}#loop@2`);
    const opt = frag(`${P}#if@3`);
    expect(opt.x1).toBeGreaterThan(loop.x1);
    expect(opt.x2).toBeLessThan(loop.x2);
    expect(opt.y1).toBeGreaterThan(loop.y1);
    expect(opt.y2).toBeLessThan(loop.y2);
    expect(opt.operands[0].guard!.length).toBeLessThan(LONG.length);
    expect(opt.operands[0].guardFull).toBe(LONG);
    // tag and guard fit into the frame
    expect(opt.x2).toBeGreaterThanOrEqual(opt.operands[0].guardX + opt.operands[0].guardWidth);
  });

  it('FR-1.16 a wide frame: the guard stays at its owner\'s bar; out of view, a copy floats at the edge of the view', () => {
    // the owner (OrderService) far right, the repositories it calls far left: the frame spans both
    const far = layoutSequence(withFragments(), {}, { 'p-svc': 1500, 'p-repo1': 120, 'p-repo2': 300 }, estimateTextWidth);
    const alt = far.fragments.find((f) => f.id === `${P}#if@1`)!;
    const owner = far.activations.find((a) => a.messageId === P)!;
    expect(owner.x - alt.x1).toBeGreaterThan(1000);
    expect(alt.operands[0].guardX).toBeGreaterThanOrEqual(owner.x + 10); // next to the first call it guards
    // the tag far away: the kind is written before the guard
    expect(alt.operands[0].kindWidth).toBeGreaterThan(0);
    const y = alt.operands[0].guardY;
    // looking at the left end (the tag is on screen, the guard far right): `alt [customer] →` at the right edge
    let ghosts = guardGhosts(far, { left: alt.x1 - 20, right: alt.x1 + 400, top: y - 50, bottom: y + 300 }, estimateTextWidth).filter((g) => g.fragmentId === alt.id);
    expect(ghosts.map((g) => [g.operand, g.text, g.side])).toEqual([[0, 'alt [customer] →', 'right'], [1, 'alt [else] →', 'right']]);
    expect(ghosts[0].x + estimateTextWidth(ghosts[0].text, 'args')).toBeLessThanOrEqual(alt.x1 + 400);
    expect(ghosts[0].targetX).toBe(alt.operands[0].guardX);
    // the guard on screen: no copy
    ghosts = guardGhosts(far, { left: owner.x - 100, right: owner.x + 400, top: y - 50, bottom: y + 300 }, estimateTextWidth).filter((g) => g.fragmentId === alt.id);
    expect(ghosts).toEqual([]);
    // right of the guard (a frame reaching far right), the tag out of view too: `← alt [customer]` at the left edge
    const wide = { ...far, fragments: [{ ...alt, x2: 4000 }] };
    ghosts = guardGhosts(wide, { left: 3000, right: 3400, top: y - 50, bottom: y + 300 }, estimateTextWidth);
    expect(ghosts[0]).toMatchObject({ text: '← alt [customer]', side: 'left', x: 3006 });
    // the guard's line scrolled under the frozen header: no copy
    expect(guardGhosts(far, { left: alt.x1, right: alt.x1 + 400, top: y + 100, bottom: y + 600 }, estimateTextWidth).filter((g) => g.fragmentId === alt.id && g.operand === 0)).toEqual([]);
  });

  it('FR-1.16 an operand without a guard (a try block) has no copy; a sliver of the frame on screen has no room for one', () => {
    const d = withFragments();
    const alt = d.fragments!.find((f) => f.id === `${P}#if@1`)!;
    alt.kind = 'try';
    alt.operands[0].guard = undefined;
    alt.operands[1].guard = 'catch (e)';
    const far = layoutSequence(d, {}, { 'p-svc': 1500, 'p-repo1': 120, 'p-repo2': 300 }, estimateTextWidth);
    const fg = far.fragments.find((f) => f.id === alt.id)!;
    const y = fg.operands[0].guardY;
    const view = { left: fg.x1 - 20, right: fg.x1 + 400, top: y - 50, bottom: y + 300 };
    expect(guardGhosts(far, view, estimateTextWidth).filter((g) => g.fragmentId === alt.id).map((g) => [g.operand, g.text, g.title])).toEqual([[1, 'try [catch (e)] →', '[catch (e)] — click to scroll to it']]);
    // only 30 px of the frame on screen (its right end is far away)
    expect(guardGhosts(far, { ...view, left: fg.x2 - 30, right: fg.x2 + 400 }, estimateTextWidth).filter((g) => g.fragmentId === alt.id)).toEqual([]);
  });

  it('FR-1.16 the copy is drawn in the view and a click scrolls to the real guard', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const v = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const s = v.root.querySelector('.seq-scroll') as HTMLElement;
    Object.defineProperty(s, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(s, 'clientHeight', { configurable: true, value: 2000 });
    bridge.send({ type: 'render', diagram: withFragments(), positions: { 'p-svc': 1500, 'p-repo1': 120, 'p-repo2': 300 } });
    const ghost = v.body.querySelector('.guard-ghost') as SVGTextElement | null;
    expect(ghost?.textContent).toBe('alt [customer] →');
    fire(ghost!, 'click');
    expect(s.scrollLeft).toBeGreaterThan(1000);
    expect(bridge.posted.some((m) => m.type === 'navigate')).toBe(false);
  });

  it('FR-1.10 a fragment inside an expanded call belongs to that activation', () => {
    const opt = frag(`${N}#if@4`);
    const owner = act(N);
    expect(opt.x1).toBeLessThanOrEqual(owner.x);
    expect(opt.y1).toBeGreaterThan(msg(N).y);
    expect(opt.y2).toBeLessThanOrEqual(owner.y2);
  });

  it('FR-1.10 compact: each frame costs one tag row, one row per extra operand and a small bottom padding', () => {
    const plain = layoutSequence(cloneSequence(), {}, {}, estimateTextWidth);
    const o = g.options;
    const extra = g.bodyHeight - plain.bodyHeight;
    // 4 frames, 1 extra operand
    const perFrame = o.rowGap - 2 + o.fragHeaderH - 4 + o.fragPadBottom;
    expect(extra).toBeLessThanOrEqual(4 * perFrame + (4 + o.fragSepH - 4) + 1);
    expect(plain.fragments).toEqual([]);
  });

  it('FR-1.10 fragments referring to messages that are not drawn are ignored', () => {
    const d = withFragments();
    d.fragments!.push({ id: 'x', kind: 'opt', ownerMessageId: 'root', operands: [{ firstMessageId: 'nope', lastMessageId: 'nope' }] });
    expect(layoutSequence(d, {}, {}, estimateTextWidth).fragments).toHaveLength(4);
  });
});

describe('sequence view: combined fragments (FR-1.10)', () => {
  let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
  let view: SequenceView;
  beforeEach(() => {
    bridge = testBridge();
    view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: withFragments() });
    bridge.posted.length = 0;
  });
  const fragEl = (id: string) => [...view.body.querySelectorAll('[data-fragment-id]')].find((e) => e.getAttribute('data-fragment-id') === id)!;

  it('FR-1.10 renders frames with a kind tag, guards in brackets and dashed operand separators', () => {
    const frames = [...view.body.querySelectorAll('.fragment')];
    expect(frames.map((f) => f.querySelector('.frag-tag-text')!.textContent)).toEqual(['alt', 'loop', 'opt', 'opt']);
    const alt = fragEl(`${P}#if@1`);
    // the kind before every guard (the corner tag is often far away), in the frame's colour
    // the kind before a guard whose corner tag is not right beside it (here: the else operand further down)
    expect([...alt.querySelectorAll('.frag-guard')].map((t) => [...t.querySelectorAll('tspan')].map((x) => x.textContent).join(' '))).toEqual(['[customer]', 'alt [else]']);
    expect(alt.querySelector('.frag-guard .frag-kind')!.textContent).toBe('alt');
    expect(alt.querySelectorAll('.frag-sep')).toHaveLength(1);
    // frames are drawn below the messages (messages stay clickable)
    const svgChildren = [...view.body.querySelector('svg')!.children].map((c) => c.getAttribute('class'));
    expect(svgChildren.indexOf('fragments')).toBeLessThan(svgChildren.indexOf('messages'));
    expect(fragEl(`${P}#if@3`).querySelector('.frag-guard title')!.textContent).toContain(LONG);
  });

  it('FR-1.10 clicking the tag navigates to the construct, clicking a guard to its condition', () => {
    fire(fragEl(`${P}#if@1`).querySelector('.frag-tag-text')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: fragments()[0].range });
    fire(fragEl(`${P}#if@1`).querySelectorAll('.frag-guard')[1], 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: fragments()[0].operands[1].range });
  });

  it('FR-1.10 View ▾ "Fragments" is on by default and posts setOption', () => {
    const btn = viewOptionRow(view, 'showFragments');
    expect(btn.getAttribute('aria-checked')).toBe('true');
    fire(btn, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showFragments', value: false });
    const off = withFragments();
    off.options.showFragments = false;
    delete off.fragments;
    bridge.send({ type: 'render', diagram: off });
    // the menu stayed open and was refreshed with the new state
    expect(viewOptionRow(view, 'showFragments').getAttribute('aria-checked')).toBe('false');
    expect(view.body.querySelector('.fragment')).toBeNull();
    fire(viewOptionRow(view, 'showFragments'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showFragments', value: true });
  });
});

/**
 * FR-1.12 as the session sends it: the loop minimized (its messages gone, a stub before charge)
 * and the opt inside the expanded notifyCustomer minimized at the end of that activation.
 */
function withCollapsed(): SequenceDiagram {
  const d = withFragments();
  const folded = new Set([`${P}/2:total`, `${P}/3:constructor`, `${P}/3:constructor/0:assertValid`, `${N}/0:notifyCustomer`]);
  d.messages = d.messages.filter((m) => !folded.has(m.id));
  const [alt, loop, , notify] = d.fragments!;
  d.fragments = [
    alt,
    { ...loop, collapsed: true, hiddenCount: 2, beforeId: `${P}/4:charge`, operands: [{ ...loop.operands[0], firstMessageId: loop.id, lastMessageId: loop.id }] },
    { ...notify, collapsed: true, hiddenCount: 1, operands: [{ ...notify.operands[0], firstMessageId: notify.id, lastMessageId: notify.id }] },
  ];
  return d;
}

describe('sequence layout: minimized fragments (FR-1.12)', () => {
  const g = layoutSequence(withCollapsed(), {}, {}, estimateTextWidth);
  const frag = (id: string) => g.fragments.find((f) => f.id === id)!;
  const msg = (id: string) => g.messages.find((m) => m.id === id)!;
  const act = (id: string) => g.activations.find((a) => a.messageId === id)!;

  it('FR-1.12 a minimized fragment is one short row where its calls were, with the folded count', () => {
    const loop = frag(`${P}#loop@2`);
    expect(loop.y2 - loop.y1).toBe(g.options.fragStubH);
    expect(loop.y1).toBeGreaterThan(frag(`${P}#if@1`).y2);
    expect(loop.y2).toBeLessThan(msg(`${P}/4:charge`).box.y);
    expect(loop.summary?.text).toBe('⋯ 2 calls');
    expect(loop.x2).toBeGreaterThanOrEqual(loop.toggleX + 5);
    // the owner's activation runs through it
    expect(loop.x1).toBeLessThanOrEqual(act(P).x);
    expect(loop.y2).toBeLessThan(act(P).y2);
  });

  it('FR-1.12 without beforeId the stub closes its owner activation', () => {
    const opt = frag(`${N}#if@4`);
    expect(opt.summary?.text).toBe('⋯ 1 call');
    expect(opt.y1).toBeGreaterThan(msg(N).y);
    expect(opt.y2).toBeLessThanOrEqual(act(N).y2);
    expect(msg('root/2:toDto').box.y).toBeGreaterThan(act(N).y2);
  });

  it('FR-1.12 an outer frame encloses a minimized inner one', () => {
    const d = withFragments();
    const opt = d.fragments![2]; // opt inside the loop, around the create
    d.messages = d.messages.filter((m) => !m.id.startsWith(`${P}/3:constructor`));
    d.fragments![1].operands[0].lastMessageId = opt.id;
    d.fragments![2] = { ...opt, collapsed: true, hiddenCount: 1, beforeId: `${P}/4:charge`, operands: [{ ...opt.operands[0], firstMessageId: opt.id, lastMessageId: opt.id }] };
    const g2 = layoutSequence(d, {}, {}, estimateTextWidth);
    const outer = g2.fragments.find((f) => f.id === `${P}#loop@2`)!;
    const inner = g2.fragments.find((f) => f.id === opt.id)!;
    expect(inner.y1).toBeGreaterThan(outer.y1);
    expect(inner.y2).toBeLessThan(outer.y2);
    expect(inner.x1).toBeGreaterThan(outer.x1);
    expect(inner.x2).toBeLessThan(outer.x2);
  });

  it('FR-1.12 minimizing saves height', () => {
    expect(g.bodyHeight).toBeLessThan(layoutSequence(withFragments(), {}, {}, estimateTextWidth).bodyHeight);
  });
});

describe('sequence view: minimize / restore fragments (FR-1.12)', () => {
  let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
  let view: SequenceView;
  beforeEach(() => {
    bridge = testBridge();
    view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  });
  const fragEl = (id: string) => [...view.body.querySelectorAll('[data-fragment-id]')].find((e) => e.getAttribute('data-fragment-id') === id)!;

  it('FR-1.12 the glyph of an expanded fragment posts collapseFragment', () => {
    bridge.send({ type: 'render', diagram: withFragments() });
    const toggle = fragEl(`${P}#loop@2`).querySelector('.frag-toggle')!;
    expect(toggle.getAttribute('data-fragment-action')).toBe('collapse');
    fire(toggle.querySelector('circle')!, 'click');
    expect(bridge.last()).toEqual({ type: 'collapseFragment', fragmentId: `${P}#loop@2` });
  });

  it('FR-1.12 a minimized fragment shows the count; the count and the glyph post expandFragment', () => {
    bridge.send({ type: 'render', diagram: withCollapsed() });
    const el = fragEl(`${P}#loop@2`);
    expect(el.classList.contains('collapsed')).toBe(true);
    expect(el.querySelector('.frag-summary')!.firstChild!.textContent).toBe('⋯ 2 calls');
    fire(el.querySelector('.frag-summary')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandFragment', fragmentId: `${P}#loop@2` });
    bridge.posted.length = 0;
    fire(el.querySelector('.frag-toggle')!, 'click');
    expect(bridge.last()).toEqual({ type: 'expandFragment', fragmentId: `${P}#loop@2` });
    // the tag still navigates to the code
    fire(el.querySelector('.frag-tag-text')!, 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: fragments()[1].range });
  });
});

describe('sequence view: callback frames (FR-1.11)', () => {
  it('FR-1.11 a callback fragment renders like the others, tagged "callback", with an explaining tooltip', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    d.fragments = [{
      id: `${P}#callback0@4`, kind: 'callback', ownerMessageId: P, range: range('services/order-service.ts', 26, 4, 30),
      operands: [{ guard: 'gateway.charge(…).then', firstMessageId: `${P}/5:info`, lastMessageId: `${P}/5:info` }],
    }];
    bridge.send({ type: 'render', diagram: d });
    const el = view.body.querySelector('.fragment.kind-callback')!;
    expect(el.querySelector('.frag-tag-text')!.textContent).toBe('callback');
    expect(el.querySelector('.frag-tag title')!.textContent).toContain('lambda passed to a library function');
    expect(el.querySelector('.frag-guard tspan:last-of-type')!.textContent).toBe('[gateway.charge(…).then]');
  });
});

describe('sequence view: what a catch does with the error (FR-1.17)', () => {
  const catchRange = range('services/order-service.ts', 30, 6, 24);
  function withTry(): SequenceDiagram {
    const d = cloneSequence();
    d.fragments = [{
      id: `${P}#try0@4`, kind: 'try', ownerMessageId: P, range: range('services/order-service.ts', 28, 4, 7),
      operands: [{ firstMessageId: `${P}/4:charge`, lastMessageId: `${P}/4:charge` }],
      catches: [{ guard: 'catch PaymentFailed', outcome: 'logged, swallowed', swallowed: true, range: catchRange }],
    }];
    return d;
  }

  it('FR-1.17 a catch without visible calls is a guard row at the bottom of the frame, with its outcome', () => {
    const g = layoutSequence(withTry(), {}, {}, estimateTextWidth);
    const f = g.fragments[0];
    const charge = g.messages.find((m) => m.id === `${P}/4:charge`)!;
    expect(f.operands).toHaveLength(2);
    expect(f.operands[1]).toMatchObject({ guard: '[catch PaymentFailed]', outcome: 'logged, swallowed', swallowed: true });
    // below the try block's call, inside the frame; the outcome after the guard, inside the frame too
    expect(f.operands[1].y).toBeGreaterThan(charge.y);
    expect(f.y2).toBeGreaterThan(f.operands[1].guardY);
    expect(f.operands[1].outcomeX!).toBeGreaterThan(f.operands[1].guardX + f.operands[1].guardWidth);
    expect(f.x2).toBeGreaterThan(f.operands[1].outcomeX! + estimateTextWidth('logged, swallowed', 'marker'));
    // the next message starts below the frame
    const next = g.messages.find((m) => m.id === `${P}/5:info`)!;
    expect(next.box.y).toBeGreaterThan(f.y2 - 4);
  });

  it('FR-1.17 renders the outcome as a warning when the error is swallowed; the guard navigates to the catch', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: withTry() });
    const el = view.body.querySelector('.fragment.kind-try')!;
    expect(el.querySelectorAll('.frag-sep')).toHaveLength(1);
    const outcome = el.querySelector('.frag-outcome')!;
    expect(outcome.firstChild!.textContent).toBe('logged, swallowed');
    expect(outcome.classList.contains('swallowed')).toBe(true);
    expect(outcome.querySelector('title')!.textContent).toContain('never learns it failed');
    fire(el.querySelectorAll('.frag-guard')[0], 'click');
    expect(bridge.last()).toEqual({ type: 'navigate', range: catchRange });
  });
});
