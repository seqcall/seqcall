import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-1.2 how TS callables, their owners and keys are named, for the less common shapes of declarations.

const lines = (m: { declaration?: { start: { line: number; character: number }; end: { line: number; character: number } } } | undefined) =>
  m?.declaration && [m.declaration.start.line, m.declaration.start.character, m.declaration.end.line, m.declaration.end.character];

describe('FR-1.2 member and function names (TS)', () => {
  const { adapter, method } = tsProject({
    'src/a.ts': `export class Odd {
  #secret() {}
  'my-method'() {}
  42() {}
  [Symbol.iterator]() {}
  'constructor'() {}
}
export default function () { return 1; }
`,
  }, undefined, true);

  it('FR-1.2 private (#), quoted, numeric and computed member names are the method names', async () => {
    const [odd] = await adapter.getFileTypes(`${adapter.projectRoot}/src/a.ts`);
    expect(odd.methods.map((m) => m.key)).toEqual([
      'src/a.ts#Odd.#secret',
      'src/a.ts#Odd.my-method',
      'src/a.ts#Odd.42',
      'src/a.ts#Odd.[Symbol.iterator]',
      'src/a.ts#Odd.constructor',
    ]);
  });

  it('FR-1.2 a constructor named by a string is the constructor, declared by the whole member; an unnamed default function is "default"', async () => {
    expect(lines(await method('src/a.ts#Odd.constructor'))).toEqual([5, 2, 5, 20]);
    const fn = await method('src/a.ts#<module>.default');
    expect([fn.name, fn.owner.name, lines(fn)]).toEqual(['default', 'a', [7, 0, 7, 40]]);
  });
});

describe('FR-1.2 class expressions and namespaces (TS)', () => {
  const { adapter, method } = tsProject({
    'src/a.ts': `export const Shop = class { run() { return 1; } };
export const Named = class Inner { go() {} };
export namespace NS {
  export class Box { open() {} }
  export function util() {}
  export namespace Deep.Er { export const x = 1; }
  export class tools {}
}
export const tools = { use() {} };
declare module 'decl-only';
export function main() {
  new Shop().run();
  new NS.Box().open();
  new (class { hidden() {} })().hidden();
  NS.util();
}
`,
  }, undefined, true);

  it('FR-1.2 a class expression assigned to a const is a class named after the const (or its own name); its methods and constructor are callables', async () => {
    expect((await adapter.getClassInfo('src/a.ts#Shop'))?.methods.map((m) => m.name)).toEqual(['run']);
    expect((await adapter.getClassInfo('src/a.ts#Inner'))?.methods.map((m) => m.name)).toEqual(['go']);
    expect((await method('src/a.ts#Shop.constructor')).owner).toMatchObject({ key: 'src/a.ts#Shop', name: 'Shop', kind: 'class' });
    expect(await adapter.getClassInfo('src/a.ts#Named')).toBeUndefined();
  });

  it('FR-1.2 an object named like a class in a namespace of the file gets a suffix (keys stay apart)', async () => {
    expect((await method('src/a.ts#tools~2.use')).owner).toMatchObject({ key: 'src/a.ts#tools~2', name: 'tools~2' });
  });

  it('FR-1.2 classes and functions in a namespace are found by key; calls resolve to them; an anonymous class is "default"', async () => {
    expect((await adapter.getClassInfo('src/a.ts#Box'))?.methods.map((m) => m.name)).toEqual(['open']);
    expect((await method('src/a.ts#Box.open')).owner.key).toBe('src/a.ts#Box');
    expect((await method('src/a.ts#<module>.util')).owner.key).toBe('src/a.ts#<module>');
    const calls = await adapter.getOutgoingCalls(await method('src/a.ts#<module>.main'));
    expect(calls.map((c) => [c.kind, c.methodName, c.target?.key])).toEqual([
      ['create', 'constructor', 'src/a.ts#Shop.constructor'],
      ['call', 'run', 'src/a.ts#Shop.run'],
      ['create', 'constructor', 'src/a.ts#Box.constructor'],
      ['call', 'open', 'src/a.ts#Box.open'],
      ['create', 'constructor', 'src/a.ts#default.constructor'],
      ['call', 'hidden', 'src/a.ts#default.hidden'],
      ['call', 'util', 'src/a.ts#<module>.util'],
    ]);
  });
});

