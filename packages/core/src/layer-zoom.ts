/**
 * FR-28 layer zoom: the flow one level up — one lifeline per layer, only the calls that cross a layer, the calls
 * inside a layer folded into the crossing call that led there (`placeOrder (+3)`). A pure projection of a rendered
 * diagram: message ids stay the real call paths, so expanding, navigating, finding, marks and shared state work on
 * the zoomed diagram unchanged. The class diagram gets the same grouping: one package per layer (as the codebase
 * map's folders, FR-26), the relations between layers merged.
 */
import type {
  ClassChange,
  ClassDiagram,
  ClassMember,
  ClassNode,
  ClassRelation,
  ExitMarker,
  Finding,
  Fragment,
  FragmentOperand,
  Message,
  Participant,
  ParticipantGroup,
  RelationCall,
  SequenceDiagram,
  SideEffectKind,
  SideEffects,
  ZoomEnd,
  ZoomedObject,
} from '@seqcall/protocol';
import { possibleOf } from './class-diagram';

const KIND_ORDER: SideEffectKind[] = ['db', 'cache', 'http', 'file', 'queue', 'cloud', 'process'];
/** Names of folded calls listed on a message (the hover card shows them). */
const MAX_FOLDED_NAMES = 12;
/** Relations listed on a merged edge. */
const MAX_LISTED = 40;

/**
 * The lifeline an object goes to: its layer; without one, its band (libraries, unresolved, `No layer · folder`)
 * — what the bands already separate, so nothing that was apart is merged.
 */
export function zoomKey(p: { layer?: string; kind: string; namespace: string }): string {
  if (p.layer) return `layer:${p.layer}`;
  if (p.kind === 'external') return 'layer::libraries';
  if (p.kind === 'unknown') return 'layer::unresolved';
  return `layer::${p.namespace}`;
}

export function zoomLabel(p: { layer?: string; kind: string; namespace: string }): string {
  if (p.layer) return p.layer;
  if (p.kind === 'external') return 'Libraries';
  if (p.kind === 'unknown') return 'Unresolved';
  return `No layer · ${p.namespace.split('/').pop() || p.namespace || '(root)'}`;
}

function unionSideEffects(all: (SideEffects | undefined)[]): SideEffects | undefined {
  const present = all.filter((s): s is SideEffects => !!s);
  if (!present.length) return undefined;
  const kinds = KIND_ORDER.filter((k) => present.some((s) => s.kinds.includes(k)));
  const evidence = [...new Set(present.flatMap((s) => s.evidence))];
  return { kinds, evidence };
}

function mergedChange(all: (ClassChange | undefined)[], n: number): ClassChange | undefined {
  const present = all.filter((c): c is ClassChange => !!c);
  if (!present.length) return undefined;
  return { kind: present.length === n && present.every((c) => c.kind === 'new') ? 'new' : 'changed', members: present.flatMap((c) => c.members) };
}

function mergedDiff(all: (Participant['diff'] | undefined)[]): Participant['diff'] | undefined {
  if (all.length && all.every((d) => d === 'added')) return 'added';
  if (all.length && all.every((d) => d === 'removed')) return 'removed';
  return undefined;
}

export interface LayerZoom {
  diagram: SequenceDiagram;
  /** Per kept message: the ids of the calls folded into it (in order). */
  folded: Map<string, string[]>;
}

/**
 * FR-28 the sequence diagram with one lifeline per layer; `open` (FR-28.7): layers drawn as their objects instead.
 * FR-28.11 `foldOnly` (the object view): only these layers fold, every other layer stays open — its objects as they are
 * (no tag: nothing to put back), in their bands' places.
 */
