/** SVG rendering of a laid-out sequence diagram. Pure DOM construction, no event wiring. */
import type { FragmentKind, SequenceDiagram } from '@seqcall/protocol';
import { round, svg, svgTitle } from '../dom';
import { layerClass, layerObjectLines } from '../layers';
import { layerHintBadge } from '../layer-hint';
import { layerReasonLine, stereotypeReasonsTitle } from '../layer-reason';
import { IO_PILL_PAD, sideEffectLines, sideEffectPill } from '../side-effects';
import { formatLocation } from './labels';
import { stereotypeText } from '../measure';
import { changeTag } from '../review-marks';
import { findingMark } from '../finding-marks';
import { ENTRY_PAD, FOLDED_PAD, type FoldGeom, type FragmentGeom, type MessageGeom, type ParticipantGeom, type SequenceGeometry } from './layout';

/** ⊕ / ⊖ of a box on its top-right corner, clear of the name and the «…» line below it. */
function cornerGlyph(width: number, plus: boolean): SVGElement[] {
  const [cx, cy] = [width - 3, 3];
  return [
    svg('circle', { cx, cy, r: 6.5 }),
    svg('line', { x1: cx - 3.5, x2: cx + 3.5, y1: cy, y2: cy }),
    ...(plus ? [svg('line', { x1: cx, x2: cx, y1: cy - 3.5, y2: cy + 3.5 })] : []),
  ];
}

