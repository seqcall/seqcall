import { changeTag, memberSign, memberTitle } from '../review-marks';
import { round, svg, svgTitle } from '../dom';
import { formatLocation } from '../sequence/labels';
import { stereotypeText } from '../measure';
import { layerClass } from '../layers';
import { layerHintBadge } from '../layer-hint';
import { layerReasonLine, stereotypeReasonsTitle } from '../layer-reason';
import { IO_PILL_PAD, sideEffectLines, sideEffectPill } from '../side-effects';
import type { ClassNode, Finding } from '@seqcall/protocol';
import { findingMark } from '../finding-marks';
import { edgePathData, type EdgeStyle } from './edges';
import { CLASS_LAYOUT, packageLine, type ClassEdgeGeom, type ClassGeometry, type ClassNodeGeom } from './layout';

export const MARKER_IDS = { 'triangle-hollow': 'seqcall-cls-triangle', 'arrow-open': 'seqcall-cls-arrow' } as const;
/** FR-12.15 the aggregation diamond at the owner's end of an association. */
const DIAMOND_ID = 'seqcall-cls-diamond';

function defs(): SVGDefsElement {
  return svg('defs', undefined, [
    svg('marker', { id: MARKER_IDS['triangle-hollow'], viewBox: '0 0 14 14', refX: 13, refY: 7, markerWidth: 14, markerHeight: 14, orient: 'auto', markerUnits: 'userSpaceOnUse' }, [
      svg('path', { class: 'cls-triangle', d: 'M1,1 L13,7 L1,13 z' }),
    ]),
    svg('marker', { id: DIAMOND_ID, viewBox: '0 0 24 12', refX: 1, refY: 6, markerWidth: 24, markerHeight: 12, orient: 'auto', markerUnits: 'userSpaceOnUse' }, [
      svg('path', { class: 'cls-diamond', d: 'M1,6 L12,1 L23,6 L12,11 z' }),
    ]),
    svg('marker', { id: MARKER_IDS['arrow-open'], viewBox: '0 0 12 12', refX: 11, refY: 6, markerWidth: 12, markerHeight: 12, orient: 'auto', markerUnits: 'userSpaceOnUse' }, [
      svg('path', { class: 'cls-arrow', d: 'M1,1 L11,6 L1,11', fill: 'none' }),
    ]),
  ]);
}

/** a relation's tooltip in plain words first (`A holds field gateway: B`), the UML name after it. */
function relationWords(e: ClassEdgeGeom, nameOf: (key: string) => string): string {
  const name = e.title ?? e.label;
  const named = name ? ` (${name})` : '';
  const [a, b] = [nameOf(e.from), nameOf(e.to)];
  if (e.kind === 'use') return `${a} uses the type ${b}, no call (in a signature or a local) — «use»${named}${e.uses?.length ? `\n${e.uses.map((u) => `${u.method} (${formatLocation(u.range)})`).join('\n')}` : ''}`;
  if (e.aggregation) return `aggregation — the field holds a collection (${e.multiplicity ?? '*'})${named}`;
  if (e.kind === 'association') return `${a} holds ${name ? `field ${name}` : 'a field'}: ${b} — association`;
  // FR-26 a codebase-map edge standing for several relations (calls, fields, creations) between what is inside
  if (e.kind === 'dependency' && e.count && e.count > 1) return `${e.count} relations from ${a} to ${b}: calls, fields or creations — dependency`;
  if (e.kind === 'dependency') return name === '«create»' ? `${a} creates ${b} — dependency «create»` : `${a} calls ${b}, holds no field of it — dependency${named}`;
  return `${a} ${e.kind === 'realization' ? 'implements' : 'extends'} ${b} — ${e.kind}${named}`;
}

