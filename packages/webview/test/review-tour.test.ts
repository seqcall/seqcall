// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EntryPoint, HostToSequenceView, MethodRef, ReviewResult, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { changeStops, ownChange, reviewTour, stopText } from '../src/sequence/review-tour';
import { changeCount } from '../src/sequence/review-bar';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const ref = (cls: string, name: string): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true }) as MethodRef;
const ep = (verb: string, route: string, cls: string): EntryPoint => ({ kind: 'http', verb, label: `${verb} ${route}`, method: ref(cls, 'handle') });
const A = ep('POST', '/orders', 'OrdersController');
const B = ep('GET', '/orders/{id}', 'OrderQueryController');
const C = ep('PUT', '/orders/{id}', 'OrderUpdateController');
const path = (e: EntryPoint, ...keys: string[]) => [{ methodKey: e.method.key, call: { range: { file: 'x', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } } }, ...keys.map((methodKey) => ({ methodKey }))];
const method = (cls: string, name: string, from: EntryPoint[]) => ({ method: ref(cls, name), status: 'changed' as const, lines: [3], reachedFrom: from.map((e) => ({ entryPoint: e, steps: path(e, ref(cls, name).key) })), tests: 0 });
const result: ReviewResult = {
  base: 'develop',
  resolvedBase: 'develop',
  branch: 'feature/x',
  files: [{ file: 'src/Order.ts', path: '/p/src/Order.ts', status: 'modified', added: 3, removed: 1 }],
  methods: [
    method('Order', 'total', [A, B, C]),
    method('Order', 'tax', [B]),
    method('Mailer', 'send', [A]),
    method('Pricing', 'round', [B, C]),
    { method: ref('Util', 'pad'), status: 'added', lines: [1], reachedFrom: [], tests: 0 },
  ],
  issues: [],
  scanned: 3,
  notScanned: 0,
  otherLines: 0,
  computedAt: '2026-10-07T10:00:00.000Z',
};

describe('FR-24.10 the review tour', () => {
  it('each changed method once, in the flow showing the most new ones; an entry point adding nothing is "also from"; unreached methods last', () => {
    const flows = reviewTour(result);
    expect(flows.map((f) => [f.label, f.methods, f.alsoFrom.map((a) => a.label)])).toEqual([
      ['GET /orders/{id}', ['Order.total', 'Order.tax', 'Pricing.round'], ['PUT /orders/{id}']],
      ['POST /orders', ['Mailer.send'], []],
      ['Util.pad', ['Util.pad'], []],
    ]);
    // FR-24.12 a covered entry point keeps what it reaches and the paths to open its own flow
    expect(flows[0].alsoFrom[0]).toEqual({ label: 'PUT /orders/{id}', entryPoint: C, methods: ['Order.total', 'Pricing.round'], paths: [path(C, ref('Order', 'total').key), path(C, ref('Pricing', 'round').key)] });
    expect(flows[1].paths).toEqual([path(A, ref('Mailer', 'send').key)]);
    expect(flows[2].paths).toEqual([[{ methodKey: ref('Util', 'pad').key }]]);
  });

  it('FR-24.2 a method past the walk limit is a flow of its own after the unreached ones, under its own separator', () => {
    const more: ReviewResult = { ...result, methods: [...result.methods, { method: ref('Util', 'trim'), status: 'added', lines: [9], reachedFrom: [], tests: 0, notWalked: true }] };
    const flows = reviewTour(more);
    expect(flows.slice(-2).map((f) => [f.label, f.notWalked ?? false])).toEqual([
      ['Util.pad', false],
      ['Util.trim', true],
    ]);
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'review', state: 'done', result: more });
    (view.root.querySelector('.review-bar [data-cmd="choose-flow"]') as HTMLElement).click();
    const panel = view.root.querySelector('.popup-layer .flow-chooser') as HTMLElement;
    expect([...panel.querySelectorAll('.fc-sep')].map((s) => s.textContent)).toEqual(['Changed methods no entry point reaches', 'Changed methods not walked up to the entry points (limit)']);
  });
});

