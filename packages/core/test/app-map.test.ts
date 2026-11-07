import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClassNode, ClassRelation, EntryPoint } from '@seqcall/protocol';
import { buildAppLevel, commonRoot, mergeScans, type EntryPointScan } from '../src/app-map';
import { createClassifier } from '../src/classifier-impl';
import { PhpAdapter } from '../src/php/php-adapter';
import { appMapEntryKey, DiagramSession } from '../src/session';

const ROOT = path.resolve(__dirname, '../../../fixtures/php-app').replace(/\\/g, '/');
const adapter = new PhpAdapter(ROOT);
afterAll(() => adapter.dispose());
const session = () => new DiagramSession({ adapter, classifier: createClassifier(ROOT) });
const LAYERS = ['Presentation', 'Application', 'Domain', 'Infrastructure'];

const cls = (key: string, layer?: string, methods: string[] = ['run']): ClassNode => ({
  key,
  name: key.replace(/^.*#/, ''),
  kind: 'class',
  stereotypes: [],
  ...(layer ? { layer } : {}),
  namespace: '',
  methods: methods.map((m) => ({ name: m, isStatic: false, signature: `${m}()` })),
  declaration: { file: key.replace(/#.*$/, ''), start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
});
const rel = (from: string, to: string, extra: Partial<ClassRelation> = {}): ClassRelation => ({ id: `${from}>${to}`, kind: 'dependency', from, to, calls: [], ...extra });
const ep = (label: string): EntryPoint => ({ kind: 'http', label, method: { key: `x#${label}`, name: label, owner: { key: 'x', name: 'x' } } as EntryPoint['method'] });
const scan = (label: string, classes: ClassNode[], relations: ClassRelation[], extra: Partial<EntryPointScan> = {}): EntryPointScan => ({
  entry: ep(label),
  files: new Set(classes.map((c) => c.key.replace(/#.*$/, ''))),
  classes,
  relations,
  findings: [],
  truncated: false,
  ...extra,
});

describe('codebase map levels (FR-26.3)', () => {
  const ctrl = cls('src/http/controllers/OrderController.ts#OrderController', 'Presentation');
  const svc = cls('src/app/services/OrderService.ts#OrderService', 'Application', ['place']);
  const svc2 = cls('src/app/services/OrderService.ts#OrderService', 'Application', ['cancel']);
  const repo = cls('src/infra/db/repos/OrderRepo.ts#OrderRepo', 'Infrastructure');
  const order = cls('src/domain/Order.ts#Order', 'Domain');
  const main = cls('src/main.ts#Main', 'Presentation');
  const model = mergeScans([
    scan('POST /orders', [ctrl, svc, repo, order], [rel(ctrl.key, svc.key), rel(svc.key, repo.key), rel(svc.key, order.key), rel(order.key, repo.key, { violation: 'Domain must not depend on Infrastructure' })]),
    scan('DELETE /orders', [ctrl, svc2, order], [rel(ctrl.key, svc.key, { calls: [{ messageId: 'x', label: 'cancel', callSite: { file: 'src/http/controllers/OrderController.ts', start: { line: 9, character: 2 }, end: { line: 9, character: 9 } } }] })], { truncated: true }),
    scan('main', [main, ctrl], [rel(main.key, ctrl.key)]),
  ]);

  it('FR-26.1 merges the flows: each class once with the methods of all flows, each relation once', () => {
    expect(model.entryPoints).toBe(3);
    expect(model.truncated).toBe(1);
    expect(model.classes.size).toBe(5);
    expect(model.classes.get(svc.key)!.methods.map((m) => m.name)).toEqual(['cancel', 'place']);
    expect(model.relations.size).toBe(5);
    expect(model.relations.get(`dependency|${ctrl.key}|${svc.key}|`)!.calls).toHaveLength(1);
  });

  it('FR-26.3 the top level: folders as packages listing their classes, a chain of single folders as one package, the folder\'s own classes as classes', () => {
    const top = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't' });
    expect(top.path).toBe('src');
    expect(top.crumbs).toEqual([{ label: 'Codebase', path: 'src' }]);
    const names = top.diagram.classes.map((c) => `${c.group ? 'pkg ' : ''}${c.name}`).sort();
    // infra/db/repos is a chain: one package; main.ts sits in src itself
    expect(names).toEqual(['Main', 'pkg app/services', 'pkg domain', 'pkg http/controllers', 'pkg infra/db/repos']);
    const services = top.diagram.classes.find((c) => c.name === 'app/services')!;
    expect(services.group).toEqual({ path: 'src/app/services', classes: 1 });
    expect(services.methods.map((m) => m.name)).toEqual(['OrderService']);
    expect(services.methods[0].declaration?.file).toBe('src/app/services/OrderService.ts');
    expect(services.layer).toBe('Application');
    expect(top.diagram.layers).toEqual(LAYERS);
  });

  it('FR-26.3 relations between drawn nodes are merged and counted; a violation inside them marks the edge', () => {
    const top = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't' });
    const edge = (a: string, b: string) => top.diagram.relations.find((r) => r.from === `package:${a}` && r.to === `package:${b}`);
    expect(edge('src/domain', 'src/infra/db/repos')).toMatchObject({ count: 1 });
    expect(edge('src/domain', 'src/infra/db/repos')!.label).toBeUndefined(); // a count is drawn from 2 up
    expect(edge('src/domain', 'src/infra/db/repos')!.violation).toMatch(/^1 of 1 relation break the dependency rule: Domain must not/);
    expect(edge('src/app/services', 'src/infra/db/repos')!.violation).toBeUndefined();
    const fromMain = top.diagram.relations.find((r) => r.from === main.key)!;
    expect(fromMain.to).toBe('package:src/http/controllers');
    // the merged relations are listed behind the edge, with where to look
    expect(edge('src/http/controllers', 'src/app/services')!.calls![0]).toMatchObject({ label: 'OrderController → OrderService', callSite: { start: { line: 9 } } });
    expect(top).toMatchObject({ entryPoints: 3, truncated: 1, classes: 5, relations: 5, violations: 1 });
  });

  it('FR-26.7 a package opened in place: its sub-folders and classes are drawn instead of it, named below it, edges re-merged', () => {
    const top = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't', open: ['src/http/controllers', 'src/nope'] });
    expect(top.open).toEqual(['src/http/controllers']);
    const keys = top.diagram.classes.map((c) => c.key);
    expect(keys).not.toContain('package:src/http/controllers');
    const controller = top.diagram.classes.find((c) => c.key === ctrl.key)!;
    expect(controller.inPackage).toBe('src/http/controllers');
    // its relations now start at the class itself
    expect(top.diagram.relations.find((r) => r.from === ctrl.key && r.to === 'package:src/app/services')).toBeTruthy();
    expect(top.diagram.relations.find((r) => r.from === main.key)!.to).toBe(ctrl.key);
    // opening a chain package shows what is inside the chain's end; a package below an open one is named below it
    const infra = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't', open: ['src/app'] });
    expect(infra.open ?? []).toEqual([]); // src/app is not a package of its own here (the chain is app/services)
    const repoModel = mergeScans([scan('x', [cls('src/infra/a/A.ts#A'), cls('src/infra/b/B.ts#B'), cls('src/c/C.ts#C')], [])]);
    const opened = buildAppLevel(repoModel, '', { layerOrder: LAYERS, computedAt: 't', open: ['src/infra'] });
    expect(opened.diagram.classes.filter((c) => c.group).map((c) => [c.name, c.group!.in])).toEqual([
      ['a', 'src/infra'],
      ['b', 'src/infra'],
      ['c', undefined],
    ]);
  });

  it('FR-26.6 every violation of the map is listed at every level, with the folder where it is drawn and the layers (for its card)', () => {
    const top = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't' });
    expect(top.violationList).toEqual([{ from: order.key, to: repo.key, fromName: 'Order', toName: 'OrderRepo', violation: 'Domain must not depend on Infrastructure', folder: 'src', fromLayer: 'Domain', toLayer: 'Infrastructure' }]);
    expect(buildAppLevel(model, 'src/app/services', { layerOrder: LAYERS, computedAt: 't' }).violationList).toHaveLength(1);
  });

  it('FR-26.3 a folder: its classes, and the folders beside it that they are related to (dashed context)', () => {
    const level = buildAppLevel(model, 'src/app/services', { layerOrder: LAYERS, computedAt: 't' });
    expect(level.crumbs.map((c) => c.label)).toEqual(['Codebase', 'app', 'services']);
    const nodes = Object.fromEntries(level.diagram.classes.map((c) => [c.name, c.group]));
    expect(Object.keys(nodes).sort()).toEqual(['OrderService', 'domain', 'http/controllers', 'infra/db/repos']);
    expect(nodes['domain']).toMatchObject({ external: true });
    expect(nodes['OrderService']).toBeUndefined();
    // a single relation between two classes keeps its own kind and calls; Main is not related to the folder: absent
    expect(level.diagram.classes.some((c) => c.name === 'Main' || c.name.includes('own classes'))).toBe(false);
    // between two outside packages: nothing (they are only context)
    expect(level.diagram.relations.every((r) => r.from === svc.key || r.to === svc.key)).toBe(true);
  });

  it('FR-26.3 classes from files outside the project (generated by a build) are left out', () => {
    const outside = cls('../../../home/u/.nuget/packages/sdk/build/AutoGeneratedProgram.cs#AutoGeneratedProgram');
    const level = buildAppLevel(mergeScans([scan('main', [main, ctrl, outside], [rel(outside.key, main.key)])]), '', { layerOrder: LAYERS, computedAt: 't' });
    expect(level.path).toBe('src');
    expect(level.diagram.classes.map((c) => c.name).sort()).toEqual(['Main', 'http/controllers']);
  });

  it('FR-26.3 the deepest common folder starts the map', () => {
    expect(commonRoot(['src/a/x.ts', 'src/b/y.ts'])).toBe('src');
    expect(commonRoot(['app/x.php', 'vendor/acme/y.php'])).toBe('');
    expect(commonRoot(['src/a/x.ts'])).toBe('src/a');
  });
});

