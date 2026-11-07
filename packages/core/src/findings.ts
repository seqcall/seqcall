import type { ClassNode, ClassRelation, Finding, FindingKind, Message, Participant, SideEffectKind, SourceRange } from '@seqcall/protocol';
import { SIDE_EFFECT_LABEL } from './side-effects';

/**
 * FR-19 design findings: likely design flaws in what the diagram shows, as short clickable markers
 * with their evidence (messages / classes to highlight). One pass over data the session already has —
 * no adapter requests. Flow findings (Q1–Q4) look at the visible sequence diagram, class findings
 * (Q10, Q11) at the visible classes.
 */

/** Remote I/O that turns a loop into N+1 round trips (FILE / PROC are local). */
const REMOTE: SideEffectKind[] = ['db', 'cache', 'http', 'queue', 'cloud'];

export interface FlowInput {
  /** Pre-order, as rendered. */
  messages: Message[];
  participants: Participant[];
  /** Messages whose call sits inside a loop over a collection in its caller's body (foreach / for…of / each-callbacks, FR-1.11). */
  inLoop: ReadonlySet<string>;
  /**
   * Messages whose call runs only while a field is not set yet — a lazy load / memoized cache
   * (`if (!self::$loaded)`, `if ($this->client === null)`, `if (!this.cache)`, `if (_x is null)`): the
   * I/O below runs once, not once per loop iteration.
   */
  loadOnce?: ReadonlySet<string>;
  /**
   * FR-1.20 messages whose call is in a JSX handler written inside the loop (`items.map((i) => <Row onDelete={() =>
   * api.delete(i)} />)`): the I/O runs on that user action, not once per element.
   */
  onAction?: ReadonlySet<string>;
  /** Classes whose I/O is by design (Active Record models such as Eloquent): no "I/O in Domain". */
  activeRecord?: (classKey: string) => boolean;
  /** `findings.ignore`: globs on `Class.method` (calls) / class names that are known to be fine. */
  ignored?: (name: string) => boolean;
  disabled?: ReadonlySet<string>;
  /** FR-19.14 «locals»: the inner functions of one function (TS) — part of that function, no class of their own. */
  localFunctions?: (classKey: string) => boolean;
}

const fileOf = (classKey: string) => classKey.slice(0, classKey.indexOf('#'));
const baseName = (file: string) => file.slice(file.lastIndexOf('/') + 1);
const lineOf = (r: SourceRange | undefined) => (r ? ` (${baseName(r.file)}:${r.start.line + 1})` : '');

const label = (m: Message) => `${m.className ?? '?'}.${m.kind === 'create' ? 'constructor' : m.methodName}`;
const kindsText = (kinds: Iterable<SideEffectKind>) => [...new Set(kinds)].map((k) => SIDE_EFFECT_LABEL[k]).join(', ');

