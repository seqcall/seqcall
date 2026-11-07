import { describe, expect, it } from 'vitest';
import type { ClassDiagram, Message, Participant, SequenceDiagram } from '@seqcall/protocol';
import { markFoldableBands, projectClassLayers, projectLayers } from '../src/layer-zoom';
import { K, method, newSession } from './helpers';

// FR-28.11 one view: a layer folded from the object view, the other layers drawn as they are.
const P = (id: string, layer: string, groupId: string): Participant =>
  ({ id, classKey: `k#${id}`, className: id.toUpperCase(), label: `:${id.toUpperCase()}`, kind: 'class', stereotypes: [], layer, namespace: groupId.split('::')[1], groupId }) as Participant;
const M = (id: string, parentId: string | null, from: string | null, to: string): Message =>
  ({ id, parentId, depth: id === 'root' ? 0 : id.split('/').length - 1, kind: from === null ? 'found' : from === to ? 'self' : 'call', from, to, methodName: id.slice(id.lastIndexOf(':') + 1), args: [], expandable: false, expanded: true }) as unknown as Message;

// the root's band first (Application · ctl), then the layers in order: Application's second band after Presentation
const diagram = (): SequenceDiagram =>
  ({
    root: { key: 'k', name: 'run', owner: { key: 'k#a', name: 'A', kind: 'class' }, isStatic: false, hasBody: true },
    participants: [P('a', 'Application', 'Application::ctl'), P('p', 'Presentation', 'Presentation::web'), P('s', 'Application', 'Application::svc'), P('r', 'Infrastructure', 'Infrastructure::db'), P('q', 'Infrastructure', 'Infrastructure::db')],
    groups: [
      { id: 'Application::ctl', label: 'Application · ctl', layer: 'Application', namespace: 'ctl' },
      { id: 'Presentation::web', label: 'Presentation · web', layer: 'Presentation', namespace: 'web' },
      { id: 'Application::svc', label: 'Application · svc', layer: 'Application', namespace: 'svc' },
      { id: 'Infrastructure::db', label: 'Infrastructure · db', layer: 'Infrastructure', namespace: 'db' },
    ],
    messages: [M('root', null, null, 'a'), M('root/0:x', 'root', 'a', 'p'), M('root/0:x/0:y', 'root/0:x', 'p', 's'), M('root/0:x/0:y/0:self', 'root/0:x/0:y', 's', 's'), M('root/0:x/0:y/1:save', 'root/0:x/0:y', 's', 'r'), M('root/0:x/0:y/1:save/0:z', 'root/0:x/0:y/1:save', 'r', 'q')],
    hiddenFilters: [],
  }) as unknown as SequenceDiagram;

