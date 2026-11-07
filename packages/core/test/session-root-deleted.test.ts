import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-13.1 a refresh after the diagram's root method was deleted: the diagram is gone, and stays gone — no background
// step brings the old one back — until the method is there again.
const SHOP = `export class Repo {
  save(order: string): void {
    console.log(order);
  }
}
export class Shop {
  constructor(private repo: Repo) {}
  checkout(order: string): void {
    this.repo.save(order);
  }
  cancel(order: string): void {
    this.repo.save(order);
  }
}
`;
const WITHOUT_CHECKOUT = SHOP.replace(/  checkout\(order: string\): void \{\n    this\.repo\.save\(order\);\n  \}\n/, '');

describe('FR-13.1 the root method deleted', () => {
  it('FR-13.1 refresh empties the diagram; the background scan, the class diagram and the current diagram stay empty', async () => {
    const p = tsProject({ 'src/shop.ts': SHOP });
    const s = p.session();
    const d = await s.openMethodByKey((await p.method('src/shop.ts#Shop.checkout')).key);
    expect(d?.messages.map((m) => m.methodName)).toEqual(['checkout', 'save']);

    fs.writeFileSync(`${p.root}/src/shop.ts`, WITHOUT_CHECKOUT);
    expect(await s.refresh([`${p.root}/src/shop.ts`])).toBeUndefined();
    // what hosts do after posting a render: the background step — it must not draw the old flow again
    expect(await s.scanSideEffects()).toBeUndefined();
    expect(s.current()).toBeUndefined();
    expect(await s.getClassDiagram()).toBeUndefined();
  });

  it('FR-13.1 a background scan that was running when the root went away does not bring it back', async () => {
    const p = tsProject({ 'src/shop.ts': SHOP });
    const s = p.session();
    await s.openMethodByKey((await p.method('src/shop.ts#Shop.checkout')).key);
    const running = s.scanSideEffects();
    fs.writeFileSync(`${p.root}/src/shop.ts`, WITHOUT_CHECKOUT);
    await s.refresh([`${p.root}/src/shop.ts`]);
    expect(await running).toBeUndefined();
    expect(s.current()).toBeUndefined();
  });

  it('FR-13.1 the method back (undo, another branch): the next refresh draws the flow again', async () => {
    const p = tsProject({ 'src/shop.ts': SHOP });
    const s = p.session();
    await s.openMethodByKey((await p.method('src/shop.ts#Shop.checkout')).key);
    fs.writeFileSync(`${p.root}/src/shop.ts`, WITHOUT_CHECKOUT);
    await s.refresh([`${p.root}/src/shop.ts`]);
    fs.writeFileSync(`${p.root}/src/shop.ts`, SHOP);
    expect((await s.refresh([`${p.root}/src/shop.ts`]))?.messages.map((m) => m.methodName)).toEqual(['checkout', 'save']);
    expect((await s.getClassDiagram())?.classes.map((c) => c.name).sort()).toEqual(['Repo', 'Shop']);
  });
});