export function flowFindings(input: FlowInput): Finding[] {
  const out: Finding[] = [];
  const off = (k: FindingKind) => input.disabled?.has(k) ?? false;
  const byId = new Map(input.participants.map((p) => [p.id, p]));
  const messages = input.messages;
  const below = (m: Message) => messages.filter((x) => x.id.startsWith(`${m.id}/`));

  // Q1 I/O in a loop (N+1): a call inside a loop over a collection that does remote I/O — itself or below it.
  // Only found further down (not drawn yet) = "possible": it may run on a cache miss only, static
  // analysis cannot see memoization. Identical findings of one diagram are grouped.
  if (!off('io-in-loop')) {
    const reported: string[] = [];
    const grouped = new Map<string, Finding>();
    for (const m of messages) {
      if (!input.inLoop.has(m.id) || reported.some((r) => m.id.startsWith(`${r}/`)) || input.ignored?.(label(m))) continue;
      // I/O reached only through a load-once branch (a cache filled on first use) runs once, not per element; I/O in
      // a JSX handler runs when the user acts (FR-1.20)
      const onceBetween = (x: Message) => {
        const parts = x.id.split('/');
        for (let n = m.id.split('/').length; n <= parts.length; n++) {
          const id = parts.slice(0, n).join('/');
          if (input.loadOnce?.has(id) || input.onAction?.has(id)) return true;
        }
        return false;
      };
      const evidence = [m, ...below(m)].filter((x) => x.sideEffects?.kinds.some((k) => REMOTE.includes(k)) && !onceBetween(x));
      if (!evidence.length) continue;
      const kinds = evidence.flatMap((x) => x.sideEffects!.kinds.filter((k) => REMOTE.includes(k)));
      const possible = evidence.every((x) => x.sideEffects!.below);
      reported.push(m.id);
      const title = `${possible ? 'Possible I/O' : 'I/O'} in a loop: ${label(m)} (${kindsText(kinds)})`;
      const ids = [m.id, ...evidence.filter((x) => x !== m).map((x) => x.id)];
      const known = grouped.get(title);
      if (known) {
        // made with its messages below
        known.messageIds = [...new Set([...known.messageIds!, ...ids])];
        continue;
      }
      const f: Finding = {
        id: `io-in-loop:${m.id}`,
        kind: 'io-in-loop',
        title,
        detail: possible
          ? // the call is drawn, the calls below it are not: say which part is missing
            'The I/O is inside this call, in calls not opened yet — it may run on every iteration, or only on a cache miss. Expand the call to check.'
          : 'Runs once per iteration — one round trip per element (N+1). Batch it, or load once before the loop.',
        messageIds: ids,
        ignoreKey: label(m),
      };
      grouped.set(title, f);
      out.push(f);
    }
  }

  // Q2 I/O in Domain: the domain layer should be free of I/O
  if (!off('io-in-domain')) {
    const seen = new Set<string>();
    for (const p of input.participants) {
      if (p.layer?.toLowerCase() !== 'domain' || seen.has(p.classKey) || input.activeRecord?.(p.classKey) || input.ignored?.(p.className)) continue;
      const calls = messages.filter((m) => m.to === p.id && m.sideEffects && !m.sideEffects.below);
      const kinds = [...(p.sideEffects?.kinds ?? []), ...calls.flatMap((m) => m.sideEffects!.kinds)];
      if (!kinds.length) continue;
      seen.add(p.classKey);
      out.push({
        id: `io-in-domain:${p.classKey}`,
        kind: 'io-in-domain',
        title: `I/O in Domain: ${p.className} (${kindsText(kinds)})`,
        ignoreKey: p.className,
        detail: 'Domain code should not talk to databases or services; put the I/O behind a port in Application / Infrastructure.',
        classKeys: [p.classKey],
        ...(calls.length ? { messageIds: calls.map((m) => m.id) } : {}),
      });
    }
  }

  // Q3 / Q4 along each call path (root → leaf)
  const children = new Map<string | null, Message[]>();
  for (const m of messages) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
  const pingPong = new Map<string, Finding>();
  const cycles = new Map<string, Finding>();
  const walk = (m: Message, path: Message[]) => {
    const here = [...path, m];
    const kids = children.get(m.id) ?? [];
    if (!kids.length) {
      if (!off('layer-ping-pong')) layerPingPong(here, byId, pingPong, input.localFunctions);
      if (!off('cyclic-collaboration')) cyclicCollaboration(here, byId, cycles, input.localFunctions);
    }
    for (const k of kids) walk(k, here);
  };
  for (const root of children.get(null) ?? []) walk(root, []);
  out.push(...pingPong.values(), ...cycles.values());
  return out;
}

/**
 * FR-19.16 a call back into code the caller was handed: a lambda / delegate passed as a parameter (FR-1.11 / FR-1.13),
 * or an inner function («locals») — reachable from outside its function only when that function handed it out
 * (`onSearchStart={…}` as a prop). The caller does not know who is on the other side: no dependency, no layer crossing.
 */
function isCallback(m: Message, byId: Map<string, Participant>, localFunctions?: (classKey: string) => boolean): boolean {
  // (lambdas and functions passed as parameters are handled by the caller before it asks)
  const to = byId.get(m.to);
  return !!to && !!localFunctions?.(to.classKey);
}