export function projectLayers(d: SequenceDiagram, open: ReadonlySet<string> = new Set(), openObjects: ReadonlySet<string> = new Set(), foldOnly?: ReadonlySet<string>): LayerZoom {
  const byId = new Map(d.participants.map((p) => [p.id, p]));
  const lifelineOf = new Map<string, string>();
  const layerOpen = (key: string) => (foldOnly ? !foldOnly.has(key) : open.has(key));
  // FR-28.8 an object pulled out of its layer is drawn as itself too
  const isOpen = (p: Participant) => layerOpen(zoomKey(p)) || openObjects.has(p.id);
  for (const p of d.participants) lifelineOf.set(p.id, isOpen(p) ? p.id : zoomKey(p));

  // the objects in band order (DI container, the root's band, then the layers in architectural order), and per lifeline
  const ordered = new Set<Participant>();
  for (const g of d.groups) for (const p of d.participants) if (p.groupId === g.id) ordered.add(p);
  for (const p of d.participants) ordered.add(p);
  const members = new Map<string, Participant[]>();
  for (const p of ordered) {
    const key = zoomKey(p);
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(p);
  }
  const participants: Participant[] = [];
  const groups: ParticipantGroup[] = [];
  const placed = new Set<string>();
  for (const p of ordered) {
    const key = zoomKey(p);
    const label = zoomLabel(p);
    if (layerOpen(key)) {
      // FR-28.7 opened in place: the object as it is, in its own band (where the band stood), with the tag that folds it again
      const g = d.groups.find((x) => x.id === p.groupId);
      if (g && !groups.some((x) => x.id === g.id)) groups.push(g);
      participants.push(foldOnly ? p : { ...p, inLayer: { key, name: label } });
      continue;
    }
    // a folded layer: one lifeline where its first band stood
    if (placed.has(key)) continue;
    placed.add(key);
    const objs = members.get(key)!;
    const first = objs[0];
    // FR-28.8 objects pulled out alone: beside the layer's lifeline, in its band; the lifeline stands for the rest
    const alone = objs.filter((x) => openObjects.has(x.id));
    const rest = objs.filter((x) => !openObjects.has(x.id));
    if (!groups.some((x) => x.id === key)) groups.push({ id: key, label, ...(first.layer ? { layer: first.layer } : {}), namespace: '' });
    if (rest.length) participants.push(layerLifeline(key, label, rest));
    for (const x of alone) participants.push({ ...x, groupId: key, inLayer: { key, name: label, alone: true } });
  }
  function layerLifeline(key: string, label: string, objs: Participant[]): Participant {
    const first = objs[0];
    const n = objs.length;
    const objects: ZoomedObject[] = objs.map((p) => ({ id: p.id, label: p.label, classKey: p.classKey, className: p.className, ...(p.declaration ? { declaration: p.declaration } : {}) }));
    const sideEffects = unionSideEffects(objs.map((p) => p.sideEffects));
    const change = mergedChange(objs.map((p) => p.change), n);
    const diff = mergedDiff(objs.map((p) => p.diff));
    const violations = [...new Set(objs.flatMap((p) => p.layerViolations ?? []))];
    return {
      id: key,
      classKey: key,
      className: label,
      label,
      kind: 'module',
      // the box says how many objects it stands for (the tooltip and the menu name them)
      stereotypes: n > 1 ? [`${n} objects`] : [],
      ...(first.layer ? { layer: first.layer } : {}),
      namespace: '',
      groupId: key,
      objects,
      ...(sideEffects ? { sideEffects } : {}),
      ...(change ? { change } : {}),
      ...(diff ? { diff } : {}),
      ...(violations.length ? { layerViolations: violations } : {}),
    };
  }

  // messages: kept when they cross a lifeline (and the root); the others fold into the nearest kept ancestor
  const index = new Map(d.messages.map((m, i) => [m.id, i]));
  const keptOf = new Map<string, string>(); // every message → the kept message it is (or is folded into)
  const depthOf = new Map<string, number>();
  const folded = new Map<string, string[]>();
  const kept: Message[] = [];
  const keptById = new Map<string, Message>();
  // only folded calls are named: a call that does not cross runs on its sender's lifeline, so its target is drawn
  const nameOf = (m: Message) => `${m.className ?? byId.get(m.to)!.className}.${m.methodName}`;
  for (const m of d.messages) {
    const from = m.from ? lifelineOf.get(m.from) : undefined;
    const to = lifelineOf.get(m.to) ?? m.to;
    // drawn: the root, a call between two lifelines, and every call an opened object makes (object level there)
    const sender = m.from ? byId.get(m.from) : undefined;
    const crosses = m.kind === 'found' || !from || from !== to || (!!sender && isOpen(sender));
    const parentKept = m.parentId ? keptOf.get(m.parentId) : undefined;
    if (!crosses) {
      // parentKept is always set: the root is kept, so every message has a kept ancestor, listed before it
      const host = parentKept!;
      keptOf.set(m.id, host);
      if (!folded.has(host)) folded.set(host, []);
      folded.get(host)!.push(m.id);
      continue;
    }
    keptOf.set(m.id, m.id);
    // a kept message's depth is set when it is kept
    const depth = parentKept ? depthOf.get(parentKept)! + 1 : 0;
    depthOf.set(m.id, depth);
    // FR-28.10 the objects a layer lifeline stands for at either end (the hover card names them)
    const end = (id: string): ZoomEnd => {
      const p = byId.get(id)!;
      return { id, label: p.label, ...(p.layer ? { layer: p.layer } : {}) };
    };
    const objects = { ...(m.from && from !== m.from ? { from: end(m.from) } : {}), ...(to !== m.to ? { to: end(m.to) } : {}) };
    const out: Message = { ...m, parentId: parentKept ?? null, depth, from: from ?? null, to, ...(objects.from || objects.to ? { objects } : {}) };
    kept.push(out);
    keptById.set(m.id, out);
  }
  // what each kept call folds: counts, names, I/O, marks, importance, and whether there is more to open below
  for (const m of kept) {
    const ids = folded.get(m.id);
    if (!ids?.length) continue;
    const inner = ids.map((id) => d.messages[index.get(id)!]);
    const expandable = inner.filter((x) => x.expandable && !x.expanded).length;
    m.folded = { count: inner.length, names: inner.slice(0, MAX_FOLDED_NAMES).map(nameOf), expandable, calls: inner.map((x) => ({ id: x.id, name: nameOf(x), participant: x.to })) };
    const io = unionSideEffects([m.sideEffects, ...inner.map((x) => x.sideEffects)]);
    if (io) m.sideEffects = { ...io, ...(m.sideEffects && !m.sideEffects.below ? {} : { below: true }) };
    // FR-24.9 the review's steps folded in here: a folded call's own change, or a folded collapsed call with changes
    // below (one step, as drawn) — the total stays the object diagram's at every zoom level
    // FR-24.15 during a review the calls carry how many of the flow's changes they stand for: the sum (one total)
    const changed = d.reviewTotal !== undefined ? inner.reduce((n, x) => n + (x.diff?.count ?? 0), 0) : inner.filter((x) => x.diff?.call || x.diff?.method || x.diff?.status || (x.diff?.inside && !x.expanded)).length;
    // FR-24.15 the numbers of the folded calls' changes are held by this call
    const held = [...new Set([...(m.diff?.held ?? []), ...inner.flatMap((x) => [...(x.diff?.positions ?? []).map((p) => p.n), ...(x.diff?.held ?? [])])])].sort((a, b) => a - b);
    if (changed) m.diff = { ...m.diff, folded: changed, ...(d.reviewTotal !== undefined ? { count: m.diff?.count ?? 0 } : {}), ...(held.length ? { held } : {}) };
    const imps = [m.importance, ...inner.map((x) => x.importance)].filter((i): i is NonNullable<Message['importance']> => !!i);
    if (imps.length) {
      const best = imps.reduce((a, b) => (b.score > a.score ? b : a), imps[0]);
      m.importance = { score: best.score, reasons: best.reasons, low: imps.every((i) => i.low) };
    }
    // ⊕ while folded calls are still collapsed: `expand` on this call opens them (the call itself is open)
    if (expandable) {
      m.expandable = true;
      m.expanded = false;
    }
  }

  // fragments: owned by the kept ancestor, spanning the kept calls of each operand (the direct children of that owner)
  const keptParentOf = (id: string) => keptById.get(id)?.parentId;
  const subtreeEnd = (id: string): number => {
    const start = index.get(id)!;
    let end = start;
    while (end + 1 < d.messages.length && d.messages[end + 1].depth > d.messages[start].depth) end++;
    return end;
  };
  const fragmentIds = new Set((d.fragments ?? []).map((f) => f.id));
  const exitById = new Map((d.exits ?? []).map((e) => [e.id, e]));
  const keptFragments = new Set<string>();
  const inRange = (owner: string, from: number, to: number): Message[] => {
    const out: Message[] = [];
    for (let i = from; i <= to; i++) {
      const k = keptById.get(d.messages[i].id);
      if (k && keptParentOf(k.id) === owner) out.push(k);
    }
    return out;
  };
  // the next kept direct child of `owner` at or after a message id (a stub / exit is drawn before it)
  const nextKept = (owner: string, beforeId: string | undefined): string | undefined => {
    if (!beforeId) return undefined;
    if (fragmentIds.has(beforeId)) return keptFragments.has(beforeId) ? beforeId : undefined;
    // an exit of the same drawn activation (`if (b) return; if (c) return;`) is drawn too
    if (exitById.has(beforeId)) return beforeId;
    const at = index.get(beforeId);
    if (at === undefined) return undefined;
    for (let i = at; i < d.messages.length; i++) {
      const k = keptById.get(d.messages[i].id);
      if (k && keptParentOf(k.id) === owner) return k.id;
    }
    return undefined;
  };
  // an operand may start or end at an early exit (`if (…) return …;`): drawn while its method's activation is, and
  // either way the operand stops there — not at the end of the method
  const exitDrawn = (e: ExitMarker) => keptById.has(e.ownerMessageId);
  // the index of the first message after the exit (where it is drawn), through the exits and minimized frames drawn
  // before that message (`if (b) return; if (c) return; save()`); else past its method's last message (an operand's
  // exit belongs to the frame's method, a message of the diagram)
  const collapsedById = new Map((d.fragments ?? []).filter((f) => f.collapsed).map((f) => [f.id, f]));
  const afterExit = (e: { ownerMessageId: string; beforeId?: string }): number => {
    if (e.beforeId === undefined) return subtreeEnd(e.ownerMessageId) + 1;
    const marker = exitById.get(e.beforeId) ?? collapsedById.get(e.beforeId);
    return marker ? afterExit(marker) : index.get(e.beforeId)!;
  };
  const fragments: Fragment[] = [];
  for (const f of d.fragments ?? []) {
    const owner = keptOf.get(f.ownerMessageId);
    if (!owner) continue;
    if (f.collapsed) {
      // a minimized fragment keeps its stub only where its owner is drawn (its calls are not in the diagram)
      if (owner !== f.ownerMessageId) continue;
      keptFragments.add(f.id);
      const beforeId = nextKept(owner, f.beforeId);
      fragments.push({ ...f, ...(f.parentId && keptFragments.has(f.parentId) ? { parentId: f.parentId } : { parentId: undefined }), ...(beforeId ? { beforeId } : { beforeId: undefined }) });
      continue;
    }
    const operands: FragmentOperand[] = [];
    for (const op of f.operands) {
      const firstStub = fragmentIds.has(op.firstMessageId);
      const lastStub = fragmentIds.has(op.lastMessageId);
      const from = firstStub ? (keptFragments.has(op.firstMessageId) ? op.firstMessageId : undefined) : undefined;
      const to = lastStub ? (keptFragments.has(op.lastMessageId) ? op.lastMessageId : undefined) : undefined;
      const firstExit = exitById.get(op.firstMessageId);
      const lastExit = exitById.get(op.lastMessageId);
      const start = firstStub ? undefined : firstExit ? afterExit(firstExit) : index.get(op.firstMessageId);
      const end = lastStub ? undefined : lastExit ? afterExit(lastExit) - 1 : index.has(op.lastMessageId) ? subtreeEnd(op.lastMessageId) : undefined;
      const span = start !== undefined && end !== undefined ? inRange(owner, start, end) : start !== undefined ? inRange(owner, start, d.messages.length - 1) : end !== undefined ? inRange(owner, 0, end) : [];
      const drawnExit = (e: ExitMarker | undefined) => (e && exitDrawn(e) ? e.id : undefined);
      // a guard whose calls all folded still shows its drawn `↩` (the early exit is what it says)
      const first = from ?? drawnExit(firstExit) ?? span[0]?.id ?? drawnExit(lastExit);
      const last = to ?? drawnExit(lastExit) ?? span[span.length - 1]?.id ?? drawnExit(firstExit);
      if (!first || !last) continue;
      operands.push({ ...op, firstMessageId: first, lastMessageId: last });
    }
    if (!operands.length) continue;
    keptFragments.add(f.id);
    const kind = f.kind === 'alt' && operands.length === 1 && operands[0].guard !== undefined && operands[0].guard !== 'else' ? 'opt' : f.kind;
    fragments.push({ ...f, kind, ownerMessageId: owner, operands, ...(f.parentId && keptFragments.has(f.parentId) ? { parentId: f.parentId } : { parentId: undefined }) });
  }
  for (const f of fragments) if (f.parentId === undefined) delete f.parentId;
  for (const f of fragments) if (f.beforeId === undefined) delete f.beforeId;
  // exits: only of the drawn activations (an inner method's early return says nothing about its layer's caller)
  const exits: ExitMarker[] = (d.exits ?? []).filter((e) => keptById.has(e.ownerMessageId)).map((e) => {
    const beforeId = nextKept(e.ownerMessageId, e.beforeId);
    return { ...e, ...(beforeId ? { beforeId } : { beforeId: undefined }) };
  });
  for (const e of exits) if (e.beforeId === undefined) delete e.beforeId;

  // the evidence of the issues: a folded call → the call it folded into, a class → its lifeline (its own key when opened)
  const keysOf = (classKey: string) => {
    const out = new Set<string>();
    for (const p of d.participants) if (p.classKey === classKey) out.add(isOpen(p) ? classKey : lifelineOf.get(p.id)!);
    return out.size ? [...out] : [classKey];
  };
  const findings = d.findings?.map((f) => zoomFinding(f, keptOf, keysOf));
  const diagram: SequenceDiagram = {
    ...d,
    participants,
    groups,
    messages: kept,
    ...(d.fragments ? { fragments } : {}),
    ...(d.exits ? (exits.length ? { exits } : { exits: undefined }) : {}),
    ...(findings ? { findings } : {}),
  };
  if (diagram.exits === undefined) delete diagram.exits;
  return { diagram, folded };
}

