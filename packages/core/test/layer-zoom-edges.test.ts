import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, Fragment, Message, Participant, SequenceDiagram } from '@seqcall/protocol';
import { projectClassLayers, projectLayers, zoomKey, zoomLabel } from '../src/layer-zoom';

const MEMBER = { kind: 'method' as const, name: 'm', change: 'changed' as const, text: 'm()' };

// FR-28 layer zoom on hand-made diagrams: the shapes at the edges (objects without a band, folded marks, minimized
// frames, stubs, exits, review counts, class packages of every kind).
const P = (id: string, layer: string | undefined, extra: Partial<Participant> = {}): Participant =>
  ({ id, classKey: `k#${id}`, className: id.toUpperCase(), label: `:${id.toUpperCase()}`, kind: 'class', stereotypes: [], ...(layer ? { layer } : {}), namespace: 'src/x', groupId: layer ? `g-${layer}` : 'g-none', ...extra }) as Participant;
const M = (id: string, from: string | null, to: string, extra: Partial<Message> = {}): Message =>
  ({
    id,
    parentId: id === 'root' ? null : id.slice(0, id.lastIndexOf('/')),
    depth: id === 'root' ? 0 : id.split('/').length - 1,
    kind: from === null ? 'found' : 'call',
    from,
    to,
    methodName: id.slice(id.lastIndexOf(':') + 1),
    args: [],
    expandable: false,
    expanded: false,
    ...extra,
  }) as Message;
const D = (participants: Participant[], messages: Message[], extra: Partial<SequenceDiagram> = {}): SequenceDiagram =>
  ({ root: { key: 'k', name: 'run', owner: { key: 'k#c', name: 'C', kind: 'class' }, isStatic: false, hasBody: true }, participants, groups: [], messages, hiddenFilters: [], ...extra }) as unknown as SequenceDiagram;
const ids = (d: SequenceDiagram) => d.messages.map((m) => m.id);

describe('FR-28.1 lifelines of objects without a layer', () => {
  it('FR-28.1 libraries, unresolved targets and folders each keep a lifeline of their own, named after the band', () => {
    expect([zoomKey({ kind: 'external', namespace: 'x' }), zoomLabel({ kind: 'external', namespace: 'x' })]).toEqual(['layer::libraries', 'Libraries']);
    expect([zoomKey({ kind: 'unknown', namespace: 'x' }), zoomLabel({ kind: 'unknown', namespace: 'x' })]).toEqual(['layer::unresolved', 'Unresolved']);
    expect([zoomLabel({ kind: 'class', namespace: 'src/util' }), zoomLabel({ kind: 'class', namespace: '' }), zoomLabel({ kind: 'class', namespace: 'odd/' })]).toEqual(['No layer · util', 'No layer · (root)', 'No layer · odd/']);
  });

  it('FR-28.1 objects of no listed band still get their lifeline; a layer whose objects are all pulled out has none', () => {
    const ps = [P('c', 'Presentation'), P('a', 'Application'), P('b', 'Application'), P('d', 'Domain')];
    const d = D(ps, [M('root', null, 'c'), M('root/0:x', 'c', 'a'), M('root/0:x/0:y', 'a', 'd')], { groups: [{ id: 'g-Presentation', label: 'P', layer: 'Presentation', namespace: '' }] as SequenceDiagram['groups'] });
    const z = projectLayers(d, new Set(), new Set(['d'])).diagram;
    expect(z.participants.map((p) => p.id)).toEqual(['layer:Presentation', 'layer:Application', 'd']);
    expect(z.groups.map((g) => g.id)).toEqual(['layer:Presentation', 'layer:Application', 'layer:Domain']);
  });

  it('FR-28.1 a layer of only new classes is new, of only removed objects removed; a review change of some objects changes it', () => {
    const ps = [P('c', 'Presentation'), P('a', 'Application', { change: { kind: 'new', members: [] }, diff: 'removed' }), P('b', 'Application', { change: { kind: 'new', members: [] }, diff: 'removed' }), P('d', 'Domain', { change: { kind: 'changed', members: [MEMBER] } }), P('e', 'Domain')];
    const z = projectLayers(D(ps, [M('root', null, 'c')])).diagram;
    const by = (id: string) => z.participants.find((p) => p.id === id)!;
    expect([by('layer:Application').change, by('layer:Application').diff]).toEqual([{ kind: 'new', members: [] }, 'removed']);
    expect(by('layer:Domain').change).toEqual({ kind: 'changed', members: [MEMBER] });
  });
});