/** Q3: along one path the receiving layers go A → B → A → B (a leaky port or a missing aggregate). */
function layerPingPong(path: Message[], byId: Map<string, Participant>, found: Map<string, Finding>, localFunctions?: (classKey: string) => boolean): void {
  // layer runs: [layer, first message that entered it]
  const runs: { layer: string; at: Message }[] = [];
  for (const m of path) {
    if (m.isLibrary) continue;
    // FR-19.16 a lambda / function drawn back to its writer: control is back in the writer's layer — no step back
    // (the runs go on from where that layer was)
    if (m.viaLambda || m.viaParameter !== undefined) {
      const layer = byId.get(m.to)?.layer;
      const at = runs.map((r) => r.layer).lastIndexOf(layer ?? '');
      if (at >= 0) runs.splice(at + 1);
      continue;
    }
    if (isCallback(m, byId, localFunctions)) continue;
    // FR-19.19 a creation is no step back: making an inner layer's error / value object is a dependency in the allowed
    // direction, not its logic running again (calls in the constructor are messages of their own and still count)
    if (m.kind === 'create') continue;
    const layer = byId.get(m.to)?.layer;
    if (!layer || runs[runs.length - 1]?.layer === layer) continue;
    runs.push({ layer, at: m });
  }
  for (let i = 0; i + 3 < runs.length; i++) {
    const a = runs[i].layer;
    const b = runs[i + 1].layer;
    if (runs[i + 2].layer !== a || runs[i + 3].layer !== b) continue;
    const key = [a, b].sort().join('|');
    if (found.has(key)) return;
    const from = path.indexOf(runs[i + 1].at);
    const to = path.indexOf(runs[i + 3].at);
    // FR-19.14 the three crossings: who calls whom, where
    const crossings = [runs[i + 1], runs[i + 2], runs[i + 3]].map((r, k) => {
      const m = r.at;
      // a crossing after the first run: there is a message before it on the path, and it has a sender
      const caller = path[path.indexOf(m) - 1];
      const sender = byId.get(m.from!)?.className;
      // a run starts at a drawn participant with a layer
      const receiver = byId.get(m.to)!.className;
      const what = `${sender ? `${sender}.${caller.methodName} calls ` : ''}${receiver}.${m.methodName}`;
      return `${runs[i + k].layer} → ${r.layer}: ${what}${lineOf(m.callSite)}`;
    });
    const at = [runs[i + 1].at, runs[i + 2].at, runs[i + 3].at];
    found.set(key, {
      id: `layer-ping-pong:${key}`,
      kind: 'layer-ping-pong',
      title: `Layer ping-pong: ${a} ↔ ${b}`,
      detail: `One call path goes ${a} → ${b} → ${a} → ${b}: the layers call back and forth — a leaky port or a missing aggregate.`,
      messageIds: path.slice(from, to + 1).map((m) => m.id),
      classKeys: [...new Set(at.flatMap((m) => [m.from!, m.to]).map((pid) => byId.get(pid)?.classKey).filter((k): k is string => !!k))],
      evidence: crossings,
    });
    return;
  }
}

/** Q4: along one path a class is reached again through other classes (A → B → … → A); callbacks excluded. */
function cyclicCollaboration(path: Message[], byId: Map<string, Participant>, found: Map<string, Finding>, localFunctions?: (classKey: string) => boolean): void {
  const steps: { classKey: string; name: string; m: Message }[] = [];
  for (const m of path) {
    const p = byId.get(m.to);
    // library / unknown targets are no dependency
    if (!p || m.isLibrary || p.kind === 'external' || p.kind === 'unknown') continue;
    // FR-19.16 a lambda / function drawn back to its writer (FR-1.11 / FR-1.13): no dependency — control is back in
    // the writer's code, so the chain goes on from where the writer was (its calls are the writer's, not the callee's)
    if (m.viaLambda || m.viaParameter !== undefined) {
      const at = steps.map((x) => x.classKey).lastIndexOf(p.classKey);
      steps.splice(at + 1);
      if (at < 0) steps.push({ classKey: p.classKey, name: p.className, m });
      continue;
    }
    if (steps[steps.length - 1]?.classKey === p.classKey) continue;
    // FR-19.14 / 19.16 inner functions: the own function's helpers, or callbacks it handed out — no dependency
    if (steps.length && localFunctions?.(p.classKey)) continue;
    steps.push({ classKey: p.classKey, name: p.className, m });
  }
  for (let j = 1; j < steps.length; j++) {
    const i = steps.findIndex((s, k) => k < j - 1 && s.classKey === steps[j].classKey);
    if (i < 0) continue;
    const loop = steps.slice(i, j + 1);
    const key = [...new Set(loop.map((s) => s.classKey))].sort().join('|');
    if (found.has(key)) return;
    found.set(key, {
      id: `cyclic-collaboration:${key}`,
      kind: 'cyclic-collaboration',
      title: `Cyclic collaboration: ${loop.map((s) => s.name).join(' → ')}`,
      detail: 'These classes call each other in a cycle; each depends on the other. Break it with an interface, an event or a callback.',
      // a step after the first: there is a message before it on the path
      evidence: loop.slice(1).map((s, k) => `${loop[k].name} → ${s.name}: ${path[path.indexOf(s.m) - 1].methodName} calls ${s.m.methodName}${lineOf(s.m.callSite)}`),
      // the whole call chain of the cooperation (A → B, B's inner calls, … → A), not only the hops
      messageIds: path.slice(path.indexOf(loop[1].m), path.indexOf(loop[loop.length - 1].m) + 1).map((m) => m.id),
      classKeys: [...new Set(loop.map((s) => s.classKey))],
    });
    return;
  }
}

