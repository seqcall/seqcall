/**
 * Pure sequence-diagram layout: model + options + manual x positions → geometry.
 * No DOM access; text widths come from the injected `measure` function.
 *
 * Coordinates: x is shared by header and body. The header and the body are separate
 * SVGs, each with y = 0 at its own top.
 */
import type { EntryPoint, ErrorPathFold, ExitMarker, Finding, Fragment, Message, Participant, ParticipantPositions, SequenceDiagram, SourceRange } from '@seqcall/protocol';
import { IO_PILL_PAD, outcomeText, sideEffectText } from '../side-effects';
import { estimateTextWidth, fitStereotypes, fitText, shownStereotypes, stereotypeText, type MeasureText, type TextStyle } from '../measure';
import { abbreviateArgument, formatMessageLabel, type MessageLabel } from './labels';
import { displayRoute } from './entry-points';
import { classMarks, designIssues } from '../finding-marks';
import { FINDING_ICON } from '../finding-guide';

export interface SequenceLayoutOptions {
  /** x of the gate the found message starts from. */
  gateX: number;
  marginX: number;
  /** Gap between neighbouring participant boxes in the automatic layout. */
  participantGap: number;
  /** Gap used by Tidy up (FR-10.2). */
  tidyGap: number;
  /** Extra gap where the group changes. */
  groupGap: number;
  /** Horizontal padding a message label keeps from the arrow ends. */
  labelPad: number;
  /**
   * Free space (span minus label width) above which a label is placed next to its sender
   * instead of centred over the whole span, so the eye connects it with its origin.
   */
  senderSideFree: number;
  /**
   * Call labels push neighbouring lifelines apart only up to this width; longer labels run past
   * the target lifeline (opaque backdrop). Default 0: participants stay as close as their boxes
   * allow and labels cross lifelines (FR-10.1, the user prefers objects close together).
   */
  labelPushMax: number;
  /** The found message's label (left of the first lifeline) gets up to this much room. */
  foundLabelMax: number;
  boxPadX: number;
  boxPadY: number;
  stereoLineH: number;
  labelLineH: number;
  minBoxWidth: number;
  /** A participant box widens for its stereotype line up to this text width, then truncates. */
  stereoMaxWidth: number;
  /** A `name:Class` label wider than this goes on two lines, the name above `:Class` (narrower boxes). */
  splitLabelAt: number;
  headerTop: number;
  groupBandH: number;
  bandPad: number;
  headerBottom: number;
  bodyTop: number;
  /** Space above an arrow reserved for its label. */
  labelSpace: number;
  rowGap: number;
  selfLoopW: number;
  selfLoopH: number;
  actW: number;
  minActH: number;
  actTail: number;
  bodyBottom: number;
  /** Width reserved for the expand/collapse glyph. */
  glyphW: number;
  segGap: number;
  /** Combined fragments (FR-1.10): height of the frame's tag row. */
  fragHeaderH: number;
  /** Height of an operand separator row (dashed line + guard). */
  fragSepH: number;
  /** Space below the last message of a fragment. */
  fragPadBottom: number;
  /** Horizontal padding of a frame around its content; nested frames add it again. */
  fragPadX: number;
  /** Guards longer than this many characters are abbreviated (full text in the tooltip). */
  fragGuardMax: number;
  /** Height of an early-exit marker row (FR-1.15). */
  exitH: number;
  /** Height of a minimized fragment's one-row stub (FR-1.12). */
  fragStubH: number;
}

export const DEFAULT_LAYOUT: SequenceLayoutOptions = {
  gateX: 10,
  marginX: 20,
  participantGap: 12,
  tidyGap: 10,
  groupGap: 12,
  labelPad: 12,
  labelPushMax: 0,
  foundLabelMax: 180,
  senderSideFree: 320,
  boxPadX: 8,
  boxPadY: 8,
  stereoLineH: 14,
  labelLineH: 17,
  minBoxWidth: 48,
  stereoMaxWidth: 200,
  splitLabelAt: 120,
  headerTop: 8,
  groupBandH: 22,
  bandPad: 4,
  headerBottom: 12,
  bodyTop: 12,
  labelSpace: 16,
  rowGap: 10,
  selfLoopW: 28,
  selfLoopH: 18,
  actW: 10,
  minActH: 14,
  actTail: 6,
  bodyBottom: 40,
  glyphW: 18,
  segGap: 5,
  fragHeaderH: 13,
  fragSepH: 13,
  fragPadBottom: 5,
  fragPadX: 6,
  fragGuardMax: 40,
  fragStubH: 17,
  exitH: 14,
};

export type LabelSegmentKind = 'entry' | 'result' | 'prefix' | 'inherited' | 'name' | 'args' | 'folded' | 'recursive' | 'finding' | 'io' | 'outcome' | 'poly' | 'glyph';

export interface LabelSegment {
  kind: LabelSegmentKind;
  text: string;
  /** Offset from the label start. */
  dx: number;
  width: number;
  style: TextStyle;
  /** FR-16.3 `entry` segments: the entry point's kind (colour). */
  /** `setup`: the DI container's step before the entry point (FR-8.7). */
  entryKind?: EntryPoint['kind'] | 'setup';
  /** `finding` segments: the design issue whose evidence starts at this call. */
  finding?: Finding;
  /** FR-32.2 `outcome` segments: the flow was not followed to its end. */
  atLeast?: true;
}

export interface LabelGeom {
  label: MessageLabel;
  segments: LabelSegment[];
  width: number;
}

export interface ParticipantGeom {
  id: string;
  participant: Participant;
  /** Lifeline centre. */
  x: number;
  width: number;
  halfWidth: number;
  /** Lines above the label: all «stereotypes» on one (possibly truncated) line and the «interface» hint (FR-6.3, FR-8.2). */
  stereoLine?: string;
  /** Untruncated stereotype line (tooltip when `stereoLine` is truncated). */
  stereoFull?: string;
  hintLine?: string;
  /** A long `name:Class` label on two lines: the name, then `:Class` (instead of the label). */
  nameLine?: string;
  classLine?: string;
  /** FR-17.2 text width of the participant's I/O pill. */
  ioWidth?: number;
  /** the design issues whose evidence is this participant's class only (marked on the box). */
  marks?: Finding[];
  /** Header box top (header coordinates). */
  headerY: number;
  boxHeight: number;
  /** Drawn faded in the header because it is created inside the diagram (FR-5.2). */
  faded: boolean;
  /** Body y of the head box top for created participants (FR-5.1). */
  createdHeadY?: number;
  lifelineTop: number;
  lifelineBottom: number;
}