describe('codebase map: shapes at the edges (FR-26.1, FR-26.3, FR-26.6)', () => {
  const kernel = cls('Kernel.php#Kernel', 'Presentation');
  const ctl = cls('app/Http/Ctl.php#Ctl', 'Presentation');
  const api = cls('app/Http/Api.php#Api', 'Application');
  const order = cls('app/Domain/Order.php#Order', 'Domain');
  const iRepo = cls('app/Domain/IRepo.php#IRepo', 'Domain');
  const sql = { ...cls('app/Infra/SqlRepo.php#SqlRepo', 'Infrastructure'), layerHint: { suggested: 'Domain', reasons: ['x'] } } as ClassNode;
  const { declaration: _d, ...cache } = cls('app/Infra/Cache.php#Cache');
  const site = (line: number) => ({ file: 'app/Http/Ctl.php', start: { line, character: 0 }, end: { line, character: 1 } });
  const noCalls = (r: ClassRelation): ClassRelation => {
    const { calls: _c, ...rest } = r;
    return rest as ClassRelation;
  };
  const model = mergeScans([
    scan('GET /a', [kernel, ctl, api, order], [
      rel(kernel.key, ctl.key),
      rel(ctl.key, order.key, { kind: 'association', label: 'order', calls: [{ messageId: 'a', label: 'save', callSite: site(4) }, { messageId: 'a2', label: 'load' }] }),
      noCalls(rel(api.key, order.key, { kind: 'association' })),
    ]),
    scan('GET /b', [ctl, order, iRepo, sql, cache as ClassNode], [
      // the same association again: its calls are known by their site, else by their label
      rel(ctl.key, order.key, { kind: 'association', label: 'order', calls: [{ messageId: 'b', label: 'load' }, { messageId: 'c', label: 'save', callSite: site(4) }] }),
      noCalls(rel(api.key, order.key, { kind: 'association' })),
      rel(sql.key, iRepo.key, { kind: 'realization' }),
      rel(cache.key, iRepo.key, { kind: 'realization' }),
      rel(order.key, sql.key, { violation: 'Domain must not depend on Infrastructure' }),
      rel(cache.key, order.key, { violation: 'Infrastructure is outside' }),
      rel(sql.key, cache.key, { kind: 'generalization', violation: 'a hint and no layer' }),
    ]),
    scan('GET /c', [], [], { failed: true }),
  ]);

  it('FR-26.1 two calls of one name at two places are two', () => {
    const r = (line: number) => rel(ctl.key, order.key, { calls: [{ messageId: 'x', label: 'save', callSite: site(line) }] });
    const merged = mergeScans([scan('a', [ctl, order], [r(4)]), scan('b', [ctl, order], [r(9), r(4)])]);
    expect([...merged.relations.values()][0].calls!.map((c) => c.callSite!.start.line)).toEqual([4, 9]);
  });

  it('FR-26.1 a failed flow is counted; relations without calls merge; a call without a site is one by its label', () => {
    expect(model).toMatchObject({ entryPoints: 3, failed: 1 });
    expect(model.relations.get(`association|${ctl.key}|${order.key}|order`)!.calls!.map((c) => c.label)).toEqual(['save', 'load']);
    expect(model.relations.get(`association|${api.key}|${order.key}|`)!.calls).toEqual([]);
  });

  it('FR-26.3 a top level at the project root: a class in the root itself; edges named by what they aggregate; a tie of layers goes by the layer order; a mixed folder\'s split', () => {
    const top = buildAppLevel(model, '', { layerOrder: LAYERS, computedAt: 't' });
    expect(top.path).toBe('');
    // Kernel sits in the root itself; app is a package (its most frequent layer: two Domain classes of six)
    expect(top.diagram.classes.map((c) => `${c.group ? 'pkg ' : ''}${c.name}${c.layer ? ` ${c.layer}` : ''}`).sort()).toEqual(['Kernel Presentation', 'pkg app Domain']);
    const inApp = buildAppLevel(model, 'app', { layerOrder: LAYERS, computedAt: 't' });
    const node = (n: string) => inApp.diagram.classes.find((c) => c.name === n)!;
    // Http: one Presentation, one Application class — the earlier layer; Infra: one class with a layer, one without
    expect(node('Http').layer).toBe('Presentation');
    expect(node('Infra').layer).toBe('Infrastructure');
    // a mixed folder: its classes per layer, most first (a tie by the layer order, no layer last)
    expect(node('Http').group!.layers).toEqual([{ layer: 'Presentation', classes: 1 }, { layer: 'Application', classes: 1 }]);
    expect(node('Infra').group!.layers).toEqual([{ layer: 'Infrastructure', classes: 1 }, { classes: 1 }]);
    expect(node('Domain').group!.layers).toBeUndefined();
    expect(top.diagram.classes.find((c) => c.name === 'app')!.group!.layers![0]).toEqual({ layer: 'Domain', classes: 2 });
    // the legend names Application, though no package at the top is in its lane
    expect(top.diagram.layers).toEqual(LAYERS);
    // the root's own classes beside the folder, related to it
    expect(node('(root) (its own classes)').group).toMatchObject({ path: '', external: true });
    const edge = (a: string, b: string) => inApp.diagram.relations.find((r) => r.from === `package:app/${a}` && r.to === `package:app/${b}`)!;
    expect(edge('Http', 'Domain')).toMatchObject({ kind: 'dependency', count: 2, label: '2' });
    expect(edge('Http', 'Domain').calls!.map((c) => c.label)).toEqual(['Ctl → Order (order)', 'Api → Order']);
    // the first call's site, else the class's declaration
    expect(edge('Http', 'Domain').calls!.map((c) => c.callSite?.start.line)).toEqual([4, 1]);
    // two realizations: drawn as one; a class without a declaration has no site; one of two relations breaks the rule
    expect(edge('Infra', 'Domain')).toMatchObject({ kind: 'dependency', count: 3, violation: '1 of 3 relations break the dependency rule: Infrastructure is outside' });
    const realizations = mergeScans([scan('x', [sql, cache as ClassNode, iRepo], [rel(sql.key, iRepo.key, { kind: 'realization' }), rel(cache.key, iRepo.key, { kind: 'realization' })])]);
    const real = buildAppLevel(realizations, 'app', { layerOrder: LAYERS, computedAt: 't' }).diagram.relations[0];
    expect(real).toMatchObject({ kind: 'realization', count: 2 });
    // a subclass and its base in another package: named as such
    const sub = mergeScans([scan('x', [sql, order], [rel(sql.key, order.key, { kind: 'generalization' }), rel(sql.key, order.key)])]);
    expect(buildAppLevel(sub, 'app', { layerOrder: LAYERS, computedAt: 't' }).diagram.relations[0].calls!.map((c) => c.label)).toEqual(['SqlRepo → Order (extends)', 'SqlRepo → Order']);
    expect(real.calls).toEqual([
      { messageId: '', label: 'SqlRepo → IRepo (implements)', callSite: sql.declaration },
      { messageId: '', label: 'Cache → IRepo (implements)' },
    ]);
  });

  it('FR-26.6 a violation lists the layers and hints its classes have', () => {
    const level = buildAppLevel(model, 'app', { layerOrder: LAYERS, computedAt: 't' });
    expect(level.violationList).toStrictEqual([
      { from: order.key, to: sql.key, fromName: 'Order', toName: 'SqlRepo', violation: 'Domain must not depend on Infrastructure', folder: 'app', fromLayer: 'Domain', toLayer: 'Infrastructure', toHint: { suggested: 'Domain', reasons: ['x'] } },
      { from: cache.key, to: order.key, fromName: 'Cache', toName: 'Order', violation: 'Infrastructure is outside', folder: 'app', toLayer: 'Domain' },
      { from: sql.key, to: cache.key, fromName: 'SqlRepo', toName: 'Cache', violation: 'a hint and no layer', folder: 'app/Infra', fromLayer: 'Infrastructure', fromHint: { suggested: 'Domain', reasons: ['x'] } },
    ]);
  });

  it('FR-26.3 the map of no classes starts nowhere', () => {
    expect(commonRoot([])).toBe('');
    expect(commonRoot(['Kernel.php'])).toBe('');
    expect(buildAppLevel(mergeScans([]), '', { layerOrder: LAYERS, computedAt: 't' })).toMatchObject({ path: '', classes: 0, relations: 0, diagram: { classes: [], relations: [] } });
  });
});

