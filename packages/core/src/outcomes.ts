import type { ClassRef, FlowOutcome, MethodRef, OutcomeVia, SideEffectKind, SourceRange } from '@seqcall/protocol';
import type { CallSite } from './adapter';
import type { BuildResult } from './session/build';
import { ioBelow, ioCallName, ioKindOfCall, ioOfCall, ioOfImplementations, MAX_IO_IMPLEMENTATIONS, SIDE_EFFECT_ORDER, withLambdaCalls, type IoFinding } from './side-effects';

type Peek = (m: MethodRef) => CallSite[] | undefined;
type PeekImpls = (m: MethodRef) => MethodRef[] | undefined;

/** One I/O call of the flow and the class whose body makes it. */
export interface OutcomeItem {
  kind: SideEffectKind;
  call: string;
  className: string;
  classKey?: string;
  at?: SourceRange;
}

/**
 * FR-32.1 the outcome of a flow built fully expanded and I/O scanned (an internal session): every message's body
 * read once — an expanded call's library calls (drawn or not; a drawn library call is counted with its sender's body)
 * and the calls hidden by a rule (through their cached bodies), a folded call's body and what is below it (the I/O
 * scan read them), an interface call with no
 * implementation chosen through the I/O all of them do (FR-17.6). Each call is charged to the class whose body makes
 * it. `atLeast` when a call stayed folded with calls of its own (the expand limit, a "don't expand" rule: `folded`
 * counts them) or an interface call has more implementations than the I/O walk follows (`wide` names them), or the I/O walk stopped
 * before the end — its depth or size limit, a body not analysed (`deep` names where). A body's calls are charged to the object that
 * runs it — the participant (`ShopClient` running `BaseHttpClient.send`, FR-5.11), not the class declaring the method.
 */
export function outcomeOfFlow(build: BuildResult, notDrawn: (messageId: string) => CallSite[], peek: Peek, peekImpls: PeekImpls): FlowOutcome {
  const items: OutcomeItem[] = [];
  let folded = 0;
  const wide = new Map<string, number>();
  let unresolved = 0;
  // the methods where the I/O walk stopped (its depth or size limit, a body not analysed)
  const cuts = new Set<string>();
  const own = (calls: CallSite[], owner: ClassRef) => {
    for (const c of withLambdaCalls(calls)) {
      const kind = ioKindOfCall(c);
      if (kind) items.push({ kind, call: ioCallName(c), className: owner.name, classKey: owner.key, at: c.range });
    }
  };
  // found below: charged to the object the walk says runs the method
  const below = (found: IoFinding[]) => {
    for (const f of found) items.push({ kind: f.kind, call: f.call, className: f.by!.name, classKey: f.by!.key, at: f.at });
  };
  const objects = new Map(build.participants.map((p) => [p.id, { key: p.classKey, name: p.className, kind: 'class' as const }]));
  for (const m of build.messages) {
    // a library call drawn (library calls shown) is counted with its sender's body
    if (m.isLibrary) continue;
    const node = build.nodes.get(m.id);
    if (m.parentId && !m.methodKey) unresolved++;
    const effective = node?.effective;
    if (!effective?.hasBody) {
      // an interface call with no implementation chosen: the I/O every implementation does
      if (!m.expanded && node?.implementations?.length) {
        // the interface method's name: what the user can look up
        if (node.implementations.length > MAX_IO_IMPLEMENTATIONS) wide.set(`${node.declared!.owner.name}.${node.declared!.name}`, node.implementations.length);
        else below(ioOfImplementations(node.implementations, peek, peekImpls, cuts));
      }
      continue;
    }
    // the same method further up the path: its body is counted there
    if (m.recursive) continue;
    if (m.expanded) {
      own(peek(effective)!.filter((c) => c.isLibrary), objects.get(m.to)!);
      below(notDrawn(m.id).filter((c) => !c.isLibrary).flatMap((c) => ioOfCall(c, peek, peekImpls, cuts, objects.get(m.to))));
    } else {
      own(peek(effective)!, objects.get(m.to)!);
      below(ioBelow(effective, peek, peekImpls, cuts, objects.get(m.to)));
      if (m.expandable) folded++;
    }
  }
  return toOutcome(items, { folded, wide: [...wide].map(([call, implementations]) => ({ call, implementations })), deep: [...cuts] }, unresolved);
}

/**
 * Kinds in the fixed order, each with its classes (first seen first; one class found by name and by key is one), each
 * class with its calls once per place.
 */
export function toOutcome(items: OutcomeItem[], cut: { folded: number; wide: { call: string; implementations: number }[]; deep?: string[] }, unresolved: number): FlowOutcome {
  const io = SIDE_EFFECT_ORDER.flatMap((kind) => {
    const via = new Map<string, OutcomeVia>();
    for (const it of items) {
      if (it.kind !== kind) continue;
      let v = via.get(it.className);
      if (!v) via.set(it.className, (v = { className: it.className, calls: [] }));
      if (it.classKey) v.classKey ??= it.classKey;
      const same = (c: { call: string; at?: SourceRange }) => c.call === it.call && c.at?.file === it.at?.file && c.at?.start.line === it.at?.start.line;
      if (!v.calls.some(same)) v.calls.push({ call: it.call, ...(it.at ? { at: it.at } : {}) });
    }
    return via.size ? [{ kind, via: [...via.values()] }] : [];
  });
  const deep = cut.deep ?? [];
  const atLeast = cut.folded > 0 || cut.wide.length > 0 || deep.length > 0;
  return {
    io,
    ...(atLeast ? { atLeast: true as const, why: atLeastWhy(cut) } : {}),
    ...(cut.folded ? { folded: cut.folded } : {}),
    ...(cut.wide.length ? { wide: cut.wide } : {}),
    ...(deep.length ? { deep } : {}),
    ...(unresolved ? { unresolved } : {}),
  };
}

/**
 * Why a flow was not followed to its end: `3 calls left folded, OrderHandler.handle has 22 implementations, the I/O
 * walk stopped at OrderClient.post` (two named of each, the rest counted).
 */
export function atLeastWhy(cut: { folded?: number; wide?: { call: string; implementations: number }[]; deep?: string[] }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const wide = cut.wide ?? [];
  const deep = cut.deep ?? [];
  return [
    cut.folded && `${plural(cut.folded, 'call')} left folded`,
    ...wide.slice(0, 2).map((w) => `${w.call} has ${w.implementations} implementations`),
    wide.length > 2 && `${plural(wide.length - 2, 'more interface call')} like that`,
    deep.length && `the I/O walk stopped at ${deep.length > 2 ? `${deep.slice(0, 2).join(', ')} and ${plural(deep.length - 2, 'more method')}` : deep.join(' and ')}`,
  ]
    .filter(Boolean)
    .join(', ');
}
