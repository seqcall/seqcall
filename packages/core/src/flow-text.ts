import type { ClassDiagram, ClassMember, ClassNode, ClassRelation, EntryPoint, Finding, Fragment, HideFilter, Message, MethodRef, SequenceDiagram, SourceRange } from '@seqcall/protocol';

/**
 * FR-27 / FR-25.4 a flow as plain data and as an indented text tree with file:line: the CLI's and the MCP server's
 * `flow` (FR-27.2) and the panels' Share → Copy as text (FR-25.4) — the same format, so an agent reads both alike.
 */

export interface Issue {
  /** Stable across runs: kind + what it is about (silencing key or classes). */
  id: string;
  kind: Finding['kind'];
  /** `possible`: the I/O is only further down, behind calls that may be cached — check the code. */
  certainty: 'definite' | 'possible';
  title: string;
  detail?: string;
  /** Lines of the concrete case (cycle steps, crossings). */
  evidence?: string[];
  /** Where the evidence calls are (file:line). */
  at?: string[];
  /** I/O in a loop: the loop (`loop [each o in orders] @ src/x.cs:562`). */
  loop?: string;
  classes?: string[];
}

export const rel = (root: string, file: string) => {
  const f = file.replace(/\\/g, '/');
  return f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f;
};
/** `file:line` of a range, the file relative to the root. */
export const lineOf = (root: string, r: SourceRange) => `${rel(root, r.file)}:${r.start.line + 1}`;
export const where = (root: string, r: SourceRange | undefined) => (r ? lineOf(root, r) : undefined);
export const nameOfKey = (key: string) => key.slice(key.indexOf('#') + 1);
export const methodLabel = (m: MethodRef) => (m.owner.name && m.owner.name !== m.name ? `${m.owner.name}.${m.name}` : m.name);
export const entryLabel = (e: EntryPoint) => e.label;

export function stableIssueId(f: Finding): string {
  const about = f.ignoreKey ?? [...(f.classKeys ?? [])].map(nameOfKey).sort((a, b) => a.localeCompare(b)).join(',');
  return `${f.kind}:${about || f.title}`;
}

export function toIssue(root: string, f: Finding, messages: Message[] = [], loopOf?: (messageId: string) => string | undefined): Issue {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const at = [...new Set((f.messageIds ?? []).map((id) => where(root, byId.get(id)?.callSite)).filter((x): x is string => !!x))];
  return {
    id: stableIssueId(f),
    kind: f.kind,
    // FR-7.16 a layer violation resting on a guessed layer
    certainty: /^Possible /.test(f.title) || f.possible ? 'possible' : 'definite',
    title: f.title,
    ...(f.detail ? { detail: f.detail } : {}),
    ...(f.evidence?.length ? { evidence: f.evidence } : {}),
    ...(at.length ? { at } : {}),
    ...(f.kind === 'io-in-loop' && f.messageIds?.[0] && loopOf?.(f.messageIds[0]) ? { loop: loopOf(f.messageIds[0]) } : {}),
    ...(f.classKeys?.length ? { classes: f.classKeys.map(nameOfKey) } : {}),
  };
}

// ───────────────────────────── flow ─────────────────────────────

export interface FlowCall {
  /** Call path, stable across edits elsewhere (`root/2:findUser/0:findById`). */
  id: string;
  depth: number;
  /** `Class.method` as called (`«create» Class` for a constructor). */
  call: string;
  args: string[];
  methodKey?: string;
  at?: string;
  layer?: string;
  /**
   * Remote / local I/O of the called method; `below`: only further down; `partOf`: the call is inside a call doing the
   * same I/O (a row reader called by the query): one I/O, not two.
   */
  io?: { kinds: string[]; below?: boolean; partOf?: string; evidence: string[] };
  async?: boolean;
  library?: boolean;
  /** Why it could not be resolved (dynamic call, missing type). */
  unresolved?: string;
  /** Not opened: the calls inside are not listed (limit, recursion, or `--depth`). */
  folded?: boolean;
  recursive?: boolean;
  /** An interface call: its implementations, and the one drawn (DI binding or the only one). */
  implementations?: { names: string[]; drawn?: string };
  /** Enclosing frames, outer first, with where they are: `loop [each o of orders] @ src/x.ts:12`, `alt [user == null] @ …`. */
  frames?: string[];
}

