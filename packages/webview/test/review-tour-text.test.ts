import type { EntryPoint, Message, MethodRef, ReviewResult } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { changeStops, firstNumber, numberText, reviewTour, stopText } from '../src/sequence/review-tour';
import { cloneSequence } from '../dev/mock-data';

const ref = (cls: string, name: string, kind: 'class' | 'module' = 'class'): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind }, isStatic: false, hasBody: true }) as MethodRef;
const ep = (label: string, key: string, verb = 'GET'): EntryPoint => ({ kind: 'http', verb, label: `${verb} ${label}`, method: ref(key, 'handle') });
const steps = (e: EntryPoint, k: string) => [{ methodKey: e.method.key }, { methodKey: k }];
const review = (methods: ReviewResult['methods']): ReviewResult => ({ base: 'main', resolvedBase: 'main', files: [], methods, issues: [], scanned: 0 }) as unknown as ReviewResult;

describe('FR-24.10 the review tour', () => {
  it('FR-24.10 a module function is named without a class; a method reached twice from one entry point keeps the first path', () => {
    const A = ep('/a', 'A');
    const fn = ref('util', 'pad', 'module');
    const r = review([{ method: fn, status: 'added', lines: [1], tests: 0, reachedFrom: [{ entryPoint: A, steps: steps(A, fn.key) }, { entryPoint: A, steps: [{ methodKey: 'other' }] }] }] as never);
    const [flow] = reviewTour(r);
    expect(flow.methods).toEqual(['pad']);
    expect(flow.paths).toEqual([steps(A, fn.key)]);
  });

  it('FR-24.12 two entry points shown the same way (route constraints shortened) are listed once under the flow', () => {
    const A = ep('/orders', 'A');
    const B = ep('/orders/{id:int}', 'B');
    const C = ep('/orders/{id}', 'C');
    const m = ref('Order', 'total');
    const r = review([{ method: m, status: 'changed', lines: [1], tests: 0, reachedFrom: [A, B, C].map((e) => ({ entryPoint: e, steps: steps(e, m.key) })) }] as never);
    const flows = reviewTour(r);
    expect(flows.map((f) => f.label)).toEqual(['GET /orders']);
    expect(flows[0].alsoFrom.map((a) => a.label)).toEqual(['GET /orders/{id}']);
    expect(flows[0].alsoFrom[0].methods).toEqual(['Order.total']);
  });

  it('FR-24.10 a tie: the entry point seen first shows the changes', () => {
    const A = ep('/a', 'A');
    const B = ep('/b', 'B');
    const m = ref('Order', 'total');
    const n = ref('Order', 'tax');
    const r = review([
      { method: m, status: 'changed', lines: [1], tests: 0, reachedFrom: [{ entryPoint: A, steps: steps(A, m.key) }] },
      { method: n, status: 'changed', lines: [1], tests: 0, reachedFrom: [{ entryPoint: B, steps: steps(B, n.key) }] },
    ] as never);
    expect(reviewTour(r).map((f) => f.label)).toEqual(['GET /a', 'GET /b']);
  });
});

