import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageAdapter } from '../src/adapter';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { createClassifier } from '../src/classifier-impl';
import { DEFAULT_OPTIONS, DiagramSession } from '../src/session';
import { C, FIXTURE_ROOT, K, byId, file, ids, method, newSession, participantOf, positionOf, sharedAdapter } from './helpers';

beforeAll(async () => {
  await sharedAdapter().getMethod(K.getUser); // warm up
});

describe('DiagramSession: generation (FR-1)', () => {
  it('FR-1.1 openAt draws the enclosing method starting with a found message', async () => {
    const s = newSession();
    const d = (await s.openAt(file('src/controllers/user-controller.ts'), positionOf('src/controllers/user-controller.ts', 'this.validate(id);\n    Logger')))!;
    expect(d.root.key).toBe(K.getUser);
    const found = d.messages[0];
    expect(found).toMatchObject({ id: 'root', kind: 'found', from: null, parentId: null, depth: 0, methodName: 'getUser' });
    expect(found.callSite).toEqual(d.root.declaration);
    expect(participantOf(d, found)).toMatchObject({ classKey: C.UserController, label: ':UserController' });
  });

  it('FR-1.3 the initial diagram shows depth 1 only; defaultDepth is configurable', async () => {
    const d1 = await newSession().openMethod(await method(K.getUser));
    expect(Math.max(...d1.messages.map((m) => m.depth))).toBe(1);
    expect(byId(d1, 'root/2:findUser')).toMatchObject({ expandable: true, expanded: false });
    const d2 = await newSession({ defaultDepth: 2 }).openMethod(await method(K.getUser));
    expect(byId(d2, 'root/2:findUser').expanded).toBe(true);
    expect(ids(d2)).toContain('root/2:findUser/0:findById');
  });

  it('FR-1.4 messages in evaluation order (argument call before the create)', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    // slugify runs inside the map callback (FR-1.11)
    expect(ids(d)).toEqual(['root', 'root/0:validate', 'root/1:info', 'root/2:findUser', 'root/3:formatName', 'root/4:constructor', 'root/6:slugify']);
  });

  it('FR-1.5 this-calls are self messages on the sender lifeline', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    const m = byId(d, 'root/0:validate');
    expect(m.kind).toBe('self');
    expect(m.from).toBe(m.to);
    expect(m.to).toBe(d.messages[0].to);
  });

  it('FR-1.6 library calls hidden by default; the option shows them on one «external» participant per library', async () => {
    const s = newSession();
    expect((await s.openMethod(await method(K.getUser))).messages.some((m) => m.isLibrary)).toBe(false);
    const d = (await s.setOption('showLibraryCalls', true))!;
    const lib = d.messages.filter((m) => m.isLibrary);
    expect(lib.map((m) => m.id)).toEqual(['root/5:map', 'root/7:stringify']);
    expect(new Set(lib.map((m) => m.to)).size).toBe(1);
    expect(participantOf(d, lib[0])).toMatchObject({ kind: 'external', stereotypes: ['external'], label: 'lib' });
    expect(lib.every((m) => !m.expandable)).toBe(true);
    expect(d.options.showLibraryCalls).toBe(true);
  });

  it('FR-1.8 unresolvable calls go to a shared «unknown» participant labelled with the call text', async () => {
    const d = await newSession().openMethod(await method(K.generate));
    const m = d.messages.find((x) => x.to === 'unknown')!;
    expect(m).toMatchObject({ methodName: 'this.printer.print', args: ['line'], expandable: false });
    expect(m.methodKey).toBeUndefined();
    expect(participantOf(d, m)).toMatchObject({ kind: 'unknown', stereotypes: ['unknown'] });
  });

  it('FR-1.9 awaited calls carry the async marker', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    expect(byId(d, 'root/2:findUser').isAsync).toBe(true);
    expect(byId(d, 'root/1:info').isAsync).toBe(false);
  });

  it('FR-1.2 module functions are drawn on a «module» participant; sibling calls are self messages', async () => {
    const d = await newSession().openMethod(await method(K.formatName));
    expect(participantOf(d, d.messages[0])).toMatchObject({ kind: 'module', label: 'format', stereotypes: ['module'] });
    expect(byId(d, 'root/0:slugify').kind).toBe('self');
  });
});

