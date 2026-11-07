import { describe, expect, it } from 'vitest';
import type { ClassRef } from '@seqcall/protocol';
import type { CallSite, ClassInfo } from '../src/adapter';
import { suggestLayer, type LayerHintInput } from '../src/layer-hints';

const ref = (key: string, kind: ClassRef['kind'] = 'class'): ClassRef => ({ key, name: key.split('#')[1], kind });
const LAYERS: Record<string, string> = { Coupon: 'Domain', IOrderRule: 'Domain', ICouponStore: 'Application', CouponDto: 'Presentation' };
const info = (r: ClassRef, over: Partial<ClassInfo> = {}): ClassInfo => ({
  ref: r, decorators: [], implements: [], fields: [], constructorParams: [], hasPrivateConstructor: false,
  hasStaticInstance: false, allMembersStatic: false, isExportedInstance: false, methods: [], ...over,
});
const call = (over: Partial<CallSite>): CallSite => ({
  ordinal: 0, kind: 'call', range: { file: 'f', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  methodName: 'm', expressionText: 'm()', args: [], receiver: { kind: 'expression', text: 'x' }, isAsync: false, isLibrary: false, ...over,
});
function input(r: ClassRef, layer: string | undefined, over: Partial<LayerHintInput> = {}): LayerHintInput {
  return {
    ref: r, layer, calls: [], analysedMethods: 0,
    classify: (t) => ({ layer: LAYERS[t.name], namespace: '', stereotypes: t.kind === 'interface' ? ['interface'] : [] }),
    typeByName: new Map(Object.keys(LAYERS).map((n) => [n, ref(`src/${n}.cs#${n}`, n.startsWith('I') ? 'interface' : 'class')])),
    ...over,
  };
}

describe('layer hints (Option A: cached evidence only)', () => {
  it('FR-7.11 a DTO (by name or folder) is never suggested for Domain, even when pure and used by Domain', () => {
    const pure = { pure: true, reasons: ['pure (whole file): takes no ports, no I/O'] };
    const plain = ref('src/Services/PricingRules.php#PricingRules');
    expect(suggestLayer(input(plain, 'Application', { purity: pure, usedByDomain: ['Coupon'] }))?.suggested).toBe('Domain');
    for (const dto of ['src/Services/CouponDto.php#CouponDto', 'app/DTO/Coupon.php#Coupon', 'app/Http/Requests/StoreOrderRequest.php#StoreOrderRequest', 'src/Api/EnrollmentResponse.php#EnrollmentResponse']) {
      expect(suggestLayer(input(ref(dto), 'Application', { purity: pure, usedByDomain: ['Coupon'] }))).toBeUndefined();
    }
  });

  it('FR-7.11 no Domain hint for what the Feature-Sliced Design preset placed (a page\'s model is page state, however pure); other reasons still hint', () => {
    const pure = { pure: true, reasons: ['pure (whole file): takes no ports, no I/O'] };
    const r = ref('src/pages/products/model/productContext.ts#<module>');
    const reason = (rule: 'preset' | 'role-folder', text: string) => ({
      classify: () => ({ stereotypes: [], layer: 'Application', namespace: '', layerReason: { rule, text, strength: 'strong' as const, notApplied: [] as string[] } }),
    });
    expect(suggestLayer(input(r, 'Application', { purity: pure, ...reason('preset', 'Feature-Sliced Design preset: `src/**/model/**`') }))).toBeUndefined();
    // the Laravel preset or a role folder do not know FSD's segments: the hint stays
    expect(suggestLayer(input(r, 'Application', { purity: pure, ...reason('preset', 'Laravel preset: `app/Jobs/**`') }))?.suggested).toBe('Domain');
    expect(suggestLayer(input(r, 'Application', { purity: pure, ...reason('role-folder', 'role folder `model/`') }))?.suggested).toBe('Domain');
  });

  it('FR-7.11 no Infrastructure hint for an Active Record model; a controller doing I/O gets advice, not a move (⚑ contradicted ⚠)', () => {
    const db = call({ isLibrary: true, libraryName: 'Illuminate', target: { key: 'lib:Illuminate\\Support\\Facades\\DB#DB.transaction', name: 'transaction', owner: { key: 'lib:Illuminate\\Support\\Facades\\DB', name: 'DB', kind: 'external' }, isStatic: true, hasBody: false } });
    const user = ref('app/Models/User.php#User');
    expect(suggestLayer(input(user, 'Domain', { calls: [db] }))?.suggested).toBe('Infrastructure');
    expect(suggestLayer(input(user, 'Domain', { calls: [db], activeRecord: true }))).toBeUndefined();
    const ctl = ref('app/Http/Controllers/TopUpController.php#TopUpController');
    expect(suggestLayer(input(ctl, 'Presentation', { calls: [db] }))).toEqual({
      suggested: 'Infrastructure',
      reasons: ['does I/O: DB.transaction'],
      advice: 'a controller doing I/O: move the call into a service or repository',
      noMove: true,
    });
    const byStereotype = suggestLayer(input(ctl, undefined, { calls: [db], classify: () => ({ stereotypes: ['controller'], namespace: '' }) }));
    expect(byStereotype?.noMove).toBe(true);
  });

  it('FR-7.11 an FSD model / ui doing I/O keeps its Infrastructure hint, with the advice instead of a move', () => {
    const r = ref('src/pages/products/model/products.hooks.ts#<module>');
    const reason = (text: string) => ({ classify: () => ({ stereotypes: [], layer: 'Application', namespace: '', layerReason: { rule: 'preset' as const, text, strength: 'strong' as const, notApplied: [] as string[] } }) });
    const calls = [{ ordinal: 0, kind: 'call' as const, range: { file: '/f', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, methodName: 'useMutation', expressionText: 'api.client.useMutation()', args: [], receiver: { kind: 'none' as const }, target: { key: 'lib:openapi-react-query#OpenapiQueryClient.useMutation', name: 'useMutation', owner: { key: 'lib:openapi-react-query', name: 'openapi-react-query', kind: 'external' as const }, isStatic: false, hasBody: false }, isAsync: false, isLibrary: true, libraryName: 'openapi-react-query' }];
    expect(suggestLayer(input(r, 'Application', { calls, ...reason('Feature-Sliced Design preset: `src/**/model/**`') }))).toEqual({
      suggested: 'Infrastructure',
      reasons: ['does I/O: OpenapiQueryClient.useMutation'],
      advice: 'in FSD, backend calls belong in an `api/` segment',
      noMove: true,
    });
    // a ui segment is Presentation: still FSD's advice, not the controller one
    const ui = { classify: () => ({ stereotypes: [], layer: 'Presentation', namespace: '', layerReason: { rule: 'preset' as const, text: 'Feature-Sliced Design preset: `src/**/ui/**`', strength: 'strong' as const, notApplied: [] as string[] } }) };
    expect(suggestLayer(input(ref('src/pages/products/ui/useProducts.ts#<module>'), 'Presentation', { calls, ...ui }))?.advice).toBe('in FSD, backend calls belong in an `api/` segment');
    // elsewhere the file itself is in the wrong place: plain hint, moving offered
    const plain = suggestLayer(input(r, 'Application', { calls, ...reason('Laravel preset: `app/Jobs/**`') }));
    expect(plain?.suggested).toBe('Infrastructure');
    expect(plain?.noMove).toBeUndefined();
  });

  it('suggests Domain for a stateless utility placed in Application that works with domain types', () => {
    const r = ref('src/Core/Utils/DateUtil.cs#DateUtil');
    const hint = suggestLayer(input(r, 'Application', { info: info(r, { allMembersStatic: true, methods: [{ name: 'GetTimetable', isStatic: true, signature: 'GetTimetable(Coupon coupon): List<(DateTime start, DateTime end)>' }] }) }));
    expect(hint).toEqual({ suggested: 'Domain', reasons: ['no injected dependencies', 'no I/O and no calls to services or ports', 'works with domain types: Coupon'] });
  });

  it('no Domain hint for pure framework helpers or for code that uses non-domain types', () => {
    const r = ref('src/Core/Utils/Format.cs#Format');
    expect(suggestLayer(input(r, 'Application', { info: info(r, { allMembersStatic: true, methods: [{ name: 'Title', isStatic: true, signature: 'Title(string s): string' }] }) }))).toBeUndefined();
    const m = ref('src/Core/Utils/Mapper.cs#Mapper');
    expect(suggestLayer(input(m, 'Application', { info: info(m, { allMembersStatic: true, methods: [{ name: 'Map', isStatic: true, signature: 'Map(CouponDto dto): Coupon' }] }) }))).toBeUndefined();
  });

  it('suggests Infrastructure when I/O is observed (C# and npm libraries)', () => {
    const r = ref('src/Core/Services/Sync.cs#Sync');
    const http = call({ isLibrary: true, libraryName: 'System.Net.Http', target: { key: 'lib:System.Net.Http#System.Net.Http.HttpClient.GetAsync(string)', name: 'GetAsync', owner: ref('lib:System.Net.Http#System.Net.Http.HttpClient', 'external'), isStatic: false, hasBody: false } });
    expect(suggestLayer(input(r, 'Application', { calls: [http], analysedMethods: 1 }))?.suggested).toBe('Infrastructure');
    const t = ref('src/app/sync.ts#<module>', 'module');
    const axios = call({ isLibrary: true, libraryName: 'axios', target: { key: 'lib:axios#AxiosInstance.get', name: 'get', owner: ref('lib:axios#AxiosInstance', 'external'), isStatic: false, hasBody: false } });
    expect(suggestLayer(input(t, 'Application', { calls: [axios], analysedMethods: 1 }))).toEqual({ suggested: 'Infrastructure', reasons: ['does I/O: AxiosInstance.get'] });
  });

  it('suggests Application for a Domain class calling a port outside Domain, but not for domain-internal abstractions', () => {
    const r = ref('src/Domain/Coupon.cs#Coupon');
    const port = call({ receiver: { kind: 'field', name: '_dl' }, methodName: 'Save', target: { key: 'src/ICouponStore.cs#ICouponStore.Save()', name: 'Save', owner: ref('src/ICouponStore.cs#ICouponStore', 'interface'), isStatic: false, hasBody: false } });
    expect(suggestLayer(input(r, 'Domain', { calls: [port], analysedMethods: 1 }))).toEqual({ suggested: 'Application', reasons: ['calls ICouponStore.Save'] });
    const strategy = call({ receiver: { kind: 'local', name: 'rule' }, methodName: 'Check', target: { key: 'src/IOrderRule.cs#IOrderRule.Check()', name: 'Check', owner: ref('src/IOrderRule.cs#IOrderRule', 'interface'), isStatic: false, hasBody: false } });
    expect(suggestLayer(input(r, 'Domain', { calls: [strategy], analysedMethods: 1 }))).toBeUndefined();
  });

  it('never hints interfaces, and stays quiet when the layer already matches', () => {
    expect(suggestLayer(input(ref('src/IThing.cs#IThing', 'interface'), 'Application'))).toBeUndefined();
    const r = ref('src/Domain/DateUtil.cs#DateUtil');
    expect(suggestLayer(input(r, 'Domain', { info: info(r, { allMembersStatic: true, methods: [{ name: 'G', isStatic: true, signature: 'G(Coupon c): bool' }] }) }))).toBeUndefined();
  });

  it("FR-7.4 a class's own nested types are no evidence for Domain (C# Enums.ToOrderStatus(ProviderStatus))", () => {
    const r = ref('src/Core/Utils/Enums.cs#Enums');
    const methods = [{ name: 'ToOrderStatus', isStatic: true, signature: 'ToOrderStatus(this ProviderStatus status): OrderStatus' }];
    // before: the unresolved names ProviderStatus / OrderStatus counted as "domain types" → ⚑ Domain (the bug)
    expect(suggestLayer(input(r, 'Application', { info: info(r, { allMembersStatic: true, methods, nestedTypes: ['OrderStatus', 'ProviderStatus'] }) }))).toBeUndefined();
    // nested types known by key (`Enums.ProviderStatus`) are skipped as well, whatever their layer
    const nestedRef = ref('src/Core/Utils/Enums.cs#Enums.ProviderStatus');
    const typeByName = new Map([['ProviderStatus', { ...nestedRef, name: 'ProviderStatus' }], ['OrderStatus', { ...ref('src/Core/Utils/Enums.cs#Enums.OrderStatus'), name: 'OrderStatus' }]]);
    const classify = (t: ClassRef) => ({ layer: t.key.startsWith('src/Core/Utils/Enums.cs#Enums.') ? 'Domain' : LAYERS[t.name], namespace: '', stereotypes: [] });
    expect(suggestLayer(input(r, 'Application', { info: info(r, { allMembersStatic: true, methods }), typeByName, classify }))).toBeUndefined();
  });

  it('FR-7.4 / FR-12.12 used by Domain classes and depending on nothing outside Domain → Domain', () => {
    const r = ref('src/Core/Utils/Enums.cs#Enums');
    const hint = suggestLayer(input(r, 'Application', { info: info(r, { allMembersStatic: true, nestedTypes: ['EnrollmentStatus'] }), usedByDomain: ['StockRule', 'CouponLogic', 'PriceRule', 'TaxRule'] }));
    expect(hint).toEqual({ suggested: 'Domain', reasons: ['used by Domain: StockRule, CouponLogic, PriceRule (+1)', 'no dependencies on Application or outer layers', 'no I/O'] });
    // depends on Domain types itself: still fine
    const dom = ref('src/Domain/Coupon.cs#Coupon');
    expect(suggestLayer(input(r, 'Application', { typeUses: [dom], usedByDomain: ['CouponLogic'] }))?.suggested).toBe('Domain');
  });

  it('FR-7.4 / FR-12.12 no "used by Domain" hint when the class uses Application or outer types, or is already elsewhere', () => {
    const r = ref('src/Core/Utils/Mapper.cs#Mapper');
    const dl = ref('src/ICouponStore.cs#ICouponStore', 'interface');
    const dto = ref('src/CouponDto.cs#CouponDto');
    expect(suggestLayer(input(r, 'Application', { typeUses: [dto], usedByDomain: ['CouponLogic'] }))).toBeUndefined();
    expect(suggestLayer(input(r, 'Application', { info: info(r, { fields: [{ name: '_dl', type: dl, isStatic: false, injected: true }] }), usedByDomain: ['CouponLogic'] }))).toBeUndefined();
    expect(suggestLayer(input(r, 'Infrastructure', { usedByDomain: ['CouponLogic'] }))).toBeUndefined();
    expect(suggestLayer(input(r, 'Application', { usedByDomain: [] }))).toBeUndefined();
  });

  it('FR-7.11 I/O evidence: the receiver type of an inherited library method, a field of an I/O type, global fetch', () => {
    const r = ref('src/Core/Services/Sync.cs#Sync');
    const lib = (key: string, kind: ClassRef['kind'] = 'external') => ({ key, name: key.slice(key.lastIndexOf('#') + 1), kind });
    // `client.Send()` — the method is declared on a base type the patterns do not know; the receiver is the HttpClient
    const inherited = call({ isLibrary: true, libraryName: 'System.Net.Primitives', methodName: 'Send', target: { key: 'lib:System.Net.Primitives#MessageInvoker.Send', name: 'Send', owner: lib('lib:System.Net.Primitives#MessageInvoker'), isStatic: false, hasBody: false }, receiverType: lib('lib:System.Net.Http#HttpClient') });
    expect(suggestLayer(input(r, 'Application', { calls: [inherited] }))).toEqual({ suggested: 'Infrastructure', reasons: ['does I/O: MessageInvoker.Send'] });
    // no target: the receiver type decides and names it
    const untyped = call({ isLibrary: true, methodName: 'GetAsync', receiverType: lib('lib:System.Net.Http#HttpClient') });
    expect(suggestLayer(input(r, 'Application', { calls: [untyped] }))?.reasons).toEqual(['does I/O: HttpClient']);
    // already in Infrastructure, or a UI component (FR-7.13: its I/O is a badge, not a move): no hint
    expect(suggestLayer(input(r, 'Infrastructure', { calls: [untyped] }))).toBeUndefined();
    expect(suggestLayer(input(r, 'Presentation', { calls: [untyped], component: true }))).toBeUndefined();
    // an injected HttpClient field, a field whose type is unknown
    const withField = info(r, { fields: [{ name: '_http', type: lib('lib:System.Net.Http#HttpClient'), isStatic: false, injected: true }, { name: '_x', isStatic: false } as never] });
    expect(suggestLayer(input(r, 'Application', { info: withField }))?.reasons).toEqual(['does I/O: HttpClient']);
    // the global fetch (TS lib), without a resolved target
    const t = ref('src/app/sync.ts#<module>', 'module');
    expect(suggestLayer(input(t, 'Application', { calls: [call({ isLibrary: true, libraryName: 'lib', methodName: 'fetch' })] }))?.reasons).toEqual(['does I/O: fetch']);
    // a library call that is no I/O
    expect(suggestLayer(input(t, 'Application', { calls: [call({ isLibrary: true, libraryName: 'lib', methodName: 'parse' })] }))).toBeUndefined();
  });

  it('FR-7.11 a Domain class taking a port in its constructor depends on it: Application', () => {
    const r = ref('src/Domain/Coupon.cs#Coupon');
    const dl = ref('src/ICouponStore.cs#ICouponStore', 'interface');
    expect(suggestLayer(input(r, 'Domain', { info: info(r, { constructorParams: [{ name: 'dl', type: dl }] }) }))).toEqual({ suggested: 'Application', reasons: ['depends on ICouponStore'] });
  });

  it('FR-7.7 pure technical code (by name or folder) is no domain code by itself; used by Domain it is', () => {
    const pure = { pure: true, reasons: ['pure (whole file)'] };
    expect(suggestLayer(input(ref('src/Core/DateHelper.cs#DateHelper'), 'Application', { purity: pure }))).toBeUndefined();
    expect(suggestLayer(input(ref('src/Core/shared/Dates.cs#Dates'), 'Application', { purity: pure }))).toBeUndefined();
    expect(suggestLayer(input(ref('src/Core/shared/Dates.cs#Dates'), 'Application', { purity: pure, usedByDomain: ['A', 'B', 'C', 'D', 'E'] }))).toEqual({
      suggested: 'Domain',
      reasons: ['used by Domain: A, B, C (+2)', 'pure (whole file)'],
    });
    expect(suggestLayer(input(ref('src/Core/Rules.cs#Rules'), 'Application', { purity: pure }))).toEqual({ suggested: 'Domain', reasons: ['pure (whole file)'] });
    expect(suggestLayer(input(ref('src/Core/Rules.cs#Rules'), 'Application', { purity: { pure: false, reasons: [] } }))).toBeUndefined();
  });

  it('FR-7.4 the types a class works with: called project classes (by target or receiver), not library calls; resolved signature types by layer', () => {
    const r = ref('src/Core/Rules.cs#Rules');
    const promo = ref('src/Coupon.cs#Coupon');
    const dto = ref('src/CouponDto.cs#CouponDto');
    const onDto = call({ methodName: 'Read', receiverType: dto });
    // a call on a Presentation type (through its receiver): foreign
    expect(suggestLayer(input(r, 'Application', { calls: [onDto], analysedMethods: 1, usedByDomain: ['X'] }))).toBeUndefined();
    // calls on a Domain type (by target), a library call: Domain types only
    const onPromo = call({ methodName: 'Apply', target: { key: `${promo.key}.Apply`, name: 'Apply', owner: promo, isStatic: false, hasBody: true } });
    const libCall = call({ isLibrary: true, methodName: 'Trim', target: { key: 'lib:System#String.Trim', name: 'Trim', owner: { key: 'lib:System#String', name: 'String', kind: 'external' }, isStatic: false, hasBody: false } });
    expect(suggestLayer(input(r, 'Application', { calls: [onPromo, libCall], analysedMethods: 1 }))).toEqual({
      suggested: 'Domain',
      reasons: ['no injected dependencies', 'no I/O and no calls to services or ports', 'works with domain types: Coupon'],
    });
    // analysed calls but no class info: only the calls count; a resolved Presentation type in a signature is foreign
    expect(suggestLayer(input(r, 'Application', { calls: [onPromo], analysedMethods: 1, info: undefined }))?.suggested).toBe('Domain');
    const sig = info(r, { methods: [{ name: 'Map', isStatic: false, signature: 'Map(Coupon p): CouponDto' }] });
    expect(suggestLayer(input(r, 'Application', { info: sig, analysedMethods: 1 }))).toBeUndefined();
  });
});