describe('FR-24.9 the review bar: stepping through the changes of a diagram and through the flows', () => {
  const setup = () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    // a new call, then a collapsed call with changes below it, then a removed one (ghost)
    const ci = d.messages.findIndex((m) => m.expandable && !m.expanded);
    const before = d.messages.findIndex((m, i) => i < ci && m.kind !== 'found');
    const after = d.messages.findIndex((m, i) => i > ci && !m.expandable);
    const collapsed = d.messages[ci];
    d.messages[before].diff = { call: true, status: 'added' };
    collapsed.diff = { inside: 2 };
    d.messages[after].diff = { status: 'removed' };
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'review', state: 'done', result });
    bridge.posted.length = 0;
    const bar = () => (view.reviewBarEl.hidden ? null : (view.root.querySelector('.review-bar') as HTMLElement | null));
    const key = (k: string) => view.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    return { bridge, view, d, collapsed, bar, key, stops: changeStops(d) };
  };

  it('the bar shows the review, the flow and the change; N / P step; a collapsed call with changes below is expanded by the host; the ruler has a tick per change', () => {
    const { bridge, view, d, collapsed, bar, key, stops } = setup();
    expect(bar()!.textContent).toContain('⎇ feature/x vs develop');
    expect(bar()!.querySelector('.rb-flow')!.textContent).toBe('Flow –/3 other diagram ▾');
    expect(bar()!.querySelector('.rb-change')!.textContent).toBe(`Change –/${stops.length} ${stops.length} here — ▶ for the first`);
    expect(view.root.querySelectorAll('.change-ruler .ruler-tick')).toHaveLength(stops.length);
    // the order: by position in the diagram
    expect(stops.map((m) => m.id)).toEqual(d.messages.filter((m) => m.diff).map((m) => m.id));
    key('n');
    expect(bar()!.querySelector('.rb-change')!.textContent).toBe(`Change 1/${stops.length} ${stopText(stops[0])}`);
    expect(view.body.querySelector('.message.highlighted')!.getAttribute('data-msg-id')).toBe(stops[0].id);
    // the next stop has only changes below it: the host expands down to the first, its reply selects it
    key('n');
    expect(bridge.last()).toEqual({ type: 'revealChange', messageId: collapsed.id });
    const below = d.messages.find((m) => m.kind !== 'found' && m.id !== collapsed.id && m.id !== stops[0].id && !m.diff)!;
    below.diff = { method: 'changed' };
    collapsed.expanded = true;
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: below.id });
    expect(view.body.querySelector('.message.highlighted')!.getAttribute('data-msg-id')).toBe(below.id);
    expect(bar()!.querySelector('.rb-change .rb-count')!.textContent).toBe(`Change ${changeStops(d).findIndex((m) => m.id === below.id) + 1}/${changeStops(d).length}`);
    // P goes back to the previous own change
    key('p');
    expect(view.body.querySelector('.message.highlighted')!.getAttribute('data-msg-id')).not.toBe(below.id);
    collapsed.expanded = false;
    below.diff = undefined;
    bridge.send({ type: 'render', diagram: d });
    // the ▲n badge does the same
    fire(view.body.querySelector('.diff-inside')!, 'click');
    expect(bridge.last()).toEqual({ type: 'revealChange', messageId: collapsed.id });
  });

  it('P at the first change opens the previous flow at its last change; at the first flow ◀ is off', () => {
    const { bridge, view, d, bar, key, stops } = setup();
    const highlighted = () => view.body.querySelector('.message.highlighted')!.getAttribute('data-msg-id');
    key('N');
    key('N');
    const second = bridge.last() as Extract<SequenceViewToHost, { type: 'openChangeFlow' }>;
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: stops[0].id });
    expect(highlighted()).toBe(stops[0].id);
    const prev = bar()!.querySelectorAll('.rb-btn')[3] as HTMLButtonElement;
    expect([prev.disabled, prev.title]).toEqual([false, 'Previous change (P): the last change of the previous flow']);
    key('p');
    const first = bridge.last() as Extract<SequenceViewToHost, { type: 'openChangeFlow' }>;
    expect(first.type).toBe('openChangeFlow');
    expect(first.paths).not.toEqual(second.paths);
    // the host selects the flow's first change; the tour goes on to its last own one
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: stops[0].id });
    expect(highlighted()).toBe(stops.filter(ownChange).at(-1)!.id);
    // a flow whose changes are all below collapsed calls: the change the host selected stays
    key('N');
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: stops[0].id });
    const below = cloneSequence();
    const held = below.messages.find((m) => m.expandable && !m.expanded)!;
    held.diff = { inside: 2 };
    key('p');
    expect(bridge.last()!.type).toBe('openChangeFlow');
    bridge.send({ type: 'render', diagram: below });
    bridge.send({ type: 'highlight', messageId: held.id });
    expect(highlighted()).toBe(held.id);
    bridge.send({ type: 'render', diagram: d });
    // the first flow, at its first change: nothing before it
    key('p');
    key('p');
    bridge.posted.length = 0;
    key('p');
    expect(bridge.posted.filter((m) => m.type === 'openChangeFlow')).toEqual([]);
  });

  it('numbered changes: P before change 1 lands on the previous flow\'s last number', () => {
    const { bridge, d, key, stops } = setup();
    d.reviewTotal = 5;
    stops[0].diff = { ...stops[0].diff, positions: [{ n: 1 }] } as never;
    key('N');
    key('N');
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: stops[0].id });
    key('p');
    expect(bridge.last()!.type).toBe('openChangeFlow');
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: stops[0].id });
    // number 5 is not drawn: the host is asked for it
    expect(bridge.last()).toEqual({ type: 'showChange', n: 5 });
  });

  it('FR-24.9 zoomed to layers: changes folded into a drawn call count as steps (one total at every level); ▶ opens the layer and lands on the first of them', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const calls = d.messages.filter((m) => m.kind !== 'found');
    const [crossing, other] = calls;
    const layer = d.participants.find((p) => p.id === crossing.to)!;
    layer.label = 'Application';
    crossing.diff = { folded: 2 }; // two changed calls inside the layer, not drawn
    crossing.expanded = true;
    other.diff = { status: 'added' };
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'review', state: 'done', result });
    bridge.posted.length = 0;
    const bar = () => view.root.querySelector('.review-bar .rb-change') as HTMLElement;
    const key = (k: string) => view.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    // the folded call is a stop and a tick, so the total is the object diagram's
    expect(changeStops(d).map((m) => m.id)).toEqual([crossing.id, other.id]);
    expect(bar().textContent).toBe('Change –/2 2 here — ▶ for the first');
    expect(view.root.querySelectorAll('.change-ruler .ruler-tick')).toHaveLength(2);
    expect(view.body.querySelector('.folded-badge')?.classList.contains('has-changes') ?? true).toBe(true);
    // ▶ on it: the host opens the layer in place (its calls drawn)
    key('n');
    expect(bridge.last()).toEqual({ type: 'setLayerOpen', layer: crossing.to, open: true });
    // the opened diagram: the two changes drawn under the call, the fold gone — the first of them is selected, the total unchanged
    const opened = cloneSequence();
    const oc = opened.messages.filter((m) => m.kind !== 'found');
    oc[0].expanded = true;
    oc[1].diff = { call: true, status: 'changed' };
    oc[1].parentId = oc[0].id;
    oc[2].diff = { method: 'changed' };
    oc[2].parentId = oc[0].id;
    oc[3].diff = { status: 'added' };
    bridge.send({ type: 'render', diagram: opened });
    expect(view.body.querySelector('.message.highlighted')!.getAttribute('data-msg-id')).toBe(oc[1].id);
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 1/3');
  });

  it('FR-24.9 the bar names the layer a folded stop sits in', () => {
    const d = cloneSequence();
    const m = d.messages.find((x) => x.kind !== 'found')!;
    m.diff = { folded: 3 };
    expect(stopText(m, 'Domain')).toBe('▲3 folded in Domain — ▶ opens it');
    m.diff = { folded: 3, call: true };
    expect(stopText(m, 'Domain')).toBe(`~ ${m.className ? `${m.className}.` : ''}${m.methodName}`);
  });

  it('after the last change ▶ says so, then opens the next flow; Shift+N / ⏭ open flows; End review hides the bar', () => {
    const { bridge, view, bar, key, stops } = setup();
    const own = stops.filter((m) => m.diff?.status || m.diff?.call || m.diff?.method);
    // select the last own change through the ruler
    fire([...view.root.querySelectorAll('.change-ruler .ruler-tick')][stops.indexOf(own[own.length - 1])], 'click');
    if (stops[stops.length - 1] === own[own.length - 1]) {
      key('n');
      expect(bar()!.querySelector('.rb-change')!.textContent).toContain('last change here — ▶ opens the next flow');
      key('n');
      expect(bridge.last()).toMatchObject({ type: 'openChangeFlow', entryPoint: { label: 'GET /orders/{id}' } });
    }
    bridge.posted.length = 0;
    key('N');
    expect(bridge.last()).toMatchObject({ type: 'openChangeFlow' });
    const opened = bridge.last() as Extract<SequenceViewToHost, { type: 'openChangeFlow' }>;
    // the host renders the flow and highlights its first change: the bar follows
    const d2 = cloneSequence();
    d2.root = { ...d2.root, key: opened.paths[0][0].methodKey };
    d2.messages[3].diff = { method: 'changed' };
    bridge.send({ type: 'render', diagram: d2 });
    bridge.send({ type: 'highlight', messageId: d2.messages[3].id });
    expect(bar()!.querySelector('.rb-flow .rb-count')!.textContent).toMatch(/^Flow [12]\/3$/);
    expect(bar()!.querySelector('.rb-change')!.textContent).toContain('Change 1/1');
    fire(bar()!.querySelector('.rb-title')!, 'click');
    fire([...view.root.querySelectorAll('.review-panel button')].find((b) => b.textContent === 'End review')!, 'click');
    expect(bar()).toBeNull();
    expect((view.root.querySelector('.change-ruler') as HTMLElement).hidden).toBe(true);
  });

  it('FR-24.10 ⏮ / Shift+P go back to the previous flow (and are off on the first)', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'review', state: 'done', result });
    const flows = reviewTour(result);
    const key = (k: string) => view.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const arrive = (i: number) => {
      const d = cloneSequence();
      d.root = { ...d.root, key: flows[i].paths[0][0].methodKey };
      d.messages[2].diff = { call: true, status: 'added' };
      bridge.send({ type: 'render', diagram: d });
      bridge.send({ type: 'highlight', messageId: d.messages[2].id });
    };
    const prev = () => [...view.root.querySelectorAll('.review-bar .rb-btn')].find((b) => b.textContent === '⏮') as HTMLButtonElement;
    key('N');
    arrive(0);
    expect(view.root.querySelector('.rb-flow .rb-count')!.textContent).toBe('Flow 1/3');
    expect(prev().disabled).toBe(true);
    key('N');
    arrive(1);
    expect(view.root.querySelector('.rb-flow .rb-count')!.textContent).toBe('Flow 2/3');
    expect(prev().disabled).toBe(false);
    bridge.posted.length = 0;
    fire(prev(), 'click');
    expect(bridge.last()).toEqual({ type: 'openChangeFlow', paths: flows[0].paths, entryPoint: flows[0].entryPoint });
    arrive(0);
    key('N');
    arrive(1);
    bridge.posted.length = 0;
    key('P');
    expect(bridge.last()).toEqual({ type: 'openChangeFlow', paths: flows[0].paths, entryPoint: flows[0].entryPoint });
  });
});

