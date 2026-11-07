import { describe, expect, it } from 'vitest';
import type { FragmentScope } from '../src/adapter';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';

// FR-1.22 follow one case of an alternative: Checkout.Pay switches on the shipping kind (three cases, one of them
// ends in an early return), then always saves.
const checkout = cls('src/App/Checkout.cs', 'Checkout');
const shop = cls('src/Api/Shop.cs', 'Shop');
const pay = meth(checkout, 'Pay');
const express = meth(checkout, 'Express');
const standard = meth(checkout, 'Standard');
const pickup = meth(checkout, 'Pickup');
const save = meth(checkout, 'Save');
const enter = meth(shop, 'Enter');
const kind = (operand: number, guard: string): FragmentScope => ({ id: 'switch@3', kind: 'alt', operand, guard });
const world = (): World => ({
  methods: [pay, express, standard, pickup, save, enter],
  calls: {
    [enter.key]: [call(0, pay, { range: at('Shop.cs', 4) })],
    [pay.key]: [call(0, express, { fragments: [kind(0, 'shipping = Express')] }), call(1, standard, { fragments: [kind(1, 'shipping = Standard')] }), call(2, pickup, { fragments: [kind(2, 'else')] }), call(3, save)],
  },
  adapter: { getEarlyExits: async (m: { key: string }) => (m.key === pay.key ? [{ kind: 'return', value: 'Ok()', range: at('Checkout.cs', 9, 30), fragments: [kind(2, 'else')] }] : []) },
});
const ids = (d: { messages: { id: string }[] } | undefined) => d!.messages.map((m) => m.id);

