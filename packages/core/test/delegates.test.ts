import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { method, newSession, sharedAdapter } from './helpers';

const REL = 'src/services/format-service.ts';
const FORMAT_ALL = `${REL}#FormatService.formatAll`;
const RENDER = `${REL}#FormatService.render`;
const EACH = `${REL}#FormatService.each`;

const label = (d: SequenceDiagram, id: string) => {
  const m = d.messages.find((x) => x.id === id)!;
  const to = d.participants.find((p) => p.id === m.to)!;
  return `${m.viaParameter ? `${m.viaParameter}⇒` : ''}${m.methodName} → ${to.className}${m.viaLambda ? ' (lambda)' : ''}${m.expandable ? ' [+]' : ''}`;
};

describe('TsAdapter: function parameters and function arguments (FR-1.13)', () => {
  it('FR-1.13 reports invoked parameters and functions passed as arguments', async () => {
    const each = await sharedAdapter().getOutgoingCalls(await method(EACH));
    expect(each.find((c) => c.methodName === 'f')).toMatchObject({ invokedParameter: 'f', target: undefined });
    const all = await sharedAdapter().getOutgoingCalls(await method(FORMAT_ALL));
    const renders = all.filter((c) => c.methodName === 'render');
    expect(renders[0].argFunctions?.[1]).toMatchObject({ kind: 'method', target: { key: `${REL}#UserFormat.plain` }, receiver: { kind: 'static' }, isLibrary: false });
    expect(renders[1].argFunctions?.[1]).toMatchObject({ kind: 'method', target: { key: `${REL}#FormatService.shout` }, receiver: { kind: 'self' } });
    expect(renders[2].argFunctions?.[1]).toMatchObject({ kind: 'lambda' });
    // a parameter passed on is not a function value: it is bound through argOrigins
    const render = await sharedAdapter().getOutgoingCalls(await method(RENDER));
    expect(render.find((c) => c.methodName === 'each')!.argFunctions).toBeUndefined();
  });
});

describe('DiagramSession: delegate / function parameters (FR-1.13)', () => {
  it('FR-1.13 invoking a parameter resolves to the method the caller passed, also when passed on', async () => {
    const s = newSession();
    await s.openMethod(await method(FORMAT_ALL));
    await s.expand('root/0:render');
    const d = (await s.expand('root/0:render/1:each'))!;
    // f(user) inside each(), two hops below where UserFormat.plain was passed
    expect(label(d, 'root/0:render/1:each/0:f')).toBe('f⇒plain → UserFormat [+]');
    const m = d.messages.find((x) => x.id === 'root/0:render/1:each/0:f')!;
    expect(m.methodKey).toBe(`${REL}#UserFormat.plain`);
    expect(m.targetDeclaration).toEqual((await method(`${REL}#UserFormat.plain`)).declaration);
    // expandable like a direct call
    const e = (await s.expand(m.id))!;
    expect(e.messages.some((x) => x.parentId === m.id && x.methodName === 'info')).toBe(true);
    // and in the class diagram as a real member
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.name === 'UserFormat')!.methods.map((x) => x.name)).toContain('plain');
    // FR-1.13 `f: (user: User) => string` is an inline port of each(): running f gives each() no dependency on
    // UserFormat. FR-19.18 (2026-10-19) but formatAll wrote `UserFormat.plain`: its class depends on UserFormat, the
    // relation's call is formatAll's `render(users, UserFormat.plain)` (where it was handed over), not `f(user)`
    const rel = cd.relations.filter((r) => r.from === `${REL}#FormatService` && r.to === `${REL}#UserFormat`);
    expect(rel.map((r) => [r.kind, r.calls?.map((c) => c.label)])).toEqual([['dependency', ['formatAll → plain']]]);
    expect(rel[0].calls![0].callSite).toEqual(d.messages.find((x) => x.id === 'root/0:render')!.callSite);
  });

  it('FR-19.18 a static method of another class handed in through a parameter: the writer depends on that class, the receiver does not', async () => {
    const s = newSession();
    await s.openMethod(await method(RENDER));
    const d = (await s.expand('root/1:each'))!;
    // rooted at render(): the method arrives as render's own parameter — nobody in the diagram wrote it
    expect(label(d, 'root/1:each/0:f')).toMatch(/^f⇒/);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.filter((r) => r.to === `${REL}#UserFormat`)).toEqual([]);
  });

  it('FR-1.13 a method of the caller passed as this.m is a call to the caller object', async () => {
    const s = newSession();
    await s.openMethod(await method(FORMAT_ALL));
    await s.expand('root/1:render');
    const d = (await s.expand('root/1:render/1:each'))!;
    expect(label(d, 'root/1:render/1:each/0:f')).toBe('f⇒shout → FormatService [+]');
    const m = d.messages.find((x) => x.id === 'root/1:render/1:each/0:f')!;
    // the root's FormatService object, not a second lifeline
    expect(m.to).toBe(d.messages[0].to);
  });

  it('FR-1.13 a lambda or an unknown caller: a self-call labelled with the parameter, never «unknown»', async () => {
    const s = newSession();
    await s.openMethod(await method(FORMAT_ALL));
    await s.expand('root/2:render');
    const d = (await s.expand('root/2:render/1:each'))!;
    expect(label(d, 'root/2:render/1:each/0:f')).toBe('f⇒f → FormatService (lambda)');
    const rooted = await newSession().openMethod(await method(EACH));
    const f = rooted.messages.find((x) => x.viaParameter === 'f')!;
    expect(f).toMatchObject({ kind: 'self', expandable: false, methodName: 'f' });
    expect(f.methodKey).toBeUndefined();
    expect(rooted.participants.some((p) => p.className === 'unknown')).toBe(false);
    // message ids do not depend on the binding
    expect(f.id).toBe('root/0:f');
  });
});

