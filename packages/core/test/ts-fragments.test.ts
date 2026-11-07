import { describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { DEFAULT_TSCONFIG, tsProject } from './ts-project';

// FR-1.10 / FR-1.11 / FR-1.17 the frames around TS calls, for the less common shapes of control flow and callbacks.

const FLOW = `declare function f(...a: unknown[]): number;
declare function g(...a: unknown[]): number;
declare const items: number[];
declare const anyLib: any;
declare const factories: any[];
declare const el: { addEventListener(type: string, cb: () => void): void };
declare const log: (...a: unknown[]) => void;
export function callbacks(deps: unknown[], type: string, a: number, b: number) {
  items.reduce((acc, x) => f(x), 0);
  items.forEach(() => f(1));
  factories[0](() => f(2));
  anyLib.run(1, () => f(3));
  anyLib.useEffect(() => f(4), deps);
  anyLib.useEffect(() => f(5), [a, b]);
  anyLib.requestAnimationFrame(() => f(6));
  anyLib.addEventListener('click', () => f(10));
  anyLib.setInterval(() => f(7));
  anyLib.setTimeout(() => f(8));
  anyLib.setTimeout(500, () => f(11));
  el.addEventListener(type, () => f(9));
}
export function conditions(ready: boolean, a: number, b: boolean) {
  if (!ready) { g(0); } else { f(1); }
  if (a > 1) { g(1); } else { f(2); }
  if (a) { g(2); } else if (f(3)) { g(3); }
  const v = a ? f(4) : b ? f(5) : f(6);
  const w = a ? 1 : f(7) ? 2 : 3;
  const x = a ? 1 : (b ? f(8) : 0);
  return [v, w, x];
}
export function loops(obj: object, x: number) {
  for (let i = f(0); i < f(1); i++) { g(0); }
  for (;;) { g(1); break; }
  for (const y of items.slice(f(2))) { g(2); }
  let k;
  for (k in obj) { g(3, k); }
  for (const z of items) { switch (x) { case f(4): break; } }
}
export function switches(x: number) {
  switch (x) { case 1: f(0); break; case 2: }
  switch (x) { case 3: f(1); }
}
export function tries() {
  try { f(0); } catch (e: unknown) { console.error(e); return; }
  try { f(1); } finally { g(1); }
  try { f(2); } catch { setTimeout(() => { throw new Error('x'); }); (g as any)(); }
  try { f(3); } catch { log('x'); }
}
`;

/** `call → [kind#operand:guard …]` per call site (only the scopes). */
const frames = (calls: CallSite[]) =>
  calls.map((c) => [
    c.expressionText,
    (c.fragments ?? []).map((s) => `${s.kind}${s.operand ? `#${s.operand}` : ''}:${s.guard ?? ''}${s.negatedGuard ? ` (not: ${s.negatedGuard})` : ''}`),
  ]);

describe('FR-1.10 / FR-1.11 frames (TS)', () => {
  const { adapter, method } = tsProject({
    'src/flow.ts': FLOW,
    'src/page.tsx': "declare function List(p: { renderItem: () => unknown }): unknown;\ndeclare function f(): number;\nexport function Page() { return <List renderItem={() => f()} />; }\n",
  }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } }, true);
  const calls = async (name: string) => adapter.getOutgoingCalls(await method(`src/flow.ts#<module>.${name}`));

  it('FR-1.11 callbacks: the element of `reduce` is its second parameter; no parameter: "each of"; when hooks, timers and events run', async () => {
    expect(frames(await calls('callbacks')).filter(([, f]) => f.length)).toEqual([
      ['f(x)', ['loop:each x of items']],
      ['f(1)', ['loop:each of items']],
      ['f(2)', ['callback:factories[0]']],
      ['f(3)', ['callback:anyLib.run']],
      ['f(4)', ['callback:anyLib.useEffect']],
      ['f(5)', ['callback:anyLib.useEffect: when a, b change']],
      ['f(6)', ['callback:anyLib.requestAnimationFrame: next frame']],
      ['f(10)', ['callback:anyLib.addEventListener: on click']],
      ['f(7)', ['callback:anyLib.setInterval']],
      ['f(8)', ['callback:anyLib.setTimeout: after 0 ms']],
      // the callback is not where the timer takes it: no timing
      ['f(11)', ['callback:anyLib.setTimeout']],
      ['f(9)', ['callback:el.addEventListener']],
    ]);
  });

  it('FR-1.11 a JSX prop that is no event handler is named as it is', async () => {
    const [call] = await adapter.getOutgoingCalls(await method('src/page.tsx#<module>.Page'));
    expect(frames([call])).toEqual([['f()', ['callback:List renderItem']]]);
  });

  it('FR-1.10 conditions: the negation of `!x` and of an expression; a call in an else-if condition or a nested `?:` condition; nested `?:` in parentheses', async () => {
    expect(frames(await calls('conditions'))).toEqual([
      ['g(0)', ['alt:!ready']],
      ['f(1)', ['alt#1:else (not: ready)']],
      ['g(1)', ['alt:a > 1']],
      ['f(2)', ['alt#1:else (not: !(a > 1))']],
      ['g(2)', ['alt:a']],
      ['f(3)', ['alt#1:f(3)']],
      ['g(3)', ['alt#1:f(3)']],
      ['f(4)', ['alt:a']],
      ['f(5)', ['alt#1:b']],
      ['f(6)', ['alt#2:else']],
      ['f(7)', ['alt#1:f(7)']],
      ['f(8)', ['alt#1:else (not: !a)', 'alt:b']],
    ]);
  });

  it('FR-1.10 loops: `for` (its initializer runs once; no condition: no guard), the iterated expression runs once, `for … in` over a variable, a call in a `case` label', async () => {
    expect(frames(await calls('loops'))).toEqual([
      ['f(0)', []],
      ['f(1)', ['loop:i < f(1)']],
      ['g(0)', ['loop:i < f(1)']],
      ['g(1)', ['loop:']],
      ['f(2)', []],
      ['items.slice(f(2))', []],
      ['g(2)', ['loop:each y of items.slice(f(2))']],
      ['g(3, k)', ['loop:each k in obj']],
      ['f(4)', ['loop:each z of items', 'opt:x = f(4)']],
    ]);
    // a call in a case label does not leave the loop
    expect((await calls('loops'))[8].fragments![0].leavesLoop).toBeUndefined();
  });

  it('FR-1.10 switch: an empty last case still forms a group; one group without default is `opt`', async () => {
    expect(frames(await calls('switches'))).toEqual([
      ['f(0)', ['alt:x = 1']],
      ['f(1)', ['opt:x = 3']],
    ]);
  });

  it('FR-1.17 try: a typed catch, a bare `return` in it, a logged error (`console.error`, `log`); try/finally has no handler; nested functions do not count', async () => {
    const c = await calls('tries');
    expect(c.map((x) => [x.expressionText.slice(0, 20), x.fragments?.[0]?.handlers?.map((h) => [h.guard, h.outcome, h.value ?? null, h.logged]) ?? null])).toEqual([
      ['f(0)', [['catch unknown', 'return', null, true]]],
      ['console.error(e)', [['catch unknown', 'return', null, true]]],
      ['f(1)', []],
      ['g(1)', null],
      ['f(2)', [['catch', 'swallow', null, false]]],
      ['setTimeout(() => { t', [['catch', 'swallow', null, false]]],
      ["new Error('x')", [['catch', 'swallow', null, false]]],
      ['(g as any)()', [['catch', 'swallow', null, false]]],
      ['f(3)', [['catch', 'swallow', null, true]]],
      ["log('x')", [['catch', 'swallow', null, true]]],
    ]);
  });
});