export interface GroupGeom {
  id: string;
  label: string;
  /** Full "Layer · folder/path" for the tooltip. */
  title: string;
  layer?: string;
  /** Possibly truncated label that fits the band. */
  displayLabel: string;
  /** FR-28.11 the layer the band's ⊖ folds (object view). */
  fold?: { key: string; name: string };
  x1: number;
  x2: number;
  y: number;
  height: number;
}

export interface ActivationGeom {
  participantId: string;
  messageId: string;
  level: number;
  /** Left edge. */
  x: number;
  y1: number;
  y2: number;
}

export interface MessageGeom {
  id: string;
  message: Message;
  kind: Message['kind'];
  x1: number;
  x2: number;
  /** Arrow y (outgoing segment for self messages). */
  y: number;
  /** Self messages: right x of the loop and y of the return segment. */
  loopX?: number;
  y2?: number;
  labelX: number;
  /** Text baseline of the label. */
  labelY: number;
  label: LabelGeom;
  /** Bounding box (for highlight / scroll into view / hit testing). */
  box: { x: number; y: number; width: number; height: number };
}

export interface FragmentOperandGeom {
  /** Top of the operand: the frame top for the first operand, the dashed separator otherwise. */
  y: number;
  /** Displayed guard incl. brackets ("[user.isActive]"), possibly abbreviated; undefined = no guard. */
  guard?: string;
  /** Untruncated guard (tooltip). */
  guardFull?: string;
  /** FR-1.10 width of the frame's kind (`loop`, `opt`, …) written before the guard (0 = none); `guardWidth` includes it. */
  kindWidth: number;
  guardX: number;
  /** Text baseline of the guard. */
  guardY: number;
  guardWidth: number;
  range?: SourceRange;
  /** FR-1.17 a catch: what happens to the error, drawn after the guard ("logged, swallowed"). */
  outcome?: string;
  outcomeX?: number;
  swallowed?: boolean;
  /** FR-3.11 a catch Smart folded: "⊕ 2 calls" after the guard / outcome. */
  fold?: FoldGeom;
}

/** FR-3.11 what is left of an error branch Smart expand folded: "⊕ 2 calls" (click shows them). */
export interface FoldGeom {
  text: string;
  x: number;
  width: number;
  errorPath: ErrorPathFold;
}

export function foldText(f: ErrorPathFold): string {
  return `⊕ ${f.calls} call${f.calls === 1 ? '' : 's'}`;
}

export interface FragmentGeom {
  id: string;
  fragment: Fragment;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  /** Pentagon tag in the top-left corner ("alt", "opt", "loop", "try"). */
  tagWidth: number;
  tagHeight: number;
  operands: FragmentOperandGeom[];
  /** FR-1.12: centre of the minimize / restore glyph in the tag row. */
  toggleX: number;
  toggleY: number;
  /** Collapsed fragments: "⋯ 3 calls" after the guard (restores it); FR-1.22 a followed alt: "📌 2 other cases" (shows them). */
  summary?: { text: string; x: number; y: number; action: 'expand' | 'all-cases' };
}

export interface SequenceGeometry {
  width: number;
  headerHeight: number;
  bodyHeight: number;
  gateX: number;
  participants: ParticipantGeom[];
  groups: GroupGeom[];
  activations: ActivationGeom[];
  messages: MessageGeom[];
  /** Combined fragments (FR-1.10), outer before inner. */
  fragments: FragmentGeom[];
  /** FR-1.15 early-exit markers. */
  exits: ExitGeom[];
  options: SequenceLayoutOptions;
}

/** FR-1.15: an early-exit marker next to its owner's activation bar. */
export interface ExitGeom {
  exit: ExitMarker;
  /** Text start and baseline. */
  x: number;
  y: number;
  text: string;
  width: number;
  /** FR-3.11 the calls of its error branch Smart folded. */
  fold?: FoldGeom;
}

/** "↩ [!user]", "↯ [!valid] ValidationException", FR-3.11 "⤷ [credentials is null]" (guard shortened like frame guards). */
export function exitText(e: ExitMarker, guardMax: number): string {
  const guard = e.guard ? ` [${abbreviateArgument(e.guard, guardMax)}]` : '';
  if (e.kind === 'branch') return `⤷${guard}${e.outcome ? ` ${e.outcome}` : ''}`;
  return e.kind === 'return' ? `↩${guard}` : `↯${guard}${e.exception ? ` ${e.exception}` : ''}`;
}

// ───────────────────────────── measuring ─────────────────────────────

interface Size {
  width: number;
  halfWidth: number;
  stereoLine?: string;
  stereoFull?: string;
  hintLine?: string;
  ioWidth?: number;
  nameLine?: string;
  classLine?: string;
}

function measureParticipants(d: SequenceDiagram, measure: MeasureText, o: SequenceLayoutOptions) {
  const sizes = new Map<string, Size>();
  let maxBlock = 0;
  for (const p of d.participants) {
    // «module» goes to the tooltip: a function's label (`productList`, no `:`) says it already, and on a React
    // flow it would be a line on every box
    const stereotypes = shownStereotypes(p.stereotypes, p.className, { portLine: !!p.implementsInterface }).filter((s) => s !== 'module');
    const stereoFull = stereotypeText(stereotypes);
    // FR-5.6 a lifeline for mutually exclusive creations says how many it stands for
    const hintFull = p.implementsInterface ? `«${p.implementsInterface.name}»` : p.alternatives ? `one of ${p.alternatives}` : p.instances ? `×${p.instances}` : undefined;
    // Compact boxes: the name decides the width; stereotype/hint lines may widen a short name
    // up to 60px of text, never beyond the name otherwise, and are truncated (tooltip).
    // A long `name:Class` label: the name above `:Class`, the box as wide as the longer of the two
    const colon = p.label.indexOf(':');
    const fullW = measure(p.label, 'participant');
    const split = colon > 0 && fullW > o.splitLabelAt ? { nameLine: p.label.slice(0, colon), classLine: p.label.slice(colon) } : undefined;
    const nameW = split ? Math.max(measure(split.nameLine, 'participant'), measure(split.classLine, 'participant')) : fullW;
    const extraCap = Math.min(o.stereoMaxWidth, Math.max(nameW, 60));
    const textW = Math.max(
      nameW,
      hintFull ? Math.min(measure(hintFull, 'stereotype'), extraCap) : 0,
      stereoFull ? Math.min(measure(stereoFull, 'stereotype'), extraCap) : 0,
    );
    // FR-17.2 the I/O pill sits on the bottom edge (4px in from the left): the box is at least that wide
    const ioWidth = p.sideEffects ? Math.ceil(measure(sideEffectText(p.sideEffects), 'tag')) : undefined;
    const width = Math.max(o.minBoxWidth, Math.ceil(textW + 2 * o.boxPadX), ioWidth ? ioWidth + 2 * IO_PILL_PAD + 8 : 0);
    const stereoLine = fitStereotypes(stereotypes, width - 2 * o.boxPadX, measure);
    const hintLine = hintFull ? fitText(hintFull, width - 2 * o.boxPadX, 'stereotype', measure) : undefined;
    sizes.set(p.id, { width, halfWidth: width / 2, stereoLine, stereoFull, hintLine, ioWidth, ...split });
    maxBlock = Math.max(maxBlock, ((stereoLine ? 1 : 0) + (hintLine ? 1 : 0)) * o.stereoLineH + (split ? o.labelLineH : 0));
  }
  const boxHeight = 2 * o.boxPadY + maxBlock + o.labelLineH;
  return { sizes, boxHeight };
}