describe('Class diagram: function-typed ports invoked as parameters (FR-1.13)', () => {
  it('FR-1.13 the use case depends on its own port type, not on the adapter interface the caller named', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method('src/application/scan.ts#<module>.scanAll'));
    expect(calls.find((c) => c.invokedParameter === 'listBranches')?.invokedParameterType).toMatchObject({ key: 'src/application/scan.ts#BranchLister', name: 'BranchLister' });

    const s = newSession();
    await s.openMethod(await method('src/controllers/scan-command.ts#<module>.runScan'));
    const scan = s.current()!.messages.find((m) => m.methodName === 'scanAll')!;
    const d = (await s.expand(scan.id))!;
    const via = d.messages.find((m) => m.parentId === scan.id && m.viaParameter === 'listBranches')!;
    expect(via.port).toEqual({ key: 'src/application/scan.ts#BranchLister', name: 'BranchLister' });
    expect(via.methodKey).toMatch(/^src\/adapters\/git-host\.ts#/); // still the real implementation

    const cd = (await s.getClassDiagram())!;
    const port = cd.classes.find((c) => c.key === 'src/application/scan.ts#BranchLister')!;
    expect(port).toMatchObject({ kind: 'interface', layer: 'Application' });
    expect(port.methods.map((m) => m.name)).toEqual(['listBranches']);
    const scanModule = 'src/application/scan.ts#<module>';
    expect(cd.relations.find((r) => r.from === scanModule && r.to === port.key)).toMatchObject({ kind: 'dependency' });
    expect(cd.relations.some((r) => r.kind === 'realization' && r.to === port.key && r.from.startsWith('src/adapters/git-host.ts#'))).toBe(true);
    // the adapter's own GitHost interface is not what the use case depends on
    expect(cd.relations.some((r) => r.from === scanModule && r.to === 'src/adapters/git-host.ts#GitHost')).toBe(false);
    expect(cd.relations.filter((r) => r.violation)).toEqual([]);
  });
});

describe('Callers: methods passed as arguments (FR-4.5)', () => {
  const PLAIN = `${REL}#UserFormat.plain`;

  it('FR-4.5 a function passed as an argument has the receiving call as caller, flagged passed', async () => {
    const callers = await sharedAdapter().getCallers(await method(PLAIN));
    const byEnclosing = (name: string) => callers.find((c) => c.enclosing.name === name)!;
    expect(byEnclosing('shout').passed).toBeUndefined(); // a direct call
    expect(byEnclosing('formatAll')).toMatchObject({ passed: true });
    expect(byEnclosing('formatAll').preview).toContain('this.render(users, UserFormat.plain)');
    expect(byEnclosing('first')).toMatchObject({ passed: true });
  });

  it('FR-4.5 re-rooting at a passed caller expands the receiving call and its invocation of the method', async () => {
    const s = newSession();
    await s.openMethod(await method(PLAIN));
    const callers = await s.getCallers('root');
    const first = callers.find((c) => c.enclosing.name === 'first')!;
    const d = (await s.reroot('root', first.id))!;
    expect(d.root.name).toBe('first');
    const applyTo = d.messages.find((m) => m.methodName === 'applyTo')!;
    expect(applyTo.expanded).toBe(true);
    const f = d.messages.find((m) => m.parentId === applyTo.id && m.viaParameter === 'f')!;
    expect(f).toMatchObject({ methodKey: PLAIN, expanded: true });
    expect(d.messages.some((m) => m.parentId === f.id && m.methodName === 'info')).toBe(true); // plain's body
  });
});
