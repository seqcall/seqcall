// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, NO_IO, startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// what the picture means, said where a novice looks (hover, View ▾).

function opened(d: SequenceDiagram) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: d });
  return view;
}

const viewMenu = (view: ReturnType<typeof opened>) => {
  fire(view.toolbar.button('view'), 'click');
  return (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
};

describe('FR-14.7 the hover card says why a call is marked', () => {
  it('a red call: the violation and the rule it breaks; a call with a design issue: the issue; other calls: nothing', () => {
    const d = cloneSequence();
    const [a, b, c] = [d.messages[1].id, d.messages[2].id, d.messages[3].id];
    d.findings = [
      { id: 'v', kind: 'layer-violation', title: 'Layer violation: Order → Db', detail: 'Domain → Infrastructure: an inner layer depends on an outer layer', messageIds: [a], classKeys: ['x', 'y'] },
      { id: 'f', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [a, b] },
    ];
    const card = (id: string) => messageCard(d.messages.find((m) => m.id === id)!, document, d) as HTMLElement[];
    const lines = card(a).filter((n) => n.className.startsWith('hc-issue') || n.textContent?.includes('inner layer'));
    expect(lines.map((n) => [n.className, n.textContent])).toEqual([
      ['hc-issue violation', '⚠ Layer violation: Order → Db'],
      ['hc-note', 'Domain → Infrastructure: an inner layer depends on an outer layer'],
      ['hc-issue', '⟳ I/O in a loop: Repo.find (DB)'],
    ]);
    expect(card(b).filter((n) => n.className.startsWith('hc-issue')).map((n) => n.textContent)).toEqual(['⟳ I/O in a loop: Repo.find (DB)']);
    expect(card(c).some((n) => n.className.startsWith('hc-issue'))).toBe(false);
  });
});

describe('FR-14.7 the unknown lifeline says why its calls were not followed', () => {
  const withUnknown = (reasons: (string | undefined)[]) => {
    const d = cloneSequence();
    d.participants.push({ ...d.participants.find((p) => p.id === 'p-log')!, id: 'p-unk', classKey: 'unknown', className: 'unknown', label: 'unknown', kind: 'unknown', stereotypes: [] });
    const parent = d.messages[1];
    reasons.forEach((r, i) => d.messages.push({ ...parent, id: `${parent.id}/9${i}:x${i}`, parentId: parent.id, to: 'p-unk', methodName: `x${i}`, ...(r ? { unresolved: r } : {}), expanded: false, expandable: false }));
    return d;
  };
  const tip = (d: SequenceDiagram) => opened(d).root.querySelector('.participant[data-participant-id="p-unk"] > title')!.textContent!;

  it('lists the reasons of the calls to it, once each; more than five: the rest counted', () => {
    expect(tip(withUnknown(['`x` is typed any.', '`x` is typed any.', 'No declaration found for `y`.', undefined]))).toBe(
      'unknown\nCalls whose target could not be found:\n• `x` is typed any.\n• No declaration found for `y`.',
    );
    const many = tip(withUnknown(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']));
    expect(many.split('\n').slice(-2)).toEqual(['• r5', "+2 more (each call's card says its own)"]);
  });

  it('no reason known: says what the lifeline is; a library lifeline gets no such line', () => {
    const view = opened(withUnknown([undefined]));
    expect(view.root.querySelector('.participant[data-participant-id="p-unk"] > title')!.textContent).toBe('unknown\nCalls whose target could not be found');
    expect(view.root.querySelector('.participant[data-participant-id="p-log"] > title')!.textContent).not.toContain('could not be found');
  });
});

describe('FR-14.7 I/O badges on and none drawn: View ▾ says where they come from', () => {
  it('"none found" with the reason while nothing in the flow does I/O; gone once a call does, or with the badges off', () => {
    const d = cloneSequence();
    const row = viewMenu(opened(d))('view:showSideEffects')!;
    expect(row.querySelector('.menu-hint')!.textContent).toBe('none found');
    expect(row.title).toBe(`Mark calls and classes that do I/O: DB, CACHE, HTTP, FILE, MQ (queues), CLOUD, PROC (processes)\n${NO_IO}`);
    const io = cloneSequence();
    io.messages[2] = { ...io.messages[2], sideEffects: { kinds: ['db'], evidence: ['DB: Repo.find'] } };
    expect(viewMenu(opened(io))('view:showSideEffects')!.querySelector('.menu-hint')).toBeNull();
    const onClass = cloneSequence();
    onClass.participants[0] = { ...onClass.participants[0], sideEffects: { kinds: ['http'], evidence: ['HTTP: fetch'] } };
    expect(viewMenu(opened(onClass))('view:showSideEffects')!.querySelector('.menu-hint')).toBeNull();
    const off = cloneSequence();
    off.options = { ...off.options, showSideEffects: false };
    expect(viewMenu(opened(off))('view:showSideEffects')!.querySelector('.menu-hint')).toBeNull();
  });
});

describe('FR-14.7 How to read this', () => {
  it('View ▾ → How to read this… shows every mark with one sentence; Close closes it', () => {
    const view = opened(cloneSequence());
    viewMenu(view)('view:legend')!.click();
    const card = view.root.querySelector('.popup-layer .legend-card') as HTMLElement;
    expect(card.querySelector('.gc-title')!.textContent).toBe('How to read this diagram');
    const rows = [...card.querySelectorAll('.legend-row')];
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => r.querySelector('svg.legend-glyph')!.childElementCount > 0 && r.querySelector('.legend-text')!.textContent!.length > 20)).toBe(true);
    expect(rows[0].textContent).toContain('"gateway:Gateway" is the field or variable holding it');
    fire(card.querySelector('.gc-btn')!, 'click');
    expect(view.root.querySelector('.legend-card')).toBeNull();
  });
});

describe('FR-8.7 the steps before the flow say what they are', () => {
  it('the DI container\'s step carries DI SETUP at its gate and says why it is there; the entry point keeps its own tag', () => {
    const d = cloneSequence();
    const root = d.messages.find((m) => m.id === 'root')!;
    d.messages.unshift({ ...root, id: 'container', methodName: 'GetRequiredService', className: 'ServiceProvider', expandable: true, expanded: false });
    const view = opened(d);
    const badge = view.body.querySelector('[data-msg-id="container"] .entry-badge') as SVGGElement;
    expect([badge.getAttribute('class'), badge.textContent]).toEqual(['entry-badge kind-setup', 'DI SETUP']);
    const card = messageCard(d.messages[0], document, d).map((n) => n.textContent);
    expect(card).toContain('Setup, not a second entry point: before the entry point runs, the DI container makes its object and the objects it is given. ⊕ shows what it creates.');
    expect(messageCard(root, document, d).some((n) => n.textContent?.startsWith('Setup, not'))).toBe(false);
  });

  it('an unresolved call named by its expression: type arguments shortened on the label, whole in the card', () => {
    const d = cloneSequence();
    const m = { ...d.messages[1], methodName: 'app.withTypeProvider<ZodTypeProvider<Schema>>().route', unresolved: 'no types' };
    d.messages[1] = m;
    const view = opened(d);
    expect(view.body.querySelector(`[data-msg-id="${m.id}"] .seg-name`)!.textContent).toBe('app.withTypeProvider<…>().route');
    expect(messageCard(m, document, d).map((n) => n.textContent).join('\n')).toContain('app.withTypeProvider<ZodTypeProvider<Schema>>().route(');
  });
});

describe('FR-5.13 one lifeline per helper type', () => {
  it('View ▾ has the option, off by default, and sends it; a merged lifeline says ×n and why, each «create» its number', () => {
    const d = cloneSequence();
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const create = d.messages.find((m) => m.kind === 'create')!;
    create.instance = 2;
    const order = d.participants.find((p) => p.id === create.to)!;
    Object.assign(order, { instances: 2, instancesWhy: 'helper' });
    bridge.send({ type: 'render', diagram: d });
    const row = viewMenu(view)('view:mergeHelpers')!;
    expect([row.textContent, row.getAttribute('aria-checked')]).toEqual(['One lifeline per helper type', 'false']);
    row.click();
    expect(bridge.posted.at(-1)).toEqual({ type: 'setOption', option: 'mergeHelpers', value: true });
    expect(view.body.querySelector(`[data-msg-id="${create.id}"] .seg-prefix`)!.textContent).toBe('«create» #2');
    expect(view.root.querySelector(`.participant[data-participant-id="${order.id}"] > title`)!.textContent).toContain(
      '2 objects created in the drawn calls, shown as one (View ▾ → One lifeline per helper type): each «create» #n makes one of them; they may hold different values',
    );
  });
});

describe('FR-6.7 one lifeline per object the container makes once', () => {
  it('the tooltip says it is one object and why: singleton, or once per request', () => {
    const tip = (service: 'singleton' | 'scoped' | 'own', heldAs?: string[]) => {
      const d = cloneSequence();
      d.participants[1] = { ...d.participants[1], service, ...(heldAs ? { heldAs } : {}) };
      return opened(d).root.querySelector(`.participant[data-participant-id="${d.participants[1].id}"] > title`)!.textContent!;
    };
    expect(tip('singleton')).toContain('\none object: the DI container makes it once (singleton) — every field or parameter that holds it here is this object');
    expect(tip('scoped')).toContain('\none object: the DI container makes it once per request (scoped) —');
    expect(tip('singleton', ['_primary', '_replica'])).toContain('is this object (_primary, _replica)');
    const seam = cloneSequence();
    seam.participants[1] = { ...seam.participants[1], service: 'singleton', seamVia: ['IOrderService in OrderController'] };
    expect(opened(seam).root.querySelector(`.participant[data-participant-id="${seam.participants[1].id}"] > title`)!.textContent).toContain(
      '\nno «seam»: only IOrderService in OrderController reaches it through an interface, the other callers hold the class itself',
    );
    seam.participants[1].seamVia = ['IOrderService in OrderController', 'IOrderService in RetryJob'];
    expect(opened(seam).root.querySelector(`.participant[data-participant-id="${seam.participants[1].id}"] > title`)!.textContent).toContain(
      '\nno «seam»: only IOrderService in OrderController, IOrderService in RetryJob reach it through an interface',
    );
    expect(tip('own')).toContain('\none object: its class keeps its only instance (private constructor, a static instance) — its static calls and the calls on that instance are drawn on it');
    expect(opened(cloneSequence()).root.querySelector('.participant > title')!.textContent).not.toContain('one object');
  });
});