/** FR-16.3 pill padding and the longest tag text (the full entry point is in the hover card). */
export const ENTRY_PAD = 5;
/** FR-28 padding of the `+n` pill (the calls a zoomed call folds). */
export const FOLDED_PAD = 4;
const ENTRY_MAX = 40;
const ENTRY_KIND: Record<EntryPoint['kind'], string> = { http: '', route: 'ROUTE ', ui: 'UI ', cli: 'CLI ', job: 'JOB ', handler: 'HANDLER ', test: 'TEST ' };

/** `POST /api/orders`, `CLI orders:expire`, `TEST OrderTest.it_works` (shortened). */
export function entryTagText(e: EntryPoint): string {
  const text = `${ENTRY_KIND[e.kind]}${e.kind === 'http' ? displayRoute(e.label) : e.label}`; // as in the lists
  return text.length > ENTRY_MAX ? `${text.slice(0, ENTRY_MAX - 1)}…` : text;
}

export function polymorphicBadge(m: Message): string | undefined {
  const p = m.polymorphic;
  if (!p) return undefined;
  if (p.selectedKey) {
    const sel = p.implementations.find((i) => i.key === p.selectedKey);
    return `${sel?.name ?? 'impl'} ▾`;
  }
  return `choose impl (${p.implementations.length}) ▾`;
}

export function measureLabel(m: Message, d: SequenceDiagram, measure: MeasureText, o: SequenceLayoutOptions): LabelGeom {
  const label = formatMessageLabel(m, d.options);
  const segments: LabelSegment[] = [];
  let x = 0;
  const push = (kind: LabelSegmentKind, text: string, style: TextStyle, width = measure(text, style), gap = o.segGap) => {
    if (segments.length) x += gap;
    segments.push({ kind, text, dx: x, width, style });
    x += width;
  };
  // FR-16.3: the entry point the root method is, as a tag at the gate (before the method name)
  const entry = m.id === 'root' ? d.entryPoints?.[0] : undefined; // not the container's step (FR-8.7)
  if (entry) {
    const text = entryTagText(entry);
    push('entry', text, 'marker', measure(text, 'marker') + 2 * ENTRY_PAD);
    segments[segments.length - 1].entryKind = entry.kind;
  } else if (m.id === 'container') {
    // the container's step would read as a second entry point: it says it is the setup before it
    push('entry', 'DI SETUP', 'marker', measure('DI SETUP', 'marker') + 2 * ENTRY_PAD);
    segments[segments.length - 1].entryKind = 'setup';
  }
  if (label.result) push('result', label.result, 'args');
  if (label.prefix) push('prefix', label.prefix, 'marker');
  // FR-5.11 ↑ the object runs a method its base class declares (hover card: which one)
  if (m.inheritedFrom) push('inherited', '↑', 'method', 8);
  push('name', label.name, 'method', undefined, m.inheritedFrom ? 1 : o.segGap);
  push('args', label.args, 'args', undefined, 1);
  // FR-28 zoomed to layers: the calls inside the layer this call folds away
  if (m.folded) {
    const text = `+${m.folded.count}`;
    push('folded', text, 'marker', measure(text, 'marker') + 2 * FOLDED_PAD);
  }
  if (m.recursive) push('recursive', '↻', 'marker', measure('↻', 'marker') + 2);
  // the design issues whose evidence starts at this call: one glyph each (hover = title, click = card)
  for (const f of designIssues(d.findings)) {
    if (f.messageIds?.[0] !== m.id) continue;
    push('finding', FINDING_ICON[f.kind], 'marker', measure(FINDING_ICON[f.kind], 'marker') + 2);
    segments[segments.length - 1].finding = f;
  }
  if (m.sideEffects) {
    const io = sideEffectText(m.sideEffects);
    push('io', io, 'tag', measure(io, 'tag') + 2 * IO_PILL_PAD);
  }
  // FR-32.2 what the entry point's whole flow touches, on its arrow (the hover card: classes, calls, why "at least")
  if (entry && d.outcome) {
    push('outcome', outcomeText(d.outcome), 'args');
    if (d.outcome.atLeast) segments[segments.length - 1].atLeast = true;
  }
  const badge = polymorphicBadge(m);
  if (badge) push('poly', badge, 'marker', measure(badge, 'marker') + 12);
  // the root (found) message is always expanded: no ⊖, it cannot collapse
  if ((m.expandable || m.expanded) && m.id !== 'root') push('glyph', m.expanded ? '⊖' : '⊕', 'marker', o.glyphW - o.segGap);
  return { label, segments, width: Math.ceil(x) };
}

/** FR-10.6 the shortest form of a creation's label: `«create»` and the expand glyph (the box names the class). */
function minCreateLabelWidth(l: LabelGeom, o: SequenceLayoutOptions): number {
  // never empty: a creation's label always has the `«create»` prefix (formatMessageLabel)
  const keep = l.segments.filter((s) => s.kind === 'prefix' || s.kind === 'glyph');
  return Math.ceil(keep.reduce((w, s) => w + s.width, 0) + (keep.length - 1) * o.segGap);
}

/**
 * FR-10.6 a creation's label shortened to `max` (it must end before the box it creates), step by step:
 * without the result (`$model =`), arguments as `(…)`, without badges, the class name cut with `…`.
 * `«create»` and the ⊕ glyph always stay; the hover card has the full text.
 */
