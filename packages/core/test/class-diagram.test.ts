import { describe, expect, it } from 'vitest';
import type { ClassDiagram } from '@seqcall/protocol';
import { C, K, method, newSession } from './helpers';

const relations = (cd: ClassDiagram, kind?: string) =>
  cd.relations
    .filter((r) => !kind || r.kind === kind)
    .map((r) => `${r.kind}:${short(r.from)}->${short(r.to)}${r.label ? `:${r.label}` : ''}`)
    .sort();
const short = (key: string) => key.slice(key.indexOf('#') + 1);

describe('Class diagram derivation (FR-12)', () => {
  it('FR-12.2 classes = visible participants (no external/unknown) with stereotypes; members = visible messages', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.setOption('showLibraryCalls', true);
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.map((c) => c.name)).toEqual(['UserController', 'UserService', 'UserDto', 'Logger', 'format']);
    const ctrl = cd.classes.find((c) => c.key === C.UserController)!;
    expect(ctrl.stereotypes).toEqual(['controller']);
    expect(ctrl.methods.map((m) => m.signature)).toEqual(['getUser(id: string): Promise<string>', 'validate(id: string): void']);
    expect(cd.classes.find((c) => c.key === C.UserService)!.methods.map((m) => m.name)).toEqual(['findUser']);
    // constructor for created classes
    expect(cd.classes.find((c) => c.key === C.UserDto)!.methods).toMatchObject([
      { name: 'constructor', isStatic: false, signature: 'constructor(name: string, label: string)' },
    ]);
    expect(cd.classes.find((c) => c.key === C.Logger)!.methods).toMatchObject([
      { name: 'info', isStatic: true, signature: 'info(message: string): void' },
    ]);
  });

  it('FR-12.3 association (field), dependency (call / «create»)', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const cd = (await s.getClassDiagram())!;
    expect(relations(cd)).toEqual([
      'association:UserController->UserService:userService',
      'dependency:UserController-><module>',
      'dependency:UserController->Logger',
      'dependency:UserController->UserDto:«create»',
    ]);
  });

  it('FR-12.3 realization and association to the interface when the client reaches the implementation through it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await s.selectImplementation('root/0:findById', C.SqlUserRepository); // remembered → both calls use Sql
    await s.revertImplementation('root/1:findById'); // primary back to the interface
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.map((c) => c.name).sort()).toEqual(['SqlUserRepository', 'UserRepository', 'UserService']);
    // replica is typed as the interface: the client associates with UserRepository, which Sql realizes.
    expect(relations(cd)).toEqual([
      'association:UserService->UserRepository:primary',
      'association:UserService->UserRepository:replica',
      'realization:SqlUserRepository->UserRepository',
    ]);
    expect(cd.classes.find((c) => c.name === 'UserRepository')!.methods.map((m) => m.name)).toEqual(['findById']);
  });

  it('FR-12.3 generalization to the abstract base class the client reaches the subclass through', async () => {
    const s = newSession();
    await s.openMethod(await method(K.rename));
    await s.selectImplementation('root/3:notify', C.EmailNotifier);
    const cd = (await s.getClassDiagram())!;
    expect(relations(cd, 'generalization')).toEqual(['generalization:EmailNotifier->Notifier']);
    expect(relations(cd, 'realization')).toEqual([]);
    expect(relations(cd, 'association')).toContain('association:UserService->Notifier:notifier');
    await s.revertImplementation('root/3:notify');
    await s.openMethod(await method('src/main.ts#<module>.bootstrap'));
    const boot = (await s.getClassDiagram())!;
    expect(relations(boot, 'dependency')).toContain('dependency:<module>->EmailNotifier:«create»');
  });

  it('FR-12.4 the class diagram follows every change of the sequence diagram', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const names = async () => (await s.getClassDiagram())!.classes.map((c) => c.name);
    expect(await names()).not.toContain('UserRepository');
    await s.expand('root/2:findUser');
    expect(await names()).toContain('UserRepository');
    await s.selectImplementation('root/2:findUser/0:findById', C.InMemoryUserRepository);
    expect(await names()).toContain('InMemoryUserRepository');
    expect(await names()).toContain('UserRepository'); // still reached through the interface
    await s.hide({ kind: 'class', classKey: C.Logger, className: 'Logger' });
    expect(await names()).not.toContain('Logger');
    await s.collapse('root/2:findUser');
    expect(await names()).not.toContain('InMemoryUserRepository');
    await s.openMethod(await method(K.audit));
    expect(await names()).toEqual(['AdminController', 'UserService', 'BillingService']);
  });
});

