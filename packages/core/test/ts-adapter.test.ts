import { beforeAll, describe, expect, it } from 'vitest';
import type { CallSite } from '../src/adapter';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { C, FIXTURE_ROOT, K, file, method, positionOf, sharedAdapter } from './helpers';

const adapter = sharedAdapter();
const calls = async (key: string): Promise<CallSite[]> => await adapter.getOutgoingCalls(await method(key));

beforeAll(async () => {
  await adapter.getMethod(K.getUser); // warm up the program
});

describe('TsAdapter: enclosing callable (FR-1.1, FR-1.2)', () => {
  it('FR-1.1 finds the method enclosing a position inside its body', async () => {
    const m = await adapter.findEnclosingCallable(file('src/controllers/user-controller.ts'), positionOf('src/controllers/user-controller.ts', 'Logger.info(`getUser'));
    expect(m?.key).toBe(K.getUser);
    expect(m?.owner).toMatchObject({ key: C.UserController, name: 'UserController', kind: 'class' });
    expect(m?.hasBody).toBe(true);
    expect(m?.declaration?.file).toBe(file('src/controllers/user-controller.ts'));
  });

  it('FR-1.1 a position inside a callback resolves to the enclosing method, not the arrow', async () => {
    const m = await adapter.findEnclosingCallable(file('src/controllers/user-controller.ts'), positionOf('src/controllers/user-controller.ts', 'slugify(t)'));
    expect(m?.key).toBe(K.getUser);
  });

  it.each([
    ['static method', 'src/util/logger.ts', 'Logger.write(\'INFO\'', 'src/util/logger.ts#Logger.info', true],
    ['constructor', 'src/services/billing-service.ts', 'private readonly gateway', 'src/services/billing-service.ts#BillingService.constructor', false],
    ['getter', 'src/domain/user.ts', 'this.name.trim()', 'src/domain/user.ts#User.displayName', false],
    ['top-level function', 'src/util/format.ts', 'slugify(user.name)', K.formatName, false],
    ['const arrow function', 'src/util/format.ts', "replace(/\\s+/g", K.slugify, false],
    ['const function expression', 'src/util/format.ts', 's.toUpperCase()', 'src/util/format.ts#<module>.shout', false],
    ['JS class method', 'src/legacy/report.js', 'formatName(user)', K.generate, false],
  ])('FR-1.2 supports %s', async (_kind, rel, needle, key, isStatic) => {
    const m = await adapter.findEnclosingCallable(file(rel), positionOf(rel, needle));
    expect(m?.key).toBe(key);
    expect(m?.isStatic).toBe(isStatic);
  });

  it('FR-1.2 module-level functions belong to a «module» owner', async () => {
    expect((await method(K.formatName)).owner).toMatchObject({ key: C.format, name: 'format', kind: 'module' });
  });

  it('FR-1.1 returns undefined outside any callable', async () => {
    expect(await adapter.findEnclosingCallable(file('src/util/format.ts'), { line: 0, character: 0 })).toBeUndefined();
  });
});

