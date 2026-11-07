/**
 * FR-29 Level 0 of a review: the structural delta of a branch. Both versions of the application are the
 * codebase map's model (FR-26.1: every entry point's flow, expanded fully, merged); the diff lists what the
 * branch did to the *shape* — dependencies between layers (or between the map's packages inside one layer)
 * that appeared or vanished, layer violations added or removed, entry points added or removed, I/O kinds a layer
 * started or stopped doing (and new I/O clients), cycles between layers / packages that appeared or vanished, classes
 * that changed layer or role.
 * Pure functions; the session gathers the two sides (`DiagramSession.compareStructure`).
 */
import type { ClassNode, ClassRelation, EntryPoint, SideEffectKind, StructurePair, StructureRow, StructureRowKind } from '@seqcall/protocol';
import { mergeScans, type EntryPointScan } from '../app-map';
import { fileOfClassKey } from '../class-key';
import { zoomKey, zoomLabel } from '../layer-zoom';

export interface StructureSide {
  /** One scan per entry point of that version (tests excluded); flows identical in both versions may be shared. */
  scans: EntryPointScan[];
  /** Every entry point of that version (tests excluded) — a flow that failed still counts as an entry point. */
  entryPoints: EntryPoint[];
  /**
   * FR-29.7 / 28.10 the I/O of each class of the side: the kinds and clients of the libraries of its file (as the
   * class box's badge, FR-17.2).
   */
  io?: ReadonlyMap<string, readonly IoUse[]>;
}

/** FR-29.10 one I/O client of a class: its kind and technology (`db` / `Npgsql`). */
export interface IoUse {
  kind: SideEffectKind;
  client: string;
}

/** FR-29.11 stereotypes that can depend on how one diagram reaches the object (FR-7.9 `inThisDiagram`), for classes without reasons. */
const FLOW_STEREOTYPES = new Set(['static', 'seam']);

export interface StructureOptions {
  /** FR-29.9 renamed files, base path → branch path: a moved class is the same class. */
  renames?: ReadonlyMap<string, string>;
}

const IO_NAMES: Record<SideEffectKind, string> = { db: 'DB', cache: 'Cache', http: 'HTTP', file: 'File', queue: 'Queue', cloud: 'Cloud', process: 'Process' };

/** Class pairs listed behind an edge row. */
const MAX_PAIRS = 20;
/** Code-unit order (what a bare sort() does), so keys and cycle order stay the same on every machine. */
const byCode = (a: string, b: string) => Number(a > b) - Number(a < b);

/** The same entry point in both versions: its kind and label (a route moved to another method is not a new route). */
export const entryIdentity = (e: EntryPoint): string => `${e.kind}|${e.label}`;

/** Relations that are calls / fields between two classes of the flow; type uses and inheritance are no flow edges. */
const isEdge = (r: ClassRelation) => (r.kind === 'dependency' || r.kind === 'association') && r.from !== r.to;
const isCreate = (r: ClassRelation) => r.label === '«create»';

/** The class pair behind a relation, with its first call (refined from the flow by `withCalls`). */
function pairOf(r: ClassRelation, from: ClassNode, to: ClassNode): StructurePair {
  const call = r.calls?.[0];
  return { from: r.from, fromName: from.name, to: r.to, toName: to.name, ...(call ? { call: { label: call.label, ...(call.callSite ? { callSite: call.callSite } : {}) } } : {}) };
}

/** FR-29.8 a strongly connected set: its members (`path` first: a cycle through them, then the rest) and its edges. */
interface Cycle {
  level: 'layer' | 'package';
  members: string[];
  path: string[];
  groups: Group[];
}

interface Group {
  level: 'layer' | 'package';
  from: string;
  to: string;
  title: string;
  pairs: Map<string, StructurePair>;
}