describe('DiagramSession: expand / collapse (FR-3)', () => {
  it('FR-3.1 expanding inserts nested messages sent from the target lifeline', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const d = (await s.expand('root/2:findUser'))!;
    const parent = byId(d, 'root/2:findUser');
    expect(parent.expanded).toBe(true);
    const children = d.messages.filter((m) => m.parentId === 'root/2:findUser');
    expect(children.map((m) => m.id)).toEqual(['root/2:findUser/0:findById', 'root/2:findUser/1:findById']);
    expect(children.every((m) => m.from === parent.to && m.depth === 2)).toBe(true);
    // pre-order: children directly follow their parent
    expect(ids(d).indexOf('root/2:findUser/0:findById')).toBe(ids(d).indexOf('root/2:findUser') + 1);
  });

  it('FR-3.2 collapsing removes the subtree and unreferenced participants', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const expanded = (await s.expand('root/2:findUser'))!;
    expect(expanded.participants.some((p) => p.classKey === C.UserRepository)).toBe(true);
    const d = (await s.collapse('root/2:findUser'))!;
    expect(d.messages.some((m) => m.parentId === 'root/2:findUser')).toBe(false);
    expect(d.participants.some((p) => p.classKey === C.UserRepository)).toBe(false);
  });

  it('FR-3.3 expand all adds one level (bounded); collapse all returns to depth 1', async () => {
    const s = newSession();
    await s.openMethod(await method(K.renameUser));
    const d1 = (await s.expandAll())!;
    expect(Math.max(...d1.messages.map((m) => m.depth))).toBe(2);
    const d2 = (await s.expandAll())!;
    expect(Math.max(...d2.messages.map((m) => m.depth))).toBe(3);
    expect(d2.messages.length).toBeLessThanOrEqual(500);
    const d3 = (await s.collapseAll())!;
    expect(Math.max(...d3.messages.map((m) => m.depth))).toBe(1);
  });

  it('FR-3.4 recursion is detected and not expandable', async () => {
    const d = await newSession().openMethod(await method(K.managementChain));
    const rec = byId(d, 'root/1:managementChain');
    expect(rec).toMatchObject({ recursive: true, expandable: false, kind: 'self' });
    expect(byId(d, 'root/0:findUser').recursive).toBe(false);
  });

  it('FR-3.5 no expand affordance when expanding would show nothing', async () => {
    const SYNC = await method('src/services/import-service.ts#ImportService.sync');
    const s = newSession();
    const d = await s.openMethod(SYNC);
    const find = (dd: typeof d, name: string) => dd.messages.find((m) => m.methodName === name)!;
    // describe() has no calls at all; Logger.info calls Logger.write
    expect(find(d, 'describe').expandable).toBe(false);
    expect(find(d, 'info').expandable).toBe(true);
    // Logger.write only calls console.log: a hidden library call
    const info = find(d, 'info').id;
    const e = (await s.expand(info))!;
    expect(find(e, 'write')).toMatchObject({ expandable: false, expanded: false });
    expect((await s.setOption('showLibraryCalls', true))!.messages.find((m) => m.methodName === 'write')!.expandable).toBe(true);
    await s.setOption('showLibraryCalls', false);

    // hiding the only call of a body removes the ⊕ — but an expanded call keeps its ⊖
    const s2 = newSession();
    await s2.openMethod(SYNC);
    const h = (await s2.hide({ kind: 'methodName', methodName: 'write' }))!;
    expect(find(h, 'info').expandable).toBe(false);
    const s3 = newSession();
    await s3.openMethod(SYNC);
    await s3.expand(info);
    const h3 = (await s3.hide({ kind: 'methodName', methodName: 'write' }))!;
    expect(h3.messages.find((m) => m.id === info)).toMatchObject({ expandable: true, expanded: true });
    expect(h3.hiddenFilters[0].hiddenCount).toBeGreaterThan(0);
  });
});

describe('DiagramSession: callers and history (FR-4)', () => {
  it('FR-4.1 callers of any message target', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    expect((await s.getCallers('root')).map((c) => c.enclosing.key)).toContain(K.getUser);
    await s.openMethod(await method(K.getUser));
    expect((await s.getCallers('root/2:findUser')).map((c) => c.enclosing.key)).toContain(K.audit);
    expect((await s.getCallers('root/4:constructor')).map((c) => c.enclosing.key)).toEqual([K.getUser]);
  });

  it('FR-4.2 re-rooting at a caller expands the path to the previous root, keeping its exploration', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await s.expand('root/0:findById'); // polymorphic, no impl chosen: not expandable → ignored
    const callers = await s.getCallers('root');
    const fromController = callers.find((c) => c.enclosing.key === K.getUser)!;
    const d = (await s.reroot('root', fromController.id))!;
    expect(d.root.key).toBe(K.getUser);
    const call = byId(d, 'root/2:findUser');
    expect(call.expanded).toBe(true);
    expect(ids(d)).toContain('root/2:findUser/1:findById');
    expect(d.canGoBack).toBe(true);
  });

  it('FR-4.2 re-rooting from a nested message transplants the expansion below it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.rename));
    await s.expand('root/0:findUser');
    const caller = (await s.getCallers('root')).find((c) => c.enclosing.key === K.renameUser)!;
    const d = (await s.reroot('root', caller.id))!;
    expect(d.root.key).toBe(K.renameUser);
    expect(byId(d, 'root/1:rename').expanded).toBe(true);
    expect(byId(d, 'root/1:rename/0:findUser').expanded).toBe(true);
  });

  it('FR-4.3 back / forward restore roots with their expansion state', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    await s.openMethod(await method(K.audit));
    let d = (await s.back())!;
    expect(d.root.key).toBe(K.getUser);
    expect(byId(d, 'root/2:findUser').expanded).toBe(true);
    expect(d).toMatchObject({ canGoBack: false, canGoForward: true });
    d = (await s.forward())!;
    expect(d.root.key).toBe(K.audit);
    expect(d).toMatchObject({ canGoBack: true, canGoForward: false });
  });
});

