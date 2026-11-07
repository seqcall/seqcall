import { describe, expect, it } from 'vitest';
import type { EarlyExit, FragmentScope } from '../src/adapter';
import { holdsOnMainPath, offPathOperands, offPathReason, onlyBuildsFailure } from '../src/main-path';
import { at, call } from './fake-world';

// FR-3.9 which branches of a body handle a failure, judged from guards and early exits (shapes of real code:
// validation guards, result checks, catch blocks, status codes).
const scope = (id: string, kind: FragmentScope['kind'], operand: number, guard?: string, negatedGuard?: string): FragmentScope =>
  ({ id, kind, operand, ...(guard !== undefined ? { guard } : {}), ...(negatedGuard !== undefined ? { negatedGuard } : {}) });
const inScope = (...s: FragmentScope[]) => call(0, undefined, { fragments: s });
const ret = (value: string | undefined, ...s: FragmentScope[]): EarlyExit => ({ kind: 'return', range: at('x.ts', 1), ...(value !== undefined ? { value } : {}), fragments: s });
const thr = (exception: string | undefined, ...s: FragmentScope[]): EarlyExit => ({ kind: 'throw', range: at('x.ts', 1), ...(exception ? { exception } : {}), fragments: s });

describe('FR-3.9 main path of a body', () => {
  it('FR-3.9 catch clauses are off the path, the try block, loops and callbacks are on it', () => {
    const tryBlock = scope('try@1', 'try', 0);
    const catchClause = scope('try@1', 'try', 1, 'catch DbException');
    const loop = scope('for@9', 'loop', 0, 'each o of orders');
    const cb = scope('then@20', 'callback', 0, 'promise.then');
    const off = offPathOperands([inScope(tryBlock), inScope(catchClause), inScope(loop), inScope(cb)], []);
    expect([...off]).toEqual([['try@1#1', 'catch DbException']]);
    expect(offPathReason([loop, catchClause], off)).toBe('catch DbException');
    expect(offPathReason([tryBlock], off)).toBeUndefined();
    expect(offPathReason(undefined, off)).toBeUndefined();
  });

  it('FR-3.9 a branch that throws, returns a failure or returns early (a guard clause) is off the path', () => {
    const invalid = scope('if@1', 'opt', 0, 'order.lines.length > 10');
    const notFound = scope('if@2', 'opt', 0, 'user == null');
    const cached = scope('if@3', 'opt', 0, 'cache.has(id)');
    const unsupported = scope('if@4', 'opt', 0, 'integration is null');
    const php = scope('if@5', 'opt', 0, '$invoice->isOverdue()');
    const off = offPathOperands(
      [inScope(invalid), inScope(notFound), inScope(cached), inScope(unsupported), inScope(php)],
      [thr('ValidationException', invalid), ret('NotFound()', notFound), ret('cache.get(id)', cached), ret('UnsupportedCarrier()', unsupported), ret("response()->json(['error' => 'Invalid state'], 422)", php)],
    );
    expect(Object.fromEntries(off)).toEqual({
      'if@1#0': 'throws ValidationException',
      'if@2#0': 'returns NotFound()',
      'if@3#0': 'returns early [cache.has(id)]',
      'if@4#0': 'returns early [integration is null]',
      'if@5#0': "returns response()->json(['error' => 'Invalid state'], 422)",
    });
  });

  it('FR-3.9 not a guard clause: a dispatch on a variant, a success check, a return inside a loop — unless it returns a failure', () => {
    const express = scope('if@1', 'opt', 0, 'kind == Shipping.Express');
    const caseA = scope('switch@2', 'alt', 0, 'kind = Express');
    const circle = scope('if@3', 'opt', 0, 'shape is Circle c');
    const quoted = scope('if@4', 'opt', 0, "mode === 'draft'");
    const delivered = scope('if@5', 'opt', 0, 'delivery.Result.IsSuccess');
    const loop = scope('for@6', 'loop', 0, 'each o of orders');
    const found = scope('if@7', 'opt', 0, 'o.id == id');
    const empty = scope('if@8', 'opt', 0, 'kind == Shipping.None');
    const scopes = [express, caseA, circle, quoted, delivered, found, empty];
    const off = offPathOperands(
      [...scopes.map((s) => inScope(s)), inScope(loop, found)],
      [ret('ShipExpress(order)', express), ret('a', caseA), ret('c.Area()', circle), ret('draft(doc)', quoted), ret('', delivered), ret('o', loop, found), ret('null', empty)],
    );
    expect(Object.fromEntries(off)).toEqual({ 'if@8#0': 'returns null' });
  });

  it('FR-3.9 an early return that hands over to project code is a dispatch — unless it calls a helper that only builds a failure', () => {
    const found = scope('if@1', 'opt', 0, 'lookup.Value != null');
    const unsupported = scope('if@2', 'opt', 0, 'integration is null');
    const crypto = scope('if@3', 'opt', 0, 'resolver.CanResolve(gw)');
    const m = (owner: string, name: string) => ({ key: `k#${owner}.${name}`, name, owner: { key: `k#${owner}`, name: owner, kind: 'class' }, isStatic: false, hasBody: true }) as never;
    const span = (line: number) => ({ file: '/p/x.ts', start: { line, character: 0 }, end: { line, character: 40 } });
    const report = m('Resolver', 'UnsupportedCarrier');
    const off = offPathOperands(
      [
        call(0, m('Callbacks', 'Process'), { range: at('x.ts', 50, 10), receiver: { kind: 'field', name: '_callbacks' }, fragments: [found] }),
        call(1, report, { range: at('x.ts', 60, 10), receiver: { kind: 'self' }, fragments: [unsupported] }),
        call(2, m('Preparation', 'PrepareInfo'), { range: at('x.ts', 70, 10), receiver: { kind: 'self' }, fragments: [crypto] }),
      ],
      [
        { kind: 'return', value: 'await _callbacks.Process(p)', range: span(50), fragments: [found] },
        { kind: 'return', value: 'UnsupportedCarrier()', range: span(60), fragments: [unsupported] },
        { kind: 'return', value: 'await PrepareInfo(gw)', range: span(70), fragments: [crypto] },
      ],
      (c) => c.target === report,
    );
    expect(Object.fromEntries(off)).toEqual({ 'if@2#0': 'returns early [integration is null]' });    // without a helper check, any hand-over is a dispatch
    expect(offPathOperands([call(1, report, { range: at('x.ts', 60, 10), receiver: { kind: 'self' }, fragments: [unsupported] })], [{ kind: 'return', value: 'UnsupportedCarrier()', range: span(60), fragments: [unsupported] }]).size).toBe(0);
  });

  it('FR-3.9 not a bail-out: a branch that does work before it returns, or returns a success', () => {
    const locked = scope('if@1', 'opt', 0, '$lock->get()');
    const found = scope('if@2', 'opt', 0, 'codes.TryGetValue(code, out var id)');
    const work = { key: 'k#Pay.Process', name: 'Process', owner: { key: 'k#Pay', name: 'Pay', kind: 'class' }, isStatic: false, hasBody: true } as never;
    const log = { key: 'k#AppLogger.warn', name: 'warn', owner: { key: 'k#AppLogger', name: 'AppLogger', kind: 'class' }, isStatic: false, hasBody: true } as never;
    const missing = scope('if@3', 'opt', 0, 'zone is null');
    const off = offPathOperands(
      [call(0, work, { range: at('x.ts', 10, 4), fragments: [locked] }), call(1, log, { range: at('x.ts', 30, 4), fragments: [missing] })],
      [ret("$this->output(['done' => 1])", locked), ret('(id, new Details { Status = Status.Ok })', found), ret('', missing)],
    );
    // logging is no work: the null check still bails out
    expect(Object.fromEntries(off)).toEqual({ 'if@3#0': 'returns early [zone is null]' });
  });

  it('FR-3.9 a helper only builds a failure when every call of its body does', () => {
    const fail = call(0, undefined, { methodName: 'Result.Failure' });
    const err = call(1, undefined, { kind: 'create', methodName: 'constructor', receiverType: { key: 'k#NotProvisionedError', name: 'NotProvisionedError', kind: 'class' } });
    expect(onlyBuildsFailure([fail, err])).toBe(true);
    expect(onlyBuildsFailure([fail, call(2, undefined, { methodName: 'Load' })])).toBe(false);
    expect(onlyBuildsFailure([call(3, undefined, { kind: 'create', methodName: 'constructor' })])).toBe(false);
    expect(onlyBuildsFailure([])).toBe(false);
  });

  it('FR-3.9 "no error" is a success check; a PHP class constant makes a dispatch', () => {
    const noError = scope('if@1', 'opt', 0, 'errorType == null');
    const noErr = scope('if@2', 'opt', 0, '!err');
    const status = scope('if@3', 'opt', 0, '$this->data[Req::STATUS] == Req::STATUS_UNPAID');
    const own = scope('if@4', 'opt', 0, '$this->data[self::TYPE] == self::TYPE_REFUND');
    const off = offPathOperands([noError, noErr, status, own].map((s) => inScope(s)), [ret('new ApiResult()', noError), ret('value', noErr), ret('$this->notConfirmed()', status), ret('x', own)]);
    expect(off.size).toBe(0);
  });

  it('FR-3.9 a branch that builds an error is off the path, also without an exit (a conditional in the last return)', () => {
    const currency = scope('cond@1', 'alt', 1, 'else', '!(currencies.Includes(c))');
    const missing = scope('if@2', 'opt', 0, 'stock < qty');
    const php = scope('if@3', 'opt', 0, '!$user->can($a)');
    const off = offPathOperands(
      [
        call(0, undefined, { methodName: 'Result.Failure', fragments: [currency] }),
        call(1, undefined, { kind: 'create', methodName: 'constructor', receiverType: { key: 'x#OutOfStockException', name: 'OutOfStockException', kind: 'class' }, fragments: [missing] }),
        call(2, undefined, { methodName: 'abort', fragments: [php] }),
      ],
      [],
    );
    expect(Object.fromEntries(off)).toEqual({ 'cond@1#1': 'calls Failure', 'if@2#0': 'creates OutOfStockException', 'if@3#0': 'calls abort' });
  });

  it('FR-3.9 a creation names its class from the target or the receiver type; a return in a loop without a value, a guard clause without a guard text', () => {
    const a = scope('if@1', 'opt', 0, 'x');
    const b = scope('if@2', 'opt', 0, 'y');
    const loop = scope('for@3', 'loop', 0, 'each o of os');
    const found = scope('if@4', 'opt', 0, 'o.ok');
    const bare = scope('if@5', 'opt', 0);
    const off = offPathOperands(
      [
        call(0, { key: 'k#ParseError.constructor', name: 'constructor', owner: { key: 'k#ParseError', name: 'ParseError', kind: 'class' }, isStatic: false, hasBody: true } as never, { kind: 'create', fragments: [a] }),
        call(1, undefined, { kind: 'create', methodName: 'constructor', fragments: [b] }),
        inScope(loop, found),
        inScope(bare),
      ],
      [ret(undefined, loop, found), ret('x', bare)],
    );
    expect(Object.fromEntries(off)).toEqual({ 'if@1#0': 'creates ParseError', 'if@5#0': 'returns early []' });
  });

  it('FR-3.9 of two branches, the one beside a branch that calls Success(…) is off the path', () => {
    const missing = scope('cond@1', 'alt', 0, 'credentials is null', 'credentials is not null');
    const found = scope('cond@1', 'alt', 1, 'else', 'credentials is not null');
    const off = offPathOperands([call(0, undefined, { methodName: 'MissingCredentials', fragments: [missing] }), call(1, undefined, { methodName: 'Result.Success', fragments: [found] })], []);
    expect([...off]).toEqual([['cond@1#0', 'the other branch succeeds']]);
    // and the other way round
    const okFirst = offPathOperands([call(0, undefined, { methodName: 'Ok', fragments: [{ ...missing, guard: 'found' }] }), call(1, undefined, { methodName: 'Retry', fragments: [found] })], []);
    expect([...okFirst]).toEqual([['cond@1#1', 'the other branch succeeds']]);
  });

  it('FR-3.9 a bare return is a failure unless its guard says it worked; a rethrow counts as a throw', () => {
    const disposed = scope('if@1', 'opt', 0, '_closed');
    const delivered = scope('if@2', 'opt', 0, 'delivery.Result.IsSuccess');
    const rethrow = scope('if@3', 'opt', 0, 'retries > 3');
    const off = offPathOperands([inScope(disposed), inScope(delivered), inScope(rethrow)], [ret('', disposed), ret('', delivered), thr(undefined, rethrow)]);
    expect(Object.fromEntries(off)).toEqual({ 'if@1#0': 'returns early [_closed]', 'if@3#0': 'throws rethrow' });
  });

  it('FR-3.9 a failure check is off the path without an exit; a missing value alone is not', () => {
    const guards = ['!result.ok', '!saveResult.IsSuccess', 'result.status != Status.Ok', 'response.IsFailure', 'error instanceof ApiError', '!Guid.TryParse(id, out var g)', 'x is null', '!user', 'items.length === 0', 'reply.HasError == false'];
    const scopes = guards.map((g, i) => scope(`if@${i}`, 'opt', 0, g));
    const off = offPathOperands(scopes.map((s) => inScope(s)), []);
    expect([...off.keys()]).toEqual(['if@0#0', 'if@1#0', 'if@2#0', 'if@3#0', 'if@4#0', 'if@5#0']);
    expect(off.get('if@0#0')).toBe('[!result.ok]');
  });

  it('FR-3.9 an else is judged by the negated condition, and the else of a success check is off the path', () => {
    const okThen = scope('if@1', 'alt', 0, 'chargeResult.IsSuccess', '!chargeResult.IsSuccess');
    const okElse = scope('if@1', 'alt', 1, 'else', '!chargeResult.IsSuccess');
    const validThen = scope('if@2', 'alt', 0, 'form.isValid()', '!form.isValid()');
    const validElse = scope('if@2', 'alt', 1, 'else', '!form.isValid()');
    const kindThen = scope('if@3', 'alt', 0, "type === 'express'", "type !== 'express'");
    const kindElse = scope('if@3', 'alt', 1, 'else', "type !== 'express'");
    const off = offPathOperands([okThen, okElse, validThen, validElse, kindThen, kindElse].map((s) => inScope(s)), []);
    expect([...off.keys()]).toEqual(['if@1#1', 'if@2#1']);
    // business variants stay: none of them is "the" main path
    expect(offPathReason([kindElse], off)).toBeUndefined();
  });

  it('FR-3.9 constructs without guard texts: a catch without a type, an else without its condition, a branch without a guard', () => {
    const anyCatch = scope('try@1', 'try', 1);
    const thenNoGuard = scope('if@2', 'alt', 0);
    const elseNoCondition = scope('if@2', 'alt', 1, 'else');
    const off = offPathOperands([anyCatch, thenNoGuard, elseNoCondition].map((s) => inScope(s)), [ret('', elseNoCondition)]);
    // a bare return without a known condition: a failure
    expect(Object.fromEntries(off)).toEqual({ 'try@1#1': 'catch', 'if@2#1': 'returns early []' });
  });

  it('FR-3.9 an exit counts for its innermost branch only; one without a branch is ignored, one without a known value is a guard clause', () => {
    const outer = scope('if@1', 'opt', 0, 'order.isOpen');
    const inner = scope('if@2', 'opt', 0, 'order.total > limit');
    const off = offPathOperands([inScope(outer, inner)], [ret('false', outer, inner), { kind: 'return', range: at('x.ts', 2) }, ret(undefined, outer)]);
    expect(Object.fromEntries(off)).toEqual({ 'if@2#0': 'returns false', 'if@1#0': 'returns early [order.isOpen]' });
  });

  it('FR-3.11 an opt whose condition is a success check holds on the main path', () => {
    expect(holdsOnMainPath(scope('if@1', 'opt', 0, 'result.IsSuccess'))).toBe(true);
    expect(holdsOnMainPath(scope('if@1', 'opt', 0, '!result.IsSuccess'))).toBe(false);
    expect(holdsOnMainPath(scope('if@1', 'alt', 0, 'result.IsSuccess'))).toBe(false);
    expect(holdsOnMainPath(scope('if@1', 'opt', 0))).toBe(false);
  });
});