export function fitCreateLabel(l: LabelGeom, max: number, measure: MeasureText, o: SequenceLayoutOptions): LabelGeom {
  if (l.width <= max) return l;
  let segs = l.segments.map((s) => ({ ...s }));
  const width = () => segs.reduce((w, s, i) => w + s.width + (i ? (s.kind === 'args' ? 1 : o.segGap) : 0), 0);
  const steps: (() => void)[] = [
    () => (segs = segs.filter((s) => s.kind !== 'result')),
    () => {
      const a = segs.find((s) => s.kind === 'args');
      if (a && a.text.length > 2) Object.assign(a, { text: '(…)', width: measure('(…)', a.style) });
    },
    () => (segs = segs.filter((s) => s.kind !== 'io' && s.kind !== 'poly' && s.kind !== 'recursive')),
    () => (segs = segs.filter((s) => s.kind !== 'args')),
    () => {
      // measureLabel always adds the name and no earlier step removes it
      const n = segs.find((s) => s.kind === 'name')!;
      const room = max - (width() - n.width);
      // a stub such as `St…` says nothing the box does not: the name goes unless ~5 characters fit
      const text = room >= measure('Xxxxx…', n.style) ? fitText(n.text, room, n.style, measure) : '';
      if (text) Object.assign(n, { text, width: measure(text, n.style) });
      else segs = segs.filter((s) => s !== n);
    },
  ];
  for (const step of steps) {
    if (width() <= max) break;
    step();
  }
  let x = 0;
  segs.forEach((s, i) => {
    if (i) x += s.kind === 'args' ? 1 : o.segGap;
    s.dx = x;
    x += s.width;
  });
  return { ...l, segments: segs, width: Math.ceil(x) };
}

function isSelf(m: Message): boolean {
  return m.kind === 'self' || (m.from !== null && m.from === m.to);
}

// ───────────────────────────── horizontal placement ─────────────────────────────

interface Constraint {
  /** Index (in placement order) of the left participant. */
  left: number;
  dist: number;
}

function computePositions(
  d: SequenceDiagram,
  order: Participant[],
  sizes: Map<string, Size>,
  labels: Map<string, LabelGeom>,
  measure: MeasureText,
  o: SequenceLayoutOptions,
  gap: number,
  groupGap: number,
  manual: ParticipantPositions,
): Map<string, number> {
  const idx = new Map(order.map((p, i) => [p.id, i]));
  const createsHead = new Set(d.participants.map((p) => p.createdByMessageId).filter(Boolean));
  const need = new Map<number, Constraint[]>();
  const add = (right: number, left: number, dist: number) => {
    const list = need.get(right) ?? [];
    list.push({ left, dist });
    need.set(right, list);
  };
  let firstMin = 0;
  for (const m of d.messages) {
    const lw = labels.get(m.id)!.width; // labels has every message of d
    if (m.kind === 'found' || m.from === null) {
      firstMin = Math.max(firstMin, o.gateX + 8 + Math.min(lw, o.foundLabelMax) + o.labelPad + o.actW);
      continue;
    }
    const a = idx.get(m.from);
    const b = idx.get(m.to);
    /* v8 ignore next -- the core lists every participant a message names */
    if (a === undefined || b === undefined) continue;
    if (isSelf(m)) {
      // Compactness: self-message labels (opaque backdrop) may cross the next lifeline; only
      // the loop itself must fit. Otherwise long self-call stacks spread participants apart.
      if (a + 1 < order.length) add(a + 1, a, 2 * o.actW + o.selfLoopW + o.labelPad);
      continue;
    }
    const left = Math.min(a, b);
    const right = Math.max(a, b);
    const head = m.kind === 'create' && createsHead.has(m.id);
    const headHalf = head ? sizes.get(m.to)!.halfWidth : 0;
    // A label may cross lifelines (opaque backdrop), but never run into the box it creates (FR-5.1):
    // a creation keeps room for its shortest form only (`«create» ⊕`) and is shortened to its span (FR-10.6).
    const push = head ? Math.min(lw, minCreateLabelWidth(labels.get(m.id)!, o)) : Math.min(lw, o.labelPushMax);
    add(right, left, push + 2 * o.labelPad + 2 * o.actW + headHalf);
  }

  const xs = new Map<string, number>();
  order.forEach((p, k) => {
    const s = sizes.get(p.id)!;
    const newGroup = k === 0 || order[k - 1].groupId !== p.groupId;
    let x: number;
    const m = manual[p.id];
    if (m !== undefined && Number.isFinite(m)) {
      x = Math.max(m, o.marginX + s.halfWidth);
    } else if (k === 0) {
      x = Math.max(o.marginX + o.bandPad + s.halfWidth, firstMin);
    } else {
      const prev = order[k - 1];
      x = xs.get(prev.id)! + sizes.get(prev.id)!.halfWidth + gap + s.halfWidth;
      // Bands never widen the layout for their label: it is truncated to the band (tooltip).
      if (newGroup) x += groupGap + 2 * o.bandPad;
      for (const c of need.get(k) ?? []) x = Math.max(x, xs.get(order[c.left].id)! + c.dist);
    }
    xs.set(p.id, x);
  });
  return xs;
}

// ───────────────────────────── main ─────────────────────────────

/** Label x for an arrow x1 (sender) → x2: centred, or next to the sender on very long spans. */
function placeLabel(x1: number, x2: number, width: number, o: SequenceLayoutOptions): number {
  const free = Math.abs(x2 - x1) - width;
  // Labels wider than their span start at the sender and run past the target lifeline
  // (never over the sender's activation); very long spans keep the label near its sender.
  if (free < 2 * o.labelPad || free > o.senderSideFree) return x2 >= x1 ? x1 + o.labelPad : x1 - o.labelPad - width;
  return (x1 + x2) / 2 - width / 2;
}

