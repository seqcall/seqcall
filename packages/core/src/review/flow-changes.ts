import type { Message } from '@seqcall/protocol';

/**
 * FR-24.15 the changes of a review flow as one fixed list: computed once per flow (expanded along every path to a
 * changed method, through every implementation those paths need), then placed in whatever view is open — drawn,
 * below a collapsed call, or in another implementation of an interface call. So the total does not move when the
 * reader expands, picks an implementation or zooms to layers.
 */

/** Where a change is in the full flow: its message, the ancestors from the root, the implementations chosen on the way. */
export interface ChangeOccurrence {
  id: string;
  /** Message ids from the root down to the change (the change's own id last). */
  path: string[];
  /** Ancestor id → the implementation's class key that path needs (an interface call). */
  needs: Map<string, string>;
}

export interface FlowChanges {
  /** Change identity → where it occurs (one entry per place; the first is the reading-order first). */
  changes: Map<string, ChangeOccurrence[]>;
  /**
   * The tour's order of the changes (identities): reading order of the first variant; a change only another
   * implementation has comes right after the changes below that interface call in the first variant.
   */
  order: string[];
}

/** A message's own change (not counting what is below it). */
export const hasOwnChange = (m: Message): boolean => !!(m.diff?.status || m.diff?.call || m.diff?.method || m.diff?.declared);

/**
 * What a message's own changes are, independent of the route that reached it: the call site of an added / removed /
 * changed call, and the changed method it reaches (unless the call is new: then its method is part of it). Two
 * messages with one identity show one change (a changed method called twice, the same call reached two ways); an
 * interface call shows the changed method of the implementation drawn.
 */
export function changeIdentities(m: Message): string[] {
  if (!hasOwnChange(m)) return [];
  const site = m.callSite;
  // chained calls start at the same position (`new Db().save()`): the end and the name tell them apart
  const at = site ? `${site.file}:${site.start.line}:${site.start.character}-${site.end.line}:${site.end.character}:${m.methodName}` : m.id;
  const out: string[] = [];
  if (m.diff?.status === 'removed') return [`-${at}`];
  if (m.diff?.status || m.diff?.call) out.push(`c${at}`);
  // an interface call with no implementation drawn reaches the interface's method: its change is the call's signature
  const atInterface = !!m.polymorphic && !m.polymorphic.selectedKey;
  if (m.diff?.method && m.diff.status !== 'added' && !(atInterface && out.length)) out.push(`m${m.methodKey ?? m.id}`);
  // the interface's method changed, the implementation drawn did not
  if (m.diff?.declared && m.polymorphic) out.push(`i${m.polymorphic.interfaceKey}.${m.methodName}`);
  return out;
}

/** the changes only an interface has come after the code changes (they change no behaviour on their own). */
export function interfaceChangesLast(flow: FlowChanges): void {
  flow.order = [...flow.order.filter((id) => !id.startsWith('i')), ...flow.order.filter((id) => id.startsWith('i'))];
}

/**
 * Adds the changes of one fully built variant of the flow (messages with their review marks, ghosts merged).
 * `divergeAt`: for a later variant, the interface call where its path leaves the first variant's implementation.
 */
export function collectChanges(into: FlowChanges, messages: Message[], choices: ReadonlyMap<string, string | null>, divergeAt?: (path: string[]) => string | undefined): void {
  const byId = new Map(messages.map((m) => [m.id, m]));
  let pointer = -1;
  const place = (identity: string, path: string[]) => {
    const known = into.order.indexOf(identity);
    if (known >= 0) {
      pointer = known;
      return;
    }
    let at = pointer + 1;
    // right after everything listed below the call where this variant takes another implementation (not after a
    // change the walk passed that sits elsewhere: the same changed method reached from another call)
    const call = divergeAt?.(path);
    if (call) {
      let last = -1;
      into.order.forEach((id, i) => {
        if (into.changes.get(id)?.[0]?.path.includes(call)) last = i;
      });
      if (last >= 0) at = last + 1;
    }
    into.order.splice(at, 0, identity);
    pointer = at;
  };
  for (const m of messages) {
    const identities = changeIdentities(m);
    if (!identities.length) continue;
    const path: string[] = [];
    for (let x: Message | undefined = m; x; x = x.parentId ? byId.get(x.parentId) : undefined) path.unshift(x.id);
    // the implementations on the way, and its own (the method it reaches decides which changed method it shows)
    const needs = new Map<string, string>();
    for (const id of path) {
      const c = choices.get(id);
      if (c) needs.set(id, c);
    }
    for (const identity of identities) {
      const list = into.changes.get(identity) ?? [];
      if (!list.some((o) => o.id === m.id && sameNeeds(o.needs, needs))) list.push({ id: m.id, path, needs });
      into.changes.set(identity, list);
      place(identity, path);
    }
  }
}

const sameNeeds = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** Where a change sits in the open view. */
export type Placement =
  | { kind: 'own'; id: string }
  | { kind: 'inside'; id: string; occurrence: ChangeOccurrence }
  | { kind: 'elsewhere'; id: string; classKey: string; occurrence: ChangeOccurrence };

