import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-31 unreachable code of a real TS project: the adapter's method list, module-level code, closures, value uses.
const APP = {
  'src/main.ts': `import { openShop } from './shop';
function boot() { openShop(); }
boot();
`,
  'src/shop.ts': `import { shopModule } from './shop-module';
import { Order } from './order';
export function mount(m: unknown) { return m; }
export function formatInvoice(total: number) { return String(total); }
const settings = { formatters: { invoice: formatInvoice } };
export function openShop() {
  mount(shopModule);
  new Order();
  return settings;
}
`,
  'src/shop-module.ts': `export function logOrder() { return 1; }
export function withAudit(routes: () => void) {
  return async (use: (f: () => number) => void) => { use(logOrder); routes(); };
}
function shopRoutes() { return 2; }
export const shopModule = withAudit(shopRoutes);
`,
  'src/order.ts': `export class Order {
  total = 0;
  toString() { return String(this.total); }
  onlyTested() { return this.total; }
}
export function unused() { return helper(); }
function helper() { return 3; }
`,
  'src/order.test.ts': `import { Order } from './order';
export function check() { return new Order().onlyTested(); }
`,
};

describe('FR-31.1 unreachable code in a TS project', () => {
  const { adapter, method, session } = tsProject(APP, undefined, true);

  it('FR-31.1 the project methods: classes and module functions of the own files (test files too)', async () => {
    const keys = (await adapter.getProjectTypes()).flatMap((t) => t.methods.map((m) => m.key));
    expect(keys).toEqual(expect.arrayContaining(['src/order.ts#Order.toString', 'src/order.ts#<module>.unused', 'src/order.test.ts#<module>.check']));
  });

  it('FR-31.1 module-level calls of the own files, not of test files', async () => {
    expect((await adapter.getModuleCalls()).map((c) => c.expressionText).sort()).toEqual(['boot()', 'withAudit(shopRoutes)']);
  });

  it('FR-31.1 the scan lists what no entry point reaches; closures, module-level code and value uses keep the rest', async () => {
    const r = (await session().findUnreachableCode())!;
    expect(r.methods.map((u) => `${u.method.name} ${u.reason}${u.framework ? ` [${u.framework}]` : ''}`)).toEqual([
      'toString no-callers [the runtime calls toString]',
      'onlyTested tests-only',
      'unused no-callers',
      'helper unreached-callers',
    ]);
    // logOrder: called in the closure withAudit returns; formatInvoice: kept in an object
    expect(r.missedMethods.map((m) => m.name).sort()).toEqual(['formatInvoice', 'logOrder']);
    expect([r.entryPoints, r.truncated]).toEqual([1, false]);
  });

  it('FR-31.1 value uses: kept in an object, not calls, not imports / exports; none for a method that is gone', async () => {
    const uses = async (key: string) => adapter.getValueUses(await method(key));
    expect([await uses('src/shop.ts#<module>.formatInvoice'), await uses('src/shop.ts#<module>.mount'), await uses('src/order.ts#<module>.unused')]).toEqual([1, 0, 0]);
    expect(await adapter.getValueUses({ ...(await method('src/order.ts#<module>.unused')), key: 'src/order.ts#<module>.gone' })).toBe(0);
  });
});

describe('FR-31.1 value uses (TS)', () => {
  it('FR-31.1 a shorthand property and an assigned method are uses; an export under another name, a type query, an override and the interface member are not', async () => {
    const { adapter, method } = tsProject({
      'src/a.ts': `export function fmt() { return 1; }
export function typed() { return 2; }
export { typed as t2 };
type T = typeof typed;
export const table = { fmt };
export interface Port { save(): void }
export class Base implements Port {
  save() {}
  handler = this.save;
}
export class Child extends Base { save() {} }
`,
    });
    const uses = async (key: string) => adapter.getValueUses(await method(key));
    expect([await uses('src/a.ts#<module>.fmt'), await uses('src/a.ts#<module>.typed'), await uses('src/a.ts#Base.save')]).toEqual([1, 0, 1]);
  });

  it('FR-31.1 a syntax error that breaks the reference search (a string as a parameter name): no value uses', async () => {
    const { adapter, method } = tsProject({
      'src/a.ts': 'export interface Store { save(n: number): void }\nexport class Db implements Store { save(n: number) {} }\nexport const keep = (s: Store) => ({ f: s.save });\n',
      'src/ui.ts': `import { Store } from './a';
export class Ui {
  constructor(private s: Store) {}
  onSave("save") { this.s.save(1); }
}
`,
    });
    expect(await adapter.getValueUses(await method('src/a.ts#Store.save'))).toBe(0);
  });
});