function zoomFinding(f: Finding, keptOf: Map<string, string>, keysOf: (classKey: string) => string[]): Finding {
  return {
    ...f,
    ...(f.messageIds?.length ? { messageIds: [...new Set(f.messageIds.map((id) => keptOf.get(id) ?? id))] } : {}),
    ...(f.classKeys?.length ? { classKeys: [...new Set(f.classKeys.flatMap(keysOf))] } : {}),
  };
}

/**
 * FR-28 the class diagram with one package per layer; `layerOrder` keeps the packages in architectural order;
 * `open` (FR-28.7): layers drawn as their classes instead.
 */
export function projectClassLayers(cd: ClassDiagram, layerOrder: string[] = [], open: ReadonlySet<string> = new Set(), openClasses: ReadonlySet<string> = new Set(), folded?: ReadonlySet<string>): ClassDiagram {
  const nodeOf = new Map<string, string>();
  const members = new Map<string, ClassNode[]>();
  const layerOpen = (key: string) => (folded ? !folded.has(key) : open.has(key));
  // the opened classes keep the diagram's order (the layout starts from it); FR-28.11 untagged in the object view
  const opened: ClassNode[] = [];
  for (const c of cd.classes) {
    const key = zoomKey(c);
    if (layerOpen(key)) opened.push(folded ? c : { ...c, inLayer: { key, name: zoomLabel(c) } });
    else if (openClasses.has(c.key)) opened.push({ ...c, inLayer: { key, name: zoomLabel(c), alone: true } });
  }
  const rank = (c: ClassNode) => {
    const i = c.layer ? layerOrder.indexOf(c.layer) : -1;
    return i >= 0 ? i : c.layer ? layerOrder.length : c.kind === 'external' ? layerOrder.length + 2 : c.kind === 'unknown' ? layerOrder.length + 3 : layerOrder.length + 1;
  };
  for (const c of [...cd.classes].sort((a, b) => rank(a) - rank(b))) {
    const key = zoomKey(c);
    if (layerOpen(key) || openClasses.has(c.key)) {
      nodeOf.set(c.key, c.key);
      continue;
    }
    nodeOf.set(c.key, key);
    if (!members.has(key)) members.set(key, []);
    members.get(key)!.push(c);
  }
  // relations between the packages (inside one: not drawn, counted as its violations)
  const edges = new Map<string, ClassRelation[]>();
  const inside = new Map<string, number>();
  const relationOf = new Map<string, string>();
  const relations: ClassRelation[] = [];
  for (const r of cd.relations) {
    const a = nodeOf.get(r.from);
    const b = nodeOf.get(r.to);
    if (!a || !b) continue;
    // a class's relation to itself stays while the class is drawn (as between two drawn classes, below)
    if (a === b && a !== r.from) {
      if (r.violation) inside.set(a, (inside.get(a) ?? 0) + 1);
      continue;
    }
    const k = `${a}→${b}`;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k)!.push(r);
  }
  // edges only join classes of the diagram (nodeOf has no other keys)
  const nameOf = (key: string) => cd.classes.find((c) => c.key === key)!.name;
  for (const [k, rs] of edges) {
    const [from, to] = k.split('→');
    // FR-28.7 between two drawn classes: the relation as it is
    if (!from.startsWith('layer:') && !to.startsWith('layer:')) {
      for (const r of rs) {
        relationOf.set(r.id, r.id);
        relations.push(r);
      }
      continue;
    }
    const broken = rs.filter((r) => r.violation);
    const calls: RelationCall[] = rs.slice(0, MAX_LISTED).map((r) => ({
      messageId: r.calls?.[0]?.messageId ?? '',
      label: `${nameOf(r.from)} → ${nameOf(r.to)}${r.kind === 'association' && r.label ? ` (${r.label})` : r.kind === 'realization' ? ' (implements)' : r.kind === 'generalization' ? ' (extends)' : ''}${r.violation ? ' ⚠' : ''}`,
      ...(r.calls?.[0]?.callSite ? { callSite: r.calls[0].callSite } : {}),
    }));
    const kinds = new Set(rs.map((r) => r.kind));
    const id = `rel:${k}`;
    for (const r of rs) relationOf.set(r.id, id);
    const diffs = new Set(rs.map((r) => r.diff));
    relations.push({
      id,
      kind: kinds.size === 1 && (kinds.has('realization') || kinds.has('generalization')) ? rs[0].kind : 'dependency',
      from,
      to,
      ...(rs.length > 1 ? { label: String(rs.length) } : {}),
      count: rs.length,
      calls,
      ...(broken.length ? { violation: `${broken.length} of ${rs.length} relation${rs.length > 1 ? 's' : ''} break the dependency rule: ${broken[0].violation}` } : {}),
      ...possibleOf(broken),
      ...(diffs.size === 1 && rs[0].diff ? { diff: rs[0].diff } : {}),
    });
  }
  const classes: ClassNode[] = [...opened];
  for (const [key, cs] of members) {
    const first = cs[0];
    const label = zoomLabel(first);
    const sideEffects = unionSideEffects(cs.map((c) => c.sideEffects));
    const change = mergedChange(cs.map((c) => c.change), cs.length);
    const diff = mergedDiff(cs.map((c) => c.diff));
    const violations = inside.get(key);
    classes.push({
      key,
      name: label,
      kind: 'module',
      stereotypes: [],
      ...(first.layer ? { layer: first.layer } : {}),
      namespace: '',
      methods: cs.map((c): ClassMember => ({ name: c.name, key: c.key, isStatic: false, signature: c.name, ...(c.declaration ? { declaration: c.declaration } : {}), ...(c.diff === 'added' || c.change?.kind === 'new' ? { diff: 'added' } : c.diff === 'removed' ? { diff: 'removed' } : c.change ? { diff: 'changed' } : {}) })),
      group: { path: key, classes: cs.length, zoom: true, ...(violations ? { violations } : {}) },
      ...(sideEffects ? { sideEffects } : {}),
      ...(change ? { change } : {}),
      ...(diff ? { diff } : {}),
    });
  }
  const findings = cd.findings?.map((f) => ({
    ...f,
    ...(f.classKeys ? { classKeys: [...new Set(f.classKeys.map((k) => nodeOf.get(k) ?? k))] } : {}),
    ...(f.relationIds ? { relationIds: [...new Set(f.relationIds.flatMap((id) => (relationOf.has(id) ? [relationOf.get(id)!] : [])))] } : {}),
  }));
  return {
    ...cd,
    classes,
    relations,
    layers: layerOrder.filter((l) => classes.some((c) => c.layer === l)),
    ...(findings ? { findings } : {}),
  };
}