export function layoutSequence(
  diagram: SequenceDiagram,
  options: Partial<SequenceLayoutOptions> = {},
  manualPositions: ParticipantPositions = {},
  measure: MeasureText = estimateTextWidth,
): SequenceGeometry {
  const o: SequenceLayoutOptions = { ...DEFAULT_LAYOUT, ...options };
  const { sizes, boxHeight } = measureParticipants(diagram, measure, o);
  const labels = new Map(diagram.messages.map((m) => [m.id, measureLabel(m, diagram, measure, o)]));
  const xs = computePositions(diagram, diagram.participants, sizes, labels, measure, o, o.participantGap, o.groupGap, manualPositions);
  // `?? 0` for a message to a participant the host did not list (the core always lists them)
  /* v8 ignore next */
  const X = (id: string) => xs.get(id) ?? 0;
  /* v8 ignore next */
  const half = (id: string) => sizes.get(id)?.halfWidth ?? 0;

  // Header
  const hasGroups = diagram.groups.length > 0;
  const headerBoxTop = o.headerTop + (hasGroups ? o.groupBandH : 0);
  const headerHeight = headerBoxTop + boxHeight + o.headerBottom;

  // Rows
  const visibleIds = new Set(diagram.messages.map((m) => m.id));
  const createdBy = new Map<string, string>(); // messageId → participantId
  for (const p of diagram.participants) {
    if (p.createdByMessageId && visibleIds.has(p.createdByMessageId)) createdBy.set(p.createdByMessageId, p.id);
  }
  const createdHead = new Map<string, number>(); // participantId → head top (body)

  interface Open {
    msg: Message;
    participant: string;
    level: number;
    y1: number;
  }
  const stack: Open[] = [];
  const activations: ActivationGeom[] = [];
  const messages: MessageGeom[] = [];
  let lastBottom = o.bodyTop - o.rowGap;
  const rows = bodyRows(diagram);
  const frags = planFragments(diagram, rows);
  /** Vertical extent of each fragment and the top of each operand (filled during the row pass). */
  const fragY = new Map<string, { y1: number; y2: number; ops: number[] }>();
  /** Fragments of `ownerId` that end before message index `i`: innermost first, each adds bottom padding. */
  const closeFragments = (i: number, ownerId: string | null) => {
    for (const f of frags.closing.get(i) ?? []) {
      if (f.fragment.ownerMessageId !== ownerId) continue;
      // FR-1.17 catch clauses without visible calls: one guard row each at the bottom of the try
      for (const _ of f.fragment.catches ?? []) {
        const top = lastBottom + 4;
        fragY.get(f.fragment.id)!.ops.push(top);
        lastBottom = top + o.fragSepH;
      }
      fragY.get(f.fragment.id)!.y2 = lastBottom + o.fragPadBottom;
      lastBottom += o.fragPadBottom;
    }
  };

  const barLeft = (pid: string, level: number) => X(pid) - o.actW / 2 + (level * o.actW) / 2;
  const barRight = (pid: string, level: number) => barLeft(pid, level) + o.actW;

  const closeTop = () => {
    const e = stack.pop()!;
    const y2 = Math.max(e.y1 + o.minActH, lastBottom + o.actTail);
    activations.push({ participantId: e.participant, messageId: e.msg.id, level: e.level, x: barLeft(e.participant, e.level), y1: e.y1, y2 });
    lastBottom = y2;
  };

  /** Row index → geometry of the message drawn in that row (stubs have none). */
  const rowMessages: (MessageGeom | undefined)[] = [];
  /** Row index → horizontal extent of an exit marker (fragments enclose it). */
  const rowExits: ({ x1: number; x2: number } | undefined)[] = [];
  const exits: ExitGeom[] = [];
  rows.forEach((row, index) => {
    while (stack.length && stack[stack.length - 1].msg.id !== row.parentId) {
      closeFragments(index, stack[stack.length - 1].msg.id);
      closeTop();
    }
    closeFragments(index, row.parentId);
    // fragments and operands starting here, outer first: a tag row / a dashed separator row each
    for (const ev of frags.opening.get(index) ?? []) {
      const top = lastBottom + (ev.operand === 0 ? o.rowGap - 2 : 4);
      if (ev.operand === 0) fragY.set(ev.f.fragment.id, { y1: top, y2: top, ops: [top] });
      else fragY.get(ev.f.fragment.id)!.ops.push(top);
      // the next label has its own headroom: overlap it a little with the tag / guard row
      lastBottom = top + (ev.operand === 0 ? o.fragHeaderH : o.fragSepH) - 4;
    }
    if (row.exit) {
      // FR-1.15: a half-height row on the owner's activation bar
      const owner = stack[stack.length - 1];
      /* v8 ignore next -- an exit's owner is a drawn message (the core sends exits of expanded calls only) */
      const x = owner ? barRight(owner.participant, owner.level) + 4 : o.gateX;
      const text = exitText(row.exit, o.fragGuardMax);
      const width = measure(text, 'marker');
      const top = lastBottom + 2;
      const ep = row.exit.errorPath;
      const fold = ep ? { text: foldText(ep), x: x + width + 6, width: Math.ceil(measure(foldText(ep), 'marker')), errorPath: ep } : undefined;
      exits.push({ exit: row.exit, x, y: top + o.exitH - 4, text, width, ...(fold ? { fold } : {}) });
      rowExits[index] = { x1: x - 2, x2: (fold ? fold.x + fold.width : x + width) + 2 };
      lastBottom = top + o.exitH;
      return;
    }
    if (row.stub) {
      // FR-1.12: a minimized fragment takes one short row in its owner's activation
      const top = lastBottom + o.rowGap - 2;
      fragY.set(row.id, { y1: top, y2: top + o.fragStubH, ops: [top] });
      lastBottom = top + o.fragStubH;
      return;
    }
    const m = row.message!;
    let label = labels.get(m.id)!;
    const level = stack.filter((e) => e.participant === m.to).length;
    let senderLevel = -1;
    if (m.from !== null) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].participant === m.from) {
          senderLevel = stack[i].level;
          break;
        }
      }
    }
    // not for the found message (no sender): its branch below starts at the gate
    const senderEdge = (from: string, right: boolean) => {
      if (senderLevel < 0) return X(from);
      return right ? barRight(from, senderLevel) : barLeft(from, senderLevel);
    };

    let y = lastBottom + o.rowGap + o.labelSpace;
    let x1: number;
    let x2: number;
    let actY1 = y;
    let loopX: number | undefined;
    let y2: number | undefined;
    let labelX: number;

    if (m.kind === 'found' || m.from === null) {
      x1 = o.gateX;
      x2 = barLeft(m.to, level);
      labelX = o.gateX + 8;
      lastBottom = y;
    } else if (isSelf(m)) {
      x1 = senderEdge(m.from, true);
      loopX = x1 + o.selfLoopW;
      y2 = y + o.selfLoopH;
      x2 = barRight(m.to, level);
      actY1 = y2;
      labelX = x1 + 6;
      lastBottom = y2;
    } else if (createdBy.get(m.id) === m.to) {
      const right = X(m.to) >= X(m.from);
      y = Math.max(y, lastBottom + o.rowGap + boxHeight / 2);
      x1 = senderEdge(m.from, right);
      x2 = right ? X(m.to) - half(m.to) : X(m.to) + half(m.to);
      createdHead.set(m.to, y - boxHeight / 2);
      actY1 = y + boxHeight / 2;
      label = fitCreateLabel(label, Math.abs(x2 - x1) - 2 * o.labelPad, measure, o);
      labelX = placeLabel(x1, x2, label.width, o);
      lastBottom = actY1;
    } else {
      const right = X(m.to) >= X(m.from);
      x1 = senderEdge(m.from, right);
      x2 = right ? barLeft(m.to, level) : barRight(m.to, level);
      labelX = placeLabel(x1, x2, label.width, o);
      lastBottom = y;
    }
    const labelY = y - 5;
    const bx1 = Math.min(x1, x2, labelX);
    const bx2 = Math.max(x1, x2, loopX ?? -Infinity, labelX + label.width);
    const by1 = labelY - o.labelSpace + 2;
    const by2 = (y2 ?? y) + 5;
    rowMessages[index] = {
      id: m.id,
      message: m,
      kind: m.kind,
      x1,
      x2,
      y,
      loopX,
      y2,
      labelX,
      labelY,
      label,
      box: { x: bx1 - 4, y: by1, width: bx2 - bx1 + 8, height: by2 - by1 },
    };
    messages.push(rowMessages[index]!);
    stack.push({ msg: m, participant: m.to, level, y1: actY1 });
  });
  const end = rows.length;
  while (stack.length) {
    closeFragments(end, stack[stack.length - 1].msg.id);
    closeTop();
  }
  const bodyHeight = Math.max(lastBottom, 0) + o.bodyBottom;
  const fragments = placeFragments(frags.list, fragY, rowMessages, rowExits, activations, X, half, measure, o);

  const participants: ParticipantGeom[] = diagram.participants.map((p) => {
    const s = sizes.get(p.id)!;
    const head = createdHead.get(p.id);
    return {
      id: p.id,
      participant: p,
      x: X(p.id),
      width: s.width,
      halfWidth: s.halfWidth,
      stereoLine: s.stereoLine,
      stereoFull: s.stereoFull,
      hintLine: s.hintLine,
      ...(s.nameLine !== undefined ? { nameLine: s.nameLine, classLine: s.classLine } : {}),
      ...(s.ioWidth !== undefined ? { ioWidth: s.ioWidth } : {}),
      ...(classMarks(diagram.findings, p.classKey).length ? { marks: classMarks(diagram.findings, p.classKey) } : {}),
      headerY: headerBoxTop,
      boxHeight,
      faded: head !== undefined,
      createdHeadY: head,
      lifelineTop: head !== undefined ? head + boxHeight : 0,
      lifelineBottom: bodyHeight,
    };
  });

  const groups: GroupGeom[] = [];
  for (const g of diagram.groups) {
    const members = participants.filter((p) => p.participant.groupId === g.id);
    if (!members.length) continue;
    const x1 = Math.min(...members.map((p) => p.x - p.halfWidth)) - o.bandPad;
    const x2 = Math.max(...members.map((p) => p.x + p.halfWidth)) + o.bandPad;
    const title = g.layer ? `${g.layer} · ${g.namespace || '(root)'}` : g.namespace || '(root)';
    groups.push({ id: g.id, label: g.label, title, layer: g.layer, displayLabel: g.label, ...(g.fold ? { fold: g.fold } : {}), x1, x2, y: o.headerTop - 4, height: headerHeight - o.headerTop });
  }
  // Widen bands so their label fits, as far as the next band allows; truncate otherwise.
  const sortedBands = [...groups].sort((a, b) => a.x1 - b.x1);
  sortedBands.forEach((g, i) => {
    const next = sortedBands[i + 1];
    // "Domain · Domain" says the layer once; a title that does not fit keeps the folder (the band's colour
    // and tooltip name the layer) before it is cut — "Presentation · Controll…" would lose the part that tells bands apart —
    // but only when another band of the layer is drawn: alone, the folder tells nothing ("src") and the layer is kept
    const folder = g.layer && g.label.startsWith(`${g.layer} · `) ? g.label.slice(g.layer.length + 3) : undefined;
    const label = folder && folder.toLowerCase() === g.layer!.toLowerCase() ? g.layer! : g.label;
    // a band with a ⊖ (fold its layer) at its right end: the title ends before it
    const glyph = g.fold || participants.some((p) => p.participant.groupId === g.id && p.participant.inLayer) ? 18 : 0;
    const wanted = g.x1 + measure(label, 'group') + 20 + glyph;
    if (wanted > g.x2) g.x2 = Math.max(g.x2, next ? Math.min(wanted, next.x1 - 6) : wanted);
    const room = g.x2 - g.x1 - 16 - glyph;
    const short = folder && label !== g.layer && measure(label, 'group') > room;
    const siblings = short && groups.some((o) => o !== g && o.layer === g.layer);
    g.displayLabel = short ? fitText(siblings ? folder : g.layer!, room, 'group', measure) : fitText(label, room, 'group', measure);
  });

  const right = Math.max(
    0,
    ...participants.map((p) => p.x + p.halfWidth),
    ...groups.map((g) => g.x2),
    ...messages.map((m) => m.box.x + m.box.width),
    ...fragments.map((f) => f.x2),
    ...exits.map((e) => e.x + e.width),
  );
  return {
    width: Math.ceil(right + o.marginX),
    headerHeight,
    bodyHeight,
    gateX: o.gateX,
    participants,
    groups,
    activations,
    messages,
    fragments,
    exits,
    options: o,
  };
}

