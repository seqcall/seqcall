import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClassNode, ClassRelation, EntryPoint, StructureRow } from '@seqcall/protocol';
import type { EntryPointScan } from '../src/app-map';
import { createClassifier } from '../src/classifier-impl';
import { affectedScans, diffStructure } from '../src/review/structure-diff';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

// ───────────────────────────── the pure diff ─────────────────────────────

const cls = (key: string, layer?: string): ClassNode => ({
  key,
  name: key.replace(/^.*#/, ''),
  kind: 'class',
  stereotypes: [],
  ...(layer ? { layer } : {}),
  namespace: key.replace(/#.*$/, '').replace(/\/[^/]*$/, ''),
  methods: [{ name: 'run', isStatic: false, signature: 'run()' }],
});
const rel = (from: string, to: string, extra: Partial<ClassRelation> = {}): ClassRelation => ({
  id: `${from}>${to}`,
  kind: 'dependency',
  from,
  to,
  calls: [{ messageId: '', label: 'run → run', callSite: { file: from.replace(/#.*$/, ''), start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } }],
  ...extra,
});
const ep = (label: string, name = label): EntryPoint => ({ kind: 'http', label, method: { key: `src/x.ts#X.${name}`, name, owner: { key: 'src/x.ts#X', name: 'X', kind: 'class' } } as EntryPoint['method'] });
const scan = (entry: EntryPoint, classes: ClassNode[], relations: ClassRelation[]): EntryPointScan => ({
  entry,
  files: new Set(classes.map((c) => c.key.replace(/#.*$/, ''))),
  classes,
  relations,
  findings: [],
  truncated: false,
});
const ctrl = cls('src/presentation/OrderController.ts#OrderController', 'Presentation');
const svc = cls('src/application/orders/OrderService.ts#OrderService', 'Application');
const billing = cls('src/application/billing/InvoiceService.ts#InvoiceService', 'Application');
const audit = cls('src/application/orders/Audit.ts#Audit', 'Application');
const order = cls('src/domain/Order.ts#Order', 'Domain');
const db = cls('src/infrastructure/Db.ts#Db', 'Infrastructure');
const mailer = cls('src/notifications/Mailer.ts#Mailer');
const show = ep('GET /orders/:id', 'show');
const list = ep('GET /orders', 'list');
const remove = ep('DELETE /orders/:id', 'remove');
const summary = (rows: StructureRow[]) => rows.map((r) => `${r.kind} ${r.title}${r.level ? ` [${r.level}]` : ''}`);

describe('FR-29 structural delta of a branch (Level 0)', () => {
  const base = {
    scans: [
      scan(show, [ctrl, svc, order, mailer], [rel(ctrl.key, svc.key), rel(svc.key, order.key), rel(svc.key, mailer.key), rel(svc.key, audit.key)]),
      scan(list, [ctrl, svc, order], [rel(ctrl.key, svc.key), rel(svc.key, order.key)]),
    ],
    entryPoints: [show, list],
  };

  it('FR-29.2 lists dependencies between layers that appeared or vanished, with the class pairs and the first entry point reaching them', () => {
    const branch = {
      scans: [
        scan(show, [ctrl, svc, order, db], [rel(ctrl.key, svc.key), rel(svc.key, order.key), rel(order.key, db.key, { violation: 'Domain must not depend on Infrastructure' }), rel(svc.key, audit.key)]),
        scan(list, [ctrl, svc, order], [rel(ctrl.key, svc.key), rel(svc.key, order.key)]),
      ],
      entryPoints: [show, list],
    };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual(['violation-added Layer violation: Order → Db [layer]', 'edge-added Domain → Infrastructure [layer]', 'edge-removed Application → No layer · notifications [layer]']);
    const added = rows[1];
    expect(added).toMatchObject({ from: 'layer:Domain', to: 'layer:Infrastructure', detail: 'Order → Db', entryPoint: { label: 'GET /orders/:id' } });
    expect(added.pairs).toEqual([{ from: order.key, fromName: 'Order', to: db.key, toName: 'Db', call: { label: 'run → run', callSite: { file: 'src/domain/Order.ts', start: { line: 3, character: 4 }, end: { line: 3, character: 9 } } } }]);
    expect(rows[0]).toMatchObject({ detail: 'Domain must not depend on Infrastructure', pairs: [{ fromName: 'Order', toName: 'Db' }], entryPoint: { label: 'GET /orders/:id' } });
    // the removed edge is reached from the base's flow
    expect(rows[2]).toMatchObject({ from: 'layer:Application', to: 'layer::src/notifications', detail: 'OrderService → Mailer', entryPoint: { label: 'GET /orders/:id' } });
  });

  it('FR-29.2 inside one layer the unit is the package of the codebase map; a call inside one package is no structural change', () => {
    const branch = {
      scans: [scan(show, [ctrl, svc, order, mailer, billing], [rel(ctrl.key, svc.key), rel(svc.key, order.key), rel(svc.key, mailer.key), rel(svc.key, billing.key)]), base.scans[1]],
      entryPoints: [show, list],
    };
    const rows = diffStructure(base, branch);
    // OrderService → Audit (same layer, same folder) vanished: not listed; OrderService → InvoiceService crosses packages inside Application
    expect(summary(rows)).toEqual(['edge-added orders → billing [package]']);
    expect(rows[0]).toMatchObject({ from: 'src/application/orders', to: 'src/application/billing', detail: 'OrderService → InvoiceService' });
  });

  it('FR-29.3 entry points added and removed (by kind and label — a route moved to another method is the same route); new rows first, then removals', () => {
    const moved = ep('GET /orders', 'index');
    const branch = { scans: [base.scans[0], scan(moved, [ctrl, svc], [rel(ctrl.key, svc.key)]), scan(remove, [ctrl, svc, order], [rel(ctrl.key, svc.key), rel(svc.key, order.key)])], entryPoints: [show, moved, remove] };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual(['entry-added DELETE /orders/:id']);
    expect(rows[0]).toMatchObject({ detail: 'X.remove', entryPoint: remove });
    const gone = diffStructure(branch, base);
    expect(summary(gone)).toEqual(['entry-removed DELETE /orders/:id']);
  });

  it('FR-29.2 type uses and inheritance are no flow edges; nothing changed gives no rows', () => {
    const branch = { scans: [scan(show, [ctrl, svc, order, mailer, db], [...base.scans[0].relations, rel(order.key, db.key, { kind: 'use' }), rel(svc.key, db.key, { kind: 'realization', calls: [] })]), base.scans[1]], entryPoints: base.entryPoints };
    expect(diffStructure(base, branch)).toEqual([]);
    expect(diffStructure(base, base)).toEqual([]);
  });

  it('FR-29.7 I/O kinds a layer started or stopped doing, with the classes and the call into the first of them', () => {
    const io = (entries: [ClassNode, ('db' | 'http' | 'file')[]][]) => new Map(entries.map(([c, k]) => [c.key, k.map((kind) => ({ kind, client: `${kind}-client` }))]));
    const branch = { ...base, scans: [scan(show, [ctrl, svc, order, mailer, db], [...base.scans[0].relations, rel(svc.key, db.key)]), base.scans[1]] };
    const rows = diffStructure({ ...base, io: io([[mailer, ['http']]]) }, { ...branch, io: io([[db, ['db']], [mailer, ['http']], [svc, ['http']]]) });
    expect(summary(rows)).toEqual(['edge-added Application → Infrastructure [layer]', 'io-added Application: HTTP [layer]', 'io-added Infrastructure: DB [layer]']);
    expect(rows[2]).toMatchObject({ from: 'layer:Infrastructure', io: 'db', detail: 'Db', classKeys: [db.key], entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'OrderService', toName: 'Db' }] });
    // removed: from the base's flow; an interface does no I/O of its own; without facts on one side nothing is compared
    const port = { ...cls('src/application/orders/Port.ts#Port', 'Application'), kind: 'interface' as const };
    const withPort = { ...base, scans: [scan(show, [...base.scans[0].classes, port], base.scans[0].relations)] };
    expect(summary(diffStructure({ ...base, io: io([[order, ['file']]]) }, { ...withPort, io: io([[port, ['http']]]) }))).toEqual(['io-removed Domain: File [layer]']);
    expect(diffStructure({ ...base, io: io([[order, ['file']]]) }, base)).toEqual([]);
  });

  it('FR-29.10 a new I/O client in a layer that already did that kind of I/O; a new kind names its clients in its own row', () => {
    const io = (entries: [ClassNode, [string, string][]][]) => new Map(entries.map(([c, uses]) => [c.key, uses.map(([kind, client]) => ({ kind: kind as 'db' | 'queue', client }))]));
    const branch = { ...base, scans: [scan(show, [ctrl, svc, order, mailer, db], [...base.scans[0].relations, rel(svc.key, db.key)]), base.scans[1]] };
    const before = io([[mailer, [['db', 'Npgsql']]]]);
    // Db: a second DB client in a layer with DB I/O already → client row; Queue is a new kind → io row only
    const rows = diffStructure({ ...base, io: before }, { ...branch, io: io([[mailer, [['db', 'Npgsql']]], [db, [['db', 'StackExchange.Redis'], ['queue', 'Confluent.Kafka']]]]) });
    expect(summary(rows).filter((r) => !r.startsWith('edge'))).toEqual(['io-added Infrastructure: DB [layer]', 'io-added Infrastructure: Queue [layer]']);
    const sameLayer = { ...base, scans: [scan(show, [ctrl, svc, order, mailer, { ...db, layer: undefined, namespace: 'src/notifications' }], [...base.scans[0].relations, rel(svc.key, db.key)]), base.scans[1]] };
    const rows2 = diffStructure({ ...base, io: before }, { ...sameLayer, io: io([[mailer, [['db', 'Npgsql']]], [db, [['db', 'StackExchange.Redis']]]]) });
    expect(summary(rows2)).toEqual(['client-added No layer · notifications: StackExchange.Redis (DB) [layer]']);
    expect(rows2[0]).toMatchObject({ io: 'db', client: 'StackExchange.Redis', detail: 'Db', entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'OrderService', toName: 'Db' }] });
    expect(summary(diffStructure({ ...sameLayer, io: io([[mailer, [['db', 'Npgsql']]], [db, [['db', 'StackExchange.Redis']]]]) }, { ...base, io: before }))).toEqual(['client-removed No layer · notifications: StackExchange.Redis (DB) [layer]']);
  });

  it('FR-29.11 a class whose role changed — over every flow, without the stereotypes one diagram\'s way of reaching it gives', () => {
    const asRole = (c: ClassNode, stereotypes: string[], reasons: ClassNode['stereotypeReasons'] = []): ClassNode => ({ ...c, stereotypes, stereotypeReasons: reasons });
    const was = { ...base, scans: [scan(show, [ctrl, asRole(svc, ['service']), order], base.scans[0].relations), scan(list, [ctrl, asRole(svc, ['service', 'static'], [{ stereotype: 'static', text: 'called statically in this diagram', inThisDiagram: true }]), order], base.scans[1].relations)] };
    const now = { ...base, scans: [scan(show, [ctrl, asRole(svc, ['repository'], [{ stereotype: 'repository', text: 'name ends in `Repository`' }]), order], base.scans[0].relations), scan(list, [ctrl, asRole(svc, ['repository', 'seam'], [{ stereotype: 'seam', text: 'reached through an injected interface', inThisDiagram: true }]), order], base.scans[1].relations)] };
    const rows = diffStructure(was, now);
    expect(summary(rows)).toEqual(['role-changed OrderService: «service» → «repository» [layer]']);
    expect(rows[0]).toMatchObject({ detail: '«repository» — name ends in Repository', classKeys: [svc.key], entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'OrderController', toName: 'OrderService' }] });
    // only the flow-dependent stereotypes differ: no change
    const flowOnly = { ...was, scans: [was.scans[0], scan(list, [ctrl, asRole(svc, ['service', 'seam'], [{ stereotype: 'seam', text: 'x', inThisDiagram: true }]), order], base.scans[1].relations)] };
    expect(diffStructure(was, flowOnly)).toEqual([]);
  });

  it('FR-29.8 cycles between layers and between packages that appeared or vanished, named in cycle order with the pairs that closed them', () => {
    const branch = {
      ...base,
      scans: [scan(show, [ctrl, svc, order, mailer, billing, audit], [...base.scans[0].relations, rel(order.key, svc.key), rel(svc.key, billing.key), rel(billing.key, audit.key)]), base.scans[1]],
    };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual([
      'cycle-added Cycle: Application → Domain → Application [layer]',
      'cycle-added Cycle: billing → orders → billing [package]',
      'edge-added Domain → Application [layer]',
      'edge-added billing → orders [package]',
      'edge-added orders → billing [package]',
    ]);
    expect(rows[0]).toMatchObject({ members: ['layer:Application', 'layer:Domain'], detail: 'Order → OrderService', entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'Order', toName: 'OrderService' }] });
    expect(rows[1]).toMatchObject({ members: ['src/application/billing', 'src/application/orders'], detail: 'InvoiceService → Audit, OrderService → InvoiceService' });
    expect(summary(diffStructure(branch, base))).toEqual(expect.arrayContaining(['cycle-removed Cycle: Application → Domain → Application [layer]', 'cycle-removed Cycle: billing → orders → billing [package]']));
  });

  it('FR-29.8 a cycle through three layers is named along its edges', () => {
    const branch = { ...base, scans: [scan(show, [ctrl, svc, order], [...base.scans[0].relations, rel(order.key, ctrl.key)]), base.scans[1]] };
    const rows = diffStructure(base, branch).filter((r) => r.kind === 'cycle-added');
    expect(rows.map((r) => r.title)).toEqual(['Cycle: Application → Domain → Presentation → Application']);
  });

  it('FR-29.8 a cycle that grew or shrank is neither added nor removed; one around a new set is', () => {
    const two = { ...base, scans: [scan(show, [ctrl, svc, order], [...base.scans[0].relations, rel(order.key, svc.key)]), base.scans[1]] };
    const three = { ...base, scans: [scan(show, [ctrl, svc, order], [...base.scans[0].relations, rel(order.key, svc.key), rel(order.key, ctrl.key), rel(svc.key, ctrl.key)]), base.scans[1]] };
    const cyclesOf = (rows: StructureRow[]) => summary(rows).filter((r) => r.startsWith('cycle'));
    expect(cyclesOf(diffStructure(two, three))).toEqual(['cycle-added Cycle: Application → Domain → Presentation → Application [layer]']);
    expect(cyclesOf(diffStructure(three, two))).toEqual(['cycle-removed Cycle: Application → Domain → Presentation → Application [layer]']);
    // two cycles sharing one layer, no cycle through all three: the shortest one is named, the rest in brackets
    const eight = { ...base, scans: [scan(show, [ctrl, svc, order], [...base.scans[0].relations, rel(order.key, svc.key), rel(svc.key, ctrl.key)]), base.scans[1]] };
    expect(cyclesOf(diffStructure(base, eight))).toEqual(['cycle-added Cycle: Application → Domain → Application (+ Presentation) [layer]']);
  });

  it('FR-29.9 a class in another layer than on the base — also when its file moved (git rename) — with the reason it is there now', () => {
    const moved = { ...cls('src/infrastructure/Order.ts#Order', 'Infrastructure'), layerReason: { rule: 'folder' as const, text: 'layer folder `infrastructure/`', strength: 'strong' as const, notApplied: [] } };
    const branch = { ...base, scans: [scan(show, [ctrl, svc, moved, mailer], [rel(ctrl.key, svc.key), rel(svc.key, moved.key), rel(svc.key, mailer.key), rel(svc.key, audit.key)]), scan(list, [ctrl, svc, moved], [rel(ctrl.key, svc.key), rel(svc.key, moved.key)])] };
    const rows = diffStructure(base, branch, { renames: new Map([['src/domain/Order.ts', 'src/infrastructure/Order.ts']]) });
    expect(summary(rows)).toEqual(['edge-added Application → Infrastructure [layer]', 'layer-changed Order: Domain → Infrastructure [layer]', 'edge-removed Application → Domain [layer]']);
    expect(rows[1]).toMatchObject({ from: 'layer:Domain', to: 'layer:Infrastructure', classKeys: [moved.key], detail: 'moved from src/domain/Order.ts · layer folder infrastructure/', entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'OrderService', toName: 'Order' }] });
    // without the rename it is another class: no layer change
    expect(diffStructure(base, branch).some((r) => r.kind === 'layer-changed')).toBe(false);
    // the same file, classified differently
    const reclassified = { ...base, scans: [scan(show, [ctrl, svc, { ...order, layer: 'Application' }], [rel(ctrl.key, svc.key)]), base.scans[1]] };
    expect(summary(diffStructure(base, reclassified)).filter((r) => r.startsWith('layer-changed'))).toEqual(['layer-changed Order: Domain → Application [layer]']);
  });

  it('FR-29.1 only flows that reached a changed file (or failed) need the base version', () => {
    const failed = { ...scan(remove, [], []), failed: true };
    expect(affectedScans([...base.scans, failed], new Set(['src/domain/Order.ts'])).map((s) => s.entry.label)).toEqual(['GET /orders/:id', 'GET /orders', 'DELETE /orders/:id']);
    expect(affectedScans(base.scans, new Set(['src/notifications/Mailer.ts'])).map((s) => s.entry.label)).toEqual(['GET /orders/:id']);
    expect(affectedScans(base.scans, new Set(['README.md']))).toEqual([]);
  });
});