export interface ClassFindingsInput {
  classes: ClassNode[];
  relations: ClassRelation[];
  /** Injected dependencies per class key (constructor / promoted / DI fields with a class type). */
  injected: (classKey: string) => string[];
  /** A relation drawn only from callbacks (a function passed as a parameter, FR-1.13): no dependency of its own. */
  callbackOnly?: (relation: ClassRelation) => boolean;
  /** FR-19.14 «locals»: the inner functions of one function (TS) — part of that function, no class of their own. */
  localFunctions?: (classKey: string) => boolean;
  ignored?: (name: string) => boolean;
  maxDependencies?: number;
  disabled?: ReadonlySet<string>;
  /** FR-19.11 a class's size: undefined = unknown (no god-class check). */
  size?: (classKey: string) => ClassSize | undefined;
  godClass?: { methods?: number; lines?: number; fields?: number; dependencies?: number };
}

/** FR-19.11 what makes a class big. */
export interface ClassSize {
  /** Instance methods. */
  methods: number;
  /** Non-blank lines of its file (undefined when unreadable). */
  lines?: number;
  fields: number;
  /** Injected dependencies (constructor parameters). */
  dependencies: number;
  /** An Active Record model (big by design) that is not checked. */
  exempt?: boolean;
}

/** FR-19.11 defaults: on real projects they name only a few classes. */
export const GOD_CLASS_DEFAULTS = { methods: 20, lines: 500, fields: 10, dependencies: 7 };

/** Relations that make one class depend on another (not inheritance / realization). */
const DEPENDS: ReadonlySet<string> = new Set(['association', 'dependency', 'use']);

export function classFindings(input: ClassFindingsInput): Finding[] {
  const out: Finding[] = [];
  const off = (k: FindingKind) => input.disabled?.has(k) ?? false;
  const names = new Map(input.classes.map((c) => [c.key, c.name]));

  // Q10 dependency cycles among the visible classes (strongly connected components, Tarjan)
  if (!off('dependency-cycle')) {
    // FR-19.14 / 19.16 calls into inner functions («locals»: the own function's helpers, or callbacks it handed out) are no dependency
    const ownLocals = (r: ClassRelation) => !!input.localFunctions?.(r.to);
    const edges = input.relations.filter((r) => DEPENDS.has(r.kind) && r.from !== r.to && names.has(r.from) && names.has(r.to) && !input.callbackOnly?.(r) && !ownLocals(r));
    const byKey = new Map(input.classes.map((c) => [c.key, c]));
    for (const scc of stronglyConnected([...names.keys()], edges)) {
      if (scc.length < 2) continue;
      const inside = new Set(scc);
      const rels = edges.filter((r) => inside.has(r.from) && inside.has(r.to));
      // Tarjan gives an SCC in DFS discovery order: each class follows an edge from the one before where it can
      const order = scc;
      out.push({
        id: `dependency-cycle:${[...scc].sort().join('|')}`,
        kind: 'dependency-cycle',
        title: `Dependency cycle: ${[...order, order[0]].map((k) => names.get(k)).join(' → ')}`,
        detail: `${scc.length} classes depend on each other: none can change, be tested or be reused alone.`,
        classKeys: scc,
        relationIds: rels.map((r) => r.id),
        evidence: [
          ...order.map((k) => classLine(byKey.get(k)!)),
          ...order.flatMap((k, i) => {
            const to = order[(i + 1) % order.length];
            const why = rels.filter((r) => r.from === k && r.to === to).flatMap(relationReasons);
            return why.length ? [`${names.get(k)} → ${names.get(to)}: ${why.join('; ')}`] : [];
          }),
        ],
      });
    }
  }

  // Q11 too many injected dependencies: a single-responsibility smell
  if (!off('too-many-dependencies')) {
    const max = input.maxDependencies ?? 6;
    for (const c of input.classes) {
      const deps = input.injected(c.key);
      if (deps.length <= max || input.ignored?.(c.name)) continue;
      out.push({
        id: `too-many-dependencies:${c.key}`,
        kind: 'too-many-dependencies',
        title: `Too many dependencies: ${c.name} (${deps.length} injected)`,
        ignoreKey: c.name,
        detail: `More than ${max} collaborators (${deps.slice(0, 8).join(', ')}${deps.length > 8 ? ', …' : ''}): the class probably does several jobs.`,
        classKeys: [c.key],
      });
    }
  }
  // FR-19.11 god class: many methods, a long file, and much state or many collaborators — all three
  if (!off('god-class') && input.size) {
    const t = { ...GOD_CLASS_DEFAULTS, ...input.godClass };
    for (const c of input.classes) {
      const s = input.size(c.key);
      if (!s || s.exempt || input.ignored?.(c.name)) continue;
      const big = s.methods >= t.methods && (s.lines ?? 0) >= t.lines && (s.fields >= t.fields || s.dependencies >= t.dependencies);
      if (!big) continue;
      const state = [s.fields >= t.fields ? `${s.fields} fields` : '', s.dependencies >= t.dependencies ? `${s.dependencies} injected dependencies` : ''].filter(Boolean).join(', ');
      out.push({
        id: `god-class:${c.key}`,
        kind: 'god-class',
        title: `God class: ${c.name} (${s.methods} methods, ${s.lines} lines)`,
        ignoreKey: c.name,
        detail: `${s.methods} methods, ${s.lines} lines in its file, ${state}: it knows and does too much — most changes touch it.`,
        classKeys: [c.key],
      });
    }
  }
  return out;
}