function renderEdge(e: ClassEdgeGeom, style: EdgeStyle, nameOf: (key: string) => string): SVGGElement {
  const g = svg('g', { class: `relation rel-${e.kind}${e.violation ? ' violation' : ''}${e.possible ? ' possible' : ''}${e.diff ? ` diff-${e.diff}` : ''}`, 'data-relation-id': e.id, 'data-marker': e.style.marker });
  // FR-26 an application-map edge merging many relations: a little thicker (1 → 1 px, 30+ → 3 px)
  if (e.count && e.count > 1) g.style.setProperty('--rel-width', `${Math.min(3, 1 + Math.log10(e.count) * 1.4).toFixed(2)}px`);
  const change = e.diff === 'added' ? '\nnew on this branch' : e.diff === 'removed' ? '\nremoved on this branch' : '';
  g.appendChild(svgTitle(`${relationWords(e, nameOf)}${e.violation ? `\n⚠ ${e.possible ? 'possible: ' : ''}${e.violation}${(e.possible ?? []).map((g) => `\n  ${g}`).join('')}` : ''}${change}`));
  const d = edgePathData(e.points, style, e.bezier);
  g.appendChild(svg('path', { class: 'rel-hit', d }));
  g.appendChild(svg('path', { class: `rel-line${e.style.dashed ? ' dashed' : ''}`, d, 'marker-end': `url(#${MARKER_IDS[e.style.marker]})`, ...(e.aggregation ? { 'marker-start': `url(#${DIAMOND_ID})` } : {}) }));
  // FR-12.15 multiplicity next to the target's end, beside the line
  const mult = e.multiplicity ? multiplicityPos(e) : undefined;
  if (mult) g.appendChild(svg('text', { class: 'rel-mult', x: round(mult.x), y: round(mult.y), 'text-anchor': 'middle' }, [e.multiplicity!]));
  if (e.label && e.labelPos) {
    g.appendChild(svg('text', { class: 'rel-label', x: round(e.labelPos.x), y: round(e.labelPos.y + 4), 'text-anchor': 'middle' }, [e.label]));
  }
  return g;
}

/**
 * FR-26 a folder of the codebase map as a UML package: a tab on the top edge, the folder, how many
 * classes it holds, and its classes (click a class: its declaration; the header: open the folder).
 */