describe('FR-28.11 folding a layer in the object view (projection)', () => {
  it('FR-28.11 nothing folded: the projection is the diagram itself (no tag, no lifeline, the same order)', () => {
    const d = diagram();
    const z = projectLayers(d, new Set(), new Set(), new Set());
    expect(z.diagram).toEqual(d);
    expect(z.folded.size).toBe(0);
  });

  it('FR-28.11 one layer folded: the other objects untouched and in their bands’ places, the folded layer one lifeline where its first band stood', () => {
    const d = diagram();
    const infra = projectLayers(d, new Set(), new Set(), new Set(['layer:Infrastructure'])).diagram;
    expect(infra.groups.map((g) => g.id)).toEqual(['Application::ctl', 'Presentation::web', 'Application::svc', 'layer:Infrastructure']);
    expect(infra.participants.slice(0, 3)).toEqual(d.participants.slice(0, 3));
    expect(infra.participants[3]).toMatchObject({ id: 'layer:Infrastructure', stereotypes: ['2 objects'] });
    // the calls between open objects as they were (the self call too); the call inside Infrastructure folds
    expect(infra.messages.slice(0, 4)).toEqual(d.messages.slice(0, 4));
    expect(infra.messages.map((m) => m.id)).not.toContain('root/0:x/0:y/1:save/0:z');
    // Application split over two bands folds into one lifeline at its first band; Presentation keeps its place
    const app = projectLayers(d, new Set(), new Set(), new Set(['layer:Application'])).diagram;
    expect(app.groups.map((g) => g.id)).toEqual(['layer:Application', 'Presentation::web', 'Infrastructure::db']);
    expect(app.participants.map((p) => p.id)).toEqual(['layer:Application', 'p', 'r', 'q']);
  });

  it('FR-28.11 zoomed with a split layer opened: its objects stay in their own bands, where they stood', () => {
    const z = projectLayers(diagram(), new Set(['layer:Application'])).diagram;
    expect(z.groups.map((g) => g.id)).toEqual(['Application::ctl', 'layer:Presentation', 'Application::svc', 'layer:Infrastructure']);
    expect(z.participants.filter((p) => p.inLayer).map((p) => p.id)).toEqual(['a', 's']);
  });

  it('FR-28.11 every band of an open layer names the layer its ⊖ folds; a folded layer’s band does not', () => {
    const z = markFoldableBands(projectLayers(diagram(), new Set(), new Set(), new Set(['layer:Infrastructure'])).diagram);
    expect(z.groups.map((g) => g.fold?.key)).toEqual(['layer:Application', 'layer:Presentation', 'layer:Application', undefined]);
    expect(z.groups[0].fold!.name).toBe('Application');
  });

  it('FR-28.11 each object of an open layer names the layer it folds into alone; a folded layer’s lifeline and the objects pulled out of it do not', () => {
    const z = markFoldableBands(projectLayers(diagram(), new Set(), new Set(['r']), new Set(['layer:Infrastructure'])).diagram);
    expect(z.participants.map((p) => [p.id, p.layerFold?.key])).toEqual([
      ['a', 'layer:Application'], ['p', 'layer:Presentation'], ['s', 'layer:Application'], ['layer:Infrastructure', undefined], ['r', undefined],
    ]);
    expect(z.participants[0].layerFold!.name).toBe('Application');
  });

  it('FR-28.11 the class projection with nothing folded keeps every class and relation as it is, a class’s relation to itself too', () => {
    const c = (key: string, layer: string) => ({ key, name: key, kind: 'class', stereotypes: [], layer, namespace: 'src', methods: [] });
    const cd = {
      classes: [c('b', 'Infrastructure'), c('a', 'Application')],
      relations: [
        { id: 'r1', kind: 'dependency', from: 'a', to: 'b' },
        { id: 'r2', kind: 'association', from: 'a', to: 'a' },
      ],
      layers: ['Application', 'Infrastructure'],
    } as unknown as ClassDiagram;
    const out = projectClassLayers(cd, ['Application', 'Infrastructure'], new Set(), new Set(), new Set());
    expect(out.classes).toEqual(cd.classes);
    expect(out.relations).toEqual(cd.relations);
    expect(out.layers).toEqual(cd.layers);
  });
});

