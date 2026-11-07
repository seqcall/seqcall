import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TestFileMatcher } from '../src/test-files';
import { createClassifier } from '../src/classifier-impl';
import type { CallSite } from '../src/adapter';
import { byId, file, method, newSession, participantOf, positionOf, sharedAdapter } from './helpers';

/** Functional-style code: function-typed ports, object literals, factories (fixtures: archive.ts, archive-store.ts, main.ts). */
const adapter = sharedAdapter();
const calls = async (key: string): Promise<CallSite[]> => await adapter.getOutgoingCalls(await method(key));

const F = {
  archiveAll: 'src/application/archive.ts#<module>.archiveAll',
  archiveOne: 'src/application/archive.ts#<module>.archiveOne',
  runArchive: 'src/main.ts#<module>.runArchive',
  users: 'src/application/archive.ts#ArchivePorts.users',
  store: 'src/application/archive.ts#ArchivePorts.store',
  audit: 'src/application/archive.ts#ArchivePorts.audit',
  labelFor: 'src/application/archive.ts#ArchiveRequest.labelFor',
  now: 'src/application/archive.ts#Clock.now',
  usersProduct: 'src/adapters/archive-store.ts#usersFrom.<returned>',
  fileStoreStore: 'src/adapters/archive-store.ts#fileStore.store',
  fileStoreFlush: 'src/adapters/archive-store.ts#fileStore.flush',
  portsAudit: 'src/main.ts#ports.audit',
  requestLabelFor: 'src/main.ts#runArchive.labelFor',
  exportUser: 'src/services/export-service.ts#ExportService.exportUser',
  write: 'src/services/export-service.ts#ExportService.write',
};
const O = {
  ArchivePorts: 'src/application/archive.ts#ArchivePorts',
  ArchiveRequest: 'src/application/archive.ts#ArchiveRequest',
  Clock: 'src/application/archive.ts#Clock',
  usersFrom: 'src/adapters/archive-store.ts#usersFrom',
  fileStore: 'src/adapters/archive-store.ts#fileStore',
  ExportService: 'src/services/export-service.ts#ExportService',
  ExportBatch: 'src/services/export-service.ts#ExportBatch',
  UserRepository: 'src/ports/user-repository.ts#UserRepository',
};

beforeAll(async () => {
  await adapter.getMethod(F.archiveAll); // warm up
});