describe('FR-28.2 folded calls', () => {
  it('FR-28.2 folded calls named by their object, own I/O of the crossing call, the best importance, review counts summed; a call to an object not drawn stays', () => {
    const ps = [P('c', 'Presentation'), P('a', 'Application'), P('b', 'Application')];
    const msgs = [
      M('root', null, 'c', { expanded: true }),
      M('root/0:x', 'c', 'a', { expanded: true, sideEffects: { kinds: ['http'], evidence: ['HTTP: a'] }, importance: { score: 1, reasons: ['r1'], low: true }, diff: { count: 1, positions: [{ n: 1 }] } }),
      M('root/0:x/0:y', 'a', 'b', { className: undefined, sideEffects: { kinds: ['db'], evidence: ['DB: b'] }, importance: { score: 5, reasons: ['r5'], low: false }, diff: { count: 2, positions: [{ n: 2 }], held: [4] } }),
      M('root/0:x/1:z', 'a', 'gone', { className: undefined }),
      M('root/0:x/2:w', 'a', 'b', { className: 'B', methodName: 'w' }),
    ];
    const z = projectLayers(D(ps, msgs, { reviewTotal: 3 })).diagram;
    const x = z.messages.find((m) => m.id === 'root/0:x')!;
    // a folded call without a class name: its object's
    expect(x.folded!.names).toEqual(['B.y', 'B.w']);
    // the call's own I/O is its own (not "below"), with the folded calls' I/O
    expect(x.sideEffects).toEqual({ kinds: ['db', 'http'], evidence: ['HTTP: a', 'DB: b'] });
    expect(x.importance).toEqual({ score: 5, reasons: ['r5'], low: false });
    expect(x.diff).toEqual({ count: 1, positions: [{ n: 1 }], folded: 2, held: [2, 4] });
    // a call to an object that is not drawn keeps its own target
    expect(ids(z)).toEqual(['root', 'root/0:x', 'root/0:x/1:z']);
    expect(z.messages[2].to).toBe('gone');
  });

  it('FR-28.2 without a review total: one step per folded change; a call without changes below keeps its marks', () => {
    const ps = [P('c', 'Presentation'), P('a', 'Application')];
    const msgs = [M('root', null, 'c', { expanded: true }), M('root/0:x', 'c', 'a', { expanded: true }), M('root/0:x/0:y', 'a', 'a', { diff: { inside: 2 } }), M('root/0:x/1:z', 'a', 'a', { diff: { inside: 1 }, expanded: true })];
    const x = projectLayers(D(ps, msgs)).diagram.messages[1];
    expect(x.diff).toEqual({ folded: 1 });
    const quiet = projectLayers(D(ps, [msgs[0], msgs[1], M('root/0:x/0:y', 'a', 'a')])).diagram.messages[1];
    expect(quiet).not.toHaveProperty('diff');
    // during a review a crossing call without changes of its own counts 0 itself
    const reviewed = projectLayers(D(ps, [msgs[0], msgs[1], M('root/0:x/0:y', 'a', 'a', { diff: { count: 2 } })], { reviewTotal: 2 })).diagram.messages[1];
    expect(reviewed.diff).toEqual({ folded: 2, count: 0 });
  });
});

