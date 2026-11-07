import type { ClassDiagram, ClassMember, ClassNode, ClassRef, ClassRelation, LayerReason, Message, MethodRef, Participant, RelationKind } from '@seqcall/protocol';
import type { ClassInfo, TypeUse } from './adapter';
import type { Classification } from './classifier';
import type { ParticipantMeta } from './session/build';
import { cutFrom, trimEndChar } from './text';

export interface ClassDiagramInput {
  participants: Participant[];
  messages: Message[];
  participantMeta: Map<string, ParticipantMeta>;
  classInfo: (classKey: string) => ClassInfo | undefined;
  /** Stereotypes/layer/namespace for classes that are not participants themselves (interfaces behind a chosen implementation). */
  classify?: (classKey: string) => Classification | undefined;
  /** Architectural layer order (lanes). */
  layerOrder?: string[];
  /** Dependency-rule ring of a layer (0 = innermost); undefined = unchecked. */
  layerRing?: (layer: string) => number | undefined;
  /** "all" keeps obvious association names visible (default: mark them obvious). */
  associationNames?: 'non-obvious' | 'all';
  /** FR-12.12: type uses of the shown methods; absent = type uses are not shown. */
  typeUses?: MethodTypeUses[];
  /** Classification of a used type that is not otherwise in the diagram (FR-12.12). */
  classifyRef?: (ref: ClassRef) => Classification | undefined;
  /** Classes hidden by a filter (FR-11.6): never added as used-only classes. */
  isHiddenClass?: (classKey: string, ref: ClassRef) => boolean;
}

/** FR-12.12: the types one shown method references. */
export interface MethodTypeUses {
  method: MethodRef;
  /** Class the method is listed under (the participant's class, e.g. a subclass running an inherited method); default: its owner. */
  classKey?: string;
  /** A visible message that runs the method ("root" for the root). */
  messageId?: string;
  uses: TypeUse[];
}

/**
 * A field name is obvious when, without naming-convention decorations, it equals the type
 * name: `_coupon: Coupon`, `_couponStore: ICouponStore`, `userService:
 * UserService`, `$repo: Repo`. Language-neutral: strips leading `_`, `m_`, `#`, `$`, trailing
 * `_`, generic arguments and a C#-style `I` interface prefix; case-insensitive.
 */
