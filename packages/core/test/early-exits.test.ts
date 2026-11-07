import ts from 'typescript';
import { DEFAULT_OPTIONS } from '../src/session';
import { describe, expect, it } from 'vitest';
import { isTail } from '../src/ts/exits';
import { K, file, method, newSession, positionOf, sharedAdapter } from './helpers';
// FR-3.12 these tests check the frames and catches as the code has them: ↯ Fold errors off
const UNFOLDED = { initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } };

/** isTail of every return / throw statement in a snippet's first function, in source order. */
function tails(code: string): boolean[] {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration)!;
  const out: boolean[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) out.push(isTail(n, fn.body!));
    if (!ts.isFunctionLike(n) || n === fn) ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return out;
}

const SERVICE = 'src/services/user-service.ts';

describe('FR-1.15 early exits', () => {
  it('FR-1.15 only exits after which the method may continue are early (tail position is not)', () => {
    expect(tails('function f(x) { if (!x) return; g(); return 1; }')).toEqual([false, true]);
    expect(tails('function f(x) { if (x) { return a(); } else { throw new E(); } }')).toEqual([true, true]);
    expect(tails('function f(xs) { for (const x of xs) { if (x) return x; } return 0; }')).toEqual([false, true]);
    expect(tails('function f(k) { switch (k) { case 1: return a(); default: g(); } h(); }')).toEqual([false]);
    expect(tails('function f() { try { return a(); } catch { throw new E(); } }')).toEqual([true, true]);
    expect(tails('function f() { const cb = () => { return 1; }; g(cb); }')).toEqual([]); // lambdas are not the body
  });

  it('FR-1.15 tail position through switch cases, labels and a `with` body', () => {
    // a case ending in `return` (then only `;` / `break`) is tail when the switch is; code after it in the case is not
    expect(tails('function f(k) { switch (k) { case 1: return a(); ; break; case 2: if (k) return 2; g(); break; } }')).toEqual([true, false]);
    // a labelled block is passed through
    expect(tails('function f(x) { l: { if (x) return 1; } }')).toEqual([true]);
    expect(tails('function f(x) { l: { if (x) return 1; } g(); }')).toEqual([false]);
    // any other statement around it (`with`, sloppy JS): not known to be the last, so early
    expect(tails('function f(o) { with (o) return 1; }')).toEqual([false]);
  });

  it('FR-1.15 the TS adapter reports kind, exception and enclosing scopes', async () => {
    const exits = await sharedAdapter().getEarlyExits!(await method(K.findUser));
    expect(exits.map((e) => [e.kind, e.exception, e.range.start.line + 1, e.fragments?.map((f) => `${f.kind}:${f.guard}`)])).toEqual([
      ['return', undefined, 17, ['opt:cached']],
      ['throw', 'Error', 21, ['opt:!user']],
    ]);
  });

  it('FR-1.15 exits are placed among the calls; the marker states the guard unless a frame around it does', async () => {
    const s = newSession(UNFOLDED);
    const d = (await s.openAt(file(SERVICE), positionOf(SERVICE, 'const cached')))!;
    expect(d.exits?.map((e) => ({ id: e.id, kind: e.kind, guard: e.guard, exception: e.exception, beforeId: e.beforeId }))).toEqual([
      { id: 'root!exit0', kind: 'return', guard: 'cached', exception: undefined, beforeId: 'root/1:findById' },
      { id: 'root!exit1', kind: 'throw', guard: '!user', exception: 'Error', beforeId: undefined }, // new Error is a hidden library call
    ]);
    expect(d.fragments ?? []).toEqual([]); // guard clauses without visible calls make no frames

    // with library calls the `new Error` is drawn: its frame encloses the throw, the marker needs no guard
    const lib = (await s.setOption('showLibraryCalls', true))!;
    const frame = lib.fragments!.find((f) => f.operands[0].guard === '!user')!;
    expect(frame.operands[0].lastMessageId).toBe('root!exit1');
    expect(lib.exits!.find((e) => e.id === 'root!exit1')!.guard).toBeUndefined();

    // Fragments off: no exits either
    const off = (await s.setOption('showFragments', false))!;
    expect(off.exits).toBeUndefined();
  });
});