function renderPackage(g: SVGGElement, n: ClassNodeGeom): SVGGElement {
  const o = CLASS_LAYOUT;
  const c = n.node;
  const grp = c.group!;
  const lc = layerClass(c.layer);
  // FR-28 a layer of the zoomed flow: its classes, nothing to open (◫ Layers in the sequence view shows the objects)
  if (grp.zoom) g.appendChild(svgTitle(`${c.name}\n${grp.classes} class${grp.classes === 1 ? '' : 'es'} of the flow${grp.violations ? ` · ⚠ ${grp.violations} layer violation${grp.violations === 1 ? '' : 's'} inside` : ''}\n⊕ shows its classes here; click a class to go to it`));
  else g.appendChild(svgTitle(`${grp.path}\n${packageLine(grp)}${grp.layers ? ` · ${splitText(grp.layers)}` : c.layer ? ` · ${c.layer}` : ''}\n${grp.external ? 'outside this folder — click to open it as its own map' : 'click to open it here (⊖ in the bar folds it again); right-click: open as its own map'}`));
  g.appendChild(svg('rect', { class: 'pkg-tab', x: 0, y: -7, width: Math.min(56, Math.round(n.width * 0.4)), height: 8, rx: 2, ry: 2 }));
  g.appendChild(svg('rect', { class: 'cls-box', width: n.width, height: n.height, rx: 3, ry: 3 }));
  if (lc) {
    g.appendChild(svg('rect', { class: 'cls-layer-head', x: 0.5, y: 0.5, width: n.width - 1, height: n.headerHeight - 0.5, rx: 2.5, ry: 2.5 }));
    g.appendChild(svg('rect', { class: 'cls-layer-bar', x: 0, y: 0, width: 4, height: n.height, rx: 2, ry: 2 }));
  }
  let y = o.padY + o.stereoH;
  g.appendChild(svg('text', { class: `cls-stereo pkg-count${grp.violations ? ' has-violations' : ''}`, x: round(n.width / 2), y: y - 3, 'text-anchor': 'middle' }, [n.stereoLine!])); // a package's line: its class count
  y += o.nameH;
  g.appendChild(svg('text', { class: 'cls-name pkg-name', x: round(n.width / 2), y: y - 4, 'text-anchor': 'middle', 'data-open-package': grp.path }, [c.name]));
  // FR-26.7 ⊕: open it in place (its folders and classes replace it)
  if (!grp.external && !grp.zoom) g.appendChild(svg('text', { class: 'pkg-expand', x: n.width - 7, y: o.padY + o.stereoH - 3, 'text-anchor': 'end', 'data-open-package': grp.path }, ['⊕']));
  // FR-28.7 a layer of the zoomed flow opens in place (its classes drawn, the other layers stay packages)
  if (grp.zoom) g.appendChild(svg('text', { class: 'pkg-expand', x: n.width - 7, y: o.padY + o.stereoH - 3, 'text-anchor': 'end', 'data-open-layer': grp.path }, ['⊕', svgTitle('Show its classes here')]));
  if (grp.layers) g.appendChild(splitBar(grp.layers, n.width, n.headerHeight));
  if (grp.in) g.appendChild(foldTag(grp.in, n.width));
  // FR-24.11 / FR-28.5 what the branch did to the classes inside (merged by the core), as on the layer's lifeline
  if (c.change) g.appendChild(changeTag(c.change, n.width, c.key));
  g.appendChild(svg('line', { class: 'cls-sep', x1: 0, x2: n.width, y1: n.headerHeight, y2: n.headerHeight }));
  y = n.headerHeight + o.padY;
  c.methods.slice(0, n.memberParts.length).forEach((m, i) => {
    y += o.methodH;
    const p = n.memberParts[i]; // one per shown row
    g.appendChild(svg('text', { class: 'cls-member pkg-class', x: o.padX, y: y - 4, 'data-member': m.name }, [p.name + p.rest, svgTitle(m.declaration ? `${m.name}\n${formatLocation(m.declaration)}` : m.name)]));
  });
  if (n.more) {
    y += o.methodH;
    const label = n.more.expanded ? '▴ fewer' : `… +${n.more.hidden.length} more`;
    const title = n.more.expanded ? 'Show fewer classes' : `${n.more.hidden.join('\n')}\n(click to show all ${n.more.total})`;
    g.appendChild(svg('text', { class: 'cls-more', x: o.padX, y: y - 4, 'data-more-toggle': c.key }, [label, svgTitle(title)]));
  }
  // FR-28.5 / FR-17.2 the I/O of the layer's classes, on the header's lower edge as on a class
  if (c.sideEffects && n.ioWidth !== undefined) {
    g.appendChild(sideEffectPill(c.sideEffects, 8, n.headerHeight - 6, n.ioWidth + 2 * IO_PILL_PAD, 'class-io', sideEffectLines(c.sideEffects, true).join('\n')));
  }
  return g;
}

/** `Domain 33 · Application 22 · no layer 3`. */
const splitText = (layers: NonNullable<NonNullable<ClassNode['group']>['layers']>): string => layers.map((l) => `${l.layer ?? 'no layer'} ${l.classes}`).join(' · ');

/**
 * a folder whose classes are in several layers: a strip on the header's lower edge, one piece per layer
 * as wide as its share (its lane and tint are the layer most of them are in).
 */
function splitBar(layers: NonNullable<NonNullable<ClassNode['group']>['layers']>, width: number, headerHeight: number): SVGGElement {
  const total = layers.reduce((n, l) => n + l.classes, 0);
  const g = svg('g', { class: 'pkg-split' }, [svgTitle(splitText(layers))]);
  let x = 4;
  for (const l of layers) {
    const w = ((width - 4) * l.classes) / total;
    g.appendChild(svg('rect', { class: `pkg-split-part ${layerClass(l.layer) || 'no-layer'}`, x: round(x), y: headerHeight - 3, width: round(w), height: 3 }));
    x += w;
  }
  return g;
}