describe('FR-12.8 dependency rule in the class diagram (layers)', () => {
  const methodAt = async (key: string) => {
    const s = newSession();
    await s.openMethod(await method(key));
    return s;
  };

  it('flags an inner layer depending on an outer one (Domain → Infrastructure)', async () => {
    const cd = (await (await methodAt('src/domain/audit-entry.ts#AuditEntry.persist')).getClassDiagram())!;
    const rel = cd.relations.find((r) => r.from.endsWith('#AuditEntry') && r.to.endsWith('#Database'))!;
    expect(rel.violation).toBe('Domain → Infrastructure: an inner layer depends on an outer layer');
    expect(cd.layers).toEqual(['Domain', 'Infrastructure']);
  });

  it('does not flag adapters realizing ports or outer layers using inner ones', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    await s.selectImplementation('root/0:findById', C.SqlUserRepository);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.filter((r) => r.violation)).toEqual([]);
    expect(cd.layers).toEqual(['Application', 'Ports', 'Infrastructure']);
  });
});

describe('FR-12.9 relations know the calls they summarise', () => {
  it('a dependency/association lists every visible call behind it; «create» lists creations; realization none', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/0:findById', C.SqlUserRepository);
    const cd = (await s.getClassDiagram())!;
    const rel = (kind: string, from: string, to: string, label?: string) =>
      cd.relations.find((r) => r.kind === kind && r.from.endsWith(`#${from}`) && r.to.endsWith(`#${to}`) && (label === undefined || r.label === label))!;

    const logger = rel('dependency', 'UserController', 'Logger');
    expect(logger.calls!.map((c) => c.label)).toEqual(['getUser → info']);
    expect(logger.calls![0].callSite).toBeDefined();

    const create = rel('dependency', 'UserController', 'UserDto', '«create»');
    expect(create.calls!.map((c) => c.label)).toEqual(['getUser → new UserDto']);

    // two fields of the interface type: each association lists the call made through it
    const primary = rel('association', 'UserService', 'UserRepository', 'primary');
    const replica = rel('association', 'UserService', 'UserRepository', 'replica');
    expect(primary.calls!.map((c) => c.label)).toEqual(['findUser → findById']);
    expect(replica.calls!.map((c) => c.label)).toEqual(['findUser → findById']);
    expect(primary.calls![0].messageId).not.toBe(replica.calls![0].messageId);

    expect(rel('realization', 'SqlUserRepository', 'UserRepository').calls).toBeUndefined();
  });
});

describe('FR-12.10 obvious association names', () => {
  it('a field name is obvious when it only repeats the type (C#, TS, PHP conventions)', async () => {
    const { isObviousFieldName } = await import('../src/class-diagram');
    for (const [field, type] of [
      ['_coupon', 'Coupon'],
      ['_couponStore', 'ICouponStore'],
      ['userService', 'UserService'],
      ['#repo', 'Repo'],
      ['$repo', 'Repo'],
      ['m_store', 'Store<T>'],
      ['this._cache', 'ICache'],
    ]) expect(isObviousFieldName(field, type), `${field}: ${type}`).toBe(true);
    for (const [field, type] of [
      ['primary', 'IUserRepository'],
      ['_repo', 'UserRepository'],
      ['_items', 'Item'],
      ['_index', 'IndexService'],
    ]) expect(isObviousFieldName(field, type), `${field}: ${type}`).toBe(false);
  });

  it('obvious names are marked (views omit them); informative ones are not; "all" keeps every name', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    const cd = (await s.getClassDiagram())!;
    const assoc = (label: string) => cd.relations.find((r) => r.kind === 'association' && r.label === label)!;
    expect(assoc('userService').labelObvious).toBe(true);
    expect(assoc('primary').labelObvious).toBeUndefined();

    const { createClassifier } = await import('../src/classifier-impl');
    const { FIXTURE_ROOT } = await import('./helpers');
    const classifier = Object.assign(createClassifier(FIXTURE_ROOT), { associationNames: () => 'all' as const });
    const all = newSession({ classifier });
    await all.openMethod(await method(K.getUser));
    const cd2 = (await all.getClassDiagram())!;
    expect(cd2.relations.find((r) => r.label === 'userService')!.labelObvious).toBeUndefined();
  });
});

