import { describe, expect, it } from 'vitest';
import type { ClassDiagram, MethodRef } from '@seqcall/protocol';
import type { ClassInfo, LanguageAdapter } from '../src/adapter';
import { deriveClassDiagram } from '../src/class-diagram';
import { C, file, method, newSession, positionOf, sharedAdapter } from './helpers';

const K12 = {
  ship: 'src/services/shipping-service.ts#ShippingService.ship',
  canShip: 'src/domain/shipping-policy.ts#ShippingPolicy.canShip',
  label: 'src/domain/shipping-policy.ts#ShippingPolicy.label',
};
const T = {
  ShippingService: 'src/services/shipping-service.ts#ShippingService',
  ShippingPolicy: 'src/domain/shipping-policy.ts#ShippingPolicy',
  Tier: 'src/infrastructure/shipping-config.ts#Tier',
  Parcel: 'src/infrastructure/shipping-config.ts#Parcel',
  config: 'src/infrastructure/shipping-config.ts#<module>',
};
const adapter = sharedAdapter();
const uses = async (key: string) => (await adapter.getTypeUses!(await method(key))).map((u) => u.type.key);
const rels = (cd: ClassDiagram) => cd.relations.map((r) => `${r.kind}:${short(r.from)}->${short(r.to)}${r.violation ? ' ⚠' : ''}`).sort();
const short = (key: string) => key.slice(key.indexOf('#') + 1);

/** Counts getTypeUses requests (the option must not cost anything while off). */
function countingAdapter(): { adapter: LanguageAdapter; requests: string[] } {
  const requests: string[] = [];
  const inner = sharedAdapter();
  const counting: LanguageAdapter = Object.create(inner);
  counting.getTypeUses = (m: MethodRef) => {
    requests.push(m.key);
    return inner.getTypeUses!(m);
  };
  return { adapter: counting, requests };
}

describe('TsAdapter.getTypeUses (FR-12.12)', () => {
  it('FR-12.12 signature and body: parameter types, generic arguments, enum constants, module consts; first reference each', async () => {
    const m = await method(K12.canShip);
    const result = await adapter.getTypeUses!(m);
    expect(result.map((u) => u.type.key)).toEqual([C.User, T.Parcel, T.Tier, T.config]);
    const tier = result.find((u) => u.type.key === T.Tier)!;
    expect(tier.type).toMatchObject({ name: 'Tier', kind: 'class' });
    // first reference: `Tier.Blocked` in the body (the local has no annotation)
    expect(tier.range.start).toEqual(positionOf('src/domain/shipping-policy.ts', 'Tier.Blocked :'));
    expect(tier.range.file).toBe(file('src/domain/shipping-policy.ts'));
    expect(result.find((u) => u.type.key === T.Parcel)!.type.kind).toBe('interface');
    expect(result.find((u) => u.type.key === T.config)!.type.kind).toBe('module');
  });

  it('FR-12.12 static calls count as uses of the class; the own class, libraries, locals and parameters do not', async () => {
    expect(await uses(K12.ship)).toEqual([C.User, T.ShippingPolicy]);
    expect(await uses(K12.label)).toEqual([]); // string, toUpperCase: library only
  });
});

