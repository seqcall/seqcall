import { describe, expect, it } from 'vitest';
import type { ClassRef, MethodRef } from '@seqcall/protocol';
import type { CallSite, ClassInfo, LanguageAdapter, ModuleFacts } from '../src/adapter';
import type { Classification, Classifier } from '../src/classifier';
import { AnalysisCache } from '../src/session/cache';

// The analysis cache between the synchronous build and the asynchronous adapter, on a fake adapter that counts what
// it is asked: adapters without the optional queries, results arriving after a refresh, requests asked twice at once.
const ref = (name: string): ClassRef => ({ key: `src/${name}.ts#${name}`, name, kind: 'class' });
const method = (owner: ClassRef, name: string): MethodRef => ({ key: `${owner.key}.${name}`, name, owner, isStatic: false, hasBody: true }) as MethodRef;
const SHOP = ref('Shop');
const RUN = method(SHOP, 'run');

function fakeAdapter(extra: Partial<LanguageAdapter> = {}) {
  const asked: string[] = [];
  const adapter = {
    findEnclosingCallable: async () => undefined,
    getMethod: async () => undefined,
    getOutgoingCalls: async (m: MethodRef) => (asked.push(`calls ${m.name}`), [] as CallSite[]),
    getImplementations: async () => [],
    getCallers: async () => [],
    getClassInfo: async (k: string) => (asked.push(`info ${k}`), { ref: SHOP, fields: [], constructorParams: [], implements: [], methods: [] } as unknown as ClassInfo),
    ...extra,
  } as LanguageAdapter;
  return { adapter, asked };
}
/** A classifier that finds no layer (the file's facts then decide, FR-7.13). */
const noLayer: Classifier = {
  classify: (): Classification => ({ namespace: '', stereotypes: [], layerReason: { rule: 'none', text: 'no rule', strength: 'weak', notApplied: ['folder `x/`'] } }),
  layerOrder: () => [],
  reloadConfig: () => undefined,
};

