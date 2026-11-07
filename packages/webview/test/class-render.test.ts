// @vitest-environment jsdom
import type { ClassDiagram, ClassNode, ClassRelation } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { layoutClassDiagram, type ClassGeometry } from '../src/class/layout';
import { multiplicityPos, renderClassDiagram } from '../src/class/render';
import { estimateTextWidth } from '../src/measure';
import { range } from '../dev/mock-data';

const cls = (key: string, extra: Partial<ClassNode> = {}): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], methods: [], namespace: 'src', ...extra });
const methods = (...names: string[]) => names.map((n) => ({ name: n, isStatic: false, signature: `${n}()` }));
function draw(classes: ClassNode[], relations: ClassRelation[] = [], opts: Parameters<typeof layoutClassDiagram>[3] = {}, manual = {}) {
  const geom = layoutClassDiagram({ classes, relations } as ClassDiagram, estimateTextWidth, manual, { direction: 'TB', ...opts });
  return { geom, svg: renderClassDiagram(geom, { edgeStyle: 'straight' }) };
}
const node = (svg: SVGSVGElement, key: string) => svg.querySelector(`[data-class-key="${key}"]`)!;
const tip = (el: Element) => el.querySelector(':scope > title')!.textContent;

describe('class diagram rendering: relations', () => {
  it('FR-12.12 a «use» relation without the places it is used says only what it is (in plain words)', () => {
    const { svg } = draw([cls('A'), cls('B'), cls('C')], [{ id: 'u', kind: 'use', from: 'A', to: 'B' }, { id: 'v', kind: 'use', from: 'A', to: 'C', uses: [] }]);
    expect(tip(svg.querySelector('[data-relation-id="u"]')!)).toBe('A uses the type B, no call (in a signature or a local) — «use»');
    expect(tip(svg.querySelector('[data-relation-id="v"]')!)).toBe('A uses the type C, no call (in a signature or a local) — «use»');
  });

  it('FR-14.7 every relation says in plain words what one class does with the other, the UML name after it', () => {
    const { svg } = draw(
      [cls('Svc'), cls('Gateway'), cls('Repo'), cls('SqlRepo'), cls('Base'), cls('Order'), cls('Pkg')],
      [
        { id: 'a', kind: 'association', from: 'Svc', to: 'Gateway', label: 'gateway' },
        { id: 'a2', kind: 'association', from: 'Svc', to: 'Repo' },
        { id: 'd', kind: 'dependency', from: 'Svc', to: 'Order' },
        { id: 'c', kind: 'dependency', from: 'Repo', to: 'Order', label: '«create»' },
        { id: 'r', kind: 'realization', from: 'SqlRepo', to: 'Repo' },
        { id: 'g', kind: 'generalization', from: 'SqlRepo', to: 'Base' },
        { id: 'm', kind: 'dependency', from: 'Svc', to: 'Pkg', label: '12', count: 12 },
      ],
    );
    const t = (id: string) => tip(svg.querySelector(`[data-relation-id="${id}"]`)!);
    expect(t('a')).toBe('Svc holds field gateway: Gateway — association');
    expect(t('a2')).toBe('Svc holds a field: Repo — association');
    expect(t('d')).toBe('Svc calls Order, holds no field of it — dependency');
    expect(t('c')).toBe('Repo creates Order — dependency «create»');
    expect(t('r')).toBe('SqlRepo implements Repo — realization');
    expect(t('g')).toBe('SqlRepo extends Base — generalization');
    expect(t('m')).toBe('12 relations from Svc to Pkg: calls, fields or creations — dependency');
  });

  it('FR-12.15 an aggregation without a known multiplicity says *', () => {
    const { svg } = draw([cls('A'), cls('B')], [{ id: 'g', kind: 'association', from: 'A', to: 'B', label: 'items', aggregation: true }]);
    expect(tip(svg.querySelector('[data-relation-id="g"]')!)).toBe('aggregation — the field holds a collection (*) (items)');
  });

  it('FR-12.15 the multiplicity of two classes on the same spot (zero-length line) is still placed', () => {
    const { geom } = draw([cls('A'), cls('B')], [{ id: 'g', kind: 'association', from: 'A', to: 'B', aggregation: true, multiplicity: '*' }], {}, { A: { x: 100, y: 100 }, B: { x: 100, y: 100 } });
    expect(multiplicityPos(geom.edges[0])).toEqual({ x: 100, y: 104 }); // no direction: at the end, 4 px down for the text baseline
    expect(multiplicityPos({ ...geom.edges[0], points: [{ x: 1, y: 1 }] })).toBeUndefined(); // no route
  });
});