describe('Class diagram with type uses (FR-12.12)', () => {
  const open = async (deps = {}) => {
    const s = newSession(deps);
    await s.openMethod(await method(K12.ship));
    await s.expandAll();
    return s;
  };

  it('FR-12.12 option off (default): no use relations, no extra classes, no getTypeUses requests', async () => {
    const { adapter: counting, requests } = countingAdapter();
    const s = await open({ adapter: counting });
    const cd = (await s.getClassDiagram())!;
    expect(cd.typeUses).toBeUndefined();
    expect(cd.classes.map((c) => c.name)).toEqual(['ShippingService', 'ShippingPolicy']);
    expect(rels(cd)).toEqual(['dependency:ShippingService->ShippingPolicy']);
    expect(requests).toEqual([]);
    expect(s.getPersistentState().options.showTypeUses).toBe(false);
  });

  it('FR-12.12 use relations from the shown methods, used-only classes, violations, dedupe against calls', async () => {
    const { adapter: counting, requests } = countingAdapter();
    const s = await open({ adapter: counting });
    const seq = await s.setOption('showTypeUses', true);
    // the sequence diagram keeps its objects; issues never count type uses: the same in both diagrams
    expect(seq!.participants.map((p) => p.className)).toEqual(['ShippingService', 'ShippingPolicy']);
    // root + effective targets of the visible messages, once each — the class diagram asks for nothing more
    expect([...requests].sort()).toEqual([K12.canShip, K12.label, K12.ship].sort());
    const cd = (await s.getClassDiagram())!;
    expect(cd.typeUses).toBe(true);
    expect(requests.sort()).toEqual([K12.canShip, K12.label, K12.ship].sort());
    expect(seq!.findings?.filter((f) => f.kind === 'layer-violation').map((f) => f.id)).toEqual(cd.findings?.filter((f) => f.kind === 'layer-violation').map((f) => f.id));
    expect(cd.findings?.some((f) => f.kind === 'layer-violation')).toBeFalsy();
    // the three red use relations below are drawn and counted apart
    expect(cd.typeUseViolations).toBe(3);
    expect(rels(cd)).toEqual([
      'dependency:ShippingService->ShippingPolicy', // the call; no extra use (dedupe)
      'use:ShippingPolicy-><module> ⚠',
      'use:ShippingPolicy->Parcel ⚠',
      'use:ShippingPolicy->Tier ⚠',
      'use:ShippingPolicy->User',
      'use:ShippingService->User',
    ]);
    const tier = cd.classes.find((c) => c.key === T.Tier)!;
    expect(tier).toMatchObject({ name: 'Tier', usedOnly: true, layer: 'Infrastructure', methods: [] });
    expect(cd.classes.find((c) => c.key === C.User)).toMatchObject({ usedOnly: true, layer: 'Domain' });
    expect(cd.classes.find((c) => c.key === T.ShippingPolicy)!.usedOnly).toBeUndefined();
    expect(cd.layers).toEqual(['Application', 'Domain', 'Infrastructure']);
    const use = cd.relations.find((r) => r.kind === 'use' && r.to === T.Tier)!;
    expect(use.violation).toBe('Domain → Infrastructure: an inner layer depends on an outer layer');
    expect(use.uses).toEqual([
      { method: 'ShippingPolicy.canShip', range: expect.objectContaining({ file: file('src/domain/shipping-policy.ts'), start: positionOf('src/domain/shipping-policy.ts', 'Tier.Blocked :') }), messageId: 'root/0:canShip' },
    ]);
    expect(cd.relations.find((r) => r.kind === 'use' && r.from === T.ShippingService)!.uses![0].messageId).toBe('root');
    expect(s.getPersistentState().options.showTypeUses).toBe(true);

    // cached: a second class diagram asks nothing; off again = exactly the diagram without uses
    const before = requests.length;
    await s.getClassDiagram();
    expect(requests.length).toBe(before);
    await s.setOption('showTypeUses', false);
    const off = (await s.getClassDiagram())!;
    expect(rels(off)).toEqual(['dependency:ShippingService->ShippingPolicy']);
    expect(off.classes.some((c) => c.usedOnly)).toBe(false);
    expect(off.typeUseViolations).toBeUndefined();
  });

  it('FR-12.12 hidden classes are not added as used-only classes; collapsed methods contribute nothing', async () => {
    const s = await open();
    await s.setOption('showTypeUses', true);
    await s.hide({ kind: 'class', classKey: T.Tier, className: 'Tier' });
    let cd = (await s.getClassDiagram())!;
    expect(cd.classes.some((c) => c.key === T.Tier)).toBe(false);
    await s.hide({ kind: 'class', classKey: T.ShippingPolicy, className: 'ShippingPolicy' });
    cd = (await s.getClassDiagram())!;
    expect(rels(cd)).toEqual(['use:ShippingService->User']);
  });

  it('FR-7.4 with type uses: a class used by Domain classes that depends on nothing outside Domain gets a Domain hint', async () => {
    // fixture config puts src/infrastructure/** in Infrastructure: re-layer the config file to Application for the rule
    const { createClassifier } = await import('../src/classifier-impl');
    const { FIXTURE_ROOT } = await import('./helpers');
    const base = createClassifier(FIXTURE_ROOT);
    const classifier = Object.create(base) as typeof base;
    classifier.classify = (ref, info, usage) => {
      const c = base.classify(ref, info, usage);
      return ref.key.startsWith('src/infrastructure/shipping-config.ts#') ? { ...c, layer: 'Application' } : c;
    };
    const s = await open({ classifier });
    await s.setOption('showTypeUses', true);
    const cd = (await s.getClassDiagram())!;
    const tier = cd.classes.find((c) => c.key === T.Tier)!;
    expect(tier.layer).toBe('Application');
    // FR-7.7: judged by its whole file (shipping-config.ts: no ports, no I/O, no project dependencies)
    expect(tier.layerHint).toEqual({ suggested: 'Domain', reasons: ['used by Domain: ShippingPolicy', 'pure (whole file): takes no ports, no I/O', 'no project dependencies'] });
    expect(cd.relations.find((r) => r.to === T.Tier)!.violation).toBe('Domain → Application: an inner layer depends on an outer layer');
  });
});

