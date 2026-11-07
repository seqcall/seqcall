import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-12 / FR-5.10 / FR-7 structural information of TS classes, interfaces and modules (class diagram, stereotypes,
// layer hints), for the less common shapes of declarations.

describe('FR-12.18 module members (TS)', () => {
  const { adapter } = tsProject({
    'src/mod.ts': `function helper() {}
function hidden() {}
export { helper as run };
export default function () {}
`,
    'src/script.ts': 'function globalHelper() {}\nconst alsoGlobal = () => 1;\n',
  }, undefined, true);

  it('FR-12.18 a function exported under another name is public; one not exported is private; the default export is public', async () => {
    const info = await adapter.getClassInfo('src/mod.ts#<module>');
    expect(info?.methods.map((m) => [m.name, m.visibility ?? 'public'])).toEqual([
      ['helper', 'public'],
      ['hidden', 'private'],
      ['default', 'public'],
    ]);
  });

  it('FR-12.18 a script (no import / export): its top-level functions are global, so public', async () => {
    const info = await adapter.getClassInfo('src/script.ts#<module>');
    expect(info?.methods.map((m) => [m.name, m.visibility ?? 'public', m.signature])).toEqual([
      ['globalHelper', 'public', 'globalHelper(): void'],
      ['alsoGlobal', 'public', 'alsoGlobal(): number'],
    ]);
  });

  it('FR-12.2 a module of a missing file, a synthetic owner of a missing file: nothing', async () => {
    expect(await adapter.getClassInfo('src/missing.ts#<module>')).toBeUndefined();
    expect(await adapter.getClassInfo('src/missing.ts#store')).toBeUndefined();
  });
});

describe('FR-12 classes (TS)', () => {
  const { adapter } = tsProject({
    'src/decorators.ts': 'export const Injectable = (t: any) => t;\nexport namespace ng { export const Component = (o: unknown) => (t: any) => t; }\n',
    'src/ports.ts': 'export interface Repo { find(id: string): string }\nexport interface Clock { now(): number }\n',
    'src/a.ts': `import { Injectable, ng } from './decorators';
import { Repo, Clock } from './ports';
@Injectable
@ng.Component({})
export class Service {
  count = 0;
  protected constructor(repo: Repo);
  protected constructor(repo: Repo, extra?: string) {
    this.hits += 1;
    other.x = 1;
    plain = 2;
  }
  find(id: string): string;
  find(id: any) { return id; }
  static instance() { return 1; }
  [key: string]: unknown;
}
declare const other: { x: number };
let plain = 0;
export class Statics {
  static a() {}
  static {}
  ;
  static [key: string]: unknown;
}
export class Pair {
  constructor([, clock]: [Repo, Clock], ...rest: string[]) {}
  pick(a?: number, ...more: number[]) { return a; }
}
export declare class Remote { constructor(url: string); }
export type Shape = { area(): number; name: string };
export type Id = string | number;
`,
  }, undefined, true);

  it('FR-12.3 decorators by name (called or not, also from a namespace); a protected constructor counts as private; overloads by their implementation', async () => {
    const info = (await adapter.getClassInfo('src/a.ts#Service'))!;
    expect(info.decorators).toEqual(['Injectable', 'Component']);
    expect(info.hasPrivateConstructor).toBe(true);
    expect(info.constructorParams.map((p) => p.name)).toEqual(['repo', 'extra']);
    expect(info.methods.map((m) => [m.name, m.signature])).toEqual([
      ['constructor', 'constructor(repo: Repo, extra?: string)'],
      ['find', 'find(id: any): any'],
      ['instance', 'instance(): number'],
    ]);
  });

  it('FR-12.3 the constructor\'s compound assignments and assignments to other objects are no fields', async () => {
    const info = (await adapter.getClassInfo('src/a.ts#Service'))!;
    expect(info.fields.map((f) => f.name)).toEqual(['count']);
  });

  it('FR-7.1 a static method named `instance` is no singleton accessor; an instance index signature makes a class not all-static', async () => {
    const info = (await adapter.getClassInfo('src/a.ts#Service'))!;
    expect([info.hasStaticInstance, info.allMembersStatic]).toEqual([false, false]);
    // static blocks, `;` and a static index signature do not count
    expect((await adapter.getClassInfo('src/a.ts#Statics'))!.allMembersStatic).toBe(true);
  });

  it('FR-12.3 an array-destructured constructor parameter (with a hole), rest and optional parameters in signatures', async () => {
    const info = (await adapter.getClassInfo('src/a.ts#Pair'))!;
    expect(info.methods.map((m) => m.signature)).toEqual([
      'constructor([, clock]: [Repo, Clock], ...rest: string[])',
      'pick(a?: number, ...more: number[]): number',
    ]);
    expect(info.fields).toEqual([]);
  });

  it('FR-12.3 a declared class: the constructor parameters, no fields', async () => {
    const info = (await adapter.getClassInfo('src/a.ts#Remote'))!;
    expect([info.constructorParams.map((p) => p.name), info.fields]).toEqual([['url'], []]);
  });

  it('FR-12.2 type aliases: an object shape lists its methods and fields; a union has no members', async () => {
    const shape = (await adapter.getClassInfo('src/a.ts#Shape'))!;
    expect([shape.ref.kind, shape.methods.map((m) => m.signature), shape.fields.map((f) => f.name)]).toEqual(['interface', ['area(): number'], ['name']]);
    const id = (await adapter.getClassInfo('src/a.ts#Id'))!;
    expect([id.methods, id.fields]).toEqual([[], []]);
  });
});

describe('FR-5.10 interchangeable objects (TS)', () => {
  const { adapter } = tsProject({
    'src/a.ts': `export class Leaf { constructor(a?: unknown, b?: unknown, c?: unknown, d?: unknown, e?: unknown) {} }
export class ByLiterals { leaf = new Leaf(1, 'a', true, null, undefined); }
export class NoParens { leaf = new Leaf; }
export class ByVariable { leaf = new Leaf(Math.PI); }
export class Base { constructor(n: number) {} }
export class Child extends Base {
  constructor() {
    super(1);
    console.log('made');
  }
}
export class Deleting { x = 1; drop() { delete this.x; } }
`,
  }, undefined, true);

  it('FR-5.10 fields built from literals (or `undefined`), also `new X` without parentheses; not from another value', async () => {
    const flags = async (name: string) => {
      const info = (await adapter.getClassInfo(`src/a.ts#${name}`))!;
      return [info.interchangeable ?? false, info.sameArgsInterchangeable ?? false];
    };
    expect(await flags('ByLiterals')).toEqual([true, true]);
    expect(await flags('NoParens')).toEqual([true, true]);
    expect(await flags('ByVariable')).toEqual([false, false]);
  });

  it('FR-5.10 a subclass calling `super` with literals (and doing more in its constructor) is; a class deleting a field is not', async () => {
    expect((await adapter.getClassInfo('src/a.ts#Child'))!.interchangeable).toBe(true);
    expect((await adapter.getClassInfo('src/a.ts#Deleting'))!.interchangeable).toBeUndefined();
  });
});
