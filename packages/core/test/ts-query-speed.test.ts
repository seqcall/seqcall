import * as fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { discoverProject, ProjectHost } from '../src/ts/host';
import { findImplementations, mayHaveImplementations } from '../src/ts/callers';
import type { TsModel } from '../src/ts/model';
import { tsProject, writeProject } from './ts-project';

// Shortcuts that make a TS project load, its entry points and its design-issue scan faster: each must answer exactly
// what the slow way answers.

/** The adapter's program-bound model and language service (internals, for comparing with the full search). */
const internals = (adapter: object) => adapter as unknown as { m: TsModel; ls: import('typescript').LanguageService; isTestFile: (rel: string) => boolean };

/** Every method of the project: skipped or not, and the implementations with and without the shortcut. */
async function compareAll(files: Record<string, string>) {
  const { adapter } = tsProject(files);
  const { m, ls, isTestFile } = internals(adapter);
  const skipped: string[] = [];
  for (const type of await adapter.getProjectTypes()) {
    for (const method of type.methods) {
      const node = m.findCallableByKey(method.key)!;
      const fast = findImplementations(m, ls, node, method, isTestFile).map((r) => r.key);
      const full = findImplementations(m, ls, node, method, isTestFile, false).map((r) => r.key);
      expect(fast, method.key).toEqual(full);
      if (!mayHaveImplementations(m, node, isTestFile)) skipped.push(method.key.split('#')[1]);
    }
  }
  return skipped.sort();
}

