import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { call, cls, fakeSession, meth, type World } from './fake-world';

// FR-16 / FR-19.9 / FR-26 the project-wide scans of a session (entry points, design issues, codebase map) against an
// adapter answering from tables: lists that fail, change or vanish between two requests.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const svc = cls('src/Core/Orders.cs', 'Orders');
const repo = cls('src/Infra/Repo.cs', 'Repo');
const get = meth(ctl, 'Get');
const post = meth(ctl, 'Post');
const place = meth(svc, 'Place');
const save = meth(repo, 'Save');
const ep = (label: string, method = get): EntryPoint => ({ kind: 'http', label, method });
const world = (entryPoints: EntryPoint[], extra: Partial<World> = {}): World => ({
  methods: [get, post, place, save],
  calls: { [get.key]: [call(0, place)], [post.key]: [call(0, save)] },
  entryPoints,
  ...extra,
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('FR-16.1 the entry-point list', () => {
  it('FR-16.1 an adapter that finds no entry points lists none', async () => {
    expect(await fakeSession({ methods: [get] }).getEntryPoints()).toEqual([]);
  });

  it('FR-16.1 a failed scan is not kept: the next request scans again; a diagram opened meanwhile has no entry-point tag', async () => {
    let fail = true;
    const s = fakeSession(world([], { adapter: { getEntryPoints: async () => (fail ? Promise.reject(new Error('sidecar gone')) : [ep('GET /shop')]) } }));
    await expect(s.getEntryPoints()).rejects.toThrow('sidecar gone');
    const d = (await s.openMethodByKey(get.key))!;
    // the background step after opening asks for the list to tag the root: the failure leaves the diagram as it is
    await expect(s.scanSideEffects()).resolves.toBeUndefined();
    expect([d.root.key, s.current()!.entryPoints]).toEqual([get.key, undefined]);
    fail = false;
    expect((await s.getEntryPoints()).map((e) => e.label)).toEqual(['GET /shop']);
  });

  it('FR-16.8 a classifier without a project root: the projects under the adapter\'s root name the entry points', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-projects-')).replace(/\\/g, '/');
    dirs.push(root);
    for (const [dir, name] of [['shop', 'shop-api'], ['admin', 'admin-api']]) {
      fs.mkdirSync(`${root}/${dir}`);
      fs.writeFileSync(`${root}/${dir}/package.json`, JSON.stringify({ name }));
    }
    const a = meth(cls('shop/api.ts', 'Api'), 'list');
    const b = meth(cls('admin/api.ts', 'Api'), 'list');
    const base = new DefaultClassifier('/nowhere', {});
    // a host's classifier with only the required members
    const classifier: Classifier = { classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => [], reloadConfig: () => undefined };
    const s = fakeSession({ methods: [a, b], entryPoints: [ep('GET /items', a), ep('GET /users', b)], adapter: { projectRoot: root } }, { classifier });
    expect((await s.getEntryPoints()).map((e) => `${e.label} ${e.project}`)).toEqual(['GET /items shop-api', 'GET /users admin-api']);
  });
});

describe('FR-19.9 / FR-26 the project scans', () => {
  it('FR-19.9 the scan counts the entry points it covered (tests not) and the flows that hit the expand limit', async () => {
    // Post makes 30 calls of a method making 30 calls: more than one flow may expand (500 messages)
    const wide = meth(repo, 'Wide');
    const leaf = meth(repo, 'Leaf');
    const s = fakeSession(
      world([ep('GET /shop'), ep('POST /shop', post), { kind: 'test', label: 'ShopTest.Get', method: get }], {
        methods: [get, post, place, save, wide, leaf],
        calls: {
          [get.key]: [call(0, place)],
          [post.key]: Array.from({ length: 30 }, (_, i) => call(i, wide)),
          [wide.key]: Array.from({ length: 30 }, (_, i) => call(i, leaf)),
        },
      }),
    );
    expect([s.projectEntryPointCount, s.projectTruncatedCount]).toEqual([0, 0]);
    expect(await s.findProjectIssues()).toEqual([]);
    expect([s.projectEntryPointCount, s.projectTruncatedCount]).toEqual([2, 1]);
  });

  it('FR-26.4 an entry point that no longer exists: its flow leaves the map at the next request', async () => {
    let eps = [ep('GET /shop'), ep('POST /shop', post)];
    const s = fakeSession(world([], { adapter: { getEntryPoints: async () => eps } }));
    // the top level: one package per folder
    const classes = async () => (await s.getAppMap())!.diagram.classes.map((c) => c.name).sort();
    expect(await classes()).toEqual(['Api', 'Core', 'Infra']);
    eps = [ep('GET /shop')];
    // a saved file no flow reached: the scans stay, the list is read again
    await s.refresh(['/p/src/Other.cs']);
    expect(await classes()).toEqual(['Api', 'Core']);
    expect((await s.getAppMap())!.rescanned).toBe(0);
    // back again: its old scan was dropped, it is scanned anew
    eps = [ep('GET /shop'), ep('POST /shop', post)];
    await s.refresh(['/p/src/Other.cs']);
    expect((await s.getAppMap())!.rescanned).toBe(1);
  });

  it('FR-26.1 a map of a project without entry points: nothing scanned, made now', async () => {
    const before = Date.now();
    const level = (await fakeSession(world([])).getAppMap())!;
    expect([level.entryPoints, level.classes, level.rescanned]).toEqual([0, 0, 0]);
    expect(Date.parse(level.computedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(level.computedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('FR-26.8 the same selection asked twice: no new scan, the same map', async () => {
    const s = fakeSession(world([ep('GET /shop'), ep('POST /shop', post)]));
    const only = ['http|GET /shop|' + get.key];
    const first = (await s.getAppMap('', { entryPoints: only }))!;
    const again = (await s.getAppMap('', { entryPoints: only }))!;
    expect(again.rescanned).toBe(0);
    expect(again.diagram).toEqual(first.diagram);
    expect(first.entryPoints).toBe(1);
  });
});