describe('DiagramSession: create messages (FR-5)', () => {
  it('FR-5.1 new X() is a create message to a participant created at that message', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    const create = byId(d, 'root/4:constructor');
    expect(create.kind).toBe('create');
    expect(create.args).toEqual(['user.name', 'formatName(user)']);
    expect(participantOf(d, create)).toMatchObject({ classKey: C.UserDto, createdByMessageId: 'root/4:constructor' });
  });

  it('FR-5.4 new X().m(): the message goes to the object just created; two creations are two objects', async () => {
    const d = await newSession().openMethod(await method('src/domain/order.ts#Pricing.quote'));
    const creates = d.messages.filter((m) => m.kind === 'create');
    const calls = d.messages.filter((m) => m.kind === 'call' && m.className === 'Order');
    expect(creates.length).toBe(2);
    // each call goes to the object its own `new` created: two objects, no third «expression» object
    expect(calls.map((c) => c.to)).toEqual(creates.map((c) => c.to));
    expect(new Set(creates.map((c) => c.to)).size).toBe(2);
    expect(d.participants.filter((p) => p.className === 'Order').length).toBe(2);
  });

  it('FR-5.5 objects that are only created are still one object each (no shared lifeline per class)', async () => {
    const d = await newSession().openMethod(await method('src/domain/order.ts#Pricing.drafts'));
    const creates = d.messages.filter((m) => m.kind === 'create');
    expect(creates.length).toBe(2);
    expect(new Set(creates.map((c) => c.to)).size).toBe(2);
    expect(d.participants.filter((p) => p.className === 'Order').map((p) => p.createdByMessageId)).toEqual(creates.map((c) => c.id));
  });

  it('FR-5.2 the created participant is listed among the participants (header)', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    expect(d.participants.filter((p) => p.createdByMessageId).map((p) => p.className)).toEqual(['UserDto']);
  });

  it('FR-5.3 expanding a create message shows the constructor calls', async () => {
    const s = newSession();
    await s.openMethod(await method('src/main.ts#<module>.bootstrap'));
    const d = (await s.setOption('showLibraryCalls', true))!;
    const create = d.messages.find((m) => m.kind === 'create' && participantOf(d, m).className === 'InMemoryUserRepository')!;
    const expanded = (await s.expand(create.id))!;
    expect(expanded.messages.filter((m) => m.parentId === create.id).map((m) => m.methodName)).toEqual(['constructor']);
  });
});