// ───────────────────────────── combined fragments (FR-1.10) ─────────────────────────────

interface PlannedFragment {
  fragment: Fragment;
  /** Message index range [start, end): first operand's first message to the end of the last operand's last subtree. */
  start: number;
  end: number;
  /** Start index per operand. */
  operandStarts: number[];
  /** Nesting depth among the fragments of the same owner. */
  level: number;
}

/** A body row: a message, the one-row stub of a minimized fragment (FR-1.12) or an exit marker (FR-1.15). */
interface Row {
  id: string;
  parentId: string | null;
  message?: Message;
  stub?: Fragment;
  exit?: ExitMarker;
}

/** Messages in pre-order with the stubs of collapsed fragments and the exit markers inserted where they belong. */
function bodyRows(d: SequenceDiagram): Row[] {
  const rows: Row[] = [];
  // several can wait before one call / at one owner's end (FR-28.4: zoomed, two guards' exits before the same drawn call)
  const before = new Map<string, (Row & { beforeId?: string })[]>();
  const atEnd = new Map<string, Row[]>();
  const pseudo: (Row & { beforeId?: string })[] = [
    ...(d.fragments ?? []).filter((f) => f.collapsed).map((f) => ({ id: f.id, parentId: f.ownerMessageId, stub: f, beforeId: f.beforeId })),
    ...(d.exits ?? []).map((e) => ({ id: e.id, parentId: e.ownerMessageId, exit: e, beforeId: e.beforeId })),
  ];
  for (const r of pseudo) {
    if (r.beforeId) before.set(r.beforeId, [...(before.get(r.beforeId) ?? []), r]);
    else atEnd.set(r.parentId!, [...(atEnd.get(r.parentId!) ?? []), r]);
  }
  const push = (r: Row & { beforeId?: string }): void => {
    const { beforeId: _b, ...row } = r;
    rows.push(row);
  };
  const emitBefore = (id: string): void => {
    for (const r of before.get(id) ?? []) {
      emitBefore(r.id);
      push(r);
    }
  };
  const closeOwner = (ownerId: string): void => {
    for (const r of atEnd.get(ownerId) ?? []) {
      emitBefore(r.id);
      push(r);
    }
  };
  const open: string[] = [];
  for (const m of d.messages) {
    while (open.length && open[open.length - 1] !== m.parentId) closeOwner(open.pop()!);
    emitBefore(m.id);
    rows.push({ id: m.id, parentId: m.parentId, message: m });
    open.push(m.id);
  }
  while (open.length) closeOwner(open.pop()!);
  return rows;
}