export function diffStructure(base: StructureSide, branch: StructureSide, opts: StructureOptions = {}): StructureRow[] {
  const rows: StructureRow[] = [];
  const a = mergeScans(base.scans);
  const b = mergeScans(branch.scans);
  // inside one layer the unit is the package of the codebase map: where the two classes' folders part (FR-26.6 draws
  // the edge in the deepest folder holding both) — a class directly in that folder stands for the folder itself
  const dirOf = (c: ClassNode) => (fileOfClassKey(c.key) ?? '').split('/').slice(0, -1);
  const pairPackages = (from: ClassNode, to: ClassNode): [string, string] => {
    const da = dirOf(from);
    const db = dirOf(to);
    let i = 0;
    while (i < da.length && i < db.length && da[i] === db[i]) i++;
    return [da.slice(0, Math.min(da.length, i + 1)).join('/'), db.slice(0, Math.min(db.length, i + 1)).join('/')];
  };
  const last = (p: string) => p.split('/').pop() || '(root)';
  const labels = new Map<string, string>(); // node (lifeline key / package path) → its label, for cycles
  const groups = (classes: Map<string, ClassNode>, relations: Iterable<ClassRelation>): Map<string, Group> => {
    const out = new Map<string, Group>();
    for (const r of relations) {
      if (!isEdge(r)) continue;
      const from = classes.get(r.from);
      const to = classes.get(r.to);
      if (!from || !to) continue;
      let g: Omit<Group, 'pairs'>;
      const kf = zoomKey(from);
      const kt = zoomKey(to);
      if (kf !== kt) {
        g = { level: 'layer', from: kf, to: kt, title: `${zoomLabel(from)} → ${zoomLabel(to)}` };
        labels.set(kf, zoomLabel(from));
        labels.set(kt, zoomLabel(to));
      } else {
        const [pf, pt] = pairPackages(from, to);
        if (pf === pt) continue; // inside one package of one layer: not a structural edge
        g = { level: 'package', from: pf, to: pt, title: `${last(pf)} → ${last(pt)}` };
        labels.set(pf, last(pf));
        labels.set(pt, last(pt));
      }
      const id = `${g.level}|${g.from}|${g.to}`;
      const group = out.get(id) ?? { ...g, pairs: new Map() };
      out.set(id, group);
      const pairId = `${r.from}>${r.to}`;
      if (!group.pairs.has(pairId)) group.pairs.set(pairId, pairOf(r, from, to));
    }
    return out;
  };
  const ga = groups(a.classes, a.relations.values());
  const gb = groups(b.classes, b.relations.values());
  // the entry point a row opens: the first flow with the pair — for a removed edge one that still exists on the
  // branch when there is one (its flow shows the removed call as a ghost, FR-24.6)
  const branchIdentities = new Set(branch.entryPoints.map(entryIdentity));
  const firstScanWhere = (side: StructureSide, has: (s: EntryPointScan) => boolean): EntryPointScan | undefined => {
    const hits = side.scans.filter(has);
    return hits.find((s) => branchIdentities.has(entryIdentity(s.entry))) ?? hits[0];
  };
  const edgeIn = (pairs: StructurePair[]) => {
    const wanted = new Set(pairs.map((p) => `${p.from}>${p.to}`));
    return (s: EntryPointScan) => s.relations.some((r) => isEdge(r) && wanted.has(`${r.from}>${r.to}`));
  };
  // The merged model of a side is built from that side's scans, so every flow edge and class of it is in one of them:
  // the rows of edges, cycles, I/O, layer and role changes always find their flow (only a violation can be on a
  // relation that is no flow edge — a type use, an inheritance —, violationRow looks for its flow itself).
  const firstScan = (side: StructureSide, pairs: StructurePair[]): EntryPointScan => firstScanWhere(side, edgeIn(pairs))!;
  // a class's row (I/O kind, layer changed) opens the first flow reaching the class, at the first call into it
  const classScan = (side: StructureSide, keys: string[]): EntryPointScan => {
    const wanted = new Set(keys);
    return firstScanWhere(side, (s) => s.classes.some((c) => wanted.has(c.key)))!;
  };
  const callInto = (scan: EntryPointScan, keys: string[], classes: Map<string, ClassNode>): StructurePair[] => {
    for (const key of keys) {
      const r = scan.relations.find((x) => isEdge(x) && x.to === key && x.calls?.length);
      const from = r && classes.get(r.from);
      const to = classes.get(key);
      if (r && from && to) return withCalls([pairOf(r, from, to)], scan);
    }
    return [];
  };
  // the call to open, from that flow's own relations: the merged model keeps one call per site, and a creation and
  // the call on it share one (`new Db().save()`) — the flow still has both
  const withCalls = (pairs: StructurePair[], scan: EntryPointScan | undefined): StructurePair[] =>
    pairs.map((pair) => {
      const rels = (scan?.relations ?? []).filter((r) => isEdge(r) && r.from === pair.from && r.to === pair.to && r.calls?.length);
      const call = (rels.find((r) => !isCreate(r)) ?? rels[0])?.calls?.[0];
      return call ? { ...pair, call: { label: call.label, ...(call.callSite ? { callSite: call.callSite } : {}) } } : pair;
    });
  const edgeRow = (kind: StructureRowKind, g: Group, side: StructureSide): StructureRow => {
    const pairs = [...g.pairs.values()];
    const names = pairs.map((p) => `${p.fromName} → ${p.toName}`);
    const scan = firstScan(side, pairs);
    return {
      kind,
      title: g.title,
      detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`,
      level: g.level,
      from: g.from,
      to: g.to,
      pairs: withCalls(pairs.slice(0, MAX_PAIRS), scan),
      entryPoint: scan.entry,
    };
  };
  for (const [id, g] of gb) if (!ga.has(id)) rows.push(edgeRow('edge-added', g, branch));
  for (const [id, g] of ga) if (!gb.has(id)) rows.push(edgeRow('edge-removed', g, base));

  // layer violations: a class pair breaking the dependency rule
  const violations = (classes: Map<string, ClassNode>, relations: Iterable<ClassRelation>) => {
    const out = new Map<string, { r: ClassRelation; from: ClassNode; to: ClassNode }>();
    for (const r of relations) {
      const from = classes.get(r.from);
      const to = classes.get(r.to);
      if (!r.violation || !from || !to || r.from === r.to) continue;
      const known = out.get(`${r.from}>${r.to}`);
      // the first relation of the pair (a creation and a field of one pair carry the same violation text, and the row's
      // call comes from its flow, withCalls)
      if (!known) out.set(`${r.from}>${r.to}`, { r, from, to });
    }
    return out;
  };
  const va = violations(a.classes, a.relations.values());
  const vb = violations(b.classes, b.relations.values());
  const violationRow = (kind: StructureRowKind, v: { r: ClassRelation; from: ClassNode; to: ClassNode }, side: StructureSide): StructureRow => {
    const pair = pairOf(v.r, v.from, v.to);
    const scan = firstScanWhere(side, edgeIn([pair]));
    return { kind, title: `Layer violation: ${v.from.name} → ${v.to.name}`, detail: v.r.violation!, level: 'layer', from: zoomKey(v.from), to: zoomKey(v.to), pairs: withCalls([pair], scan), ...(v.r.possible ? { possible: v.r.possible } : {}), ...(scan ? { entryPoint: scan.entry } : {}) };
  };
  for (const [id, v] of vb) if (!va.has(id)) rows.push(violationRow('violation-added', v, branch));
  for (const [id, v] of va) if (!vb.has(id)) rows.push(violationRow('violation-removed', v, base));

  // FR-29.8 cycles between layers / between packages: strongly connected sets of the grouped graph, per level
  const cycles = (gs: Map<string, Group>) => {
    const out = new Map<string, Cycle>();
    for (const level of ['layer', 'package'] as const) {
      const edges = [...gs.values()].filter((g) => g.level === level);
      for (const scc of stronglyConnected(edges.map((g) => [g.from, g.to] as const))) {
        const set = new Set(scc);
        const inside = edges.filter((g) => set.has(g.from) && set.has(g.to));
        const { path, rest } = cycleOrder(inside.map((g) => [g.from, g.to] as const), scc);
        out.set(`${level}|${[...scc].sort(byCode).join('|')}`, { level, members: [...path, ...rest], path, groups: inside });
      }
    }
    return out;
  };
  const ca = cycles(ga);
  const cb = cycles(gb);
  const cycleRow = (kind: StructureRowKind, c: Cycle, side: StructureSide, other: Map<string, Group>): StructureRow => {
    // the pairs that closed it: the edges the other version lacks (there is one — with all of them the other version
    // would have a cycle around these members, and `within` drops the row)
    const along = c.groups.filter((g) => !other.has(`${g.level}|${g.from}|${g.to}`)).sort((x, y) => c.members.indexOf(x.from) - c.members.indexOf(y.from));
    const pairs = along.flatMap((g) => [...g.pairs.values()]);
    const names = pairs.map((p) => `${p.fromName} → ${p.toName}`);
    const scan = firstScan(side, pairs);
    // groups() labels both ends of every group, and the members of a cycle are ends of its groups
    const name = (m: string) => labels.get(m)!;
    const shown = c.path.map(name);
    const rest = c.members.slice(c.path.length).map(name);
    return {
      kind,
      title: `Cycle: ${[...shown, shown[0]].join(' → ')}${rest.length ? ` (+ ${rest.join(', ')})` : ''}`,
      detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`,
      level: c.level,
      members: c.members,
      pairs: withCalls(pairs.slice(0, MAX_PAIRS), scan),
      entryPoint: scan.entry,
    };
  };
  // a cycle that grew or shrank is no new / vanished cycle: only one the other version has no cycle around
  const within = (c: { level: string; members: string[] }, others: Map<string, { level: string; members: string[] }>) =>
    [...others.values()].some((o) => o.level === c.level && c.members.every((m) => o.members.includes(m)));
  for (const c of cb.values()) if (!within(c, ca)) rows.push(cycleRow('cycle-added', c, branch, ga));
  for (const c of ca.values()) if (!within(c, cb)) rows.push(cycleRow('cycle-removed', c, base, gb));

  // FR-29.7 I/O kinds per layer, FR-29.10 the clients behind them: from the layer's classes (interfaces and groups do
  // no I/O of their own)
  const ioByLayer = (classes: Map<string, ClassNode>, io: StructureSide['io'], unit: (u: IoUse) => string) => {
    const out = new Map<string, { label: string; classes: ClassNode[]; use: IoUse }>();
    for (const c of classes.values()) {
      if (c.kind === 'interface' || c.group) continue;
      const seen = new Set<string>();
      for (const use of io?.get(c.key) ?? []) {
        const id = `${zoomKey(c)}|${unit(use)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const known = out.get(id) ?? { label: zoomLabel(c), classes: [], use };
        known.classes.push(c);
        out.set(id, known);
      }
    }
    return out;
  };
  if (base.io && branch.io) {
    const byKind = (u: IoUse) => u.kind;
    const byClient = (u: IoUse) => `${u.kind}|${u.client}`;
    const ia = ioByLayer(a.classes, base.io, byKind);
    const ib = ioByLayer(b.classes, branch.io, byKind);
    const ioRow = (kind: StructureRowKind, id: string, v: { label: string; classes: ClassNode[]; use: IoUse }, side: StructureSide, classes: Map<string, ClassNode>, client?: string): StructureRow => {
      const layer = id.split('|')[0];
      const keys = v.classes.map((c) => c.key);
      const names = v.classes.map((c) => c.name).sort(byCode);
      const scan = classScan(side, keys);
      return {
        kind,
        title: client ? `${v.label}: ${client} (${IO_NAMES[v.use.kind]})` : `${v.label}: ${IO_NAMES[v.use.kind]}`,
        detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`,
        level: 'layer',
        from: layer,
        io: v.use.kind,
        ...(client ? { client } : {}),
        classKeys: keys,
        pairs: callInto(scan, keys, classes),
        entryPoint: scan.entry,
      };
    };
    for (const [id, v] of ib) if (!ia.has(id)) rows.push(ioRow('io-added', id, v, branch, b.classes));
    for (const [id, v] of ia) if (!ib.has(id)) rows.push(ioRow('io-removed', id, v, base, a.classes));
    // a client new to a layer that already did that kind of I/O (a new kind's row names its classes already)
    const clientsA = ioByLayer(a.classes, base.io, byClient);
    const clientsB = ioByLayer(b.classes, branch.io, byClient);
    const kindOf = (id: string) => id.split('|').slice(0, 2).join('|');
    for (const [id, v] of clientsB) if (!clientsA.has(id) && ia.has(kindOf(id))) rows.push(ioRow('client-added', id, v, branch, b.classes, v.use.client));
    for (const [id, v] of clientsA) if (!clientsB.has(id) && ib.has(kindOf(id))) rows.push(ioRow('client-removed', id, v, base, a.classes, v.use.client));
  }

  // FR-29.9 classes in another layer than on the base (a moved file is the same class: its key by the new path)
  const branchKey = (key: string) => {
    const file = fileOfClassKey(key);
    const moved = file && opts.renames?.get(file);
    return moved ? moved + key.slice(file.length) : key;
  };
  for (const old of a.classes.values()) {
    const now = b.classes.get(branchKey(old.key));
    if (!now || zoomKey(old) === zoomKey(now)) continue;
    const scan = classScan(branch, [now.key]);
    // why it is there now: the file moved, and / or the rule that placed it (FR-7.8)
    const why = [...(now.key !== old.key ? [`moved from ${fileOfClassKey(old.key)}`] : []), ...(now.layerReason ? [now.layerReason.text.replace(/`/g, '')] : [])];
    rows.push({
      kind: 'layer-changed',
      title: `${now.name}: ${zoomLabel(old)} → ${zoomLabel(now)}`,
      ...(why.length ? { detail: why.join(' · ') } : {}),
      level: 'layer',
      from: zoomKey(old),
      to: zoomKey(now),
      classKeys: [now.key],
      pairs: callInto(scan, [now.key], b.classes),
      entryPoint: scan.entry,
    });
  }

  // FR-29.11 classes whose role (stereotypes) differs: over every flow of each side, without the stereotypes one
  // diagram's way of reaching the object gives (FR-7.9)
  const roles = (side: StructureSide) => {
    const out = new Map<string, { roles: Set<string>; reasons: Map<string, string> }>();
    for (const sc of side.scans) {
      for (const c of sc.classes) {
        const known = out.get(c.key) ?? { roles: new Set<string>(), reasons: new Map<string, string>() };
        out.set(c.key, known);
        // the reasons say which ones this flow gave («static» can also be "all its members are static"); without them, by name
        const flowOnly = c.stereotypeReasons?.length ? new Set(c.stereotypeReasons.filter((r) => r.inThisDiagram).map((r) => r.stereotype)) : FLOW_STEREOTYPES;
        // «data» (FR-7.15) is no role: it follows every edit of the class's code, which the review shows anyway
        for (const st of c.stereotypes) if (!flowOnly.has(st) && st !== 'data') known.roles.add(st);
        for (const r of c.stereotypeReasons ?? []) if (!r.inThisDiagram && !known.reasons.has(r.stereotype)) known.reasons.set(r.stereotype, r.text.replace(/`/g, ''));
      }
    }
    return out;
  };
  const ra = roles(base);
  const rb = roles(branch);
  const roleText = (set: Set<string>) => (set.size ? [...set].sort(byCode).map((x) => `«${x}»`).join(' ') : 'no role');
  for (const [oldKey, was] of ra) {
    const now = b.classes.get(branchKey(oldKey));
    const is = now && rb.get(now.key);
    if (!now || !is || (was.roles.size === is.roles.size && [...was.roles].every((x) => is.roles.has(x)))) continue;
    const scan = classScan(branch, [now.key]);
    const gained = [...is.roles].filter((x) => !was.roles.has(x)).sort(byCode);
    rows.push({
      kind: 'role-changed',
      title: `${now.name}: ${roleText(was.roles)} → ${roleText(is.roles)}`,
      ...(gained.length && gained.every((x) => is.reasons.has(x)) ? { detail: gained.map((x) => `«${x}» — ${is.reasons.get(x)}`).join(' · ') } : {}),
      level: 'layer',
      classKeys: [now.key],
      pairs: callInto(scan, [now.key], b.classes),
      entryPoint: scan.entry,
    });
  }

  // entry points
  const ea = new Map(base.entryPoints.map((e) => [entryIdentity(e), e]));
  const eb = new Map(branch.entryPoints.map((e) => [entryIdentity(e), e]));
  const entryRow = (kind: StructureRowKind, e: EntryPoint): StructureRow => ({
    kind,
    title: e.label,
    detail: `${e.method.owner.kind === 'module' ? e.method.name : `${e.method.owner.name}.${e.method.name}`}${e.detail ? ` · ${e.detail}` : ''}`,
    entryPoint: e,
  });
  for (const [id, e] of eb) if (!ea.has(id)) rows.push(entryRow('entry-added', e));
  for (const [id, e] of ea) if (!eb.has(id)) rows.push(entryRow('entry-removed', e));

  const order: StructureRowKind[] = ['violation-added', 'cycle-added', 'edge-added', 'io-added', 'client-added', 'layer-changed', 'role-changed', 'entry-added', 'edge-removed', 'cycle-removed', 'io-removed', 'client-removed', 'violation-removed', 'entry-removed'];
  const level = (r: StructureRow) => (r.level === 'package' ? 1 : 0);
  return rows.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || level(x) - level(y) || x.title.localeCompare(y.title));
}

