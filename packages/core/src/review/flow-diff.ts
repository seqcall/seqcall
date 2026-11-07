import type { Message, Participant, ParticipantGroup } from '@seqcall/protocol';
import type { BuildResult } from '../session/build';
import { fileOfClassKey } from '../class-key';
import { cutFrom } from '../text';

/**
 * FR-24.6 the visible flow compared with the same flow at the merge base: calls the branch added, and the
 * calls it removed as "ghost" messages (with the participants only they reach), merged into one diagram.
 */
export interface FlowDiff {
  /** Ids of current messages that the base flow does not have. */
  added: Set<string>;
  /** Base messages missing now, as messages of the current diagram, each after its `anchor` (null = first child). */
  removed: { message: Message; parentId: string; anchor: string | null }[];
  /** Participants only removed calls reach (not in the current diagram). */
  removedParticipants: Participant[];
  removedGroups: ParticipantGroup[];
  /** Current participants the base flow does not have. */
  addedParticipants: Set<string>;
  /** Calls at the same place with the same name whose target differs (signature changed, another implementation): what they reached before. */
  retargeted: Map<string, string>;
  /** FR-24.15 a current call → where its counterpart was in the base version (both versions make it). */
  baseSites: Map<string, NonNullable<Message['callSite']>>;
}

export interface FlowDiffInput {
  current: BuildResult;
  /** Implementation choices of the current view (message id → class key). */
  choices: Map<string, string | null>;
  /** Builds the base flow with these expanded message ids and choices (undefined: the root does not exist there). */
  buildBase(expanded: Set<string>, choices: Map<string, string | null>): Promise<BuildResult | undefined>;
  /** Rounds of base expansion (one per level). */
  maxRounds?: number;
  /**
   * FR-24.15 may a call of today's flow stand for this call of the base flow? False when they are clearly two calls
   * (today's lines are all new while the base call's lines are still there, moved elsewhere): one added, one removed.
   */
  sameCall?(current: Message, base: Message): boolean;
  /** Renamed files of the branch: old path → new path (a class of a moved file is the same class). */
  renames?: ReadonlyMap<string, string>;
}

/** A key (`<relPath>#…`) with its file renamed by `renames`; other keys as they are. */
export function movedKey(key: string, renames: ReadonlyMap<string, string> | undefined): string {
  const file = fileOfClassKey(key);
  const moved = file && renames?.get(file);
  return moved ? moved + key.slice(file.length) : key;
}

/** What a call is, independent of its position: the target method, else class and name (keys through `key`). */
const signature = (m: Message, key: (k: string) => string = (k) => k): string => (m.methodKey ? key(m.methodKey) : `${key(m.classKey ?? '')}.${m.methodName}`);

/**
 * The calls of an expanded message in both versions, matched: by what they call (longest common subsequence),
 * then, between two such matches, by name — the same call whose target changed (a signature, an implementation).
 */
function matchChildren(cs: Message[], bs: Message[], sameCall: FlowDiffInput['sameCall'], baseKey: (k: string) => string): { pairs: [number, number][]; retargeted: Set<number> } {
  const ok = ([i, j]: [number, number]) => !sameCall || sameCall(cs[i], bs[j]);
  const exact = alignCalls(cs.map((m) => signature(m)), bs.map((m) => signature(m, baseKey))).filter(ok);
  const pairs: [number, number][] = [];
  const retargeted = new Set<number>();
  let [pi, pj] = [-1, -1];
  for (const [i, j] of [...exact, [cs.length, bs.length] as [number, number]]) {
    const byName = alignCalls(cs.slice(pi + 1, i).map((m) => m.methodName), bs.slice(pj + 1, j).map((m) => m.methodName));
    for (const [a, b] of byName) {
      if (!ok([pi + 1 + a, pj + 1 + b])) continue;
      pairs.push([pi + 1 + a, pj + 1 + b]);
      retargeted.add(pi + 1 + a);
    }
    if (i < cs.length) pairs.push([i, j]);
    [pi, pj] = [i, j];
  }
  return { pairs, retargeted };
}

