import { describe, expect, it } from 'vitest';
import { TsAdapter } from '../src/ts/ts-adapter';
import { DEFAULT_TSCONFIG, tsProject, writeProject } from './ts-project';

// FR-4.1 callers and FR-8.2 implementations of the TS adapter, for the shapes of code a project has
// (also broken code: users' files are often mid-edit).

/** Callers of `key` as `<enclosing key>@<line>:<col>[ passed] «preview»`. */
async function callers(files: Record<string, string>, key: string): Promise<string[]> {
  const { adapter, method } = tsProject(files);
  return (await adapter.getCallers(await method(key))).map((c) => `${c.enclosing.key}@${c.range.start.line}:${c.range.start.character}${c.passed ? ' passed' : ''}${c.inTest ? ' test' : ''} «${c.preview}»`);
}

/** Implementation keys of `key`. */
async function impls(files: Record<string, string>, key: string): Promise<string[]> {
  const { adapter, method } = tsProject(files);
  return (await adapter.getImplementations(await method(key))).map((m) => m.key);
}

describe('FR-4.1 callers (TS): how a reference is a call', () => {
  it('FR-4.1 a call through `obj["name"]`, in parentheses, with `!` or through a cast (`as`, `<T>`, `satisfies`) is a call', async () => {
    expect(await callers({
      'src/a.ts': `export class S { save(n: number) {} }
type X = (n: number) => void;
export function run(s: S) {
  s['save'](1);
  (s.save)(2);
  s.save!(3);
  (s.save as any)(4);
  (<any>s.save)(5);
  (s.save satisfies X)(6);
  ((s.save as any))!(7);
  (s['save'] as any)(8);
}
`,
    }, 'src/a.ts#S.save')).toEqual([
      'src/a.ts#<module>.run@3:2 «s[\'save\'](1);»',
      'src/a.ts#<module>.run@4:2 «(s.save)(2);»',
      'src/a.ts#<module>.run@5:2 «s.save!(3);»',
      'src/a.ts#<module>.run@6:2 «(s.save as any)(4);»',
      'src/a.ts#<module>.run@7:2 «(<any>s.save)(5);»',
      'src/a.ts#<module>.run@8:2 «(s.save satisfies X)(6);»',
      'src/a.ts#<module>.run@9:2 «((s.save as any))!(7);»',
      'src/a.ts#<module>.run@10:2 «(s[\'save\'] as any)(8);»',
    ]);
  });

  it('FR-4.5 a method passed on: bound, in parentheses or through a cast; not its `.call` (read or called), a `.bind` read and not called, `new` of it', async () => {
    expect(await callers({
      'src/a.ts': `type X = (n: number) => void;
export class S {
  save(n: number) {}
  step() {
    run(this.save.bind(this));
    run((this.save));
    run(this.save as any);
    run(this.save satisfies X);
    run(<any>this.save);
    run(this.save.call);
    run(this.save.call(this, 1));
    outer(run(this.save.bind));
    const f = this.save.bind;
    new (this.save as any);
  }
}
function run(f: any) {}
function outer(f: any) {}
`,
    }, 'src/a.ts#S.save')).toEqual([
      'src/a.ts#S.step@4:4 passed «run(this.save.bind(this));»',
      'src/a.ts#S.step@5:4 passed «run((this.save));»',
      'src/a.ts#S.step@6:4 passed «run(this.save as any);»',
      'src/a.ts#S.step@7:4 passed «run(this.save satisfies X);»',
      'src/a.ts#S.step@8:4 passed «run(<any>this.save);»',
    ]);
  });

  describe('FR-4.1 an implementation: calls through itself, its interface or a base class; not a sibling\'s', () => {
    const files = {
      'src/a.ts': `export interface Store { save(): void }
export class Top { save() {} }
export abstract class Base extends Top { abstract save(): void }
export class MemStore extends Base implements Store { save() {} }
export class SubMem extends MemStore {}
export class Over extends MemStore { save() {} }
export abstract class Shelf { abstract save: () => void }
export class DbStore extends Shelf implements Store { save = () => {}; }
export function viaPort(p: Store) { p.save(); }
export function viaTop(t: Top) { t.save(); }
export function viaShelf(s: Shelf) { s.save(); }
export function viaMem(m: MemStore) { m.save(); }
export function viaDb(d: DbStore) { d.save(); }
export function viaUnion(u: MemStore | DbStore) { u.save(); }
export function viaSub(x: SubMem) { x.save(); }
export function viaOver(o: Over) { o.save(); }
export function viaBase(b: Base) { b.save(); }
export function viaDestr(d: DbStore) { const { save } = d; save(); }
`,
    };
    const names = async (key: string) => (await callers(files, key)).map((c) => c.replace(/@.*/, '').replace('src/a.ts#<module>.', '')).sort();

    it('FR-4.1 a class method: its own calls, a subclass that inherits it, the interface, the base classes it overrides (abstract or not), a union holding it', async () => {
      expect(await names('src/a.ts#MemStore.save')).toEqual(['viaBase', 'viaMem', 'viaPort', 'viaSub', 'viaTop', 'viaUnion']);
    });

    it('FR-4.1 a field holding a function: through an abstract field it implements, also called after being taken out (`const { save } = d`)', async () => {
      expect(await names('src/a.ts#DbStore.save')).toEqual(['viaDb', 'viaDestr', 'viaPort', 'viaShelf', 'viaUnion']);
    });

    it('FR-4.1 an interface member: only the calls through the interface, not those on a concrete class or a union of them', async () => {
      expect(await names('src/a.ts#Store.save')).toEqual(['viaPort']);
    });
  });

  it('FR-4.1 a class built on a mixin: calls on it reach its method, calls on the mixin\'s own method do not', async () => {
    expect(await callers({
      'src/a.ts': `type Ctor = new (...a: any[]) => object;
function Saving<T extends Ctor>(B: T) { return class extends B { save() {} }; }
class Plain {}
export class Store extends Saving(Plain) { save() {} }
export function viaStore(s: Store) { s.save(); }
export function viaMixin(m: InstanceType<ReturnType<typeof Saving<typeof Plain>>>) { m.save(); }
`,
    }, 'src/a.ts#Store.save')).toEqual(['src/a.ts#<module>.viaStore@4:37 «export function viaStore(s: Store) { s.save(); }»']);
  });

  it('FR-4.1 a destructuring default value or a nested pattern is no call; a call outside any function is not a caller', async () => {
    expect(await callers({
      'src/a.ts': `export function save(n: number) {}
save(0);
export function run(o: any) {
  const { cb = save } = o;
  const { save: { x } } = { save: { x: 1 } };
  cb(1);
}
export function other() { save(2); }
`,
    }, 'src/a.ts#<module>.save')).toEqual(['src/a.ts#<module>.other@7:26 «export function other() { save(2); }»']);
  });

  it('FR-4.1 a nested destructuring pattern of a namespace import (`const { save: { length } } = mod`) is no call', async () => {
    expect(await callers({
      'src/a.ts': 'export function save(n: number) {}\n',
      'src/b.ts': "import * as mod from './a';\nexport function run() {\n  const { save: { length } } = mod;\n  mod.save(length);\n}\n",
    }, 'src/a.ts#<module>.save')).toEqual(['src/b.ts#<module>.run@3:2 «mod.save(length);»']);
  });

  it('FR-4.1 a returned function has no name to search for: no callers (its callers call the factory\'s result)', async () => {
    expect(await callers({
      'src/a.ts': 'export function make() {\n  return (n: number) => n;\n}\nexport function run() { return make()(1); }\n',
    }, 'src/a.ts#make.<returned>')).toEqual([]);
  });

  it('FR-4.1 the preview is the line as TypeScript counts lines: also after a lone CR or a U+2028 in a comment', async () => {
    expect(await callers({
      'src/a.ts': 'export function save(n: number) {}\r// a b\rexport function run() {\r  save(2);\r}\r',
    }, 'src/a.ts#<module>.save')).toEqual(['src/a.ts#<module>.run@4:2 «save(2);»']);
  });

  it('FR-4.1 a getter read through `obj["name"]` is a caller of the getter', async () => {
    expect(await callers({
      'src/a.ts': `export class O { get total() { return 1; } }
export function run(o: O) {
  return o['total'];
}
`,
    }, 'src/a.ts#O.total')).toEqual(['src/a.ts#<module>.run@2:11 «return o[\'total\'];»']);
  });

  it('FR-4.1 the constructor of an unnamed default-exported class is called by `new` of its import', async () => {
    expect(await callers({
      'src/a.ts': 'export default class { constructor(n: number) {} }\n',
      'src/b.ts': "import Shop from './a';\nexport function run() { return new Shop(1); }\n",
    }, 'src/a.ts#default.constructor')).toEqual(['src/b.ts#<module>.run@1:31 «export function run() { return new Shop(1); }»']);
  });

  it('FR-1.20 a component used through a wrapper passed on (`register(memo(Panel))`) or `export =` is not rendered there; a wrapper reached twice is followed once', async () => {
    const files = {
      'src/ui.tsx': `declare function memo<T>(c: T): T;
declare function both<T>(a: T, b: T): T;
declare function register(c: unknown): void;
export function Panel() { return <div />; }
register(memo(Panel));
export const Shown = both(memo(Panel), Panel);
export function Page() { return <Shown />; }
`,
      'src/legacy.tsx': `import { Panel } from './ui';\nexport = memo(Panel);\ndeclare function memo<T>(c: T): T;\n`,
    };
    const { adapter, method } = tsProject(files, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    expect((await adapter.getCallers(await method('src/ui.tsx#<module>.Panel'))).map((c) => `${c.enclosing.key}@${c.range.start.line}`)).toEqual(['src/ui.tsx#<module>.Page@6']);
  });

  it('FR-1.20 a component rendered as `<ui.Panel />` (a namespace import) is rendered by that element', async () => {
    const { adapter, method } = tsProject({
      'src/panel.tsx': 'export function Panel() { return <div />; }\n',
      'src/page.tsx': "import * as ui from './panel';\nexport function Page() { return <ui.Panel />; }\n",
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    expect((await adapter.getCallers(await method('src/panel.tsx#<module>.Panel'))).map((c) => `${c.enclosing.key} «${c.preview}»`)).toEqual([
      'src/page.tsx#<module>.Page «export function Page() { return <ui.Panel />; }»',
    ]);
  });

  it('FR-4.1 calls from a file outside the project root (a shared folder importing back) are not callers', async () => {
    const root = writeProject({
      'app/tsconfig.json': JSON.stringify(DEFAULT_TSCONFIG),
      'app/src/a.ts': "import { twice } from '../../shared/twice';\nexport function save(n: number) {}\nexport function run() { save(1); return twice(); }\n",
      'shared/twice.ts': "import { save } from '../app/src/a';\nexport function twice() { save(2); save(3); }\n",
    }, false);
    const adapter = new TsAdapter(`${root}/app`);
    const save = (await adapter.getMethod('src/a.ts#<module>.save'))!;
    expect((await adapter.getCallers(save)).map((c) => c.enclosing.key)).toEqual(['src/a.ts#<module>.run']);
  });

  it('FR-4.1 a syntax error in another file that breaks the reference search (a string as a parameter name): no callers instead of a failed request', async () => {
    const files = {
      'src/a.ts': 'export interface Store { save(n: number): void }\nexport class Db implements Store { save(n: number) {} }\n',
      'src/ui.ts': `import { Store } from './a';
export class Ui {
  constructor(private s: Store) {}
  onSave("save") { this.s.save(1); }
}
`,
    };
    const { adapter, method } = tsProject(files);
    expect(await adapter.getCallers(await method('src/a.ts#Store.save'))).toEqual([]);
    // FR-8.2 the implementation search fails the same way: none found
    expect(await adapter.getImplementations(await method('src/a.ts#Store.save'))).toEqual([]);
  });
});

const PORTS = `export interface Ports { save(n: number): void }
export type Fn = (n: number) => void;
export interface FnPorts { save: Fn }
export interface MorePorts { save: Fn }
`;

describe('FR-8.2 implementations (TS): where an implementation is found', () => {
  it('FR-8.2 a shorthand property names the implementation: a function, a const alias of one, a cast arrow function; not a parameter, an undeclared body or a `let`', async () => {
    // one port per case (`P1` … `P6`), wired in its own file
    const ports = Array.from({ length: 6 }, (_, i) => `export interface P${i + 1} { save: Fn }`).join('\n');
    const { adapter, method } = tsProject({
      'src/p.ts': `export type Fn = (n: number) => void;\n${ports}\n`,
      'src/a1.ts': "import { P1 } from './p';\nfunction save(n: number) {}\nexport const ports: P1 = { save };\n",
      'src/a2.ts': "import { P2 } from './p';\nfunction real(n: number) {}\nconst save = real;\nexport const ports: P2 = { save };\n",
      'src/a3.ts': "import { P3, Fn } from './p';\nconst save = ((n: number) => {}) as Fn;\nexport const ports: P3 = { save };\n",
      'src/a4.ts': "import { P4, Fn } from './p';\nexport function make(save: Fn): P4 { return { save }; }\nexport class Wiring {\n  make(save: Fn): P4 { return { save }; }\n  wire({ save }: { save: Fn }): P4 { return { save }; }\n}\n",
      'src/a5.ts': "import { P5 } from './p';\ndeclare function save(n: number): void;\nexport const ports: P5 = { save };\n",
      'src/a6.ts': "import { P6 } from './p';\nlet save: any;\nexport const ports: P6 = { save };\n",
    });
    const of = async (i: number) => (await adapter.getImplementations(await method(`src/p.ts#P${i}.save`))).map((m) => m.key);
    expect(await of(1)).toEqual(['src/a1.ts#<module>.save']);
    expect(await of(2)).toEqual(['src/a2.ts#<module>.real']);
    expect(await of(3)).toEqual(['src/a3.ts#<module>.save']);
    expect(await of(4)).toEqual([]);
    expect(await of(5)).toEqual([]);
    expect(await of(6)).toEqual([]);
  });

  it('FR-8.2 class fields: an arrow function (also cast), the function a factory returns; a field without a value is none', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
function mk(): Fn { return (n) => {}; }
export class A implements FnPorts { save = (n: number) => {}; }
export class B implements FnPorts { save = mk(); }
export class C implements FnPorts { save: Fn; }
export class D implements FnPorts { save = ((n: number) => {}) as Fn; }
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#A.save', 'src/a.ts#D.save', 'src/a.ts#mk.<returned>']);
  });

  it('FR-8.2 a class field holding a factory product is implemented by what the factory returns', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': "import { Fn } from './p';\nfunction mk(): Fn { return (n) => {}; }\nexport class B { save: Fn = mk(); run() { this.save(1); } }\n",
    }, 'src/a.ts#B.save')).toEqual(['src/a.ts#mk.<returned>']);
  });

  it('FR-8.2 an abstract class between the interface and the concrete class: only the concrete method', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': "import { Ports } from './p';\nexport abstract class Base implements Ports { abstract save(n: number): void; }\nexport class Db extends Base { save(n: number) {} }\n",
    }, 'src/p.ts#Ports.save')).toEqual(['src/a.ts#Db.save']);
  });

  it('FR-8.2 an overloaded implementation: its body, once; an abstract override in between: only the concrete one', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': "import { Ports } from './p';\nexport class Db implements Ports { save(n: number): void; save(n: any) {} }\n",
    }, 'src/p.ts#Ports.save')).toEqual(['src/a.ts#Db.save']);
    expect(await impls({
      'src/p.ts': 'export abstract class Base { abstract save(n: number): void }\n',
      'src/a.ts': "import { Base } from './p';\nexport abstract class Mid extends Base { abstract save(n: number): void }\nexport class Db extends Mid { save(n: number) {} }\n",
    }, 'src/p.ts#Base.save')).toEqual(['src/a.ts#Db.save']);
  });

  it('FR-8.2 declarations without a body are no implementations: a `declare` field, a method of a `declare` class, an interface augmentation, an import', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/x.ts': 'export function save(n: number) {}\n',
      'src/a.ts': `import { Ports, FnPorts, Fn } from './p';
import { save } from './x';
export class C implements FnPorts { declare save: Fn; }
export declare class D implements Ports { save(n: number): void }
declare module './p' { interface FnPorts { save: Fn } }
export const p: FnPorts = { save };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/x.ts#<module>.save']);
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': "import { Ports } from './p';\nexport declare class D implements Ports { save(n: number): void }\nexport class E implements Ports { save(n: number) {} }\n",
    }, 'src/p.ts#Ports.save')).toEqual(['src/a.ts#E.save']);
  });

  it('FR-8.2 a value only typed like the member (`typeof ports.save`) is not an implementation, nor a method or field returning one', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts } from './p';
declare const ports: FnPorts;
export const helper: typeof ports.save = (n) => {};
export class K {
  mk(): typeof ports.save { return (n) => {}; }
  mk2 = (): typeof ports.save => class {} as any;
  mk3 = (): typeof ports.save => ({}) as any;
}
declare const deps: { save: (n: number) => void };
const { save } = deps;
export const fromDestructured: FnPorts = { save };
export const real: FnPorts = { save: (n) => {} };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#real.save']);
  });

  it('FR-8.2 implementations with the same class name in two files: sorted by file', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/sql/db.ts': "import { Ports } from '../p';\nexport class Db implements Ports { save(n: number) {} }\n",
      'src/mem/db.ts': "import { Ports } from '../p';\nexport class Db implements Ports { save(n: number) {} }\n",
      // the program meets the sql one first
      'src/a.ts': "export * from './sql/db';\nexport * from './mem/db';\n",
    }, 'src/p.ts#Ports.save')).toEqual(['src/mem/db.ts#Db.save', 'src/sql/db.ts#Db.save']);
  });
});

describe('FR-8.2 implementations (TS): what a member value evaluates to', () => {
  it('FR-8.2 both branches of `?:`, both sides of `??` / `||`; not an element of an array, `undefined`, an unknown name or a library function', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
declare const dev: boolean; declare const custom: Fn | undefined; declare const handlers: Fn[];
function a1(n: number) {} function a2(n: number) {} function a3(n: number) {} function a4(n: number) {} function a5(n: number) {}
export const p1: FnPorts = { save: dev ? a1 : a2 };
export const p2: FnPorts = { save: custom ?? a3 };
export const p3: FnPorts = { save: a5 || a4 };
export const p4: FnPorts = { save: handlers[0] };
export const p5: FnPorts = { save: undefined };
export const p6: FnPorts = { save: nothingHere };
export const p7: FnPorts = { save: console.log };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#<module>.a1', 'src/a.ts#<module>.a2', 'src/a.ts#<module>.a3', 'src/a.ts#<module>.a4', 'src/a.ts#<module>.a5']);
  });

  it('FR-8.2 a member of another object: its function (also a shorthand one); another port member: that port’s implementations', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, MorePorts } from './p';
function s1(n: number) {}
const short = { s1 };
const long = { s2: (n: number) => {} };
export const p1: FnPorts = { save: short.s1 };
export const p2: FnPorts = { save: long.s2 };
declare const more: MorePorts;
export const p3: FnPorts = { save: more.save };
export const m1: MorePorts = { save: (n) => {} };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#<module>.s1', 'src/a.ts#long.s2', 'src/a.ts#m1.save']);
  });

  it('FR-8.2 a member of a class-typed or Record-typed object: a field\'s value, an abstract method\'s overrides, the body of an overloaded method; a Record member: none', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
function fieldValue(n: number) {}
export class Holder { save: Fn = fieldValue; }
export abstract class Base { abstract save(n: number): void; }
export class Impl extends Base { save(n: number) {} }
export class Over { save(n: number): void; save(n: any) {} }
declare const holder: Holder; declare const base: Base; declare const over: Over; declare const rec: Record<'save', Fn>;
export const p1: FnPorts = { save: holder.save };
export const p2: FnPorts = { save: base.save };
export const p3: FnPorts = { save: over.save };
export const p4: FnPorts = { save: rec.save };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#<module>.fieldValue', 'src/a.ts#Impl.save', 'src/a.ts#Over.save']);
  });

  it('FR-8.2 a factory call: what it returns (expression body, `await`ed, a const holding the product); a factory returning no function is the implementation itself', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
const arrowMaker = () => (n: number) => {};
async function asyncMaker() { return (n: number) => {}; }
function logged(f: Fn): Fn { return f; }
function inner(n: number) {}
const made = arrowMaker();
export const p1: FnPorts = { save: made };
export const p2 = async (): Promise<FnPorts> => ({ save: await asyncMaker() });
export const p3: FnPorts = { save: logged(inner) };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#<module>.logged', 'src/a.ts#arrowMaker.<returned>', 'src/a.ts#asyncMaker.<returned>']);
  });

  it('FR-8.2 a factory as a method of an object, an unknown factory, a library one, one declared without body: only the known product', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
const factories = { make(): Fn { return (n) => {}; } };
declare function declared(): Fn;
export const p1: FnPorts = { save: factories.make() };
export const p2: FnPorts = { save: unknownFactory() };
export const p3: FnPorts = { save: Function.prototype.bind.call(1) };
export const p4: FnPorts = { save: declared() };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#make.<returned>']);
  });

  it('FR-8.2 a recursive factory is followed once (it is not an implementation itself); an empty `return` returns nothing', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, Fn } from './p';
function make(depth: number): Fn {
  if (depth < 0) return;
  if (depth > 0) return make(depth - 1);
  return (n) => {};
}
export const p: FnPorts = { save: make(2) };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#make.<returned>']);
  });

  it('FR-8.2 functions inside a callback (an object member, a method, a local function) are no callables: not offered as implementations', async () => {
    const { adapter, method } = tsProject({
      'src/p.ts': PORTS,
      'src/a.ts': "import { FnPorts, Ports } from './p';\ndeclare function later(f: () => void): void;\nlater(() => { const p: FnPorts = { save: (n) => {} }; });\nlater(() => { function save(n: number) {} const p: FnPorts = { save }; });\nlater(() => { const p: Ports = { save(n) {} }; });\n",
    });
    expect(await adapter.getImplementations(await method('src/p.ts#FnPorts.save'))).toEqual([]);
    expect(await adapter.getImplementations(await method('src/p.ts#Ports.save'))).toEqual([]);
  });

  it('FR-8.2 two ports implemented by each other: the cycle ends, no implementation', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'src/a.ts': `import { FnPorts, MorePorts } from './p';
declare const a: FnPorts; declare const b: MorePorts;
export const x: FnPorts = { save: b.save };
export const y: MorePorts = { save: a.save };
`,
    }, 'src/p.ts#FnPorts.save')).toEqual([]);
  });

  it('FR-8.2 a chain of more than six ports is cut (the deeper implementation is not reached)', async () => {
    const n = 8;
    const ports = Array.from({ length: n }, (_, i) => `export interface P${i} { save(x: number): void }`).join('\n');
    const wiring = Array.from({ length: n - 1 }, (_, i) => `declare const v${i + 1}: P${i + 1};\nexport const w${i}: P${i} = { save: v${i + 1}.save };`).join('\n');
    expect(await impls({
      'src/p.ts': `${ports}\n`,
      'src/a.ts': `import { ${Array.from({ length: n }, (_, i) => `P${i}`).join(', ')} } from './p';\n${wiring}\nexport const last: P${n - 1} = { save: (x) => {} };\nexport const near: P1 = { save: (x) => {} };\n`,
    }, 'src/p.ts#P0.save')).toEqual(['src/a.ts#near.save']);
  });

  it('FR-8.2 a function from a test file wired into production code is not an implementation', async () => {
    expect(await impls({
      'src/p.ts': PORTS,
      'test/fakes.ts': 'export function fakeSave(n: number) {}\n',
      'src/a.ts': "import { FnPorts } from './p';\nimport { fakeSave } from '../test/fakes';\nfunction realSave(n: number) {}\nexport const p1: FnPorts = { save: fakeSave };\nexport const p2: FnPorts = { save: realSave };\n",
    }, 'src/p.ts#FnPorts.save')).toEqual(['src/a.ts#<module>.realSave']);
  });
});