/** FR-26.7 `⊖ ‹package›` above a box shown from an open package: folds that package again. */
function foldTag(pkg: string, width: number): SVGGElement {
  const label = `⊖ ${pkg.split('/').pop()}`;
  return svg('g', { class: 'fold-tag', 'data-app-fold': pkg }, [
    svgTitle(`Fold ${pkg} again`),
    svg('text', { class: 'fold-tag-text', x: width, y: -4, 'text-anchor': 'end' }, [label]),
  ]);
}

function renderNode(n: ClassNodeGeom, marks: readonly Finding[] = []): SVGGElement {
  const o = CLASS_LAYOUT;
  const c = n.node;
  const lc = layerClass(c.layer);
  const pkg = c.group ? ` package${c.group.external ? ' external' : ''}${c.group.violations ? ' has-violations' : ''}` : '';
  const g = svg('g', { class: `class-node kind-${c.kind}${pkg}${lc ? ` ${lc}` : ''}${c.usedOnly ? ' used-only' : ''}${c.stereotypes.includes('data') ? ' data-only' : ''}${c.diff ? ` diff-${c.diff}` : ''}`, 'data-class-key': c.key, transform: `translate(${round(n.x)},${round(n.y)})` });
  // FR-26.7 a class shown because its package is open in place
  const shownFrom = c.inPackage ? `\nin ${c.inPackage} (open — ⊖ in the bar folds it)` : c.inLayer ? (c.inLayer.alone ? `\npulled out of ${c.inLayer.name} (⊖ puts it back)` : `\nin ${c.inLayer.name}, opened (⊖ puts this class back; ⊖ on the lane folds the layer)`) : '';
  if (c.group) return renderPackage(g, n);
  // FR-7.8 the layer with the rule that placed it there (right-click → Why this layer?)
  const where = `${layerReasonLine(c.layer, c.layerReason) ?? c.layer ?? 'no layer'} · ${c.namespace}`;
  const other = c.otherMethodCount ? `\n${c.otherMethodCount} other method${c.otherMethodCount > 1 ? 's' : ''} not used in this interaction` : '';
  const usedOnly = c.usedOnly ? '\nonly referenced by the shown methods (no calls)' : '';
  const quiet = !n.stereoLine && c.stereotypes.length ? `\n${stereotypeText(c.stereotypes)}` : '';
  g.appendChild(svgTitle(`${c.name}${quiet}${c.declaration ? `\n${formatLocation(c.declaration)}` : ''}\n${where}${other}${usedOnly}${shownFrom}${c.diff === 'added' ? '\nreached only by calls new on this branch' : c.diff === 'removed' ? '\nreached only by calls this branch removed' : ''}`));
  g.appendChild(svg('rect', { class: 'cls-box', width: n.width, height: n.height, rx: 3, ry: 3 }));
  if (lc) {
    // Layer cue: tinted header and an accent bar on the left edge (colours in styles.css).
    g.appendChild(svg('rect', { class: 'cls-layer-head', x: 0.5, y: 0.5, width: n.width - 1, height: n.headerHeight - 0.5, rx: 2.5, ry: 2.5 }));
    g.appendChild(svg('rect', { class: 'cls-layer-bar', x: 0, y: 0, width: 4, height: n.height, rx: 2, ry: 2 }));
  }
  let y = o.padY;
  if (n.stereoLine) {
    y += o.stereoH;
    // FR-7.9 each stereotype with its reason
    const reasons = stereotypeReasonsTitle(c.stereotypeReasons);
    // a cut line (it has stereotypes, so stereoFull is set) shows the whole line
    const title = reasons ? svgTitle(reasons) : n.stereoLine !== n.stereoFull ? svgTitle(n.stereoFull!) : null;
    g.appendChild(svg('text', { class: 'cls-stereo', x: round(n.width / 2), y: y - 3, 'text-anchor': 'middle' }, [n.stereoLine, title]));
  }
  y += o.nameH;
  const abstract = c.kind === 'interface' || c.kind === 'abstract';
  g.appendChild(svg('text', { class: `cls-name${abstract ? ' abstract' : ''}`, x: round(n.width / 2), y: y - 4, 'text-anchor': 'middle' }, [c.name]));
  g.appendChild(svg('line', { class: 'cls-sep', x1: 0, x2: n.width, y1: n.headerHeight, y2: n.headerHeight }));
  y = n.headerHeight + o.padY;
  c.methods.slice(0, n.memberParts.length).forEach((m, i) => {
    y += o.methodH;
    // Method name emphasised, "(params): type" de-emphasised — like sequence message labels.
    const parts = n.memberParts[i]; // one per shown row
    const deco = m.diff === 'removed' ? 'line-through' : m.isStatic ? 'underline' : undefined;
    // FR-24.11 a member the branch added / changed / removed: its sign in the left margin, its change in the tooltip
    const change = m.diff ? c.change?.members.find((x) => x.name === m.name && x.change === m.diff && (x.kind === 'field') === !!m.field) : undefined;
    if (m.diff) g.appendChild(svg('text', { class: `cls-diff-sign ${m.diff}`, x: o.padX - 2, y: y - 4, 'text-anchor': 'end' }, [memberSign[m.diff]]));
    g.appendChild(
      svg('text', { class: `cls-member${m.isStatic ? ' static' : ''}${m.diff ? ` diff-${m.diff}` : ''}${m.field ? ' field' : ''}`, x: o.padX, y: y - 4, 'text-decoration': deco, 'data-member': m.name, ...(m.diff ? { 'data-member-diff': m.diff } : {}) }, [
        svg('tspan', { class: 'cls-m-name', 'text-decoration': deco }, [parts.name]),
        parts.rest ? svg('tspan', { class: 'cls-m-sig', 'text-decoration': deco }, [parts.rest]) : null,
        svgTitle(change ? memberTitle(change) : m.signature.replace(/\s+/g, ' ')),
      ]),
    );
  });
  if (n.more) {
    // FR-12.11: "… +k more" (hover lists them, click expands) or "▴ fewer" when expanded.
    y += o.methodH;
    const label = n.more.expanded ? '▴ fewer' : `… +${n.more.hidden.length} more`;
    const title = n.more.expanded ? `Show fewer methods` : `${n.more.hidden.join('\n')}\n(click to show all ${n.more.total})`;
    g.appendChild(svg('text', { class: 'cls-more', x: o.padX, y: y - 4, 'data-more-toggle': c.key }, [label, svgTitle(title)]));
  }
  // Last, so it stays on top of the tinted header.
  if (c.layerHint) g.appendChild(layerHintBadge(c.layer, c.layerHint, n.width));
  // the design issues of this class (the same list as the sequence diagram's)
  marks.forEach((f, i) => g.appendChild(findingMark(f, 9 + 12 * i, 14)));
  // FR-17.2 as on its participant: on the name compartment's lower edge, left
  if (c.sideEffects && n.ioWidth !== undefined) {
    g.appendChild(sideEffectPill(c.sideEffects, 8, n.headerHeight - 6, n.ioWidth + 2 * IO_PILL_PAD, 'class-io', sideEffectLines(c.sideEffects, true).join('\n')));
  }
  // the rows list the members the flow uses: the tag says how many of its changes are not among them
  if (c.change) g.appendChild(changeTag(c.change, n.width, c.key, undefined, c.methods.slice(0, n.memberParts.length).filter((m) => m.diff).length));
  if (c.inPackage) g.appendChild(foldTag(c.inPackage, n.width));
  // FR-28.7 a class of a layer opened in place: ⊖ in the corner folds the layer again (the lane names it)
  if (c.inLayer) g.appendChild(svg('text', { class: 'pkg-expand', x: n.width - 7, y: o.padY + o.stereoH - 3, 'text-anchor': 'end', 'data-fold-layer': c.key }, ['⊖', svgTitle(c.inLayer.alone ? `Pulled out of ${c.inLayer.name} — put it back` : `In ${c.inLayer.name}, opened — put this class back (the others stay out; ⊖ on the lane folds ${c.inLayer.name})`)]));
  // FR-28.11 the object view: ⊖ folds this class alone into its layer's package (while the class is hovered); a class
  // only used as a type has no objects to fold
  if (c.layerFold && !c.usedOnly) g.appendChild(svg('text', { class: 'pkg-expand obj-fold quiet', x: n.width - 7, y: o.padY + o.stereoH - 3, 'text-anchor': 'end', 'data-fold-layer': c.key }, ['⊖', svgTitle(`Fold into ${c.layerFold.name} — the layer's other classes stay out`)]));
  return g;
}

