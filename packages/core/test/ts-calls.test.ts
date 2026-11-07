import { describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { DEFAULT_TSCONFIG, tsProject } from './ts-project';

// FR-1.4 / FR-1.13 / FR-5 / FR-6.5 / FR-9 the call sites of a TS method: targets, receivers, arguments, results, for
// the less common shapes of calls (also broken code: users' files are often mid-edit).

const PORTS = `export type Lister = (dir: string) => string[];
export class Order { constructor(public id?: string) {} total() { return 1; } }
export declare class Remote { send(): void; constructor(url: string); }
export interface Weird { then(x: number): void }
`;

const SHOP = `import type { Lister } from './ports';
import { Order, Remote, Weird } from './ports';
import { Missing } from './nowhere';
declare const Ctor: any;
declare function weird(): Weird;
type Handler = (n: number) => void;
export class Base { save(n: number) {} }
export class Shop extends Base {
  id = 'x';
  get total() { return 1; }
  save(n: number) { super.save(n); }
  over(a: string): void;
  over(a: any) {}
  run(list: Lister, cb: Missing, fn: Function) {
    list('a');
    cb();
    fn();
  }
  creates({ id }: { id: string }) {
    new Order(this.id, id);
    new Order(id);
    new Order;
    new Date;
    new Ctor();
    let o;
    o = new Order();
  }
  handler: Handler = (n) => {};
  names(key: string) {
    this['handler'](0);
    'abc'.toUpperCase();
    this['save'](1);
    (Math.random() > 0.5 ? this.save : this.over)(1);
    this[key]();
    this.over('x');
  }
  async awaits() {
    const done = await new Promise((resolve) => resolve(1));
    await weird();
    return done;
  }
  remote() {
    new Remote('u').send();
  }
}
function Legacy(this: any) { this.x = 1; }
interface Legacy { x: number }
export function legacy() { return new Legacy(); }
export function classCall() { return (Order as any)('x'); }
`;

const describeCall = (c: CallSite) => [c.kind, c.methodName, c.target?.key ?? null];

describe('FR-1.4 call targets (TS)', () => {
  const { adapter, method } = tsProject({ 'src/ports.ts': PORTS, 'src/shop.ts': SHOP }, undefined, true);
  const calls = async (key: string) => adapter.getOutgoingCalls(await method(key));

  it('FR-1.4 a call through `this["name"]` (also of a function-typed field), a conditional callee, a computed member, an overload: by name where known', async () => {
    const c = await calls('src/shop.ts#Shop.names');
    expect(c.map(describeCall)).toEqual([
      // a field typed by a function type alias, called by `this['handler']`
      ['call', 'handler', 'src/shop.ts#Shop.handler'],
      ['call', 'toUpperCase', 'lib:lib#String.toUpperCase'],
      ['call', 'save', 'src/shop.ts#Shop.save'],
      ['call', 'random', 'lib:lib#Math.random'],
      ['call', 'Math.random() > 0.5 ? this.save : this.over', 'src/shop.ts#Shop.save'],
      ['call', 'this[key]', null],
      // an overloaded method: its implementation
      ['call', 'over', 'src/shop.ts#Shop.over'],
    ]);
    expect(c[1].receiverType?.key).toBe('lib:lib'); // a string: the method's owner
    expect(c[4].receiver).toEqual({ kind: 'expression', text: 'Math.random() > 0.5 ? this.save : this.over' });
    expect(c[6].target?.hasBody).toBe(true);
  });

  it('FR-1.4 creations: of a project class without parentheses, of a library class, of an `any` value (unresolved), of a JS-style constructor function', async () => {
    const c = await calls('src/shop.ts#Shop.creates');
    expect(c.map(describeCall)).toEqual([
      ['create', 'constructor', 'src/ports.ts#Order.constructor'],
      ['create', 'constructor', 'src/ports.ts#Order.constructor'],
      ['create', 'constructor', 'src/ports.ts#Order.constructor'],
      ['create', 'constructor', 'lib:lib#DateConstructor.constructor'],
      ['create', 'constructor', null],
      ['create', 'constructor', 'src/ports.ts#Order.constructor'],
    ]);
    expect([c[2].args, c[3].args]).toEqual([[], []]);
    expect(c[4].untypedReceiver).toBeUndefined();
    const [legacy] = await calls('src/shop.ts#<module>.legacy');
    expect([legacy.target?.key, legacy.receiverType?.key]).toEqual(['src/shop.ts#<module>.Legacy', 'src/shop.ts#<module>']);
  });

  it('FR-1.4 a class called without `new` (a mistake mid-edit) still targets its constructor; a declared class: its constructor and methods without body', async () => {
    const [call] = await calls('src/shop.ts#<module>.classCall');
    expect([call.kind, call.target?.key, call.target?.hasBody]).toEqual(['call', 'src/ports.ts#Order.constructor', true]);
    const remote = await calls('src/shop.ts#Shop.remote');
    expect(remote.map((x) => [x.target?.key, x.target?.hasBody])).toEqual([
      ['src/ports.ts#Remote.constructor', false],
      ['src/ports.ts#Remote.send', false],
    ]);
  });

  it('FR-1.13 invoked parameters: the named function type (also imported as a type); a type from a missing file or a library type is none', async () => {
    const c = await calls('src/shop.ts#Shop.run');
    expect(c.map((x) => [x.invokedParameter, x.invokedParameterType?.key ?? null])).toEqual([
      ['list', 'src/ports.ts#Lister'],
      ['cb', null],
      ['fn', null],
    ]);
  });

  it('FR-6.5 `super.save()`: the base class method on the «super» receiver', async () => {
    const [c] = await calls('src/shop.ts#Shop.save');
    expect([c.target?.key, c.receiver, c.receiverType?.key]).toEqual(['src/shop.ts#Base.save', { kind: 'super' }, 'src/shop.ts#Shop']);
  });

  it('FR-9.4 / FR-9.5 `await new Promise(…)` assigned to a local; the type of an awaited value that is no valid promise is kept', async () => {
    const c = await calls('src/shop.ts#Shop.awaits');
    expect(c.map((x) => [x.methodName, x.assignedTo ?? null, x.returnType ?? null])).toEqual([
      ['constructor', { kind: 'local', name: 'done' }, null],
      // the executor runs inside the library call (FR-1.11)
      ['resolve', null, null],
      ['weird', null, 'Weird'],
    ]);
  });

  it('FR-5.10 where creation arguments come from: a field or a destructured parameter (not fixed), none (fixed), an assignment to a declared local', async () => {
    const c = await calls('src/shop.ts#Shop.creates');
    expect(c.map((x) => [x.argsFrom ?? null, x.assignedTo ?? null])).toEqual([
      [null, null],
      [null, null],
      ['fixed', null],
      [null, null],
      [null, null],
      ['fixed', { kind: 'local', name: 'o' }],
    ]);
  });
});

const FLOW = `import { Order, Store, getStore } from './ports';
declare function run(f: any, ...rest: any[]): void;
declare function later(f: () => void): void;
declare const anyRouter: any;
export function helper(n: number) {}
function untyped(x: any, ...more: any[]) {}
// a rest parameter typed any (an error mid-edit)
function loose(x: any, ...more: any) {}
export class Flow {
  get total() { return 1; }
  handle(n: number) {}
  args(deps: { save: (n: number) => void }) {
    run(this.handle.bind(this));
    run(helper);
    run(Math.max);
    run(deps.save);
    run(missingName);
    const local = () => 1;
    run(local);
    run(((x) => helper(x)));
    run((x = new Order()) => helper(1));
    run(({ id }) => helper(id));
    untyped(...[new Order()]);
    untyped(new Order(), new Order());
    loose(1, new Order());
  }
  async receivers() {
    const { clear } = await getStore();
    clear();
    missing.save();
    globalThis.setTimeout(() => {}, 1);
    makeFn()();
  }
  accessors() {
    this.total;
    delete this.total;
    typeof this.total;
    if (this.total) helper(1);
    later(() => { const o = { get size() { return 1; } }; return o.size; });
  }
  options() {
    new anyRouter.trim();
    anyRouter.route({ handler() {}, ['x']: () => helper(0), cb: ((n: number) => helper(n)), ...{} });
    [1].map((x => helper(x)));
  }
}
declare function makeFn(): () => void;
export function withThis(this: Flow) { this.handle(1); run(this.handle); }
`;

describe('FR-1.13 / FR-6.5 arguments and receivers (TS)', () => {
  const { adapter, method } = tsProject({
    'src/ports.ts': 'export class Order { constructor(public id?: string) {} }\nexport interface Store { clear(): void }\nexport declare function getStore(): Promise<Store>;\n',
    'src/flow.ts': FLOW,
  }, undefined, true);
  const calls = async (key: string) => adapter.getOutgoingCalls(await method(key));

  it('FR-1.13 functions passed as arguments: bound method, module function, library method, a local helper; not a member of an inline type or an unknown name', async () => {
    const c = (await calls('src/flow.ts#Flow.args')).filter((x) => x.methodName === 'run' && !x.args[0].includes('=>'));
    expect(c.map((x) => {
      const f = x.argFunctions?.[0];
      return f?.kind === 'method' ? [x.args[0], f.target.key, f.receiver, f.receiverType?.key ?? null, f.libraryName ?? null] : [x.args[0], null];
    })).toEqual([
      ['this.handle.bind(this)', 'src/flow.ts#Flow.handle', { kind: 'self' }, 'src/flow.ts#Flow', null],
      ['helper', 'src/flow.ts#<module>.helper', { kind: 'module', name: 'helper' }, null, null],
      ['Math.max', 'lib:lib#Math.max', { kind: 'local', name: 'Math' }, 'lib:lib', 'lib'],
      ['deps.save', null],
      ['missingName', null],
      ['local', 'src/flow.ts#Flow.args.local', { kind: 'module', name: 'local' }, null, null],
    ]);
  });

  it('FR-1.13 a `this` method passed outside a class (a `this` parameter): no receiver class', async () => {
    const [call, passing] = await calls('src/flow.ts#<module>.withThis');
    expect(call.receiverType?.key).toBe('src/flow.ts#Flow'); // the target's owner
    const f = passing.argFunctions?.[0];
    expect(f?.kind === 'method' && [f.target.key, f.receiverType]).toEqual(['src/flow.ts#Flow.handle', undefined]);
  });

  it('FR-1.11 lambdas passed to a project function carry their calls: in parentheses, with a defaulted parameter (its value first), a destructured parameter (no name)', async () => {
    const c = (await calls('src/flow.ts#Flow.args')).filter((x) => x.methodName === 'run' && x.args[0].includes('=>'));
    expect(c.map((x) => {
      const f = x.argFunctions?.[0];
      return f?.kind === 'lambda' ? [f.params, f.calls?.map((y) => y.methodName)] : null;
    })).toEqual([
      [['x'], ['helper']],
      [['x'], ['constructor', 'helper']],
      [[''], ['helper']],
    ]);
  });

  it('FR-6.5 local helpers and unknown names passed on are no argument origins; created objects are', async () => {
    const c = await calls('src/flow.ts#Flow.args');
    const byText = (t: string) => c.find((x) => x.expressionText === t)!;
    expect(byText('run(local)').argOrigins).toBeUndefined();
    expect(byText('run(missingName)').argOrigins).toBeUndefined();
    expect(byText('untyped(new Order(), new Order())').argOrigins).toEqual([{ kind: 'created', ordinal: 12 }, { kind: 'created', ordinal: 13 }]);
  });

  it('FR-1.19 what is passed for `any` parameters: the class of a created object; nothing for a spread or a rest parameter', async () => {
    const c = await calls('src/flow.ts#Flow.args');
    expect(c.find((x) => x.expressionText === 'untyped(...[new Order()])')!.argTypes).toBeUndefined();
    expect(c.find((x) => x.expressionText === 'loose(1, new Order())')!.argTypes).toBeUndefined();
    expect(c.find((x) => x.expressionText === 'untyped(new Order(), new Order())')!.argTypes).toEqual([
      { type: { key: 'src/ports.ts#Order', name: 'Order', kind: 'class', declaration: expect.anything() }, isLibrary: false },
      undefined,
    ]);
  });

  it('FR-6.5 receivers: a local destructured from an awaited call (the call is the receiver), an unknown name, `globalThis`, a called call', async () => {
    const c = await calls('src/flow.ts#Flow.receivers');
    expect(c.map((x) => [x.expressionText, x.receiver])).toEqual([
      ['getStore()', { kind: 'module', name: 'getStore' }],
      ['clear()', { kind: 'expression', text: 'getStore()' }],
      ['missing.save()', { kind: 'local', name: 'missing' }],
      ['globalThis.setTimeout(() => {}, 1)', { kind: 'local', name: 'globalThis' }],
      ['makeFn()', { kind: 'module', name: 'makeFn' }],
      ['makeFn()()', { kind: 'expression', text: 'makeFn()' }],
    ]);
    expect(c[2].untypedReceiver).toBe('missing');
  });

  it('FR-1.18 getter reads: not under `delete` / `typeof`; a condition is read outside its frame; a getter of an object literal in a callback is no callable', async () => {
    const c = await calls('src/flow.ts#Flow.accessors');
    expect(c.map((x) => [x.methodName, x.accessor ?? null, x.fragments?.map((f) => `${f.kind}:${f.guard}`) ?? null])).toEqual([
      ['total', 'get', null],
      // the condition is read before the frame
      ['total', 'get', null],
      ['helper', null, ['opt:this.total']],
      ['later', null, null],
    ]);
    const lambda = c[3].argFunctions?.[0];
    expect(lambda?.kind === 'lambda' && lambda.calls).toEqual([]);
  });

  it('FR-1.11 an options object passed to an unresolved call: its function-valued properties (also in parentheses) run there; methods, computed names and spreads are not followed', async () => {
    const c = await calls('src/flow.ts#Flow.options');
    expect(c.map((x) => [x.methodName, x.fragments?.map((f) => `${f.kind}:${f.guard}`) ?? null])).toEqual([
      ['constructor', null],
      ['route', null],
      ['helper', ['callback:anyRouter.route: cb']],
      ['map', null],
      ['helper', ['loop:each x of [1]']],
    ]);
    // `new` through a value typed any: unresolved, and not taken for a String method or explained by its receiver
    expect([c[0].target, c[0].untypedReceiver]).toEqual([undefined, undefined]);
  });
});

describe('FR-1.20 JSX props that run functions (TS)', () => {
  it('FR-1.20 a handler written in place or a local function (an overloaded one by its implementation) is drawn at its prop; a member or a declaration without body is not', async () => {
    const { adapter, method } = tsProject({
      'src/page.tsx': `declare const handlers: { save(): void };
export function helper(n: number) {}
export function Page() {
  function onJoin(n: number): void;
  function onJoin(n: any) { helper(2); }
  function onLeave(): void;
  return (
    <div>
      <button onClick={() => helper(1)} />
      <button onClick={onJoin} />
      <button onClick={handlers.save} />
      <button onClick={onLeave} />
    </div>
  );
}
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    const c = await adapter.getOutgoingCalls(await method('src/page.tsx#<module>.Page'));
    expect(c.map((x) => [x.methodName, x.fragments?.map((f) => `${f.kind}:${f.guard}`) ?? null])).toEqual([
      ['helper', ['callback:button onClick: on click']],
      ['helper', ['callback:button onClick: on click']],
    ]);
  });
});

describe('FR-1.4 calls of callables without a body; argument texts (TS)', () => {
  it('FR-1.4 an interface method or a function-typed property runs nothing', async () => {
    const { adapter, method } = tsProject({ 'src/a.ts': 'export interface Port { save(n: number): void; load: (id: string) => void }\n' });
    expect(await adapter.getOutgoingCalls(await method('src/a.ts#Port.save'))).toEqual([]);
    expect(await adapter.getOutgoingCalls(await method('src/a.ts#Port.load'))).toEqual([]);
  });

  it('FR-9.2 argument texts without comments: a space where a comment separated two tokens, none before closing punctuation', async () => {
    const { adapter, method } = tsProject({
      'src/a.ts': 'declare function f(...a: unknown[]): void;\nexport function run(a: number, b: number) {\n  f(a/* first */+b, a /* second */, (b/* third */));\n}\n',
    });
    const [call] = await adapter.getOutgoingCalls(await method('src/a.ts#<module>.run'));
    expect(call.args).toEqual(['a +b', 'a', '(b)']);
  });

  it('FR-1.18 a getter read inside a frame carries the frame', async () => {
    const { adapter, method } = tsProject({ 'src/a.ts': 'export class A {\n  get total() { return 1; }\n  run(x: boolean) {\n    if (x) return this.total;\n  }\n}\n' });
    const [read] = await adapter.getOutgoingCalls(await method('src/a.ts#A.run'));
    expect([read.accessor, read.fragments?.map((f) => `${f.kind}:${f.guard}`)]).toEqual(['get', ['opt:x']]);
  });
});
