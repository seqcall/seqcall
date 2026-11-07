/**
 * FR-24.9 / FR-24.10 the review as a tour: the flows to look at (each change once, in the flow that shows
 * the most changes not seen yet) and, in the open diagram, its changes in reading order.
 */
import type { CallPathStep, EntryPoint, Message, ReviewResult, SequenceDiagram } from '@seqcall/protocol';
import { entryText } from './review-panel';

export interface TourFlow {
  label: string;
  entryPoint?: EntryPoint;
  /** Paths from the flow's start to each of its changed methods. */
  paths: CallPathStep[][];
  /** `Class.method` of the changed methods this flow shows (first seen here). */
  methods: string[];
  /** Other entry points that reach only methods already shown by earlier flows: covered by this flow, each openable on its own. */
  alsoFrom: AlsoFrom[];
  /** A changed method the review did not walk up to the entry points (limit): who reaches it is unknown. */
  notWalked?: boolean;
}

/** FR-24.12 an entry point a tour flow covers: its changed methods were shown by that flow (or earlier ones). */
export interface AlsoFrom {
  label: string;
  entryPoint: EntryPoint;
  /** `Class.method` of the changed methods it reaches. */
  methods: string[];
  /** Paths from it to each of them (its own flow, expanded down to them). */
  paths: CallPathStep[][];
}

const methodLabel = (m: ReviewResult['methods'][number]) => (m.method.owner.kind === 'module' ? m.method.name : `${m.method.owner.name}.${m.method.name}`);

/**
 * The flows of a review, greedy: the entry point whose flow reaches the most changed methods not shown yet
 * comes next; an entry point reaching nothing new is listed under the flow that showed its methods. Changed
 * methods no entry point reaches are flows of their own (opened from the method), at the end, then those not walked.
 */
export function reviewTour(r: ReviewResult): TourFlow[] {
  const byEntry = new Map<string, { entryPoint: EntryPoint; methods: Map<string, CallPathStep[]> }>();
  r.methods.forEach((m) => {
    for (const x of m.reachedFrom) {
      const id = `${x.entryPoint.kind}|${x.entryPoint.label}|${x.entryPoint.method.key}`;
      const e = byEntry.get(id) ?? { entryPoint: x.entryPoint, methods: new Map() };
      if (!e.methods.has(m.method.key)) e.methods.set(m.method.key, x.steps);
      byEntry.set(id, e);
    }
  });
  const label = new Map(r.methods.map((m) => [m.method.key, methodLabel(m)]));
  const shownIn = new Map<string, TourFlow>();
  const flows: TourFlow[] = [];
  const left = [...byEntry.values()];
  while (left.length) {
    let best = -1;
    let bestNew = 0;
    left.forEach((e, i) => {
      const n = [...e.methods.keys()].filter((k) => !shownIn.has(k)).length;
      // a tie keeps the earlier one (`left` stays in first-seen order)
      if (n > bestNew) [best, bestNew] = [i, n];
    });
    if (best < 0) {
      // the rest reach only methods shown already: "also from" under the flow that showed the first of them
      for (const e of left) {
        const flow = shownIn.get([...e.methods.keys()][0])!; // every method of the rest is shown
        const text = entryText(e.entryPoint);
        if (!flow.alsoFrom.some((a) => a.label === text)) flow.alsoFrom.push({ label: text, entryPoint: e.entryPoint, methods: [...e.methods.keys()].map((k) => label.get(k)!), paths: [...e.methods.values()] });
      }
      break;
    }
    const [e] = left.splice(best, 1);
    const fresh = [...e.methods].filter(([k]) => !shownIn.has(k));
    const flow: TourFlow = { label: entryText(e.entryPoint), entryPoint: e.entryPoint, paths: fresh.map(([, steps]) => steps), methods: fresh.map(([k]) => label.get(k)!), alsoFrom: [] }; // every key is one of r.methods
    for (const [k] of fresh) shownIn.set(k, flow);
    flows.push(flow);
  }
  for (const m of r.methods) {
    if (m.reachedFrom.length || shownIn.has(m.method.key)) continue;
    flows.push({ label: methodLabel(m), paths: [[{ methodKey: m.method.key }]], methods: [methodLabel(m)], alsoFrom: [], ...(m.notWalked ? { notWalked: true } : {}) });
  }
  return flows;
}

/**
 * FR-24.15 how many of the flow's changes a message stands for: its `count` (own, below, other implementations) and
 * the changes folded into it (zoomed). Without counts (an older host): 1 per stop.
 */
export const changeWeight = (m: Message): number =>
  m.diff?.count !== undefined ? m.diff.count + (m.diff.folded ?? 0) : m.diff?.status || m.diff?.call || m.diff?.method || (m.diff?.inside && !m.expanded) || m.diff?.folded ? 1 : 0;

/** A message the reviewer stops at: a call the branch added / changed / removed, a changed method, or changes below it. */
export const isChangeStop = (m: Message): boolean => changeWeight(m) > 0;

