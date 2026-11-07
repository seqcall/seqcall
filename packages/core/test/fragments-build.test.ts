import { describe, expect, it } from 'vitest';
import type { Fragment, SourceRange } from '@seqcall/protocol';
import type { FragmentScope } from '../src/adapter';
import { buildFragments } from '../src/session/fragments';

// FR-1.10 / FR-1.12 / FR-1.15 / FR-1.17 combined fragments from the scopes of the drawn calls (the adapters'
// output), on scopes written per test.
const at: SourceRange = { file: 'a.ts', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
const s = (id: string, kind: FragmentScope['kind'], operand: number, guard?: string, extra: Partial<FragmentScope> = {}): FragmentScope => ({
  id,
  kind,
  operand,
  ...(guard !== undefined ? { guard } : {}),
  ...extra,
});
const show = (fs: Fragment[]) =>
  fs.map((f) => `${f.parentId ? '  ' : ''}${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}${o.outcome ? ` → ${o.outcome}` : ''}] ${o.firstMessageId}..${o.lastMessageId}`).join(' ')}${f.catches ? ` catches: ${f.catches.map((c) => `${c.guard} → ${c.outcome}`).join(', ')}` : ''}${f.collapsed ? ` (collapsed ${f.hiddenCount})` : ''}`);

describe('FR-1.10 nested conditions', () => {
  it('FR-1.10 an opt around one opt (or a one-branch alt) on the same calls is one opt; conditions with || / ? / and are put in parentheses', () => {
    const outer = s('if@1', 'opt', 0, 'a || b');
    expect(show(buildFragments('m', [{ id: 'm/0:x', scopes: [outer, s('if@2', 'opt', 0, 'c ? d : e')] }]))).toEqual(['opt [(a || b) && (c ? d : e)] m/0:x..m/0:x']);
    expect(show(buildFragments('m', [{ id: 'm/0:x', scopes: [s('if@1', 'opt', 0, '(a || b)'), s('if@2', 'opt', 0, 'x and y')] }]))).toEqual(['opt [(a || b) && (x and y)] m/0:x..m/0:x']);
    // the inner alt shows only its else branch: its negated condition
    const elseOnly = s('if@2', 'alt', 1, 'else', { negatedGuard: '!ready' });
    expect(show(buildFragments('m', [{ id: 'm/0:x', scopes: [s('if@1', 'opt', 0, 'ok'), elseOnly] }]))).toEqual(['opt [ok && !ready] m/0:x..m/0:x']);
  });

  it('FR-1.10 not merged: an inner alt with two branches, an inner frame around fewer calls, a loop, an else without its condition', () => {
    const outer = s('if@1', 'opt', 0, 'ok');
    const two = buildFragments('m', [
      { id: 'm/0:x', scopes: [outer, s('if@2', 'alt', 0, 'p')] },
      { id: 'm/1:y', scopes: [outer, s('if@2', 'alt', 1, 'else')] },
    ]);
    expect(show(two)).toEqual(['opt [ok] m/0:x..m/1:y', '  alt [p] m/0:x..m/0:x [else] m/1:y..m/1:y']);
    const fewer = buildFragments('m', [{ id: 'm/0:x', scopes: [outer, s('if@2', 'opt', 0, 'q')] }, { id: 'm/1:y', scopes: [outer] }]);
    expect(show(fewer)).toEqual(['opt [ok] m/0:x..m/1:y', '  opt [q] m/0:x..m/0:x']);
    // a loop inside is no condition
    const loop = buildFragments('m', [{ id: 'm/0:x', scopes: [outer, s('for@2', 'loop', 0, 'each u of users')] }]);
    expect(show(loop)).toEqual(['opt [ok] m/0:x..m/0:x', '  loop [each u of users] m/0:x..m/0:x']);
    // an else branch alone whose condition the adapter did not give: stays an alt [else]
    const bare = buildFragments('m', [{ id: 'm/0:x', scopes: [outer, s('if@2', 'alt', 1, 'else')] }]);
    expect(show(bare)).toEqual(['opt [ok] m/0:x..m/0:x', '  alt [else] m/0:x..m/0:x']);
  });

  it('FR-1.10 scopes without a source range: fragments without one', () => {
    const [f] = buildFragments('m', [{ id: 'm/0:x', scopes: [s('for@1', 'loop', 0, 'each u of users')] }]);
    expect(f).toStrictEqual({ id: 'm#for@1', kind: 'loop', ownerMessageId: 'm', operands: [{ guard: 'each u of users', firstMessageId: 'm/0:x', lastMessageId: 'm/0:x' }] });
    const [r] = buildFragments('m', [{ id: 'm/0:x', scopes: [s('for@1', 'loop', 0, 'each u of users', { range: at })] }]);
    expect(r.range).toEqual(at);
    expect(r.operands[0].range).toEqual(at);
  });
});

describe('FR-1.12 / FR-1.15 / FR-1.17 minimized frames, exits, catches', () => {
  it('FR-1.12 a minimized try (no guard, no range) is one stub; next to an exit marker it stays', () => {
    const tryScope = s('try@1', 'try', 0);
    const out = buildFragments('m', [{ id: 'm#try@1', scopes: [tryScope] }, { id: 'm/9:return', scopes: [] }], new Map([['m#try@1', 3]]), new Set(['m/9:return']));
    expect(out).toStrictEqual([{ id: 'm#try@1', kind: 'try', ownerMessageId: 'm', operands: [{ firstMessageId: 'm#try@1', lastMessageId: 'm#try@1' }], collapsed: true, hiddenCount: 3, beforeId: 'm/9:return' }]);
    // with a guard and a range: both on the stub
    const loop = s('for@1', 'loop', 0, 'each o of orders', { range: at });
    expect(buildFragments('m', [{ id: 'm#for@1', scopes: [loop] }], new Map([['m#for@1', 2]]))[0]).toMatchObject({ operands: [{ guard: 'each o of orders', range: at }], range: at });
  });

  it('FR-1.17 a try without catch information and nothing visible in its catches: no frame', () => {
    expect(buildFragments('m', [{ id: 'm/0:x', scopes: [s('try@1', 'try', 0)] }])).toEqual([]);
  });

  it('FR-1.17 a visible catch that rethrows says nothing more, one that returns a value says so; a catch row without a range has none', () => {
    const handlers = [
      { operand: 1, guard: 'catch A', outcome: 'rethrow' as const, logged: false },
      { operand: 2, guard: 'catch B', outcome: 'swallow' as const, logged: true },
      { operand: 3, guard: 'catch C', outcome: 'return' as const, value: 'null', logged: false },
    ];
    const t = (operand: number, guard?: string) => s('try@1', 'try', operand, guard, { handlers });
    const out = buildFragments('m', [
      { id: 'm/0:x', scopes: [t(0)] },
      { id: 'm/1:y', scopes: [t(1, 'catch A')] },
      { id: 'm/2:z', scopes: [t(3, 'catch C')] },
    ]);
    // the visible catch C returns a value: its outcome, not swallowed
    expect(show(out)).toEqual(['try [] m/0:x..m/0:x [catch A] m/1:y..m/1:y [catch C → ↩ null] m/2:z..m/2:z catches: catch B → logged, swallowed']);
    expect(out[0].operands[2]).not.toHaveProperty('swallowed');
    expect(out[0].catches).toStrictEqual([{ guard: 'catch B', outcome: 'logged, swallowed', swallowed: true }]);
  });
});