describe('the analysis cache', () => {
  it('FR-1.15 / FR-5.8 / FR-6.5 / FR-12.12 / FR-7.7 an adapter without the optional queries: none of their data, nothing asked', async () => {
    const { adapter, asked } = fakeAdapter();
    const cache = new AnalysisCache(adapter, noLayer);
    const out = await cache.resolve(() => ({ exits: cache.earlyExits(RUN), returns: cache.returns(RUN), names: cache.parameterNames(RUN), uses: cache.typeUses(RUN) }));
    expect(out).toEqual({ exits: [], returns: undefined, names: [], uses: [] });
    expect(await cache.fetchParameterNames(RUN)).toEqual([]);
    expect(await cache.fetchModuleFacts(SHOP.key)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it('FR-7.7 file facts are asked only for project classes; a file the adapter has no facts for keeps what the classifier said', async () => {
    const facts: string[] = [];
    const { adapter } = fakeAdapter({ getModuleFacts: async (k: string) => (facts.push(k), undefined) });
    const cache = new AnalysisCache(adapter, noLayer);
    expect(await cache.fetchModuleFacts('lib:axios#Axios')).toBeUndefined();
    expect(await cache.fetchModuleFacts('unknown')).toBeUndefined();
    const c = await cache.resolve(() => cache.classify(SHOP, {}));
    expect(facts).toEqual([SHOP.key]);
    expect(c.layer).toBeUndefined();
    expect(c.layerReason).toEqual({ rule: 'none', text: 'no rule', strength: 'weak', notApplied: ['folder `x/`'] });
  });

  it('FR-7.13 facts showing I/O give the layer, keeping what did not apply', async () => {
    const { adapter } = fakeAdapter({ getModuleFacts: async () => ({ libraries: ['axios'], ports: [], dependsOn: [] }) as ModuleFacts });
    const cache = new AnalysisCache(adapter, noLayer);
    const c = await cache.resolve(() => cache.classify(SHOP, {}));
    expect(c).toMatchObject({ layer: 'Infrastructure', layerReason: { rule: 'evidence', text: 'the code: does I/O (uses axios)', strength: 'weak', notApplied: ['folder `x/`'] } });
  });

  it('a request asked twice while running is asked once; a class only looked at for its type uses has no analysed calls', async () => {
    const { adapter, asked } = fakeAdapter({ getTypeUses: async () => [] });
    const cache = new AnalysisCache(adapter, noLayer);
    const [a, b] = await Promise.all([cache.fetchClassInfo(SHOP.key), cache.fetchClassInfo(SHOP.key)]);
    expect(a).toBe(b);
    expect(asked).toEqual([`info ${SHOP.key}`]);
    await cache.resolve(() => cache.typeUses(RUN));
    expect(cache.callsOfClass(SHOP.key)).toEqual({ analysedMethods: 0, calls: [] });
  });

  it("FR-7.4 a class's analysed calls and type uses (layer hints): only its own methods, in the order they were asked; none after a refresh", async () => {
    const CART = ref('Cart');
    const call = (name: string) => ({ methodName: name }) as CallSite;
    const { adapter } = fakeAdapter({
      getOutgoingCalls: async (m: MethodRef) => [call(`${m.owner.name}.${m.name}`)],
      getTypeUses: async (m: MethodRef) => [{ type: ref(`${m.name}Type`) }] as never,
    });
    const cache = new AnalysisCache(adapter, noLayer);
    for (const m of [method(SHOP, 'b'), method(CART, 'x'), method(SHOP, 'a')]) {
      await cache.fetchOutgoing(m);
      await cache.resolve(() => cache.typeUses(m));
    }
    // asked again: keeps its first place
    await cache.fetchOutgoing(method(SHOP, 'b'));
    expect(cache.callsOfClass(SHOP.key)).toEqual({ analysedMethods: 2, calls: [call('Shop.b'), call('Shop.a')] });
    expect(cache.callsOfClass(CART.key)).toEqual({ analysedMethods: 1, calls: [call('Cart.x')] });
    expect(cache.typeUsesOfClass(SHOP.key).map((u) => u.type.name)).toEqual(['bType', 'aType']);
    // a method asked with another owner moves to that class's list, in its first place
    await cache.fetchOutgoing({ ...method(SHOP, 'b'), owner: CART });
    expect(cache.callsOfClass(SHOP.key)).toEqual({ analysedMethods: 1, calls: [call('Shop.a')] });
    expect(cache.callsOfClass(CART.key)).toEqual({ analysedMethods: 2, calls: [call('Shop.b'), call('Cart.x')] });
    cache.clear();
    expect(cache.callsOfClass(SHOP.key)).toEqual({ analysedMethods: 0, calls: [] });
    expect(cache.typeUsesOfClass(SHOP.key)).toEqual([]);
  });

  it('a refresh while a request runs: its result is not kept, and its failure does not drop the new generation\'s request', async () => {
    let release!: (v: CallSite[]) => void;
    const fails: ((e: Error) => void)[] = [];
    let n = 0;
    let infos = 0;
    const { adapter } = fakeAdapter({
      getOutgoingCalls: () => (n++ === 0 ? new Promise<CallSite[]>((r) => (release = r)) : Promise.resolve([])),
      getClassInfo: () => (infos++, new Promise((_, j) => fails.push(j))),
    });
    const cache = new AnalysisCache(adapter, noLayer);
    const old = cache.fetchOutgoing(RUN);
    const oldInfo = cache.fetchClassInfo(SHOP.key);
    cache.clear();
    const fresh = cache.fetchOutgoing(RUN); // a new request (the old one is not shared after the refresh)
    release([{ methodName: 'stale' } as CallSite]);
    expect((await old).map((c) => c.methodName)).toEqual(['stale']);
    expect(await fresh).toEqual([]);
    expect(cache.peekOutgoing(RUN)).toEqual([]);
    // the new generation asks again; the old request fails meanwhile; asking once more shares the running one
    const newInfo = cache.fetchClassInfo(SHOP.key);
    fails[0](new Error('gone'));
    await expect(oldInfo).rejects.toThrow('gone');
    expect(cache.fetchClassInfo(SHOP.key)).toBe(newInfo);
    expect(infos).toBe(2);
    fails[1](new Error('later'));
    await expect(newInfo).rejects.toThrow('later');
  });
});