describe('codebase map of a project (FR-26, PHP fixture)', () => {
  it('FR-26.1 every entry point\'s flow, merged: the folders of the project with their relations and the layer violation', async () => {
    const s = session();
    const progress: number[] = [];
    const top = (await s.getAppMap('src', { onProgress: (done) => progress.push(done) }))!;
    expect(top.entryPoints).toBeGreaterThan(5);
    expect(progress.at(-1)).toBe(top.entryPoints);
    expect(top.rescanned).toBe(top.entryPoints);
    const pkgs = top.diagram.classes.filter((c) => c.group).map((c) => c.name);
    expect(pkgs).toEqual(expect.arrayContaining(['Http/Controllers', 'Services', 'Domain', 'Repositories']));
    const broken = top.diagram.relations.find((r) => r.from === 'package:src/Services' && r.to === 'package:src/Repositories')!;
    expect(broken.violation).toMatch(/break the dependency rule/);
    expect(top.violations).toBeGreaterThan(0);
    // FR-26.2 calls left folded by the expand limit are followed: no flow stays cut short
    expect(top.truncated).toBe(0);
  });

  it('FR-26.8 a map of selected entry points: only their flows are scanned and merged; the full map stays as it was', async () => {
    const s = session();
    const eps = (await s.getEntryPoints()).filter((e) => e.kind !== 'test');
    const pick = eps.slice(0, 2);
    expect(pick).toHaveLength(2);
    const progress: number[] = [];
    const some = (await s.getAppMap('', { entryPoints: pick.map(appMapEntryKey), onProgress: (done) => progress.push(done) }))!;
    expect(some.entryPoints).toBe(2);
    expect(progress.at(-1)).toBe(2); // only those were scanned
    const all = (await s.getAppMap(''))!;
    expect(all.entryPoints).toBe(eps.length);
    expect(all.classes).toBeGreaterThan(some.classes);
    // the selection again: from the cache, and still only its classes
    const again = (await s.getAppMap('', { entryPoints: pick.map(appMapEntryKey) }))!;
    expect([again.entryPoints, again.classes, again.rescanned]).toEqual([2, some.classes, 0]);
  });

  it('FR-26.2 an interface with two implementations: both are in the map, each realizing it', async () => {
    const level = (await session().getAppMap('src/Repositories'))!;
    const names = level.diagram.classes.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['OrderRepositoryContract', 'EloquentOrderRepository', 'InMemoryOrderRepository']));
    const realizes = level.diagram.relations.filter((r) => r.kind === 'realization' && r.to.endsWith('#OrderRepositoryContract')).map((r) => r.from.replace(/^.*#/, ''));
    expect(realizes.sort()).toEqual(['EloquentOrderRepository', 'InMemoryOrderRepository']);
  });

  it('FR-26.4 cached: other levels need no scan; a saved file re-scans only the entry points whose flows reached it; the design issues reuse the walk', async () => {
    const s = session();
    const first = (await s.getAppMap())!;
    expect((await s.getAppMap('src/Services'))!.rescanned).toBe(0);
    // FR-19.9 the design-issue scan is the same walk: no entry point is scanned again (FR-19.23 only the methods no
    // entry point reaches, counted after them)
    const steps: number[] = [];
    await s.findProjectIssues({ onProgress: (done) => steps.push(done) });
    expect(steps[0]).toBe(first.entryPoints);
    expect(steps.slice(1).every((n) => n > first.entryPoints)).toBe(true);
    // asked again after a rescan of the map: those are kept too
    steps.length = 0;
    await s.findProjectIssues({ onProgress: (done) => steps.push(done), rescan: false });
    expect(steps.length).toBeLessThanOrEqual(1);
    await s.refresh([`${ROOT}/src/Repositories/InMemoryOrderRepository.php`]);
    const after = (await s.getAppMap())!;
    expect(after.rescanned).toBeGreaterThan(0);
    expect(after.rescanned).toBeLessThan(first.entryPoints);
    expect(after.classes).toBe(first.classes);
    // a file no flow reaches: nothing to scan
    await s.refresh([`${ROOT}/src/Providers/RouteServiceProvider.php`]);
    expect((await s.getAppMap())!.rescanned).toBe(0);
    // ↻ Rescan: everything
    expect((await s.getAppMap('', { rescan: true }))!.rescanned).toBe(first.entryPoints);
  });

  it('FR-26.2 / FR-19.9 the design issues scan only the flows; the map then follows where they stop (same scans, no second expansion)', async () => {
    const s = session();
    const steps: number[] = [];
    await s.findProjectIssues({ onProgress: (done) => steps.push(done) });
    const map = (await s.getAppMap())!;
    expect(map.rescanned).toBe(s.projectEntryPointCount); // every entry point: its stops are followed now
    expect(map.truncated).toBe(0);
    expect((await s.getAppMap())!.rescanned).toBe(0);
  });

  it('FR-26.4 a cancelled scan keeps what it scanned; the next request continues from there', async () => {
    const s = session();
    let n = 0;
    expect(await s.getAppMap('', { onProgress: () => n++, cancelled: () => n >= 3 })).toBeUndefined();
    const rest = (await s.getAppMap())!;
    expect(rest.rescanned).toBe(rest.entryPoints - 3);
  });
});