// ───────────────────────────── the review on a repository ─────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-structure-')).replace(/\\/g, '/');
const write = (relPath: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
  fs.writeFileSync(path.join(root, relPath), text);
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();

beforeAll(() => {
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\nexport const Delete = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/infrastructure/db.ts', `export class Db {\n  save(x: string) { return x; }\n}\n`);
  write('src/infrastructure/order-repo.ts', `export class OrderRepo {\n  load(id: string) { return id; }\n}\n`);
  write('src/notifications/mailer.ts', `export class Mailer {\n  send(what: string) { return what; }\n}\n`);
  write('src/domain/order.ts', `export class Order {\n  total() {\n    return 1;\n  }\n}\n`);
  write('src/application/order-service.ts', `import { Order } from '../domain/order';\nimport { OrderRepo } from '../infrastructure/order-repo';\nimport { Mailer } from '../notifications/mailer';\nexport class OrderService {\n  place(id: string) {\n    new OrderRepo().load(id);\n    new Mailer().send('placed');\n    return new Order().total();\n  }\n  cancel(id: string) {\n    return new OrderRepo().load(id);\n  }\n}\n`);
  write('src/presentation/orders.controller.ts', `import { Controller, Get, Delete } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id') show() { return new OrderService().place('1'); }\n}\n`);
  write('src/presentation/legacy.controller.ts', `import { Controller, Get } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('legacy')\nexport class LegacyController {\n  @Get('orders') list() { return new OrderService().place('old'); }\n}\n`);
  write('src/presentation/health.controller.ts', `import { Controller, Get } from '../decorators';\n@Controller('health')\nexport class HealthController {\n  @Get() check() { return 'ok'; }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/shape');
  // the branch: Domain saves through Infrastructure (new layer edge + violation), the mail is gone (edge removed),
  // a new route, the legacy route deleted; health untouched
  write('src/domain/order.ts', `import { Db } from '../infrastructure/db';\nexport class Order {\n  total() {\n    new Db().save('total');\n    return 1;\n  }\n}\n`);
  write('src/application/order-service.ts', `import { Order } from '../domain/order';\nimport { OrderRepo } from '../infrastructure/order-repo';\nexport class OrderService {\n  place(id: string) {\n    new OrderRepo().load(id);\n    return new Order().total();\n  }\n  cancel(id: string) {\n    return new OrderRepo().load(id);\n  }\n}\n`);
  write('src/presentation/orders.controller.ts', `import { Controller, Get, Delete } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id') show() { return new OrderService().place('1'); }\n  @Delete(':id') remove() { return new OrderService().cancel('1'); }\n}\n`);
  fs.rmSync(path.join(root, 'src/presentation/legacy.controller.ts'));
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-29 the review compares the structure with the base version', () => {
  it('FR-29.1 / FR-29.4 / FR-29.5 the rows of a branch; affected flows compared on the base, unchanged flows copied; a row opens the zoomed flow at its call', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const phases: string[] = [];
    const r = (await s.reviewChanges({ onProgress: (p) => phases.push(p) }))!;
    expect(phases).toContain('Comparing the structure: the base version');
    const st = r.structure!;
    expect(summary(st.rows)).toEqual([
      'violation-added Layer violation: Order → Db [layer]',
      'edge-added Domain → Infrastructure [layer]',
      'entry-added DELETE /orders/:id',
      'edge-removed Application → No layer · notifications [layer]',
      'entry-removed GET /legacy/orders',
    ]);
    // GET /orders/:id touches changed files and GET /legacy/orders exists only in the base: analysed there; GET /health is the same in both
    expect([st.compared, st.copied, st.notCompared]).toEqual([2, 1, 0]);
    const edge = st.rows[1];
    expect(edge).toMatchObject({ detail: 'Order → Db', entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'Order', toName: 'Db', call: { callSite: { file: `${root}/src/domain/order.ts` } } }] });
    expect(st.rows[3]).toMatchObject({ detail: 'OrderService → Mailer', entryPoint: { label: 'GET /orders/:id' } });
    expect(st.rows[4]).toMatchObject({ detail: 'LegacyController.list · controller', entryPoint: { label: 'GET /legacy/orders' } });
    // the row opens its entry point's flow zoomed to layers, the new call highlighted (and marked by the review)
    const opened = (await s.openReviewStructure(edge))!;
    const hit = opened.diagram!.messages.find((m) => m.id === opened.messageId)!;
    expect(hit).toMatchObject({ methodName: 'save', diff: { status: 'added' } });
    expect(opened.diagram!.participants.map((p) => p.id)).toEqual(expect.arrayContaining(['layer:Domain', 'layer:Infrastructure']));
    // nothing to open for an entry point only the base has
    expect(await s.openReviewStructure(st.rows[4])).toBeUndefined();
    // FR-24.8 shown again with the structure
    expect((await s.reviewChanges())!).toMatchObject({ reused: true, structure: { rows: st.rows } });
    await s.dispose();
  });

  it('FR-29.6 the scan behind the codebase map ignores the layer zoom of the user\'s view', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    await s.setOption('layerZoom', true);
    const map = (await s.getAppMap())!;
    expect(map.diagram.classes.map((c) => c.key).some((k) => k.startsWith('layer:'))).toBe(false);
    expect(map.classes).toBeGreaterThan(3);
  });

  it('FR-29.6 a review finds the same issues with the view zoomed to layers (the branch adds a layer violation)', async () => {
    const issues = async (zoom: boolean) => {
      const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
      if (zoom) await s.setOption('layerZoom', true);
      const r = (await s.reviewChanges())!;
      await s.dispose();
      return r.issues.map((i) => `${i.finding.kind} ${i.finding.title} (${i.where})`).sort();
    };
    const plain = await issues(false);
    expect(plain).toContain('layer-violation Layer violation: Order → Db (changed-lines)');
    expect(await issues(true)).toEqual(plain);
  });
});

