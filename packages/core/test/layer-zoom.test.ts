import { describe, expect, it } from 'vitest';
import type { ClassDiagram, SequenceDiagram } from '@seqcall/protocol';
import { projectClassLayers, projectLayers } from '../src/layer-zoom';
import * as path from 'node:path';
import { createClassifier } from '../src/classifier-impl';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { DEFAULT_OPTIONS, DiagramSession } from '../src/session';
import { K, method, newSession } from './helpers';
// FR-3.12 these tests check the frames and calls as the code has them: ↯ Fold errors off
const UNFOLDED = { initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } };

const IMPORT_ALL = 'src/services/import-service.ts#ImportService.importAll';

const ids = (d: SequenceDiagram) => d.messages.map((m) => m.id);
const byId = (d: SequenceDiagram, id: string) => d.messages.find((m) => m.id === id)!;

/** The projected tree is a valid pre-order tree over drawn ids: every parent is drawn and comes before its children. */
function expectWellFormed(d: SequenceDiagram): void {
  const seen = new Set<string>();
  const lifelines = new Set(d.participants.map((p) => p.id));
  for (const m of d.messages) {
    if (m.parentId !== null) expect(seen.has(m.parentId)).toBe(true);
    seen.add(m.id);
    expect(lifelines.has(m.to)).toBe(true);
    if (m.from) expect(lifelines.has(m.from)).toBe(true);
  }
  expect(d.messages[0].id).toBe('root');
  for (const f of d.fragments ?? []) {
    expect(seen.has(f.ownerMessageId)).toBe(true);
    for (const op of f.operands) {
      const stub = (id: string) => d.fragments!.some((x) => x.id === id && x.collapsed);
      // an operand may also start / end at an early exit of its owner (a guard's `return`)
      const exit = (id: string) => (d.exits ?? []).some((e) => e.id === id && e.ownerMessageId === f.ownerMessageId);
      if (!stub(op.firstMessageId) && !exit(op.firstMessageId)) expect(byId(d, op.firstMessageId).parentId).toBe(f.ownerMessageId);
      if (!stub(op.lastMessageId) && !exit(op.lastMessageId)) expect(byId(d, op.lastMessageId).parentId).toBe(f.ownerMessageId);
    }
  }
  for (const e of d.exits ?? []) expect(seen.has(e.ownerMessageId)).toBe(true);
  for (const g of d.groups) expect(d.participants.some((p) => p.groupId === g.id)).toBe(true);
}

