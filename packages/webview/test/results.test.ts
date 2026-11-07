// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { HostToSequenceView, Message, SequenceViewToHost } from '@seqcall/protocol';
import { formatMessageLabel, fullCallText, shortType } from '../src/sequence/labels';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, viewOptionRow } from './helpers';

const P = 'root/1:placeOrder';
const base = (m: Partial<Message>): Message => ({
  id: 'root/0:f', parentId: 'root', depth: 1, kind: 'call', from: 'a', to: 'b', methodName: 'findUser', className: 'UserService',
  args: ['id'], isAsync: false, isLibrary: false, expandable: false, expanded: false, recursive: false, ...m,
});
const opts = { showArguments: true, maxArgumentLength: 30 };

describe('FR-9.4 / FR-9.5 results in message labels', () => {
  it('FR-9.4 the assignment target precedes the call; returned values get ↩; long targets are shortened', () => {
    expect(formatMessageLabel(base({ result: { kind: 'assign', target: 'user', operator: '=' } }), opts).result).toBe('user =');
    expect(formatMessageLabel(base({ result: { kind: 'assign', target: 'cache', operator: '??=' } }), opts).result).toBe('cache ??=');
    expect(formatMessageLabel(base({ result: { kind: 'return' } }), opts).result).toBe('↩');
    expect(formatMessageLabel(base({ result: { kind: 'assign', target: '(var providerDetails, createdCouponCycle)', operator: '=' } }), opts).result).toBe('(var providerDe… =');
    expect(formatMessageLabel(base({}), opts).result).toBeUndefined();
  });

  it('FR-9.5 the tooltip shows the full UML form with the return type', () => {
    expect(fullCallText(base({ result: { kind: 'assign', target: 'user', operator: '=' }, returnType: 'User', isAsync: true }))).toBe('user = async UserService.findUser(id): User');
    expect(fullCallText(base({ result: { kind: 'return' }, returnType: 'string' }))).toBe('return UserService.findUser(id): string');
  });

  it('FR-9.4 the view draws the result before the name, and the Results toggle switches it off', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    d.messages.find((m) => m.id === P)!.result = { kind: 'assign', target: 'order', operator: '=' };
    bridge.send({ type: 'render', diagram: d });
    const el = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === P)!;
    const result = el.querySelector('.seg-result')!;
    expect(result.textContent).toBe('order =');
    expect(Number(result.getAttribute('x'))).toBeLessThan(Number(el.querySelector('.seg-name')!.getAttribute('x')));
    expect(viewOptionRow(view, 'showResults').getAttribute('aria-checked')).toBe('true'); // absent option = on
    fire(viewOptionRow(view, 'showResults'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showResults', value: false });
  });
});

describe('FR-9.8 short return types where the label shows no result', () => {
  it('FR-9.8 a call whose value goes elsewhere shows ": Type"; an assigned or returned one does not', () => {
    expect(formatMessageLabel(base({ methodName: 'isValid', returnType: 'boolean' }), opts).args).toBe('(id): boolean');
    expect(formatMessageLabel(base({ returnType: 'User', result: { kind: 'assign', target: 'user', operator: '=' } }), opts).args).toBe('(id)');
    expect(formatMessageLabel(base({ returnType: 'User', result: { kind: 'return' } }), opts).args).toBe('(id)');
    expect(formatMessageLabel(base({ returnType: 'User', kind: 'create' }), opts).args).toBe('(id)');
    expect(formatMessageLabel(base({}), opts).args).toBe('(id)'); // void: no type
    expect(formatMessageLabel(base({ returnType: 'boolean' }), { ...opts, showArguments: false }).args).toBe('(…): boolean');
    expect(formatMessageLabel(base({ returnType: 'boolean' }), { ...opts, showReturnTypes: false }).args).toBe('(id)');
  });

  it('FR-9.8 types are shortened; types that tell nothing (PHP static / mixed, any, void) are left out', () => {
    expect(shortType('Promise<User>')).toBe('User');
    expect(shortType('Task<IReadOnlyList<Coupon>>')).toBe('IReadOnlyList<…>');
    expect(shortType('\\App\\Models\\User')).toBe('User');
    expect(shortType('?\\App\\Models\\User')).toBe('?User');
    expect(shortType('{ id: string; name: string }')).toBe('{…}');
    expect(shortType('(x: number) => string')).toBe('(x: number) => …');
    expect(shortType('A | B | C')).toBe('A | …');
    expect(shortType('VeryLongTypeNameForTesting')).toBe('VeryLongTypeNam…');
    for (const silent of ['void', 'Promise<void>', 'static', '?static', 'static|null', '$this', 'self', 'mixed', 'any', 'unknown', 'never']) expect(shortType(silent)).toBeUndefined();
  });

  it('FR-9.8 the View option "Return types" is on by default and switches the types off', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(viewOptionRow(view, 'showReturnTypes').getAttribute('aria-checked')).toBe('true');
    fire(viewOptionRow(view, 'showReturnTypes'), 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showReturnTypes', value: false });
  });
});
