import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { EntryOutcome, EntryPoint, EntryPointKind, HostToSequenceView, ReviewMethod, ReviewResult } from '@seqcall/protocol';
import { EntryPointsTree, type EntryPointsNode, type EntryPointsResult } from '../../src/entry-points-tree';
import { DesignIssuesTree, ReviewTree, type SidebarNode } from '../../src/sidebar-views';

// The sidebar's trees on their own (made-up lists of the shapes a large project has: several projects, long route
// lists in folders, module-level calls by file, test projects); the extension-host suite shows them in the views.

const ep = (kind: EntryPointKind, label: string, cls: string, method: string, extra: Partial<EntryPoint> = {}): EntryPoint => ({
  kind,
  label,
  method: { key: `src/${cls}.ts#${cls}.${method}`, name: method, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind: 'class' } },
  ...extra,
}) as EntryPoint;

/** 30 routes of ShopApi (folders: more than 25), a worker's module-level calls, two test projects. */
function shop(): EntryPoint[] {
  const routes = Array.from({ length: 30 }, (_, i) =>
    i < 16 ? ep('http', `GET /api/orders/${i}`, 'OrdersController', `get${i}`, { project: 'ShopApi' }) : ep('http', `GET /api/items/${i}`, 'ItemsController', `get${i}`, { project: 'ShopApi' }),
  );
  const mod = (call: string): EntryPoint => ({ kind: 'cli', label: `scripts/seed.ts: ${call}()`, file: 'scripts/seed.ts', project: 'Worker', method: { key: `scripts/seed.ts#${call}`, name: call, owner: { key: 'scripts/seed.ts', name: 'seed', kind: 'module' } } }) as EntryPoint;
  return [
    ...routes,
    mod('seedUsers'),
    mod('seedOrders'),
    ep('job', 'NightlyExport', 'ExportJob', 'run', { project: 'Worker', detail: 'cron 0 2 * * *' }),
    ep('test', 'OrderTest.creates', 'OrderTest', 'creates', { project: 'UnitTests' }),
    ep('test', 'ShopIT.lists', 'ShopIT', 'lists', { project: 'IntegrationTests' }),
  ];
}

const tree = (load: () => Promise<EntryPointsResult>) => new EntryPointsTree(load, 'test.open');

async function walk(t: EntryPointsTree, n?: EntryPointsNode): Promise<EntryPointsNode[]> {
  const kids = await t.getChildren(n);
  return (await Promise.all(kids.map(async (k) => [k, ...(await walk(t, k))]))).flat();
}

