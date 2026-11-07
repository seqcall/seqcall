/**
 * FR-26 codebase map: the classes every entry point's flow reaches, merged, shown one folder
 * level at a time — sub-folders as UML packages (their classes listed), classes directly in the
 * folder as classes, relations aggregated between whatever is drawn. Pure functions over the
 * per-entry-point scans the session keeps (see `DiagramSession.getAppMap`).
 */
import type { AppMapCrumb, AppMapLevel, AppMapViolation, ClassDiagram, ClassMember, ClassNode, ClassRelation, EntryPoint, Finding, FlowOutcome, RelationCall } from '@seqcall/protocol';
import { possibleOf } from './class-diagram';
import { fileOfClassKey } from './class-key';

/** What one entry point's fully expanded flow reached (FR-26.1), kept until a file it touched changes. */
export interface EntryPointScan {
  entry: EntryPoint;
  /** Files of the classes the flow reached (its own and those of followed implementations). */
  files: Set<string>;
  classes: ClassNode[];
  relations: ClassRelation[];
  /** FR-19.9 design findings of the flow and its class diagram, with the classes of their evidence. */
  findings: { finding: Finding; classKeys: string[] }[];
  /** The flow hit the expand limit: calls stayed folded. */
  truncated: boolean;
  /**
   * FR-26.2 where the flow stops (interface calls with several implementations, folded calls), until the
   * map follows them; undefined once followed (the design-issue scan does not need them).
   */
  pending?: { methodKey: string; interfaceKey?: string }[];
  /** It could not be analysed (stale route, missing class). */
  failed?: boolean;
  /** FR-32.1 what the flow touches (I/O by the classes doing it). */
  outcome?: FlowOutcome;
}

/** The merged model: every class once (methods of all flows), every relation once (calls of all flows). */
export interface AppModel {
  classes: Map<string, ClassNode>;
  relations: Map<string, ClassRelation>;
  entryPoints: number;
  failed: number;
  truncated: number;
}

/** Underlying relations listed behind an aggregated edge (its click menu). */
const MAX_LISTED = 40;

export function mergeScans(scans: Iterable<EntryPointScan>): AppModel {
  const classes = new Map<string, ClassNode>();
  const relations = new Map<string, ClassRelation>();
  let entryPoints = 0;
  let failed = 0;
  let truncated = 0;
  for (const s of scans) {
    entryPoints++;
    if (s.failed) failed++;
    if (s.truncated) truncated++;
    for (const c of s.classes) {
      const known = classes.get(c.key);
      if (!known) {
        classes.set(c.key, { ...c, methods: [...c.methods] });
        continue;
      }
      const names = new Set(known.methods.map((m) => m.signature));
      for (const m of c.methods) if (!names.has(m.signature)) known.methods.push(m);
      known.layer ??= c.layer;
    }
    for (const r of s.relations) {
      const id = relationKey(r);
      const known = relations.get(id);
      if (!known) {
        relations.set(id, { ...r, id, calls: [...(r.calls ?? [])] });
        continue;
      }
      // stored with a list of calls above
      const sites = new Set(known.calls!.map(callId));
      for (const c of r.calls ?? []) if (!sites.has(callId(c))) known.calls!.push(c);
      if (r.violation && !known.violation) {
        known.violation = r.violation;
        if (r.possible) known.possible = r.possible;
      }
    }
  }
  // a class's method count can differ between flows: keep the list sorted for a stable picture
  for (const c of classes.values()) c.methods.sort((a, b) => a.name.localeCompare(b.name));
  return { classes, relations, entryPoints, failed, truncated };
}

function relationKey(r: ClassRelation): string {
  return `${r.kind}|${r.from}|${r.to}|${r.kind === 'association' ? (r.label ?? '') : ''}`;
}

function callId(c: RelationCall): string {
  return c.callSite ? `${c.callSite.file}:${c.callSite.start.line}:${c.callSite.start.character}` : c.label;
}