// ───────────────────────────── A2 rows on a repository ─────────────────────────────

describe('FR-29 A2: I/O kinds, cycles and layer changes on a repository', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-structure-a2-')).replace(/\\/g, '/');
  const put = (relPath: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root2, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root2, relPath), text);
  };
  const git2 = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root2, stdio: 'pipe' }).toString();
  const tax = `export class TaxTable {\n  rate(country: string) {\n    return country.length / 100;\n  }\n  vat() {\n    return 0.2;\n  }\n}\n`;

  beforeAll(() => {
    put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
    put('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
    put('src/domain/tax-table.ts', tax);
    put('src/domain/order.ts', `export class Order {\n  total() {\n    return 1;\n  }\n}\n`);
    put('src/application/clock.ts', `export class Clock {\n  now() {\n    return 0;\n  }\n}\n`);
    put('src/infrastructure/order-repo.ts', `export class OrderRepo {\n  load(id: string) {\n    return id;\n  }\n}\n`);
    put('src/infrastructure/report-file.ts', `import { writeFile } from 'node:fs/promises';\nexport class ReportFile {\n  write(text: string) {\n    return writeFile('report.txt', text);\n  }\n}\n`);
    put(
      'src/application/order-service.ts',
      `import { Order } from '../domain/order';\nimport { TaxTable } from '../domain/tax-table';\nimport { OrderRepo } from '../infrastructure/order-repo';\nexport class OrderService {\n  place(id: string) {\n    new OrderRepo().load(id);\n    new TaxTable().rate(id);\n    return new Order().total();\n  }\n}\n`,
    );
    put('src/presentation/orders.controller.ts', `import { Controller, Get } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id') show() { return new OrderService().place('1'); }\n}\n`);
    git2('init', '-q', '-b', 'develop');
    git2('add', '.');
    git2('commit', '-q', '-m', 'base');
    git2('checkout', '-q', '-b', 'feature/a2');
    // the branch: the tax table moves to Infrastructure (same content: a git rename), the service writes a report
    // file (Infrastructure now does File I/O — and the repo asks the application's clock: a cycle)
    fs.mkdirSync(path.join(root2, 'src/infrastructure'), { recursive: true });
    git2('mv', 'src/domain/tax-table.ts', 'src/infrastructure/tax-table.ts');
    put('src/infrastructure/order-repo.ts', `import { Clock } from '../application/clock';\nexport class OrderRepo {\n  static readonly shared = new OrderRepo();\n  load(id: string) {\n    new Clock().now();\n    return id;\n  }\n}\n`);
    put(
      'src/application/order-service.ts',
      `import { Order } from '../domain/order';\nimport { TaxTable } from '../infrastructure/tax-table';\nimport { OrderRepo } from '../infrastructure/order-repo';\nimport { ReportFile } from '../infrastructure/report-file';\nexport class OrderService {\n  place(id: string) {\n    new OrderRepo().load(id);\n    new TaxTable().rate(id);\n    new ReportFile().write(id);\n    return new Order().total();\n  }\n}\n`,
    );
    git2('add', '-A');
    git2('commit', '-q', '-m', 'feature');
  });
  afterAll(() => fs.rmSync(root2, { recursive: true, force: true }));

  it('FR-29.7 … 28.11 the rows of a branch, from both versions\' own file facts; each opens its flow', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root2), classifier: createClassifier(root2), createBaseAdapter: () => createTsAdapter(root2) });
    const st = (await s.reviewChanges())!.structure!;
    expect(summary(st.rows)).toEqual([
      'violation-added Layer violation: OrderService → ReportFile [layer]',
      'violation-added Layer violation: OrderService → TaxTable [layer]',
      'cycle-added Cycle: Application → Infrastructure → Application [layer]',
      'edge-added Infrastructure → Application [layer]',
      'io-added Infrastructure: File [layer]',
      'layer-changed TaxTable: Domain → Infrastructure [layer]',
      'role-changed OrderRepo: «repository» → «repository» «singleton» [layer]',
    ]);
    const io = st.rows[4];
    expect(io).toMatchObject({ io: 'file', detail: 'ReportFile', entryPoint: { label: 'GET /orders/:id' }, pairs: [{ fromName: 'OrderService', toName: 'ReportFile' }] });
    expect(st.rows[5]).toMatchObject({ from: 'layer:Domain', to: 'layer:Infrastructure', detail: expect.stringMatching(/^moved from src\/domain\/tax-table\.ts/) });
    expect(st.rows[2]).toMatchObject({ members: ['layer:Application', 'layer:Infrastructure'], detail: 'OrderRepo → Clock' });
    // the I/O row opens the zoomed flow at the call into the class doing it
    const opened = (await s.openReviewStructure(io))!;
    expect(opened.diagram!.messages.find((m) => m.id === opened.messageId)).toMatchObject({ methodName: 'write', diff: { status: 'added' } });
    // the cycle row at the call that closed it, the layer-changed row at the call into the moved class
    const cycle = (await s.openReviewStructure(st.rows[2]))!;
    expect(cycle.diagram!.messages.find((m) => m.id === cycle.messageId)).toMatchObject({ methodName: 'now', diff: { status: 'added' } });
    expect(st.rows[6]).toMatchObject({ detail: '«singleton» — it holds a static instance of itself', classKeys: [expect.stringMatching(/order-repo\.ts#OrderRepo$/)] });
    const moved = (await s.openReviewStructure(st.rows[5]))!;
    expect(moved.diagram!.messages.find((m) => m.id === moved.messageId)).toMatchObject({ methodName: 'rate' });
    await s.dispose();
  });
});