describe('FR-1.22 follow this case', () => {
  it('FR-1.22 the alt names its cases; following one leaves the others (and their exits) out; the frame says how many', async () => {
    const s = fakeSession(world());
    const d = (await s.openMethodByKey(pay.key))!;
    const alt = d.fragments!.find((f) => f.kind === 'alt')!;
    expect(alt.id).toBe('root#alt0@0');
    expect(alt.operands.map((o) => o.case)).toEqual([0, 1, 2]);
    expect(d.exits).toHaveLength(1);
    const followed = (await s.followCase(alt.id, 1))!;
    expect(ids(followed)).toEqual(['root', 'root/1:Standard', 'root/3:Save']);
    expect(followed.exits ?? []).toEqual([]);
    // still an alt (not rewritten to opt): other cases exist
    expect(followed.fragments).toEqual([expect.objectContaining({ id: alt.id, kind: 'alt', operands: [expect.objectContaining({ guard: 'shipping = Standard', case: 1 })], followed: { otherCases: 2 } })]);
    const all = (await s.showAllCases(alt.id))!;
    expect(ids(all)).toEqual(['root', 'root/0:Express', 'root/1:Standard', 'root/2:Pickup', 'root/3:Save']);
  });

  it('FR-1.22 / FR-3.11 without a diagram following, showing all cases or an error path changes nothing', async () => {
    const s = fakeSession(world());
    expect(await s.followCase('root#alt0@0', 0)).toBeUndefined();
    expect(await s.showAllCases('root#alt0@0')).toBeUndefined();
    expect(await s.showErrorPath('root#opt0@0#0')).toBeUndefined();
  });

  it('FR-1.22 only a case of an alt on screen can be followed', async () => {
    const s = fakeSession(world());
    await s.openMethodByKey(pay.key);
    expect(ids(await s.followCase('root#alt0@0', 7))).toHaveLength(5);
    expect(ids(await s.followCase('root#nope', 0))).toHaveLength(5);
  });

  it('FR-1.22 / FR-3.11 focus and re-rooting keep only what is below the call; error paths shown again travel too', async () => {
    const w = world();
    w.callers = { [pay.key]: [{ id: 'c1', enclosing: enter, range: at('Shop.cs', 4) } as never] };
    // Enter: if (cart) Pay() else Save()
    w.calls![enter.key] = [call(0, pay, { range: at('Shop.cs', 4), fragments: [{ id: 'if@1', kind: 'alt', operand: 0, guard: 'cart' }] }), call(1, save, { fragments: [{ id: 'if@1', kind: 'alt', operand: 1, guard: 'else' }] })];
    const s = fakeSession(w);
    await s.openMethodByKey(enter.key);
    await s.expand('root/0:Pay');
    await s.followCase('root/0:Pay#alt0@0', 2);
    await s.followCase('root#alt0@0', 0); // Enter's own: not below Pay
    await s.showErrorPath('root/0:Pay#opt0@0#0');
    await s.showErrorPath('root/0:Pay#opt1@4#0');
    await s.showErrorPath('root#opt0@9#0'); // not below Pay
    const snap = (await s.exportState({ language: 'csharp' } as never))!;
    expect(snap.shownErrorPaths).toEqual(['root/0:Pay#opt0@0#0', 'root/0:Pay#opt1@4#0', 'root#opt0@9#0']);
    expect((await fakeSession(w).restoreState(snap, { language: 'csharp' })).diagram!.messages.map((m) => m.id)).toEqual(['root', 'root/0:Pay', 'root/0:Pay/2:Pickup', 'root/0:Pay/3:Save']);
    const focused = (await s.focus('root/0:Pay'))!;
    expect(ids(focused)).toEqual(['root', 'root/2:Pickup', 'root/3:Save']);
    const again = (await s.exportState({ language: 'csharp' } as never))!;
    expect(again.shownErrorPaths).toEqual(['root#opt0@0#0', 'root#opt1@4#0']);
    // back to Enter, then re-root Pay at its caller: Pay's own state is carried below the call
    await s.back();
    await s.followCase('root#alt9@9', 1); // not on screen: ignored
    const up = (await s.reroot('root/0:Pay', 'c1'))!;
    // Enter's own followed case is not carried (only Pay's), so its else branch is back
    expect(ids(up)).toEqual(['root', 'root/0:Pay', 'root/0:Pay/2:Pickup', 'root/0:Pay/3:Save', 'root/1:Save']);
    expect((await s.exportState({ language: 'csharp' } as never))!.shownErrorPaths).toEqual(['root/0:Pay#opt0@0#0', 'root/0:Pay#opt1@4#0']);
  });

  it('FR-1.22 the followed case moves with focus and re-rooting, and travels in a shared state', async () => {
    const w = world();
    w.callers = { [pay.key]: [{ id: 'c1', enclosing: enter, range: at('Shop.cs', 4) } as never] };
    const s = fakeSession(w);
    await s.openMethodByKey(pay.key);
    await s.followCase('root#alt0@0', 0);
    // re-root at the caller: the case stays followed below the call
    const up = (await s.reroot('root', 'c1'))!;
    expect(ids(up)).toEqual(['root', 'root/0:Pay', 'root/0:Pay/0:Express', 'root/0:Pay/3:Save']);
    // focus back on Pay
    const focused = (await s.focus('root/0:Pay'))!;
    expect(ids(focused)).toEqual(['root', 'root/0:Express', 'root/3:Save']);
    const snap = await s.exportState({ language: 'csharp' } as never);
    expect(snap?.followedCases).toEqual({ 'root#alt0@0': 0 });
    const other = fakeSession(world());
    const { diagram, report } = await other.restoreState(snap!, { language: 'csharp' });
    expect(ids(diagram)).toEqual(['root', 'root/0:Express', 'root/3:Save']);
    expect(report.missing).toEqual([]);
    // a followed alt that is not in the diagram is reported
    const { report: gone } = await fakeSession(world()).restoreState({ ...snap!, followedCases: { 'root#alt9@9': 1 } }, { language: 'csharp' });
    expect(gone.missing).toEqual(['followed case of root#alt9@9']);
  });
});