/** Row index ranges of the fragments and the row events they cause. */
function planFragments(d: SequenceDiagram, rows: Row[]) {
  const list: PlannedFragment[] = [];
  const opening = new Map<number, { f: PlannedFragment; operand: number }[]>();
  const closing = new Map<number, PlannedFragment[]>();
  const fragments = d.fragments ?? [];
  if (!fragments.length) return { list, opening, closing };
  const index = new Map(rows.map((r, i) => [r.id, i]));
  // end of each row's subtree (pre-order list)
  const subtreeEnd = new Array<number>(rows.length).fill(rows.length);
  const open: number[] = [];
  rows.forEach((r, i) => {
    while (open.length && rows[open[open.length - 1]].id !== r.parentId) subtreeEnd[open.pop()!] = i;
    open.push(i);
  });
  const byId = new Map(fragments.map((f) => [f.id, f]));
  const level = (f: Fragment): number => (f.parentId && byId.has(f.parentId) ? 1 + level(byId.get(f.parentId)!) : 0);
  for (const fragment of fragments) {
    const starts = fragment.operands.map((op) => index.get(op.firstMessageId));
    const lastIdx = index.get(fragment.operands[fragment.operands.length - 1]?.lastMessageId ?? '');
    if (!fragment.operands.length || starts.some((s) => s === undefined) || lastIdx === undefined) continue;
    const owner = index.get(fragment.ownerMessageId);
    /* v8 ignore next -- the operands' calls are the owner's children: drawn only when the owner is */
    if (owner === undefined) continue;
    const pf: PlannedFragment = { fragment, start: starts[0]!, end: subtreeEnd[lastIdx], operandStarts: starts as number[], level: level(fragment) };
    list.push(pf);
    if (fragment.collapsed) continue; // its stub row is laid out in the row pass
    pf.operandStarts.forEach((s, k) => opening.set(s, [...(opening.get(s) ?? []), { f: pf, operand: k }]));
    closing.set(pf.end, [...(closing.get(pf.end) ?? []), pf]);
  }
  for (const evs of opening.values()) evs.sort((a, b) => a.f.level - b.f.level);
  for (const fs of closing.values()) fs.sort((a, b) => b.level - a.level);
  return { list, opening, closing };
}