describe('DiagramSession: participants (FR-6)', () => {
  it('FR-6.2 participants are anonymous unless several of the same class are visible', async () => {
    const s = newSession();
    const d0 = await s.openMethod(await method(K.getUser));
    expect(d0.participants.map((p) => p.label)).toEqual([':UserController', ':UserService', ':UserDto', 'Logger', 'format']);
    const d = (await s.expand('root/2:findUser'))!;
    const repos = d.participants.filter((p) => p.classKey === C.UserRepository);
    expect(repos.map((p) => p.label)).toEqual(['replica:UserRepository', 'primary:UserRepository']);
  });

  it('FR-6.3 participants carry stereotypes', async () => {
    const d = await newSession().openMethod(await method(K.getUser));
    const byClass = Object.fromEntries(d.participants.map((p) => [p.className, p.stereotypes]));
    expect(byClass.UserController).toEqual(['controller']);
    expect(byClass.UserService).toEqual(['service']);
    expect(byClass.Logger).toEqual(['static']);
    expect(byClass.format).toEqual(['module']);
  });

  it('FR-6.4 grouped by layer and namespace; ordered by group then first appearance', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const d = (await s.expand('root/2:findUser'))!;
    expect(d.groups.map((g) => g.label)).toEqual([
      'Presentation · controllers',
      'Application · services',
      'Ports · ports',
      'Domain · domain',
      'No layer · util',
    ]); // short labels: layer + last folder (full path is the view's tooltip); unlayered ones say so
    expect(d.groups.map((g) => g.namespace)).toContain('src/controllers');
    const groupOrder = d.participants.map((p) => d.groups.findIndex((g) => g.id === p.groupId));
    expect(groupOrder).toEqual([...groupOrder].sort((a, b) => a - b));
    const util = d.participants.filter((p) => p.namespace === 'src/util').map((p) => p.className);
    expect(util).toEqual(['Logger', 'format']); // first appearance: Logger.info before formatName
  });

  it('FR-6.5 identity = (class, receiver origin): same field → one participant, statics share one «static»', async () => {
    // FR-3.12 the error branch's calls are drawn: ↯ Fold errors off
    const s = newSession({ initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
    await s.openMethod(await method(K.rename));
    const d = (await s.expand('root/0:findUser'))!;
    const primaryFind = byId(d, 'root/0:findUser/1:findById');
    const primarySave = byId(d, 'root/2:save');
    const replicaFind = byId(d, 'root/0:findUser/0:findById');
    expect(primaryFind.to).toBe(primarySave.to);
    expect(replicaFind.to).not.toBe(primarySave.to);

    await s.openMethod(await method(K.getUser));
    const d2 = (await s.expand('root/0:validate'))!;
    expect(byId(d2, 'root/0:validate/0:error').to).toBe(byId(d2, 'root/1:info').to);
    expect(participantOf(d2, byId(d2, 'root/1:info'))).toMatchObject({ label: 'Logger', stereotypes: ['static'] });
  });

  it('FR-7.1 «seam» on interface-typed injected dependencies, «singleton» on exported instances', async () => {
    const s = newSession();
    await s.openMethod(await method(K.renameUser));
    const d = (await s.expand('root/1:rename'))!;
    const notifier = participantOf(d, byId(d, 'root/1:rename/3:notify'));
    expect(notifier.stereotypes).toEqual(['abstract', 'seam']);
    expect(participantOf(d, byId(d, 'root/2:bill')).stereotypes).toContain('singleton');
  });
});

describe('DiagramSession: polymorphism (FR-8)', () => {
  it('FR-8.1 interface calls target the interface participant and are not expandable', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    const d = s.current()!;
    const m = byId(d, 'root/1:findById');
    expect(m.expandable).toBe(false);
    expect(m.polymorphic).toMatchObject({ interfaceKey: C.UserRepository, interfaceName: 'UserRepository', selectedKey: undefined });
    expect(m.polymorphic?.implementations.map((i) => i.name)).toEqual(['InMemoryUserRepository', 'SqlUserRepository']);
    expect(participantOf(d, m).kind).toBe('interface');
  });

  it('FR-2.5 activation bars carry the definition of the executed method (the chosen implementation)', async () => {
    const s = newSession();
    const d0 = await s.openMethod(await method(K.findUser));
    expect(d0.messages[0].targetDeclaration).toEqual(d0.root.declaration);
    expect(byId(d0, 'root/1:findById').targetDeclaration?.file).toMatch(/ports\/user-repository\.ts$/);
    const d1 = (await s.selectImplementation('root/1:findById', C.SqlUserRepository))!;
    expect(byId(d1, 'root/1:findById').targetDeclaration).toEqual((await method(K.sqlFindById)).declaration);
    const lib = newSession({ initialState: { options: { showArguments: true, maxArgumentLength: 30, showLibraryCalls: true, followCursor: false } } });
    const d2 = await lib.openMethod(await method('src/services/import-service.ts#ImportService.sync'));
    expect(d2.messages.find((m) => m.methodName === 'forEach')!.targetDeclaration).toBeUndefined();
  });

  it('FR-8.2 choosing an implementation makes the participant the implementation and the message expandable', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    let d = (await s.selectImplementation('root/1:findById', C.SqlUserRepository))!;
    const m = byId(d, 'root/1:findById');
    expect(m).toMatchObject({ expandable: true, methodKey: K.sqlFindById });
    expect(m.polymorphic?.selectedKey).toBe(C.SqlUserRepository);
    expect(participantOf(d, m)).toMatchObject({
      className: 'SqlUserRepository',
      kind: 'class',
      implementsInterface: { key: C.UserRepository, name: 'UserRepository' },
    });
    d = (await s.expand('root/1:findById'))!;
    expect(d.messages.filter((x) => x.parentId === 'root/1:findById').map((x) => x.methodName)).toEqual([
      'getInstance',
      'query',
      'constructor',
    ]);
  });

  it('FR-8.3 back to interface reverts the choice and collapses the subtree', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await s.selectImplementation('root/1:findById', C.SqlUserRepository);
    await s.expand('root/1:findById');
    const d = (await s.revertImplementation('root/1:findById'))!;
    const m = byId(d, 'root/1:findById');
    expect(m).toMatchObject({ expandable: false, expanded: false });
    expect(m.polymorphic?.selectedKey).toBeUndefined();
    expect(d.messages.some((x) => x.parentId === 'root/1:findById')).toBe(false);
    expect(participantOf(d, m).classKey).toBe(C.UserRepository);
  });

  it('FR-8.4 the choice is remembered per interface and applied to other calls through it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    const d = (await s.selectImplementation('root/1:findById', C.InMemoryUserRepository))!;
    expect(byId(d, 'root/0:findById').polymorphic?.selectedKey).toBe(C.InMemoryUserRepository);
    // two visible instances of the same implementation class → named (FR-6.2)
    expect(d.participants.filter((p) => p.classKey === C.InMemoryUserRepository).map((p) => p.label).sort()).toEqual([
      'primary:InMemoryUserRepository',
      'replica:InMemoryUserRepository',
    ]);
    // also in a new root of the same session
    const d2 = await s.openMethod(await method(K.rename));
    expect(byId(d2, 'root/2:save').polymorphic?.selectedKey).toBe(C.InMemoryUserRepository);
  });

  it('FR-8.5 a single implementation is pre-selected (configurable)', async () => {
    const d = await newSession().openMethod(await method(K.bill));
    expect(byId(d, 'root/0:charge')).toMatchObject({ expandable: true, polymorphic: { selectedKey: C.StripeGateway } });
    const off = await newSession({ autoSelectSingleImplementation: false }).openMethod(await method(K.bill));
    expect(byId(off, 'root/0:charge')).toMatchObject({ expandable: false, polymorphic: { selectedKey: undefined } });
  });
});