describe('FR-1.2 synthetic owners: object literals and closures (TS)', () => {
  const { adapter, method, at } = tsProject({
    'src/a.ts': `export function nested() {
  return () => { return () => 1; };
}
export class Ctor { constructor() { const helper = () => 1; helper(); } }
export const store = {
  get size() { return 1; },
  set size(v: number) {},
  'save-all'() {},
  7() {},
  inner: { deep() {} },
  'quoted-inner': { other() {} },
  save() { const helper = () => 2; return helper(); },
};
export const twice = { set value(v: number) {}, set value(v: string) {} };
const KEY = 'k';
export const odd = { [KEY]() {}, 0x10() {} };
export function makeStore() {
  const save = () => 1;
  const load = () => 2;
  return { save: save, size: 1, other: KEY };
}
export function closure() {
  const clear = () => 0;
  clear();
}
setTimeout(() => clear2(), 1);
setTimeout(function () { clear2(); }, 2);
function clear2() {}
`,
  }, undefined, true);

  it('FR-1.2 object members: getter and setter (=) of one property, quoted and numeric names, a nested object named by its property; an object under a quoted name belongs to the module', async () => {
    expect((await adapter.getClassInfo('src/a.ts#store'))?.methods.map((m) => m.name)).toEqual(['size', 'size', 'save-all', '7', 'save']);
    expect((await method('src/a.ts#store.size=')).name).toBe('size');
    expect((await method('src/a.ts#inner.deep')).owner).toMatchObject({ key: 'src/a.ts#inner', name: 'inner' });
    expect((await method('src/a.ts#<module>.other')).owner).toMatchObject({ key: 'src/a.ts#<module>', name: 'a', kind: 'module' });
    // two setters of one name: the second gets a suffix
    expect((await adapter.getClassInfo('src/a.ts#twice'))?.methods.map((m) => m.name)).toEqual(['value', 'value~2']);
    expect((await method('src/a.ts#twice.value~2=')).name).toBe('value~2');
  });

  it('FR-1.2 a computed member name is its source text, a numeric one its value', async () => {
    expect((await adapter.getClassInfo('src/a.ts#odd'))?.methods.map((m) => m.name)).toEqual(['[KEY]', '16']);
  });

  it('FR-1.2 helpers handed out by a factory (`return { save: save }`) belong to a port implementation, not to `makeStore()`; a closure\'s own helpers do', async () => {
    expect((await method('src/a.ts#makeStore.save')).owner.name).toBe('makeStore');
    expect((await method('src/a.ts#closure.clear')).owner.name).toBe('closure()');
  });

  it('FR-1.1 code in a callback at module level (arrow or function expression) is in no callable', async () => {
    expect(await adapter.findEnclosingCallable(`${adapter.projectRoot}/src/a.ts`, at('src/a.ts', 'clear2()'))).toBeUndefined();
    expect(await adapter.findEnclosingCallable(`${adapter.projectRoot}/src/a.ts`, at('src/a.ts', 'clear2(); }'))).toBeUndefined();
  });

  it('FR-1.2 a function returned by a returned function: its owner is named after the outer function (with a suffix), declared at its name', async () => {
    const inner = await method('src/a.ts#nested~2.<returned>');
    expect([inner.owner.key, inner.owner.name, lines({ declaration: inner.owner.declaration })]).toEqual(['src/a.ts#nested~2', 'nested~2', [0, 16, 0, 22]]);
  });

  it('FR-1.2 helpers declared in a constructor or an object method: owned by `Class.constructor()` / `save()`', async () => {
    const ctor = await method('src/a.ts#Ctor.constructor.helper');
    expect([ctor.owner.key, ctor.owner.name]).toEqual(['src/a.ts#Ctor.constructor', 'Ctor.constructor()']);
    expect((await adapter.getClassInfo('src/a.ts#Ctor.constructor'))?.localFunctions).toBe(true);
    const save = await method('src/a.ts#save.helper');
    expect([save.owner.key, save.owner.name]).toEqual(['src/a.ts#save', 'save()']);
  });
});