describe('deriveClassDiagram with type uses (FR-12.12, synthetic input)', () => {
  const ref = (key: string) => ({ key, name: key.slice(key.indexOf('#') + 1), kind: 'class' as const });
  const info = (key: string, over: Partial<ClassInfo> = {}): ClassInfo => ({
    ref: ref(key), decorators: [], implements: [], fields: [], constructorParams: [], hasPrivateConstructor: false,
    hasStaticInstance: false, allMembersStatic: false, isExportedInstance: false, methods: [], ...over,
  });
  const range = { file: '/p/a.cs', start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  const p = (key: string, layer: string) => ({ id: `${key}|c`, classKey: key, className: ref(key).name, label: '', kind: 'class' as const, stereotypes: [], layer, namespace: '', groupId: 'g' });
  const infos: Record<string, ClassInfo> = { 'a.cs#Repo': info('a.cs#Repo', { extends: ref('b.cs#BaseRepo') }) };

  it('FR-12.12 an inherited method is listed under (and uses from) the subclass; its base type becomes a generalization, not a use', () => {
    const inherited = { key: 'b.cs#BaseRepo.Run()', name: 'Run', owner: ref('b.cs#BaseRepo'), isStatic: false, hasBody: true };
    const cd = deriveClassDiagram({
      participants: [p('a.cs#Repo', 'Infrastructure')],
      messages: [],
      participantMeta: new Map(),
      classInfo: (k) => infos[k],
      classifyRef: () => ({ layer: 'Infrastructure', namespace: 'n', stereotypes: [] }),
      typeUses: [{ method: inherited, classKey: 'a.cs#Repo', messageId: 'root/0:Run', uses: [{ type: ref('b.cs#BaseRepo'), range }, { type: ref('c.cs#Settings'), range }] }],
    });
    expect(cd.relations.map((r) => `${r.kind}:${r.from}->${r.to}`)).toEqual(['generalization:a.cs#Repo->b.cs#BaseRepo', 'use:a.cs#Repo->c.cs#Settings']);
    expect(cd.relations[1].uses).toEqual([{ method: 'BaseRepo.Run', range, messageId: 'root/0:Run' }]);
    expect(cd.classes.map((c) => [c.name, !!c.usedOnly])).toEqual([['Repo', false], ['BaseRepo', true], ['Settings', true]]);
  });

  it('FR-12.12 methods of classes that are not in the diagram contribute nothing', () => {
    const m = { key: 'x.cs#X.M()', name: 'M', owner: ref('x.cs#X'), isStatic: false, hasBody: true };
    const cd = deriveClassDiagram({ participants: [p('a.cs#Repo', 'Infrastructure')], messages: [], participantMeta: new Map(), classInfo: (k) => infos[k], typeUses: [{ method: m, uses: [{ type: ref('c.cs#Settings'), range }] }] });
    expect(cd.relations).toEqual([]);
    expect(cd.typeUses).toBe(true);
  });
});
