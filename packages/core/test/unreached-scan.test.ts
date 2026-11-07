import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryPoint, MethodRef } from '@seqcall/protocol';
import type { FileType } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import { listSourceFiles } from '../src/project-files';
import { call, cls, fakeSession, meth } from './fake-world';
import { newSession } from './helpers';

// FR-19.23 the project's design issues also cover code no entry point reaches: before, a layer guard
// got "No design issues found in 1 entry point" while the fixture's deliberate violation sat in an unreached class.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (files: string[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-unreached-')).replace(/\\/g, '/');
  dirs.push(root);
  for (const f of files) {
    fs.mkdirSync(path.dirname(`${root}/${f}`), { recursive: true });
    fs.writeFileSync(`${root}/${f}`, '');
  }
  return root;
};

describe('FR-19.23 listSourceFiles', () => {
  it('the files with the extensions, sorted; no dependencies, build output, dot-folders or declaration files; at most max', () => {
    const root = tmp(['src/b.ts', 'src/a.ts', 'src/a.d.ts', 'src/x.cs', 'node_modules/p/i.ts', 'bin/o.ts', '.git/h.ts', 'src/.hidden.ts', 'packages/core/c.ts']);
    expect(listSourceFiles(root, new Set(['.ts']))).toEqual(['packages/core/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(listSourceFiles(root, new Set(['.ts']), 2)).toEqual(['packages/core/c.ts', 'src/a.ts']);
    expect(listSourceFiles(`${root}/missing`, new Set(['.ts']))).toEqual([]);
  });
});

describe('FR-19.23 the TS fixture: the violation in a class no entry point reaches is found', () => {
  it('listed with the method it is in, marked unreached; it opens as that method, its evidence drawn', async () => {
    const s = newSession();
    const found = (await s.findProjectIssues())!;
    const f = found.find((x) => x.finding.kind === 'layer-violation' && x.finding.title.startsWith('Layer violation: AuditEntry'))!;
    expect(f.finding.title).toBe('Layer violation: AuditEntry → Database');
    expect(f.entryPoint).toMatchObject({ label: 'AuditEntry.persist', detail: 'not reached by any entry point', unreached: true, unreachedWhy: 'no entry point reaches it: no callers' });
    expect(s.projectUnreachedCount.scanned).toBeGreaterThan(0);
    expect(s.projectUnreachedCount.skipped).toBe(0);
    const d = (await s.openFinding(f.entryPoint))!;
    expect(d.root.key).toBe(f.entryPoint.method.key);
    expect(d.entryPoints).toBeUndefined(); // no entry point's tag or steps
    for (const id of f.finding.messageIds ?? []) expect(d.messages.some((m) => m.id === id)).toBe(true);
  });

  it('a scan kept from an older list is named as the list names it now', async () => {
    const s = newSession();
    await s.findProjectIssues();
    // the kept list now puts the method in another group (as a later walk could); another file is saved
    const kept = (s as unknown as { unreachable: { methods: { method: { name: string }; framework?: string }[] } }).unreachable;
    kept.methods.find((u) => u.method.name === 'persist')!.framework = 'extends a library type';
    await s.refresh(['/nowhere/else.ts']);
    const found = (await s.findProjectIssues())!;
    const f = found.find((x) => x.finding.title === 'Layer violation: AuditEntry → Database')!;
    expect(f.entryPoint.unreachedWhy).toBe('no entry point reaches it: probably called by the framework');
  });
});

describe('FR-19.23 with an adapter answering from tables: the methods the unreachable-code list (FR-31) names', () => {
  const ctl = cls('src/Api/ShopController.cs', 'ShopController');
  const lost = cls('src/Core/Lost.cs', 'Lost');
  const port = cls('src/Core/IPort.cs', 'IPort', 'interface');
  const spec = cls('tests/LostTests.cs', 'LostTests');
  const get = meth(ctl, 'Get');
  const a = meth(lost, 'A');
  const b = meth(lost, 'B');
  const abstractOne = meth(lost, 'C', { hasBody: false });
  const ep: EntryPoint = { kind: 'http', label: 'GET /shop', method: get };
  const at = (root: string, m: MethodRef): MethodRef => ({ ...m, declaration: m.declaration && { ...m.declaration, file: `${root}/${m.owner.key.slice(0, m.owner.key.indexOf('#'))}` } });

  function session(types: (root: string) => FileType[], getTypes = { calls: 0 }, extra: MethodRef[] = []) {
    const root = tmp(['src/Api/ShopController.cs', 'src/Core/Lost.cs', 'src/Core/IPort.cs', 'tests/LostTests.cs']);
    return fakeSession(
      {
        methods: [get, a, b, meth(spec, 'Test'), ...extra].map((m) => at(root, m)),
        calls: { [a.key]: [call(0, b)] },
        entryPoints: [ep],
        adapter: {
          projectRoot: root,
          getProjectTypes: async () => {
            getTypes.calls++;
            return types(root);
          },
        },
      },
      { classifier: new DefaultClassifier(root, {}) },
    );
  }
  const all = (root: string): FileType[] => [
    { type: ctl, methods: [at(root, get)] },
    { type: lost, methods: [at(root, a), at(root, b), at(root, abstractOne)] },
    { type: port, methods: [at(root, meth(port, 'Run', { hasBody: false }))] },
    { type: spec, methods: [at(root, meth(spec, 'Test'))] },
  ];

  it('scans each listed method once (B is inside A\'s flow), not bodiless or test methods; scans cached until their file changes, the list kept across saves (marked stale)', async () => {
    const getTypes = { calls: 0 };
    const s = session(all, getTypes);
    const steps: number[] = [];
    const early: number[] = [];
    await s.findProjectIssues({ onProgress: (done, total) => steps.push(done * 100 + total), onEntryPointsDone: (f) => early.push(f.length) });
    expect(s.projectUnreachedCount).toEqual({ scanned: 1, skipped: 0 }); // A (B was reached by it)
    expect(steps).toEqual([101, 203]); // the entry point, then A of the 2 listed (A, then B: only unreached code calls it)
    expect(early).toEqual([0]); // the entry point's findings before the list is walked
    expect(getTypes.calls).toBe(1);
    // a change elsewhere: the scan of A and the list are kept; the list says it is older than the code
    await s.refresh(['/x/src/Api/ShopController.cs']);
    steps.length = 0;
    await s.findProjectIssues({ onProgress: (done, total) => steps.push(done * 100 + total) });
    expect(steps).toEqual([101]);
    expect(getTypes.calls).toBe(1);
    expect(s.projectUnreachedCount).toEqual({ scanned: 1, skipped: 0, stale: true });
    // A's file changed: A is scanned again (from the kept list)
    await s.refresh(['/x/src/Core/Lost.cs']);
    steps.length = 0;
    await s.findProjectIssues({ onProgress: (done, total) => steps.push(done * 100 + total) });
    expect(steps).toEqual([101, 203]);
    // ↻ walks again: no longer stale
    await s.findProjectIssues({ rescan: true });
    expect(getTypes.calls).toBe(2);
    expect(s.projectUnreachedCount).toEqual({ scanned: 1, skipped: 0 });
  });

  it('a listed method gone since the list was made is skipped; a row carries the list\'s group', async () => {
    const s = session(all);
    await s.findUnreachableCode();
    // A disappears from the code (the kept list still names it): nothing to scan; B, which only A called, is scanned itself
    const adapter = (s as unknown as { adapter: { getMethod(k: string): Promise<MethodRef | undefined> } }).adapter;
    const getMethod = adapter.getMethod.bind(adapter);
    adapter.getMethod = async (k) => (k === a.key ? undefined : getMethod(k));
    await s.refresh(['/x/src/Core/Lost.cs']);
    await s.findProjectIssues();
    expect(s.projectUnreachedCount).toEqual({ scanned: 1, skipped: 0, stale: true });
    const scans = (s as unknown as { unreachedScans: Map<string, { entry: EntryPoint }> }).unreachedScans;
    expect([...scans.values()].map((x) => [x.entry.label, x.entry.unreachedWhy])).toEqual([['Lost.B', 'no entry point reaches it: called only from unreached code']]);
  });

  it('then the methods the walk reaches but no flow opened (an interface call with two implementations): scanned, named so', async () => {
    const pay = cls('src/Core/IPay.cs', 'IPay', 'interface');
    const card = cls('src/Infra/Card.cs', 'Card');
    const cash = cls('src/Infra/Cash.cs', 'Cash');
    const charge = meth(pay, 'Charge', { hasBody: false });
    const byCard = meth(card, 'Charge');
    const byCash = meth(cash, 'Charge');
    const root = tmp(['src/Api/ShopController.cs', 'src/Core/IPay.cs', 'src/Infra/Card.cs', 'src/Infra/Cash.cs']);
    const placed = (m: MethodRef) => at(root, m);
    const types: FileType[] = [
      { type: ctl, methods: [placed(get)] },
      { type: pay, methods: [placed(charge)] },
      { type: card, methods: [placed(byCard)] },
      { type: cash, methods: [placed(byCash)] },
    ];
    const s = fakeSession(
      {
        methods: [get, charge, byCard, byCash].map(placed),
        calls: { [get.key]: [call(0, placed(charge))] },
        impls: { [charge.key]: [placed(byCard), placed(byCash)] },
        entryPoints: [ep],
        adapter: { projectRoot: root, getProjectTypes: async () => types, getFileTypes: async (file: string) => types.filter((t) => file.endsWith(t.type.key.slice(0, t.type.key.indexOf('#')))) },
      },
      { classifier: new DefaultClassifier(root, {}) },
    );
    // ∅ lists neither (the walk takes every implementation of a reached interface method)
    expect((await s.findUnreachableCode())!.methods).toEqual([]);
    await s.findProjectIssues();
    expect(s.projectUnreachedCount).toEqual({ scanned: 2, skipped: 0 });
    const scans = (s as unknown as { unreachedScans: Map<string, { entry: EntryPoint }> }).unreachedScans;
    expect([...scans.values()].map((x) => [x.entry.label, x.entry.unreachedWhy])).toEqual([
      ['Card.Charge', "not opened by any entry point's flow"],
      ['Cash.Charge', "not opened by any entry point's flow"],
    ]);
  });

  it('cancelled while the list is walked or during the unreached methods: no result', async () => {
    const s = session(all);
    let n = 0;
    expect(await s.findProjectIssues({ cancelled: () => ++n > 1 })).toBeUndefined();
    await s.findUnreachableCode();
    // the entry point (scanned before the first cancel) and the list are known: the only check is the unreached method's
    expect(await s.findProjectIssues({ cancelled: () => true })).toBeUndefined();
  });

  it('more than the limit: the rest are counted, not scanned', async () => {
    const many = Array.from({ length: 405 }, (_, i) => meth(lost, `M${i}`));
    const s = session((root) => [{ type: ctl, methods: [at(root, get)] }, { type: lost, methods: many.map((m) => at(root, m)) }], undefined, many);
    await s.findProjectIssues();
    expect(s.projectUnreachedCount).toEqual({ scanned: 400, skipped: 5 });
  });

  it('a classifier without a project root: the adapter\'s', async () => {
    const base = session(all);
    const root = (base as unknown as { adapter: { projectRoot: string } }).adapter.projectRoot;
    const s = fakeSession(
      { methods: [get, a, b].map((m) => at(root, m)), calls: { [a.key]: [call(0, b)] }, entryPoints: [ep], adapter: { projectRoot: root, getProjectTypes: async () => all(root) } },
      { classifier: Object.assign(Object.create(new DefaultClassifier('/elsewhere', {})), { projectRoot: undefined }) },
    );
    await s.findProjectIssues();
    expect(s.projectUnreachedCount.scanned).toBe(1);
  });

  it('no getProjectTypes (an older sidecar): nothing beyond the entry points', async () => {
    const s = fakeSession({ methods: [get], entryPoints: [ep] });
    await s.findProjectIssues();
    expect(s.projectUnreachedCount).toEqual({ scanned: 0, skipped: 0 });
  });
});

describe('FR-16.15 searchMethods: the project\'s methods by name', () => {
  it('every word of the query in Class.method, case-insensitive; production code before tests; a limit with the rest counted', async () => {
    const s = newSession();
    const r = await s.searchMethods('audit persist');
    expect(r.methods.map((m) => `${m.owner.name}.${m.name}`)).toEqual(['AuditEntry.persist']);
    expect(r.more).toBe(0);
    const many = await s.searchMethods('e', 3);
    expect(many.methods).toHaveLength(3);
    expect(many.more).toBeGreaterThan(0);
    expect(await s.searchMethods('   ')).toEqual({ methods: [], more: 0 });
    // after the entry points are known: their language only (the same answer here)
    await s.getEntryPoints();
    expect((await s.searchMethods('audit persist')).methods.map((m) => m.name)).toEqual(['persist']);
  });

  it('module-level functions by their name alone; tests last; a failed entry-point list: every language', async () => {
    const root = tmp(['src/a.ts', 'tests/a.test.ts']);
    const mod = cls('src/a.ts', '<module>', 'module');
    const spec = cls('tests/a.test.ts', 'ATests');
    const lib = cls('lib:x', 'X', 'external');
    const s = fakeSession(
      {
        methods: [],
        adapter: {
          projectRoot: root,
          getEntryPoints: async () => Promise.reject(new Error('gone')),
          getFileTypes: async (file: string) =>
            file.endsWith('a.test.ts') ? [{ type: spec, methods: [meth(spec, 'formatsTotal')] }] : [{ type: mod, methods: [meth(mod, 'formatTotal')] }, { type: lib, methods: [meth(lib, 'formatX')] }],
        },
      },
      { classifier: new DefaultClassifier(root, {}) },
    );
    // asked while the entry-point list is still being made (and then fails): every language
    const pending = s.getEntryPoints().catch(() => undefined);
    expect((await s.searchMethods('format')).methods.map((m) => m.name)).toEqual(['formatTotal', 'formatsTotal']);
    await pending;
    expect((await s.searchMethods('<module>')).methods).toEqual([]); // a module's name is not part of its functions'
  });
});