/** A drawn message's share of the tour: the changes' numbers (1-based) it shows, and the ones it holds. */
export interface MessageChanges {
  own: number;
  inside: number;
  elsewhere: Map<string, number>;
  /** Numbers of its own changes (`method`: the change of the method it reaches, not of the call). */
  positions: { n: number; method?: true }[];
  /** Numbers of the changes below it / in another implementation. */
  held: number[];
}

export interface PlacedChanges {
  /** Message id → what it stands for. */
  at: Map<string, MessageChanges>;
  /** Change identity → its place (one per change). */
  placement: Map<string, Placement>;
  /** The tour's order (identities); a change's number is its index + 1. */
  order: string[];
  total: number;
}

/**
 * Places each change of the flow in the view: on its own message when drawn (the first in reading order when it
 * shows twice), else on the deepest drawn ancestor — collapsed (`inside`) or showing another implementation than
 * the one the change needs (`elsewhere`). Changes the view shows that the full flow has not (the reader expanded
 * beyond the review's paths) count too.
 */
export function placeChanges(flow: FlowChanges, view: { messages: Message[]; implOf(id: string): string | undefined }): PlacedChanges {
  const byId = new Map(view.messages.map((m) => [m.id, m]));
  const order = new Map(view.messages.map((m, i) => [m.id, i]));
  const placed: PlacedChanges = { at: new Map(), placement: new Map(), order: [], total: 0 };
  const slot = (id: string) => {
    let s = placed.at.get(id);
    if (!s) placed.at.set(id, (s = { own: 0, inside: 0, elsewhere: new Map(), positions: [], held: [] }));
    return s;
  };
  // drawn own changes: where the full flow has it first when drawn there, else the first in reading order — so a
  // change reached from two calls (one changed method) keeps its place whichever way the tour came
  const drawnAt = new Map<string, string[]>();
  for (const m of view.messages) for (const identity of changeIdentities(m)) drawnAt.set(identity, [...(drawnAt.get(identity) ?? []), m.id]);
  const drawn = new Map<string, string>();
  for (const [identity, ids] of drawnAt) {
    const home = flow.changes.get(identity)?.[0]?.id;
    drawn.set(identity, home && ids.includes(home) ? home : ids[0]);
  }
  const locate = (o: ChangeOccurrence): Placement => {
    let holder = o.path[0];
    for (const id of o.path) {
      const m = byId.get(id);
      // not drawn (below a call the view does not show): held by the deepest drawn one
      if (!m) break;
      const need = o.needs.get(id);
      if (need && view.implOf(id) !== need) return { kind: 'elsewhere', id, classKey: need, occurrence: o };
      if (id === o.id) return { kind: 'own', id };
      if (!m.expanded && id !== o.path[0]) return { kind: 'inside', id, occurrence: o };
      holder = id;
    }
    return { kind: 'inside', id: holder, occurrence: o };
  };
  const rank = (p: Placement) => (p.kind === 'own' ? 0 : 1);
  for (const [identity, occurrences] of flow.changes) {
    const shown = drawn.get(identity);
    let best: Placement | undefined = shown ? { kind: 'own', id: shown } : undefined;
    if (!best) {
      for (const o of occurrences) {
        const p = locate(o);
        if (!best || rank(p) < rank(best) || (rank(p) === rank(best) && (order.get(p.id) ?? Infinity) < (order.get(best.id) ?? Infinity))) best = p;
      }
    }
    // every change has an occurrence (collectChanges lists it where it adds it)
    placed.placement.set(identity, best!);
  }
  for (const [identity, id] of drawn) if (!placed.placement.has(identity)) placed.placement.set(identity, { kind: 'own', id });
  // the tour's order: the flow's, then what only this view shows (expanded beyond the review's paths)
  placed.order = [...flow.order.filter((id) => placed.placement.has(id)), ...[...placed.placement.keys()].filter((id) => !flow.order.includes(id))];
  placed.order.forEach((identity, i) => {
    const p = placed.placement.get(identity)!;
    const s = slot(p.id);
    if (p.kind === 'own') {
      s.own++;
      s.positions.push({ n: i + 1, ...(identity.startsWith('m') ? { method: true as const } : {}) });
      return;
    }
    s.held.push(i + 1);
    if (p.kind === 'inside') s.inside++;
    else s.elsewhere.set(p.classKey, (s.elsewhere.get(p.classKey) ?? 0) + 1);
  });
  placed.total = placed.order.length;
  return placed;
}

/** The change numbered `n` (1-based) in the tour: its place in the view now. */
export function changeAt(placed: PlacedChanges, n: number): Placement | undefined {
  // out of range: no identity, no placement
  return placed.placement.get(placed.order[n - 1]);
}

/** The change a message holds that comes first in the tour (below it, in another implementation). */
export function firstHeldBy(placed: PlacedChanges, messageId: string): ChangeOccurrence | undefined {
  for (const identity of placed.order) {
    const p = placed.placement.get(identity);
    if (p && p.id === messageId && p.kind !== 'own') return p.occurrence;
  }
  return undefined;
}