describe('FR-12.11 other methods of a class', () => {
  it('counts methods of the class that take no part in the visible interaction', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const cd = (await s.getClassDiagram())!;
    const svc = cd.classes.find((c) => c.name === 'UserService')!;
    expect(svc.methods.map((m) => m.name)).toEqual(['findUser']);
    expect(svc.otherMethodCount).toBeGreaterThan(0);
  });
});

describe('FR-12.13 class-diagram methods know where they run', () => {
  it('a method row carries its definition (the class that runs it) and the calls of the diagram that run it', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/0:findById', C.SqlUserRepository);
    const cd = (await s.getClassDiagram())!;
    const member = (cls: string, name: string) => cd.classes.find((c) => c.key.endsWith(`#${cls}`))!.methods.find((m) => m.name === name)!;

    const sql = member('SqlUserRepository', 'findById');
    expect(sql.declaration?.file).toMatch(/adapters\/sql-user-repository\.ts$/);
    // both findById calls (primary and replica) run it: the choice is remembered per interface (FR-8.4)
    expect(sql.calls!.map((c) => c.label)).toEqual(['from UserService.findUser', 'from UserService.findUser']);
    expect(sql.calls![0].callSite).toBeDefined();

    // the interface row lists every call through the interface, but has no definition of its own
    const port = member('UserRepository', 'findById');
    expect(port.declaration).toBeUndefined();
    expect(port.calls!.length).toBeGreaterThanOrEqual(1);
    expect(port.calls!.map((c) => c.messageId)).toContain(sql.calls![0].messageId);

    // the root method: run by the diagram's found message
    expect(member('UserController', 'getUser').calls!.map((c) => c.label)).toEqual(['diagram root']);
  });
});


describe('FR-5.11 methods an object inherits from its base class', () => {
  const emailNotify = 'src/notifications/notifier.ts#EmailNotifier.notify';

  it('FR-5.11 a call of an inherited method is a self call on the object, marked with the base class', async () => {
    const d = await newSession().openMethod(await method(emailNotify));
    const format = d.messages.find((m) => m.methodName === 'format')!;
    expect(format.kind).toBe('self');
    expect(format.inheritedFrom).toEqual({ key: C.Notifier, name: 'Notifier' });
    // the object's own calls are not marked
    expect(d.messages.find((m) => m.methodName === 'info')!.inheritedFrom).toBeUndefined();
    expect(d.participants.some((p) => p.classKey === C.Notifier)).toBe(false);
  });

  it('FR-5.11 the class diagram lists the inherited method in the base class, with a generalization to it', async () => {
    const s = newSession();
    await s.openMethod(await method(emailNotify));
    const cd = (await s.getClassDiagram())!;
    const base = cd.classes.find((c) => c.key === C.Notifier)!;
    expect(base).toMatchObject({ name: 'Notifier', kind: 'abstract' });
    expect(base.methods.map((m) => m.name)).toEqual(['format']);
    expect(base.methods[0]).toMatchObject({ signature: 'format(user: User, message: string): string', visibility: 'protected' });
    expect(cd.classes.find((c) => c.key === C.EmailNotifier)!.methods.map((m) => m.name)).toEqual(['notify']);
    expect(relations(cd, 'generalization')).toEqual(['generalization:EmailNotifier->Notifier']);
  });

  it('FR-5.11 through the chosen implementation: its own override is not marked, the base method it calls is', async () => {
    const s = newSession();
    let d = (await s.openMethod(await method(K.renameUser)))!;
    d = (await s.expandEverything())!;
    const notify = d.messages.find((m) => m.methodName === 'notify')!;
    d = (await s.selectImplementation(notify.id, C.EmailNotifier))!;
    d = (await s.expand(notify.id))!;
    expect(d.messages.find((m) => m.id === notify.id)!.inheritedFrom).toBeUndefined();
    const format = d.messages.find((m) => m.parentId === notify.id && m.methodName === 'format')!;
    expect(format.inheritedFrom).toEqual({ key: C.Notifier, name: 'Notifier' });
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.key === C.Notifier)!.methods.map((m) => m.name).sort()).toEqual(['format', 'notify']);
    expect(cd.classes.find((c) => c.key === C.EmailNotifier)!.methods.map((m) => m.name)).toEqual(['notify']);
  });
});