describe('FR-1.2 what is no callable, and keys that name nothing (TS)', () => {
  const { adapter } = tsProject({
    'src/a.ts': `import { pad } from 'text';
export interface Deps { save; load: () => void }
export class Holder { save; run() { return pad(); } }
export type Shape = { name: string; save(): void };
export class Over { constructor(n: string); constructor(n: any) {} m(a: string): void; m(a: any) { return a; } }
export declare class Ext { constructor(n: number); }
export function make() { return new Ext(1); }
export function run(deps: { save: (n: number) => void }) { deps.save(1); }
`,
    'node_modules/text/package.json': '{"name":"text","main":"index.ts"}',
    'node_modules/text/index.ts': 'export function pad() { return 1; }\n',
  }, undefined, true);

  it('FR-1.2 an untyped property is no method; a function-typed one is; a type literal member that is data is none', async () => {
    const types = await adapter.getFileTypes(`${adapter.projectRoot}/src/a.ts`);
    expect(types.map((t) => [t.type.name, t.methods.map((m) => m.name)])).toEqual([
      ['Deps', []],
      ['Holder', ['run']],
      ['Over', ['constructor', 'm']],
      ['Ext', []],
      ['a', ['make', 'run']],
    ]);
    expect(await adapter.getMethod('src/a.ts#Deps.load')).toMatchObject({ name: 'load', hasBody: false });
    expect(await adapter.getMethod('src/a.ts#Deps.save')).toBeUndefined();
    expect(await adapter.getMethod('src/a.ts#Holder.save')).toBeUndefined();
    expect(await adapter.getMethod('src/a.ts#Shape.save')).toMatchObject({ name: 'save', hasBody: false });
    expect(await adapter.getMethod('src/a.ts#Shape.name')).toBeUndefined();
    expect(await adapter.getMethod('src/a.ts#Over.constructor')).toMatchObject({ hasBody: true });
    // an overloaded method is its implementation
    expect(lines(await adapter.getMethod('src/a.ts#Over.m'))).toEqual([4, 87, 4, 88]);
    // the constructor of a declared class has no body
    const [create] = await adapter.getOutgoingCalls((await adapter.getMethod('src/a.ts#<module>.make'))!);
    expect(create.target).toMatchObject({ key: 'src/a.ts#Ext.constructor', hasBody: false });
    // a member of an inline parameter type has no owner: the call is unresolved
    const [save] = await adapter.getOutgoingCalls((await adapter.getMethod('src/a.ts#<module>.run'))!);
    expect([save.methodName, save.target, save.receiver]).toEqual(['save', undefined, { kind: 'parameter', name: 'deps' }]);
  });

  it('FR-1.2 keys without a file part, of libraries, of library files or of missing files: nothing', async () => {
    expect(await adapter.getMethod('no-hash')).toBeUndefined();
    expect(await adapter.getMethod('lib:text#<module>.pad')).toBeUndefined();
    expect(await adapter.getMethod('node_modules/text/index.ts#<module>.pad')).toBeUndefined();
    expect(await adapter.getMethod('src/missing.ts#X.run')).toBeUndefined();
    expect(await adapter.getClassInfo('lib:text')).toBeUndefined();
    expect(await adapter.getClassInfo('unknown')).toBeUndefined();
    expect(await adapter.getClassInfo('src/missing.ts#X')).toBeUndefined();
  });
});

describe('FR-1.6 Node built-ins (TS)', () => {
  it('FR-1.6 a module declared as `node:x` keeps its name; `x` is shown as `node:x`', async () => {
    const { adapter, method } = tsProject({
      'node_modules/@types/node/package.json': '{"name":"@types/node","types":"index.d.ts"}',
      'node_modules/@types/node/index.d.ts': `declare module 'fs' { export function readFileSync(p: string): string; }
declare module 'node:events' { export function once(e: unknown, n: string): Promise<unknown[]>; }
`,
      'src/a.ts': "import { readFileSync } from 'fs';\nimport { once } from 'node:events';\nexport function run() { readFileSync('x'); return once(null, 'y'); }\n",
    }, { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'node', types: ['node'] } });
    const calls = await adapter.getOutgoingCalls(await method('src/a.ts#<module>.run'));
    expect(calls.map((c) => [c.methodName, c.libraryName])).toEqual([['readFileSync', 'node:fs'], ['once', 'node:events']]);
  });
});

describe('FR-12 a class whose base and interfaces are imported from a missing file (mid-edit)', () => {
  it('FR-12.3 no base class, no interfaces (the names resolve to nothing)', async () => {
    const { adapter } = tsProject({
      'src/a.ts': "import { Base, Port } from './nowhere';\nexport class Shop extends Base implements Port { run() {} }\n",
    });
    const info = await adapter.getClassInfo('src/a.ts#Shop');
    expect([info?.extends, info?.implements, info?.methods.map((m) => m.name)]).toEqual([undefined, [], ['run']]);
  });
});
