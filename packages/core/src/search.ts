import type { MethodRef, SearchHit } from '@seqcall/protocol';
import type { CallSite, ArgumentFunction } from './adapter';

/**
 * FR-23 name matching (the webview's find bar matches visible names the same way): case-insensitive
 * substring, or camelCase / snake_case word starts in order (`fUs`, `fiUse` → `findUser`). A query
 * with a dot matches `Class.method` as a substring.
 */
export function nameMatches(query: string, ...names: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return names.some((n) => !!n && (n.toLowerCase().includes(q) || (!q.includes('.') && q.length > 1 && humps(q, words(n)))));
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** `q` is a sequence of prefixes of words, in order (words may be skipped). */
function humps(q: string, ws: string[], from = 0): boolean {
  if (!q) return true;
  for (let i = from; i < ws.length; i++) {
    for (let k = Math.min(q.length, ws[i].length); k > 0; k--) {
      if (ws[i].startsWith(q.slice(0, k)) && humps(q.slice(k), ws, i + 1)) return true;
    }
  }
  return false;
}

/** FR-23.2 bounds of the search below the collapsed calls (normal, and "Search deeper"). */
export const SEARCH_LIMITS = { depth: 4, methods: 200 } as const;
export const SEARCH_DEEPER_LIMITS = { depth: 8, methods: 800 } as const;
const MAX_HITS = 100;

export interface SearchAnchor {
  /** The visible, collapsed message. */
  id: string;
  /** What it runs: its method, or every implementation when no implementation is chosen yet. */
  methods: MethodRef[];
  /** The call drawn for it (FR-1.13: the functions its caller passed are what its body's parameter invocations run). */
  call?: CallSite;
}

export interface SearchDeps {
  outgoing(m: MethodRef): Promise<CallSite[]>;
  implementations(m: MethodRef): Promise<MethodRef[]>;
  /** The method's parameter names, to bind the functions a call passes (FR-1.13). Optional. */
  parameterNames?(m: MethodRef): Promise<string[]>;
  /** Library calls are drawn (the option `showLibraryCalls`); otherwise they are not searched. */
  libraryCalls: boolean;
  cancelled?(): boolean;
  onProgress?(methods: number): void;
}

const label = (m: MethodRef) => (m.owner.kind === 'module' ? m.name : `${m.owner.name}.${m.name}`);
const callLabel = (c: CallSite) => {
  const owner = c.target?.owner.kind === 'module' ? undefined : (c.target?.owner.name ?? c.receiverType?.name ?? c.libraryName);
  return owner ? `${owner}.${c.methodName}` : c.methodName;
};

const plainName = (n: string | undefined) => n?.split('<', 1)[0].toLowerCase();

/**
 * FR-23.5 an `@object` query (`@:Mailer`, `@primary:Repo`, `@Mail`): whether a call goes to that object's class — by its
 * label's class exactly, or a typed name matched like the drawn lifelines are. Undefined when the query names no object.
 */
function objectMatcher(query: string): ((c: CallSite) => boolean) | undefined {
  const q = query.trim();
  if (!q.startsWith('@') || q.length < 2) return undefined;
  const text = q.slice(1).trim();
  const colon = text.indexOf(':');
  const cls = colon >= 0 ? plainName(text.slice(colon + 1)) : undefined;
  return (c) => {
    const names = [c.target?.owner.kind === 'module' ? undefined : c.target?.owner.name, c.receiverType?.name];
    return cls !== undefined ? names.some((n) => plainName(n) === cls) : nameMatches(text, ...names);
  };
}

/**
 * FR-23.2 calls matching `query` below the collapsed messages: breadth-first through the bodies the
 * calls run (every implementation of an interface call), nearest first, each method once. A hit
 * carries the path from its collapsed message down to the call, to be expanded on demand.
 */
export async function searchBelow(anchors: SearchAnchor[], query: string, deps: SearchDeps, limits: { depth: number; methods: number } = SEARCH_LIMITS): Promise<{ hits: SearchHit[]; methods: number; truncated: boolean } | undefined> {
  type Functions = Map<string, ArgumentFunction>;
  type Item = { anchorId: string; chain: { method: MethodRef; call?: CallSite }[]; functions: Functions };
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  // FR-23.5 `@object`: the calls that reach the object (its own calls are below them: not searched)
  const toObject = objectMatcher(query);
  /**
   * FR-1.13 the functions `call` passes to `target`, by the target's parameter name (a method reference, a lambda,
   * or a function of the caller's own passed on) — what the target's parameter invocations run.
   */
  const bindFunctions = async (target: MethodRef, call: CallSite | undefined, from: Functions): Promise<Functions> => {
    const out: Functions = new Map();
    if (!call || !(call.argFunctions?.some(Boolean) || call.argOrigins?.some((o) => o?.kind === 'parameter' && from.has(o.name)))) return out;
    const names = (await deps.parameterNames?.(target)) ?? [];
    names.forEach((name, i) => {
      // a parameter without a name (destructured) is never invoked by name: what is set for it is never asked for
      const origin = call.argOrigins?.[i];
      const fn = call.argFunctions?.[i] ?? (origin?.kind === 'parameter' ? from.get(origin.name) : undefined);
      if (fn) out.set(name, fn);
    });
    return out;
  };
  let queue: Item[] = [];
  for (const a of anchors) for (const m of a.methods) if (m.hasBody) queue.push({ anchorId: a.id, chain: [{ method: m }], functions: await bindFunctions(m, a.call, new Map()) });
  let searched = 0;
  let truncated = false;
  for (let depth = 0; queue.length; depth++) {
    const next: Item[] = [];
    for (const item of queue) {
      if (deps.cancelled?.()) return undefined;
      const method = item.chain[item.chain.length - 1].method;
      if (seen.has(method.key)) continue;
      if (searched >= limits.methods || hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      seen.add(method.key);
      searched++;
      deps.onProgress?.(searched);
      const raw = await deps.outgoing(method);
      // FR-1.13 a parameter invocation runs what the caller passed: a method reference becomes that call, a lambda
      // its body's calls (searched as the method's own, like the diagram draws them)
      const calls: CallSite[] = [];
      for (const c of raw) {
        const passed = c.invokedParameter !== undefined ? item.functions.get(c.invokedParameter) : undefined;
        if (passed?.kind === 'method') calls.push({ ...c, methodName: passed.target.name, target: passed.target, receiverType: passed.receiverType, isLibrary: passed.isLibrary, libraryName: passed.libraryName });
        else if (passed?.kind === 'lambda') calls.push(...(passed.calls ?? []));
        else calls.push(c);
      }
      for (const c of calls) {
        if (c.isLibrary && !deps.libraryCalls) continue;
        const hit = toObject ? toObject(c) : nameMatches(query, c.methodName, callLabel(c));
        if (hit) {
          const steps = [...item.chain.slice(0, -1).map((s, i) => ({ methodKey: s.method.key, call: { range: item.chain[i + 1].call!.range } })), { methodKey: method.key, call: { range: c.range } }];
          hits.push({
            anchorId: item.anchorId,
            steps,
            labels: item.chain.map((s) => label(s.method)),
            hit: { label: callLabel(c), range: c.range, ...(c.isLibrary ? { isLibrary: true } : {}) },
          });
        }
        if (c.isLibrary || !c.target || (toObject && hit)) continue;
        if (depth + 1 >= limits.depth) {
          truncated ||= c.target.hasBody;
          continue;
        }
        const targets = c.target.hasBody ? [c.target] : (await deps.implementations(c.target)).filter((m) => m.hasBody);
        for (const t of targets) if (!seen.has(t.key)) next.push({ anchorId: item.anchorId, chain: [...item.chain, { method: t, call: c }], functions: await bindFunctions(t, c, item.functions) });
      }
    }
    // a limit reached at the end of a level is seen by the next level's first method not searched yet (truncated)
    queue = next;
  }
  return { hits, methods: searched, truncated };
}
