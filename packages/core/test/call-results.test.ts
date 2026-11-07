import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { callResult } from '../src/ts/resolve';
import { DEFAULT_OPTIONS } from '../src/session';
import { K, method, sharedAdapter } from './helpers';

/** callResult of the first call to `name` in a snippet. */
function resultOf(code: string, name = 'f') {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | ts.NewExpression | undefined;
  const visit = (n: ts.Node) => {
    if (!found && (ts.isCallExpression(n) || ts.isNewExpression(n)) && n.expression.getText(sf).endsWith(name)) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return callResult(found!);
}

describe('FR-9.4 where a call result goes (TS)', () => {
  it('FR-9.4 assignments keep the target as written (this. dropped) and the operator', () => {
    expect(resultOf('async function m() { const user = await svc.f(id); }')).toEqual({ kind: 'assign', target: 'user', operator: '=' });
    expect(resultOf('class A { m() { this.cache = this.f(); } }')).toEqual({ kind: 'assign', target: 'cache', operator: '=' });
    expect(resultOf('const { a,\n  b } = f();')).toEqual({ kind: 'assign', target: '{a, b}', operator: '=' });
    expect(resultOf('let x; x ??= (f() as string);')).toEqual({ kind: 'assign', target: 'x', operator: '??=' });
    expect(resultOf('let n = 0; n += f();')).toEqual({ kind: 'assign', target: 'n', operator: '+=' });
  });

  it('FR-9.4 returned values; arguments, conditions and discarded results have none', () => {
    expect(resultOf('function m() { return await f(); }')).toEqual({ kind: 'return' });
    expect(resultOf('const m = () => f();')).toEqual({ kind: 'return' });
    expect(resultOf('g(f());')).toBeUndefined();
    expect(resultOf('if (f()) {}')).toBeUndefined();
    expect(resultOf('svc.f();')).toBeUndefined();
    expect(resultOf('const order = new f();')).toEqual({ kind: 'assign', target: 'order', operator: '=' });
    expect(resultOf('function m() { return new f(); }')).toEqual({ kind: 'return' });
    expect(resultOf('const x = a.f().g();', 'f')).toBeUndefined(); // receiver of a chain
    expect(resultOf('const x = a.f().g();', 'g')).toEqual({ kind: 'assign', target: 'x', operator: '=' });
  });

  it('FR-9.4 the value passes through ?: branches and ?? / || operands, not through the condition', () => {
    expect(resultOf('const x = c ? f() : g();')).toEqual({ kind: 'assign', target: 'x', operator: '=' });
    expect(resultOf('const x = c ? g() : (await f());')).toEqual({ kind: 'assign', target: 'x', operator: '=' });
    expect(resultOf('function m() { return a ?? f(); }')).toEqual({ kind: 'return' });
    expect(resultOf('this.cache = f() || fallback;')).toEqual({ kind: 'assign', target: 'cache', operator: '=' });
    expect(resultOf('const x = f() ? a : b;')).toBeUndefined(); // the condition
    expect(resultOf('const x = f() && a;')).toBeUndefined();
    expect(resultOf('g(c ? f() : 0);')).toBeUndefined();
  });

  it('FR-9.4 / FR-9.5 the adapter reports results and awaited return types', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method(K.getUser));
    const find = calls.find((c) => c.methodName === 'findUser')!;
    expect(find.result).toEqual({ kind: 'assign', target: 'user', operator: '=' });
    expect(find.returnType).toBe('User'); // Promise<User> awaited
    const format = calls.find((c) => c.methodName === 'formatName')!;
    expect(format.result).toBeUndefined(); // an argument of new UserDto(...)
    expect(format.returnType).toBe('string');
    expect(calls.find((c) => c.methodName === 'stringify')!.result).toEqual({ kind: 'return' });
    expect(calls.find((c) => c.kind === 'create')!.result).toEqual({ kind: 'assign', target: 'dto', operator: '=' }); // const dto = new UserDto(...)
    const validate = calls.find((c) => c.methodName === 'validate')!;
    expect(validate.returnType).toBeUndefined(); // void
  });
});

describe('FR-9.4 results option', () => {
  it('FR-9.4 messages carry result and return type; showResults=false drops the result only', async () => {
    const { newSession, file, positionOf } = await import('./helpers');
    expect(DEFAULT_OPTIONS.showResults).toBe(false); // off by default, for a calmer first look
    const s = newSession({ initialState: { options: { ...DEFAULT_OPTIONS, showResults: true } } });
    const d = (await s.openAt(file('src/controllers/user-controller.ts'), positionOf('src/controllers/user-controller.ts', 'this.validate(id);')))!;
    const find = d.messages.find((m) => m.methodName === 'findUser')!;
    expect(find.result).toEqual({ kind: 'assign', target: 'user', operator: '=' });
    expect(find.returnType).toBe('User');
    const off = (await s.setOption('showResults', false))!;
    const find2 = off.messages.find((m) => m.methodName === 'findUser')!;
    expect(find2.result).toBeUndefined();
    expect(find2.returnType).toBe('User'); // the tooltip keeps the type
  });
});