describe('FR-28 layer zoom: the sequence diagram one level up', () => {
  it('FR-28.10 a call between layer lifelines names the objects behind them; an end drawn as itself (opened layer) does not', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    await s.expandAll();
    const zoomed = (await s.setOption('layerZoom', true))!;
    const replica = 'src/ports/user-repository.ts#UserRepository|field:src/services/user-service.ts#UserService.replica';
    expect(byId(zoomed, 'root/2:findUser/0:findById').objects).toEqual({
      from: { id: 'src/services/user-service.ts#UserService|field:src/controllers/user-controller.ts#UserController.userService', label: ':UserService', layer: 'Application' },
      to: { id: replica, label: 'replica:UserRepository', layer: 'Ports' },
    });
    // the root has no sender; an object without a layer has none either
    expect(byId(zoomed, 'root').objects).toEqual({ to: expect.objectContaining({ label: ':UserController', layer: 'Presentation' }) });
    expect(byId(zoomed, 'root/1:info').objects!.to).toEqual({ id: 'src/util/logger.ts#Logger|static', label: 'Logger' });
    // Application opened in place: its object is drawn as itself — only the other end is named
    const open = (await s.setLayerOpen('layer:Application', true))!;
    expect(byId(open, 'root/2:findUser').objects).toEqual({ from: expect.objectContaining({ label: ':UserController' }) });
    expect(byId(open, 'root/2:findUser/0:findById').objects).toEqual({ to: expect.objectContaining({ id: replica }) });
    // not zoomed: nothing
    expect((await s.setOption('layerZoom', false))!.messages.some((m) => m.objects)).toBe(false);
  });

  it('FR-28.1 one lifeline per layer in band order, objects without a layer keep their band; the objects are listed', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    await s.expandAll();
    const d = (await s.setOption('layerZoom', true))!;
    expect(d.options.layerZoom).toBe(true);
    // (an `Unresolved` band follows when the flow has unresolved calls)
    expect(d.participants.slice(0, 5).map((p) => [p.id, p.label])).toEqual([
      ['layer:Presentation', 'Presentation'],
      ['layer:Application', 'Application'],
      ['layer:Ports', 'Ports'],
      ['layer:Domain', 'Domain'],
      ['layer::src/util', 'No layer · util'],
    ]);
    expect(d.groups.slice(0, 5).map((g) => g.label)).toEqual(['Presentation', 'Application', 'Ports', 'Domain', 'No layer · util']);
    const ports = d.participants.find((p) => p.id === 'layer:Ports')!;
    expect(ports.stereotypes).toEqual(['2 objects']);
    expect(d.participants.find((p) => p.id === 'layer:Domain')!.stereotypes).toEqual([]);
    expect(ports.objects?.map((o) => o.label)).toEqual(['replica:UserRepository', 'primary:UserRepository']);
    expect(ports.layer).toBe('Ports');
    expect(ports.groupId).toBe('layer:Ports');
    expectWellFormed(d);
  });

  it('FR-28.2 only calls that cross a layer are drawn; the calls inside a layer fold into the crossing call (+n, names), their crossing calls re-parent to it', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    await s.expandAll();
    const plain = s.current()!;
    expect(ids(plain)).toContain('root/0:validate'); // a self call of the controller
    const d = (await s.setOption('layerZoom', true))!;
    expect(ids(d)).not.toContain('root/0:validate');
    // its call to the logger crosses to the util band: drawn, now a direct child of the root
    const error = byId(d, 'root/0:validate/0:error');
    expect(error).toMatchObject({ parentId: 'root', depth: 1, from: 'layer:Presentation', to: 'layer::src/util' });
    expect(byId(d, 'root').folded).toMatchObject({ count: 1, names: ['UserController.validate'], expandable: 0 });
    // FR-23.6 the full list for Find: id, name, the object to pull out
    expect(byId(d, 'root').folded!.calls).toEqual([{ id: 'root/0:validate', name: 'UserController.validate', participant: plain.messages.find((m) => m.id === 'root/0:validate')!.to }]);
    // the same ids as the object diagram: nothing renamed
    for (const m of d.messages) expect(plain.messages.some((x) => x.id === m.id)).toBe(true);
    // Application → Ports stays, with the real target
    expect(byId(d, 'root/2:findUser/0:findById')).toMatchObject({ from: 'layer:Application', to: 'layer:Ports', parentId: 'root/2:findUser', depth: 2 });
    expectWellFormed(d);
  });

  it('FR-28.3 ⊕ on an open call whose folded calls are still collapsed opens them (one level); zooming out keeps the expansion', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.renameUser));
    await s.expandAll();
    let d = (await s.setOption('layerZoom', true))!;
    // the controller's `rename` (→ Application) folds the service's own `findUser`, still collapsed: ⊕ although `rename` is open
    const rename = byId(d, 'root/1:rename');
    expect(rename.folded).toMatchObject({ count: 1, names: ['UserService.findUser'], expandable: 1 });
    expect(rename).toMatchObject({ expandable: true, expanded: false });
    expect(ids(d)).not.toContain('root/1:rename/0:findUser');
    d = (await s.expand('root/1:rename'))!;
    expect(byId(d, 'root/1:rename')).toMatchObject({ folded: { count: 1, names: ['UserService.findUser'], expandable: 0 }, expanded: true });
    // findUser's call to the port crosses: drawn under `rename`
    expect(byId(d, 'root/1:rename/0:findUser/0:findById')).toMatchObject({ parentId: 'root/1:rename', depth: 2, from: 'layer:Application', to: 'layer:Ports' });
    expectWellFormed(d);
    // back to the objects: the expansion stays
    const plain = (await s.setOption('layerZoom', false))!;
    expect(ids(plain)).toContain('root/1:rename/0:findUser/0:findById');
    expect(plain.participants.every((p) => !p.objects)).toBe(true);
    expect(plain.messages.every((m) => !m.folded)).toBe(true);
  });

  it('FR-28.4 fragments and exits follow the drawn calls: operands span the kept direct children, frames without a drawn call are dropped', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(IMPORT_ALL));
    const plain = (await s.expandAll())!;
    expect(plain.fragments!.map((f) => f.kind)).toEqual(['loop', 'alt', 'opt', 'try']);
    const d = (await s.setOption('layerZoom', true))!;
    const describe = (x: SequenceDiagram) => x.fragments!.map((f) => `${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}] ${o.firstMessageId.slice(o.firstMessageId.lastIndexOf(':') + 1)}..${o.lastMessageId.slice(o.lastMessageId.lastIndexOf(':') + 1)}`).join(' ')}`);
    // every call of importAll crosses a layer (service → port / notifier / logger): the frames stay as they were
    expect(describe(d)).toEqual(describe(plain));
    expectWellFormed(d);
    // getUser: the opt [!id] is in validate's body (folded): it now frames the drawn logger call under the root
    const s2 = newSession(UNFOLDED);
    await s2.openMethod(await method(K.getUser));
    await s2.expandAll();
    await s2.expandAll();
    const z = (await s2.setOption('layerZoom', true))!;
    const opt = z.fragments!.find((f) => f.operands[0].guard === '!id')!;
    expect(opt.ownerMessageId).toBe('root');
    expect(opt.operands[0]).toMatchObject({ firstMessageId: 'root/0:validate/0:error', lastMessageId: 'root/0:validate/0:error' });
    // the early exits of findUser (drawn) stay; none of a folded method
    expect(z.exits!.every((e) => z.messages.some((m) => m.id === e.ownerMessageId))).toBe(true);
    expectWellFormed(z);
  });

  it('FR-28.7 a layer opened in place: its objects on their own lifelines (their own calls drawn), the other layers folded; the class diagram follows; folding again restores the lifeline', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.renameUser));
    await s.expandAll();
    await s.setOption('layerZoom', true);
    let d = (await s.setLayerOpen('layer:Application', true))!;
    expect(d.options.openLayers).toEqual(['layer:Application']);
    const svc = d.participants.find((p) => p.className === 'UserService')!;
    expect(svc).toMatchObject({ inLayer: { key: 'layer:Application', name: 'Application' }, groupId: expect.stringContaining('Application') });
    expect(svc.objects).toBeUndefined();
    expect(d.participants.map((p) => p.id)).toContain('layer:Presentation');
    expect(d.groups.find((g) => g.id === svc.groupId)!.label).toContain('Application · ');
    // the controller's `rename` now goes to the object; the service's own `findUser` is drawn (a self call), not folded
    expect(byId(d, 'root/1:rename')).toMatchObject({ from: 'layer:Presentation', to: svc.id });
    expect(byId(d, 'root/1:rename').folded).toBeUndefined();
    expect(byId(d, 'root/1:rename/0:findUser')).toMatchObject({ from: svc.id, to: svc.id, parentId: 'root/1:rename' });
    expect(byId(d, 'root/1:rename/2:save')).toMatchObject({ from: svc.id, to: 'layer:Ports' });
    expectWellFormed(d);
    const cd = (await s.getClassDiagram())!;
    const cls = cd.classes.find((c) => c.name === 'UserService')!;
    expect(cls).toMatchObject({ kind: 'class', inLayer: { key: 'layer:Application', name: 'Application' } });
    expect(cls.group).toBeUndefined();
    expect(cd.classes.find((c) => c.key === 'layer:Application')).toBeUndefined();
    expect(cd.relations.some((r) => r.from === 'layer:Presentation' && r.to === cls.key)).toBe(true);
    expect(cd.relations.some((r) => r.from === cls.key && r.to === 'layer:Ports')).toBe(true);
    d = (await s.setLayerOpen('layer:Application', false))!;
    expect(d.options.openLayers).toEqual([]);
    expect(d.participants.find((p) => p.id === 'layer:Application')!.objects!.map((o) => o.className)).toContain('UserService');
    expect(byId(d, 'root/1:rename').folded).toMatchObject({ count: 1 });
    // FR-28.8 an opened layer is all of its objects out: putting one back closes the layer and leaves the others out;
    // folding the layer (the band's ⊖) puts the pulled-out ones back too
    d = (await s.setLayerOpen('layer:Application', true))!;
    const others = d.participants.filter((p) => p.inLayer?.key === 'layer:Application' && p.id !== svc.id).map((p) => p.id);
    expect(others.length).toBeGreaterThan(0);
    d = (await s.setLayerOpen(svc.id, false))!;
    expect(d.options.openLayers).toEqual([]);
    expect([...(d.options.openObjects ?? [])].sort()).toEqual([...others].sort());
    expect(d.participants.find((p) => p.id === 'layer:Application')!.objects!.map((o) => o.id)).toEqual([svc.id]);
    expect(d.participants.filter((p) => p.inLayer?.alone).map((p) => p.id).sort()).toEqual([...others].sort());
    d = (await s.setLayerOpen('layer:Application', false))!;
    expect(d.options.openObjects).toEqual([]);
    expect(d.participants.find((p) => p.id === 'layer:Application')!.objects!.length).toBe(others.length + 1);
  });

  it('FR-28.9 Fold all layers: every opened layer folded and every pulled-out object back, the zoom stays on; both diagrams follow', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.renameUser));
    await s.expandAll();
    let d = (await s.setOption('layerZoom', true))!;
    const repo = d.participants.find((p) => p.id === 'layer:Ports')!.objects![0].id;
    await s.setLayerOpen('layer:Application', true);
    d = (await s.setLayerOpen(repo, true))!;
    expect([d.options.openLayers, d.options.openObjects]).toEqual([['layer:Application'], [repo]]);
    d = (await s.foldAllLayers())!;
    expect([d.options.layerZoom, d.options.openLayers, d.options.openObjects]).toEqual([true, [], []]);
    expect(d.participants.some((p) => p.inLayer)).toBe(false);
    expect(d.participants.find((p) => p.id === 'layer:Application')!.objects!.map((o) => o.className)).toContain('UserService');
    expect((await s.getClassDiagram())!.classes.every((c) => c.group?.zoom)).toBe(true);
    expectWellFormed(d);
  });

  it('FR-28.8 one object pulled out of its layer: beside the layer’s lifeline (which stands for the rest), its calls to the rest drawn; a class key pulls out every object of the class', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(K.renameUser));
    await s.expandAll();
    await s.setOption('layerZoom', true);
    const svcId = (await s.setOption('layerZoom', true))!.participants.find((p) => p.id === 'layer:Application')!.objects!.find((o) => o.className === 'UserService')!.id;
    let d = (await s.setLayerOpen(svcId, true))!;
    expect(d.options.openObjects).toEqual([svcId]);
    expect(d.options.openLayers ?? []).toEqual([]);
    const svc = d.participants.find((p) => p.id === svcId)!;
    expect(svc).toMatchObject({ groupId: 'layer:Application', inLayer: { key: 'layer:Application', name: 'Application', alone: true } });
    const app = d.participants.find((p) => p.id === 'layer:Application')!;
    expect(app.objects!.some((o) => o.id === svcId)).toBe(false); // the lifeline stands for the rest
    expect(d.participants.indexOf(svc)).toBe(d.participants.indexOf(app) + 1);
    // the service's call to its own layer's BillingService... (none here) — its own calls are drawn, its crossing ones too
    expect(byId(d, 'root/1:rename')).toMatchObject({ from: 'layer:Presentation', to: svcId });
    expect(byId(d, 'root/1:rename/0:findUser')).toMatchObject({ from: svcId, to: svcId });
    expectWellFormed(d);
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.name === 'UserService')!.inLayer).toEqual({ key: 'layer:Application', name: 'Application', alone: true });
    expect(cd.classes.find((c) => c.key === 'layer:Application')!.group!.classes).toBeGreaterThanOrEqual(1);
    // put back by the class key (what the class view sends)
    d = (await s.setLayerOpen(svc.classKey, false))!;
    expect(d.options.openObjects).toEqual([]);
    expect(d.participants.find((p) => p.id === 'layer:Application')!.objects!.some((o) => o.id === svcId)).toBe(true);
  });

  it('FR-28.5 findings point at the drawn calls; the class diagram shows one package per layer with merged relations and the same issues', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(IMPORT_ALL));
    await s.expandAll();
    const d = (await s.setOption('layerZoom', true))!;
    const violation = d.findings!.find((f) => f.kind === 'layer-violation')!;
    expect(violation.title).toContain('ImportService → Notifier');
    expect(violation.messageIds).toEqual(['root/3:notify']);
    expect(violation.classKeys).toEqual(['layer:Application', 'layer:Infrastructure']); // the lifelines, so the view can mark them
    expect(violation.id).toBe(s.current()!.findings![0].id); // unchanged: a host's copy of the issue still matches
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.map((c) => [c.key, c.name, c.group?.classes, c.methods.map((m) => m.name)])).toEqual([
      ['layer:Application', 'Application', 1, ['ImportService']],
      ['layer:Ports', 'Ports', 1, ['UserRepository']],
      ['layer:Infrastructure', 'Infrastructure', 1, ['Notifier']],
      ['layer::src/util', 'No layer · util', 1, ['Logger']],
    ]);
    expect(cd.classes.every((c) => c.group?.zoom && c.kind === 'module')).toBe(true);
    const broken = cd.relations.find((r) => r.violation)!;
    expect(broken).toMatchObject({ id: 'rel:layer:Application→layer:Infrastructure', from: 'layer:Application', to: 'layer:Infrastructure', count: 1 });
    expect(broken.calls?.[0]).toMatchObject({ messageId: 'root/3:notify', label: 'ImportService → Notifier (notifier) ⚠' });
    const issue = cd.findings!.find((f) => f.kind === 'layer-violation')!;
    expect(issue.classKeys).toEqual(['layer:Application', 'layer:Infrastructure']);
    expect(issue.relationIds).toEqual(['rel:layer:Application→layer:Infrastructure']);
    expect(cd.layers).toEqual(['Application', 'Ports', 'Infrastructure']);
  });
});

describe('FR-28 layer zoom: I/O badges (FR-17) propagate to the lifelines, the drawn calls and the packages', () => {
  const IO_ROOT = path.resolve(__dirname, '../../../fixtures/io-app').replace(/\\/g, '/');

  it('FR-28.1 / FR-28.2 / FR-28.5 the file I/O of FileNotes shows on its layer lifeline, on the drawn call that folds the call, and on its package', async () => {
    const adapter = createTsAdapter(IO_ROOT);
    try {
      const s = new DiagramSession({ adapter, classifier: createClassifier(IO_ROOT) });
      let d = (await s.openMethodByKey('src/controllers/note-controller.ts#NoteController.show'))!;
      d = (await s.expand(d.messages.find((m) => m.methodName === 'load')!.id))!;
      const plainFile = d.participants.find((p) => p.className === 'FileNotes')!;
      expect(plainFile.sideEffects?.kinds).toEqual(['file']);
      const z = (await s.setOption('layerZoom', true))!;
      const lifeline = z.participants.find((p) => p.objects?.some((o) => o.className === 'FileNotes'))!;
      expect(lifeline.sideEffects?.kinds).toContain('file');
      expect(z.messages.some((m) => m.sideEffects?.kinds.includes('file'))).toBe(true);
      const cd = (await s.getClassDiagram())!;
      const pkg = cd.classes.find((c) => c.group?.zoom && c.methods.some((m) => m.name === 'FileNotes'))!;
      expect(pkg.sideEffects?.kinds).toContain('file');
    } finally {
      await adapter.dispose();
    }
  });
});

describe('FR-28 layer zoom: the projection on a hand-made diagram', () => {
  const participant = (id: string, layer: string | undefined, label: string, extra: Partial<SequenceDiagram['participants'][number]> = {}): SequenceDiagram['participants'][number] => ({
    id, classKey: `k#${id}`, className: label.replace(/^.*:/, ''), label, kind: 'class', stereotypes: [], ...(layer ? { layer } : {}), namespace: 'src/x', groupId: layer ? `g-${layer}` : 'g-none', ...extra,
  });
  const msg = (id: string, parentId: string | null, from: string | null, to: string, extra: Partial<SequenceDiagram['messages'][number]> = {}): SequenceDiagram['messages'][number] => ({
    id, parentId, depth: id === 'root' ? 0 : id.split('/').length - 1, kind: from === null ? 'found' : from === to ? 'self' : 'call', from, to, methodName: id.slice(id.lastIndexOf(':') + 1), args: [], isAsync: false, isLibrary: false, expandable: false, expanded: false, recursive: false, ...extra,
  });
  const diagram = (): SequenceDiagram => ({
    root: { key: 'k', name: 'run', owner: { key: 'k#c', name: 'C', kind: 'class' }, isStatic: false, hasBody: true },
    participants: [participant('c', 'Presentation', ':C'), participant('s1', 'Application', ':S1', { sideEffects: { kinds: ['http'], evidence: ['HTTP: fetch'] } }), participant('s2', 'Application', ':S2', { diff: 'added' }), participant('r', 'Infrastructure', ':R', { diff: 'added' })],
    groups: [{ id: 'g-Presentation', label: 'Presentation · src/x', layer: 'Presentation', namespace: 'src/x' }, { id: 'g-Application', label: 'Application · src/x', layer: 'Application', namespace: 'src/x' }, { id: 'g-Infrastructure', label: 'Infrastructure · src/x', layer: 'Infrastructure', namespace: 'src/x' }],
    messages: [
      msg('root', null, null, 'c', { expandable: true, expanded: true }),
      msg('root/0:a', 'root', 'c', 's1', { expandable: true, expanded: true, sideEffects: { kinds: ['db'], evidence: ['DB: x'], below: true } }),
      msg('root/0:a/0:b', 'root/0:a', 's1', 's2', { expandable: true, expanded: true, diff: { call: true } }),
      msg('root/0:a/0:b/0:save', 'root/0:a/0:b', 's2', 'r', { sideEffects: { kinds: ['db'], evidence: ['DB: save'] } }),
      msg('root/0:a/1:c', 'root/0:a', 's1', 's2', { expandable: true, expanded: false, importance: { score: 9, reasons: ['crosses'], low: false } }),
      msg('root/1:d', 'root', 'c', 's1', { kind: 'create' }),
    ],
    hiddenFilters: [],
    options: { showArguments: false, maxArgumentLength: 30, showLibraryCalls: false, followCursor: false, layerZoom: true },
    canGoBack: false,
    canGoForward: false,
    fragments: [{ id: 'root/0:a#loop0@0', kind: 'loop', ownerMessageId: 'root/0:a', operands: [{ guard: 'each x of xs', firstMessageId: 'root/0:a/0:b', lastMessageId: 'root/0:a/1:c' }] }],
    exits: [{ id: 'root/0:a/0:b!exit0', ownerMessageId: 'root/0:a/0:b', kind: 'return', range: { file: 'f', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }],
    findings: [{ id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop', messageIds: ['root/0:a/0:b/0:save', 'root/0:a/0:b'] }],
  });

  it('FR-28.2 folds the calls inside a layer, aggregating I/O, importance and review marks onto the crossing call', () => {
    const { diagram: d, folded } = projectLayers(diagram());
    expect(ids(d)).toEqual(['root', 'root/0:a', 'root/0:a/0:b/0:save', 'root/1:d']);
    const a = byId(d, 'root/0:a');
    expect(a.folded).toMatchObject({ count: 2, names: ['S2.b', 'S2.c'], expandable: 1 });
    expect(folded.get('root/0:a')).toEqual(['root/0:a/0:b', 'root/0:a/1:c']);
    // I/O of the folded calls joins the call's own (what it already knew from below stays `below`)
    expect(a.sideEffects).toEqual({ kinds: ['db'], evidence: ['DB: x'], below: true });
    expect(a.importance).toEqual({ score: 9, reasons: ['crosses'], low: false });
    expect(a.diff).toEqual({ folded: 1 }); // FR-24.9 the changed call b folded in here is a step of the review
    // still collapsed calls inside: ⊕ although the call is open
    expect(a).toMatchObject({ expandable: true, expanded: false });
    expect(byId(d, 'root/0:a/0:b/0:save')).toMatchObject({ parentId: 'root/0:a', depth: 2, from: 'layer:Application', to: 'layer:Infrastructure' });
    expect(byId(d, 'root/1:d')).toMatchObject({ kind: 'create', from: 'layer:Presentation', to: 'layer:Application' });
    expectWellFormed(d);
  });

  it('FR-28.1 a layer lifeline carries the union of its objects’ I/O and the review outline only when all of them share it', () => {
    const { diagram: d } = projectLayers(diagram());
    const app = d.participants.find((p) => p.id === 'layer:Application')!;
    expect(app.sideEffects).toEqual({ kinds: ['http'], evidence: ['HTTP: fetch'] });
    expect(app.diff).toBeUndefined(); // one of two objects is new
    expect(d.participants.find((p) => p.id === 'layer:Infrastructure')!.diff).toBe('added');
    expect(app.objects!.map((o) => o.label)).toEqual([':S1', ':S2']);
  });

  it('FR-28.4 a frame of a folded call spans the drawn calls inside it; exits of folded methods are dropped; findings point at drawn calls', () => {
    const { diagram: d } = projectLayers(diagram());
    expect(d.fragments).toEqual([{ id: 'root/0:a#loop0@0', kind: 'loop', ownerMessageId: 'root/0:a', operands: [{ guard: 'each x of xs', firstMessageId: 'root/0:a/0:b/0:save', lastMessageId: 'root/0:a/0:b/0:save' }] }]);
    expect(d.exits).toBeUndefined();
    expect(d.findings![0].messageIds).toEqual(['root/0:a/0:b/0:save', 'root/0:a']);
  });

  it('FR-28.4 a guard that ends at an early exit stops there — not at the end of its method — also when its calls folded', () => {
    // `a` (kept, it crosses) runs: if (!ok) { b(); return; } … if (!found) { c(); return; } load()
    const base = diagram();
    const exitAt = (n: number, beforeId: string) => ({ id: `root/0:a!exit${n}`, ownerMessageId: 'root/0:a', kind: 'return' as const, beforeId, range: { file: 'f', start: { line: n, character: 0 }, end: { line: n, character: 1 } } });
    const d0: SequenceDiagram = {
      ...base,
      messages: [...base.messages.slice(0, 5), msg('root/0:a/2:load', 'root/0:a', 's1', 'r'), base.messages[5]],
      fragments: [
        // b folded, its call to r drawn: the operand spans that call and the exit
        { id: 'root/0:a#opt0@0', kind: 'opt', ownerMessageId: 'root/0:a', operands: [{ guard: '!ok', firstMessageId: 'root/0:a/0:b', lastMessageId: 'root/0:a!exit0' }] },
        // c folded with nothing drawn inside: the frame keeps the drawn ↩
        { id: 'root/0:a#opt0@1', kind: 'opt', ownerMessageId: 'root/0:a', operands: [{ guard: '!found', firstMessageId: 'root/0:a/1:c', lastMessageId: 'root/0:a!exit1' }] },
      ],
      exits: [exitAt(0, 'root/0:a/1:c'), exitAt(1, 'root/0:a/2:load')],
    };
    const { diagram: d } = projectLayers(d0);
    expect(d.fragments!.map((f) => [f.id, f.operands[0].firstMessageId, f.operands[0].lastMessageId])).toEqual([
      ['root/0:a#opt0@0', 'root/0:a/0:b/0:save', 'root/0:a!exit0'],
      ['root/0:a#opt0@1', 'root/0:a!exit1', 'root/0:a!exit1'],
    ]);
    // the exits stay, each before the next drawn call; load is outside both frames
    expect(d.exits!.map((e) => [e.id, e.beforeId])).toEqual([['root/0:a!exit0', 'root/0:a/2:load'], ['root/0:a!exit1', 'root/0:a/2:load']]);
    expectWellFormed(d);
    // a's activation folded into the root's: its exits and the guards' ends go, the frames end at their last drawn call
    const folded = projectLayers({ ...d0, participants: d0.participants.map((p) => (p.id === 'c' ? { ...p, layer: 'Application', groupId: 'g-Application' } : p)) }).diagram;
    expect(folded.exits).toBeUndefined();
    expect(folded.fragments!.map((f) => [f.id, f.operands[0].firstMessageId, f.operands[0].lastMessageId])).toEqual([['root/0:a#opt0@0', 'root/0:a/0:b/0:save', 'root/0:a/0:b/0:save']]);
  });

  it('FR-28.7 an opened layer in the projections: objects / classes as they are, relations between two opened classes untouched, mixed ones merged per class', () => {
    const open = new Set(['layer:Application']);
    const { diagram: d } = projectLayers(diagram(), open);
    expect(d.participants.map((p) => p.id)).toEqual(['layer:Presentation', 's1', 's2', 'layer:Infrastructure']);
    expect(d.groups.map((g) => g.id)).toEqual(['layer:Presentation', 'g-Application', 'layer:Infrastructure']);
    expect(d.participants[1]).toMatchObject({ label: ':S1', inLayer: { key: 'layer:Application', name: 'Application' } });
    expect(ids(d)).toEqual(['root', 'root/0:a', 'root/0:a/0:b', 'root/0:a/0:b/0:save', 'root/0:a/1:c', 'root/1:d']);
    expect(byId(d, 'root/0:a')).toMatchObject({ from: 'layer:Presentation', to: 's1' });
    expect(byId(d, 'root/0:a').folded).toBeUndefined();
    expect(byId(d, 'root/0:a/0:b')).toMatchObject({ from: 's1', to: 's2', parentId: 'root/0:a' });
    expect(byId(d, 'root/0:a/0:b/0:save')).toMatchObject({ from: 's2', to: 'layer:Infrastructure', parentId: 'root/0:a/0:b' });
    expect(d.fragments![0].operands[0]).toMatchObject({ firstMessageId: 'root/0:a/0:b', lastMessageId: 'root/0:a/1:c' });
    expect(d.exits).toHaveLength(1);
    const cd: ClassDiagram = {
      classes: [
        { key: 'k#c', name: 'C', kind: 'class', stereotypes: [], layer: 'Presentation', namespace: 'src/x', methods: [] },
        { key: 'k#s1', name: 'S1', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [] },
        { key: 'k#s2', name: 'S2', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [] },
        { key: 'k#r', name: 'R', kind: 'interface', stereotypes: [], layer: 'Infrastructure', namespace: 'src/x', methods: [] },
      ],
      relations: [
        { id: 'r1', kind: 'association', from: 'k#c', to: 'k#s1', label: 's1' },
        { id: 'r2', kind: 'dependency', from: 'k#c', to: 'k#s2', label: '«create»' },
        { id: 'r3', kind: 'dependency', from: 'k#s1', to: 'k#s2', violation: 'inside' },
        { id: 'r4', kind: 'association', from: 'k#s2', to: 'k#r' },
      ],
      findings: [{ id: 'f', kind: 'dependency-cycle', title: 'cycle', classKeys: ['k#s1', 'k#s2'], relationIds: ['r3', 'r4'] }],
    };
    const z = projectClassLayers(cd, ['Presentation', 'Application', 'Infrastructure'], open);
    expect(z.classes.map((c) => [c.key, c.inLayer?.name, c.group?.classes])).toEqual([
      ['k#s1', 'Application', undefined],
      ['k#s2', 'Application', undefined],
      ['layer:Presentation', undefined, 1],
      ['layer:Infrastructure', undefined, 1],
    ]);
    expect(z.relations.map((r) => [r.id, r.from, r.to, r.count])).toEqual([
      ['rel:layer:Presentation→k#s1', 'layer:Presentation', 'k#s1', 1],
      ['rel:layer:Presentation→k#s2', 'layer:Presentation', 'k#s2', 1],
      ['r3', 'k#s1', 'k#s2', undefined],
      ['rel:k#s2→layer:Infrastructure', 'k#s2', 'layer:Infrastructure', 1],
    ]);
    expect(z.findings![0]).toMatchObject({ classKeys: ['k#s1', 'k#s2'], relationIds: ['r3', 'rel:k#s2→layer:Infrastructure'] });
  });

  it('FR-28.8 an object pulled out in the projection: its calls to the rest of its layer become arrows to the layer lifeline', () => {
    const { diagram: d } = projectLayers(diagram(), new Set(), new Set(['s1']));
    expect(d.participants.map((p) => [p.id, p.groupId])).toEqual([['layer:Presentation', 'layer:Presentation'], ['layer:Application', 'layer:Application'], ['s1', 'layer:Application'], ['layer:Infrastructure', 'layer:Infrastructure']]);
    expect(d.participants[1].objects!.map((o) => o.id)).toEqual(['s2']);
    expect(d.participants[1].stereotypes).toEqual([]);
    expect(d.participants[2].inLayer).toEqual({ key: 'layer:Application', name: 'Application', alone: true });
    expect(ids(d)).toEqual(['root', 'root/0:a', 'root/0:a/0:b', 'root/0:a/0:b/0:save', 'root/0:a/1:c', 'root/1:d']);
    expect(byId(d, 'root/0:a/0:b')).toMatchObject({ from: 's1', to: 'layer:Application' });
    expect(byId(d, 'root/0:a/0:b/0:save')).toMatchObject({ from: 'layer:Application', to: 'layer:Infrastructure', parentId: 'root/0:a/0:b' });
    const cd: ClassDiagram = {
      classes: [
        { key: 'k#s1', name: 'S1', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [] },
        { key: 'k#s2', name: 'S2', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [] },
      ],
      relations: [{ id: 'r3', kind: 'dependency', from: 'k#s1', to: 'k#s2' }],
    };
    const z = projectClassLayers(cd, ['Application'], new Set(), new Set(['k#s1']));
    expect(z.classes.map((c) => [c.key, c.inLayer, c.group?.classes, c.methods.map((m) => m.key)])).toEqual([
      ['k#s1', { key: 'layer:Application', name: 'Application', alone: true }, undefined, []],
      ['layer:Application', undefined, 1, ['k#s2']],
    ]);
    expect(z.relations.map((r) => [r.from, r.to, r.count])).toEqual([['k#s1', 'layer:Application', 1]]);
  });

  it('FR-28.5 the class projection merges the relations between layers and keeps those inside a layer as its violations', () => {
    const cd: ClassDiagram = {
      classes: [
        { key: 'k#c', name: 'C', kind: 'class', stereotypes: [], layer: 'Presentation', namespace: 'src/x', methods: [] },
        { key: 'k#s1', name: 'S1', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [], change: { kind: 'new', members: [] } },
        { key: 'k#s2', name: 'S2', kind: 'class', stereotypes: [], layer: 'Application', namespace: 'src/x', methods: [] },
        { key: 'k#r', name: 'R', kind: 'interface', stereotypes: [], layer: 'Infrastructure', namespace: 'src/x', methods: [] },
        { key: 'k#l', name: 'L', kind: 'class', stereotypes: [], namespace: 'src/util', methods: [] },
      ],
      relations: [
        { id: 'r1', kind: 'association', from: 'k#c', to: 'k#s1', label: 's1' },
        { id: 'r2', kind: 'dependency', from: 'k#c', to: 'k#s2', label: '«create»' },
        { id: 'r3', kind: 'dependency', from: 'k#s1', to: 'k#s2', violation: 'inside' },
        { id: 'r4', kind: 'association', from: 'k#s2', to: 'k#r', calls: [{ messageId: 'root/0:a/0:b/0:save', label: 'b → save' }] },
        { id: 'r5', kind: 'dependency', from: 'k#s1', to: 'k#l' },
      ],
      layers: ['Presentation', 'Application', 'Infrastructure'],
      findings: [{ id: 'f', kind: 'dependency-cycle', title: 'cycle', classKeys: ['k#s1', 'k#s2'], relationIds: ['r3', 'r4'] }],
    };
    const z = projectClassLayers(cd, ['Presentation', 'Application', 'Ports', 'Infrastructure']);
    expect(z.classes.map((c) => [c.key, c.name, c.methods.map((m) => `${m.name}${m.diff ? `:${m.diff}` : ''}`), c.group])).toEqual([
      ['layer:Presentation', 'Presentation', ['C'], { path: 'layer:Presentation', classes: 1, zoom: true }],
      ['layer:Application', 'Application', ['S1:added', 'S2'], { path: 'layer:Application', classes: 2, zoom: true, violations: 1 }],
      ['layer:Infrastructure', 'Infrastructure', ['R'], { path: 'layer:Infrastructure', classes: 1, zoom: true }],
      ['layer::src/util', 'No layer · util', ['L'], { path: 'layer::src/util', classes: 1, zoom: true }],
    ]);
    expect(z.relations.map((r) => [r.id, r.kind, r.count, r.label])).toEqual([
      ['rel:layer:Presentation→layer:Application', 'dependency', 2, '2'],
      ['rel:layer:Application→layer:Infrastructure', 'dependency', 1, undefined],
      ['rel:layer:Application→layer::src/util', 'dependency', 1, undefined],
    ]);
    expect(z.relations[0].calls!.map((c) => c.label)).toEqual(['C → S1 (s1)', 'C → S2']);
    expect(z.relations[1].calls![0].messageId).toBe('root/0:a/0:b/0:save');
    expect(z.findings![0]).toMatchObject({ classKeys: ['layer:Application'], relationIds: ['rel:layer:Application→layer:Infrastructure'] });
    expect(z.layers).toEqual(['Presentation', 'Application', 'Infrastructure']);
  });
});