/** Its own change (not only changes below it). */
export const ownChange = (m: Message): boolean => !!(m.diff?.status || m.diff?.call || m.diff?.method || m.diff?.declared);

/** The change stops of a diagram, in reading order. */
export function changeStops(d: SequenceDiagram | null | undefined): Message[] {
  return (d?.messages ?? []).filter(isChangeStop);
}

/** One line about a stop for the bar: "+ Order.save", "− Audit.log", "~ total (method changed)", "▲3 below place", "▲2 folded in Application". */
export function stopText(m: Message, foldedIn?: string): string {
  const name = m.className ? `${m.className}.${m.methodName}` : m.methodName;
  const own = ownText(m, name, foldedIn);
  // FR-24.15 what ▶ opens next: changes below, in another implementation (not the ones stepped through)
  const others = m.diff?.elsewhere ?? [];
  const held = [...(m.diff?.inside && (own || others.length) ? [`▲${m.diff.inside} below`] : []), ...others.map((e) => `▲${e.count} in ${e.className}`)];
  if (own && held.length) return `${own} · ${held.join(' · ')} — ▶ shows ${held.length > 1 ? 'them' : 'it'}`;
  if (held.length) return `${held.join(' · ')} — ▶ shows ${held.length > 1 ? 'them' : 'it'}`;
  return own ?? `▲${m.diff?.inside ?? 0} below ${name}`;
}

function ownText(m: Message, name: string, foldedIn?: string): string | undefined {
  const s = m.diff?.status;
  if (!s && !m.diff?.call && !m.diff?.method && !(m.diff?.inside && !m.expanded) && m.diff?.folded) return `▲${m.diff.folded} folded in ${foldedIn ?? 'the layer'} — ▶ opens it`;
  if (s === 'added') return `+ ${name}`;
  if (s === 'removed') return `− ${name}`;
  if (s === 'changed') {
    // FR-24.15 an interface call: the drawn implementation's method changed too
    const impl = m.polymorphic?.selectedKey && m.diff?.method ? m.polymorphic.implementations.find((i) => i.key === m.polymorphic!.selectedKey)?.name : undefined;
    // … or only the interface's method
    const iface = m.diff?.declared && m.polymorphic ? [`interface ${m.polymorphic.interfaceName}.${m.methodName} ${m.diff.declared}`] : [];
    const why = [...(m.diff?.before ? [`was ${m.diff.before}`] : m.diff?.signature ? ['signature changed'] : []), ...(impl ? [`${impl}.${m.methodName} ${m.diff!.method}`] : []), ...iface];
    return `~ ${name}${why.length ? ` (${why.join('; ')})` : ''}`;
  }
  if (m.diff?.call) return `~ ${name}`;
  if (m.diff?.method) return `${m.diff.method === 'added' ? '+' : '~'} ${name} (method ${m.diff.method})`;
  // only the interface changed: say whose method it is, and that the drawn implementation is the same
  if (m.diff?.declared && m.polymorphic) return `~ ${m.polymorphic.interfaceName}.${m.methodName} (interface method ${m.diff.declared}; ${name} unchanged)`;
  return undefined;
}

/** FR-24.15 the diagram numbers its review changes (a host with `reviewTotal` and numbered messages). */
export const numbered = (d: SequenceDiagram | null | undefined): boolean => d?.reviewTotal !== undefined && d.messages.some((m) => m.diff?.positions?.length || m.diff?.held?.length);

/** The message shows or holds change number `n`. */
export const hasNumber = (m: Message, n: number | undefined): boolean => n !== undefined && !!(m.diff?.positions?.some((x) => x.n === n) || m.diff?.held?.includes(n));

/** The first change number a message shows, else the first it holds. */
export const firstNumber = (m: Message | undefined): number | undefined => m?.diff?.positions?.[0]?.n ?? m?.diff?.held?.[0];

/**
 * FR-24.15 the bar's line for change `n` on message `m`: the call's own change, the change of the method it reaches
 * (an interface call: the implementation drawn), or — still held by `m` (below it, folded) — what it holds.
 */
export function numberText(m: Message, n: number, foldedIn?: string): string {
  const own = m.diff?.positions?.find((x) => x.n === n);
  if (!own) return stopText(m, foldedIn);
  const impl = m.polymorphic?.selectedKey ? m.polymorphic.implementations.find((i) => i.key === m.polymorphic!.selectedKey)?.name : undefined;
  const name = m.className ? `${m.className}.${m.methodName}` : m.methodName;
  if (own.method) return `~ ${impl ?? m.className ?? ''}${impl || m.className ? '.' : ''}${m.methodName} (method ${m.diff?.method ?? 'changed'})`;
  const s = m.diff?.status;
  if (s === 'added') return `+ ${name}`;
  if (s === 'removed') return `− ${name}`;
  if (s === 'changed') return `~ ${name}${m.diff?.before ? ` (was ${m.diff.before})` : m.diff?.signature ? ' (signature changed)' : ''}`;
  if (m.diff?.method) return `${m.diff.method === 'added' ? '+' : '~'} ${name} (method ${m.diff.method})`;
  return `~ ${name}`;
}