describe('FR-24.15 one total per flow: the stops carry how many changes they stand for', () => {
  it('FR-24.15 the tour by number: N / P move one change in the flow\'s fixed order; a change not drawn is asked from the host, back as well as forward', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const iface = d.messages.find((m) => m.id.endsWith('/4:charge'))!;
    const calls = d.messages.filter((m) => m.kind !== 'found');
    const first = calls[calls.indexOf(iface) - 1];
    const last = calls[calls.indexOf(iface) + 1];
    iface.polymorphic!.selectedKey = iface.polymorphic!.implementations[0].key;
    const shown = iface.polymorphic!.implementations[0];
    const other = iface.polymorphic!.implementations.find((i) => i.key !== shown.key)!;
    first.diff = { method: 'changed', count: 1, positions: [{ n: 1 }] };
    // the interface call: its signature (2), the drawn implementation's method (3), one change in the other one (4)
    iface.diff = { status: 'changed', signature: true, method: 'changed', count: 3, positions: [{ n: 2 }, { n: 3, method: true }], held: [4], elsewhere: [{ classKey: other.key, className: other.name, count: 1 }] };
    last.diff = { call: true, status: 'added', count: 1, positions: [{ n: 5 }] };
    d.reviewTotal = 5;
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'review', state: 'done', result });
    bridge.posted.length = 0;
    const bar = () => view.root.querySelector('.review-bar .rb-change') as HTMLElement;
    const key = (k: string) => view.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const lit = () => view.body.querySelector('.message.highlighted')?.getAttribute('data-msg-id');
    expect(bar().textContent).toBe('Change –/5 5 here — ▶ for the first');
    key('n');
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 1/5');
    // each step shows its code diff beside the diagram, as a click on the call does — the diagram keeps the focus
    expect(bridge.posted).toContainEqual({ type: 'openDiff', messageId: first.id, keepFocus: true });
    key('n');
    expect(bar().textContent).toBe(`Change 2/5 ~ PaymentGateway.charge (signature changed)`);
    key('n');
    expect(bar().textContent).toBe(`Change 3/5 ~ ${shown.name}.charge (method changed)`);
    expect(lit()).toBe(iface.id);
    // 4 is in the other implementation: the host shows it
    key('n');
    expect(bridge.last()).toEqual({ type: 'showChange', n: 4 });
    const swapped = structuredClone(d);
    const sw = swapped.messages.find((m) => m.id === iface.id)!;
    sw.polymorphic!.selectedKey = other.key;
    sw.diff = { status: 'changed', signature: true, method: 'changed', count: 3, positions: [{ n: 2 }, { n: 4, method: true }], held: [3], elsewhere: [{ classKey: shown.key, className: shown.name, count: 1 }] };
    expect(bridge.posted.filter((m) => m.type === 'openDiff')).toHaveLength(3); // 1, 2, 3 — not yet 4 (not drawn)
    bridge.send({ type: 'render', diagram: swapped });
    bridge.send({ type: 'highlight', messageId: iface.id });
    expect(bar().textContent).toBe(`Change 4/5 ~ ${other.name}.charge (method changed)`);
    expect(bridge.last()).toEqual({ type: 'openDiff', messageId: iface.id, keepFocus: true, method: true }); // the implementation's method
    // back: 3 is not drawn now — asked from the host again (not skipped to 1)
    bridge.posted.length = 0;
    key('p');
    expect(bridge.last()).toEqual({ type: 'showChange', n: 3 });
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: iface.id });
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 3/5');
    key('p');
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 2/5');
    key('p');
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 1/5');
    expect(lit()).toBe(first.id);
    key('p'); // stays at the first
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 1/5');
    // to the end: 2, 3 (drawn), 4 (host), 5, then "last change"
    key('n');
    key('n');
    key('n');
    expect(bridge.last()).toEqual({ type: 'showChange', n: 4 });
    bridge.send({ type: 'render', diagram: swapped });
    bridge.send({ type: 'highlight', messageId: iface.id });
    key('n');
    expect(bar().querySelector('.rb-count')!.textContent).toBe('Change 5/5');
    expect(lit()).toBe(last.id);
    key('n');
    expect(bar().textContent).toContain('last change here');
  });

  it('FR-24.15 the count text: one change, a range, nothing chosen yet; the total given by the host wins', () => {
    const m = (count: number, folded?: number) => ({ id: String(count), diff: { count, ...(folded ? { folded } : {}) } }) as never;
    const stops = [m(1), m(3), m(0, 2), m(1)];
    expect(changeCount({ stops, current: -1, total: 7 })).toBe('Change –/7');
    expect(changeCount({ stops, current: 0, total: 7 })).toBe('Change 1/7');
    expect(changeCount({ stops, current: 1, total: 7 })).toBe('Changes 2–4/7');
    expect(changeCount({ stops, current: 2, total: 7 })).toBe('Changes 5–6/7');
    expect(changeCount({ stops, current: 3 })).toBe('Change 7/7');
  });
});