describe('TsAdapter: outgoing calls', () => {
  it('FR-1.4 calls appear in evaluation order; nested argument calls precede the enclosing call', async () => {
    expect((await calls(K.getUser)).map((c) => `${c.kind}:${c.methodName}`)).toEqual([
      'call:validate',
      'call:info',
      'call:findUser',
      'call:formatName',
      'create:constructor',
      'call:map',
      'call:slugify',
      'call:stringify',
    ]);
  });

  it('FR-1.11 calls inside a callback passed to a library function follow the receiving call, in a loop scope', async () => {
    const c = await calls(K.getUser);
    expect(c.map((x) => x.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const slug = c.find((x) => x.methodName === 'slugify')!;
    expect(slug.ordinal).toBe(c.find((x) => x.methodName === 'map')!.ordinal + 1);
    expect(slug.fragments?.map((f) => [f.kind, f.guard])).toEqual([['loop', "each t of ['a', 'b']"]]);
    expect(slug.argOrigins?.[0]).toEqual({ kind: 'parameter', name: 't' });
  });

  it('FR-1.5 this-calls have a self receiver; fields, statics and module functions are classified', async () => {
    const [validate, info, findUser, formatName, create] = await calls(K.getUser);
    expect(validate.receiver).toEqual({ kind: 'self' });
    expect(validate.target?.key).toBe('src/controllers/user-controller.ts#UserController.validate');
    expect(info.receiver).toEqual({ kind: 'static' });
    expect(info.target).toMatchObject({ key: 'src/util/logger.ts#Logger.info', isStatic: true });
    expect(findUser.receiver).toEqual({ kind: 'field', name: 'userService' });
    expect(findUser.receiverType?.key).toBe(C.UserService);
    expect(findUser.target?.key).toBe(K.findUser);
    expect(formatName.receiver.kind).toBe('module');
    expect(formatName.target?.key).toBe(K.formatName);
    expect(create.receiver).toEqual({ kind: 'none' });
    expect(create.receiverType?.key).toBe(C.UserDto);
    expect(create.target?.key).toBe('src/domain/user-dto.ts#UserDto.constructor');
    expect(create.args).toEqual(['user.name', 'formatName(user)']);
  });

  it('FR-1.9 awaited / promise-returning calls are marked async', async () => {
    const byName = Object.fromEntries((await calls(K.getUser)).map((c) => [c.methodName, c]));
    expect(byName.findUser.isAsync).toBe(true);
    expect(byName.validate.isAsync).toBe(false);
    // not awaited but returns a Promise
    expect((await calls(K.audit)).find((c) => c.methodName === 'bill')?.isAsync).toBe(true);
  });

  it('FR-1.6 library calls are flagged with their library name', async () => {
    const lib = (await calls(K.getUser)).filter((c) => c.isLibrary);
    expect(lib.map((c) => c.methodName)).toEqual(['map', 'stringify']);
    expect(lib.every((c) => c.libraryName === 'lib' && c.target?.owner.kind === 'external')).toBe(true);
    expect(lib[0].target?.owner.key).toBe('lib:lib');
  });

  it('FR-1.8 unresolvable calls (any) have no target', async () => {
    const print = (await calls(K.generate)).find((c) => c.methodName === 'print');
    expect(print?.target).toBeUndefined();
    expect(print?.expressionText).toBe('this.printer.print(line)');
  });

  it('FR-1.2 plain JS code calling into TS resolves through JSDoc types and imports', async () => {
    const [findUser, formatName] = await calls(K.generate);
    expect(findUser.target?.key).toBe(K.findUser);
    expect(formatName.target?.key).toBe(K.formatName);
  });

  it('FR-8.1 calls through an interface-typed field target the interface member (no body)', async () => {
    const [replica, primary] = await calls(K.findUser);
    expect(replica.receiver).toEqual({ kind: 'field', name: 'replica' });
    expect(primary.receiver).toEqual({ kind: 'field', name: 'primary' });
    expect(replica.target).toMatchObject({ key: K.findById, hasBody: false });
    expect(replica.target?.owner.kind).toBe('interface');
  });

  it('FR-1.2 constructors include parameter defaults; singleton access chains have expression receivers', async () => {
    const ctor = await calls('src/services/billing-service.ts#BillingService.constructor');
    expect(ctor.map((c) => c.kind)).toEqual(['create']);
    expect(ctor[0].receiverType?.key).toBe(C.StripeGateway);
    const sql = await calls(K.sqlFindById);
    expect(sql[0]).toMatchObject({ methodName: 'getInstance', receiver: { kind: 'static' } });
    expect(sql[1]).toMatchObject({ methodName: 'query', receiver: { kind: 'expression', text: 'Database.getInstance()' } });
    expect(sql[1].target?.key).toBe('src/infrastructure/database.ts#Database.query');
  });
});

describe('TsAdapter: implementations, callers, class info', () => {
  it('FR-8.2 interface members map to implementing class members', async () => {
    const impls = await adapter.getImplementations(await method(K.findById));
    expect(impls.map((i) => i.key)).toEqual([K.memFindById, K.sqlFindById]);
    expect(impls.every((i) => i.hasBody)).toBe(true);
  });

  it('FR-8.2 abstract members map to overriding members', async () => {
    expect((await adapter.getImplementations(await method(K.notify))).map((i) => i.owner.key)).toEqual([C.EmailNotifier, C.SmsNotifier]);
  });

  it('FR-8.5 single-implementation interface', async () => {
    const charge = (await adapter.getMethod('src/services/billing-service.ts#PaymentGateway.charge'))!;
    expect((await adapter.getImplementations(charge)).map((i) => i.owner.key)).toEqual([C.StripeGateway]);
  });

  it('FR-4.1 callers list every call site with enclosing method, location and preview', async () => {
    const callers = await adapter.getCallers(await method(K.findUser));
    expect(callers.map((c) => c.enclosing.key).sort()).toEqual(
      [K.audit, K.getUser, K.generate, K.managementChain, K.rename].sort(),
    );
    const fromAdmin = callers.find((c) => c.enclosing.key === K.audit)!;
    expect(fromAdmin.preview).toBe('const user = await this.users.findUser(id);');
    expect(fromAdmin.range.file).toBe(file('src/controllers/admin-controller.ts'));
    expect(fromAdmin.range.start.line).toBe(positionOf('src/controllers/admin-controller.ts', 'this.users.findUser').line);
    expect(new Set(callers.map((c) => c.id)).size).toBe(callers.length);
  });

  it('FR-4.1 callers of a constructor are the new-expressions', async () => {
    const callers = await adapter.getCallers(await method('src/domain/user-dto.ts#UserDto.constructor'));
    expect(callers.map((c) => c.enclosing.key)).toEqual([K.getUser]);
  });

  it('FR-12.18 private / #name / protected members and a module\'s not exported functions are marked', async () => {
    const vis = async (key: string, name: string) => (await adapter.getClassInfo(key))!.methods.find((m) => m.name === name)?.visibility;
    expect(await vis(C.UserController, 'validate')).toBe('private');
    expect(await vis(C.UserController, 'getUser')).toBeUndefined();
    expect(await vis(C.Notifier, 'format')).toBe('protected');
    expect(await vis(C.Database, 'constructor')).toBe('private');
    const archive = 'src/application/archive.ts#<module>';
    expect(await vis(archive, 'summary')).toBe('private');
    expect(await vis(archive, 'archiveAll')).toBeUndefined();
  });

  it('FR-7.1 class info: decorators, injected fields, singleton and static traits', async () => {
    const svc = (await adapter.getClassInfo(C.UserService))!;
    expect(svc.decorators).toEqual(['Injectable']);
    expect(svc.fields.map((f) => [f.name, f.type?.key, f.injected])).toEqual([
      ['primary', C.UserRepository, true],
      ['replica', C.UserRepository, true],
      ['notifier', C.Notifier, true],
    ]);
    expect(svc.methods.find((m) => m.name === 'findUser')?.signature).toBe('findUser(id: string): Promise<User>');

    const db = (await adapter.getClassInfo(C.Database))!;
    expect(db).toMatchObject({ hasPrivateConstructor: true, hasStaticInstance: true, allMembersStatic: false });
    expect((await adapter.getClassInfo(C.Logger))?.allMembersStatic).toBe(true);
    expect((await adapter.getClassInfo(C.BillingService))?.isExportedInstance).toBe(true);
    expect((await adapter.getClassInfo(C.SqlUserRepository))?.implements.map((i) => i.key)).toEqual([C.UserRepository]);
    expect((await adapter.getClassInfo(C.EmailNotifier))?.extends?.key).toBe(C.Notifier);
    expect((await adapter.getClassInfo(C.UserRepository))?.ref.kind).toBe('interface');
    expect((await adapter.getClassInfo(C.Notifier))?.ref.kind).toBe('abstract');
    // JS-style DI: this.userService = userService (typed via JSDoc)
    expect((await adapter.getClassInfo(C.ReportGenerator))?.fields.find((f) => f.name === 'userService')).toMatchObject({
      injected: true,
      type: { key: C.UserService },
    });
  });
});

describe('TsAdapter: incremental updates (FR-13.1)', () => {
  it('FR-13.1 updateFile re-analyses changed content', async () => {
    const a = createTsAdapter(FIXTURE_ROOT);
    const rel = 'src/util/format.ts';
    const f = file(rel);
    expect((await a.getOutgoingCalls((await a.getMethod(K.formatName))!)).map((c) => c.methodName)).toEqual(['slugify']);
    await a.updateFile(f, `export function formatName(u: { name: string }): string { return shout(u.name) + slugify(u.name); }
export const slugify = (s: string): string => s;
export const shout = (s: string): string => s;`);
    expect((await a.getOutgoingCalls((await a.getMethod(K.formatName))!)).map((c) => c.methodName)).toEqual(['shout', 'slugify']);
    await a.updateFile(f); // back to disk content
    expect((await a.getOutgoingCalls((await a.getMethod(K.formatName))!)).map((c) => c.methodName)).toEqual(['slugify']);
    await a.dispose();
  });
});