/** One I/O of the flow: the calls doing I/O themselves (not those inside one doing the same), folded calls with I/O below. */
export interface FlowIo {
  kinds: string[];
  call: string;
  id: string;
  at?: string;
  /** The methods called on the way, from the flow's method down to the call. */
  via: string[];
  /** Inside a loop over a collection (FR-19.1) — once per element. */
  inLoop?: boolean;
  /** Inside a loop, but after it the loop ends (`return await …`): at most once per loop. */
  onceInLoop?: boolean;
  /** In work handed off to run later (a dataflow block, FR-17.7), not during the call. */
  later?: boolean;
  /** Only further down, in calls not shown (folded, or an interface call with several implementations and none chosen). */
  below?: boolean;
}

export interface FlowResult {
  method: { key: string; label: string; at?: string; layer?: string };
  entryPoints: string[];
  /** How many calls the flow has; the calls themselves only with --tree (FR-27.6). */
  callCount: number;
  calls?: FlowCall[];
  io: FlowIo[];
  issues: Issue[];
}

/** Frames (operand ranges in render order) each message is in; an operand spans its first message to the end of its last one's subtree. */
function framesByMessage(d: SequenceDiagram): Map<string, { fragment: Fragment; operand: number }[]> {
  const index = new Map(d.messages.map((m, i) => [m.id, i]));
  const subtreeEnd = (id: string) => {
    let i = index.get(id)!;
    while (i + 1 < d.messages.length && d.messages[i + 1].id.startsWith(`${id}/`)) i++;
    return i;
  };
  // an operand may start or end at an early exit (`…!exit2`) or a minimized fragment: they sit before their `beforeId`
  const exits = new Map((d.exits ?? []).map((x) => [x.id, x.beforeId]));
  const fragments = new Map((d.fragments ?? []).map((f) => [f.id, f.beforeId]));
  const startOf = (id: string | undefined): number | undefined => {
    for (let n = 0; id !== undefined && n < 100; n++) {
      const i = index.get(id);
      if (i !== undefined) return i;
      id = exits.has(id) ? exits.get(id) : fragments.get(id);
    }
    return undefined;
  };
  const endOf = (id: string, owner: string): number => {
    if (index.has(id)) return subtreeEnd(id);
    const next = startOf(exits.has(id) ? exits.get(id) : fragments.get(id));
    return next !== undefined ? next - 1 : index.has(owner) ? subtreeEnd(owner) : d.messages.length - 1;
  };
  const out = new Map<string, { fragment: Fragment; operand: number }[]>();
  for (const f of d.fragments ?? []) {
    if (f.collapsed) continue;
    f.operands.forEach((o, n) => {
      const a = startOf(o.firstMessageId);
      if (a === undefined) return;
      const b = endOf(o.lastMessageId, f.ownerMessageId);
      for (let i = a; i <= b; i++) {
        const id = d.messages[i].id;
        out.set(id, [...(out.get(id) ?? []), { fragment: f, operand: n }]);
      }
    });
  }
  return out;
}

const frameText = (root: string, f: Fragment, n: number) => {
  const guard = f.operands[n].guard;
  const kind = n > 0 && (f.kind === 'alt' || f.kind === 'try') ? (f.kind === 'try' ? 'catch' : 'else') : f.kind;
  const at = where(root, f.operands[n].range ?? f.range);
  return `${kind}${guard && guard !== 'else' ? ` [${guard}]` : ''}${at ? ` @ ${at}` : ''}`;
};

