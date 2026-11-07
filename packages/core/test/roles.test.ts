import { describe, expect, it } from 'vitest';
import type { ClassRef } from '@seqcall/protocol';
import type { ClassInfo, ModuleFacts } from '../src/adapter';
import { applyRoles, portsAndAdapters, projectBases } from '../src/roles';

const ref = (name: string, kind: ClassRef['kind'] = 'class'): ClassRef => ({ key: `src/${name}.cs#${name}`, name, kind });
const info = (r: ClassRef, implementsTypes: ClassRef[] = [], base?: ClassRef, holds: ClassRef[] = []): ClassInfo =>
  ({ ref: r, implements: implementsTypes, ...(base ? { extends: base } : {}), methods: [], fields: [], constructorParams: holds.map((t, i) => ({ name: `p${i}`, type: t })) }) as unknown as ClassInfo;

function judge(classes: ClassInfo[], libraries: Record<string, string[]>, candidates = classes.map((c) => c.ref.key)) {
  const byKey = new Map(classes.map((c) => [c.ref.key, c]));
  return portsAndAdapters({
    candidates,
    classInfo: (k) => byKey.get(k),
    moduleFacts: (k) => (libraries[k] ? ({ libraries: libraries[k], ports: [], dependsOn: [] } as ModuleFacts) : undefined),
  });
}