describe('DiagramSession: hiding (FR-11)', () => {
  it('FR-11.1 hide all calls to a method name (any class) removes messages and orphaned participants', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const d = (await s.hide({ kind: 'methodName', methodName: 'info' }))!;
    expect(ids(d)).not.toContain('root/1:info');
    expect(d.participants.some((p) => p.classKey === C.Logger)).toBe(false);
    expect(d.hiddenFilters).toEqual([{ filter: { id: 'methodName:info', kind: 'methodName', methodName: 'info' }, hiddenCount: 1 }]);
  });

  it('FR-11.1 hide calls to Class.name hides the message and its subtree', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    const d = (await s.hide({ kind: 'classMethod', classKey: C.UserService, className: 'UserService', methodName: 'findUser' }))!;
    expect(d.messages.some((m) => m.id.startsWith('root/2:findUser'))).toBe(false);
    expect(d.participants.some((p) => p.classKey === C.UserRepository)).toBe(false);
    expect(d.hiddenFilters[0].hiddenCount).toBe(1);
  });

  it('FR-11.2 filters are part of the persistent state and restored from it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.hide({ kind: 'methodName', methodName: 'validate' });
    const state = s.getPersistentState();
    expect(state.filters.map((f) => f.id)).toEqual(['methodName:validate']);
    const restored = await newSession({ initialState: state }).openMethod(await method(K.getUser));
    expect(ids(restored)).not.toContain('root/0:validate');
  });

  it('FR-11.3 hidden filter list with counts; unhide one or all', async () => {
    const s = newSession();
    await s.openMethod(await method(K.renameUser));
    await s.expandAll();
    let d = (await s.hide({ kind: 'methodName', methodName: 'info' }))!;
    expect(d.hiddenFilters[0].hiddenCount).toBe(1); // inside bill (expanded)
    d = (await s.hide({ kind: 'methodName', methodName: 'validate' }))!;
    expect(d.hiddenFilters.map((h) => [h.filter.id, h.hiddenCount])).toEqual([
      ['methodName:info', 1],
      ['methodName:validate', 1],
    ]);
    d = (await s.unhide('methodName:validate'))!;
    expect(ids(d)).toContain('root/0:validate');
    expect(d.hiddenFilters).toHaveLength(1);
    d = (await s.unhideAll())!;
    expect(d.hiddenFilters).toEqual([]);
    expect(s.getPersistentState().filters).toEqual([]);
  });

  it('FR-11.4 hide class hides calls to any method of that class', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/0:validate');
    const d = (await s.hide({ kind: 'class', classKey: C.Logger, className: 'Logger' }))!;
    expect(d.messages.some((m) => m.classKey === C.Logger)).toBe(false);
    expect(d.hiddenFilters[0].hiddenCount).toBe(2);
  });

  it('FR-11.7 a "don\'t expand" rule keeps the call drawn, marked, and counted', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const d = (await s.hide({ kind: 'classMethod', classKey: C.UserService, className: 'UserService', methodName: 'findUser', noExpand: true }))!;
    expect(byId(d, 'root/2:findUser')).toMatchObject({ expandable: true, expanded: false, noExpand: `noExpand:classMethod:${C.UserService}.findUser` });
    expect(d.participants.some((p) => p.classKey === C.UserService)).toBe(true);
    expect(d.hiddenFilters).toEqual([{ filter: { id: `noExpand:classMethod:${C.UserService}.findUser`, kind: 'classMethod', classKey: C.UserService, className: 'UserService', methodName: 'findUser', noExpand: true }, hiddenCount: 1 }]);
    expect(byId(d, 'root/0:validate').noExpand).toBeUndefined();
  });

  it('FR-11.7 Expand all / expand everything / Smart expand leave the call folded; a click (and Expand all below it) still opens it', async () => {
    const rule = { kind: 'class', classKey: C.UserService, className: 'UserService', noExpand: true } as const;
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.hide(rule);
    expect(byId((await s.expandAll())!, 'root/2:findUser').expanded).toBe(false);
    const every = (await s.expandEverything())!;
    expect(byId(every, 'root/2:findUser').expanded).toBe(false);
    expect(every.expandNotice).toBeUndefined(); // folded by the rule, not by a limit
    await s.collapseAll();
    expect(byId((await s.smartExpand())!, 'root/2:findUser').expanded).toBe(false);
    const clicked = (await s.expand('root/2:findUser'))!;
    expect(byId(clicked, 'root/2:findUser').expanded).toBe(true);
    expect(ids(clicked)).toContain('root/2:findUser/0:findById');
    await s.collapse('root/2:findUser');
    expect(byId((await s.expandEverything('root/2:findUser'))!, 'root/2:findUser').expanded).toBe(true);
  });

  it('FR-11.7 a "don\'t expand" rule folds every open call it matches, marked ⊡', async () => {
    // FR-3.12 the error branches' calls are drawn: ↯ Fold errors off
    const s = newSession({ initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
    await s.openMethod(await method('src/services/import-service.ts#ImportService.importAll'));
    const open = (await s.expandAll())!;
    const errors = open.messages.filter((m) => m.methodName === 'error');
    expect(errors.length).toBe(2);
    expect(errors.every((m) => m.expanded)).toBe(true);
    const d = (await s.hide({ kind: 'methodName', methodName: 'error', noExpand: true }))!;
    const folded = d.messages.filter((m) => m.methodName === 'error');
    expect(folded.map((m) => [m.expanded, m.noExpand])).toEqual([[false, 'noExpand:methodName:error'], [false, 'noExpand:methodName:error']]);
    expect(d.messages.some((m) => m.parentId && folded.some((f) => f.id === m.parentId))).toBe(false);
    // the other open calls stay open
    expect(d.messages.filter((m) => m.expanded && m.id !== 'root').length).toBeGreaterThan(0);
    expect(d.hiddenFilters[0].hiddenCount).toBe(2);
  });

  it('FR-11.7 one rule per target: hiding replaces "don\'t expand" and back; unhide removes it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.hide({ kind: 'methodName', methodName: 'findUser', noExpand: true });
    let d = (await s.hide({ kind: 'methodName', methodName: 'findUser' }))!;
    expect(d.hiddenFilters.map((h) => h.filter.id)).toEqual(['methodName:findUser']);
    expect(ids(d)).not.toContain('root/2:findUser');
    d = (await s.hide({ kind: 'methodName', methodName: 'findUser', noExpand: true }))!;
    expect(d.hiddenFilters.map((h) => h.filter.id)).toEqual(['noExpand:methodName:findUser']);
    expect(ids(d)).toContain('root/2:findUser');
    d = (await s.unhide('noExpand:methodName:findUser'))!;
    expect(byId(d, 'root/2:findUser').noExpand).toBeUndefined();
  });

  it('FR-9.2 / FR-9.3 argument options are passed through to the view', async () => {
    const s = newSession({ initialState: { options: { showArguments: false, maxArgumentLength: 10, showLibraryCalls: false, followCursor: false } } });
    const d = await s.openMethod(await method(K.getUser));
    expect(d.options).toMatchObject({ showArguments: false, maxArgumentLength: 10 });
    expect((await s.setOption('maxArgumentLength', 40))!.options.maxArgumentLength).toBe(40);
    expect(s.getPersistentState().options.maxArgumentLength).toBe(40);
  });
});