describe('FR-24.12 the flows of the review in a list', () => {
  it('the flow label lists every flow with what it reviews; the filter matches entry points and changed methods; a pick opens it', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'review', state: 'done', result });
    const flows = reviewTour(result);
    (view.root.querySelector('.review-bar [data-cmd="choose-flow"]') as HTMLElement).click();
    const panel = view.root.querySelector('.popup-layer .flow-chooser') as HTMLElement;
    const rows = () => [...panel.querySelectorAll('.fc-row:not(.fc-sub)')];
    expect(rows().length).toBe(flows.length);
    expect(rows()[0].querySelector('.fc-label')!.textContent).toBe(`${flows[0].label} · covers 2 entry points`);
    // FR-24.12 the entry point the first flow covers, indented under it, with what it reaches
    const sub = panel.querySelector('.fc-row.fc-sub') as HTMLElement;
    expect(sub.textContent).toBe('↳PUT /orders/{id}2 changed, same as above: Order.total, Pricing.round');
    expect(panel.querySelector('.fc-status')!.textContent).toBe(`${flows.length} flows`); // covered entry points are no flows of their own
    expect(sub.getAttribute('data-flow-index')).toBe('0');
    expect(rows()[0].querySelector('.fc-methods')!.textContent).toBe(`${flows[0].methods.length} changed: ${flows[0].methods.join(', ')}`);
    // the flow of no entry point comes last, after a separator
    expect(panel.querySelector('.fc-sep')!.textContent).toBe('Changed methods no entry point reaches');
    expect(rows().at(-1)!.querySelector('.fc-label')!.textContent).toBe('Util.pad');
    // "where does Mailer.send change?" — typing a method name finds its flow
    const filter = panel.querySelector('.fc-filter') as HTMLInputElement;
    filter.value = 'mailer';
    filter.dispatchEvent(new Event('input'));
    expect(rows().map((r) => r.getAttribute('data-flow-index'))).toEqual([String(flows.findIndex((f) => f.methods.includes('Mailer.send')))]);
    expect(panel.querySelector('.fc-status')!.textContent).toBe(`1 of ${flows.length} flows`);
    // Enter opens the first match
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const target = flows.find((f) => f.methods.includes('Mailer.send'))!;
    expect(bridge.last()).toMatchObject({ type: 'openChangeFlow', paths: target.paths });
    expect(view.root.querySelector('.popup-layer .flow-chooser')).toBeNull();
  });

  it('FR-24.12 a covered entry point opens its own flow; the bar names it and counts it as the flow that shows its changes', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    d.root = { ...d.root, key: B.method.key };
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'review', state: 'done', result });
    const flows = reviewTour(result);
    const bar = () => view.root.querySelector('.review-bar [data-cmd="choose-flow"]') as HTMLElement;
    // the flow's root is open: "1/3 … covers 2 entry points" instead of a bare +1
    expect(bar().textContent).toBe('Flow 1/3 GET /orders/{id} · covers 2 entry points ▾');
    bar().click();
    const panel = view.root.querySelector('.popup-layer .flow-chooser') as HTMLElement;
    (panel.querySelector('.fc-row.fc-sub') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'openChangeFlow', paths: flows[0].alsoFrom[0].paths, entryPoint: C });
    // its diagram arrives: the bar says which entry point is open and whose changes it repeats
    const opened = cloneSequence();
    opened.root = { ...opened.root, key: C.method.key };
    bridge.send({ type: 'render', diagram: opened });
    bridge.send({ type: 'highlight', messageId: null });
    expect(bar().textContent).toBe('Flow 1/3 PUT /orders/{id} · same changes as GET /orders/{id} ▾');
  });
});