/** A class key's file outside the project root (`../…`, absolute). */
const isOutside = (file: string) => file.startsWith('../') || file.startsWith('/') || /^[A-Za-z]:/.test(file);
const dirOf = (file: string) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
const isUnder = (file: string, dir: string) => !dir || file.startsWith(`${dir}/`);

/** The deepest folder holding every class: the map starts there (`src`, not the repository root). */
export function commonRoot(files: string[]): string {
  if (!files.length) return '';
  let parts = dirOf(files[0]).split('/').filter(Boolean);
  for (const f of files.slice(1)) {
    const p = dirOf(f).split('/').filter(Boolean);
    let i = 0;
    while (i < parts.length && i < p.length && parts[i] === p[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

export interface AppLevelOptions {
  /** Architectural order of the layers (lanes). */
  layerOrder: string[];
  /** When the scans were made (ISO). */
  computedAt: string;
  /** FR-26.7 packages opened in place (folder paths): their sub-folders and classes are drawn instead of them. */
  open?: string[];
}

/**
 * One level of the map: `path` is a folder relative to the project ('' = where the classes start).
 * Children are the sub-folders holding classes (a chain of single sub-folders is one package,
 * `modules/users`) and the classes directly in the folder. Below the start, the classes outside the
 * folder that its classes are related to appear as the packages of the start level that hold them,
 * dashed. Relations between two drawn nodes are merged into one edge, labelled with how many there are.
 */
export function buildAppLevel(model: AppModel, path: string, opts: AppLevelOptions): AppMapLevel {
  const fileOf = new Map<string, string>();
  for (const key of model.classes.keys()) {
    const f = fileOfClassKey(key);
    // generated code outside the project (a NuGet build file's `Program`) is not part of the application
    if (f && !isOutside(f)) fileOf.set(key, f);
  }
  const start = commonRoot([...fileOf.values()]);
  const here = path && isUnder(`${path}/x`, start) ? path : start;
  // node of a class at this level: a package (folder below `here`), the class itself, or the start-level package outside
  // asked for files below `dir` only (this folder's, a package's, or below the common folder of an outside one)
  const packageOf = (file: string, dir: string): string | undefined => {
    const rest = file.slice(dir ? dir.length + 1 : 0);
    const seg = rest.split('/');
    return seg.length > 1 ? (dir ? `${dir}/${seg[0]}` : seg[0]) : undefined;
  };
  // a package that is a chain of single sub-folders without classes of its own goes down the chain
  const filesUnder = (dir: string) => [...fileOf.values()].filter((f) => isUnder(f, dir));
  const deepen = (dir: string): string => {
    for (;;) {
      const files = filesUnder(dir);
      if (files.some((f) => dirOf(f) === dir)) return dir;
      const subs = new Set(files.map((f) => packageOf(f, dir)));
      if (subs.size !== 1) return dir;
      dir = [...subs][0]!;
    }
  };
  const nodeOf = new Map<string, string>(); // class key → node key at this level
  const packages = new Map<string, { path: string; members: ClassNode[]; external: boolean; /** The classes directly in a parent folder. */ own?: boolean; /** FR-26.7 the open package it is shown from. */ from?: string }>();
  const shown = new Map<string, ClassNode>();
  // FR-26.7 packages opened in place (below this folder): replaced by what they hold
  const open = new Set((opts.open ?? []).filter((p) => p !== here && isUnder(`${p}/x`, here)));
  const opened = new Set<string>(); // those that are packages here (a folder that disappeared is not)
  for (const [key, file] of fileOf) {
    const c = model.classes.get(key)!;
    if (isUnder(file, here)) {
      let dir = here;
      let from: string | undefined;
      let p: string | undefined;
      for (;;) {
        const pkg = packageOf(file, dir);
        p = pkg ? deepen(pkg) : undefined;
        if (!p || !open.has(p)) break;
        opened.add(p);
        from = p;
        dir = p;
      }
      if (!p) {
        shown.set(key, from ? { ...c, inPackage: from } : c);
        nodeOf.set(key, key);
        continue;
      }
      const nodeKey = `package:${p}`;
      if (!packages.has(nodeKey)) packages.set(nodeKey, { path: p, members: [], external: false, ...(from ? { from } : {}) });
      packages.get(nodeKey)!.members.push(c);
      nodeOf.set(key, nodeKey);
    } else {
      // outside the folder: grouped by the folder beside it that holds it (below their common folder);
      // classes directly in a parent folder form that folder's own package
      const anc = commonRoot([`${here}/x`, file]);
      const sib = packageOf(file, anc);
      const p = sib ? deepen(sib) : anc;
      const nodeKey = sib ? `package:${p}` : `package:${p}/*`;
      if (!packages.has(nodeKey)) packages.set(nodeKey, { path: p, members: [], external: true, ...(sib ? {} : { own: true }) });
      packages.get(nodeKey)!.members.push(c);
      nodeOf.set(key, nodeKey);
    }
  }

  // relations between the nodes drawn here (inside one node: not drawn)
  const edges = new Map<string, ClassRelation[]>();
  for (const r of model.relations.values()) {
    const a = nodeOf.get(r.from);
    const b = nodeOf.get(r.to);
    if (!a || !b || a === b) continue;
    // nothing between two outside packages: they are only context for this folder
    if (packages.get(a)?.external && packages.get(b)?.external) continue;
    const k = `${a}→${b}`;
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k)!.push(r);
  }
  const used = new Set([...edges.values()].flatMap((rs) => [nodeOf.get(rs[0].from)!, nodeOf.get(rs[0].to)!]));
  // asked for classes of the map only (ends of drawn edges, of relations between files of the map)
  const nameOf = (key: string) => model.classes.get(key)!.name;
  const relations: ClassRelation[] = [];
  for (const [k, rs] of edges) {
    const [from, to] = k.split('→');
    const classEdge = !from.startsWith('package:') && !to.startsWith('package:');
    if (classEdge && rs.length === 1) {
      relations.push({ ...rs[0], id: `rel:${k}` });
      continue;
    }
    const broken = rs.filter((r) => r.violation);
    const calls: RelationCall[] = rs.slice(0, MAX_LISTED).map((r) => ({
      messageId: '',
      label: `${nameOf(r.from)} → ${nameOf(r.to)}${r.kind === 'association' && r.label ? ` (${r.label})` : r.kind === 'realization' ? ' (implements)' : r.kind === 'generalization' ? ' (extends)' : ''}${r.violation ? ' ⚠' : ''}`,
      ...(r.calls?.[0]?.callSite ? { callSite: r.calls[0].callSite } : model.classes.get(r.from)?.declaration ? { callSite: model.classes.get(r.from)!.declaration } : {}),
    }));
    const kinds = new Set(rs.map((r) => r.kind));
    relations.push({
      id: `rel:${k}`,
      kind: kinds.size === 1 && (kinds.has('realization') || kinds.has('generalization')) ? rs[0].kind : 'dependency',
      from,
      to,
      ...(rs.length > 1 ? { label: String(rs.length) } : {}),
      count: rs.length,
      calls,
      ...(broken.length ? { violation: `${broken.length} of ${rs.length} relation${rs.length > 1 ? 's' : ''} break the dependency rule: ${broken[0].violation}` } : {}),
      ...possibleOf(broken),
    });
  }

  // a folder's classes per layer ('' none), most first, a tie by the layer order; its lane is the first with a layer
  const layerCounts = (members: ClassNode[]): [string, number][] => {
    const n = new Map<string, number>();
    for (const c of members) n.set(c.layer ?? '', (n.get(c.layer ?? '') ?? 0) + 1);
    const rank = (l: string) => (l ? opts.layerOrder.indexOf(l) : opts.layerOrder.length);
    return [...n].sort((x, y) => y[1] - x[1] || rank(x[0]) - rank(y[0]));
  };
  const classes: ClassNode[] = [];
  for (const [key, p] of packages) {
    if (p.external && !used.has(key)) continue;
    // inside an open package: named below it (its folder says where, `in …`); an outside package is a folder below the
    // start (a sibling below the common folder): its path is longer than the start's
    const label = p.own ? `${p.path.split('/').pop() || '(root)'} (its own classes)` : p.from ? p.path.slice(p.from.length + 1) : !p.external ? p.path.slice(here ? here.length + 1 : 0) : p.path.slice(start ? start.length + 1 : 0);
    const members = [...p.members].sort((a, b) => a.name.localeCompare(b.name));
    const inside = [...model.relations.values()].filter((r) => r.violation && nodeOf.get(r.from) === key && nodeOf.get(r.to) === key).length;
    const counts = layerCounts(members);
    const layer = counts.find(([l]) => l)?.[0];
    // a mixed folder says so (a split bar): its lane alone would hide the other layers
    const mixed = counts.length > 1 ? { layers: counts.map(([l, n]) => ({ ...(l ? { layer: l } : {}), classes: n })) } : {};
    classes.push({
      key,
      name: label,
      kind: 'module',
      stereotypes: [],
      ...(layer ? { layer } : {}),
      namespace: p.path,
      methods: members.map((c): ClassMember => ({ name: c.name, isStatic: false, signature: c.name, ...(c.declaration ? { declaration: c.declaration } : {}) })),
      group: { path: p.path, classes: members.length, ...(p.external ? { external: true } : {}), ...(inside ? { violations: inside } : {}), ...(p.from ? { in: p.from } : {}), ...mixed },
    });
  }
  for (const c of shown.values()) classes.push(c);
  // no edges between a class's own rows: a class's methods are its own
  // the legend names a layer that is only part of a mixed folder too
  const layers = opts.layerOrder.filter((l) => classes.some((c) => c.layer === l || c.group?.layers?.some((x) => x.layer === l)));
  const diagram: ClassDiagram = { classes, relations, layers };
  const crumbs: AppMapCrumb[] = [{ label: 'Codebase', path: start }];
  if (here !== start) {
    const rest = here.slice(start ? start.length + 1 : 0).split('/');
    let acc = start;
    for (const seg of rest) {
      acc = acc ? `${acc}/${seg}` : seg;
      // a chain folder that is never a level of its own still gets its crumb (it opens the chain's end)
      crumbs.push({ label: seg, path: acc });
    }
  }
  const all = [...model.relations.values()].filter((r) => fileOf.has(r.from) && fileOf.has(r.to));
  // FR-26.6 every violation, with the folder where it is drawn as an edge (both classes below it, apart)
  const violationList: AppMapViolation[] = all
    .filter((r) => r.violation)
    .map((r): AppMapViolation => {
      // both ends are classes of the map (`all` keeps relations between its files)
      const a = model.classes.get(r.from)!;
      const b = model.classes.get(r.to)!;
      return {
        from: r.from, to: r.to, fromName: nameOf(r.from), toName: nameOf(r.to), violation: r.violation!, folder: commonRoot([fileOf.get(r.from)!, fileOf.get(r.to)!]),
        ...(a.layer ? { fromLayer: a.layer } : {}), ...(b.layer ? { toLayer: b.layer } : {}),
        ...(a.layerHint ? { fromHint: a.layerHint } : {}), ...(b.layerHint ? { toHint: b.layerHint } : {}),
        ...(r.possible ? { possible: r.possible } : {}),
      };
    });
  const possibleViolations = violationList.filter((v) => v.possible).length;
  return {
    path: here,
    crumbs,
    diagram,
    entryPoints: model.entryPoints,
    failed: model.failed,
    truncated: model.truncated,
    classes: fileOf.size,
    relations: all.length,
    violations: violationList.length,
    ...(possibleViolations ? { possibleViolations } : {}),
    ...(opened.size ? { open: [...opened] } : {}),
    ...(violationList.length ? { violationList } : {}),
    computedAt: opts.computedAt,
  };
}