/**
 * FR-28.11 the object view (no layer zoom): every band of an open layer names its layer, so its ⊖ folds it; the
 * bands of a folded layer (its lifeline, objects pulled out of it) are left as the projection made them.
 */
export function markFoldableBands(d: SequenceDiagram): SequenceDiagram {
  const groups = d.groups.map((g) => {
    const p = d.participants.find((x) => x.groupId === g.id && !x.objects && !x.inLayer);
    return p ? { ...g, fold: { key: zoomKey(p), name: zoomLabel(p) } } : g;
  });
  // each object of an open layer can fold into it alone (the others stay out, FR-28.8)
  const foldable = new Set(groups.filter((g) => g.fold).map((g) => g.id));
  const participants = d.participants.map((p) => (foldable.has(p.groupId) && !p.objects && !p.inLayer ? { ...p, layerFold: { key: zoomKey(p), name: zoomLabel(p) } } : p));
  return { ...d, groups, participants };
}

/** FR-28.11 the object view: every class of an open layer names its layer (right-click → *Fold ‹layer›*, the lane's ⊖). */
export function markFoldableClasses(cd: ClassDiagram): ClassDiagram {
  return { ...cd, classes: cd.classes.map((c) => (c.group || c.inLayer ? c : { ...c, layerFold: { key: zoomKey(c), name: zoomLabel(c) } })) };
}
