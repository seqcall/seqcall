import type { CallerInfo, CallPathNode, EntryPoint, MethodRef } from '@seqcall/protocol';

/** FR-22 limits of a paths-to-here walk (the walk is one references query per method). */
export const PATHS_MAX_DEPTH = 12;
export const PATHS_MAX_METHODS = 400;
export const PATHS_MAX_LEAVES = 300;

export interface PathsWalk {
  /** References query of a method (cached by the caller across walks). */
  callers(method: MethodRef): Promise<CallerInfo[]>;
  /** The project's entry points (FR-16). */
  entryPoints: EntryPoint[];
  cancelled?(): boolean;
  /** Methods whose callers were searched so far. */
  onProgress?(methods: number): void;
  maxDepth?: number;
  maxMethods?: number;
  maxLeaves?: number;
}

export interface PathsResult {
  tree: CallPathNode;
  /** Methods whose callers were searched. */
  methods: number;
  /** A limit cut some paths (nodes with `end: 'limit'`). */
  truncated: boolean;
}

/** Callers grouped by their enclosing method (several calls from one method are one path step). */
interface CallerEdge {
  caller: CallerInfo;
  count: number;
}

/**
 * FR-22 paths to here: walks the callers of `target` (through interface → implementation, as the
 * references query reports them) breadth-first up to the entry points, then lays the paths out as a
 * reverse tree. The walk stops at entry points (except the target itself), in test code, at methods
 * nothing calls, and at the limits; a method already on the path (recursion) is not a new path.
 * Undefined when cancelled.
 */
export async function findPathsToHere(target: MethodRef, walk: PathsWalk): Promise<PathsResult | undefined> {
  const maxDepth = walk.maxDepth ?? PATHS_MAX_DEPTH;
  const maxMethods = walk.maxMethods ?? PATHS_MAX_METHODS;
  const maxLeaves = walk.maxLeaves ?? PATHS_MAX_LEAVES;
  const entries = new Map<string, EntryPoint[]>();
  for (const e of walk.entryPoints) entries.set(e.method.key, [...(entries.get(e.method.key) ?? []), e]);
  const isEntry = (key: string) => (entries.get(key) ?? []).length > 0;

  // phase 1: the callers graph, breadth-first (each method's references are searched once)
  const graph = new Map<string, CallerEdge[]>();
  const tests = new Set<string>();
  let truncated = false;
  let queue: MethodRef[] = [target];
  const queued = new Set([target.key]);
  for (let depth = 0; depth < maxDepth && queue.length; depth++) {
    const next: MethodRef[] = [];
    for (const m of queue) {
      if (walk.cancelled?.()) return undefined;
      if (graph.size >= maxMethods) {
        truncated = true;
        break;
      }
      const edges = new Map<string, CallerEdge>();
      for (const c of await walk.callers(m)) {
        const known = edges.get(c.enclosing.key);
        if (known) known.count++;
        else edges.set(c.enclosing.key, { caller: c, count: 1 });
        if (c.inTest) tests.add(c.enclosing.key);
      }
      graph.set(m.key, [...edges.values()]);
      walk.onProgress?.(graph.size);
      for (const { caller } of edges.values()) {
        const key = caller.enclosing.key;
        if (queued.has(key) || caller.inTest || isEntry(key)) continue;
        queued.add(key);
        next.push(caller.enclosing);
      }
    }
    queue = next;
  }

  // phase 2: the reverse tree (a method reached on several paths appears under each of them)
  let leaves = 0;
  const node = (method: MethodRef, edge: CallerEdge | undefined, onPath: Set<string>): CallPathNode => {
    const n: CallPathNode = { method };
    if (edge) {
      const c = edge.caller;
      n.call = { range: c.range, preview: c.preview, ...(c.passed ? { passed: true } : {}), ...(edge.count > 1 ? { count: edge.count } : {}) };
    }
    const eps = entries.get(method.key);
    if (eps?.length) n.entryPoints = eps;
    if (tests.has(method.key)) n.inTest = true;
    if (edge && (eps?.length || n.inTest)) {
      n.end = eps?.length ? 'entry' : 'test';
      leaves++;
      return n;
    }
    const edges = graph.get(method.key);
    if (!edges) {
      n.end = 'limit';
      truncated = true;
      leaves++;
      return n;
    }
    const up = edges.filter((e) => !onPath.has(e.caller.enclosing.key));
    if (!up.length) {
      n.end = 'top';
      leaves++;
      return n;
    }
    // production callers first; within them the adapter's order (file, line)
    up.sort((a, b) => Number(!!a.caller.inTest) - Number(!!b.caller.inTest));
    n.callers = [];
    for (const e of up) {
      if (leaves >= maxLeaves) {
        truncated = true;
        break;
      }
      const key = e.caller.enclosing.key;
      onPath.add(key);
      n.callers.push(node(e.caller.enclosing, e, onPath));
      onPath.delete(key);
    }
    return n;
  };
  const tree = node(target, undefined, new Set([target.key]));
  return { tree, methods: graph.size, truncated };
}
