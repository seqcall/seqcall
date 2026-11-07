import { describe, expect, it } from 'vitest';
import type { ClassRef } from '@seqcall/protocol';
import type { ModuleFacts } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { cls, fakeSession, meth } from './fake-world';

// FR-7.7 the purity of an Application class, from the module facts an adapter reports: dependency cycles, long
// chains, dependencies the adapter knows nothing about.
const LAYERS = [{ name: 'Application', match: ['src/App/**'] }, { name: 'Domain', match: ['src/Domain/**'] }];
const app = (name: string): ClassRef => cls(`src/App/${name}.cs`, name);
const dom = (name: string): ClassRef => cls(`src/Domain/${name}.cs`, name);
const facts = (dependsOn: ClassRef[]): ModuleFacts => ({ ports: [], libraries: [], dependsOn });
const svc = app('Pricing');
async function hintOf(table: Record<string, ModuleFacts>) {
  const run = meth(svc, 'Run');
  const s = fakeSession({ methods: [run], adapter: { getModuleFacts: async (k: string) => table[k] } }, { classifier: new DefaultClassifier('/p', { layers: LAYERS } as never) });
  const d = (await s.openMethodByKey(run.key))!;
  return d.participants.find((p) => p.classKey === svc.key)!.layerHint;
}
const pure = (deps: string) => ({ suggested: 'Domain', reasons: ['pure (whole file): takes no ports, no I/O', deps] });

describe('FR-7.7 purity through the dependencies', () => {
  it('FR-7.7 a cycle of Application classes counts as pure', async () => {
    const rates = app('Rates');
    expect(await hintOf({ [svc.key]: facts([rates]), [rates.key]: facts([svc]) })).toEqual(pure('depends only on Domain or pure code: Rates'));
  });

  it('FR-7.7 library types and the class itself are no dependencies; many Domain ones are listed with a count', async () => {
    const lib = { key: 'lib:System#Math', name: 'Math', kind: 'external' as const };
    const domain = ['Order', 'Line', 'Price', 'Tax', 'Discount', 'Currency'].map(dom);
    expect(await hintOf({ [svc.key]: facts([lib, svc, ...domain]) })).toEqual(pure('depends only on Domain or pure code: Order, Line, Price, Tax (+2)'));
  });

  it('FR-7.7 a chain of Application classes deeper than four, or a dependency the adapter knows nothing about: no hint', async () => {
    const chain = [1, 2, 3, 4, 5, 6].map((i) => app(`Step${i}`));
    const table: Record<string, ModuleFacts> = { [svc.key]: facts([chain[0]]) };
    chain.forEach((c, i) => (table[c.key] = facts(i + 1 < chain.length ? [chain[i + 1]] : [])));
    expect(await hintOf(table)).toBeUndefined();
    expect(await hintOf({ [svc.key]: facts([app('Unknown')]) })).toBeUndefined();
  });
});