export function flowResult(root: string, d: SequenceDiagram): FlowResult {
  const parts = new Map(d.participants.map((p) => [p.id, p]));
  const frames = framesByMessage(d);
  const byId = new Map(d.messages.map((m) => [m.id, m]));
  const ownIo = (m: Message | undefined) => (m?.sideEffects && !m.sideEffects.below ? m.sideEffects.kinds : undefined);
  // the nearest caller doing the same I/O itself: this call is part of it (the query's row reader)
  const partOf = (m: Message, kinds: NonNullable<Message['sideEffects']>['kinds']): Message | undefined => {
    for (let p = m.parentId ? byId.get(m.parentId) : undefined; p && p.id !== 'root'; p = p.parentId ? byId.get(p.parentId) : undefined) {
      const own = ownIo(p);
      if (own && kinds.every((k) => own.includes(k))) return p;
    }
    return undefined;
  };
  const label = (m: Message) => {
    const cls = m.className ?? parts.get(m.to)?.className;
    return m.kind === 'create' ? `«create» ${cls ?? m.methodName}` : cls ? `${cls}.${m.methodName}` : m.methodName;
  };
  // the method's own calls; the DI container's object creation before it (FR-6.5) is left out
  const calls: FlowCall[] = d.messages.filter((m) => m.id.startsWith('root/')).map((m) => {
    const to = parts.get(m.to);
    const call = label(m);
    const inside = m.sideEffects ? partOf(m, m.sideEffects.kinds) : undefined;
    const poly = m.polymorphic;
    const drawn = poly?.selectedKey ?? poly?.bound?.classKey;
    const fr = frames.get(m.id);
    return {
      id: m.id,
      depth: m.depth,
      call,
      args: m.args,
      ...(m.methodKey ? { methodKey: m.methodKey } : {}),
      ...(m.callSite ? { at: where(root, m.callSite) } : {}),
      ...(to?.layer ? { layer: to.layer } : {}),
      ...(m.sideEffects ? { io: { kinds: m.sideEffects.kinds, ...(m.sideEffects.below ? { below: true } : {}), ...(inside ? { partOf: label(inside) } : {}), evidence: m.sideEffects.evidence } } : {}),
      ...(m.isAsync ? { async: true } : {}),
      ...(m.isLibrary ? { library: true } : {}),
      ...(m.unresolved ? { unresolved: m.unresolved } : {}),
      ...(m.expandable && !m.expanded ? { folded: true } : {}),
      ...(m.recursive ? { recursive: true } : {}),
      ...(poly ? { implementations: { names: poly.implementations.map((c) => c.name), ...(drawn ? { drawn: nameOfKey(drawn) } : {}) } } : {}),
      ...(fr?.length ? { frames: fr.map((x) => frameText(root, x.fragment, x.operand)) } : {}),
    };
  });
  const io: FlowIo[] = [];
  for (const c of calls) {
    // I/O only further down counts when nothing below it is listed (folded, or an interface call with no implementation chosen)
    const opened = calls.some((x) => x.id.startsWith(`${c.id}/`));
    if (!c.io || c.io.partOf || (c.io.below && opened)) continue;
    const m = byId.get(c.id)!;
    const chain: Message[] = [];
    for (let p = m.parentId ? byId.get(m.parentId) : undefined; p && p.id !== 'root'; p = p.parentId ? byId.get(p.parentId) : undefined) chain.unshift(p);
    const scopes = frames.get(c.id) ?? [];
    // a loop runs it once when a call on the way down from the loop leaves it (FR-19.1 leavesLoop)
    const leaves = (owner: string) => {
      for (let p: Message | undefined = m; p && p.id !== owner; p = p.parentId ? byId.get(p.parentId) : undefined) if (p.leavesLoop) return true;
      return false;
    };
    const loops = scopes.filter((x) => x.fragment.kind === 'loop' && /^each\b/.test(x.fragment.operands[x.operand].guard ?? ''));
    const perElement = loops.some((x) => !leaves(x.fragment.ownerMessageId));
    io.push({
      kinds: c.io.kinds,
      call: c.call,
      id: c.id,
      ...(c.at ? { at: c.at } : {}),
      via: chain.map(label),
      ...(perElement ? { inLoop: true } : loops.length ? { onceInLoop: true } : {}),
      ...(scopes.some((x) => x.fragment.kind === 'callback' && /^later: /.test(x.fragment.operands[x.operand].guard ?? '')) ? { later: true } : {}),
      ...(c.io.below ? { below: true } : {}),
    });
  }
  // the innermost loop around a call (an N+1's loop)
  const loopOf = (id: string) => {
    const loops = (frames.get(id) ?? []).filter((x) => x.fragment.kind === 'loop');
    const last = loops[loops.length - 1];
    return last && frameText(root, last.fragment, last.operand);
  };
  const rootPart = parts.get(d.messages.find((m) => m.id === 'root')?.to ?? '');
  return {
    method: { key: d.root.key, label: methodLabel(d.root), ...(d.root.declaration ? { at: where(root, d.root.declaration) } : {}), ...(rootPart?.layer ? { layer: rootPart.layer } : {}) },
    entryPoints: (d.entryPoints ?? []).map(entryLabel),
    callCount: calls.length,
    calls,
    io,
    issues: (d.findings ?? []).map((f) => toIssue(root, f, d.messages, loopOf)),
  };
}