/**
 * FR-19.17 a flow finding on the class diagram too: its classes that are drawn, and the relations its calls made
 * (layer ping-pong: only the ones between layers, its crossings).
 */
export function withClassEvidence(f: Finding, classes: ClassNode[], relations: ClassRelation[]): Finding {
  const layerOf = new Map(classes.map((c) => [c.key, c.layer]));
  const ids = new Set(f.messageIds);
  const crossing = (r: ClassRelation) => f.kind !== 'layer-ping-pong' || layerOf.get(r.from) !== layerOf.get(r.to);
  const relationIds = relations.filter((r) => crossing(r) && r.calls?.some((c) => ids.has(c.messageId))).map((r) => r.id);
  const classKeys = (f.classKeys ?? []).filter((k) => layerOf.has(k));
  return { ...f, ...(classKeys.length ? { classKeys } : {}), ...(relationIds.length ? { relationIds } : {}) };
}

/**
 * FR-19.17 one problem, one issue: a cyclic collaboration among the same classes as a dependency cycle is that cycle
 * seen in the flow — the dependency cycle stays (with the collaboration's call chain as its messages).
 */
export function mergeCycles(flow: Finding[], classLevel: Finding[]): Finding[] {
  const same = (a: Finding, b: Finding) => [...(a.classKeys ?? [])].sort().join('|') === [...(b.classKeys ?? [])].sort().join('|');
  const cycles = classLevel.map((c) => {
    if (c.kind !== 'dependency-cycle') return c;
    const chain = flow.find((f) => f.kind === 'cyclic-collaboration' && same(f, c));
    return chain?.messageIds?.length ? { ...c, messageIds: chain.messageIds } : c;
  });
  const covered = (f: Finding) => f.kind === 'cyclic-collaboration' && classLevel.some((c) => c.kind === 'dependency-cycle' && same(f, c));
  return [...flow.filter((f) => !covered(f)), ...cycles];
}

/** FR-19.17 a class finding on the sequence diagram too: the calls (and type uses) behind its relations. */
export function withMessageEvidence(f: Finding, relations: ClassRelation[]): Finding {
  const ids = new Set(f.relationIds ?? []);
  const messageIds = [...new Set(relations.filter((r) => ids.has(r.id)).flatMap(relationMessages))];
  return messageIds.length ? { ...f, messageIds } : f;
}

const relationMessages = (r: ClassRelation): string[] =>
  r.kind === 'use' ? (r.uses ?? []).flatMap((u) => (u.messageId ? [u.messageId] : [])) : (r.calls ?? []).map((c) => c.messageId);

/**
 * issues are judged on the calls, fields and «create»s of a flow, never on its type uses — the Uses toggle
 * (FR-12.12) only draws more of the class diagram. Otherwise a flow's ⚠ N, the project scan, the map and the branch
 * review would each count differently.
 */
