import { describe, expect, it } from 'vitest';
import type { DiagramStateSnapshot } from '@seqcall/protocol';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { C, FIXTURE_ROOT, K, method, newSession } from './helpers';
import { call, cls, fakeSession, meth } from './fake-world';

// FR-25.2 / FR-25.3 sharing a diagram's state: what travels besides the calls (entry point, minimized frames, smart
// view) and opening states whose parts are not found here, on a receiver that cannot borrow a config.
const HOST = { language: 'typescript' };
const ownOnly = (base: DefaultClassifier): Classifier => ({ classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => base.layerOrder(), reloadConfig: () => undefined });

describe('FR-25.2 what a shared state carries', () => {
  async function sent() {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    // FR-3.12 Smart starts from closed: first the smart view, then the user's own changes on top of it
    await s.smartExpand();
    await s.selectImplementation('root/0:findById', C.SqlUserRepository);
    await s.expand('root/0:findById');
    await s.collapseFragment('root/0:findById#alt0@2');
    return (await s.exportState(HOST))!;
  }

  it('FR-25.2 nothing to share before a diagram is open', async () => {
    expect(await newSession().exportState(HOST)).toBeUndefined();
  });

  it('FR-25.2 the entry point it was opened from travels and is found again', async () => {
    const s = newSession();
    const entry = (await s.getEntryPoints())[0];
    await s.openMethodByKey(entry.method.key, entry);
    const snap = (await s.exportState(HOST))!;
    expect(snap.entry).toEqual({ kind: entry.kind, label: entry.label });
    const { diagram, report } = await newSession().restoreState(snap, HOST);
    expect(diagram!.entryPoints?.map((e) => e.label)).toEqual([entry.label]);
    expect(report.differences.filter((t) => !/uncommitted/.test(t))).toEqual([]);
  });

  it('FR-25.2 its minimized frames and the smart view travel and come back', async () => {
    const snap = await sent();
    expect([snap.entry, snap.collapsedFragments, snap.smart]).toEqual([undefined, ['root/0:findById#alt0@2'], true]);
    const { diagram, report } = await newSession().restoreState(snap, HOST);
    expect((diagram!.fragments ?? []).filter((f) => f.collapsed).map((f) => f.id)).toEqual(['root/0:findById#alt0@2']);
    expect(diagram!.messages.some((m) => m.importance)).toBe(true);
    expect([report.missing, report.differences.filter((t) => !/uncommitted/.test(t))]).toEqual([[], []]);
  });

  it('FR-25.2 parts not found here are reported: the entry point, a minimized frame; a remembered choice that is no class key is ignored', async () => {
    const snap = await sent();
    const changed: DiagramStateSnapshot = {
      ...snap,
      git: undefined,
      entry: { kind: 'http', label: 'GET /gone' },
      collapsedFragments: ['root/0:findById#alt0@2', 'root/0:findById#loop9@9'],
      interfaceChoices: { ...snap.interfaceChoices, [C.Notifier]: 7 as unknown as string },
    };
    const r = newSession();
    const { diagram, report } = await r.restoreState(changed, HOST);
    expect(diagram!.entryPoints ?? []).toEqual([]);
    expect(report.missing).toEqual(['minimized fragment root/0:findById#loop9@9']);
    expect(report.differences).toContain('The sender opened it from the entry point GET /gone, which is not found here.');
    // the sender had no git: no commit in the source
    expect(report.source).toMatch(/^UserService\.findUser · sample-app · \d{4}-\d\d-\d\d$/);
    expect((await r.exportState(HOST))!.interfaceChoices).toEqual(snap.interfaceChoices);
  });
});

describe('FR-25.2 a root that is several entry points', () => {
  it('FR-25.2 the one it was opened from is named first again', async () => {
    const shop = cls('src/Shop.cs', 'Shop');
    const run = meth(shop, 'Run');
    const entryPoints = [{ kind: 'http' as const, label: 'POST /orders', method: run }, { kind: 'job' as const, label: 'NightlyOrders', method: run }];
    const world = { methods: [run], entryPoints };
    const s = fakeSession(world);
    await s.getEntryPoints();
    expect((await s.openMethodByKey(run.key, entryPoints[1]))!.entryPoints!.map((e) => e.label)).toEqual(['NightlyOrders', 'POST /orders']);
    const snap = (await s.exportState({ language: 'csharp' }))!;
    const { diagram } = await fakeSession(world).restoreState(snap, { language: 'csharp' });
    expect(diagram!.entryPoints!.map((e) => e.label)).toEqual(['NightlyOrders', 'POST /orders']);
  });
});

describe('FR-25.3 the sender\'s layer config', () => {
  it('FR-25.3 the file again when nothing was borrowed, also before any diagram: nothing to do', async () => {
    const s = newSession();
    expect(await s.useSharedConfig(false)).toBeUndefined();
    expect(s.configBorrowed()).toBe(false);
  });

  it('FR-25.3 refused without an opened state, and on a project whose classifier cannot take another config (no notice of a different config then)', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await expect(s.useSharedConfig(true)).rejects.toThrow('No shared diagram with a layer config was opened.');
    const snap = (await s.exportState(HOST))!;
    snap.config = JSON.stringify({ layers: [] });
    const r = newSession({ classifier: ownOnly(new DefaultClassifier(FIXTURE_ROOT)) });
    const { report } = await r.restoreState(snap, HOST);
    expect(report.configDiffers).toBeUndefined();
    await expect(r.useSharedConfig(true)).rejects.toThrow('This project cannot use another layer config.');
  });

  it('FR-25.3 a sender without a config: borrowing it means no layers; opening another state gives the project\'s file back', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    const snap = (await s.exportState(HOST))!;
    delete snap.config;
    const r = newSession();
    await r.restoreState(snap, HOST);
    const repoLayer = (d: { participants: { className: string; layer?: string }[] } | undefined) => d!.participants.find((p) => p.className === 'UserRepository')!.layer;
    // the project's file names the ports' folder a layer; with none, nothing does
    const d = (await r.useSharedConfig(true))!;
    expect(repoLayer(d)).toBeUndefined();
    expect(r.configBorrowed()).toBe(true);
    const again = await r.restoreState({ ...snap, config: undefined }, HOST);
    expect(r.configBorrowed()).toBe(false);
    expect(repoLayer(again.diagram)).toBe('Ports');
  });
});

describe('FR-25.2 restoreSettings', () => {
  it('FR-25.2 nothing replaced: the settings stay', async () => {
    const shop = cls('src/Shop.cs', 'Shop');
    const s = fakeSession({ methods: [meth(shop, 'Run'), meth(shop, 'Step')], calls: { [`${shop.key}.Run`]: [call(0, meth(shop, 'Step'))] } }, { options: { showArguments: false } });
    await s.openMethodByKey(`${shop.key}.Run`);
    const before = s.getPersistentState();
    await s.restoreSettings();
    expect(s.getPersistentState()).toEqual(before);
  });
});