describe('implementation search skipped where none can exist (FR-8)', () => {
  it('FR-8 by name: a method no other declaration is named like has none; an interface member, an override and a re-exported or shorthand name are searched', async () => {
    const skipped = await compareAll({
      'src/ports.ts': 'export interface Store { save(n: number): void; }\nexport type Load = { load(): number };\n',
      'src/store.ts': "import type { Store } from './ports';\nexport class DbStore implements Store { save(n: number) {} flush() {} }\n",
      'src/shapes.ts': 'export class Shape { area() { return 0; } }\nexport class Square extends Shape { area() { return 4; } }\n',
      // the implementation of `load` is a function named otherwise, reached through a renamed re-export
      'src/impl.ts': 'export function readAll() { return 1; }\n',
      'src/index.ts': "export { readAll as load } from './impl';\n",
      'src/wire.ts': "import type { Load } from './ports';\nimport * as impl from './index';\nexport const loader: Load = impl;\nexport function unique() { return 2; }\n",
    });
    // (a class member also by its class: no class extends DbStore or Square)
    expect(skipped).toEqual(['<module>.unique', 'DbStore.flush', 'DbStore.save', 'Square.area']);
  });

  it('FR-8 a class member: skipped while no class extends or implements its class and no object literal is typed by it', async () => {
    const skipped = await compareAll({
      // value objects: `value` is declared many times, none of them implements another
      'src/money.ts': 'export class Money { get value() { return 1; } amount() { return 1; } }\n',
      'src/weight.ts': 'export class Weight { get value() { return 2; } amount() { return 2; } }\n',
      'src/plain.ts': 'export const value = 3;\nexport const point = { value: 4, amount: () => 4 };\n',
      // a subclass through a renamed import, an interface extending a class, a literal typed by a class
      'src/base.ts': 'export class Base { run() { return 1; } stop() { return 1; } }\nexport class Other { run() { return 0; } stop() { return 0; } }\n',
      'src/derived.ts': "import { Base as B } from './base';\nexport class Child extends B { run() { return 2; } }\n",
      'src/fake.ts': "import { Weight } from './weight';\nexport const w: Partial<Weight> = { amount() { return 9; } };\n",
    });
    // Base is extended, a literal typed Partial<Weight> holds `amount`: those are searched
    expect(skipped).toEqual(['Child.run', 'Money.amount', 'Money.value', 'Other.run', 'Other.stop', 'Weight.value']);
  });

  it('FR-8 a base held in a variable (`extends Base` of `const Base = …`): every class may have subclasses, none is skipped by its class', async () => {
    const skipped = await compareAll({
      'src/a.ts': 'export class Shape { draw() { return 1; } }\nexport class Line { draw() { return 2; } }\nconst Base = Shape;\nexport class Circle extends Base { draw() { return 3; } }\n',
    });
    expect(skipped).toEqual([]);
  });

  it('FR-8 a base that is no plain name (a mixin call): its function holds no class; the mixin\'s own `extends B` may be any class', async () => {
    // `extends Timed(Base)`: the mixin's function name holds no class; the mixin's own `extends B` (a parameter) may be
    // any class, so no class member is skipped by its class
    const mixin = await compareAll({
      'src/mix.ts': 'export function Timed<T extends new (...a: any[]) => object>(B: T) { return class extends B {}; }\nexport class Base { tick() { return 1; } }\nexport class Lone { tick() { return 0; } }\nexport class Clock extends Timed(Base) { tick() { return 2; } }\n',
    });
    expect(mixin).toEqual(['<module>.Timed']);
  });

  it('FR-8 a base no declaration answers (a missing import): any class may be extended, none is skipped by its class', async () => {
    const unknown = await compareAll({
      'src/a.ts': '// @ts-nocheck\nexport class Plain { go() { return 1; } }\nexport class Other { go() { return 2; } }\nexport class Sub extends Missing { go() { return 3; } }\n',
    });
    expect(unknown).toEqual([]);
  });

  it('FR-8 object literals: one typed by a union holds the member of each class in it; spread and computed members are left out', async () => {
    const literals = await compareAll({
      'src/pay.ts': 'export class Card { pay() { return 1; } refund() { return 1; } }\nexport class Cash { pay() { return 2; } refund() { return 2; } }\n',
      'src/use.ts': "import { Card, Cash } from './pay';\nconst k = 'x';\nconst base = { pay() { return 0; } };\nexport const p: Card | Cash = { ...base, [k]: 1, pay() { return 3; }, refund() { return 3; } };\nexport const q: Partial<Card> | number = { pay() { return 4; } };\n",
    });
    // (the union holds both classes' members: all are searched)
    expect(literals).toEqual([]);
  });

  it('FR-8 a method of a test file: its own name is not counted', async () => {
    // a method of a test file: its own name is not counted, so a name only it has has no implementation (and no class
    // extends FakeShop)
    const tests = await compareAll({
      'src/a.ts': 'export class Shop { open() { return 1; } }\n',
      'test/shop.test.ts': 'export class FakeShop { onlyHere() { return 1; } open() { return 2; } }\n',
    });
    expect(tests).toEqual(['FakeShop.onlyHere', 'FakeShop.open', 'Shop.open']);
  });

  it('FR-8 a member with a computed name (`[key]()`) is searched: its name is not known', async () => {
    const { adapter } = tsProject({ 'src/a.ts': "const key = 'run';\nexport class Job { [key]() { return 1; } plain() { return 2; } }\n" });
    const { m, isTestFile } = internals(adapter);
    const job = m.findCallableByKey('src/a.ts#Job.plain')!.parent as import('typescript').ClassDeclaration;
    const computed = job.members.find((x) => x.name && !('text' in x.name))!;
    expect(mayHaveImplementations(m, computed as never, isTestFile)).toBe(true);
    expect(mayHaveImplementations(m, m.findCallableByKey('src/a.ts#Job.plain')!, isTestFile)).toBe(false);
  });

  it('FR-8 a member holding another value (`save = makeSaver()`) is searched: it leads to the function the factory returns', async () => {
    const { adapter } = tsProject({
      'src/a.ts': 'function makeSaver() { return (n: number) => n; }\nexport class Repo { save = makeSaver(); }\n',
    });
    const { m, isTestFile } = internals(adapter);
    expect(mayHaveImplementations(m, m.findCallableByKey('src/a.ts#Repo.save')!, isTestFile)).toBe(true);
  });
});

