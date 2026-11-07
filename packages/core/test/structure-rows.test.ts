import { describe, expect, it } from 'vitest';
import type { ClassNode, ClassRelation, EntryPoint, StructureRow } from '@seqcall/protocol';
import type { EntryPointScan } from '../src/app-map';
import { diffStructure } from '../src/review/structure-diff';

// FR-29 the rows of the structural delta in detail: pure `diffStructure` on hand-made flows (structure.test.ts has
// the main cases and the review on a repository)

const cls = (key: string, layer?: string, extra: Partial<ClassNode> = {}): ClassNode => ({
  key,
  name: key.replace(/^.*#/, ''),
  kind: 'class',
  stereotypes: [],
  ...(layer ? { layer } : {}),
  namespace: key.replace(/#.*$/, '').replace(/\/[^/]*$/, ''),
  methods: [{ name: 'run', isStatic: false, signature: 'run()' }],
  ...extra,
});
const at = (file: string, line: number) => ({ file, start: { line, character: 4 }, end: { line, character: 9 } });
const rel = (from: string, to: string, extra: Partial<ClassRelation> = {}): ClassRelation => ({
  id: `${from}>${to}`,
  kind: 'dependency',
  from,
  to,
  calls: [{ messageId: '', label: 'run → run', callSite: at(from.replace(/#.*$/, ''), 3) }],
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
const summary = (rows: StructureRow[]) => rows.map((r) => `${r.kind} ${r.title}${r.level ? ` [${r.level}]` : ''}`);

const ctrl = cls('src/presentation/OrderController.ts#OrderController', 'Presentation');
const svc = cls('src/application/orders/OrderService.ts#OrderService', 'Application');
const billing = cls('src/application/billing/InvoiceService.ts#InvoiceService', 'Application');
const audit = cls('src/application/orders/Audit.ts#Audit', 'Application');
const order = cls('src/domain/Order.ts#Order', 'Domain');
const db = cls('src/infrastructure/Db.ts#Db', 'Infrastructure');
const repo = cls('src/infrastructure/OrderRepo.ts#OrderRepo', 'Infrastructure');
const show = ep('GET /orders/:id', 'show');
const list = ep('GET /orders', 'list');
const remove = ep('DELETE /orders/:id', 'remove');
const base = { scans: [scan(show, [ctrl, svc], [rel(ctrl.key, svc.key)])], entryPoints: [show] };

describe('FR-29 structural delta: the class pairs behind a row', () => {
  it('FR-29.5 a pair carries the call to open: none for a field never called, the label alone for a call without a site', () => {
    const branch = {
      scans: [scan(show, [ctrl, svc, db, order], [rel(ctrl.key, svc.key), rel(svc.key, db.key, { kind: 'association', label: 'db', calls: [] }), rel(ctrl.key, order.key, { calls: [{ messageId: '', label: 'total → total' }] })])],
      entryPoints: [show],
    };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual(['edge-added Application → Infrastructure [layer]', 'edge-added Presentation → Domain [layer]']);
    expect(rows[0].pairs).toStrictEqual([{ from: svc.key, fromName: 'OrderService', to: db.key, toName: 'Db' }]);
    expect(rows[1].pairs).toStrictEqual([{ from: ctrl.key, fromName: 'OrderController', to: order.key, toName: 'Order', call: { label: 'total → total' } }]);
  });

  it('FR-29.5 a field called in another flow than the one the row opens: the pair keeps that call', () => {
    const field = (calls: ClassRelation['calls']) => rel(svc.key, db.key, { kind: 'association', label: 'db', calls });
    const branch = {
      scans: [scan(show, [ctrl, svc, db], [rel(ctrl.key, svc.key), field([])]), scan(list, [ctrl, svc, db], [rel(ctrl.key, svc.key), field([{ messageId: '', label: 'save' }])])],
      entryPoints: [show, list],
    };
    const [row] = diffStructure({ ...base, entryPoints: [show, list] }, branch);
    expect(row).toMatchObject({ kind: 'edge-added', entryPoint: show });
    expect(row.pairs).toStrictEqual([{ from: svc.key, fromName: 'OrderService', to: db.key, toName: 'Db', call: { label: 'save' } }]);
  });

  it('FR-29.2 calls between two library classes and between packages of one layer: libraries are one group, a class at the root is the "(root)" package', () => {
    const axios = cls('lib:axios#Axios', undefined, { kind: 'external', namespace: 'axios' });
    const request = cls('lib:axios#Request', undefined, { kind: 'external', namespace: 'axios' });
    const main = cls('main.ts#Main', 'Application');
    const branch = { scans: [scan(show, [ctrl, svc, axios, request, main], [rel(ctrl.key, svc.key), rel(axios.key, request.key), rel(main.key, svc.key)])], entryPoints: [show] };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual(['edge-added (root) → src [package]']);
    expect(rows[0]).toMatchObject({ from: '', to: 'src', detail: 'Main → OrderService' });
  });

  it('FR-29.4 a layer violation by a type use (no flow edge) is listed without a flow to open; removed, it is listed too', () => {
    const branch = { scans: [scan(show, [ctrl, svc, order, db], [rel(ctrl.key, svc.key), rel(order.key, db.key, { kind: 'use', calls: [], violation: 'Domain → Infrastructure: an inner layer depends on an outer layer' })])], entryPoints: [show] };
    const rows = diffStructure(base, branch);
    expect(summary(rows)).toEqual(['violation-added Layer violation: Order → Db [layer]']);
    expect(rows[0]).toStrictEqual({
      kind: 'violation-added',
      title: 'Layer violation: Order → Db',
      detail: 'Domain → Infrastructure: an inner layer depends on an outer layer',
      level: 'layer',
      from: 'layer:Domain',
      to: 'layer:Infrastructure',
      pairs: [{ from: order.key, fromName: 'Order', to: db.key, toName: 'Db' }],
    });
    expect(summary(diffStructure(branch, base))).toEqual(['violation-removed Layer violation: Order → Db [layer]']);
  });

  it('FR-29.4 a class that creates and holds an outer-layer object breaks the rule once: one violation row, opened at the call', () => {
    const viol = 'Domain → Infrastructure: an inner layer depends on an outer layer';
    const branch = {
      scans: [
        scan(show, [ctrl, svc, order, db], [
          rel(ctrl.key, svc.key),
          rel(order.key, db.key, { label: '«create»', violation: viol, calls: [{ messageId: '', label: 'new Db()', callSite: at('src/domain/Order.ts', 2) }] }),
          rel(order.key, db.key, { kind: 'association', label: 'db', violation: viol, calls: [{ messageId: '', label: 'save', callSite: at('src/domain/Order.ts', 5) }] }),
        ]),
      ],
      entryPoints: [show],
    };
    const rows = diffStructure(base, branch).filter((r) => r.kind === 'violation-added');
    expect(rows).toHaveLength(1);
    expect(rows[0].pairs).toEqual([{ from: order.key, fromName: 'Order', to: db.key, toName: 'Db', call: { label: 'save', callSite: at('src/domain/Order.ts', 5) } }]);
  });

  it('FR-29.5 a removed edge opens a flow that still exists on the branch, at that flow\'s own call; else the removed entry point\'s flow', () => {
    const create = (line: number) => rel(svc.key, db.key, { label: '«create»', calls: [{ messageId: '', label: 'new Db()', callSite: at('src/application/orders/OrderService.ts', line) }] });
    // both flows only construct the Db; the one still on the branch comes second
    const was = { scans: [scan(remove, [ctrl, svc, db], [rel(ctrl.key, svc.key), create(3)]), scan(show, [ctrl, svc, db], [rel(ctrl.key, svc.key), create(7)])], entryPoints: [show, remove] };
    const rows = diffStructure(was, base);
    expect(summary(rows)).toEqual(['edge-removed Application → Infrastructure [layer]', 'entry-removed DELETE /orders/:id']);
    expect(rows[0]).toMatchObject({ entryPoint: show, pairs: [{ call: { label: 'new Db()', callSite: at('src/application/orders/OrderService.ts', 7) } }] });
    // only the removed route reached it
    const only = { scans: [base.scans[0], scan(remove, [ctrl, svc, db], [rel(ctrl.key, svc.key), create(3)])], entryPoints: [show, remove] };
    expect(diffStructure(only, base)[0]).toMatchObject({ kind: 'edge-removed', entryPoint: remove });
  });

  it('FR-29.2 / 28.7 / 28.8 a row names three class pairs (or classes) and counts the rest', () => {
    const cache = cls('src/infrastructure/Cache.ts#Cache', 'Infrastructure');
    const queue = cls('src/infrastructure/Queue.ts#Queue', 'Infrastructure');
    const branch = {
      scans: [
        scan(show, [ctrl, svc, billing, audit, db, repo, cache, queue], [
          rel(ctrl.key, svc.key),
          rel(svc.key, db.key),
          rel(billing.key, db.key),
          rel(audit.key, repo.key),
          rel(svc.key, repo.key),
          rel(db.key, svc.key),
        ]),
      ],
      entryPoints: [show],
    };
    const io = new Map([db, repo, cache, queue].map((c) => [c.key, [{ kind: 'db' as const, client: 'Npgsql' }]]));
    const rows = diffStructure({ ...base, io: new Map() }, { ...branch, io });
    const row = (kind: string, title: string) => rows.find((r) => r.kind === kind && r.title === title)!;
    expect(row('edge-added', 'Application → Infrastructure').detail).toBe('OrderService → Db, InvoiceService → Db, Audit → OrderRepo +1');
    expect(row('cycle-added', 'Cycle: Application → Infrastructure → Application').detail).toBe('OrderService → Db, InvoiceService → Db, Audit → OrderRepo +2');
    expect(row('io-added', 'Infrastructure: DB')).toMatchObject({ detail: 'Cache, Db, OrderRepo +1', classKeys: [db.key, repo.key, cache.key, queue.key] });
  });

  it('FR-29.7 a class with two clients of one kind is named once in the layer\'s new I/O kind', () => {
    const branch = { scans: [scan(show, [ctrl, svc, db], [rel(ctrl.key, svc.key), rel(svc.key, db.key)])], entryPoints: [show] };
    const io = new Map([[db.key, [{ kind: 'db' as const, client: 'Npgsql' }, { kind: 'db' as const, client: 'StackExchange.Redis' }]]]);
    const rows = diffStructure({ ...base, io: new Map() }, { ...branch, io });
    expect(rows.find((r) => r.kind === 'io-added')).toMatchObject({ title: 'Infrastructure: DB', detail: 'Db', classKeys: [db.key] });
  });

  it('FR-29.11 a class that gained its first role or lost its only one; no reason given, no detail', () => {
    const withRoles = (stereotypes: string[]) => ({ scans: [scan(show, [ctrl, { ...svc, stereotypes }], [rel(ctrl.key, svc.key)])], entryPoints: [show] });
    const gained = diffStructure(withRoles([]), withRoles(['repository']));
    expect(summary(gained)).toEqual(['role-changed OrderService: no role → «repository» [layer]']);
    expect(gained[0]).not.toHaveProperty('detail');
    const lost = diffStructure(withRoles(['service']), withRoles([]));
    expect(summary(lost)).toEqual(['role-changed OrderService: «service» → no role [layer]']);
    expect(lost[0]).not.toHaveProperty('detail');
  });

  it('FR-29.3 a new module-level entry point is named by its function', () => {
    const handler: EntryPoint = { kind: 'http', label: 'POST /hooks', method: { key: 'src/hooks.ts#handler', name: 'handler', owner: { key: 'src/hooks.ts', name: 'hooks', kind: 'module' } } as EntryPoint['method'] };
    const rows = diffStructure(base, { ...base, entryPoints: [show, handler] });
    expect(rows).toEqual([{ kind: 'entry-added', title: 'POST /hooks', detail: 'handler', entryPoint: handler }]);
  });
});

describe('FR-29.8 naming a cycle', () => {
  const layers = (names: string[]) => new Map(names.map((n) => [n, cls(`src/${n.toLowerCase()}/${n}.ts#${n}`, n)]));
  const cycleTitle = (names: string[], edges: [string, string][]) => {
    const c = layers(names);
    const branch = { scans: [scan(show, [...c.values()], edges.map(([f, t]) => rel(c.get(f)!.key, c.get(t)!.key)))], entryPoints: [show] };
    return diffStructure({ scans: [], entryPoints: [show] }, branch).filter((r) => r.kind === 'cycle-added').map((r) => r.title);
  };

  it('FR-29.8 without a cycle through every layer, the shortest way back to the first one (breadth first, the first way found)', () => {
    expect(cycleTitle(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['D', 'A']])).toEqual(['Cycle: A → B → D → A (+ C)']);
  });

  it('FR-29.8 a tangle of many layers is named quickly: the search for a cycle through all of them gives up, the shortest cycle is named', () => {
    const many = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const edges: [string, string][] = [['A', 'B'], ['A', 'C'], ['B', 'A'], ...many.map((m) => ['B', m] as [string, string]), ...many.map((m) => [m, 'B'] as [string, string])];
    for (const f of many) for (const t of many) if (f !== t) edges.push([f, t]);
    // a cycle through all ten exists (A → C → … → J → B → A), but only after > 100 000 steps of the search
    expect(cycleTitle(['A', 'B', ...many], edges)).toEqual(['Cycle: A → B → A (+ C, D, E, F, G, H, I, J)']);
  });
});