describe('class diagram rendering: classes', () => {
  it('FR-12.11 one other method not used in this interaction is singular', () => {
    const { svg } = draw([cls('A', { otherMethodCount: 1 })]);
    expect(tip(node(svg, 'A'))).toContain('\n1 other method not used in this interaction');
  });

  it('FR-7.9 a stereotype line cut to the box shows the full line as its tooltip; a whole one has none', () => {
    const long = cls('A', { stereotypes: ['repository', 'singleton', 'adapter', 'entity'] });
    const { svg, geom } = draw([long, cls('B', { stereotypes: ['entity'] })]);
    const n = geom.nodes[0];
    expect(n.stereoLine).not.toBe(n.stereoFull);
    expect(node(svg, 'A').querySelector('.cls-stereo title')!.textContent).toBe(n.stereoFull);
    expect(node(svg, 'B').querySelector('.cls-stereo title')).toBeNull();
  });

  it('FR-7.9 the stereotype line explains each stereotype when the reasons are known', () => {
    const { svg } = draw([cls('A', { stereotypes: ['service'], stereotypeReasons: [{ stereotype: 'service', text: 'name ends in `Service`' }] })]);
    expect(node(svg, 'A').querySelector('.cls-stereo title')!.textContent).toBe('«service» — name ends in Service');
  });

  it('FR-26.7 a class of an open package says so and carries the fold tag', () => {
    const { svg } = draw([cls('A', { inPackage: 'src/shop/orders' })]);
    expect(tip(node(svg, 'A'))).toContain('\nin src/shop/orders (open — ⊖ in the bar folds it)');
    expect(node(svg, 'A').querySelector('.fold-tag-text')!.textContent).toBe('⊖ orders');
  });

  it('FR-28.7 a class of a layer opened in place, and one pulled out alone: tooltip and ⊖', () => {
    const { svg } = draw([cls('A', { layer: 'Domain', inLayer: { key: 'layer:Domain', name: 'Domain' } }), cls('B', { layer: 'Domain', inLayer: { key: 'layer:Domain', name: 'Domain', alone: true } })]);
    expect(tip(node(svg, 'A'))).toContain('\nin Domain, opened (⊖ puts this class back; ⊖ on the lane folds the layer)');
    expect(tip(node(svg, 'B'))).toContain('\npulled out of Domain (⊖ puts it back)');
    expect(node(svg, 'A').querySelector('[data-fold-layer] title')!.textContent).toBe('In Domain, opened — put this class back (the others stay out; ⊖ on the lane folds Domain)');
    expect(node(svg, 'B').querySelector('[data-fold-layer] title')!.textContent).toBe('Pulled out of Domain — put it back');
  });

  it('FR-28.7 a lane with several classes out folds them all from its ⊖', () => {
    const { svg } = draw([cls('A', { layer: 'Domain', inLayer: { key: 'layer:Domain', name: 'Domain' } }), cls('B', { layer: 'Domain', inLayer: { key: 'layer:Domain', name: 'Domain' } })], [], { lanes: true });
    expect(svg.querySelector('.lane-fold title')!.textContent).toBe('Fold Domain: one package for its 2 classes');
  });

  it('FR-14.2 without a chosen edge style relations are curved', () => {
    const geom = draw([cls('A'), cls('B')], [{ id: 'r', kind: 'dependency', from: 'A', to: 'B' }]).geom;
    expect(renderClassDiagram(geom).querySelector('.rel-line')!.getAttribute('d')).toMatch(/^M[\d.,]+ C/);
  });
});