describe('TsAdapter answers once per program (FR-31)', () => {
  it('FR-31 repeated queries come from memory until a file changes; a returned list is a copy', async () => {
    const { root, adapter, method } = tsProject({
      'src/a.ts': 'export class A { run() { return this.step(); } step() { return 1; } }\n',
    });
    const run = await method('src/a.ts#A.run');
    const first = await adapter.getOutgoingCalls(run);
    expect(first.map((c) => c.methodName)).toEqual(['step']);
    first.length = 0; // a caller sorting / emptying its list does not change the next answer
    expect((await adapter.getOutgoingCalls(run)).map((c) => c.methodName)).toEqual(['step']);
    fs.writeFileSync(`${root}/src/a.ts`, 'export class A { run() { return this.other(); } other() { return 1; } }\n');
    await adapter.updateFile(`${root}/src/a.ts`);
    expect((await adapter.getOutgoingCalls(await method('src/a.ts#A.run'))).map((c) => c.methodName)).toEqual(['other']);
  });

  it('FR-15.1 a file created after the first load is found once the editor reports it (no stale "does not exist")', async () => {
    const { root, adapter, method } = tsProject({
      'src/a.ts': "import { later } from './later';\nexport function run() { return later(); }\n",
    });
    expect((await adapter.getOutgoingCalls(await method('src/a.ts#<module>.run')))[0]?.target).toBeUndefined();
    fs.writeFileSync(`${root}/src/later.ts`, 'export function later() { return 1; }\n');
    await adapter.updateFile(`${root}/src/later.ts`);
    expect((await adapter.getOutgoingCalls(await method('src/a.ts#<module>.run')))[0]?.target?.key).toBe('src/later.ts#<module>.later');
  });

  it('FR-15.1 JSDoc types of JavaScript files still type the code (JSDoc is skipped only in TypeScript files)', async () => {
    const { adapter, method } = tsProject(
      {
        'src/order.js': 'export class Order { save() { return 1; } }\n',
        'src/use.js': "/** @param {import('./order').Order} o */\nexport function keep(o) { return o.save(); }\n",
      },
      { compilerOptions: { allowJs: true, checkJs: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'node' } },
    );
    expect((await adapter.getOutgoingCalls(await method('src/use.js#<module>.keep')))[0]?.target?.key).toBe('src/order.js#Order.save');
  });
});

describe('route handlers answered without types where possible (FR-16.1)', () => {
  it('FR-16.1 an HTTP client call with an object literal is no route; a method, a function, a typed variable keep their old answers', async () => {
    const { adapter } = tsProject({
      'src/routes.ts': `declare const app: any;
declare const api: { post(url: string, init: object): void };
export class Ctrl { list(req: unknown) {} }
const ctrl = new Ctrl();
function health(req: unknown) {}
const notAFunction: object = () => {};
app.get('/orders', ctrl.list);
app.get('/health', health);
app.get('/odd', notAFunction);
export function send() { api.post('/orders', { body: 1 }); api.post('/list', [1]); api.post('/x', 'text'); }
`,
    });
    expect((await adapter.getEntryPoints()).filter((e) => e.kind === 'http').map((e) => `${e.label} → ${e.method.key.split('#')[1]}`)).toEqual([
      'GET /health → <module>.health',
      'GET /orders → Ctrl.list',
    ]);
  });

  it('FR-16.1 handlers by name: imported, inline-function variables and properties (typed or not); an undeclared name, a value or a factory\'s result (no method to show) is no route', async () => {
    const { adapter } = tsProject({
      'src/handlers.ts': 'export function ping(req: unknown) {}\n',
      'src/routes.ts': `// @ts-nocheck
import { ping } from './handlers';
declare const app: any;
const arrow = (req) => {};
const fn = function (req) {};
const typed: (req: unknown) => void = (req) => {};
const made = makeHandler();
const value = 3;
const table = { show: (req) => {}, count: 1 };
function makeHandler() { return (req) => {}; }
app.get('/ping', ping);
app.get('/arrow', arrow);
app.get('/fn', fn);
app.get('/typed', typed);
app.get('/made', made);
app.get('/value', value);
app.get('/show', table.show);
app.get('/count', table.count);
app.get('/missing', notDeclared);
`,
    });
    expect((await adapter.getEntryPoints()).filter((e) => e.kind === 'http').map((e) => e.label).sort()).toEqual([
      'GET /arrow',
      'GET /fn',
      'GET /ping',
      'GET /show',
      'GET /typed',
    ]);
  });
});

describe('file checks kept while a program is built (FR-15.1)', () => {
  it('FR-15.1 a path is checked on disk once until the next update', () => {
    const root = writeProject({ 'src/a.ts': '' });
    const host = new ProjectHost(root, discoverProject(root));
    const disk = vi.spyOn(ts.sys, 'fileExists');
    const dirs = vi.spyOn(ts.sys, 'directoryExists');
    expect(host.fileExists(`${root}/src/a.ts`)).toBe(true);
    expect(host.fileExists(`${root}/src/a.ts`)).toBe(true);
    expect(host.directoryExists(`${root}/src`)).toBe(true);
    expect(host.directoryExists(`${root}/src`)).toBe(true);
    expect(disk).toHaveBeenCalledTimes(1);
    expect(dirs).toHaveBeenCalledTimes(1);
    fs.writeFileSync(`${root}/src/b.ts`, '');
    expect(host.fileExists(`${root}/src/b.ts`)).toBe(true);
    host.updateFile(`${root}/src/b.ts`);
    expect(host.fileExists(`${root}/src/a.ts`)).toBe(true);
    expect(disk).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });
});