export function renderClassDiagram(geom: ClassGeometry, opts: { edgeStyle?: EdgeStyle; marks?: ReadonlyMap<string, Finding[]> } = {}): SVGSVGElement {
  const edgeStyle = opts.edgeStyle ?? 'curved';
  const root = svg('svg', { class: 'class-svg', width: geom.width, height: geom.height, viewBox: `0 0 ${geom.width} ${geom.height}` });
  root.appendChild(defs());
  if (geom.lanes) {
    const lanes = svg('g', { class: 'lanes' });
    for (const l of geom.lanes) {
      const lc = layerClass(l.layer);
      const g = svg('g', { class: `class-lane${lc ? ` ${lc}` : ''}`, 'data-lane': l.layer ?? '' });
      g.appendChild(svg('rect', { class: 'lane-band', x: round(l.x), y: round(l.y), width: round(l.width), height: round(l.height), rx: 6, ry: 6 }));
      g.appendChild(svg('text', { class: 'lane-label', x: round(l.x + 10), y: round(l.y + 15) }, [l.label]));
      // FR-28.7 / FR-28.8 a lane whose layer has classes out (opened, or pulled out): ⊖ at its right end folds them all;
      // FR-28.11 in the object view every lane of a layer
      const out = geom.nodes.map((nd) => nd.node).filter((c) => (c.inLayer ?? c.layerFold)?.name === l.label);
      if (out.length) {
        const key = (out[0].inLayer ?? out[0].layerFold)!.key;
        g.appendChild(svg('text', { class: 'pkg-expand lane-fold', x: round(l.x + l.width - 10), y: round(l.y + 16), 'text-anchor': 'end', 'data-fold-layer': key }, ['⊖', svgTitle(`Fold ${l.label}: one package for its ${out.length === 1 ? 'class' : `${out.length} classes`}`)]));
      }
      lanes.appendChild(g);
    }
    root.appendChild(lanes);
  }
  const edges = svg('g', { class: 'relations' });
  const names = new Map(geom.nodes.map((n) => [n.key, n.node.name]));
  for (const e of geom.edges) edges.appendChild(renderEdge(e, edgeStyle, (key) => names.get(key)!));
  const nodes = svg('g', { class: 'classes' });
  for (const n of geom.nodes) nodes.appendChild(renderNode(n, opts.marks?.get(n.key)));
  root.append(edges, nodes);
  return root;
}

/** FR-12.15 where the multiplicity goes: 16 px back from the target's end along the line, 9 px beside it. */
export function multiplicityPos(e: ClassEdgeGeom): { x: number; y: number } | undefined {
  const pts = e.points;
  if (pts.length < 2) return undefined;
  const end = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const dx = prev.x - end.x;
  const dy = prev.y - end.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x: end.x + ux * 16 - uy * 9, y: end.y + uy * 16 + ux * 9 + 4 };
}

