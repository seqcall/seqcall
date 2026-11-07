import { describe, expect, it } from 'vitest';
import type { CallSite, FragmentScope } from '../src/adapter';
import { call, cls, fakeSession, meth } from './fake-world';

// FR-19.1 I/O in a loop as the session finds it from the frames an adapter reports around each call: only a loop
// over a collection (`each x of xs`) repeats the I/O per item; a loop without a guard (`for (;;)`, a polling loop) does not.
const shop = cls('src/Shop.cs', 'Shop');
const run = meth(shop, 'Run');
const pool = { key: 'lib:pg#Pool', name: 'Pool', kind: 'external' as const };
const query = { key: 'lib:pg#Pool.query', name: 'query', owner: pool, isStatic: false, hasBody: false };
const io = (o: number, fragments: FragmentScope[]): CallSite => call(o, query, { isLibrary: true, libraryName: 'pg', methodName: 'query', fragments });

describe('FR-19.1 I/O in a loop: which loops count', () => {
  it('FR-19.1 a query in a loop over a collection is reported; in a loop without a guard, or in a UI handler inside one, it is not', async () => {
    const s = fakeSession({
      methods: [run],
      calls: {
        [run.key]: [
          io(0, [{ id: 'for@1', kind: 'loop', operand: 0 }]),
          io(1, [{ id: 'for@2', kind: 'loop', operand: 0, guard: 'each o of orders' }]),
          io(2, [{ id: 'for@3', kind: 'loop', operand: 0 }, { id: 'jsx@4', kind: 'callback', operand: 0 }]),
        ],
      },
    }, { options: { showLibraryCalls: true } });
    const d = (await s.openMethodByKey(run.key))!;
    expect(d.findings!.filter((f) => f.kind === 'io-in-loop').map((f) => f.messageIds)).toEqual([['root/1:query']]);
  });
});