describe('class diagram rendering: packages (FR-26 codebase map, FR-28.5 layer zoom)', () => {
  const pkg = (key: string, group: NonNullable<ClassNode['group']>, extra: Partial<ClassNode> = {}) => cls(key, { name: key, group, methods: methods('Order', 'Invoice'), ...extra });

  it('FR-26.3 a folder in several layers: a split strip on its header, the counts in its tooltip', () => {
    const p = pkg('shop', { path: 'src/shop', classes: 4, layers: [{ layer: 'Domain', classes: 2 }, { layer: 'Application', classes: 1 }, { classes: 1 }] }, { layer: 'Domain' });
    const { svg } = draw([p]);
    const g = node(svg, 'shop');
    expect(tip(g).split('\n')[1]).toBe('4 classes · Domain 2 · Application 1 · no layer 1');
    const parts = [...g.querySelectorAll('.pkg-split-part')];
    expect(parts.map((r) => r.getAttribute('class'))).toEqual(['pkg-split-part layer-4', 'pkg-split-part layer-2', 'pkg-split-part no-layer']);
    const w = parts.map((r) => Number(r.getAttribute('width')));
    expect(w[0]).toBeCloseTo(2 * w[1], 0);
    expect(w[1]).toBeCloseTo(w[2], 0);
    expect(g.querySelector('.pkg-split title')!.textContent).toBe('Domain 2 · Application 1 · no layer 1');
    expect(node(draw([pkg('one', { path: 'src/one', classes: 2 }, { layer: 'Domain' })]).svg, 'one').querySelector('.pkg-split')).toBeNull();
  });

  it('FR-26.5 a folder: tooltip with its layer, ⊕ to open it, class rows with their files', () => {
    const p = pkg('shop', { path: 'src/shop', classes: 2 }, { layer: 'Domain', methods: [{ name: 'Order', isStatic: false, signature: 'Order', declaration: range('src/shop/Order.ts', 3, 0, 5) }, { name: 'Invoice', isStatic: false, signature: 'Invoice' }] });
    const { svg } = draw([p]);
    const g = node(svg, 'shop');
    expect(g.getAttribute('class')).toBe('class-node kind-class package layer-4');
    expect(tip(g)).toBe('src/shop\n2 classes · Domain\nclick to open it here (⊖ in the bar folds it again); right-click: open as its own map');
    expect(g.querySelector('.pkg-expand')!.getAttribute('data-open-package')).toBe('src/shop');
    expect([...g.querySelectorAll('.pkg-class')].map((t) => t.firstChild!.textContent)).toEqual(['Order', 'Invoice']);
    expect(g.querySelector('[data-member="Invoice"] title')!.textContent).toBe('Invoice');
    expect(g.querySelector('[data-member="Order"] title')!.textContent).toMatch(/^Order\nOrder\.ts:\d+$/);
  });

  it('FR-26.6 an external folder with violations inside: no ⊕, marked, no layer colour', () => {
    const { svg } = draw([pkg('lib', { path: 'lib', classes: 1, external: true, violations: 2 })]);
    const g = node(svg, 'lib');
    expect(g.getAttribute('class')).toBe('class-node kind-class package external has-violations');
    expect(tip(g)).toBe('lib\n1 class · ⚠ 2 inside\noutside this folder — click to open it as its own map');
    expect(g.querySelector('.pkg-expand')).toBeNull();
    expect(g.querySelector('.pkg-count')!.getAttribute('class')).toBe('cls-stereo pkg-count has-violations');
    expect(g.querySelector('.cls-layer-bar')).toBeNull();
  });

  it('FR-28.5 a layer of the zoomed flow: its classes and violations in the tooltip, ⊕ opens the layer', () => {
    const one = draw([pkg('L1', { path: 'Domain', classes: 1, zoom: true, violations: 1 })]).svg;
    expect(tip(node(one, 'L1'))).toBe('L1\n1 class of the flow · ⚠ 1 layer violation inside\n⊕ shows its classes here; click a class to go to it');
    expect(node(one, 'L1').querySelector('[data-open-layer]')!.getAttribute('data-open-layer')).toBe('Domain');
    const two = draw([pkg('L2', { path: 'Domain', classes: 2, zoom: true, violations: 3 })]).svg;
    expect(tip(node(two, 'L2')).split('\n')[1]).toBe('2 classes of the flow · ⚠ 3 layer violations inside');
    const none = draw([pkg('L3', { path: 'Domain', classes: 2, zoom: true })]).svg;
    expect(tip(node(none, 'L3')).split('\n')[1]).toBe('2 classes of the flow');
  });

  it('FR-26.5 a package with more classes than rows: "… +k more", expanded "▴ fewer"', () => {
    const many = pkg('big', { path: 'src/big', classes: 8 }, { methods: methods('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H') });
    const folded = draw([many]).svg;
    const more = node(folded, 'big').querySelector('.cls-more')!;
    expect(more.firstChild!.textContent).toBe('… +3 more');
    expect(more.querySelector('title')!.textContent).toBe('F\nG\nH\n(click to show all 8)');
    const open = draw([many], [], { methods: { maxMethods: 5, expanded: new Set(['big']) } }).svg;
    const fewer = node(open, 'big').querySelector('.cls-more')!;
    expect(fewer.firstChild!.textContent).toBe('▴ fewer');
    expect(fewer.querySelector('title')!.textContent).toBe('Show fewer classes');
  });
});

describe('class diagram rendering: geometry passed in', () => {
  it('FR-12.6 a lane without a layer has no colour', () => {
    const geom = draw([cls('A')], [], { lanes: true }).geom as ClassGeometry;
    expect(renderClassDiagram(geom).querySelector('.class-lane')!.getAttribute('class')).toBe('class-lane');
  });
});