describe('FR-24.9 the stops of a diagram and their text', () => {
  const base = cloneSequence().messages.find((m) => m.id === 'root/1:placeOrder')!;
  const msg = (diff: Message['diff'], extra: Partial<Message> = {}): Message => ({ ...base, diff, ...extra });

  it('FR-24.9 no diagram: no stops', () => {
    expect(changeStops(null)).toEqual([]);
  });

  it('FR-24.9 a function (no class) is named by itself; a changed method alone says added / changed', () => {
    expect(stopText(msg({ method: 'added' }, { className: undefined }))).toBe('+ placeOrder (method added)');
    expect(stopText(msg({ method: 'changed' }))).toBe('~ OrderService.placeOrder (method changed)');
  });

  it('only the interface\'s method changed: named, the drawn implementation said unchanged; with its line changed too, both', () => {
    const poly = { polymorphic: { interfaceKey: 'src/i.ts#IOrders', interfaceName: 'IOrders', implementations: [], selectedKey: 'src/s.ts#OrderService' } };
    expect(stopText(msg({ declared: 'changed' }, poly))).toBe('~ IOrders.placeOrder (interface method changed; OrderService.placeOrder unchanged)');
    expect(stopText(msg({ status: 'changed', call: true, declared: 'added' }, poly))).toBe('~ OrderService.placeOrder (interface IOrders.placeOrder added)');
    // no interface on the message: no step text of its own
    expect(stopText(msg({ declared: 'changed', inside: 1 }, { expanded: true }))).toBe('▲1 below OrderService.placeOrder');
  });

  it('FR-24.9 changes below only: "▲n below"; with an own change or other implementations they are named after it', () => {
    expect(stopText(msg({ inside: 3 }, { expanded: true }))).toBe('▲3 below OrderService.placeOrder');
    expect(stopText(msg({ status: 'added', inside: 1 }))).toBe('+ OrderService.placeOrder · ▲1 below — ▶ shows it');
    expect(stopText(msg({ status: 'added', inside: 1, elsewhere: [{ classKey: 'k', className: 'PaypalGateway', count: 2 }] }))).toBe('+ OrderService.placeOrder · ▲1 below · ▲2 in PaypalGateway — ▶ shows them');
    expect(stopText(msg({ elsewhere: [{ classKey: 'k', className: 'PaypalGateway', count: 2 }] }, { expanded: true }))).toBe('▲2 in PaypalGateway — ▶ shows it');
    expect(stopText(msg({ inside: 2, elsewhere: [{ classKey: 'k', className: 'B', count: 1 }] }, { expanded: true }))).toBe('▲2 below · ▲1 in B — ▶ shows them');
    expect(stopText(msg(undefined))).toBe('▲0 below OrderService.placeOrder');
  });

  it('FR-24.9 changes folded into a call, without the layer\'s name', () => {
    expect(stopText(msg({ folded: 2 }))).toBe('▲2 folded in the layer — ▶ opens it');
    expect(stopText(msg({ folded: 2 }), 'Domain')).toBe('▲2 folded in Domain — ▶ opens it');
    expect(stopText(msg({ folded: 2, inside: 1 }, { expanded: false }))).toBe('▲1 below OrderService.placeOrder'); // collapsed: what is below comes first
  });

  it('FR-24.15 a changed call: what it was, its signature, the drawn implementation\'s method', () => {
    const poly = { interfaceKey: 'i', interfaceName: 'IGateway', implementations: [{ key: 'impl', name: 'Stripe', kind: 'class' as const }], selectedKey: 'impl' };
    expect(stopText(msg({ status: 'changed', before: 'Old.run' }))).toBe('~ OrderService.placeOrder (was Old.run)');
    expect(stopText(msg({ status: 'changed', signature: true }))).toBe('~ OrderService.placeOrder (signature changed)');
    expect(stopText(msg({ status: 'changed', method: 'changed' }, { polymorphic: poly }))).toBe('~ OrderService.placeOrder (Stripe.placeOrder changed)');
    expect(stopText(msg({ status: 'changed' }, { polymorphic: { ...poly, selectedKey: 'gone' } }))).toBe('~ OrderService.placeOrder');
    expect(stopText(msg({ status: 'changed' }, { polymorphic: poly }))).toBe('~ OrderService.placeOrder'); // the implementation's method did not change
    expect(stopText(msg({ status: 'changed', method: 'changed' }, { polymorphic: { ...poly, selectedKey: 'gone' } }))).toBe('~ OrderService.placeOrder');
  });

  it('FR-24.15 numbers: the first shown, else the first held; none for no message', () => {
    expect(firstNumber(msg({ positions: [{ n: 4 }], held: [9] }))).toBe(4);
    expect(firstNumber(msg({ held: [9] }))).toBe(9);
    expect(firstNumber(undefined)).toBeUndefined();
  });

  it('FR-24.15 the line for change n: the method change (of the implementation, the class, or a function), the call\'s own change', () => {
    const poly = { interfaceKey: 'i', interfaceName: 'IGateway', implementations: [{ key: 'impl', name: 'Stripe', kind: 'class' as const }], selectedKey: 'impl' };
    expect(numberText(msg({ positions: [{ n: 1, method: true }], method: 'added' }, { polymorphic: poly }), 1)).toBe('~ Stripe.placeOrder (method added)');
    expect(numberText(msg({ positions: [{ n: 1, method: true }] }), 1)).toBe('~ OrderService.placeOrder (method changed)');
    expect(numberText(msg({ positions: [{ n: 1, method: true }] }, { className: undefined }), 1)).toBe('~ placeOrder (method changed)');
    expect(numberText(msg({ positions: [{ n: 1, method: true }] }, { className: undefined, polymorphic: { ...poly, selectedKey: undefined } }), 1)).toBe('~ placeOrder (method changed)');
    expect(numberText(msg({ positions: [{ n: 2 }], status: 'changed' }, { className: undefined }), 2)).toBe('~ placeOrder');
    expect(numberText(msg({ positions: [{ n: 2 }], status: 'changed', before: 'Old.run' }), 2)).toBe('~ OrderService.placeOrder (was Old.run)');
    expect(numberText(msg({ positions: [{ n: 2 }], status: 'changed', signature: true }), 2)).toBe('~ OrderService.placeOrder (signature changed)');
    expect(numberText(msg({ positions: [{ n: 2 }], method: 'added' }), 2)).toBe('+ OrderService.placeOrder (method added)');
    expect(numberText(msg({ positions: [{ n: 2 }], method: 'changed' }), 2)).toBe('~ OrderService.placeOrder (method changed)');
    expect(numberText(msg({ positions: [{ n: 2 }], call: true }), 2)).toBe('~ OrderService.placeOrder');
  });
});
