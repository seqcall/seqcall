import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// TsAdapter queries on small projects: what each one answers for files and keys the program does not know (any more).

const ORDER = `export class Order {
  total(a: number): number;
  total(a: string): number;
  total(a: any) { return a ? 1 : 2; }
  get id() { return 1; }
  constructor(n: number);
  constructor(n: any) {}
}
export abstract class Base {
  abstract run(): void;
}
export interface Repo { find(id: string): Order; find(id: number): Order; }
export function f(a: string): void;
export function f(a: any) {}
export declare function g(): void;
export const h = () => 1, n = 2;
`;

describe('TsAdapter.getFileTypes (FR-31.1)', () => {
  it('FR-31.1 each class / interface with its methods, module functions last; an overloaded method once (in a class: its implementation)', async () => {
    const { root, adapter } = tsProject({ 'src/order.ts': ORDER });
    const types = await adapter.getFileTypes(`${root}/src/order.ts`);
    expect(types.map((t) => ({ type: t.type.key, kind: t.type.kind, methods: t.methods.map((m) => `${m.name}${m.hasBody ? '' : ' (no body)'}`) }))).toEqual([
      { type: 'src/order.ts#Order', kind: 'class', methods: ['total', 'id', 'constructor'] },
      { type: 'src/order.ts#Base', kind: 'abstract', methods: ['run (no body)'] },
      { type: 'src/order.ts#Repo', kind: 'interface', methods: ['find (no body)'] },
      { type: 'src/order.ts#<module>', kind: 'module', methods: ['f', 'h'] },
    ]);
  });

  it('FR-31.1 a file outside the program or in a library: no types', async () => {
    const { root, adapter } = tsProject({
      'src/a.ts': `import { pad } from 'text';\nexport const x = pad();\n`,
      'node_modules/text/index.ts': 'export class Pad { run() {} }\nexport function pad() { return 1; }\n',
      'node_modules/text/package.json': '{"name":"text","main":"index.ts"}',
    });
    expect(await adapter.getFileTypes(`${root}/node_modules/text/index.ts`)).toEqual([]);
    expect(await adapter.getFileTypes(`${root}/src/missing.ts`)).toEqual([]);
  });
});

describe('TsAdapter.findEnclosingCallable (FR-1.1)', () => {
  it('FR-1.1 a position past the end of the file (a stale editor position), a library file or an unknown file: no method', async () => {
    const { root, adapter, at } = tsProject({
      'src/a.ts': `import { pad } from 'text';\nexport function run() { return pad(); }\n`,
      'node_modules/text/index.ts': 'export function pad() {\n  return 1;\n}\n',
      'node_modules/text/package.json': '{"name":"text","main":"index.ts"}',
    });
    expect((await adapter.findEnclosingCallable(`${root}/src/a.ts`, at('src/a.ts', 'pad()')))?.key).toBe('src/a.ts#<module>.run');
    expect(await adapter.findEnclosingCallable(`${root}/src/a.ts`, { line: 99, character: 0 })).toBeUndefined();
    expect(await adapter.findEnclosingCallable(`${root}/node_modules/text/index.ts`, { line: 1, character: 2 })).toBeUndefined();
    expect(await adapter.findEnclosingCallable(`${root}/src/missing.ts`, { line: 0, character: 0 })).toBeUndefined();
  });
});

describe('TsAdapter: a method deleted since its MethodRef was taken (FR-13.1 re-analysis after a save)', () => {
  it('FR-13.1 every query on the stale MethodRef answers "nothing" instead of failing', async () => {
    const { root, adapter, method } = tsProject({
      'src/a.ts': `export interface Port { save(n: number): void; }
export interface Clock { now(): number; }
export class Db implements Port { save(n: number) {} }
export class Shop {
  constructor(private port: Port) {}
  buy(n: number, at?: Clock): number {
    if (n < 0) return 0;
    this.port.save(n);
    return n;
  }
}
export function main() { new Shop(new Db()).buy(1); }
`,
    });
    const buy = await method('src/a.ts#Shop.buy');
    const save = await method('src/a.ts#Port.save');
    // before: there is something to find
    expect((await adapter.getOutgoingCalls(buy)).map((c) => c.methodName)).toEqual(['save']);
    expect((await adapter.getEarlyExits(buy)).length).toBe(1);
    expect((await adapter.getReturns(buy)).length).toBe(2);
    expect((await adapter.getTypeUses(buy)).map((u) => u.type.key)).toEqual(['src/a.ts#Clock']);
    expect((await adapter.getImplementations(save)).map((m) => m.key)).toEqual(['src/a.ts#Db.save']);
    expect((await adapter.getCallers(buy)).map((c) => c.enclosing.key)).toEqual(['src/a.ts#<module>.main']);
    expect(await adapter.getParameterNames(buy)).toEqual(['n', 'at']);

    await adapter.updateFile(`${root}/src/a.ts`, 'export const nothing = 1;\n');
    expect(await adapter.getMethod(buy.key)).toBeUndefined();
    expect(await adapter.getOutgoingCalls(buy)).toEqual([]);
    expect(await adapter.getEarlyExits(buy)).toEqual([]);
    expect(await adapter.getReturns(buy)).toEqual([]);
    expect(await adapter.getTypeUses(buy)).toEqual([]);
    expect(await adapter.getImplementations(save)).toEqual([]);
    expect(await adapter.getCallers(buy)).toEqual([]);
    expect(await adapter.getParameterNames(buy)).toEqual([]);
  });
});

describe('TsAdapter.warmUp (FR-16.10)', () => {
  it('FR-16.10 warmUp builds the program before the first request', async () => {
    const { adapter } = tsProject({ 'src/a.ts': 'export function run() {}\n' });
    const model = () => (adapter as unknown as { model: unknown }).model;
    expect(model()).toBeUndefined();
    await adapter.warmUp();
    expect(model()).not.toBeUndefined();
    expect((await adapter.getMethod('src/a.ts#<module>.run'))?.name).toBe('run');
  });
});