describe('FR-24.9 the change ruler follows the panel', () => {
  it('FR-24.9 the ruler stays at the right edge of the scroll area after a resize and below the header after a zoom', () => {
    const root = mount();
    const win = root.ownerDocument.defaultView! as unknown as { ResizeObserver?: unknown };
    const saved = win.ResizeObserver;
    const observed: { el: Element; cb: () => void }[] = [];
    win.ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(el: Element) {
        observed.push({ el, cb: this.cb });
      }
      disconnect() {}
    };
    try {
      const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
      const view = startSequenceView(root, bridge, { measureText: estimateTextWidth });
      let rect = { top: 40, left: 0, right: 600, bottom: 540, width: 600, height: 500 };
      view.scroll.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
      const d = cloneSequence();
      d.messages.find((m) => m.kind !== 'found')!.diff = { call: true, status: 'added' };
      bridge.send({ type: 'render', diagram: d });
      bridge.send({ type: 'review', state: 'done', result });
      const ruler = view.root.querySelector('.change-ruler') as HTMLElement;
      expect(ruler.hidden).toBe(false);
      expect(ruler.style.left).toBe('590px');
      const tops = () => [...ruler.querySelectorAll<HTMLElement>('.ruler-tick')].map((t) => t.style.top);
      const before = tops();
      // the panel gets wider (sidebar closed): the ruler moves to the new right edge, the ticks keep their place
      rect = { ...rect, right: 1000, width: 1000 };
      observed.filter((o) => o.el === view.scroll).forEach((o) => o.cb());
      expect(ruler.style.left).toBe('990px');
      expect(tops()).toEqual(before);
      // zoom in: the header gets taller, the ruler starts below it and still ends at the bottom of the scroll area
      const top = parseFloat(ruler.style.top);
      fire(view.root.querySelector('[data-cmd=zoomIn]')!, 'click');
      expect(parseFloat(ruler.style.top)).toBeGreaterThan(top);
      expect(parseFloat(ruler.style.top) + parseFloat(ruler.style.height)).toBeCloseTo(540, -0.5);
      // still clickable: a tick selects its change
      fire(ruler.querySelector('.ruler-tick')!, 'click');
      expect(view.body.querySelector('.message.highlighted')).not.toBeNull();
    } finally {
      win.ResizeObserver = saved;
    }
  });
});