/**
 * The entry points whose flows must be analysed on the base version: a flow that reached a changed file (its
 * classes', its followed implementations' — `changed` holds the branch's changed files and their old names), or
 * one that failed. Every other flow is the same in both versions.
 */
export function affectedScans(scans: EntryPointScan[], changed: ReadonlySet<string>): EntryPointScan[] {
  return scans.filter((s) => s.failed || [...s.files].some((f) => changed.has(f)));
}

/** Tarjan: the strongly connected sets of a directed graph with more than one node (a cycle between them). */
export function stronglyConnected(edges: readonly (readonly [string, string])[]): string[][] {
  const next = new Map<string, string[]>();
  for (const [f, t] of edges) {
    next.set(f, [...(next.get(f) ?? []), t]);
    if (!next.has(t)) next.set(t, []);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v)!) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1) out.push(scc);
  };
  for (const v of [...next.keys()].sort(byCode)) if (!index.has(v)) visit(v);
  return out;
}

/**
 * A cycle through a strongly connected set, to name it: through every member when there is one (a small search from
 * the first member, sorted), else the shortest way back to the first member; `rest` = the members it does not pass.
 */
function cycleOrder(edges: readonly (readonly [string, string])[], scc: string[]): { path: string[]; rest: string[] } {
  const sorted = [...scc].sort(byCode);
  const start = sorted[0];
  const next = (v: string) => edges.filter(([f]) => f === v).map(([, t]) => t).sort(byCode);
  let budget = 5000;
  const full = (path: string[]): string[] | undefined => {
    if (--budget < 0) return undefined;
    const v = path[path.length - 1];
    for (const t of next(v)) {
      if (t === start && path.length === scc.length) return path;
      if (t === start || path.includes(t)) continue;
      const found = full([...path, t]);
      if (found) return found;
    }
    return undefined;
  };
  const all = full([start]);
  if (all) return { path: all, rest: [] };
  const prev = new Map<string, string>();
  const queue = [start];
  let end: string | undefined;
  while (queue.length && !end) {
    const v = queue.shift()!;
    for (const t of next(v)) {
      if (t === start) {
        end = v;
        break;
      }
      if (!prev.has(t)) {
        prev.set(t, v);
        queue.push(t);
      }
    }
  }
  const path: string[] = [];
  for (let v = end; v && v !== start; v = prev.get(v)) path.unshift(v);
  const order = [start, ...path];
  return { path: order, rest: sorted.filter((m) => !order.includes(m)) };
}