/** Horizontal extent: the owner's lifeline and everything drawn for the enclosed messages; nested frames inset. */
function placeFragments(
  list: PlannedFragment[],
  fragY: Map<string, { y1: number; y2: number; ops: number[] }>,
  rowMessages: (MessageGeom | undefined)[],
  rowExits: ({ x1: number; x2: number } | undefined)[],
  activations: ActivationGeom[],
  X: (id: string) => number,
  half: (id: string) => number,
  measure: MeasureText,
  o: SequenceLayoutOptions,
): FragmentGeom[] {
  const actsByMsg = new Map(activations.map((a) => [a.messageId, a]));
  const done = new Map<string, FragmentGeom>();
  const plannedById = new Map(list.map((p) => [p.fragment.id, p]));
  // innermost first: smaller ranges, then deeper nesting
  const order = [...list].sort((a, b) => a.end - a.start - (b.end - b.start) || b.level - a.level);
  for (const pf of order) {
    const ys = fragY.get(pf.fragment.id);
    // a minimized fragment's stub row is missing only when the host sends a `beforeId` that is not drawn
    /* v8 ignore next */
    if (!ys) continue;
    // planFragments keeps a fragment only when its owner is a drawn call, and every drawn call has an activation
    const ownerAct = actsByMsg.get(pf.fragment.ownerMessageId)!;
    let x1 = ownerAct.x;
    let x2 = ownerAct.x + o.actW;
    for (let i = pf.start; i < pf.end; i++) {
      const ex = rowExits[i];
      if (ex) {
        x1 = Math.min(x1, ex.x1);
        x2 = Math.max(x2, ex.x2);
      }
      const mg = rowMessages[i];
      if (!mg) continue;
      x1 = Math.min(x1, mg.box.x);
      x2 = Math.max(x2, mg.box.x + mg.box.width);
      const act = actsByMsg.get(mg.id)!; // every drawn call has an activation
      x1 = Math.min(x1, act.x);
      x2 = Math.max(x2, act.x + o.actW);
      if (mg.message.kind === 'create') {
        x1 = Math.min(x1, X(mg.message.to) - half(mg.message.to));
        x2 = Math.max(x2, X(mg.message.to) + half(mg.message.to));
      }
    }
    x1 -= o.fragPadX;
    x2 += o.fragPadX;
    // enclose nested frames (already placed) with a margin
    for (const inner of done.values()) {
      const ip = plannedById.get(inner.id)!;
      if (ip.start >= pf.start && ip.end <= pf.end) {
        x1 = Math.min(x1, inner.x1 - o.fragPadX);
        x2 = Math.max(x2, inner.x2 + o.fragPadX);
      }
    }
    // operand guards start right of the owner's activation bar (which runs through the frame), next to
    // the first call they guard; when that is out of view, the view floats a copy at its edge (FR-1.16)
    const contentLeft = Math.max(x1 + 6, ownerAct.x + o.actW + 4);
    const tagText = pf.fragment.kind;
    const tagWidth = Math.ceil(measure(tagText, 'marker')) + 12;
    // FR-1.17 catch clauses without visible calls follow the operands as guard-only rows
    const rows: (Fragment['operands'][number] & { errorPath?: ErrorPathFold })[] = [
      ...pf.fragment.operands,
      ...(pf.fragment.catches ?? []).map((c) => ({ guard: c.guard, range: c.range, outcome: c.outcome, swallowed: c.swallowed, errorPath: c.errorPath, firstMessageId: '', lastMessageId: '' })),
    ];
    const operands: FragmentOperandGeom[] = rows.map((op, k) => {
      // `?? ys.y1`: a minimized fragment has one top; the core minimizes to the first operand only, no catches
      /* v8 ignore next */
      const y = ys.ops[k] ?? ys.y1;
      const full = op.guard;
      const guard = full === undefined ? undefined : `[${abbreviateArgument(full, o.fragGuardMax)}]`;
      const guardX = k === 0 ? Math.max(x1 + tagWidth + 5, contentLeft) : contentLeft;
      // the frame's kind goes before a guard whose corner tag is not right beside it (a wide frame, an
      // operand further down) — the tag is then often out of sight (FR-1.10)
      const besideTag = k === 0 && guardX - (x1 + tagWidth) < 24;
      const kindWidth = guard && !besideTag ? Math.ceil(measure(tagText, 'marker')) + 5 : 0;
      const guardWidth = guard ? kindWidth + Math.ceil(measure(guard, 'args')) : 0;
      const geom: FragmentOperandGeom = { y, guard, guardFull: full, kindWidth, guardX, guardY: y + 10, guardWidth, range: op.range };
      if (op.outcome) Object.assign(geom, { outcome: op.outcome, outcomeX: guardX + guardWidth + 6, ...(op.swallowed ? { swallowed: true } : {}) });
      if (op.errorPath) {
        const text = foldText(op.errorPath);
        const x = op.outcome ? geom.outcomeX! + Math.ceil(measure(op.outcome, 'marker')) + 6 : guardX + guardWidth + 6;
        geom.fold = { text, x, width: Math.ceil(measure(text, 'marker')), errorPath: op.errorPath };
      }
      return geom;
    });
    // FR-1.12: minimize / restore glyph after the first guard, then (collapsed) the folded count
    const first = operands[0];
    let after = first?.guard ? first.guardX + first.guardWidth : x1 + tagWidth;
    let summary: FragmentGeom['summary'];
    if (pf.fragment.collapsed) {
      /* v8 ignore next -- the core always sets hiddenCount on a minimized fragment */
      const n = pf.fragment.hiddenCount ?? 0;
      const text = `⋯ ${n} call${n === 1 ? '' : 's'}`;
      summary = { text, x: after + 6, y: ys.y1 + 10, action: 'expand' };
      after = summary.x + Math.ceil(measure(text, 'args'));
    } else if (pf.fragment.followed) {
      // FR-1.22 the frame says other cases exist; a click shows them
      const n = pf.fragment.followed.otherCases;
      const text = n ? `📌 ${n} other case${n === 1 ? '' : 's'}` : '📌 followed';
      summary = { text, x: after + 6, y: ys.y1 + 10, action: 'all-cases' };
      after = summary.x + Math.ceil(measure(text, 'args'));
    }
    const toggleX = after + 11;
    const toggleY = ys.y1 + o.fragHeaderH / 2;
    // the tag, the guards and the glyph stay inside the frame
    for (const op of operands) {
      x2 = Math.max(x2, op.fold ? op.fold.x + op.fold.width + 6 : op.outcome ? op.outcomeX! + Math.ceil(measure(op.outcome, 'marker')) + 6 : op.guardX + op.guardWidth + 6);
    }
    x2 = Math.max(x2, toggleX + 10);
    const geom: FragmentGeom = { id: pf.fragment.id, fragment: pf.fragment, x1, x2, y1: ys.y1, y2: ys.y2, tagWidth, tagHeight: o.fragHeaderH, operands, toggleX, toggleY, ...(summary ? { summary } : {}) };
    done.set(geom.id, geom);
  }
  return list.map((pf) => done.get(pf.fragment.id)).filter((g): g is FragmentGeom => !!g);
}

/**
 * Tidy up (FR-10.2): compact x positions with a small gap, wide enough that labels of
 * messages between neighbours fit. Preserves the current visual order (by x, falling back
 * to diagram order).
 */
export function tidyPositions(
  diagram: SequenceDiagram,
  measure: MeasureText = estimateTextWidth,
  currentPositions: ParticipantPositions = {},
  options: Partial<SequenceLayoutOptions> = {},
): ParticipantPositions {
  const o: SequenceLayoutOptions = { ...DEFAULT_LAYOUT, ...options };
  const { sizes } = measureParticipants(diagram, measure, o);
  const labels = new Map(diagram.messages.map((m) => [m.id, measureLabel(m, diagram, measure, o)]));
  // one sort key per participant: its x; one without a position (new after an expand) right after the
  // participant before it in diagram order — a mixed "by x, else by index" comparison is not a consistent order
  const key = new Map<string, number>();
  let prev = -Infinity;
  diagram.participants.forEach((p, i) => {
    const x = currentPositions[p.id];
    prev = x !== undefined ? x : prev + 1e-3;
    key.set(p.id, prev + i * 1e-9);
  });
  const byX = [...diagram.participants].sort((a, b) => key.get(a.id)! - key.get(b.id)!);
  // a band (layer · folder) is drawn over its members: keep them together, bands in the order they first appear
  const bandOrder = new Map<string, number>();
  for (const p of byX) if (!bandOrder.has(p.groupId)) bandOrder.set(p.groupId, bandOrder.size);
  const order = byX.map((p, i) => ({ p, i })).sort((a, b) => bandOrder.get(a.p.groupId)! - bandOrder.get(b.p.groupId)! || a.i - b.i).map((x) => x.p);
  const xs = computePositions(diagram, order, sizes, labels, measure, o, o.tidyGap, o.tidyGap / 2, {});
  return Object.fromEntries([...xs].map(([id, x]) => [id, Math.round(x)]));
}

/** Current x of every participant (used to freeze the layout before a drag). */
export function positionsOf(geom: SequenceGeometry): ParticipantPositions {
  return Object.fromEntries(geom.participants.map((p) => [p.id, Math.round(p.x)]));
}
