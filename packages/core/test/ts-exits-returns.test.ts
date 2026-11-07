import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-1.15 early exits and FR-5.8 return facts of the TS adapter, for the shapes of callables a project has.

const SHOP = `export abstract class Shop {
  abstract close(): void;
  open(x: number) {
    if (x > 1) throw err;
    if (x > 2) throw new RangeError('x');
    return x;
    tidy(); // mid-edit: code after the return
  }
  pick(x: number) {
    if (x) return;
    return [x, null];
  }
}
declare const err: Error;
declare function tidy(): void;
export const twice = (x: number) => (x * 2);
export type Port = { save: (n: number) => void };
`;

describe('FR-1.15 early exits (TS adapter)', () => {
  it('FR-1.15 a thrown value is named by its expression, a created exception by its class; an exit followed by dead code has no frame', async () => {
    const { adapter, method } = tsProject({ 'src/shop.ts': SHOP });
    const exits = await adapter.getEarlyExits(await method('src/shop.ts#Shop.open'));
    expect(exits.map((e) => [e.kind, e.exception, e.range.start.line, e.fragments?.map((f) => `${f.kind}:${f.guard}`)])).toEqual([
      ['throw', 'err', 3, ['opt:x > 1']],
      ['throw', 'RangeError', 4, ['opt:x > 2']],
      ['return', undefined, 5, undefined],
    ]);
  });

  it('FR-3.9 a return says what it returns (compacted), a bare return an empty text; a throw has no value', async () => {
    const { adapter, method } = tsProject({ 'src/shop.ts': SHOP });
    expect((await adapter.getEarlyExits(await method('src/shop.ts#Shop.open'))).map((e) => e.value)).toEqual([undefined, undefined, 'x']);
    expect((await adapter.getEarlyExits(await method('src/shop.ts#Shop.pick'))).map((e) => e.value)).toEqual(['']);
  });

  it('FR-1.15 no body (abstract method, function-typed property) or an expression body: no early exits', async () => {
    const { adapter, method } = tsProject({ 'src/shop.ts': SHOP });
    expect(await adapter.getEarlyExits(await method('src/shop.ts#Shop.close'))).toEqual([]);
    expect(await adapter.getEarlyExits(await method('src/shop.ts#Port.save'))).toEqual([]);
    expect(await adapter.getEarlyExits(await method('src/shop.ts#<module>.twice'))).toEqual([]);
  });
});

describe('FR-5.8 return facts (TS adapter)', () => {
  it('FR-5.8 an expression body is one return; an empty `return` returns nothing; a tuple element by element', async () => {
    const { adapter, method } = tsProject({ 'src/shop.ts': SHOP });
    const twice = await adapter.getReturns(await method('src/shop.ts#<module>.twice'));
    // the statement range is the body, the value without its parentheses
    expect(twice.map((r) => [r.range.start.line, r.range.start.character, r.tuple, r.values.map((v) => [v.range.start.character, v.empty ?? false])])).toEqual([[15, 36, undefined, [[37, false]]]]);
    const pick = await adapter.getReturns(await method('src/shop.ts#Shop.pick'));
    expect(pick.map((r) => [r.range.start.line, r.tuple, r.values.map((v) => v.empty ?? false)])).toEqual([[9, undefined, []], [10, true, [false, true]]]);
  });

  it('FR-5.8 no body (abstract method, function-typed property): no returns', async () => {
    const { adapter, method } = tsProject({ 'src/shop.ts': SHOP });
    expect(await adapter.getReturns(await method('src/shop.ts#Shop.close'))).toEqual([]);
    expect(await adapter.getReturns(await method('src/shop.ts#Port.save'))).toEqual([]);
  });
});