// ───────────────────────────── text ─────────────────────────────

export function issueLines(issues: (Issue & { where?: string; flow?: string })[], indent = '  '): string[] {
  return issues.map((i) => {
    const tags = [i.kind, i.certainty === 'possible' ? 'possible' : '', i.where ?? ''].filter(Boolean).join(', ');
    const lines = [`${indent}⚠ ${i.title}  (${tags})${i.at?.length ? `  at ${i.at.slice(0, 4).join(', ')}${i.at.length > 4 ? ` +${i.at.length - 4}` : ''}` : ''}${i.flow ? `  in ${i.flow}` : ''}`];
    if (i.loop) lines.push(`${indent}    the loop: ${i.loop}`);
    for (const ev of i.evidence ?? []) lines.push(`${indent}    ${ev}`);
    return lines.join('\n');
  });
}

/** `A → B → … → Y → Z`: the first step and the last two of a long chain. */
const shortChain = (via: string[]) => (via.length > 4 ? [via[0], '…', ...via.slice(-2)] : via).join(' → ');

/** FR-27.6 short by default (the method, its I/O and issues); the call tree with `tree`. FR-25.4: what the panel copies. */
export function flowLines(r: FlowResult, opts: { tree?: boolean } = {}): string[] {
  const out: string[] = [];
  out.push(`${r.method.label}${r.method.layer ? `  [${r.method.layer}]` : ''}${r.method.at ? `  ${r.method.at}` : ''}${r.entryPoints.length ? `  ← ${r.entryPoints.join(', ')}` : ''}`);
  if (!opts.tree) out.push(`${r.callCount} call${r.callCount === 1 ? '' : 's'}${r.callCount ? ' (the call tree: --tree)' : ''}`);
  const open: string[] = []; // frames printed for the current line, outer first
  for (const c of opts.tree ? (r.calls ?? []) : []) {
    const frames = c.frames ?? [];
    // a frame line opens where the frame list of this call differs from the open one
    let same = 0;
    while (same < open.length && same < frames.length && open[same] === frames[same]) same++;
    open.length = same;
    for (let k = same; k < frames.length; k++) {
      out.push(`${'  '.repeat(c.depth + k)}${frames[k]}`);
      open.push(frames[k]);
    }
    const pad = '  '.repeat(c.depth + frames.length);
    const tags = [
      c.layer && `[${c.layer}]`,
      c.io && `${c.io.below ? 'I/O below: ' : ''}${c.io.kinds.join(',').toUpperCase()}${c.io.partOf ? ` (part of ${c.io.partOf})` : ''}`,
      c.async && 'async',
      c.library && 'lib',
      c.unresolved && `unresolved: ${c.unresolved}`,
      c.implementations && `impl: ${c.implementations.names.join(' | ')}${c.implementations.drawn ? ` → ${c.implementations.drawn}` : ''}`,
      c.recursive && 'recursive',
      c.folded && '(folded)',
    ].filter(Boolean);
    out.push(`${pad}${c.call}(${c.args.join(', ')})${tags.length ? `  ${tags.join('  ')}` : ''}${c.at ? `  ${c.at}` : ''}`);
  }
  out.push(r.io.length ? `I/O (${r.io.length}; inside calls doing the same I/O not repeated):` : 'I/O: none found in the shown calls');
  for (const x of r.io) {
    const tags = [x.inLoop && 'IN LOOP', x.onceInLoop && 'in a loop, once (the loop ends after it)', x.later && 'runs later', x.below && 'further down, not shown'].filter(Boolean);
    out.push(`  ${x.kinds.join(',').toUpperCase()}  ${x.call}${x.at ? `  ${x.at}` : ''}${tags.length ? `  [${tags.join(', ')}]` : ''}${x.via.length ? `  via ${opts.tree ? x.via.join(' → ') : shortChain(x.via)}` : ''}`);
  }
  out.push(r.issues.length ? `issues (${r.issues.length}):` : 'issues: none in this flow');
  out.push(...issueLines(r.issues));
  return out;
}