export function withoutTypeUses<T extends { classes: ClassNode[]; relations: ClassRelation[] }>(cd: T): { classes: ClassNode[]; relations: ClassRelation[] } {
  const usedOnly = new Set(cd.classes.filter((c) => c.usedOnly).map((c) => c.key));
  if (!usedOnly.size && !cd.relations.some((r) => r.kind === 'use')) return cd;
  return {
    classes: cd.classes.filter((c) => !usedOnly.has(c.key)),
    relations: cd.relations.filter((r) => r.kind !== 'use' && !usedOnly.has(r.from) && !usedOnly.has(r.to)),
  };
}

/**
 * FR-19.17 the dependency-rule violations of a flow (the class diagram's red relations) as issues, for both diagrams:
 * the two classes, the relation, the calls / type uses behind it, and what closes it.
 */
export function layerViolationFindings(classes: ClassNode[], relations: ClassRelation[]): Finding[] {
  const byKey = new Map(classes.map((c) => [c.key, c]));
  const name = (key: string) => byKey.get(key)?.name ?? key.replace(/^.*#/, '');
  // one issue per class pair (a call and a «create» of the same pair are one issue, as on the map)
  const pairs = new Map<string, ClassRelation[]>();
  for (const r of relations.filter((x) => x.violation)) {
    const k = `${r.from}\u0000${r.to}`;
    pairs.set(k, [...(pairs.get(k) ?? []), r]);
  }
  return [...pairs.values()].map((rs) => {
    const r = rs[0];
    const messageIds = [...new Set(rs.flatMap(relationMessages))];
    const why = [...new Set(rs.flatMap(relationReasons))];
    return {
      id: `layer-violation:${r.id}`,
      kind: 'layer-violation' as const,
      title: `Layer violation: ${name(r.from)} → ${name(r.to)}`,
      detail: r.violation,
      // FR-7.16 a pair's relations have the same two classes, so the same guesses
      ...(r.possible ? { possible: r.possible } : {}),
      ...(messageIds.length ? { messageIds } : {}),
      classKeys: [r.from, r.to],
      relationIds: rs.map((x) => x.id),
      evidence: [
        `${name(r.from)}: ${byKey.get(r.from)?.layer ?? '?'}`,
        `${name(r.to)}: ${byKey.get(r.to)?.layer ?? '?'}`,
        // every relation has a reason (relationReasons falls back to its label or kind)
        `${name(r.from)} → ${name(r.to)}: ${why.join('; ')}`,
        // FR-7.16 the guessed layers it rests on
        ...(r.possible ?? []),
      ],
    };
  });
}

/**
 * FR-19.14 what a class of a cycle is: `name: class in src/a.ts`, `name: the top-level functions of src/a.ts`. (Inner
 * functions are never in a cycle: calls into them are no edges, so nothing in a cycle depends on them.)
 */
function classLine(c: ClassNode): string {
  const file = fileOf(c.key);
  const what = c.kind === 'module' ? `the top-level functions of ${file}` : `${c.kind === 'interface' ? 'interface' : c.kind === 'abstract' ? 'abstract class' : 'class'} in ${file}`;
  return `${c.name}: ${what}`;
}

/** FR-19.14 why one class depends on the other: its calls, its field, its «create», its type uses (a few, with lines). */
function relationReasons(r: ClassRelation): string[] {
  const few = <T>(xs: T[], f: (x: T) => string) => [...new Set(xs.map(f))].slice(0, 3).concat(xs.length > 3 ? [`… ${xs.length - 3} more`] : []);
  if (r.kind === 'association') return [`holds it in the field ${r.label ?? '?'}`];
  if (r.calls?.length) {
    const create = r.label === '«create»';
    return few(r.calls, (c) => `${create ? c.label.replace(/ → .*$/, ' creates it') : c.label.replace(' → ', ' calls ')}${lineOf(c.callSite)}`);
  }
  if (r.uses?.length) return few(r.uses, (u) => `${u.method} uses the type${lineOf(u.range)}`);
  return [r.label ?? r.kind];
}

/** Tarjan's strongly connected components (iteration order of `nodes` kept for stable output). */
export function stronglyConnected(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const connect = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!idx.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      out.push(scc.reverse());
    }
  };
  for (const v of nodes) if (!idx.has(v)) connect(v);
  return out;
}