describe('TsAdapter: functional code', () => {
  it('FR-1.2 calls of function-typed properties (also via a type alias) resolve to methods of the owning interface', async () => {
    const [now, users, archiveOne, summary, audit] = await calls(F.archiveAll);
    expect(users.target).toMatchObject({ key: F.users, name: 'users', hasBody: false, owner: { key: O.ArchivePorts, kind: 'interface' } });
    expect(users.receiver).toEqual({ kind: 'parameter', name: 'ports' });
    expect(audit.target?.key).toBe(F.audit);
    expect(now.target?.key).toBe(F.now); // optional call clock?.now()
    expect([archiveOne.methodName, summary.methodName]).toEqual(['archiveOne', 'summary']);
    expect((await calls(F.archiveOne)).map((c) => c.target?.key)).toEqual([F.labelFor, F.store]);
  });

  it.each([
    ['function returned by a factory', 'src/adapters/archive-store.ts', 'Logger.info(`listing', F.usersProduct, O.usersFrom, 'usersFrom'],
    ['local const function of a factory', 'src/adapters/archive-store.ts', 'Logger.info(`${dir}/${id}', F.fileStoreStore, O.fileStore, 'fileStore'],
    ['local function declaration of a factory', 'src/adapters/archive-store.ts', 'Logger.info(`flushed', F.fileStoreFlush, O.fileStore, 'fileStore'],
    ['member of a named object literal', 'src/main.ts', 'Logger.info(line)', F.portsAudit, 'src/main.ts#ports', 'ports'],
    ['member of an object literal argument', 'src/main.ts', '`user-${id}`', F.requestLabelFor, 'src/main.ts#runArchive', 'runArchive'],
  ])('FR-1.2 %s is a callable with a stable key and a synthetic owner', async (_kind, rel, needle, key, ownerKey, ownerName) => {
    const m = await adapter.findEnclosingCallable(file(rel), positionOf(rel, needle));
    expect(m?.key).toBe(key);
    expect(m).toMatchObject({ hasBody: true, isStatic: false, owner: { key: ownerKey, name: ownerName, kind: 'class' } });
    expect((await adapter.getMethod(key))?.key).toBe(key);
  });

  it('FR-1.2 synthetic owners carry class info listing their callables', async () => {
    const info = (await adapter.getClassInfo(O.fileStore))!;
    expect(info.synthetic).toBe(true);
    expect(info.methods.map((m) => m.signature)).toEqual([
      'store(id: string, label: string): Promise<void>',
      'flush(): void',
    ]);
    expect((await adapter.getClassInfo(O.ArchivePorts))?.methods.map((m) => m.name)).toEqual(['users', 'store', 'audit']);
    expect((await adapter.getClassInfo(O.ArchivePorts))?.synthetic).toBeUndefined();
  });

  it('FR-8.2 implementations of function-typed interface members are found in contextually typed object literals', async () => {
    const impls = async (key: string) => (await adapter.getImplementations(await method(key))).map((i) => i.key);
    expect(await impls(F.users)).toEqual([F.usersProduct]); // factory call → the function it returns
    expect(await impls(F.store)).toEqual([F.fileStoreStore]); // files.store → FileStore.store → shorthand → local const
    expect(await impls(F.audit)).toEqual([F.portsAudit]); // inline arrow
    expect(await impls(F.labelFor)).toEqual([F.requestLabelFor]);
    expect(await impls(F.now)).toEqual([]);
    // a defaulted destructured option is no implementation (and not the enclosing factory)
    expect(await impls('src/adapters/archive-store.ts#StoreOptions.log')).toEqual([]);
    expect((await adapter.getImplementations(await method(F.users)))[0]).toMatchObject({ hasBody: true, owner: { name: 'usersFrom' } });
  });

  it('FR-6.5 call sites report argument origins and the variable a created object is assigned to', async () => {
    const [create, write] = await calls(F.exportUser);
    expect(create.assignedTo).toEqual({ kind: 'local', name: 'batch' });
    expect(write.argOrigins).toEqual([{ kind: 'field', name: 'repo' }, { kind: 'parameter', name: 'id' }, { kind: 'local', name: 'batch' }]);
    expect((await calls(F.write)).find((c) => c.methodName === 'logExport')?.argOrigins).toEqual([{ kind: 'self' }, { kind: 'parameter', name: 'id' }]);
    expect(await adapter.getParameterNames?.(await method(F.write))).toEqual(['source', 'id', 'into']);
  });

  it('FR-9.2 argument texts have comments stripped and whitespace collapsed', async () => {
    const archive = (await calls(F.runArchive)).find((c) => c.methodName === 'archiveAll')!;
    expect(archive.args).toEqual(["{ options: { dryRun: false, tag: 'archive' }, labelFor: (id) => `user-${id}`, }", 'ports']);
  });
});