const filterText = (f: HideFilter) => {
  switch (f.kind) {
    case 'methodName': return `calls named ${f.methodName}`;
    case 'classMethod': return `${f.className}.${f.methodName}`;
    case 'class': return `calls to ${f.className}`;
    case 'classPattern': return `classes named ${f.pattern}`;
    case 'stereotype': return `«${f.stereotype}» classes`;
  }
};

/**
 * FR-25.4 Share → Copy as text: the flow as the panel shows it — the calls opened, the implementations chosen, without
 * the hidden ones (named at the end, so the reader knows they were left out on purpose); folded calls stay folded.
 */
export function viewText(root: string, d: SequenceDiagram): string {
  const out = ['# Seqcall sequence diagram, as shown in the panel (folded calls not opened)', ...flowLines(flowResult(root, d), { tree: true })];
  // no I/O badges: no I/O was looked for, "none found" would be wrong
  const io = out.findIndex((l) => l.startsWith('I/O'));
  if (d.options.showSideEffects === false) out[io] = 'I/O: not looked for (View ▾ I/O badges are off)';
  out.push(...ruleLines(d.hiddenFilters));
  return out.join('\n');
}

/**
 * FR-25.5 right-click on a call → Ask AI about this call: a ready prompt about that call (a review question when the
 * branch changed it, FR-24), then the flow as Copy as text gives it, for the agent to read only the code named there.
 * Undefined when the call is not in the diagram.
 */
export function askText(root: string, d: SequenceDiagram, messageId: string): string | undefined {
  const r = flowResult(root, d);
  const c = r.calls!.find((x) => x.id === messageId);
  const m = d.messages.find((x) => x.id === messageId);
  if (!m || (!c && messageId !== 'root')) return undefined;
  const what = c ? `the call \`${c.call}(${c.args.join(', ')})\`${c.at ? ` at ${c.at}` : ''}` : `the method \`${r.method.label}\`${r.method.at ? ` at ${r.method.at}` : ''} (the start of the flow)`;
  const changed = !!(m.diff?.status || m.diff?.call || m.diff?.method);
  const question = changed
    ? `Review ${what}: the branch changed it. Is the change correct, what in the rest of the flow can break because of it, and which tests would you add?`
    : `Explain ${what} in the flow below. What does it do, what can go wrong there, and what in the rest of the flow depends on it?`;
  return [
    question,
    'Read the code at the file:line places the flow names. The flow lists only the calls opened in the diagram; a call marked (folded) was not opened, read its code when it matters.',
    '',
    viewText(root, d),
  ].join('\n');
}

/** The hide rules (named, so the reader knows what was left out on purpose) and the Don't expand rules. */
function ruleLines(filters: SequenceDiagram['hiddenFilters']): string[] {
  const list = (noExpand: boolean) => filters.filter((h) => !!h.filter.noExpand === noExpand).map((h) => `${filterText(h.filter)}${h.hiddenCount ? ` (${h.hiddenCount})` : ''}`);
  const hidden = list(false);
  const kept = list(true);
  return [...(hidden.length ? [`hidden: ${hidden.join(', ')}`] : []), ...(kept.length ? [`not expanded: ${kept.join(', ')}`] : [])];
}

