import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-12.12 type uses of the different kinds of TS callables, on small projects.

const FILES = {
  'src/types.ts': `export interface Order { id: string }
export interface Clock { now(): number }
export class Repo { find(id: string): Order { return { id }; } }
export type Handler = (o: Order) => void;
`,
  'src/shop.ts': `import { Order, Clock, Repo, Handler } from './types';
export class Shop {
  repo = new Repo();
  clock: Clock;
  run(o: import('./types').Order) { return Repo.name; }
}
export class Till {
  repo = new Repo();
  constructor(private c: Clock) {}
}
export interface Ports { save: (o: Order) => void; }
export const handle: Handler = (o) => {};
`,
};

const uses = async (files: Record<string, string>, key: string) => {
  const { adapter, method } = tsProject(files);
  return (await adapter.getTypeUses(await method(key))).map((u) => `${u.type.key} ${u.type.kind}`);
};

describe('FR-12.12 type uses (TS)', () => {
  it('FR-12.12 a constructor uses the types of the field initialisers, also an implicit one; a declared field type is not used by it', async () => {
    expect(await uses(FILES, 'src/shop.ts#Shop.constructor')).toEqual(['src/types.ts#Repo class']);
    expect(await uses(FILES, 'src/shop.ts#Till.constructor')).toEqual(['src/types.ts#Clock interface', 'src/types.ts#Repo class']);
  });

  it('FR-12.12 a function-typed property signature and a typed const arrow use the types of their annotation', async () => {
    expect(await uses(FILES, 'src/shop.ts#Ports.save')).toEqual(['src/types.ts#Order interface']);
    expect(await uses(FILES, 'src/shop.ts#<module>.handle')).toEqual(['src/types.ts#Handler interface']);
  });

  it('FR-12.12 an `import("…")` type is not followed', async () => {
    expect(await uses(FILES, 'src/shop.ts#Shop.run')).toEqual(['src/types.ts#Repo class']);
  });
});