function participantBox(p: ParticipantGeom, y: number, extraClass = '', unknownWhy = ''): SVGGElement {
  const part = p.participant;
  const cls = ['participant', `kind-${part.kind}`, extraClass, part.implementsInterface ? 'is-impl' : '', part.diff ? `diff-${part.diff}` : ''].filter(Boolean).join(' ');
  const g = svg('g', { class: cls, 'data-participant-id': p.id, transform: `translate(${round(p.x - p.halfWidth)},${round(y)})` });
  const o = { padY: 8, stereoH: 14, labelH: 17 };
  const lines: { cls: string; text: string; title?: string }[] = [];
  // FR-7.9 the «…» line's tooltip: each stereotype with its reason
  if (p.stereoLine) lines.push({ cls: 'p-stereo', text: p.stereoLine, title: stereotypeReasonsTitle(part.stereotypeReasons) ?? (p.stereoLine !== p.stereoFull ? p.stereoFull : undefined) });
  if (p.hintLine) lines.push({ cls: 'p-hint', text: p.hintLine });
  g.appendChild(svg('rect', { class: 'p-box', width: p.width, height: p.boxHeight, rx: 4, ry: 4 }));
  // Text block is vertically centred in the (uniform-height) box.
  const labels = p.nameLine !== undefined ? [p.nameLine, p.classLine!] : [part.label];
  const blockH = lines.length * o.stereoH + labels.length * o.labelH;
  let ty = (p.boxHeight - blockH) / 2;
  for (const line of lines) {
    ty += o.stereoH;
    g.appendChild(
      svg('text', { class: line.cls, x: round(p.width / 2), y: round(ty - 3), 'text-anchor': 'middle' }, [line.text, line.title ? svgTitle(line.title) : null]),
    );
  }
  for (const label of labels) {
    ty += o.labelH;
    g.appendChild(svg('text', { class: 'p-label', x: round(p.width / 2), y: round(ty - 4), 'text-anchor': 'middle' }, [label]));
  }
  const where = part.declaration ? `\n${formatLocation(part.declaration)}` : '';
  const impl = part.implementsInterface ? `\nimplementation of ${part.implementsInterface.name}` : '';
  const alts = part.alternatives
    ? `\none of ${part.alternatives} objects created in mutually exclusive places (each returned, or in different branches): only one exists in a run`
    : part.instances
      ? part.instancesWhy === 'helper'
        ? `\n${part.instances} objects created in the drawn calls, shown as one (View ▾ → One lifeline per helper type): each «create» #n makes one of them; they may hold different values`
        : part.instancesWhy === 'value'
        ? `\n${part.instances} objects created in the drawn calls, shown as one: values — their class cannot change once built (readonly fields, no setters), so which one a call goes to changes nothing; each call shows its values`
        : `\n${part.instances} objects created in the drawn calls, shown as one: built the same way (no arguments, or the same line given the same values) and holding no state of their own (fields set only in the constructor), so which one a call goes to changes nothing`
      : '';
  // FR-6.7 several references to one container-made object
  const service = part.service === 'own'
    ? `\none object: its class keeps its only instance (private constructor, a static instance) — its static calls and the calls on that instance are drawn on it`
    : part.service
      ? `\none object: the DI container makes it once${part.service === 'scoped' ? ' per request (scoped)' : ' (singleton)'} — every field or parameter that holds it here is this object${part.heldAs ? ` (${part.heldAs.join(', ')})` : ''}${part.seamVia ? `\nno «seam»: only ${part.seamVia.join(', ')} reach${part.seamVia.length === 1 ? 'es' : ''} it through an interface, the other callers hold the class itself` : ''}`
      : '';
  // FR-24.6 the outline: whether this flow reaches it only now / only before (said in words)
  const reach = part.diff === 'added' ? '\nonly this branch’s flow reaches it' : part.diff === 'removed' ? '\nonly the base version’s flow reached it' : '';
  // FR-7.8 which rule placed it in its layer (right-click → Why this layer? for the whole story)
  const why = layerReasonLine(part.layer, part.layerReason);
  // the stereotypes the box leaves out (said by the name / the port line, «module»): all of them in the tooltip
  const quiet = part.stereotypes.length && p.stereoFull !== stereotypeText(part.stereotypes) ? `\n${stereotypeText(part.stereotypes)}` : '';
  // FR-28 a layer lifeline: the objects of the flow it stands for
  const objects = part.objects ? `\n${part.objects.length} object${part.objects.length === 1 ? '' : 's'} of the flow (⊕ shows them here, ◫ Open layers shows every layer's):\n${layerObjectLines(part.objects)}` : part.inLayer ? (part.inLayer.alone ? `\npulled out of ${part.inLayer.name} (⊖ puts it back)` : `\nin ${part.inLayer.name}, opened (⊖ puts this object back; ⊖ on the band folds the layer)`) : part.layerFold ? `\nin ${part.layerFold.name} (⊖ folds this object into it; ⊖ on the band folds the whole layer)` : '';
  g.appendChild(svgTitle(`${part.label}${quiet}${objects}${impl}${alts}${service}${where}${why ? `\n${why}` : ''}${reach}${unknownWhy}`));
  if (part.layerHint) g.appendChild(layerHintBadge(part.layer, part.layerHint, p.width));
  // FR-28.7 a layer lifeline opens in place (⊕); an object of an opened layer carries the tag that folds it again
  if (part.objects) {
    g.appendChild(
      svg('g', { class: 'layer-open', 'data-action': 'open-layer', 'data-layer': p.id, role: 'button' }, [
        svgTitle(`Show its ${part.objects.length === 1 ? 'object' : `${part.objects.length} objects`} here (the other layers stay folded)`),
        ...cornerGlyph(p.width, true),
      ]),
    );
  }
  if (part.inLayer) {
    // ⊖ in the corner (a tag above the box would sit on the band's label)
    g.appendChild(
      svg('g', { class: 'layer-open fold', 'data-action': 'fold-layer', 'data-layer': p.id, role: 'button' }, [
        svgTitle(part.inLayer.alone ? `Pulled out of ${part.inLayer.name} — put it back` : `In ${part.inLayer.name}, opened — put this object back (the others stay out; ⊖ on the band folds ${part.inLayer.name})`),
        ...cornerGlyph(p.width, false),
      ]),
    );
  }
  // FR-28.11 the object view: ⊖ folds this object alone into its layer (shown while the box is hovered, like the band's)
  if (part.layerFold) {
    g.appendChild(
      svg('g', { class: 'layer-open fold obj-fold quiet', 'data-action': 'fold-layer', 'data-layer': p.id, role: 'button' }, [
        svgTitle(`Fold into ${part.layerFold.name} — the layer's other objects stay out`),
        ...cornerGlyph(p.width, false),
      ]),
    );
  }
  // FR-24.11 what the branch did to its class
  if (part.change) g.appendChild(changeTag(part.change, p.width, part.classKey));
  // the design issues of its class (evidence classes only), top-left so the box keeps its size
  (p.marks ?? []).forEach((f, i) => g.appendChild(findingMark(f, 5 + 12 * i, 12)));
  // FR-17.2: on the bottom edge, left, so the box keeps its size
  if (part.sideEffects) {
    const w = p.ioWidth! + 2 * IO_PILL_PAD; // the layout measures the pill of every participant with side effects
    g.appendChild(sideEffectPill(part.sideEffects, 4, p.boxHeight - 6, w, 'participant-io', sideEffectLines(part.sideEffects, true).join('\n')));
  }
  return g;
}

