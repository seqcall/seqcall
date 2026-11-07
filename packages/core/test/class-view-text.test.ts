import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, SourceRange } from '@seqcall/protocol';
import { classViewText } from '../src/flow-text';
import { FIXTURE_ROOT, K, newSession } from './helpers';

const at = (file: string, line: number): SourceRange => ({ file: `/p/${file}`, start: { line, character: 0 }, end: { line, character: 1 } });
const node = (key: string, name: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name, kind: 'class', stereotypes: [], namespace: '', methods: [], ...extra });

describe('FR-25.4 Share → Copy as text (class diagram)', () => {
  it('FR-25.4 the classes of the shown flow by layer, the methods it runs with file:line, relations with the calls behind them; hidden rules named', async () => {
    const s = newSession();
    await s.openMethodByKey(K.getUser);
    await s.expand(s.current()!.messages.find((m) => m.methodName === 'findUser')!.id);
    await s.selectImplementation(s.current()!.messages.find((m) => m.methodName === 'findById')!.id, 'src/adapters/sql-user-repository.ts#SqlUserRepository');
    await s.hide({ kind: 'class', classKey: 'src/util/logger.ts#Logger', className: 'Logger' });
    const text = classViewText(FIXTURE_ROOT, (await s.getClassDiagram())!, s.current());
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Seqcall class diagram of UserController.getUser: the classes in the shown calls');
    expect(text).toContain([
      '[Presentation]',
      '  UserController  «controller»  src/controllers/user-controller.ts:9',
      '    getUser(id: string): Promise<string>  src/controllers/user-controller.ts:12',
      '    - validate(id: string): void  src/controllers/user-controller.ts:27',
      '    (+1 method not in this flow)',
    ].join('\n'));
    // the kind only when no stereotype says it
    expect(lines).toContain('  UserRepository  «interface»«repository»«port»  src/ports/user-repository.ts:4');
    expect(text).toContain('  UserController has UserService\n    getUser → findUser  src/controllers/user-controller.ts:15');
    expect(lines).toContain('  SqlUserRepository implements UserRepository');
    expect(text).not.toMatch(/^ *Logger\b/m); // no class box for the hidden class
    expect(lines.at(-1)).toBe('hidden: calls to Logger (1)');
  });

  it('FR-25.4 packages, kinds, static members, I/O, violations, multiplicities, long call lists and issues; no layers: no headings', () => {
    const d: ClassDiagram = {
      classes: [
        node('a#Shop', 'Shop', { declaration: at('shop.ts', 0), sideEffects: { kinds: ['db', 'http'] } as ClassNode['sideEffects'], methods: [{ name: 'run', isStatic: true, signature: '' }, { name: 'p', isStatic: false, signature: 'p()', visibility: 'protected' }] }),
        node('a#Base', 'Base', { kind: 'abstract' }),
        node('a#Orders', 'orders', { group: { path: 'orders', classes: 2 }, methods: [{ name: 'Order', isStatic: false, signature: 'Order', declaration: at('orders/order.ts', 4) }], otherMethodCount: 3 }),
      ],
      relations: [
        { id: '1', kind: 'association', from: 'a#Shop', to: 'a#Orders', label: 'orders', multiplicity: '*', violation: 'Domain → Infrastructure' },
        { id: '2', kind: 'generalization', from: 'a#Shop', to: 'a#Base', label: 'base', labelObvious: true },
        { id: '3', kind: 'use', from: 'a#Shop', to: 'lib:x#Gone' },
        { id: '4', kind: 'dependency', from: 'a#Shop', to: 'a#Base', calls: [1, 2, 3, 4, 5].map((n) => ({ messageId: `m${n}`, label: `run → f${n}`, ...(n === 1 ? { callSite: at('shop.ts', 9) } : {}) })) },
      ],
      findings: [{ id: 'f', kind: 'dependency-cycle', title: 'Dependency cycle: Shop → Base → Shop', classKeys: ['a#Shop', 'a#Base'] }],
    };
    expect(classViewText('/p', d)).toBe([
      '# Seqcall class diagram: the classes in the shown calls',
      'Shop  I/O: DB,HTTP  shop.ts:1',
      '  static run',
      '  # p()',
      'abstract Base',
      'package orders',
      '  Order  orders/order.ts:5',
      '  (+3 methods not in this flow)',
      'relations (4):',
      '  Shop has orders orders [*]  ⚠ Domain → Infrastructure',
      '  Shop extends Base',
      '  Shop uses Gone',
      '  Shop calls Base',
      '    run → f1  shop.ts:10',
      '    run → f2',
      '    run → f3',
      '    +2 more calls',
      'issues (1):',
      '  ⚠ Dependency cycle: Shop → Base → Shop  (dependency-cycle)',
    ].join('\n'));
  });

  it('FR-25.4 a layer the diagram does not list still gets its heading; unlayered classes after the layers; no relations, no issues', () => {
    const d: ClassDiagram = {
      classes: [node('a#A', 'A', { layer: 'Domain' }), node('a#B', 'B', { layer: 'Web' }), node('a#C', 'C', { kind: 'unknown' })],
      relations: [],
      layers: ['Web', 'Infrastructure'],
    };
    expect(classViewText('/p', d)).toBe(['# Seqcall class diagram: the classes in the shown calls', '[Web]', '  B', '[Domain]', '  A', '[no layer]', '  C', 'relations: none', 'issues: none among these classes'].join('\n'));
    // every class in a layer: no "[no layer]"; a relation from a class not drawn is named by its key
    const layered: ClassDiagram = { classes: [node('a#B', 'B', { layer: 'Web' })], relations: [{ id: '1', kind: 'dependency', from: 'lib:x#Ext', to: 'a#B' }], layers: ['Web'] };
    expect(classViewText('/p', layered).split('\n').slice(1, 5)).toEqual(['[Web]', '  B', 'relations (1):', '  Ext calls B']);
  });
});
