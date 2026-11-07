import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { objectTargets } from '../src/session/build';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-interchangeable-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], strict: false, jsx: 'preserve', moduleResolution: 'node' }, include: ['src'] }));
write('node_modules/react/package.json', JSON.stringify({ name: 'react', types: 'index.d.ts' }));
write('node_modules/react/index.d.ts', 'export function useMemo<T>(factory: () => T, deps: unknown[]): T;\n');
// as a React front end: facades over a shared store, created per component by a hook
write('src/store.ts', `export class Store { isMobile = false; }
const store = new Store();
export function getStore(): Store { return store; }
`);
write('src/classes.ts', `import { getStore } from './store';
export class View { isMobile(): boolean { return getStore().isMobile; } }
export class Handler {
  store = getStore();
  label = 'handler';
  toggle(): void { this.store.isMobile = !this.store.isMobile; }
}
export class ViewHandler {
  view: View;
  handler: Handler;
  constructor() { this.view = new View(); this.handler = new Handler(); }
}
// not interchangeable
export class WithParams { constructor(readonly name: string) {} }
export class Counter { count = 0; inc(): void { this.count++; } }
export class Assigns { last?: string; set(v: string): void { this.last = v; } }
export class Later { run: () => void; constructor() { this.run = () => { this.done = true; }; } done = false; }
export class Cache { items = new Map<string, string>(); }
export class List { items: string[] = []; }
export class HoldsCounter { c = new Counter(); }
export class Child extends View {}
export class CountingChild extends Counter {}
// same arguments → same object (FR-5.10 B): a base storing what it is given, a subclass passing its parameter on
export class Base { protected store: Store; constructor(store: Store) { this.store = store; } }
export class CartView extends Base { constructor(store: Store) { super(store); } read(): boolean { return this.store.isMobile; } }
export class CartHandler extends Base { constructor(store: Store) { super(store); } toggle(): void { this.store.isMobile = !this.store.isMobile; } }
export class CartViewHandler {
  view: CartView;
  handler: CartHandler;
  constructor(store: Store) { this.view = new CartView(store); this.handler = new CartHandler(store); }
}
export class Random { value: number; constructor() { this.value = 0; } }
export class Picky extends Base { constructor() { super(new Store()); } }
export class Seeded { inner: CartView; constructor(store: Store, n: number) { this.inner = new CartView(n > 0 ? store : store); } }
`);
write('src/live-hook.ts', `import { useMemo } from 'react';
import { getStore } from './store';
import { CartViewHandler } from './classes';
export function useLive(): CartViewHandler {
  const store = getStore();
  return useMemo(() => new CartViewHandler(store), [store]);
}
export function useLiveFor(store: Store): CartViewHandler { return useMemo(() => new CartViewHandler(store), [store]); }
import type { Store } from './store';
`);
write('src/live.tsx', `import { useLive, useLiveFor } from './live-hook';
import { getStore } from './store';
export function Score() { const { view } = useLive(); view.read(); return <b />; }
export function Popup() { const { handler: h } = useLive(); h.toggle(); return <i />; }
export function Board() { return (<main><Score /><Popup /></main>); }
export function Twice() {
  const a = useLiveFor(getStore());
  const b = useLiveFor(getStore());
  a.view.read();
  b.view.read();
  return <p />;
}
`);
write('src/hook.ts', `import { useMemo } from 'react';
import { ViewHandler } from './classes';
export function useViewHandler(): ViewHandler { return useMemo(() => new ViewHandler(), []); }
`);
write('src/components.tsx', `import { useViewHandler } from './hook';
import { Counter } from './classes';
export function Header() { const { view } = useViewHandler(); view.isMobile(); return <div />; }
export function Footer() { const { view, handler } = useViewHandler(); view.isMobile(); handler.toggle(); return <p />; }
export function Page() {
  const a = new Counter();
  const b = new Counter();
  a.inc();
  b.inc();
  return (<main><Header /><Footer /></main>);
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-5.10 interchangeable objects (TS)', () => {
  const adapter = createTsAdapter(root);
  const info = async (name: string) => (await adapter.getClassInfo(`src/classes.ts#${name}`))!.interchangeable ?? false;

  it('FR-5.10 a class without state of its own: no constructor parameters, fields set only in the constructor, shared or interchangeable values', async () => {
    for (const c of ['View', 'Handler', 'ViewHandler', 'Child']) expect(await info(c), c).toBe(true);
  });

  it('FR-5.10 alike when built with the same arguments: parameters stored or passed on (super, nested new); not with own values or other arguments', async () => {
    const same = async (name: string) => (await adapter.getClassInfo(`src/classes.ts#${name}`))!.sameArgsInterchangeable ?? false;
    for (const c of ['Base', 'CartView', 'CartHandler', 'CartViewHandler', 'WithParams', 'View']) expect(await same(c), c).toBe(true);
    for (const c of ['CartView', 'CartViewHandler']) expect(await info(c), c).toBe(false);
    // `super(new Store())` builds its own store; `new CartView(n > 0 ? store : store)` is no plain parameter
    for (const c of ['Picky', 'Seeded', 'Counter', 'CountingChild']) expect(await same(c), c).toBe(false);
  });

  it('FR-5.10 not interchangeable: constructor parameters, fields written later (methods, ++, stored functions), own collections or stateful objects, extends', async () => {
    for (const c of ['WithParams', 'Counter', 'Assigns', 'Later', 'Cache', 'List', 'HoldsCounter', 'CountingChild']) expect(await info(c), c).toBe(false);
  });

  it('FR-5.10 objects a hook creates in each component: one lifeline per class, ×n; objects with state keep one lifeline each', async () => {
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await session.openMethodByKey('src/components.tsx#<module>.Page');
    const d = (await session.expandEverything())!;
    const lifelines = (cls: string) => d.participants.filter((p) => p.className === cls);
    for (const cls of ['ViewHandler', 'View', 'Handler']) {
      expect(lifelines(cls), cls).toHaveLength(1);
      expect(lifelines(cls)[0].instances, cls).toBe(2);
    }
    // the calls through `const { view } = useViewHandler()` are on the created object's lifeline, not a second one
    const view = lifelines('View')[0];
    expect(d.messages.filter((m) => m.methodName === 'isMobile').map((m) => m.to)).toEqual([view.id, view.id]);
    expect(d.messages.filter((m) => m.kind === 'create' && m.to === view.id)).toHaveLength(2);
    // a and b count separately
    expect(lifelines('Counter')).toHaveLength(2);
    expect(lifelines('Counter').every((p) => p.instances === undefined)).toBe(true);
  });

  it('FR-5.10 one hook line for many components: `{ view } = useLive()` is the field of the object useMemo keeps; one lifeline per class, also for a collapsed call', async () => {
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await session.openMethodByKey('src/live.tsx#<module>.Board');
    const d = (await session.expandEverything())!;
    const lifelines = (cls: string) => d.participants.filter((p) => p.className === cls);
    for (const cls of ['CartViewHandler', 'CartView', 'CartHandler']) {
      expect(lifelines(cls), cls).toHaveLength(1);
      expect(lifelines(cls)[0].instances, cls).toBe(2);
    }
    expect(d.messages.find((m) => m.methodName === 'read')!.to).toBe(lifelines('CartView')[0].id);
    expect(d.messages.find((m) => m.methodName === 'toggle')!.to).toBe(lifelines('CartHandler')[0].id);
    // Popup's hook call collapsed: its `h` is still the handler any call of useLive gives
    const popup = d.messages.find((m) => m.methodName === 'Popup')!;
    const hook = d.messages.find((m) => m.parentId === popup.id && m.methodName === 'useLive')!;
    const collapsed = (await session.collapse(hook.id))!;
    expect(collapsed.messages.find((m) => m.methodName === 'toggle')!.to).toBe(collapsed.participants.find((p) => p.className === 'CartHandler')!.id);
  });

  it('FR-5.10 a hook given the value by its caller (`useLiveFor(store)`): each call its own objects', async () => {
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await session.openMethodByKey('src/live.tsx#<module>.Twice');
    const d = (await session.expandEverything())!;
    expect(d.participants.filter((p) => p.className === 'CartViewHandler')).toHaveLength(2);
    expect(d.participants.every((p) => p.instances === undefined)).toBe(true);
  });

  it('FR-5.10 object destructuring targets', () => {
    expect(objectTargets('{view}')).toEqual([{ field: 'view', name: 'view' }]);
    expect(objectTargets('{view, handler: h}')).toEqual([{ field: 'view', name: 'view' }, { field: 'handler', name: 'h' }]);
    for (const t of ['view', '[a, b]', '{a: {b}}', '{...rest}', '{a = 1}', '{}']) expect(objectTargets(t), t).toBeUndefined();
  });
});