describe('Test code (FR-8, FR-4.1)', () => {
  it('FR-8.2 fakes in test files are not implementations, so the single production one is still auto-selected (FR-8.5)', async () => {
    // archive.spec.ts implements every ArchivePorts member with fakes
    expect((await adapter.getImplementations(await method(F.users))).map((i) => i.key)).toEqual([F.usersProduct]);
    expect((await adapter.getImplementations(await method(F.labelFor))).map((i) => i.key)).toEqual([F.requestLabelFor]);
    const d = await newSession().openMethod(await method(F.archiveAll));
    expect(byId(d, 'root/1:users').polymorphic?.selectedKey).toBe(O.usersFrom);
  });

  it('FR-4.1 callers in test files are kept but listed after production callers', async () => {
    const callers = await adapter.getCallers(await method(F.archiveAll));
    expect(callers.map((c) => c.enclosing.key)).toEqual([F.runArchive, 'src/application/archive.spec.ts#<module>.archivesWithFakes']);
    // FR-4.4: flagged, so the view can hide them unless the developer includes tests
    expect(callers.map((c) => c.inTest ?? false)).toEqual([false, true]);
  });

  it('FR-7.2 default test globs, replaced by "testFiles" in .seqcall.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-tests-'));
    try {
      const m = new TestFileMatcher(dir);
      expect(['src/a.spec.ts', 'src/a.test.js', 'src/__tests__/a.ts', 'test/a.ts', 'pkg/tests/a.ts',
        'features/step_definitions/a.steps.ts', 'src/a.steps.ts', 'features/support/setup.ts',
        'resources/src/features/step-definitions/shop/viewCoupon.bdd.tsx'].every((f) => m.isTest(f))).toBe(true);
      expect(m.isTest('src/application/sweep.ts')).toBe(false);
      fs.writeFileSync(path.join(dir, '.seqcall.json'), JSON.stringify({ testFiles: ['e2e/**'] }));
      // the file is looked at every 2 s, or at once when the config is reloaded (a save: the classifier's reloadConfig)
      expect(m.isTest('e2e/flow.ts')).toBe(false);
      createClassifier(dir).reloadConfig();
      expect(m.isTest('e2e/flow.ts')).toBe(true);
      expect(m.isTest('src/a.spec.ts')).toBe(false); // the defaults are replaced
      // without a reload: after the interval
      const quick = new TestFileMatcher(dir, 0);
      expect(quick.isTest('e2e/flow.ts')).toBe(true);
      fs.writeFileSync(path.join(dir, '.seqcall.json'), JSON.stringify({ testFiles: ['qa/**'] }));
      expect(quick.isTest('qa/flow.ts')).toBe(true);
      // an empty list: no file is test code
      fs.writeFileSync(path.join(dir, '.seqcall.json'), JSON.stringify({ testFiles: [] }));
      expect(['qa/flow.ts', 'src/a.spec.ts'].map((f) => quick.isTest(f))).toEqual([false, false]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DiagramSession: functional code', () => {
  it('FR-8.2 / FR-8.5 a port call offers the adapter implementations and expands into them', async () => {
    const s = newSession();
    await s.openMethod(await method(F.archiveAll));
    let d = (await s.expand('root/1:users'))!;
    const users = byId(d, 'root/1:users');
    expect(users).toMatchObject({ expandable: true, expanded: true, methodKey: F.usersProduct });
    expect(users.polymorphic).toMatchObject({ interfaceKey: O.ArchivePorts, selectedKey: O.usersFrom });
    expect(participantOf(d, users)).toMatchObject({ label: 'usersFrom', implementsInterface: { key: O.ArchivePorts } });
    expect(d.messages.filter((m) => m.parentId === 'root/1:users').map((m) => m.methodName)).toEqual(['info']);

    await s.expand('root/2:archiveOne');
    d = (await s.expand('root/2:archiveOne/1:store'))!;
    const store = byId(d, 'root/2:archiveOne/1:store');
    expect(participantOf(d, store)).toMatchObject({ label: 'fileStore', classKey: O.fileStore, stereotypes: ['adapter'] });
    // a sibling function of the same closure is a self message
    expect(byId(d, 'root/2:archiveOne/1:store/1:flush')).toMatchObject({ kind: 'self', to: store.to });
    expect((await s.getClassDiagram())!.classes.find((c) => c.key === O.fileStore)?.methods.map((m) => m.name)).toEqual(['store', 'flush']);
  });

  it('FR-6.5 callee parameters are bound to the caller argument participants (no duplicates for renamed parameters)', async () => {
    const s = newSession({ autoSelectSingleImplementation: false });
    await s.openMethod(await method(F.archiveAll));
    const d = (await s.expand('root/2:archiveOne'))!;
    const store = byId(d, 'root/2:archiveOne/1:store');
    expect(store.to).toBe(byId(d, 'root/1:users').to); // deps → ports
    expect(store.to).toBe(byId(d, 'root/4:audit').to);
    expect(d.participants.filter((p) => p.classKey === O.ArchivePorts)).toHaveLength(1);
    const request = participantOf(d, byId(d, 'root/2:archiveOne/0:labelFor'));
    expect(request).toMatchObject({ classKey: O.ArchiveRequest, instanceName: 'request' }); // req → request
  });

  it('FR-6.5 a created object assigned to a local is one participant, also when passed to helpers; this and fields are bound', async () => {
    const s = newSession();
    await s.openMethod(await method(F.exportUser));
    await s.expand('root/1:write');
    const d = (await s.expand('root/1:write/2:logExport'))!;
    const created = byId(d, 'root/0:constructor').to;
    expect(participantOf(d, byId(d, 'root/0:constructor'))).toMatchObject({ classKey: O.ExportBatch, createdByMessageId: 'root/0:constructor' });
    expect(['root/2:add', 'root/4:close', 'root/1:write/1:add'].map((id) => byId(d, id).to)).toEqual([created, created, created]);
    expect(d.participants.filter((p) => p.classKey === O.ExportBatch)).toHaveLength(1);
    // write(this.repo, …) → source.findById is the field participant
    expect(byId(d, 'root/1:write/0:findById').to).toBe(byId(d, 'root/3:findById').to);
    expect(d.participants.filter((p) => p.classKey === O.UserRepository)).toHaveLength(1);
    // logExport(this, …) → service.label() goes back to the root participant
    expect(byId(d, 'root/1:write/2:logExport/0:label').to).toBe(d.messages[0].to);
  });

  it('FR-7.1 «seam» only on behavioural abstractions that have implementations', async () => {
    const d = await newSession({ autoSelectSingleImplementation: false }).openMethod(await method(F.archiveAll));
    expect(participantOf(d, byId(d, 'root/1:users')).stereotypes).toContain('seam');
    expect(participantOf(d, byId(d, 'root/0:now'))).toMatchObject({ classKey: O.Clock, stereotypes: ['interface'] });
  });

  it('FR-6.5 / FR-7.1 a destructured local and a parameter of the same name are one participant; «seam» from any path', async () => {
    const d = await newSession({ autoSelectSingleImplementation: false, defaultDepth: 2 })
      .openMethod(await method('src/application/archive.ts#<module>.auditTwice'));
    const via = byId(d, 'root/0:auditVia/0:audit');
    expect(via.to).toBe(byId(d, 'root/1:audit').to);
    expect(participantOf(d, via).stereotypes).toEqual(['interface', 'seam']);
  });

  it('FR-6.4 the root participant group comes first, then layer order', async () => {
    const d = await newSession().openMethod(await method(F.runArchive));
    expect(d.groups.map((g) => g.label)).toEqual(['Presentation · src', 'Application · application', 'Infrastructure · adapters']); // main.ts: composition root
    expect(d.participants[0].id).toBe(d.messages[0].to);
  });
});

describe('Class diagram: interfaces implemented by module-level object literals (FR-8.2 / FR-12)', () => {
  it('FR-12.3 the chosen implementation owned by a module keeps its interface: drawn with a realization', async () => {
    const s = newSession();
    const d = await s.openMethod(await method('src/console/report.ts#<module>.report'));
    const line = d.messages.find((m) => m.methodName === 'line')!;
    expect(line.polymorphic).toMatchObject({ interfaceKey: 'src/console/report.ts#Output', selectedKey: 'src/console/terminal.ts#<module>' });
    expect(participantOf(d, line)).toMatchObject({ kind: 'module', implementsInterface: { key: 'src/console/report.ts#Output', name: 'Output' } });
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.key === 'src/console/report.ts#Output')).toMatchObject({ kind: 'interface' });
    expect(cd.relations.some((r) => r.kind === 'realization' && r.from === 'src/console/terminal.ts#<module>' && r.to === 'src/console/report.ts#Output')).toBe(true);
  });
});