/** the *unknown* lifeline says why its calls could not be followed (the reasons of the calls to it, once each). */
function unknownReasons(geom: SequenceGeometry, p: ParticipantGeom): string {
  if (p.participant.kind !== 'unknown') return '';
  const reasons = [...new Set(geom.messages.flatMap((mg) => (mg.message.to === p.id && mg.message.unresolved ? [mg.message.unresolved] : [])))];
  if (!reasons.length) return '\nCalls whose target could not be found';
  const shown = reasons.slice(0, 5).map((r) => `• ${r}`);
  return `\nCalls whose target could not be found:\n${shown.join('\n')}${reasons.length > 5 ? `\n+${reasons.length - 5} more (each call's card says its own)` : ''}`;
}

export function renderHeader(geom: SequenceGeometry): SVGSVGElement {
  const root = svg('svg', { class: 'seq-header-svg', width: geom.width, height: geom.headerHeight, viewBox: `0 0 ${geom.width} ${geom.headerHeight}` });
  const bands = svg('g', { class: 'groups' });
  for (const g of geom.groups) {
    const lc = layerClass(g.layer);
    const band = svg('g', { class: `group${lc ? ` ${lc}` : ''}`, 'data-group-id': g.id });
    band.appendChild(svg('rect', { class: 'group-band', x: round(g.x1), y: round(g.y), width: round(g.x2 - g.x1), height: round(g.height), rx: 6, ry: 6 }));
    band.appendChild(svg('text', { class: 'group-label', x: round(g.x1 + 8), y: round(g.y + 15) }, [g.displayLabel]));
    band.appendChild(svgTitle(g.title));
    // FR-28.7 / FR-28.8 the band of a layer with objects out (opened, or pulled out): ⊖ at its right end folds them all;
    // FR-28.11 in the object view every band of a layer (the band names which)
    const out = geom.participants.find((pg) => pg.participant.groupId === g.id && pg.participant.inLayer);
    const il = g.fold ?? out?.participant.inLayer;
    if (il) {
      const n = g.fold ? geom.participants.filter((pg) => geom.groups.find((x) => x.id === pg.participant.groupId)?.fold?.key === il.key).length : geom.participants.filter((pg) => pg.participant.inLayer?.key === il.key).length;
      band.appendChild(
        // FR-28.11 in the object view (every band has one) only while the band is hovered: it covers the label's end
        svg('g', { class: `layer-open fold band-fold${g.fold ? ' quiet' : ''}`, 'data-action': 'fold-layer', 'data-layer': il.key, role: 'button' }, [
          svgTitle(`Fold ${il.name}: one lifeline for its ${n === 1 ? 'object' : `${n} objects`}`),
          svg('circle', { cx: round(g.x2 - 12), cy: round(g.y + 11), r: 6.5 }),
          svg('line', { x1: round(g.x2 - 15.5), x2: round(g.x2 - 8.5), y1: round(g.y + 11), y2: round(g.y + 11) }),
        ]),
      );
    }
    bands.appendChild(band);
  }
  root.appendChild(bands);
  const stubs = svg('g', { class: 'lifeline-stubs' });
  const boxes = svg('g', { class: 'participants' });
  for (const p of geom.participants) {
    if (!p.faded) {
      stubs.appendChild(svg('line', { class: 'lifeline', x1: round(p.x), x2: round(p.x), y1: round(p.headerY + p.boxHeight), y2: geom.headerHeight }));
    }
    boxes.appendChild(participantBox(p, p.headerY, p.faded ? 'faded' : '', unknownReasons(geom, p)));
  }
  root.appendChild(stubs);
  root.appendChild(boxes);
  return root;
}

function markerDefs(): SVGDefsElement {
  const defs = svg('defs');
  const filled = (id: string, cls: string) =>
    svg('marker', { id, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, [
      svg('path', { class: cls, d: 'M0,1 L10,5 L0,9 z' }),
    ]);
  const open = (id: string, cls: string) =>
    svg('marker', { id, viewBox: '0 0 10 10', refX: 9.5, refY: 5, markerWidth: 10, markerHeight: 10, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, [
      svg('path', { class: cls, d: 'M0,0.5 L9.5,5 L0,9.5', fill: 'none' }),
    ]);
  defs.append(
    filled('seqcall-arrow', 'arrow-head'),
    filled('seqcall-arrow-muted', 'arrow-head muted'),
    open('seqcall-arrow-open', 'arrow-open'),
    open('seqcall-arrow-open-muted', 'arrow-open muted'),
    filled('seqcall-arrow-removed', 'arrow-head removed'),
    open('seqcall-arrow-open-removed', 'arrow-open removed'),
  );
  return defs;
}

function messageClasses(mg: MessageGeom, highlighted: boolean, violates: boolean | 'possible'): string {
  const m = mg.message;
  return [
    'message',
    `kind-${m.kind}`,
    m.isLibrary ? 'library' : '',
    m.isAsync ? 'async' : '',
    m.recursive ? 'recursive' : '',
    m.polymorphic ? 'polymorphic' : '',
    m.expanded ? 'expanded' : '',
    m.importance?.low ? 'low' : '',
    highlighted ? 'highlighted' : '',
    // FR-19.17 the call breaks the dependency rule (the class diagram's red relation)
    violates ? 'violates' : '',
    // FR-7.16 only possible: it rests on a guessed layer
    violates === 'possible' ? 'possible' : '',
    // FR-24.4 review: the call is on a changed line / its method was added or changed on the branch
    m.diff?.call ? 'diff-call' : '',
    m.diff?.method ? `diff-method diff-${m.diff.method}` : '',
    // FR-24.6 compared with the base version: a new call, an edited one, a call the branch removed (ghost)
    m.diff?.status ? `diff-st-${m.diff.status}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function renderMessage(mg: MessageGeom, highlighted: boolean, violates: boolean | 'possible' = false): SVGGElement {
  const m = mg.message;
  const g = svg('g', { class: messageClasses(mg, highlighted, violates), 'data-msg-id': m.id });
  // the call text and importance are shown by the view's hover card (messageCard)
  g.appendChild(svg('rect', { class: 'msg-highlight', x: round(mg.box.x), y: round(mg.box.y), width: round(mg.box.width), height: round(mg.box.height), rx: 4, ry: 4 }));

  const openHead = m.kind === 'create' || m.isAsync;
  const marker = `url(#seqcall-arrow${openHead ? '-open' : ''}${m.diff?.status === 'removed' ? '-removed' : m.isLibrary ? '-muted' : ''})`;
  let d: string;
  if (mg.loopX !== undefined && mg.y2 !== undefined) {
    d = `M${round(mg.x1)},${round(mg.y)} H${round(mg.loopX)} V${round(mg.y2)} H${round(mg.x2)}`;
  } else {
    d = `M${round(mg.x1)},${round(mg.y)} H${round(mg.x2)}`;
  }
  g.appendChild(svg('path', { class: 'msg-hit', d }));
  g.appendChild(svg('path', { class: `msg-line${m.kind === 'create' ? ' dashed' : ''}`, d, 'marker-end': marker }));
  if (m.kind === 'found') g.appendChild(svg('circle', { class: 'found-gate', cx: round(mg.x1), cy: round(mg.y), r: 3.5 }));
  // the label's pieces together: they slide along a long arrow to stay in view (FR-10.4)
  const label = svg('g', { class: 'msg-label' });
  g.appendChild(label);
  label.appendChild(svg('rect', { class: 'msg-hit-label', x: round(mg.labelX - 2), y: round(mg.labelY - 13), width: round(mg.label.width + 4), height: 17 }));
  // Opaque backdrop so lifelines crossing long spans do not run through the text.
  label.appendChild(svg('rect', { class: 'msg-label-bg', x: round(mg.labelX - 3), y: round(mg.labelY - 11), width: round(mg.label.width + 6), height: 14, rx: 3, ry: 3 }));

  for (const seg of mg.label.segments) {
    const x = mg.labelX + seg.dx;
    switch (seg.kind) {
      case 'glyph': {
        const cx = round(x + 7);
        const cy = round(mg.labelY - 4);
        // FR-11.7 ⊡ a call a "don't expand" rule keeps folded: Expand all / Smart pass it by, a click still opens it
        const stopped = !m.expanded && !!m.noExpand;
        const glyph = svg('g', { class: stopped ? 'expand-glyph no-expand' : 'expand-glyph', 'data-action': m.expanded ? 'collapse' : 'expand', role: 'button' }, [
          svgTitle(m.expanded ? 'Collapse' : stopped ? "Not expanded by Overview / Expand all (a Don't expand filter) — click to expand" : 'Expand (Shift+click: expand everything below)'),
          stopped ? svg('rect', { x: cx - 6, y: cy - 6, width: 12, height: 12, rx: 1.5 }) : svg('circle', { cx, cy, r: 6.5 }),
          stopped ? svg('circle', { class: 'dot', cx, cy, r: 1.6 }) : svg('line', { x1: cx - 3.5, x2: cx + 3.5, y1: cy, y2: cy }),
          m.expanded || stopped ? null : svg('line', { x1: cx, x2: cx, y1: cy - 3.5, y2: cy + 3.5 }),
        ]);
        label.appendChild(glyph);
        // FR-24.9 changes hidden below this collapsed call (the review's changed methods)
        if (!m.expanded && m.diff?.inside) {
          label.appendChild(
            svg('g', { class: 'diff-inside', 'data-action': 'reveal-change', role: 'button' }, [
              svgTitle(`${m.diff.inside} changed method${m.diff.inside > 1 ? 's' : ''} below — click to expand down to the first`),
              svg('circle', { cx: cx + 7, cy: cy - 6, r: 5.5 }),
              svg('text', { x: cx + 7, y: cy - 3.5, 'text-anchor': 'middle' }, [String(Math.min(m.diff.inside, 9))]),
            ]),
          );
        }
        break;
      }
      case 'poly': {
        const pill = svg('g', { class: 'poly-badge' + (m.polymorphic?.selectedKey ? ' selected' : ''), 'data-action': 'implementations', role: 'button' }, [
          svgTitle(`${m.polymorphic!.interfaceName}: choose implementation`),
          svg('rect', { x: round(x), y: round(mg.labelY - 11), width: round(seg.width), height: 14, rx: 7, ry: 7 }),
          svg('text', { class: 'seg-marker', x: round(x + 6), y: round(mg.labelY - 1) }, [seg.text]),
        ]);
        label.appendChild(pill);
        break;
      }
      case 'entry': {
        // FR-16.3: the entry point at the gate, coloured by kind (the hover card lists all of them)
        label.appendChild(
          svg('g', { class: `entry-badge kind-${seg.entryKind}`, 'data-entry': seg.entryKind }, [
            svg('rect', { x: round(x), y: round(mg.labelY - 11), width: round(seg.width), height: 14, rx: 3, ry: 3 }),
            svg('text', { class: 'entry-text', x: round(x + ENTRY_PAD), y: round(mg.labelY - 1) }, [seg.text]),
          ]),
        );
        break;
      }
      case 'inherited': {
        // FR-5.11 ↑ drawn, not a font glyph (thin in most fonts at this size); the text stays for find / copy
        const ax = round(x + 4);
        const top = round(mg.labelY - 10);
        const bottom = round(mg.labelY);
        label.appendChild(
          svg('g', { class: 'seg-inherited' }, [
            svg('path', { d: `M${ax},${bottom} V${top + 1} M${ax - 3},${top + 4} L${ax},${top + 1} L${ax + 3},${top + 4}` }),
            svg('text', { class: 'seg-inherited-text', x: round(x), y: round(mg.labelY) }, [seg.text]),
          ]),
        );
        break;
      }
      case 'io':
        label.appendChild(sideEffectPill(m.sideEffects!, x, mg.labelY - 10, seg.width));
        break;
      case 'outcome':
        // FR-32.2 the I/O of the entry point's whole flow (its hover card is the message's)
        label.appendChild(svg('text', { class: `seg-outcome${seg.atLeast ? ' at-least' : ''}`, x: round(x), y: round(mg.labelY) }, [seg.text]));
        break;
      case 'folded': {
        // FR-28 the calls inside the layer this call folds away (the hover card lists them)
        const f = m.folded!;
        const more = f.count > f.names.length ? `\n+${f.count - f.names.length} more` : '';
        const open = f.expandable ? `\n${f.expandable} still collapsed — ⊕ opens them` : '';
        // FR-24.9 the branch changed some of them: steps of the review (▶ opens the layer)
        const changed = m.diff?.folded ? `\n▲ ${m.diff.folded} changed on this branch — ▶ in the review bar opens the layer` : '';
        label.appendChild(
          svg('g', { class: `folded-badge${f.expandable ? ' has-collapsed' : ''}${m.diff?.folded ? ' has-changes' : ''}` }, [
            svgTitle(`${f.count} call${f.count === 1 ? '' : 's'} inside the layer, folded:\n${f.names.join('\n')}${more}${open}${changed}`),
            svg('rect', { x: round(x), y: round(mg.labelY - 10), width: round(seg.width), height: 13, rx: 6, ry: 6 }),
            svg('text', { class: 'seg-folded', x: round(x + FOLDED_PAD), y: round(mg.labelY - 0.5) }, [seg.text]),
          ]),
        );
        break;
      }
      case 'finding':
        // a design issue whose evidence starts here
        label.appendChild(findingMark(seg.finding!, x + 1, mg.labelY));
        break;
      default: {
        const cls = { result: 'seg-result', prefix: 'seg-prefix', name: 'seg-name', args: 'seg-args', recursive: 'seg-recursive' }[seg.kind];
        label.appendChild(svg('text', { class: cls, x: round(x), y: round(mg.labelY) }, [seg.text]));
      }
    }
  }
  return g;
}

const FRAGMENT_TITLES: Record<FragmentKind, string> = {
  alt: 'alternatives',
  opt: 'optional',
  loop: 'loop',
  try: 'try / catch',
  callback: 'callback: a lambda passed to a library function (runs when that function calls it)',
};

/**
 * Combined fragment (FR-1.10): a frame with a pentagon tag ("alt", "opt", "loop", "try"),
 * guards in brackets, dashed separators between operands. The frame itself ignores the mouse
 * (messages inside stay clickable); the tag and the guards navigate to the code.
 */
/** the guard of an alternative says what its right-click does (otherwise no one finds it). */
function caseHint(f: FragmentGeom['fragment'], k: number): string {
  if (f.kind !== 'alt' || f.operands[k].case === undefined) return '';
  if (f.followed) return '\nRight-click: Show all cases';
  return f.operands.length > 1 ? '\nRight-click: Follow this case (the other cases leave both diagrams)' : '';
}

/** What `g` tests against null: `x === null` / `x == null` / `x is null` → "x" (`negated`: `!==`, `!=`, `is not null`). */
function nullTested(g: string, negated: boolean): string | undefined {
  if (!g.endsWith('null')) return undefined;
  const head = g.slice(0, -'null'.length);
  const word = negated ? 'is not ' : 'is ';
  if (head.endsWith(word)) return head.slice(0, -word.length).trimEnd();
  const op = (negated ? ['!==', '!='] : ['===', '==']).find((o) => head.trimEnd().endsWith(o));
  return op ? head.trimEnd().slice(0, -op.length).trimEnd() : undefined;
}

/** a simple condition in words: `!id` → "id is empty, false or missing"; otherwise the code as written. */
export function plainCondition(g: string): string {
  const name = /^[\w$.]+(?:\(\))?$/;
  const not = /^!\(?([\w$.]+(?:\(\))?)\)?$/.exec(g);
  if (not) return `${not[1]} is empty, false or missing`;
  const nul = nullTested(g, false);
  if (nul && name.test(nul)) return `${nul} is null`;
  const set = nullTested(g, true);
  if (set && name.test(set)) return `${set} is set (not null)`;
  return name.test(g) ? `${g} is set (not empty, not false)` : g;
}

/** what an operand's guard means, in one sentence (alt / opt only; loops and catches say it already). */
function guardSentence(kind: string, guard: string, first: boolean): string {
  if (kind === 'alt') return guard === 'else' ? '\nThis case runs when no case above holds' : `\nThis case runs if ${first ? '' : 'no case above holds and '}${plainCondition(guard)}`;
  if (kind === 'opt') return `\nRuns only if ${plainCondition(guard)}`;
  return '';
}

function renderFragment(fg: FragmentGeom): SVGGElement {
  const f = fg.fragment;
  const g = svg('g', { class: `fragment kind-${f.kind}${f.collapsed ? ' collapsed' : ''}`, 'data-fragment-id': f.id });
  const x1 = round(fg.x1);
  const x2 = round(fg.x2);
  const y1 = round(fg.y1);
  const y2 = round(fg.y2);
  g.appendChild(svg('rect', { class: 'frag-frame', x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 2, ry: 2 }));
  const w = fg.tagWidth;
  const h = fg.tagHeight;
  const tag = svg('g', { class: 'frag-tag', 'data-fragment-part': 'tag', role: 'button' }, [
    svgTitle(`${FRAGMENT_TITLES[f.kind]}${fg.operands[0]?.guardFull ? ` [${fg.operands[0].guardFull}]` : ''}${f.range ? `
${formatLocation(f.range)} · click to go to the code` : ''}`),
    svg('path', { class: 'frag-tag-bg', d: `M${x1},${y1} H${x1 + w} V${y1 + h - 4} L${x1 + w - 4},${y1 + h} H${x1} Z` }),
    svg('text', { class: 'frag-tag-text', x: x1 + 5, y: y1 + h - 3 }, [f.kind]),
  ]);
  g.appendChild(tag);
  fg.operands.forEach((op, k) => {
    if (k > 0) g.appendChild(svg('line', { class: 'frag-sep', x1, x2, y1: round(op.y), y2: round(op.y) }));
    if (!op.guard) return;
    g.appendChild(
      svg('text', { class: 'frag-guard', x: round(op.guardX), y: round(op.guardY), 'data-fragment-part': 'guard', 'data-operand': k }, [
        op.kindWidth ? svg('tspan', { class: 'frag-kind' }, [f.kind]) : null,
        svg('tspan', { x: round(op.guardX + op.kindWidth) }, [op.guard]),
        svgTitle(`[${op.guardFull}]${guardSentence(f.kind, op.guardFull!, k === 0)}${op.range ? `
${formatLocation(op.range)} · click to go to the code` : ''}${caseHint(f, k)}`),
      ]),
    );
    if (op.fold) g.appendChild(foldElement(op.fold, op.guardY));
    // FR-1.17 what the catch does with the error
    if (op.outcome)
      g.appendChild(
        svg('text', { class: `frag-outcome${op.swallowed ? ' swallowed' : ''}`, x: round(op.outcomeX!), y: round(op.guardY) }, [
          op.outcome,
          svgTitle(op.swallowed ? 'The error ends here: not rethrown, not returned — the caller never learns it failed' : 'The error becomes this return value: the caller sees no exception'),
        ]),
      );
  });
  // FR-1.12: minimized → "⋯ n calls" (click restores); otherwise a glyph to minimize
  if (fg.summary) {
    const title =
      fg.summary.action === 'all-cases'
        ? 'You follow this case: the other cases of this alternative are left out. Click to show all cases'
        : 'Restore: show the calls of this fragment';
    g.appendChild(
      svg('text', { class: `frag-summary${fg.summary.action === 'all-cases' ? ' followed' : ''}`, x: round(fg.summary.x), y: round(fg.summary.y), 'data-fragment-action': fg.summary.action, role: 'button' }, [
        fg.summary.text,
        svgTitle(title),
      ]),
    );
  }
  const cx = round(fg.toggleX);
  const cy = round(fg.toggleY);
  g.appendChild(
    svg('g', { class: 'expand-glyph frag-toggle', 'data-fragment-action': f.collapsed ? 'expand' : 'collapse', role: 'button' }, [
      svgTitle(f.collapsed ? 'Restore fragment' : 'Minimize fragment to one row'),
      svg('circle', { cx, cy, r: 5 }),
      svg('line', { x1: cx - 2.5, x2: cx + 2.5, y1: cy, y2: cy }),
      f.collapsed ? svg('line', { x1: cx, x2: cx, y1: cy - 2.5, y2: cy + 2.5 }) : null,
    ]),
  );
  return g;
}

/** FR-3.11 "⊕ 2 calls" after an exit marker / a catch row: shows the error branch Smart folded. */
function foldElement(fold: FoldGeom, y: number): SVGElement {
  return svg('text', { class: 'error-fold', x: round(fold.x), y: round(y), 'data-error-path': fold.errorPath.key, role: 'button' }, [
    fold.text,
    svgTitle(`Error path (${fold.errorPath.reason}), folded (↯ Fold errors). Click to show its calls; ↯ off shows them all`),
  ]);
}

export function renderBody(geom: SequenceGeometry, highlighted: ReadonlySet<string> = new Set(), violating: ReadonlyMap<string, boolean | 'possible'> = new Map()): SVGSVGElement {
  const h = geom.bodyHeight;
  const root = svg('svg', { class: 'seq-body-svg', width: geom.width, height: h, viewBox: `0 0 ${geom.width} ${h}` });
  root.appendChild(markerDefs());
  const lifelines = svg('g', { class: 'lifelines' });
  const heads = svg('g', { class: 'created-heads' });
  for (const p of geom.participants) {
    lifelines.appendChild(svg('line', { class: `lifeline${p.participant.diff === 'removed' ? ' diff-removed' : ''}`, 'data-lifeline': p.id, x1: round(p.x), x2: round(p.x), y1: round(p.lifelineTop), y2: round(p.lifelineBottom) }));
    // FR-23.5 a wider, invisible line to Shift+click (the dashed one is 1px); under the calls, which keep their clicks
    lifelines.appendChild(svg('line', { class: 'lifeline-hit', 'data-lifeline': p.id, x1: round(p.x), x2: round(p.x), y1: round(p.lifelineTop), y2: round(p.lifelineBottom) }));
    if (p.createdHeadY !== undefined) heads.appendChild(participantBox(p, p.createdHeadY, 'created-head'));
  }
  const acts = svg('g', { class: 'activations' });
  // Outer bars first so nested (offset) bars are drawn on top and stay visible.
  const byId = new Map(geom.messages.map((mg) => [mg.id, mg.message]));
  for (const a of [...geom.activations].sort((p, q) => p.level - q.level)) {
    // FR-2.5: an activation bar leads to the definition of the method it executes
    const m = byId.get(a.messageId);
    const target = m?.targetDeclaration;
    const title = target ? svgTitle(`${m!.className ? `${m!.className}.` : ''}${m!.methodName} — ${formatLocation(target)} · click to go to the definition`) : null;
    acts.appendChild(svg('rect', { class: `activation${target ? ' nav' : ''}`, 'data-activation-for': a.messageId, x: round(a.x), y: round(a.y1), width: geom.options.actW, height: round(a.y2 - a.y1) }, [title]));
  }
  const frags = svg('g', { class: 'fragments' });
  for (const fg of geom.fragments) frags.appendChild(renderFragment(fg));
  const msgs = svg('g', { class: 'messages' });
  for (const mg of geom.messages) msgs.appendChild(renderMessage(mg, highlighted.has(mg.id), violating.get(mg.id) ?? false));
  // FR-1.15 early exits: muted text next to the activation bar, clickable (reveals the statement)
  const exits = svg('g', { class: 'exits' });
  for (const eg of geom.exits) {
    exits.appendChild(
      svg('g', { class: `exit-marker kind-${eg.exit.kind}${eg.exit.swallowed ? ' swallowed' : ''}`, 'data-exit-id': eg.exit.id, role: 'button' }, [
        svg('rect', { class: 'exit-hit', x: round(eg.x - 2), y: round(eg.y - 10), width: round(eg.width + 4), height: 13 }),
        svg('text', { class: 'exit-text', x: round(eg.x), y: round(eg.y) }, [eg.text]),
      ]),
    );
    if (eg.fold) exits.appendChild(foldElement(eg.fold, eg.y));
  }
  root.append(lifelines, heads, acts, frags, msgs, exits);
  return root;
}

export function rootDeclarationRange(d: SequenceDiagram) {
  return d.messages.find((m) => m.id === 'root')?.callSite ?? d.root.declaration;
}