describe('FR-28.4 frames, minimized frames, exits', () => {
  const ps = [P('c', 'Presentation'), P('a', 'Application'), P('b', 'Domain')];
  const base = [
    M('root', null, 'c', { expanded: true }),
    M('root/0:x', 'c', 'a', { expanded: true }),
    M('root/0:x/0:in', 'a', 'a'),
    M('root/0:x/1:out', 'a', 'b'),
    M('root/0:x/2:in2', 'a', 'a'),
    M('root/0:x/3:out2', 'a', 'b'),
  ];
  const frame = (id: string, owner: string, operands: Fragment['operands'], extra: Partial<Fragment> = {}): Fragment => ({ id, kind: 'opt', ownerMessageId: owner, operands, ...extra }) as Fragment;
  const op = (first: string, last: string, guard?: string) => ({ ...(guard !== undefined ? { guard } : {}), firstMessageId: first, lastMessageId: last });

  it('FR-28.4 a minimized frame keeps its stub where its owner is drawn, before the next drawn call; in a folded call it goes', () => {
    const fragments = [
      frame('root/0:x#if1', 'root/0:x', [op('root/0:x#if1', 'root/0:x#if1')], { collapsed: true, hiddenCount: 2, beforeId: 'root/0:x/2:in2', parentId: 'root/0:x#loop' }),
      // in a drawn frame; before the last folded call, nothing drawn after it
      frame('root/0:x#outer', 'root/0:x', [op('root/0:x/1:out', 'root/0:x/1:out')]),
      frame('root/0:x#if6', 'root/0:x', [op('root/0:x#if6', 'root/0:x#if6')], { collapsed: true, hiddenCount: 1, parentId: 'root/0:x#outer', beforeId: 'root/0:x/4:last' }),
      // a frame of a call that is not in the diagram
      frame('gone#if7', 'gone', [op('gone#if7', 'gone#if7')], { collapsed: true, hiddenCount: 1 }),
      frame('root/0:x/0:in#if2', 'root/0:x/0:in', [op('root/0:x/0:in#if2', 'root/0:x/0:in#if2')], { collapsed: true, hiddenCount: 1 }),
      frame('root/0:x#if3', 'root/0:x', [op('root/0:x#if3', 'root/0:x#if3')], { collapsed: true, hiddenCount: 1, beforeId: 'root/0:x#if1' }),
      frame('root/0:x#if4', 'root/0:x', [op('root/0:x#if4', 'root/0:x#if4')], { collapsed: true, hiddenCount: 1, beforeId: 'root/0:x/0:in#if2' }),
      frame('root/0:x#if5', 'root/0:x', [op('root/0:x#if5', 'root/0:x#if5')], { collapsed: true, hiddenCount: 1, beforeId: 'nowhere' }),
    ];
    const z = projectLayers(D(ps, [...base, M('root/0:x/4:last', 'a', 'a')], { fragments })).diagram;
    expect(z.fragments!.map((f) => `${f.id}${f.beforeId ? ` before ${f.beforeId}` : ''}${'parentId' in f ? ` in ${f.parentId}` : ''}`)).toEqual([
      // its parent frame is not drawn; the next drawn call after `in2` is `out2`
      'root/0:x#if1 before root/0:x/3:out2',
      'root/0:x#outer',
      'root/0:x#if6 in root/0:x#outer',
      // before a drawn stub; before a stub of a folded call (not drawn); before a call that is not in the diagram
      'root/0:x#if3 before root/0:x#if1',
      'root/0:x#if4',
      'root/0:x#if5',
    ]);
    expect(z.fragments!.find((f) => f.id === 'root/0:x#if4')).not.toHaveProperty('beforeId');
  });

  it('FR-28.4 operands: from a stub to a call, from a call to the end, ending at a stub; an alt left with its else only stays an alt', () => {
    const stub = frame('root/0:x#s', 'root/0:x', [op('root/0:x#s', 'root/0:x#s')], { collapsed: true, hiddenCount: 1 });
    const fragments = [
      stub,
      frame('root/0:x#a', 'root/0:x', [op('root/0:x#s', 'root/0:x/1:out', 'p')], { kind: 'alt' }),
      frame('root/0:x#b', 'root/0:x', [op('root/0:x/3:out2', 'root/0:x#s')]),
      frame('root/0:x#c', 'root/0:x', [op('root/0:x/0:in', 'root/0:x/0:in', 'q'), op('root/0:x/1:out', 'root/0:x/1:out', 'else')], { kind: 'alt' }),
      // an operand of only a stub that is not drawn, and one of calls not in the diagram: no frame
      frame('root/0:x#d', 'root/0:x', [op('root/0:x/0:in#nope', 'root/0:x/0:in#nope')]),
      frame('root/0:x#e', 'root/0:x', [op('missing', 'missing2')]),
      // from a call to a stub listed after it, and from a stub listed before
      frame('root/0:x#f', 'root/0:x', [op('root/0:x/1:out', 'missing')]),
      frame('root/0:x#g', 'root/0:x', [op('missing', 'root/0:x/1:out')]),
      // a frame of a call not in the diagram, though its operand names a drawn stub
      frame('gone#h', 'gone', [op('root/0:x#s', 'root/0:x#s')]),
    ];
    const z = projectLayers(D(ps, base, { fragments: [...fragments, frame('root/0:x/0:in#nope', 'root/0:x/0:in', [op('root/0:x/0:in#nope', 'root/0:x/0:in#nope')], { collapsed: true, hiddenCount: 1 })] })).diagram;
    const show = (f: Fragment) => `${f.id} ${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}] ${o.firstMessageId}..${o.lastMessageId}`).join(' ')}`;
    expect(z.fragments!.map(show)).toEqual([
      'root/0:x#s opt [] root/0:x#s..root/0:x#s',
      // an alt with one operand: drawn as opt
      'root/0:x#a opt [p] root/0:x#s..root/0:x/1:out',
      'root/0:x#b opt [] root/0:x/3:out2..root/0:x#s',
      'root/0:x#c alt [else] root/0:x/1:out..root/0:x/1:out',
      'root/0:x#f opt [] root/0:x/1:out..root/0:x/3:out2',
      'root/0:x#g opt [] root/0:x/1:out..root/0:x/1:out',
    ]);
  });

  it('FR-28.4 a diagram without frames or exits has none zoomed', () => {
    const z = projectLayers(D(ps, base)).diagram;
    expect(z).not.toHaveProperty('fragments');
    expect(z).not.toHaveProperty('exits');
    // exits of a drawn activation, before the next drawn call, or at its end
    const exits = [
      { id: 'root/0:x!e1', ownerMessageId: 'root/0:x', kind: 'return' as const, range: { file: 'f', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, beforeId: 'root/0:x/0:in' },
      { id: 'root/0:x!e2', ownerMessageId: 'root/0:x', kind: 'throw' as const, range: { file: 'f', start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
    ];
    expect(projectLayers(D(ps, base, { exits })).diagram.exits).toEqual([{ ...exits[0], beforeId: 'root/0:x/1:out' }, exits[1]]);
  });
});

describe('FR-28.5 issues on the zoomed diagrams', () => {
  it('FR-28.5 a finding without messages or classes stays as it is; a class not drawn keeps its own key', () => {
    const ps = [P('c', 'Presentation')];
    const z = projectLayers(D(ps, [M('root', null, 'c')], { findings: [{ id: 'f', kind: 'god-class', title: 't' }, { id: 'g', kind: 'god-class', title: 't', classKeys: ['k#gone', 'k#c'], messageIds: ['gone/0:x', 'root'] }] })).diagram;
    expect(z.findings).toEqual([{ id: 'f', kind: 'god-class', title: 't' }, { id: 'g', kind: 'god-class', title: 't', classKeys: ['k#gone', 'layer:Presentation'], messageIds: ['gone/0:x', 'root'] }]);
  });
});

describe('FR-28.5 the class diagram one level up', () => {
  const C = (key: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name: key.replace(/^.*#/, ''), kind: 'class', stereotypes: [], namespace: 'src/x', methods: [], ...extra });

  it('FR-28.5 packages in layer order, then layers not listed, folders, libraries, unresolved; their rows with the review marks', () => {
    const decl = { file: 'a.ts', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const cd: ClassDiagram = {
      classes: [
        C('k#U', { kind: 'unknown', namespace: 'unknown' }),
        C('k#L', { kind: 'external', namespace: 'lib' }),
        C('k#F', { namespace: 'src/util', diff: 'removed' }),
        C('k#X', { layer: 'Extra', change: { kind: 'changed', members: [MEMBER] }, declaration: decl }),
        C('k#A', { layer: 'Application', diff: 'added', sideEffects: { kinds: ['db'], evidence: ['DB'] } }),
      ],
      relations: [],
    };
    const z = projectClassLayers(cd, ['Application']);
    expect(z.classes.map((c) => `${c.key} ${c.methods.map((m) => `${m.name}${m.diff ? `:${m.diff}` : ''}${m.declaration ? '@' : ''}`).join(',')}`)).toEqual([
      'layer:Application A:added',
      'layer:Extra X:changed@',
      'layer::src/util F:removed',
      'layer::libraries L',
      'layer::unresolved U',
    ]);
    const app = z.classes[0];
    expect([app.sideEffects, app.diff]).toEqual([{ kinds: ['db'], evidence: ['DB'] }, 'added']);
    expect(z.classes[1].change).toEqual({ kind: 'changed', members: [MEMBER] });
  });

  it('FR-28.5 merged relations: names of classes not drawn, realizations, extends, one violation of one, a shared review mark; relations to unknown classes go', () => {
    const cd: ClassDiagram = {
      classes: [C('k#A', { layer: 'Application' }), C('k#D', { layer: 'Domain' }), C('k#E', { layer: 'Domain' })],
      relations: [
        { id: 'r1', kind: 'realization', from: 'k#A', to: 'k#D', diff: 'added' },
        { id: 'r2', kind: 'realization', from: 'k#A', to: 'k#E', diff: 'added', violation: 'x' },
        { id: 'r3', kind: 'generalization', from: 'k#D', to: 'k#A' },
        { id: 'r4', kind: 'association', from: 'k#D', to: 'k#A' },
        { id: 'r5', kind: 'dependency', from: 'k#A', to: 'k#gone' },
      ],
      findings: [{ id: 'f', kind: 'god-class', title: 't' }, { id: 'g', kind: 'dependency-cycle', title: 't', classKeys: ['k#gone'], relationIds: ['r5', 'r1'] }],
    };
    const z = projectClassLayers(cd, ['Application', 'Domain']);
    const rel = (id: string) => z.relations.find((r) => r.id === id)!;
    expect(rel('rel:layer:Application→layer:Domain')).toMatchObject({ kind: 'realization', count: 2, diff: 'added', violation: '1 of 2 relations break the dependency rule: x' });
    expect(rel('rel:layer:Application→layer:Domain').calls!.map((c) => [c.messageId, c.label])).toEqual([
      ['', 'A → D (implements)'],
      ['', 'A → E (implements) ⚠'],
    ]);
    expect(rel('rel:layer:Domain→layer:Application')).toMatchObject({ kind: 'dependency', count: 2 });
    expect(rel('rel:layer:Domain→layer:Application').calls!.map((c) => c.label)).toEqual(['D → A (extends)', 'D → A']);
    expect(rel('rel:layer:Domain→layer:Application')).not.toHaveProperty('diff');
    expect(z.findings).toEqual([{ id: 'f', kind: 'god-class', title: 't' }, { id: 'g', kind: 'dependency-cycle', title: 't', classKeys: ['k#gone'], relationIds: ['rel:layer:Application→layer:Domain'] }]);
    // a violation of one relation alone
    const one = projectClassLayers({ classes: cd.classes, relations: [{ id: 'v', kind: 'dependency', from: 'k#D', to: 'k#A', violation: 'y' }] }, ['Application', 'Domain']);
    expect(one.relations[0].violation).toBe('1 of 1 relation break the dependency rule: y');
    expect(one).not.toHaveProperty('findings');
  });
});