const VISIBILITY = { private: '-', protected: '#' } as const;
const memberLine = (root: string, m: ClassMember) =>
  `${m.visibility ? `${VISIBILITY[m.visibility]} ` : ''}${m.isStatic ? 'static ' : ''}${m.signature || m.name}${m.declaration ? `  ${lineOf(root, m.declaration)}` : ''}`;
const ARROW: Record<ClassRelation['kind'], string> = { realization: 'implements', generalization: 'extends', association: 'has', dependency: 'calls', use: 'uses' };

/**
 * FR-25.4 the class diagram's Share → Copy as text: the classes of the shown flow by layer (stereotypes, file:line, the
 * methods the flow runs), then the relations with the calls behind them, layer violations and issues.
 */
export function classViewText(root: string, d: ClassDiagram, seq?: SequenceDiagram): string {
  const out = [`# Seqcall class diagram${seq ? ` of ${methodLabel(seq.root)}` : ''}: the classes in the shown calls`];
  const names = new Map(d.classes.map((c) => [c.key, c.name]));
  const classLines = (c: ClassNode, pad: string) => {
    // the kind when no stereotype says it already (`interface X «interface»` twice)
    const kind = c.kind === 'class' || c.kind === 'unknown' || c.stereotypes.includes(c.kind) ? '' : `${c.kind} `;
    const tags = [c.stereotypes.map((x) => `«${x}»`).join(''), c.sideEffects?.kinds.length && `I/O: ${c.sideEffects.kinds.join(',').toUpperCase()}`].filter(Boolean);
    out.push(`${pad}${c.group ? 'package ' : kind}${c.name}${tags.length ? `  ${tags.join('  ')}` : ''}${c.declaration ? `  ${lineOf(root, c.declaration)}` : ''}`);
    for (const m of c.methods) out.push(`${pad}  ${memberLine(root, m)}`);
    if (c.otherMethodCount) out.push(`${pad}  (+${c.otherMethodCount} method${c.otherMethodCount === 1 ? '' : 's'} not in this flow)`);
  };
  const layers = [...(d.layers ?? []), ...new Set(d.classes.map((c) => c.layer).filter((l): l is string => !!l && !d.layers?.includes(l)))];
  for (const layer of layers) {
    const inLayer = d.classes.filter((c) => c.layer === layer);
    if (!inLayer.length) continue;
    out.push(`[${layer}]`);
    for (const c of inLayer) classLines(c, '  ');
  }
  const noLayer = d.classes.filter((c) => !c.layer);
  if (noLayer.length) {
    if (layers.length) out.push('[no layer]');
    for (const c of noLayer) classLines(c, layers.length ? '  ' : '');
  }
  out.push(d.relations.length ? `relations (${d.relations.length}):` : 'relations: none');
  for (const r of d.relations) {
    const label = r.label && !r.labelObvious ? ` ${r.label}` : '';
    const many = r.multiplicity ? ` [${r.multiplicity}]` : '';
    out.push(`  ${names.get(r.from) ?? nameOfKey(r.from)} ${ARROW[r.kind]}${label} ${names.get(r.to) ?? nameOfKey(r.to)}${many}${r.violation ? `  ⚠ ${r.possible ? 'possible: ' : ''}${r.violation}` : ''}`);
    // FR-7.16 why it is only possible
    for (const g of r.possible ?? []) out.push(`    ${g}`);
    for (const c of (r.calls ?? []).slice(0, 3)) out.push(`    ${c.label}${c.callSite ? `  ${lineOf(root, c.callSite)}` : ''}`);
    if ((r.calls?.length ?? 0) > 3) out.push(`    +${r.calls!.length - 3} more calls`);
  }
  const issues = (d.findings ?? []).map((f) => toIssue(root, f));
  out.push(issues.length ? `issues (${issues.length}):` : 'issues: none among these classes');
  out.push(...issueLines(issues));
  if (seq) out.push(...ruleLines(seq.hiddenFilters));
  return out.join('\n');
}
