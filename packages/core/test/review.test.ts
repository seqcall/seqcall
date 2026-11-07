import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { hunkAround, parseHunks, parseUnifiedDiff } from '../src/review/git-changes';
import { alignCalls, diffFlow, mergeRemoved } from '../src/review/flow-diff';
import { reviewBranch } from '../src/review/review';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-review-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();

beforeAll(() => {
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/infrastructure/db.ts', `export class Db {\n  save(x: string) { return x; }\n}\n`);
  write('src/domain/order.ts', `export class Order {\n  total() {\n    return 1;\n  }\n  legacy() {\n    return 2;\n  }\n}\n`);
  write('src/application/audit.ts', `export class Audit {\n  log(what: string) {\n    return what;\n  }\n}\n`);
  write('src/application/order-service.ts', `import { Order } from '../domain/order';\nimport { Audit } from './audit';\nexport class OrderService {\n  place() {\n    new Audit().log('place');\n    return new Order().total();\n  }\n}\n`);
  write('src/presentation/orders.controller.ts', `import { Controller, Get } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id') show() { return new OrderService().place(); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/total');
  // the branch: the Domain total() now saves through Infrastructure (a layer violation on a changed line),
  // a new helper nobody calls yet, and a new untracked file
  // …and no longer audits the order (a removed call)
  write('src/application/order-service.ts', `import { Order } from '../domain/order';\nexport class OrderService {\n  place() {\n    return new Order().total();\n  }\n}\n`);
  // …drops legacy() and keeps a Db (a new field)
  write('src/domain/order.ts', `import { Db } from '../infrastructure/db';\nexport class Order {\n  total() {\n    new Db().save('total');\n    return 1;\n  }\n  discount() {\n    return 0;\n  }\n  private db: Db;\n}\n`);
  git('commit', '-q', '-am', 'feature');
  write('src/domain/money.ts', `export function round(x: number) {\n  return Math.round(x);\n}\n`);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Review of a branch (FR-24)', () => {
  it('FR-24.1 unified diff: added / changed lines of the new version, deletions, renames, the project folder only', () => {
    const diff = [
      'diff --git a/app/src/A.ts b/app/src/A.ts',
      'index 1..2 100644',
      '--- a/app/src/A.ts',
      '+++ b/app/src/A.ts',
      '@@ -3,0 +4,2 @@ class A {',
      '+  x();',
      '+  y();',
      '@@ -10,2 +12 @@',
      '-  old();',
      '-  older();',
      '+  newer();',
      '@@ -20 +21,0 @@',
      '-  gone();',
      'diff --git a/app/src/B.ts b/app/src/C.ts',
      'similarity index 90%',
      'rename from app/src/B.ts',
      'rename to app/src/C.ts',
      'diff --git a/other/X.ts b/other/X.ts',
      'new file mode 100644',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const files = parseUnifiedDiff(diff, 'app/');
    expect(files.map((f) => [f.file, f.status, [...f.added], f.removedAt, f.addedCount, f.removedCount])).toEqual([
      ['src/A.ts', 'modified', [4, 5, 12], [12, 21], 3, 3],
      ['src/C.ts', 'renamed', [], [], 0, 0],
    ]);
    expect(files[1].from).toBe('src/B.ts');
  });

  it('FR-24.2 changed methods, the entry points reaching them, issues on changed lines, untracked files; the diff marks', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    const phases: string[] = [];
    const r = (await s.reviewChanges({ onProgress: (p) => phases.push(p) }))!;
    expect(r).toMatchObject({ base: 'develop', resolvedBase: 'develop', branch: 'feature/total' });
    expect(r.files.map((f) => [f.file, f.status]).sort()).toEqual([
      ['src/application/order-service.ts', 'modified'],
      ['src/domain/money.ts', 'added'],
      ['src/domain/order.ts', 'modified'],
    ]);
    const m = (name: string) => r.methods.find((x) => x.method.name === name)!;
    expect(m('total')).toMatchObject({ status: 'changed' });
    expect(m('discount')).toMatchObject({ status: 'added', reachedFrom: [] });
    expect(m('round')).toMatchObject({ status: 'added' });
    // total() is reached from GET /orders/:id, with the path to open
    expect(m('total').reachedFrom.map((x) => x.entryPoint.label)).toEqual(['GET /orders/:id']);
    expect(m('total').reachedFrom[0].steps.map((x) => x.methodKey.replace(/^.*#/, ''))).toEqual(['OrdersController.show', 'OrderService.place', 'Order.total']);
    // the new Domain → Infrastructure call is an issue on a changed line, found in that endpoint's flow
    const v = r.issues.find((i) => i.finding.kind === 'layer-violation')!;
    expect(v).toMatchObject({ where: 'changed-lines', at: { file: 'src/domain/order.ts', line: 4 }, entryPoint: { label: 'GET /orders/:id' } });
    expect(v.finding.title).toBe('Layer violation: Order → Db');
    expect(phases).toContain('Walking the callers up to the entry points');
    // the diagram marks the changes from now on
    const opened = (await s.openPath(m('total').reachedFrom[0].steps))!;
    const total = opened.diagram!.messages.find((x) => x.methodName === 'total')!;
    expect(total.diff).toEqual({ method: 'changed', count: 1, positions: [{ n: 2, method: true }] }); // FR-24.15 the 2nd change of the flow (place() changed first), a method change
    await s.expand(total.id);
    const save = s.current()!.messages.find((x) => x.methodName === 'save')!;
    expect(save.diff).toMatchObject({ call: true });
    // ending the review removes them
    const after = (await s.endReview())!;
    expect(after.messages.some((x) => x.diff)).toBe(false);
  });

  it('FR-24.1 called on its own, the review reads the changes from git (against develop by default)', async () => {
    const r = (await reviewBranch({
      root,
      adapter: createTsAdapter(root),
      entryPoints: async () => [],
      paths: async () => undefined,
      scan: async () => ({}),
      isTest: () => false,
    }))!;
    expect(r.result.base).toBe('develop');
    expect(r.result.methods.map((x) => `${x.method.owner.name}.${x.method.name} ${x.status}`).sort()).toEqual(['Order.discount added', 'Order.total changed', 'OrderService.place changed', 'money.round added']);
  });

  it('FR-24.6 compared with the base version: the added call and its new participant, the removed call as a ghost', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const phases: string[] = [];
    await s.reviewChanges({ onProgress: (p) => phases.push(p) });
    expect(phases).toContain('Loading the base version');
    await s.openMethodByKey('src/presentation/orders.controller.ts#OrdersController.show');
    const d = (await s.expandEverything())!;
    const msg = (name: string) => d.messages.find((m) => m.methodName === name)!;
    const part = (name: string) => d.participants.find((p) => p.className === name)!;
    // the branch's new call (and Db, reached only by it), the audit it dropped as a ghost
    expect(msg('save').diff).toMatchObject({ call: true, status: 'added' });
    expect(part('Db').diff).toBe('added');
    expect(msg('log')).toMatchObject({ diff: { status: 'removed' }, expandable: false, parentId: msg('place').id });
    expect(msg('log').id).toMatch(/\/~\d+:log$/);
    expect(d.participants.find((p) => p.id === msg('log').to)).toMatchObject({ className: 'Audit', diff: 'removed' });
    // in the base order: the ghost before total()
    expect(d.messages.filter((m) => m.parentId === msg('place').id).map((m) => [m.methodName, m.diff?.status ?? ''])).toEqual([
      ['constructor', 'removed'],
      ['log', 'removed'],
      ['constructor', ''],
      ['total', ''],
    ]);
    // unchanged calls carry no status
    expect(msg('place').diff?.status).toBeUndefined();
    // FR-24.7 the diff lines around the calls, and the side-by-side diff (a removed call: where it was)
    expect(msg('log').diff!.hunk!.find((l) => l.at)).toEqual({ kind: '-', text: "    new Audit().log('place');", at: true });
    expect(msg('save').diff!.hunk!.find((l) => l.at)).toEqual({ kind: '+', text: "    new Db().save('total');", at: true });
    const gone = (await s.diffTarget(msg('log').id))!;
    expect(gone).toMatchObject({ file: `${root}/src/application/order-service.ts`, line: 3, title: 'order-service.ts (develop ↔ feature/total)' });
    expect(gone.baseText).toContain("new Audit().log('place');");
    expect(await s.diffTarget(msg('save').id)).toMatchObject({ file: `${root}/src/domain/order.ts`, line: 3 });
    // a call whose method changed (the call itself did not): the method's file, at its declaration
    expect(await s.diffTarget(msg('total').id)).toMatchObject({ file: `${root}/src/domain/order.ts` });
    // the class diagram: Db only today, Audit only in the base flow; their relations likewise
    const cd = (await s.getClassDiagram())!;
    const cls = (name: string) => cd.classes.find((c) => c.name === name)!;
    expect([cls('Db').diff, cls('Audit').diff, cls('Order').diff]).toEqual(['added', 'removed', undefined]);
    const rel = (from: string, to: string) => cd.relations.filter((r) => r.from === cls(from).key && r.to === cls(to).key && r.kind === 'dependency').map((r) => r.diff);
    // (a «create» and a call dependency each)
    expect(new Set(rel('OrderService', 'Audit'))).toEqual(new Set(['removed']));
    expect(new Set(rel('Order', 'Db'))).toEqual(new Set(['added']));
    expect(new Set(rel('OrderService', 'Order'))).toEqual(new Set([undefined]));
    // ending the review removes the ghosts too
    const after = (await s.endReview())!;
    expect(after.messages.some((m) => m.methodName === 'log' || m.diff)).toBe(false);
    await s.dispose();
  });

  it('FR-24.6 calls aligned by what they call (longest common subsequence); removed calls placed after their anchor', () => {
    expect(alignCalls(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'y'])).toEqual([[0, 0], [2, 2], [3, 3]]);
    expect(alignCalls([], ['a'])).toEqual([]);
    const m = (id: string, depth: number, parentId: string | null) => ({ id, depth, parentId }) as never;
    const msgs = [m('root', 0, null), m('root/0:a', 1, 'root'), m('root/0:a/0:x', 2, 'root/0:a'), m('root/1:b', 1, 'root')];
    const ghost = (id: string) => ({ id, depth: 1, parentId: 'root', diff: { status: 'removed' } }) as never;
    const merged = mergeRemoved(msgs, [
      { message: ghost('root/~0:g0'), parentId: 'root', anchor: null },
      { message: ghost('root/~2:g2'), parentId: 'root', anchor: 'root/0:a' },
    ]);
    expect(merged.map((x: { id: string }) => x.id)).toEqual(['root', 'root/~0:g0', 'root/0:a', 'root/0:a/0:x', 'root/~2:g2', 'root/1:b']);
  });

  it('FR-24.6 the same call reaching another method (a new implementation, a changed signature) is changed, not removed + added', async () => {
    const msg = (id: string, parentId: string | null, methodName: string, methodKey: string, expanded = false) => ({ id, parentId, depth: parentId ? 1 : 0, kind: 'call', from: 'a', to: 'b', methodName, methodKey, args: [], isAsync: false, isLibrary: false, expandable: expanded, expanded, recursive: false }) as never;
    const build = (messages: unknown[]) => ({ messages, participants: [], groups: [], nodes: new Map(), participantMeta: new Map(), hiddenFilters: [], fragments: [], exits: [] }) as never;
    const current = build([msg('root', null, 'run', 'R', true), msg('root/0:join', 'root', 'join', 'IClient.join'), msg('root/1:save', 'root', 'save', 'Db.save')]);
    const base = build([msg('root', null, 'run', 'R', true), msg('root/0:log', 'root', 'log', 'Audit.log'), msg('root/1:join', 'root', 'join', 'MapsClient.join'), msg('root/2:save', 'root', 'save', 'Db.save')]);
    const d = (await diffFlow({ current, choices: new Map(), buildBase: async () => base }))!;
    expect([...d.added]).toEqual([]);
    expect([...d.retargeted]).toEqual([['root/0:join', 'join']]);
    expect(d.removed.map((r) => [r.message.methodName, r.anchor])).toEqual([['log', null]]);
  });

  it('FR-24.15 two calls, not one changed call: today\'s lines all new while the base call\'s lines are still there (it moved)', async () => {
    const msg = (id: string, parentId: string | null, methodName: string, methodKey: string, expanded = false) => ({ id, parentId, depth: id.split('/').length - 1, from: 'a', to: 'b', kind: parentId ? 'call' : 'found', methodName, methodKey, expandable: true, expanded }) as never;
    const build = (messages: never[]) => ({ messages, participants: [], groups: [], participantMeta: new Map(), nodes: new Map(), fragments: [], exits: [], hiddenFilters: [] }) as never;
    const current = build([msg('root', null, 'run', 'R', true), msg('root/0:constructor', 'root', 'constructor', 'Details.ctor')]);
    const base = build([msg('root', null, 'run', 'R', true), msg('root/0:constructor', 'root', 'constructor', 'Details.ctor')]);
    const paired = (await diffFlow({ current, choices: new Map(), buildBase: async () => base }))!;
    expect([...paired.added]).toEqual([]);
    const split = (await diffFlow({ current, choices: new Map(), buildBase: async () => base, sameCall: () => false }))!;
    expect([...split.added]).toEqual(['root/0:constructor']);
    expect(split.removed.map((r) => r.message.methodName)).toEqual(['constructor']);
  });

  it('FR-24.7 hunks with context: the lines around a new line, or around a removed (old) line with where it was', () => {
    const hunks = parseHunks(['diff --git a/app/A.ts b/app/A.ts', '@@ -1,4 +1,4 @@', ' one', '-two', '+TWO', ' three', ' four'].join('\n'), 'app/').get('A.ts')!;
    expect(hunkAround(hunks, 2, 'new', 1)).toEqual({ lines: [{ kind: ' ', text: 'one' }, { kind: '-', text: 'two' }, { kind: '+', text: 'TWO', at: true }, { kind: ' ', text: 'three' }], newLine: 2 });
    expect(hunkAround(hunks, 2, 'old', 1)!.lines.find((l) => l.at)).toEqual({ kind: '-', text: 'two', at: true });
    expect(hunkAround(hunks, 9, 'new')).toBeUndefined();
    // a guard added above a call belongs to its change: the whole run of changed lines, one context line around
    const guard = parseHunks(
      ['diff --git a/S.cs b/S.cs', '@@ -1,5 +1,10 @@', ' {', '     var client = Router(id);', ' ', '-    var x = client.Get();', '+    if (client is not IGold gold)', '+    {', '+        return;', '+    }', '+', '+    var x = gold.Get();', '     return x;', ' }'].join('\n'),
    ).get('S.cs')!;
    const around = hunkAround(guard, 9, 'new')!;
    expect(around.lines.map((l) => `${l.kind}${l.text.trim()}${l.at ? ' ←' : ''}`)).toEqual(['', '-var x = client.Get();', '+if (client is not IGold gold)', '+{', '+return;', '+}', '+', '+var x = gold.Get(); ←', ' return x;'].map((x) => (x === '' ? ' ' : x)));
    // a long run is cut to `max` lines, the line kept
    const long = parseHunks(['diff --git a/L.ts b/L.ts', '@@ -1,1 +1,40 @@', ...Array.from({ length: 40 }, (_, k) => `+line ${k + 1}`)].join('\n')).get('L.ts')!;
    const cut = hunkAround(long, 30, 'new')!;
    expect(cut.lines).toHaveLength(16);
    expect(cut.lines.find((l) => l.at)!.text).toBe('line 30');
  });

  it('FR-24.9 / FR-24.10 a collapsed call counts the changed methods below it; revealing expands down to the first; a tour flow opens expanded to its changes', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    const r = (await s.reviewChanges())!;
    const d = (await s.openMethodByKey('src/presentation/orders.controller.ts#OrdersController.show'))!;
    const place = d.messages.find((m) => m.methodName === 'place')!;
    expect(place.expanded).toBe(false);
    // FR-24.15 counted in changes, the unit of the review bar: total() changed, and its two new calls `new Db().save()`
    expect(place.diff?.inside).toBe(3);
    expect(place.diff?.count).toBe(4); // its own change too
    expect(d.reviewTotal).toBe(4);
    const revealed = (await s.revealChange(place.id))!;
    expect(revealed.diagram!.messages.find((m) => m.id === revealed.messageId)).toMatchObject({ methodName: 'total', diff: { method: 'changed' } });
    expect(revealed.diagram!.messages.find((m) => m.id === place.id)!.diff?.inside).toBeUndefined(); // expanded now
    // the tour flow of GET /orders/:id: opened from the controller, expanded to total(), the first change selected
    const total = r.methods.find((m) => m.method.name === 'total')!;
    const flow = (await s.openChangeFlow(total.reachedFrom.map((x) => x.steps), total.reachedFrom[0].entryPoint))!;
    expect(flow.diagram!.root.name).toBe('show');
    expect(flow.diagram!.messages.find((m) => m.id === flow.messageId)!.diff).toBeDefined();
    expect(flow.diagram!.messages.some((m) => m.methodName === 'total')).toBe(true);
  });

  it('FR-24.8 reviewing again without changes reuses the result; an edit, or force, computes it again', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    const first = (await s.reviewChanges())!;
    expect(first.reused).toBeUndefined();
    expect(first.computedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const phases: string[] = [];
    const again = (await s.reviewChanges({ onProgress: (p) => phases.push(p) }))!;
    expect(again).toMatchObject({ reused: true, computedAt: first.computedAt });
    expect(phases).toEqual(['Reading the changes (git)']); // no flow scanned again
    // the marks come back after End review
    await s.endReview();
    await s.reviewChanges();
    await s.openMethodByKey('src/presentation/orders.controller.ts#OrdersController.show');
    expect((await s.expandEverything())!.messages.find((m) => m.methodName === 'total')!.diff).toMatchObject({ method: 'changed' });
    expect((await s.reviewChanges({ force: true }))!.reused).toBeUndefined();
    // an edit (an untracked file changed) is a new state
    const money = path.join(root, 'src/domain/money.ts');
    const before = fs.readFileSync(money, 'utf8');
    fs.writeFileSync(money, before + 'export const ZERO = 0;\n');
    try {
      expect((await s.reviewChanges())!.reused).toBeUndefined();
    } finally {
      fs.writeFileSync(money, before);
    }
  });

  it('FR-24.11 what the branch did to each class: changed (methods added / changed / removed, fields), new; marked on objects and class rows; hidden by Show changes', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    await s.reviewChanges();
    await s.openMethodByKey('src/presentation/orders.controller.ts#OrdersController.show');
    const d = (await s.expandEverything())!;
    const order = d.participants.find((p) => p.className === 'Order' && p.change)!;
    expect(order.change!.kind).toBe('changed');
    expect(order.change!.members.map((m) => [m.kind, m.name, m.change]).sort()).toEqual([
      ['field', 'db', 'added'],
      ['method', 'discount', 'added'],
      ['method', 'legacy', 'removed'],
      ['method', 'total', 'changed'],
    ]);
    expect(order.change!.members.find((m) => m.name === 'total')!.hunk!.some((l) => l.at)).toBe(true);
    expect(d.participants.find((p) => p.className === 'Db')!.change).toBeUndefined(); // an old class, newly used: no tag
    expect(d.participants.find((p) => p.className === 'OrdersController')!.change).toBeUndefined();
    // the class diagram: the box lists the changes first
    const cd = (await s.getClassDiagram())!;
    const box = cd.classes.find((c) => c.name === 'Order')!;
    expect(box.change!.kind).toBe('changed');
    expect(box.methods.map((m) => [m.name, m.diff ?? '', !!m.field])).toEqual([
      ['total', 'changed', false],
      ['legacy', 'removed', false],
      ['db', 'added', true],
    ].concat(box.methods.slice(3).map((m) => [m.name, m.diff ?? '', !!m.field]) as never));
    // the side-by-side diff of the class, at a member
    expect(await s.classDiffTarget(box.key, 'total')).toMatchObject({ file: `${root}/src/domain/order.ts`, line: 3 });
    // View ▾ Show changes off: no review marks at all
    const off = (await s.setOption('showReviewMarks', false))!;
    expect(off.messages.some((m) => m.diff) || off.participants.some((p) => p.change || p.diff)).toBe(false);
    await s.dispose();
  });

  it('FR-24.11 a class in a file the branch added is new', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    await s.reviewChanges();
    await s.openMethodByKey('src/domain/money.ts#<module>.round');
    const d = s.current()!;
    expect(d.participants[0].change).toEqual({ kind: 'new', members: [] });
    await s.dispose();
  });

  it('FR-24.1 an unknown base says so', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    await expect(s.reviewChanges({ base: 'nope' })).rejects.toThrow('No branch, tag or commit "nope" (nor "origin/nope")');
  });
});