describe('FR-7.10 «adapter» / «port» from evidence', () => {
  const port = ref('IShippingApi', 'interface');
  const base = ref('BaseHttpClient', 'abstract');
  const maps = ref('ParcelApiClient');

  it('FR-7.10 an implementation of a project interface that does I/O is an adapter, the interface a port', () => {
    const roles = judge([info(maps, [port])], { [maps.key]: ['System.Net.Http.HttpClient'] });
    expect(roles.get(maps.key)).toEqual([{ stereotype: 'adapter', text: 'implements `IShippingApi` and does HTTP itself' }]);
    expect(roles.get(port.key)).toEqual([{ stereotype: 'port', text: 'an adapter implements it: ParcelApiClient (HTTP)' }]);
  });

  it('FR-7.10 I/O inherited from a project base class counts; that base (doing I/O) is no port', () => {
    // the C# reference solution: ParcelApiClient : BaseHttpClient, IShippingApi — the HttpClient is in BaseHttpClient
    const roles = judge([info(maps, [port], base), info(base)], { [maps.key]: ['Polly.Registry.ResiliencePipelineProvider`1'], [base.key]: ['System.Net.Http.HttpClient'] }, [maps.key]);
    expect(roles.get(maps.key)?.[0].text).toBe('implements `IShippingApi` and does HTTP through its base `BaseHttpClient`');
    expect(roles.has(port.key)).toBe(true);
    expect(roles.has(base.key)).toBe(false);
  });

  it('FR-7.10 no I/O (a policy, a pure service behind its contract) or no interface (a client used directly): no adapter', () => {
    const policy = ref('PricingPolicy');
    const client = ref('RequestClient');
    const roles = judge([info(policy, [ref('IPricingPolicy', 'interface')]), info(client)], { [client.key]: ['GuzzleHttp\\Client'] });
    expect(roles.size).toBe(0);
  });

  it('FR-7.10 an implementation that delegates its I/O to a concrete client it holds is an adapter (repositories of a hexagonal TS backend)', () => {
    const repoPort = ref('ProductRepositoryPort', 'interface');
    const repo = ref('ApiProductsRepository');
    const client = ref('ShopApiClient');
    const roles = judge([info(repo, [repoPort], undefined, [client]), info(client)], { [client.key]: ['fetch'] }, [repo.key]);
    expect(roles.get(repo.key)).toEqual([{ stereotype: 'adapter', text: 'implements `ProductRepositoryPort` and does HTTP through `ShopApiClient`' }]);
    expect(roles.get(repoPort.key)).toEqual([{ stereotype: 'port', text: 'an adapter implements it: ApiProductsRepository (HTTP)' }]);
    // the client implements no project interface: no adapter itself
    expect(roles.has(client.key)).toBe(false);
  });

  it('FR-7.10 delegation is followed two levels (a caching wrapper → the client → its base doing I/O), not three', () => {
    const cache = ref('CachingProviderClient');
    const real = ref('ProviderHttpClient');
    const deeper = ref('Transport');
    const roles = judge([info(cache, [port], undefined, [real]), info(real, [], base), info(base)], { [base.key]: ['System.Net.Http.HttpClient'] }, [cache.key]);
    expect(roles.get(cache.key)?.[0].text).toBe('implements `IShippingApi` and does HTTP through `ProviderHttpClient`');
    const far = judge([info(cache, [port], undefined, [real]), info(real, [], undefined, [deeper]), info(deeper, [], undefined, [maps]), info(maps)], { [maps.key]: ['System.Net.Http.HttpClient'] }, [cache.key]);
    expect(far.has(cache.key)).toBe(false);
    const two = judge([info(cache, [port], undefined, [real]), info(real, [], undefined, [deeper]), info(deeper)], { [deeper.key]: ['System.Net.Http.HttpClient'] }, [cache.key]);
    expect(two.get(cache.key)?.[0].text).toBe('implements `IShippingApi` and does HTTP through `ProviderHttpClient` → `Transport`');
  });

  it('FR-7.10 a held port is no delegate: a service reaching I/O through an interface stays no adapter', () => {
    const service = ref('CouponService');
    const store = ref('ICouponStore', 'interface');
    const roles = judge([info(service, [ref('ICouponService', 'interface')], undefined, [store])], { [store.key]: ['Npgsql'] }, [service.key]);
    expect(roles.size).toBe(0);
  });

  it('FR-7.10 a library interface is no port; evidence replaces a weaker name / folder reason', () => {
    const roles = judge([info(maps, [{ key: 'lib:System#IDisposable', name: 'IDisposable', kind: 'interface' }])], { [maps.key]: ['System.Net.Http.HttpClient'] });
    expect(roles.size).toBe(0);
    const box = { stereotypes: ['adapter'], stereotypeReasons: [{ stereotype: 'adapter', text: 'folder `adapters/` (only the folder name decided)', weak: true }] };
    applyRoles(box, [{ stereotype: 'adapter', text: 'implements `X` and does DB itself' }, { stereotype: 'port', text: 'p' }]);
    expect(box).toEqual({ stereotypes: ['adapter', 'port'], stereotypeReasons: [{ stereotype: 'adapter', text: 'implements `X` and does DB itself' }, { stereotype: 'port', text: 'p' }] });
    // a class without evidence: the box stays as it is
    const plain = { stereotypes: ['service'] };
    applyRoles(plain, undefined);
    expect(plain).toStrictEqual({ stereotypes: ['service'] });
  });

  it('FR-7.10 an abstract base without I/O is the port; more than three adapters are counted, not named', () => {
    const repoBase = ref('BaseRepository', 'abstract');
    const names = ['SqlOrders', 'SqlUsers', 'SqlShops', 'SqlCarts'];
    const repos = names.map((n) => info(ref(n), [], repoBase));
    const roles = judge(repos, Object.fromEntries(names.map((n) => [ref(n).key, ['Npgsql']])));
    expect(roles.get(ref('SqlOrders').key)).toEqual([{ stereotype: 'adapter', text: 'implements `BaseRepository` and does DB itself' }]);
    expect(roles.get(repoBase.key)).toEqual([{ stereotype: 'port', text: 'an adapter implements it: SqlOrders (DB), SqlUsers (DB), SqlShops (DB), +1' }]);
  });

  it('FR-7.10 the walk up the base classes stops at a library base and at a cycle (broken code); bases without facts do no I/O', () => {
    const a = ref('OrderClient');
    const b = ref('MiddleClient');
    const c = ref('LoopClient');
    const lib = { key: 'lib:System#HttpMessageInvoker', name: 'HttpMessageInvoker', kind: 'class' } as ClassRef;
    // OrderClient : MiddleClient : LoopClient : MiddleClient (a cycle) — none has I/O in its file
    expect(judge([info(a, [port], b), info(b, [], c), info(c, [], b)], {}, [a.key]).size).toBe(0);
    const chain = new Map([info(a, [port], b), info(b, [], c), info(c, [], b)].map((i) => [i.ref.key, i]));
    expect(projectBases((k) => chain.get(k), a.key).map((x) => x.name)).toEqual(['MiddleClient', 'LoopClient']);
    // the library base of MiddleClient is not followed: its HTTP does not count
    expect(judge([info(a, [port], b), info(b, [], lib)], { [lib.key]: ['System.Net.Http.HttpClient'] }, [a.key]).size).toBe(0);
    // the same chain with I/O in LoopClient: found through the bases before the cycle closes
    expect(judge([info(a, [port], b), info(b, [], c), info(c, [], b)], { [c.key]: ['System.Net.Http.HttpClient'] }, [a.key]).get(a.key)?.[0].text).toBe(
      'implements `IShippingApi` and does HTTP through its base `LoopClient`',
    );
  });

  it('FR-7.10 delegation: a class held twice or held back is looked at once; a held class without information is a dead end', () => {
    const cache = ref('CachingProviderClient');
    const real = ref('ProviderHttpClient');
    const unknown = ref('GeneratedClient');
    // the cache holds a class the adapter knows nothing about and the client; the client holds the cache back (a cycle)
    const roles = judge([info(cache, [port], undefined, [unknown, real]), info(real, [], undefined, [cache])], {}, [cache.key]);
    expect(roles.size).toBe(0);
    // with I/O in the client: found on the first level
    expect(judge([info(cache, [port], undefined, [real, real]), info(real, [], undefined, [cache])], { [real.key]: ['fetch'] }, [cache.key]).get(cache.key)?.[0].text).toBe(
      'implements `IShippingApi` and does HTTP through `ProviderHttpClient`',
    );
  });

  it('FR-7.10 only concrete classes are judged; a candidate the adapter does not know is skipped', () => {
    // the interface extends a project interface and its file does I/O: still no adapter (it is no class)
    const roles = judge([info(port, [ref('IClient', 'interface')]), info(maps, [port])], { [maps.key]: ['System.Net.Http.HttpClient'], [port.key]: ['System.Net.Http.HttpClient'] }, [port.key, 'src/Gone.cs#Gone', maps.key]);
    expect([...roles.keys()]).toEqual([maps.key, port.key]);
  });
});