describe('FR-28.11 folding a layer in the object view (session)', () => {
  it('FR-28.11 ⊖ on a band folds that layer only: the other objects as before, the class diagram one package for it; ◫ folds all, ◫ again opens all', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    const plain = (await s.expandAll())!;
    expect(plain.options.layerZoom).toBe(false);
    const ports = plain.groups.find((g) => g.layer === 'Ports')!;
    expect(ports.fold).toEqual({ key: 'layer:Ports', name: 'Ports' });
    expect(plain.participants.some((p) => p.inLayer || p.objects)).toBe(false);
    const d = (await s.setLayerOpen('layer:Ports', false))!;
    expect(d.options).toMatchObject({ layerZoom: false, foldedLayers: ['layer:Ports'] });
    const lifeline = d.participants.find((p) => p.id === 'layer:Ports')!;
    expect(lifeline.objects!.map((o) => o.label)).toEqual(['replica:UserRepository', 'primary:UserRepository']);
    // every other object as in the object view: no tag, no lifeline, in the same order
    const others = (x: SequenceDiagram) => x.participants.filter((p) => p.layer !== 'Ports');
    expect(others(d)).toEqual(others(plain));
    expect(byId(d, 'root/0:validate')).toEqual(byId(plain, 'root/0:validate'));
    expect(byId(d, 'root/2:findUser/0:findById')).toMatchObject({ to: 'layer:Ports' });
    // the class diagram follows: Ports one package, the other classes as they are, each able to fold its layer
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.filter((c) => c.group?.zoom).map((c) => c.key)).toEqual(['layer:Ports']);
    const svc = cd.classes.find((c) => c.name === 'UserService')!;
    expect(svc.inLayer).toBeUndefined();
    expect(svc.layerFold).toEqual({ key: 'layer:Application', name: 'Application' });
    // ⊕ on the lifeline opens it again
    const back = (await s.setLayerOpen('layer:Ports', true))!;
    expect(back.participants).toEqual(plain.participants);
    // ◫ Layers: every layer folded, the object view's exceptions dropped; off again: every layer open
    await s.setLayerOpen('layer:Ports', false);
    const zoomed = (await s.setOption('layerZoom', true))!;
    expect(zoomed.options).toMatchObject({ foldedLayers: [], openLayers: [] });
    expect(zoomed.groups.some((g) => g.fold)).toBe(false);
    await s.setLayerOpen('layer:Application', true);
    const all = (await s.setOption('layerZoom', false))!;
    expect(all.options).toMatchObject({ foldedLayers: [], openLayers: [], openObjects: [] });
    expect(all.participants).toEqual(plain.participants);
  });

  it('FR-28.11 ⊖ on one object of the object view folds it alone into its layer: the layer\'s other objects stay out, each able to go back too', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    const plain = (await s.expandAll())!;
    const [replica, primary] = plain.participants.filter((p) => p.layer === 'Ports');
    expect(replica.layerFold).toEqual({ key: 'layer:Ports', name: 'Ports' });
    let d = (await s.setLayerOpen(replica.id, false))!;
    expect(d.options).toMatchObject({ layerZoom: false, foldedLayers: ['layer:Ports'], openObjects: [primary.id] });
    expect(d.participants.find((p) => p.id === 'layer:Ports')!.objects!.map((o) => o.id)).toEqual([replica.id]);
    expect(d.participants.find((p) => p.id === primary.id)).toMatchObject({ inLayer: { key: 'layer:Ports', name: 'Ports', alone: true } });
    expect(d.participants.find((p) => p.id === primary.id)!.layerFold).toBeUndefined();
    // the other layers as before
    const others = (x: SequenceDiagram) => x.participants.filter((p) => p.layer !== 'Ports');
    expect(others(d)).toEqual(others(plain));
    // the last one folded too: the whole layer one lifeline, nothing out
    d = (await s.setLayerOpen(primary.id, false))!;
    expect(d.options).toMatchObject({ foldedLayers: ['layer:Ports'], openObjects: [] });
    expect(d.participants.find((p) => p.id === 'layer:Ports')!.objects).toHaveLength(2);
    // ⊕ on the lifeline: the object view as it was
    expect((await s.setLayerOpen('layer:Ports', true))!.participants).toEqual(plain.participants);
  });

  it('FR-28.11 the class diagram: ⊖ on one class folds it alone into its layer\'s package, the layer\'s other classes stay out', async () => {
    const s = newSession();
    await s.openMethod(await method(K.audit));
    await s.expandAll();
    const flow = (await s.expandAll())!;
    // the Application classes with objects in the flow (UserService, BillingService, StripeGateway)
    const objects = new Set(flow.participants.map((p) => p.classKey));
    const before = (await s.getClassDiagram())!;
    const app = before.classes.filter((c) => c.layer === 'Application' && objects.has(c.key));
    expect(app.length).toBeGreaterThan(1);
    expect(app.every((c) => c.layerFold?.key === 'layer:Application')).toBe(true);
    const [one, ...rest] = app;
    await s.setLayerOpen(one.key, false);
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.find((c) => c.key === 'layer:Application')!.group!.zoom).toBeTruthy();
    expect(cd.classes.some((c) => c.key === one.key)).toBe(false);
    for (const c of rest) expect(cd.classes.find((x) => x.key === c.key)).toMatchObject({ inLayer: { key: 'layer:Application', alone: true } });
  });

  it('FR-28.11 a layer reached later (after an expand) comes in open; Fold all from the object view turns the zoom on', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.setLayerOpen('layer:Presentation', false);
    const d = (await s.expandAll())!;
    expect(d.participants.find((p) => p.layer === 'Application')).toMatchObject({ className: 'UserService' });
    expect(d.participants.find((p) => p.id === 'layer:Presentation')).toBeDefined();
    const folded = (await s.foldAllLayers())!;
    expect(folded.options).toMatchObject({ layerZoom: true, foldedLayers: [], openLayers: [] });
    expect(folded.participants.every((p) => p.objects || !p.layer)).toBe(true);
  });

  it('FR-28.11 an object pulled out of a layer folded in the object view, put back by folding the layer', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    await s.expandAll();
    let d = (await s.setLayerOpen('layer:Ports', false))!;
    const repo = d.participants.find((p) => p.id === 'layer:Ports')!.objects![0].id;
    d = (await s.setLayerOpen(repo, true))!;
    expect(d.participants.find((p) => p.id === repo)!.inLayer).toEqual({ key: 'layer:Ports', name: 'Ports', alone: true });
    d = (await s.setLayerOpen('layer:Ports', false))!;
    expect(d.options.openObjects).toEqual([]);
    expect(d.participants.some((p) => p.id === repo)).toBe(false);
  });

  it('FR-28.11 a saved zoomed state from before (only `layerZoom`, no lists) reads as every layer folded: put one object back, open a layer, the class diagram', async () => {
    const s = newSession({ initialState: { options: { layerZoom: true } } as never });
    await s.openMethod(await method(K.getUser));
    const d = (await s.expandAll())!;
    expect(d.participants.every((p) => p.objects || !p.layer)).toBe(true);
    expect((await s.getClassDiagram())!.classes.some((c) => c.group?.zoom)).toBe(true);
    const svc = d.participants.find((p) => p.id === 'layer:Application')!.objects![0].id;
    // putting back an object of a folded layer changes no layer
    await s.setLayerOpen(svc, false);
    expect(s.getPersistentState().options.openLayers).toBeUndefined();
    await s.setLayerOpen('layer:Application', true);
    expect(s.getPersistentState().options.openLayers).toEqual(['layer:Application']);
  });

  it('FR-28.11 pulling out an object whose layer is open in the object view keeps it as it is', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const plain = (await s.expandAll())!;
    const ctl = plain.participants.find((p) => p.layer === 'Presentation')!;
    const d = (await s.setLayerOpen(ctl.id, true))!;
    expect(d.participants).toEqual(plain.participants);
  });

  it('FR-28.11 putting one object back in the object view folds its layer, the layer’s other objects stay out', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expandAll();
    const plain = (await s.expandAll())!;
    const [replica, primary] = plain.participants.filter((p) => p.layer === 'Ports');
    const d = (await s.setLayerOpen(replica.id, false))!;
    expect(d.options).toMatchObject({ foldedLayers: ['layer:Ports'], openObjects: [primary.id] });
    expect(d.participants.find((p) => p.id === 'layer:Ports')!.objects!.map((o) => o.id)).toEqual([replica.id]);
    expect(d.participants.find((p) => p.id === primary.id)!.inLayer).toEqual({ key: 'layer:Ports', name: 'Ports', alone: true });
  });
});

const byId = (d: SequenceDiagram, id: string) => d.messages.find((m) => m.id === id)!;
