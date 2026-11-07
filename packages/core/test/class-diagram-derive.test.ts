import { describe, expect, it } from 'vitest';
import type { Message, Participant } from '@seqcall/protocol';
import type { ClassInfo } from '../src/adapter';
import { deriveClassDiagram, type ClassDiagramInput } from '../src/class-diagram';

// FR-12 the class diagram derived from a sequence diagram, on hand-built flows: without the optional classification
// (a caller that has none), several objects of one class, ports, inherited methods two levels up.
const part = (id: string, classKey: string, extra: Partial<Participant> = {}): Participant =>
  ({ id, classKey, className: classKey.replace(/^.*#/, ''), label: id, kind: 'class', stereotypes: [], namespace: 'ns', groupId: 'g', ...extra }) as Participant;
const msg = (id: string, from: string | null, to: string, extra: Partial<Message> = {}): Message =>
  ({
    id,
    parentId: id === 'root' ? null : id.slice(0, id.lastIndexOf('/')),
    depth: id.split('/').length - 1,
    kind: id === 'root' ? 'found' : 'call',
    from,
    to,
    methodName: id.slice(id.lastIndexOf(':') + 1),
    methodKey: `k:${id}`,
    args: [],
    ...extra,
  }) as Message;
const info = (key: string, kind: 'class' | 'abstract' = 'class', extra: Partial<ClassInfo> = {}): Partial<ClassInfo> => ({
  ref: { key, name: key.replace(/^.*#/, ''), kind },
  implements: [],
  fields: [],
  methods: [],
  ...extra,
});
const derive = (participants: Participant[], messages: Message[], infos: Record<string, Partial<ClassInfo>> = {}, extra: Partial<ClassDiagramInput> = {}) =>
  deriveClassDiagram({ participants, messages, participantMeta: new Map(), classInfo: (k) => infos[k] as ClassInfo | undefined, ...extra });

describe('FR-12 the class diagram of a flow, without classification', () => {
  it('FR-12.3 the interface lists only what is called through it, not the implementation\'s own self / inherited calls', () => {
    const svc = part('svc', 'svc.ts#Svc');
    const impl = part('impl', 'impl.ts#Impl', { implementsInterface: { key: 'port.ts#Port', name: 'Port' } });
    const cd = derive(
      [svc, impl],
      [
        msg('root', null, 'svc'),
        msg('root/0:fetch', 'svc', 'impl'),
        msg('root/0:fetch/0:buildRequest', 'impl', 'impl', { kind: 'self' }),
        msg('root/0:fetch/1:postAsync', 'impl', 'impl', { kind: 'self', inheritedFrom: { key: 'base.ts#ApiClientBase', name: 'ApiClientBase' } }),
      ],
      { 'base.ts#ApiClientBase': info('base.ts#ApiClientBase', 'abstract') },
    );
    const methods = (key: string) => cd.classes.find((c) => c.key === key)?.methods.map((m) => m.name);
    expect(methods('port.ts#Port')).toEqual(['fetch']);
    // the base class is not drawn: the object's box keeps the inherited method (FR-5.11)
    expect(methods('impl.ts#Impl')).toEqual(['fetch', 'buildRequest', 'postAsync']);
  });

  it('FR-12.2 two objects of one class are one box with the stereotypes and reasons of both', () => {
    const a1 = part('a1', 'a.ts#A', { stereotypes: ['service'] });
    const a2 = part('a2', 'a.ts#A', { stereotypes: ['service', 'static'], stereotypeReasons: [{ stereotype: 'static', text: 'called statically' }] });
    const a3 = part('a3', 'a.ts#A', { stereotypeReasons: [{ stereotype: 'static', text: 'again' }, { stereotype: 'seam', text: 'injected' }] });
    const cd = derive([a1, a2, a3], [msg('root', null, 'a1')]);
    expect(cd.classes).toHaveLength(1);
    expect(cd.classes[0].stereotypes).toEqual(['service', 'static']);
    expect(cd.classes[0].stereotypeReasons).toEqual([{ stereotype: 'static', text: 'called statically' }, { stereotype: 'seam', text: 'injected' }]);
  });

  it('FR-12.3 an interface behind the chosen implementation and a function-type port: their own kind, the namespace of the object', () => {
    const svc = part('svc', 'svc.ts#Svc');
    const impl = part('impl', 'impl.ts#Impl', { implementsInterface: { key: 'port.ts#Port', name: 'Port' } });
    const base = part('base', 'b.ts#B', { implementsInterface: { key: 'abs.ts#Abs', name: 'Abs' } });
    const cd = derive(
      [svc, impl, base],
      [
        msg('root', null, 'svc'),
        msg('root/0:save', 'svc', 'impl'),
        msg('root/1:run', 'svc', 'base'),
        // a parameter of a named function type, invoked: a port; without the parameter's name the method's
        msg('root/2:list', 'svc', 'impl', { port: { key: 'lister.ts#Lister', name: 'Lister' } }),
      ],
      { 'abs.ts#Abs': info('abs.ts#Abs', 'abstract') },
    );
    const box = (key: string) => cd.classes.find((c) => c.key === key)!;
    expect([box('port.ts#Port').kind, box('port.ts#Port').stereotypes, box('port.ts#Port').namespace]).toEqual(['interface', ['interface'], 'ns']);
    expect([box('abs.ts#Abs').kind, box('abs.ts#Abs').stereotypes]).toEqual(['abstract', ['abstract']]);
    expect(box('lister.ts#Lister')).toMatchObject({ kind: 'interface', stereotypes: ['interface'], namespace: '' });
    expect(box('lister.ts#Lister').methods.map((m) => m.name)).toEqual(['list']);
    expect(cd.relations.map((r) => `${r.kind} ${r.from} ${r.to}`)).toContain('generalization b.ts#B abs.ts#Abs');
  });

  it('FR-5.11 a method inherited from two levels up: the classes between; a base without class info named by its key', () => {
    const obj = part('o', 'c.ts#Leaf');
    const inherited = [msg('root', null, 'o'), msg('root/0:save', 'o', 'o', { kind: 'self', inheritedFrom: { key: 'a.ts#Root', name: 'Root' } })];
    const cd = derive([obj], inherited, {
      'c.ts#Leaf': info('c.ts#Leaf', 'class', { extends: { key: 'b.ts#Mid', name: 'Mid', kind: 'class' } }),
      'b.ts#Mid': info('b.ts#Mid', 'class', { extends: { key: 'a.ts#Root', name: 'Root', kind: 'abstract' } }),
      'a.ts#Root': info('a.ts#Root', 'abstract'),
    });
    expect(cd.classes.map((c) => `${c.name} ${c.kind} [${c.stereotypes.join(',')}] ${c.namespace}`)).toEqual(['Leaf class [] ns', 'Mid class [] ns', 'Root abstract [abstract] ns']);
    expect(cd.classes.find((c) => c.name === 'Root')!.methods.map((m) => m.name)).toEqual(['save']);
    // the base's class info is not known: its box is named by its key, the chain ends there, the row stays on the object
    const unknown = derive([obj], inherited, { 'c.ts#Leaf': info('c.ts#Leaf', 'class', { extends: { key: 'b.ts#Mid', name: 'Mid', kind: 'class' } }) });
    expect(unknown.classes.map((c) => `${c.name} ${c.kind} ${c.methods.map((m) => m.name).join(',')}`)).toEqual(['Leaf class root,save', 'Mid class ']);
  });

  it('FR-12.13 a call row without a call site; called from the diagram root, or from a caller without a class', () => {
    const a = part('a', 'a.ts#A');
    const b = part('b', 'b.ts#B');
    const cd = derive([a, b], [msg('root', null, 'a'), msg('root/0:go', 'a', 'b'), msg('root/0:go/0:go2', 'x', 'b')]);
    const rows = cd.classes.find((c) => c.key === 'b.ts#B')!.methods;
    expect(rows.find((m) => m.name === 'go')!.calls).toStrictEqual([{ messageId: 'root/0:go', label: 'from A.root' }]);
    // the sender is no participant (dropped from the view): the class the parent call reached
    expect(rows.find((m) => m.name === 'go2')!.calls).toStrictEqual([{ messageId: 'root/0:go/0:go2', label: 'from ?.go' }]);
  });

  it('FR-12.13 the caller named by the class of the call that runs it when the sender is gone', () => {
    const a = part('a', 'a.ts#A');
    const b = part('b', 'b.ts#B');
    const cd = derive([a, b], [msg('root', null, 'a', { className: 'Entry' }), msg('root/0:go', 'gone', 'b')]);
    expect(cd.classes.find((c) => c.key === 'b.ts#B')!.methods[0].calls).toStrictEqual([{ messageId: 'root/0:go', label: 'from Entry.root' }]);
    // a call in a constructor body: from the constructor
    // (a creation named after the class, as `new B()` reads)
    const ctor = derive([a, b], [msg('root', null, 'a'), msg('root/0:B', 'a', 'b', { kind: 'create' }), msg('root/0:B/0:init', 'b', 'a')]);
    expect(ctor.classes.find((c) => c.key === 'a.ts#A')!.methods.find((m) => m.name === 'init')!.calls![0].label).toBe('from B.constructor');
  });

  it('FR-12.3 a creation of a class without a name, a call whose caller is not in the list; a static class\'s constructor is no static member', () => {
    const a = part('a', 'a.ts#A');
    const b = part('b', 'b.ts#B', { stereotypes: ['static'] });
    const cd = derive([a, b], [msg('root', null, 'a'), msg('root/0:constructor', 'a', 'b', { kind: 'create' }), msg('lost/0:go', 'a', 'b')]);
    const rel = (label?: string) => cd.relations.find((r) => r.from === 'a.ts#A' && r.to === 'b.ts#B' && r.label === label)!;
    expect(rel('«create»').calls).toEqual([{ messageId: 'root/0:constructor', label: 'root → new', callSite: undefined }]);
    expect(rel(undefined).calls).toEqual([{ messageId: 'lost/0:go', label: '? → go', callSite: undefined }]);
    expect(cd.classes.find((c) => c.key === 'b.ts#B')!.methods.map((m) => `${m.name} ${m.isStatic}`)).toEqual(['constructor false', 'go true']);
  });

  it('FR-12.12 type uses: one relation per used type listing every use; the own base type is that relation; unclassified used types', () => {
    const a = part('a', 'a.ts#A');
    const range = { file: 'a.ts', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
    const run = { key: 'a.ts#A.run', name: 'run', owner: { key: 'a.ts#A', name: 'A', kind: 'class' }, isStatic: false, hasBody: true } as never;
    const t = (key: string) => ({ type: { key, name: key.replace(/^.*#/, ''), kind: 'class' as const }, range });
    const cd = derive([a], [msg('root', null, 'a')], { 'a.ts#A': info('a.ts#A', 'class', { extends: { key: 'base.ts#Base', name: 'Base', kind: 'class' }, implements: [{ key: 'i.ts#I', name: 'I', kind: 'interface' }] }) }, {
      typeUses: [
        { method: run, messageId: 'root', uses: [t('e.ts#Status'), t('base.ts#Base'), t('i.ts#I')] },
        { method: run, uses: [t('e.ts#Status')] },
      ],
    });
    expect(cd.relations.map((r) => `${r.kind} ${r.to}`)).toEqual(['use e.ts#Status', 'generalization base.ts#Base', 'realization i.ts#I']);
    expect(cd.relations[0].uses).toStrictEqual([{ method: 'A.run', range, messageId: 'root' }, { method: 'A.run', range }]);
    expect(cd.classes.find((c) => c.key === 'e.ts#Status')).toMatchObject({ stereotypes: [], namespace: '', usedOnly: true });
  });
});