describe('DiagramSession: refresh (FR-13)', () => {
  it('FR-13.1 refresh re-analyses and preserves expansion, implementation choices and filters where paths still exist', async () => {
    const adapter = createTsAdapter(FIXTURE_ROOT);
    const s = newSession({ adapter });
    await s.openMethod((await adapter.getMethod(K.getUser))!);
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/1:findById', C.SqlUserRepository);
    await s.expand('root/2:findUser/1:findById');
    await s.hide({ kind: 'methodName', methodName: 'validate' });

    const rel = 'src/controllers/user-controller.ts';
    const original = fs.readFileSync(file(rel), 'utf8');
    const edited = original.replace('return JSON.stringify({ dto, tags });', "Logger.info('done');\n    return JSON.stringify({ dto, tags });");
    await adapter.updateFile(file(rel), edited);
    let d = (await s.refresh())!;
    expect(ids(d)).toContain('root/7:info'); // new call between the map callback and stringify
    expect(byId(d, 'root/2:findUser').expanded).toBe(true);
    expect(byId(d, 'root/2:findUser/1:findById').polymorphic?.selectedKey).toBe(C.SqlUserRepository);
    expect(byId(d, 'root/2:findUser/1:findById').expanded).toBe(true);
    expect(ids(d)).not.toContain('root/0:validate');

    d = (await s.refresh([file(rel)]))!; // re-read from disk
    expect(ids(d)).not.toContain('root/6:info');
    expect(byId(d, 'root/2:findUser/1:findById').expanded).toBe(true);
    await adapter.dispose();
  });

  it('FR-13.1 refresh returns undefined when the root method no longer exists', async () => {
    const adapter = createTsAdapter(FIXTURE_ROOT);
    const s = newSession({ adapter });
    await s.openMethod((await adapter.getMethod(K.audit))!);
    await adapter.updateFile(file('src/controllers/admin-controller.ts'), 'export class AdminController {}');
    expect(await s.refresh()).toBeUndefined();
    await adapter.dispose();
  });
});