suite('Seqcall sidebar trees', () => {
  test('FR-16.10 nothing loads until asked; then "Finding entry points…" and the list when it arrives', async () => {
    let calls = 0;
    const t = tree(async () => (calls++, { entryPoints: shop(), project: 'shop' }));
    assert.deepStrictEqual(await t.getChildren(), []);
    assert.strictEqual(calls, 0);
    const changed = new Promise<void>((r) => t.onDidChangeTreeData(() => r()));
    t.request();
    await changed;
    const first = await t.getChildren();
    assert.deepStrictEqual(first, [{ type: 'note', text: 'Finding entry points…', icon: 'loading~spin' }]);
    assert.strictEqual(t.getTreeItem(first[0]).checkboxState, undefined);
    await new Promise<void>((r) => t.onDidChangeTreeData(() => r()));
    assert.deepStrictEqual((await t.getChildren()).map((n) => n.type === 'project' && n.name), ['ShopApi', 'Worker', 'Tests']);
    assert.deepStrictEqual(t.summary(), { project: 'shop', count: 35 });
    assert.strictEqual(calls, 1);
  });

  test('FR-16.8 projects first, test projects together under Tests; a project row counts its entry points by kind', async () => {
    const t = tree(async () => ({ entryPoints: shop(), project: 'shop' }));
    const [api, worker, tests] = await t.roots();
    const item = (n: EntryPointsNode) => t.getTreeItem(n);
    assert.deepStrictEqual([item(api).label, item(api).description, item(api).tooltip, (item(api).iconPath as vscode.ThemeIcon).id, item(api).id], ['ShopApi', '30', 'ShopApi: 30 http endpoints', 'project', 'project:ShopApi']);
    assert.strictEqual(item(worker).tooltip, 'Worker: 2 programs & scripts, 1 background jobs');
    assert.deepStrictEqual([item(tests).label, item(tests).tooltip, (item(tests).iconPath as vscode.ThemeIcon).id, item(tests).id], ['Tests', '2 test projects, 2 tests', 'beaker', 'project:*Tests']);
    // the test projects below Tests, each with its Tests group (collapsed)
    const testProjects = await t.getChildren(tests);
    assert.deepStrictEqual(testProjects.map((p) => p.type === 'project' && p.name), ['IntegrationTests', 'UnitTests']);
    const [group] = await t.getChildren(testProjects[0]);
    assert.deepStrictEqual([item(group).label, item(group).collapsibleState, item(group).id], ['Tests', vscode.TreeItemCollapsibleState.Collapsed, 'group:IntegrationTests:test']);
  });

  test('FR-16.4 more than 25 routes go into folders by path; a folder row names its path and count', async () => {
    const t = tree(async () => ({ entryPoints: shop(), project: 'shop' }));
    const [api] = await t.roots();
    const [http] = await t.getChildren(api);
    assert.deepStrictEqual([t.getTreeItem(http).label, t.getTreeItem(http).collapsibleState, t.getTreeItem(http).id], ['HTTP endpoints', vscode.TreeItemCollapsibleState.Expanded, 'group:ShopApi:http']);
    const folders = await t.getChildren(http);
    const shown = folders.map((f) => {
      const i = t.getTreeItem(f);
      return `${i.label} ${i.description} ${i.tooltip} ${(i.iconPath as vscode.ThemeIcon).id}`;
    });
    // every route starts with /api: that level is skipped; folders by name
    assert.deepStrictEqual(shown, ['/items 14 /api/items — 14 entry points folder', '/orders 16 /api/orders — 16 entry points folder']);
    // the routes below: label the route, description the handler, a click opens it
    const [first] = await t.getChildren(folders[1]);
    const row = t.getTreeItem(first);
    assert.deepStrictEqual([row.label, row.description, row.tooltip, row.command?.command], ['GET /api/orders/0', 'OrdersController.get0', 'GET /api/orders/0\nOrdersController.get0', 'test.open']);
    assert.deepStrictEqual(row.command?.arguments, [first.type === 'entry' && first.entryPoint]);
  });

  test('FR-16.5 module-level calls of one file under the file, each by its call; a job with its detail', async () => {
    const t = tree(async () => ({ entryPoints: shop(), project: 'shop' }));
    const [, worker] = await t.roots();
    const [cli, job] = await t.getChildren(worker);
    const [file] = await t.getChildren(cli);
    const f = t.getTreeItem(file);
    assert.deepStrictEqual([f.label, f.description, f.tooltip, (f.iconPath as vscode.ThemeIcon).id, f.id], ['seed.ts', '2 calls · scripts/seed.ts', 'scripts/seed.ts: 2 calls when the module is loaded', 'file-code', 'file:scripts/seed.ts']);
    const calls = await t.getChildren(file);
    assert.deepStrictEqual(calls.map((c) => t.getTreeItem(c).label), ['seedOrders()', 'seedUsers()']);
    assert.strictEqual(t.getTreeItem(calls[0]).description, 'seedOrders', 'a module function: its name, no class');
    const [nightly] = await t.getChildren(job);
    assert.deepStrictEqual([t.getTreeItem(nightly).label, t.getTreeItem(nightly).description], ['NightlyExport', 'ExportJob.run']);
    assert.deepStrictEqual(await t.getChildren(nightly), []);
  });

  test('FR-32.4 a row shows its flow\'s I/O once known (`+`: there may be more), in the tooltip too; none while unknown or without I/O', async () => {
    const known: Record<string, EntryOutcome> = {};
    const t = new EntryPointsTree(async () => ({ entryPoints: shop(), project: 'shop' }), 'test.open', undefined, () => known);
    const [api, worker] = await t.roots();
    const [http] = await t.getChildren(api);
    const [, orders] = await t.getChildren(http);
    const [get0] = await t.getChildren(orders);
    const [, job] = await t.getChildren(worker);
    const [nightly] = await t.getChildren(job);
    const row = (n: EntryPointsNode) => [t.getTreeItem(n).description, t.getTreeItem(n).tooltip];
    assert.deepStrictEqual([row(get0), row(nightly)], [['OrdersController.get0', 'GET /api/orders/0\nOrdersController.get0'], ['ExportJob.run', 'NightlyExport\nExportJob.run\ncron 0 2 * * *']]);
    const key = (n: EntryPointsNode) => (n.type === 'entry' ? `${n.entryPoint.kind}|${n.entryPoint.label}|${n.entryPoint.method.key}` : '');
    known[key(get0)] = { kinds: ['db', 'http'], atLeast: true };
    known[key(nightly)] = { kinds: [] };
    assert.deepStrictEqual([row(get0), row(nightly)], [
      ['OrdersController.get0  DB·HTTP+', 'GET /api/orders/0\nOrdersController.get0\nI/O of its whole flow: DB·HTTP+'],
      ['ExportJob.run', 'NightlyExport\nExportJob.run\ncron 0 2 * * *'],
    ]);
    // a label that is its method and no detail: only the I/O
    const bare = ep('cli', 'Tool.main', 'Tool', 'main');
    const b = new EntryPointsTree(async () => ({ entryPoints: [bare] }), 'test.open', undefined, () => ({ [`cli|Tool.main|${bare.method.key}`]: { kinds: ['file'] } }));
    await b.roots();
    const leaf = (await walk(b)).find((n) => n.type === 'entry')!;
    assert.strictEqual(b.getTreeItem(leaf).description, 'FILE');
  });

  test('FR-26.8 while selecting: checkboxes on projects, groups and rows; a project ticks its entry points; tests never', async () => {
    const t = tree(async () => ({ entryPoints: shop(), project: 'shop' }));
    const [api, worker, tests] = await t.roots();
    assert.strictEqual(t.getTreeItem(api).checkboxState, undefined);
    t.setSelecting(true);
    assert.strictEqual(t.getTreeItem(api).checkboxState, vscode.TreeItemCheckboxState.Unchecked);
    assert.strictEqual(t.getTreeItem(tests).checkboxState, undefined, 'tests are no map entry');
    t.setChecked(worker, true);
    t.setChecked(tests, true);
    assert.deepStrictEqual(t.selection(), ['cli|scripts/seed.ts: seedUsers()|scripts/seed.ts#seedUsers', 'cli|scripts/seed.ts: seedOrders()|scripts/seed.ts#seedOrders', 'job|NightlyExport|src/ExportJob.ts#ExportJob.run']);
    assert.strictEqual(t.getTreeItem(worker).checkboxState, vscode.TreeItemCheckboxState.Checked);
    const [cli] = await t.getChildren(worker);
    const [file] = await t.getChildren(cli);
    t.setChecked(file, false);
    assert.deepStrictEqual(t.selection(), ['job|NightlyExport|src/ExportJob.ts#ExportJob.run']);
    assert.strictEqual(t.getTreeItem(worker).checkboxState, vscode.TreeItemCheckboxState.Unchecked);
    // every node is a known kind
    assert.ok((await walk(t)).every((n) => t.getTreeItem(n).label));
  });

  test('FR-16.4 a failed load and an empty project say so; Go to Entry Point loads the list and shows it from then on', async () => {
    const failed = tree(async () => {
      throw new Error('no tsconfig.json');
    });
    const [note] = await failed.roots();
    assert.deepStrictEqual(note, { type: 'note', text: 'no tsconfig.json', tooltip: 'no tsconfig.json', icon: 'warning' });
    const item = failed.getTreeItem(note);
    assert.deepStrictEqual([item.label, item.tooltip, (item.iconPath as vscode.ThemeIcon).id], ['no tsconfig.json', 'no tsconfig.json', 'warning']);
    assert.deepStrictEqual([failed.summary(), failed.selection()], [undefined, []]);
    const empty = tree(async () => ({ entryPoints: [] }));
    assert.deepStrictEqual((await empty.roots()).map((n) => n.type === 'note' && n.text), ['No entry points found']);
    const t = tree(async () => ({ entryPoints: shop() }));
    assert.strictEqual(t.isRequested(), false);
    assert.strictEqual(((await t.entryPoints()) as { entryPoints: EntryPoint[] }).entryPoints.length, 35);
    assert.strictEqual(t.isRequested(), true);
  });

  // ───────────────────────────── Design Issues, Review ─────────────────────────────

  const itemOf = (t: DesignIssuesTree | ReviewTree, n: SidebarNode) => t.getTreeItem(n);

  test('FR-19.12 the Design Issues view says what the scan does: progress, cancelled, failed, cut flows, no entry points', () => {
    const t = new DesignIssuesTree(() => undefined);
    type Scan = Extract<HostToSequenceView, { type: 'projectFindings' }>;
    const said = (m: Omit<Scan, 'type'>) => (t.onMessage({ type: 'projectFindings', ...m }), [t.status(), t.message]);
    assert.deepStrictEqual(said({ state: 'running', project: 'shop' }), ['running', 'Scanning shop…']);
    assert.deepStrictEqual(said({ state: 'running', done: 3, total: 9 }), ['running', 'Scanning shop… 3 / 9 flows'], 'the project kept');
    assert.deepStrictEqual(t.getChildren(), []);
    assert.deepStrictEqual(said({ state: 'cancelled' }), ['cancelled', 'Scan cancelled.']);
    assert.deepStrictEqual(said({ state: 'error' }), ['error', 'The scan failed.']);
    assert.deepStrictEqual(said({ state: 'error', error: 'out of memory' }), ['error', 'out of memory']);
    assert.deepStrictEqual(said({ state: 'done', findings: [], total: 4, truncated: 2 }), ['done', 'shop · 0 issues in 4 entry points · 2 cut by the expand limit']);
    assert.deepStrictEqual(said({ state: 'done', findings: [], total: 0 }).slice(1), ['shop · 0 issues in 0 entry points']);
    // FR-19.23 the methods no entry point reaches were checked too
    assert.deepStrictEqual(said({ state: 'done', findings: [], total: 4, unreached: { scanned: 12, skipped: 0 } }).slice(1), ['shop · 0 issues in 4 entry points and 12 methods no flow opened']);
    assert.deepStrictEqual(said({ state: 'done', findings: [], total: 0 }).slice(1), ['shop · 0 issues in 0 entry points']);
    assert.deepStrictEqual(t.getChildren().map((n) => n.label), ['No entry points to scan (a library?)']);
    // a finding reached from more entry points
    const entry = ep('http', 'GET /orders', 'OrdersController', 'list');
    t.onMessage({ type: 'projectFindings', state: 'done', total: 1, findings: [{ finding: { id: 'g', kind: 'god-class', title: 'God class: Order', detail: '40 methods' }, entryPoint: entry, others: 2 }] });
    const [group] = t.getChildren();
    const [row] = t.getChildren(group);
    assert.deepStrictEqual([group.label, group.icon, itemOf(t, group).collapsibleState], ['God classes', 'symbol-class', vscode.TreeItemCollapsibleState.Expanded]);
    assert.deepStrictEqual([row.description, row.icon], ['GET /orders +2 more', 'circle-small-filled']);
    assert.strictEqual(row.tooltip, 'God class: Order\n40 methods\nFound in GET /orders (and 2 more entry points)');
    // FR-19.23 found in a method no entry point reaches: named so
    t.onMessage({ type: 'projectFindings', state: 'done', total: 1, findings: [{ finding: { id: 'v', kind: 'layer-violation', title: 'Layer violation: AuditEntry → Database' }, entryPoint: { ...ep('handler', 'AuditEntry.persist', 'AuditEntry', 'persist'), unreached: true } }] });
    assert.strictEqual(t.getChildren(t.getChildren()[0])[0].description, 'AuditEntry.persist (no entry point reaches it)');
    // FR-19.23 with its group in the unreachable-code list (FR-31), as ∅ names it
    t.onMessage({ type: 'projectFindings', state: 'done', total: 1, findings: [{ finding: { id: 'v', kind: 'layer-violation', title: 'Layer violation: AuditEntry → Database' }, entryPoint: { ...ep('handler', 'AuditEntry.persist', 'AuditEntry', 'persist'), unreached: true, unreachedWhy: 'no entry point reaches it: no callers' } }] });
    assert.strictEqual(t.getChildren(t.getChildren()[0])[0].description, 'AuditEntry.persist (no entry point reaches it: no callers)');
    // FR-7.16 resting on a guessed layer: named possible, the guess on hover
    const guess = '`Database` is Infrastructure by a guess: role folder `Services/`';
    t.onMessage({ type: 'projectFindings', state: 'done', total: 1, findings: [{ finding: { id: 'v', kind: 'layer-violation', title: 'Layer violation: AuditEntry → Database', detail: 'Domain → Infrastructure', possible: [guess] }, entryPoint: entry }] });
    const possible = t.getChildren(t.getChildren()[0])[0];
    assert.deepStrictEqual([possible.label, possible.tooltip], ['Possible layer violation: AuditEntry → Database', `Possible layer violation: AuditEntry → Database\nDomain → Infrastructure\n${guess}\nFound in GET /orders`]);
  });

  const method = (name: string, extra: Partial<ReviewMethod> = {}): ReviewMethod => ({ method: ep('http', '', 'OrderService', name).method, status: 'changed', lines: [3, 4], reachedFrom: [], tests: 0, ...extra }) as ReviewMethod;
  const result = (r: Partial<ReviewResult>): ReviewResult => ({ base: 'develop', resolvedBase: 'develop', files: [{ file: 'a.ts', path: '/a.ts', status: 'modified', added: 1, removed: 0 }], methods: [], issues: [], scanned: 0, notScanned: 0, otherLines: 0, ...r });

  test('FR-24.14 the Review view: progress, cancelled, failed; no changes (and changes outside the project); nothing changed since', () => {
    const t = new ReviewTree(() => undefined);
    const said = (m: Omit<Extract<HostToSequenceView, { type: 'review' }>, 'type'>) => (t.onMessage({ type: 'review', ...m }), [t.status(), t.message]);
    assert.deepStrictEqual(said({ state: 'running' }), ['running', 'Reviewing…']);
    assert.deepStrictEqual(said({ state: 'running', phase: 'Scanning flows', done: 2, total: 7 }), ['running', 'Scanning flows… 2 / 7']);
    assert.deepStrictEqual(said({ state: 'cancelled' }), ['cancelled', 'Review cancelled.']);
    assert.deepStrictEqual(said({ state: 'error' }), ['error', 'The review failed.']);
    assert.deepStrictEqual(t.getChildren(), []);
    said({ state: 'done', result: result({ files: [], compare: { mode: 'split', point: 'abc', commits: 1, behind: 0, outside: ['../other/x.ts'] } }) });
    assert.deepStrictEqual(t.getChildren().map((n) => `${n.label} | ${n.description}`), ['No changes in this project | 1 outside it']);
    assert.deepStrictEqual(said({ state: 'done', result: result({ reused: true, structure: { rows: [], compared: 1, copied: 0, notCompared: 0 } }) })[1], 'HEAD vs develop · 0 changed methods · 0 issues · shape unchanged · nothing changed since');
    assert.deepStrictEqual(t.getChildren().map((n) => n.label), ['No structural change']);
    t.clear();
    assert.deepStrictEqual([t.status(), t.message, t.getChildren()], [undefined, undefined, []]);
  });

  test('FR-24.14 the Review view lists issues and methods no static caller reaches', () => {
    const t = new ReviewTree(() => undefined);
    const lonely = method('recalc', { status: 'added', tests: 2, lines: [7] });
    t.onMessage({
      type: 'review',
      state: 'done',
      result: result({
        branch: 'feature/x',
        methods: [lonely],
        issues: [
          { finding: { id: 'i1', kind: 'io-in-loop', title: 'I/O in a loop: Db.find (DB)', detail: 'per order' }, where: 'changed-lines', at: { file: 'src/order-service.ts', line: 12 }, entryPoint: ep('http', 'GET /orders', 'OrdersController', 'list') },
          { finding: { id: 'i2', kind: 'god-class', title: 'God class: Order' }, where: 'changed-class' },
        ],
      }),
    });
    assert.strictEqual(t.message, 'feature/x vs develop · 1 changed method · 2 issues');
    const [issues, unreached, ...rest] = t.getChildren();
    assert.deepStrictEqual(rest, []);
    assert.deepStrictEqual(t.getChildren(issues).map((n) => `${n.description} | ${n.icon} | ${n.tooltip}`), [
      'order-service.ts:12 · ← GET /orders | error | I/O in a loop: Db.find (DB)\nper order\nIts evidence is on a changed line.',
      'in a changed class | warning | God class: Order\nIn a class the branch changed.',
    ]);
    assert.deepStrictEqual(t.getChildren(issues)[1].action, { kind: 'intent', msg: { type: 'openReviewIssue', issue: t.result()!.issues[1] } });
    assert.deepStrictEqual([unreached.label, unreached.description], ['Changed, no static caller', '1']);
    const [row] = t.getChildren(unreached);
    assert.deepStrictEqual([row.label, row.description, row.icon, row.tooltip], ['OrderService.recalc', 'added · 1 line · 2 tests', 'diff-added', 'Open its diagram']);
    assert.deepStrictEqual(row.action, { kind: 'intent', msg: { type: 'openPath', steps: [{ methodKey: lonely.method.key }] } });
    // FR-24.2 a method past the walk limit: its own group, not "no static caller"
    const t2 = new ReviewTree(() => undefined);
    t2.onMessage({ type: 'review', state: 'done', result: result({ methods: [lonely, { ...method('refund', { status: 'added', lines: [9] }), notWalked: true }] }) });
    assert.deepStrictEqual(t2.getChildren().map((n) => `${n.label} ${n.description}`), ['Changed, no static caller 1', 'Changed, callers not walked (limit) 1']);
  });
});