export function isObviousFieldName(field: string, typeName: string): boolean {
  const f = trimEndChar(field.replace(/^(this\.)?(m_|[_#$]+)/, ''), '_').toLowerCase();
  const t = cutFrom(typeName, '<').replace(/`\d+$/, '');
  const bare = /^I[A-Z]/.test(t) ? t.slice(1) : t;
  return !!f && (f === bare.toLowerCase() || f === t.toLowerCase());
}

/**
 * FR-12: class diagram of exactly the classes visible in the (filtered) sequence diagram.
 * Members = methods appearing as visible messages (+ constructor for created classes).
 */
/**
 * FR-19.18 a method of another class handed in as a function (`Query(sql, Readers.ReadOrder)`) and run
 * through the parameter: the receiver depends on its own parameter only, but the class that wrote the reference — the
 * sender of the call that handed it over — depends on the method's class. A lambda, or a method of the writer itself,
 * gives none. Shared by the class diagram and the objects' layer violations (FR-19.17: both diagrams alike).
 */
export function methodGroupWriter<P extends { classKey: string }>(m: Message, messageById: (id: string) => Message | undefined, participantById: (id: string) => P | undefined): P | undefined {
  if (m.viaParameter === undefined || m.port || m.viaLambda || !m.methodKey || !m.parentId || m.kind !== 'call') return undefined;
  // the sender of the call that handed it over: a call inside the diagram, never the found message (the root method's
  // own parameters are not bound), so it has one. A method of the writer's own class (`this.shout`) or a target that is
  // not drawn: every caller checks the target and draws no relation of a class to itself.
  return participantById(handingCall(m, messageById)?.from as string);
}

/** The call that handed the method over (`render(users, UserFormat.plain)`; passed on through `each(xs, f)`: `render`). */
export function handingCall(m: Message, messageById: (id: string) => Message | undefined): Message | undefined {
  return messageById(m.handedBy!);
}

/**
 * FR-7.16 the ends of a violation whose layer is a guess (a weak rule decided it: a name, a role folder, the code's
 * evidence, a preset's fallback), one line each: the violation is only possible. Empty = both layers are certain.
 */
export function guessedLayers(ends: { name: string; layer?: string; layerReason?: LayerReason }[]): string[] {
  return ends.flatMap((e) => (e.layerReason?.strength === 'weak' ? [`\`${e.name}\` is ${e.layer} by a guess: ${e.layerReason.text}`] : []));
}

/**
 * FR-7.16 an edge merging broken relations is only possible when every one of them is: one certain violation makes it
 * certain. Its lines: the guesses, without repeats.
 */
export function possibleOf(broken: ClassRelation[]): { possible?: string[] } {
  return broken.length && broken.every((r) => r.possible) ? { possible: [...new Set(broken.flatMap((r) => r.possible!))] } : {};
}

export function deriveClassDiagram(input: ClassDiagramInput): ClassDiagram {
  const { participants, messages, participantMeta, classInfo } = input;
  const byId = new Map(participants.map((p) => [p.id, p]));
  const isVisibleClass = (p: Participant | undefined): p is Participant =>
    !!p && p.kind !== 'external' && p.kind !== 'unknown';

  // ── classes ──
  const nodes = new Map<string, ClassNode>();
  for (const p of participants) {
    if (!isVisibleClass(p)) continue;
    const existing = nodes.get(p.classKey);
    if (existing) {
      for (const s of p.stereotypes) if (!existing.stereotypes.includes(s)) existing.stereotypes.push(s);
      // FR-7.9 the reasons of stereotypes another object of the class added
      for (const r of p.stereotypeReasons ?? []) {
        if (!existing.stereotypeReasons?.some((x) => x.stereotype === r.stereotype)) (existing.stereotypeReasons ??= []).push(r);
      }
      continue;
    }
    nodes.set(p.classKey, {
      key: p.classKey,
      name: p.className,
      kind: p.kind,
      stereotypes: [...p.stereotypes],
      layer: p.layer,
      ...(p.layerReason ? { layerReason: p.layerReason } : {}),
      ...(p.stereotypeReasons ? { stereotypeReasons: [...p.stereotypeReasons] } : {}),
      namespace: p.namespace,
      methods: [],
      declaration: p.declaration,
      layerHint: p.layerHint,
    });
  }

  // Interfaces/abstract classes reached through a chosen implementation (FR-8.2) are part of
  // the interaction: the client depends on the interface, the implementation realizes it.
  const viaInterface = (p: Participant): string | undefined => p.implementsInterface?.key;
  for (const p of participants) {
    const iface = p.implementsInterface;
    if (!isVisibleClass(p) || !iface || nodes.has(iface.key)) continue;
    const info = classInfo(iface.key);
    const c = input.classify?.(iface.key);
    const kind = info?.ref.kind === 'abstract' ? 'abstract' : 'interface';
    nodes.set(iface.key, {
      key: iface.key,
      name: iface.name,
      kind,
      stereotypes: c?.stereotypes ?? [kind],
      layer: c?.layer,
      ...(c?.layerReason ? { layerReason: c.layerReason } : {}),
      ...(c?.stereotypeReasons ? { stereotypeReasons: c.stereotypeReasons } : {}),
      namespace: c?.namespace ?? p.namespace,
      methods: [],
      declaration: info?.ref.declaration,
    });
  }

  // FR-1.13: ports invoked as function parameters (`listBranches: BranchLister`)
  for (const m of messages) {
    const to = byId.get(m.to);
    if (!m.port || !isVisibleClass(to) || nodes.has(m.port.key)) continue;
    const info = classInfo(m.port.key);
    const c = input.classify?.(m.port.key);
    nodes.set(m.port.key, {
      key: m.port.key,
      name: m.port.name,
      kind: 'interface',
      stereotypes: c?.stereotypes ?? ['interface'],
      layer: c?.layer,
      ...(c?.layerReason ? { layerReason: c.layerReason } : {}),
      ...(c?.stereotypeReasons ? { stereotypeReasons: c.stereotypeReasons } : {}),
      namespace: c?.namespace ?? '',
      methods: [],
      declaration: info?.ref.declaration,
    });
  }
  // FR-5.11 a base class whose method a shown object runs: its box (and those between it and the object's class)
  const addBaseClasses = (objectKey: string, baseKey: string, near: Participant): void => {
    let key = classInfo(objectKey)?.extends?.key;
    for (let depth = 0; key && depth < 8; depth++) {
      if (!nodes.has(key)) {
        const info = classInfo(key);
        const c = input.classify?.(key);
        const kind = info?.ref.kind === 'abstract' ? 'abstract' : 'class';
        nodes.set(key, {
          key,
          name: info?.ref.name ?? key.replace(/^.*#/, ''),
          kind,
          stereotypes: c?.stereotypes ?? (kind === 'abstract' ? ['abstract'] : []),
          layer: c?.layer,
          ...(c?.layerReason ? { layerReason: c.layerReason } : {}),
          ...(c?.stereotypeReasons ? { stereotypeReasons: c.stereotypeReasons } : {}),
          namespace: c?.namespace ?? near.namespace,
          methods: [],
          declaration: info?.ref.declaration,
        });
      }
      if (key === baseKey) return;
      key = classInfo(key)?.extends?.key;
    }
  };
  for (const m of messages) {
    const to = byId.get(m.to);
    if (m.inheritedFrom && isVisibleClass(to)) addBaseClasses(to.classKey, m.inheritedFrom.key, to);
  }
  const targetOf = (m: Message, to: Participant): string => m.port?.key ?? viaInterface(to) ?? to.classKey;
  /**
   * FR-1.13 a function the sender was handed with an inline type (`operation: () => Promise<T>`): the sender depends
   * only on its own parameter's type, a port it declares itself — no dependency on the code behind it (the lambda's
   * writer realizes it). Named function types are ports (`m.port`), drawn as such.
   */
  const inlinePort = (m: Message): boolean => m.viaParameter !== undefined && !m.port;

  // ── members ──
  const members = new Map<string, ClassMember>();
  /** FR-12.13: every row knows the messages that run it and (on the class that runs it) its definition. */
  const addMember = (node: ClassNode, name: string, p: Participant, m: Message, own: boolean): void => {
    const seenKey = `${node.key}.${name}`;
    let member = members.get(seenKey);
    if (!member) {
      member = memberOf(classInfo(node.key), name, p);
      members.set(seenKey, member);
      node.methods.push(member);
    }
    if (own && !member.declaration && m.targetDeclaration) member.declaration = m.targetDeclaration;
    (member.calls ??= []).push({ messageId: m.id, label: callerLabel(m), ...(m.callSite ? { callSite: m.callSite } : {}) });
  };
  const byMessage = new Map(messages.map((x) => [x.id, x]));
  /** "from UserService.findUser" — the method whose body makes the call ("from root" for the root's own calls). */
  const callerLabel = (m: Message): string => {
    const parent = m.parentId ? byMessage.get(m.parentId) : undefined;
    const sender = m.from ? byId.get(m.from) : undefined;
    if (!parent) return 'diagram root';
    return `from ${sender?.className ?? parent.className ?? '?'}.${parent.kind === 'create' ? 'constructor' : parent.methodName}`;
  };
  for (const m of messages) {
    const to = byId.get(m.to);
    if (!isVisibleClass(to) || !m.methodKey) continue;
    const name = m.kind === 'create' ? 'constructor' : m.methodName;
    // FR-5.11 an inherited method is listed in the base class that declares it (the object's class only inherits it)
    addMember(nodes.get((m.inheritedFrom && nodes.get(m.inheritedFrom.key)?.key) || to.classKey)!, name, to, m, true);
    // The interface declares what is called through it (a port: the parameter that is invoked).
    if (m.port && m.kind !== 'create') addMember(nodes.get(m.port.key)!, m.viaParameter ?? name, to, m, false);
    // only what others call on the object goes through the interface: its own (self / ↑ inherited) calls do not
    const iface = m.from !== m.to && !m.inheritedFrom ? viaInterface(to) : undefined;
    if (!m.port && iface && m.kind !== 'create') addMember(nodes.get(iface)!, name, to, m, false);
  }

  // Methods of the class that are not part of the visible interaction (tooltip only).
  for (const node of nodes.values()) {
    const all = classInfo(node.key)?.methods ?? [];
    const shown = new Set(node.methods.map((m) => m.name));
    const other = new Set(all.map((m) => m.name).filter((n) => !shown.has(n) && n !== 'constructor')).size;
    if (other) node.otherMethodCount = other;
  }

  // ── relations ──
  const relations = new Map<string, ClassRelation>();
  const add = (kind: RelationKind, from: string, to: string, label?: string): void => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    const id = `${kind}:${from}->${to}${label ? `:${label}` : ''}`;
    if (!relations.has(id)) relations.set(id, { id, kind, from, to, label });
  };

  for (const node of nodes.values()) {
    const info = classInfo(node.key);
    if (!info) continue;
    if (info.extends) add('generalization', node.key, info.extends.key);
    for (const i of info.implements) add('realization', node.key, i.key);
    for (const f of info.fields) {
      if (!f.type) continue;
      add('association', node.key, f.type.key, f.name);
      // FR-12.15 a collection field: an aggregation of many
      const r = relations.get(`association:${node.key}->${f.type.key}:${f.name}`);
      if (r && f.collection) Object.assign(r, { aggregation: true, multiplicity: '*' });
    }
  }

  // Field-based associations to the participant actually drawn. A field reached through an
  // interface points at the interface (that is the declared type), not the implementation.
  for (const p of participants) {
    const meta = participantMeta.get(p.id);
    if (meta?.origin?.kind === 'field' && meta.senderClassKey) {
      add('association', meta.senderClassKey, viaInterface(p) ?? p.classKey, meta.origin.name);
    }
    const iface = viaInterface(p);
    // An abstract base class is extended (generalization), an interface is realized.
    if (isVisibleClass(p) && iface) add(nodes.get(iface)?.kind === 'abstract' ? 'generalization' : 'realization', p.classKey, iface);
  }

  const associated = (from: string, to: string): boolean =>
    [...relations.values()].some((r) => r.kind === 'association' && r.from === from && r.to === to);

  const byMsgId = new Map(messages.map((m) => [m.id, m]));
  // the method a call is made from ('?' for the root, or a caller not in the list)
  const callerName = (m: Message) => (m.parentId && byMsgId.get(m.parentId)?.methodName) || '?';
  const writerOf = (m: Message) => methodGroupWriter(m, (id) => byMsgId.get(id), (id) => byId.get(id));
  for (const m of messages) {
    if (m.kind !== 'call' && m.kind !== 'create') continue;
    // a call or creation always has a sender (only the found message has none)
    const from = byId.get(m.from!);
    const to = byId.get(m.to);
    if (inlinePort(m)) {
      // the receiver depends on its parameter only; the writer of a method reference on the method's class
      const writer = writerOf(m);
      if (isVisibleClass(writer) && isVisibleClass(to)) add('dependency', writer.classKey, to.classKey);
      continue;
    }
    if (!isVisibleClass(from) || !isVisibleClass(to) || from.classKey === to.classKey) continue;
    if (m.kind === 'create') {
      add('dependency', from.classKey, to.classKey, '«create»');
      continue;
    }
    const target = targetOf(m, to);
    if (target !== from.classKey && !associated(from.classKey, target)) add('dependency', from.classKey, target);
    if (m.port && to.classKey !== m.port.key) add('realization', to.classKey, m.port.key);
  }

  // Each dependency/association knows the visible calls behind it (a relation summarises
  // possibly many calls); the class view uses them to highlight messages and jump to code.
  for (const r of relations.values()) {
    if (r.kind === 'realization' || r.kind === 'generalization') continue;
    const create = r.label === '«create»';
    // a method reference handed over: the writer's call that hands it over, at its own line
    const handed = (m: Message) => (inlinePort(m) && !create && r.kind === 'dependency' && writerOf(m)?.classKey === r.from && byId.get(m.to)?.classKey === r.to ? handingCall(m, (id) => byMsgId.get(id)) : undefined);
    r.calls = messages
      .filter((m) => {
        if (handed(m)) return true;
        if (m.kind !== (create ? 'create' : 'call') || inlinePort(m)) return false;
        const from = byId.get(m.from!);
        const to = byId.get(m.to);
        if (!from || !to || from.classKey !== r.from) return false;
        if ((create ? to.classKey : targetOf(m, to)) !== r.to) return false;
        // A field association only covers the calls made through that field.
        if (r.kind === 'association' && r.label) {
          const origin = participantMeta.get(to.id)?.origin;
          if (origin?.kind === 'field' && origin.name !== r.label) return false;
        }
        return true;
      })
      .map((m) => {
        const via = handed(m);
        if (via) return { messageId: m.id, label: `${callerName(via)} → ${m.methodName}`, callSite: via.callSite };
        return {
          messageId: m.id,
          label: `${callerName(m)} → ${create ? `new ${m.className ?? ''}`.trim() : m.methodName}`,
          callSite: m.callSite,
        };
      });
  }

  // FR-12.12: a shown method that references a type without calling it (an enum constant, a
  // signature type, a cast …) still depends on it. Only where no other relation says so already.
  if (input.typeUses) {
    const related = (from: string, to: string): boolean =>
      [...relations.values()].some((r) => r.kind !== 'use' && r.from === from && r.to === to);
    for (const mu of input.typeUses) {
      const from = mu.classKey ?? mu.method.owner.key;
      if (!nodes.has(from)) continue;
      const info = classInfo(from);
      for (const u of mu.uses) {
        const to = u.type.key;
        if (to === from || to === 'unknown' || to.startsWith('lib:') || related(from, to)) continue;
        if (input.isHiddenClass?.(to, u.type)) continue;
        // the class's own base type / interface: that relation, not a use
        const inheritance = info?.extends?.key === to ? 'generalization' : info?.implements.some((i) => i.key === to) ? 'realization' : undefined;
        if (!nodes.has(to)) {
          const c = input.classifyRef?.(u.type);
          nodes.set(to, {
            key: to,
            name: u.type.name,
            kind: u.type.kind,
            stereotypes: c?.stereotypes ?? [],
            layer: c?.layer,
            ...(c?.layerReason ? { layerReason: c.layerReason } : {}),
            ...(c?.stereotypeReasons ? { stereotypeReasons: c.stereotypeReasons } : {}),
            namespace: c?.namespace ?? '',
            methods: [],
            declaration: u.type.declaration ?? classInfo(to)?.ref.declaration,
            usedOnly: true,
          });
          const n = new Set((classInfo(to)?.methods ?? []).map((m) => m.name).filter((x) => x !== 'constructor')).size;
          if (n) nodes.get(to)!.otherMethodCount = n;
        }
        if (inheritance) {
          add(inheritance, from, to);
          continue;
        }
        const id = `use:${from}->${to}`;
        let r = relations.get(id);
        if (!r) relations.set(id, (r = { id, kind: 'use', from, to, uses: [] }));
        r.uses!.push({ method: `${mu.method.owner.name}.${mu.method.name}`, range: u.range, ...(mu.messageId ? { messageId: mu.messageId } : {}) });
      }
    }
  }

  if (input.associationNames !== 'all') {
    for (const r of relations.values()) {
      // add() keeps relations between boxes only
      if (r.kind === 'association' && r.label && isObviousFieldName(r.label, nodes.get(r.to)!.name)) r.labelObvious = true;
    }
  }

  // Dependency rule: an inner layer must not depend on an outer one (ring numbers, 0 = innermost).
  const ring = input.layerRing;
  if (ring) {
    for (const r of relations.values()) {
      const a = nodes.get(r.from)?.layer;
      const b = nodes.get(r.to)?.layer;
      if (!a || !b || a === b) continue;
      const ra = ring(a);
      const rb = ring(b);
      if (ra === undefined || rb === undefined || rb <= ra) continue;
      r.violation = `${a} → ${b}: an inner layer depends on an outer layer`;
      const possible = guessedLayers([nodes.get(r.from)!, nodes.get(r.to)!]);
      if (possible.length) r.possible = possible;
    }
  }

  const present = new Set([...nodes.values()].flatMap((n) => (n.layer ? [n.layer] : [])));
  const order = input.layerOrder ?? [];
  const layers = [...order.filter((l) => present.has(l)), ...[...present].filter((l) => !order.includes(l)).sort()];
  return { classes: [...nodes.values()], relations: [...relations.values()], layers, ...(input.typeUses ? { typeUses: true } : {}) };
}

function memberOf(info: ClassInfo | undefined, name: string, p: Participant): ClassMember {
  const method = info?.methods.find((x) => x.name === name);
  if (method) return { name, isStatic: method.isStatic, signature: method.signature, ...(method.visibility ? { visibility: method.visibility } : {}) };
  return { name, isStatic: p.stereotypes.includes('static') && name !== 'constructor', signature: `${name}()` };
}