describe('Performance (NFR-1)', () => {
  it('NFR-1 opening and expanding a diagram after warm-up is fast', async () => {
    const s = newSession();
    const t0 = performance.now();
    await s.openAt(file('src/controllers/user-controller.ts'), positionOf('src/controllers/user-controller.ts', 'this.userService.rename'));
    await s.expandAll();
    await s.expandAll();
    await s.getClassDiagram();
    const ms = performance.now() - t0;
    console.log(`NFR-1: open + 2x expand all + class diagram took ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

describe('DiagramSession: asynchronous adapters', () => {
  /** The shared TsAdapter behind random delays, counting requests per method. */
  function slowAdapter(): { adapter: LanguageAdapter; counts: Map<string, number> } {
    const inner = sharedAdapter();
    const counts = new Map<string, number>();
    const adapter = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'projectRoot') return value;
        return async (...args: unknown[]) => {
          counts.set(String(prop), (counts.get(String(prop)) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { adapter, counts };
  }

  it('builds exactly the same diagrams as with an immediate adapter, fetching each result once', async () => {
    const { adapter, counts } = slowAdapter();
    const fast = newSession();
    const slow = newSession({ adapter });
    for (const s of [fast, slow]) {
      await s.openMethod(await method(K.getUser));
      await s.expandAll();
      await s.selectImplementation('root/2:findUser/0:findById', C.SqlUserRepository);
      await s.expandAll();
    }
    expect(slow.current()).toEqual(fast.current());
    expect(await slow.getClassDiagram()).toEqual(await fast.getClassDiagram());
    // memoised: re-rendering does not ask the adapter again
    const before = new Map(counts);
    await slow.hide({ kind: 'methodName', methodName: 'validate' });
    await slow.unhideAll();
    expect(counts).toEqual(before);
  });

  it('serializes overlapping intents in call order', async () => {
    const { adapter } = slowAdapter();
    const s = newSession({ adapter });
    const opened = s.openMethod(await method(K.getUser));
    const expanded = s.expand('root/2:findUser');
    const hidden = s.hide({ kind: 'methodName', methodName: 'validate' });
    const collapsed = s.collapse('root/2:findUser');
    const [d1, d2, d3, d4] = await Promise.all([opened, expanded, hidden, collapsed]);
    expect(ids(d1)).toContain('root/0:validate');
    expect(byId(d2!, 'root/2:findUser').expanded).toBe(true);
    expect(ids(d3!)).not.toContain('root/0:validate');
    expect(byId(d3!, 'root/2:findUser').expanded).toBe(true);
    expect(byId(d4!, 'root/2:findUser').expanded).toBe(false);
    expect(s.current()).toBe(d4);
  });

  it('a failing adapter request rejects the operation without blocking later ones', async () => {
    const inner = sharedAdapter();
    let fail = true;
    const adapter: LanguageAdapter = Object.assign(Object.create(inner) as LanguageAdapter, {
      getOutgoingCalls: async (m: Parameters<LanguageAdapter['getOutgoingCalls']>[0]) => {
        if (fail) throw new Error('sidecar down');
        return inner.getOutgoingCalls(m);
      },
    });
    const s = newSession({ adapter });
    await expect(s.openMethod(await method(K.getUser))).rejects.toThrow('sidecar down');
    fail = false;
    expect(ids((await s.refresh())!)).toContain('root/2:findUser');
  });
});

describe('FR-3.3 / FR-3.7 expand everything', () => {
  it('FR-3.3 expandEverything opens every level (expandAll stays one level); no notice when nothing is left folded', async () => {
    // FR-3.12 every call, the error branches' too: ↯ Fold errors off
    const one = newSession({ initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
    await one.openMethod(await method(K.getUser));
    const level = (await one.expandAll())!;
    const all = newSession({ initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
    await all.openMethod(await method(K.getUser));
    const every = (await all.expandEverything())!;
    expect(every.messages.length).toBeGreaterThan(level.messages.length);
    expect(every.messages.some((m) => m.expandable && !m.expanded && !m.recursive)).toBe(false);
    expect(every.expandNotice).toBeUndefined();
  });

  it('FR-3.7 expandEverything below one call leaves the rest of the diagram as it was', async () => {
    const s = newSession();
    const d = (await s.openMethod(await method(K.getUser)))!;
    const target = d.messages.find((m) => m.methodName === 'findUser')!;
    const other = d.messages.filter((m) => m.expandable && !m.expanded && m.id !== target.id).map((m) => m.id);
    const after = (await s.expandEverything(target.id))!;
    expect(after.messages.find((m) => m.id === target.id)!.expanded).toBe(true);
    expect(after.messages.filter((m) => other.includes(m.id)).every((m) => !m.expanded)).toBe(true);
  });

  it('FR-12.9 an association nothing calls through (a field holding data): no calls, the diagram unchanged, the field\'s declaration', async () => {
    const s = newSession();
    const before = (await s.openMethod(await method(K.getUser)))!;
    // getUser never notifies: UserService.notifier is not called in this flow
    const r = await s.revealRelation('src/services/user-service.ts#UserService', 'src/notifications/notifier.ts#Notifier', 'notifier');
    expect(r.messageIds).toEqual([]);
    expect(ids(r.diagram!)).toEqual(ids(before)); // the search's expansions are undone
    expect(r.fieldDeclaration).toMatchObject({ file: expect.stringMatching(/src\/services\/user-service\.ts$/), start: { line: positionOf('src/services/user-service.ts', 'notifier: Notifier').line } });
  });

  it('FR-12.14 revealRelation expands the collapsed calls into the source class until the call through the field appears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-rel-')).replace(/\\/g, '/');
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }));
    fs.writeFileSync(
      `${root}/src/app.ts`,
      `export class Repo {\n  find(id: number) { return id; }\n}\nexport class Cache {\n  get(id: number) { return id; }\n}\nexport class Service {\n  constructor(private repo: Repo, private cache: Cache) {}\n  run() { return this.helper(); }\n  private helper() { return this.cache.get(1) + this.repo.find(1); }\n}\nexport function main(s: Service) {\n  return s.run();\n}\n`,
    );
    const adapter = createTsAdapter(root);
    try {
      const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
      const d = (await s.openAt(`${root}/src/app.ts`, { line: 12, character: 4 }))!;
      expect(d.messages.map((m) => m.methodName)).toEqual(['main', 'run']); // run() collapsed
      const r = await s.revealRelation('src/app.ts#Service', 'src/app.ts#Repo', 'repo');
      expect(r.messageIds.map((id) => r.diagram!.messages.find((m) => m.id === id)!.methodName)).toEqual(['find']);
      expect(r.diagram!.messages.some((m) => m.methodName === 'get')).toBe(true); // expanded, not highlighted
      // nothing to find: the diagram unchanged, no ids
      const none = await s.revealRelation('src/app.ts#Repo', 'src/app.ts#Cache');
      expect(none.messageIds).toEqual([]);
    } finally {
      await adapter.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FR-3.7 Expand all below goes all the way down: the depth limit counts from the clicked message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-deep-')).replace(/\\/g, '/');
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }));
    const chain = Array.from({ length: 16 }, (_, i) => `export function f${i + 1}() { return ${i === 15 ? '0' : `f${i + 2}()`}; }`).join('\n');
    fs.writeFileSync(`${root}/src/chain.ts`, `${chain}\nexport function page() {\n  return f1();\n}\n`);
    const adapter = createTsAdapter(root);
    try {
      const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
      let d = (await s.openAt(`${root}/src/chain.ts`, { line: 17, character: 4 }))!;
      for (let i = 1; i <= 4; i++) d = (await s.expand(d.messages.find((m) => m.methodName === `f${i}`)!.id))!; // f5 at level 5
      const f5 = d.messages.find((m) => m.methodName === 'f5')!;
      d = (await s.expandEverything(f5.id))!;
      expect(d.messages.map((m) => m.methodName)).toContain('f16'); // the end of the chain, level 16
      expect(d.messages.some((m) => m.expandable && !m.expanded)).toBe(false);
      expect(d.expandNotice).toBeUndefined();
      // FR-3.3 from the root the depth limit holds Expand all at 12 levels and says so; One more level (asked by hand) goes past it
      await s.collapseAll();
      d = (await s.expandEverything())!;
      expect(d.expandNotice).toMatchObject({ reason: 'depth', folded: 1, limit: 12 });
      expect(d.messages.map((m) => m.methodName)).not.toContain('f13');
      d = (await s.expandAll())!;
      expect(d.messages.map((m) => m.methodName)).toContain('f13');
    } finally {
      await adapter.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FR-3.7 below one call the budget is the subtree\'s: a method with hundreds of other calls still expands it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-big-')).replace(/\\/g, '/');
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src'] }));
    const many = Array.from({ length: 520 }, (_, i) => `  t('k${i}');`).join('\n');
    fs.writeFileSync(`${root}/src/big.ts`, `export function t(k: string) { return k; }\nexport function c() { return d(); }\nexport function d() { return t('x'); }\nexport function b() { return c(); }\nexport function page() {\n  b();\n${many}\n}\n`);
    const adapter = createTsAdapter(root);
    try {
      const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
      const d = (await s.openAt(`${root}/src/big.ts`, { line: 5, character: 3 }))!;
      expect(d.messages.length).toBeGreaterThan(500); // more than the expand budget already
      const b = d.messages.find((m) => m.methodName === 'b')!;
      const after = (await s.expandEverything(b.id))!;
      expect(after.messages.filter((m) => m.id.startsWith(`${b.id}/`)).map((m) => m.methodName)).toEqual(['c', 'd', 't']);
      expect(after.expandNotice).toBeUndefined();
    } finally {
      await adapter.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