/** Longest common subsequence of two lists of signatures: the matched index pairs, in order. */
export function alignCalls(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) out.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function childrenOf(messages: Message[]): Map<string, Message[]> {
  const out = new Map<string, Message[]>();
  for (const m of messages) if (m.parentId !== null) out.set(m.parentId, [...(out.get(m.parentId) ?? []), m]);
  return out;
}

export async function diffFlow(input: FlowDiffInput): Promise<FlowDiff | undefined> {
  const cur = input.current;
  // FR-24.6 the base's keys by today's paths; a chosen implementation by its base path
  const baseKey = (k: string) => movedKey(k, input.renames);
  const back = new Map([...(input.renames ?? [])].map(([from, to]) => [to, from]));
  const curById = new Map(cur.messages.map((m) => [m.id, m]));
  const curChildren = childrenOf(cur.messages);
  const baseExpanded = new Set<string>(['root']);
  const baseChoices = new Map<string, string | null>();
  let base: BuildResult | undefined;
  let pairs: [string, string][] = [];
  // expand the base flow where the current one is expanded, one level per round
  for (let round = 0; round < (input.maxRounds ?? 16); round++) {
    base = await input.buildBase(baseExpanded, baseChoices);
    if (!base) return undefined;
    const baseById = new Map(base.messages.map((m) => [m.id, m]));
    const baseChildren = childrenOf(base.messages);
    pairs = [];
    let grew = false;
    const queue: [string, string][] = [['root', 'root']];
    while (queue.length) {
      const [c, b] = queue.shift()!;
      pairs.push([c, b]);
      const cm = curById.get(c);
      const bm = baseById.get(b);
      if (!cm?.expanded && c !== 'root') continue;
      if (b !== 'root' && !bm?.expanded) {
        if (bm?.expandable && !baseExpanded.has(b)) {
          baseExpanded.add(b);
          grew = true;
        }
        continue;
      }
      const cs = curChildren.get(c) ?? [];
      const bs = baseChildren.get(b) ?? [];
      for (const [i, j] of matchChildren(cs, bs, input.sameCall, baseKey).pairs) {
        const chosen = input.choices.get(cs[i].id);
        const choice = chosen ? movedKey(chosen, back) : chosen;
        if (choice !== undefined && baseChoices.get(bs[j].id) !== choice) {
          baseChoices.set(bs[j].id, choice);
          grew = true;
        }
        queue.push([cs[i].id, bs[j].id]);
      }
    }
    if (!grew) break;
  }
  if (!base) return undefined;

  const baseById = new Map(base.messages.map((m) => [m.id, m]));
  const baseChildren = childrenOf(base.messages);
  const curParticipants = new Map(cur.participants.map((p) => [p.id, p]));
  const curByClass = new Map<string, string>();
  for (const p of cur.participants) if (!curByClass.has(p.classKey)) curByClass.set(p.classKey, p.id);
  const baseParticipants = new Map(base.participants.map((p) => [p.id, p]));
  const baseClasses = new Set(base.participants.map((p) => baseKey(p.classKey)));
  const curGroups = new Set(cur.groups.map((g) => g.id));

  const diff: FlowDiff = { added: new Set(), removed: [], removedParticipants: [], removedGroups: [], addedParticipants: new Set(), retargeted: new Map(), baseSites: new Map() };
  for (const [c, b] of pairs) {
    const site = baseById.get(b)?.callSite;
    if (c !== 'root' && site) diff.baseSites.set(c, site);
  }
  const removedParticipants = new Map<string, Participant>();
  // a base participant in the current diagram: the same object, else the same class; else a ghost participant
  const participantOf = (id: string): string => {
    if (curParticipants.has(id)) return id;
    const p = baseParticipants.get(id);
    if (!p) return id;
    const sameClass = curByClass.get(baseKey(p.classKey));
    if (sameClass) return sameClass;
    if (!removedParticipants.has(id)) removedParticipants.set(id, { ...p, diff: 'removed' });
    return id;
  };

  for (const [c, b] of pairs) {
    const cm = curById.get(c);
    const bm = baseById.get(b);
    if (c !== 'root' && !cm?.expanded) continue;
    const cs = curChildren.get(c) ?? [];
    // the base call is not expanded there (its method is new, or has no body then): all of today's calls are new
    if (b !== 'root' && !bm?.expanded) {
      for (const m of cs) diff.added.add(m.id);
      continue;
    }
    const bs = baseChildren.get(b) ?? [];
    const { pairs: matched, retargeted } = matchChildren(cs, bs, input.sameCall, baseKey);
    for (const i of retargeted) {
      const b = bs[matched.find(([x]) => x === i)![1]];
      // the method it reached (an implementation, not the declaring interface): `ParcelApiClient.EnrollInCouponAsync`
      const reached = b.methodKey?.includes('#') ? cutFrom(b.methodKey.slice(b.methodKey.indexOf('#') + 1), '(') : undefined;
      diff.retargeted.set(cs[i].id, reached ?? (b.className ? `${b.className}.${b.methodName}` : b.methodName));
    }
    const curMatched = new Set(matched.map(([i]) => i));
    const baseToCur = new Map(matched.map(([i, j]) => [j, i]));
    cs.forEach((m, i) => {
      if (!curMatched.has(i)) diff.added.add(m.id);
    });
    let anchor: string | null = null;
    bs.forEach((m, j) => {
      const i = baseToCur.get(j);
      if (i !== undefined) {
        anchor = cs[i].id;
        return;
      }
      const ghost: Message = {
        ...m,
        id: `${c}/~${m.id.slice(m.id.lastIndexOf('/') + 1)}`,
        parentId: c,
        // `root` and every expanded message are drawn; a call below another always has a sender
        depth: cm!.depth + 1,
        from: participantOf(m.from!),
        to: participantOf(m.to),
        expandable: false,
        expanded: false,
        diff: { status: 'removed' },
      };
      delete ghost.importance;
      delete ghost.sideEffects;
      delete ghost.polymorphic;
      diff.removed.push({ message: ghost, parentId: c, anchor });
    });
  }
  diff.removedParticipants = [...removedParticipants.values()];
  for (const p of diff.removedParticipants) {
    if (curGroups.has(p.groupId)) continue;
    // the base build has the group of each of its participants
    const g = base.groups.find((x) => x.id === p.groupId)!;
    if (!diff.removedGroups.some((x) => x.id === g.id)) diff.removedGroups.push(g);
  }
  for (const p of cur.participants) if (!baseParticipants.has(p.id) && !baseClasses.has(p.classKey)) diff.addedParticipants.add(p.id);
  return diff;
}

/** The current messages with the removed ones placed after their anchor's subtree (or first under their parent). */
export function mergeRemoved(messages: Message[], removed: FlowDiff['removed']): Message[] {
  if (!removed.length) return messages;
  const out = [...messages];
  const endOfSubtree = (index: number): number => {
    const depth = out[index].depth;
    let k = index + 1;
    while (k < out.length && out[k].depth > depth) k++;
    return k;
  };
  for (const r of removed) {
    const at = r.anchor ?? r.parentId;
    const index = out.findIndex((m) => m.id === at);
    if (index < 0) continue;
    // after the anchor's subtree (and ghosts already placed there); first child: right after the parent
    let pos = r.anchor ? endOfSubtree(index) : index + 1;
    while (pos < out.length && out[pos].diff?.status === 'removed' && out[pos].parentId === r.parentId) pos++;
    out.splice(pos, 0, r.message);
  }
  return out;
}
