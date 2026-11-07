/**
 * Combined fragments (FR-1.10): turns the enclosing control-flow scopes of the *visible* direct
 * children of one message into nested fragments. Only operands with visible messages exist, so
 * hiding calls (filters, library toggle) never leaves empty frames behind.
 */
import type { CatchRow, ErrorPathFold, Fragment, FragmentOperand } from '@seqcall/protocol';
import type { CatchHandler, FragmentScope } from '../adapter';

export interface ScopedChild {
  /** Message id of a direct child of the owner, or the id of a collapsed fragment (its stub). */
  id: string;
  scopes?: FragmentScope[];
}

/** FR-1.22 / FR-3.11 what the build left out of an owner's frames. */
export interface FragmentFolds {
  /** Followed `alt`s (fragment id) → how many other cases were left out. */
  followed?: ReadonlyMap<string, number>;
  /** Error branches Smart expand folded: `<fragment id>#<operand>` → the fold (catch rows). */
  errorPaths?: ReadonlyMap<string, ErrorPathFold>;
}

interface Node {
  scope: FragmentScope;
  kind: Fragment['kind'];
  id: string;
  operands: (FragmentOperand & { index: number; negatedGuard?: string })[];
  children: Node[];
}

/**
 * Fragments of one owner message, outer before inner, in message order. `collapsed` maps the ids
 * of minimized fragments (FR-1.12) to their folded call count; such a fragment's calls are
 * represented by one child whose id is the fragment id and whose innermost scope is the fragment.
 */
export function buildFragments(
  ownerMessageId: string,
  children: ScopedChild[],
  collapsed: ReadonlyMap<string, number> = new Map(),
  /** FR-1.15: exit markers among the children — they join frames but never make one on their own. */
  markers: ReadonlySet<string> = new Set(),
  folds: FragmentFolds = {},
): Fragment[] {
  const followed = folds.followed ?? new Map<string, number>();
  const roots: Node[] = [];
  const open: Node[] = [];
  for (const child of children) {
    const scopes = child.scopes ?? [];
    // keep the open fragments that still enclose this child (same construct, same operand)
    let k = 0;
    while (k < open.length && k < scopes.length && open[k].scope.id === scopes[k].id && currentOperand(open[k]).index === scopes[k].operand) k++;
    const sameConstruct = k < open.length && k < scopes.length && open[k].scope.id === scopes[k].id;
    open.length = sameConstruct ? k + 1 : k;
    if (sameConstruct) {
      // next operand of an alt / try that is already open
      open[k].operands.push(operandOf(scopes[k], child.id));
      k++;
    }
    for (; k < scopes.length; k++) {
      const node: Node = {
        scope: scopes[k],
        kind: scopes[k].kind,
        id: `${ownerMessageId}#${scopes[k].id}`,
        operands: [operandOf(scopes[k], child.id)],
        children: [],
      };
      (k === 0 ? roots : open[k - 1].children).push(node);
      open.push(node);
    }
    for (const node of open) currentOperand(node).lastMessageId = child.id;
  }
  const nextChild = new Map(children.map((c, i) => [c.id, children[i + 1]?.id]));
  const position = new Map(children.map((c, i) => [c.id, i]));
  /** An operand with at least one message or stub (not only exit markers). */
  const hasContent = (op: { firstMessageId: string; lastMessageId: string }): boolean => {
    const from = position.get(op.firstMessageId)!;
    const to = position.get(op.lastMessageId)!;
    for (let i = from; i <= to; i++) if (!markers.has(children[i].id)) return true;
    return false;
  };
  /** Drops marker-only operands; a frame left without operands is replaced by its inner frames. */
  const prune = (nodes: Node[]): Node[] =>
    nodes.flatMap((node) => {
      const children = prune(node.children);
      // a minimized frame keeps its operand: its stub is a call, never a marker
      const operands = node.operands.filter(hasContent);
      return operands.length ? [{ ...node, operands, children }] : children;
    });
  const out: Fragment[] = [];
  const emit = (nodes: Node[], parentId: string | undefined): void => {
    for (const node of simplify(nodes, collapsed, followed)) {
      const fragment = collapsed.has(node.id)
        ? collapsedFragment(node, ownerMessageId, parentId, collapsed.get(node.id)!, nextChild.get(node.id))
        : toFragment(node, ownerMessageId, parentId, followed.get(node.id), folds.errorPaths);
      if (fragment) out.push(fragment);
      emit(node.children, fragment ? fragment.id : parentId);
    }
  };
  emit(markers.size ? prune(roots) : roots, undefined);
  return out;
}

function currentOperand(node: Node) {
  return node.operands[node.operands.length - 1];
}

function operandOf(scope: FragmentScope, messageId: string): Node['operands'][number] {
  return {
    index: scope.operand,
    ...(scope.guard !== undefined ? { guard: scope.guard } : {}),
    ...(scope.negatedGuard !== undefined ? { negatedGuard: scope.negatedGuard } : {}),
    ...(scope.range ? { range: scope.range } : {}),
    firstMessageId: messageId,
    lastMessageId: messageId,
  };
}

/**
 * Clutter reduction among siblings: an `opt` whose only content is another `opt` around the
 * same messages becomes one `opt [a && b]`.
 */
function simplify(nodes: Node[], collapsed: ReadonlyMap<string, number>, followed: ReadonlyMap<string, number>): Node[] {
  // a followed alt keeps its frame: it says other cases exist (FR-1.22)
  const kept = (id: string) => collapsed.has(id) || followed.has(id);
  return nodes.map((node) => {
    while (
      !kept(node.id) &&
      !node.children.some((c) => kept(c.id)) &&
      (node.kind === 'opt' || (node.kind === 'alt' && node.operands.length === 1))
    ) {
      const inner = node.children.length === 1 ? node.children[0] : undefined;
      const op = node.operands[0];
      // an inner alt with two branches spans more calls than its first one: the span check below stops it
      const innerSingle = inner && (inner.kind === 'opt' || inner.kind === 'alt');
      if (!inner || !innerSingle || node.operands.length !== 1) break;
      const iop = inner.operands[0];
      if (iop.firstMessageId !== op.firstMessageId || iop.lastMessageId !== op.lastMessageId) break;
      const g1 = singleGuard(op);
      const g2 = singleGuard(iop);
      if (g1 === undefined || g2 === undefined) break;
      node = {
        ...node,
        kind: 'opt',
        operands: [{ ...op, guard: `${paren(g1)} && ${paren(g2)}`, negatedGuard: undefined, index: 0 }],
        children: inner.children,
      };
    }
    return node;
  });
}

/** Guard of an operand drawn as the only one ([else] needs its negated condition), or undefined. */
function singleGuard(op: Node['operands'][number]): string | undefined {
  if (op.guard === 'else') return op.negatedGuard;
  return op.guard;
}

function paren(g: string): string {
  return /\|\||\?|\s(or|and)\s/.test(g) && !/^\(.*\)$/.test(g) ? `(${g})` : g;
}

/** FR-1.12: a minimized fragment — the construct as written (no alt→opt rewrite), first guard only. */
function collapsedFragment(node: Node, ownerMessageId: string, parentId: string | undefined, hiddenCount: number, beforeId: string | undefined): Fragment {
  const op = node.operands[0];
  return {
    id: node.id,
    kind: node.kind,
    ownerMessageId,
    ...(parentId ? { parentId } : {}),
    operands: [{ ...(op.guard !== undefined ? { guard: op.guard } : {}), ...(op.range ? { range: op.range } : {}), firstMessageId: node.id, lastMessageId: node.id }],
    ...(op.range ? { range: op.range } : {}),
    collapsed: true,
    hiddenCount,
    ...(beforeId ? { beforeId } : {}),
  };
}

function toFragment(
  node: Node,
  ownerMessageId: string,
  parentId: string | undefined,
  otherCases: number | undefined,
  errorPaths: ReadonlyMap<string, ErrorPathFold> = new Map(),
): Fragment | undefined {
  let kind = node.kind;
  let operands = node.operands;
  let catches: CatchRow[] = [];
  let outcomes = new Map<number, CatchHandler>();
  if (kind === 'try') {
    // FR-1.17 catch clauses without visible calls are rows saying what happens to the error; one that
    // rethrows hides nothing — unless Smart folded its calls (FR-3.11: the row is what is left of them).
    // A try whose catches all rethrow (and have no visible calls) says nothing: no frame.
    const fold = (h: CatchHandler) => errorPaths.get(`${node.id}#${h.operand}`);
    const handlers = (node.scope.handlers ?? []).filter((h) => h.outcome !== 'rethrow' || fold(h));
    const visible = new Set(operands.map((o) => o.index));
    catches = handlers.filter((h) => !visible.has(h.operand)).map((h) => catchRow(h, fold(h)));
    outcomes = new Map(handlers.filter((h) => h.outcome !== 'rethrow').map((h) => [h.operand, h]));
    if (!operands.some((o) => o.index > 0) && !catches.length) return undefined;
  }
  if (kind === 'alt' && operands.length === 1 && otherCases === undefined) {
    // one visible branch: "only when …" — drawn as opt, with the negated condition for an else branch
    const guard = singleGuard(operands[0]);
    if (guard !== undefined) {
      kind = 'opt';
      operands = [{ ...operands[0], guard }];
    }
  }
  return {
    id: node.id,
    kind,
    ownerMessageId,
    ...(parentId ? { parentId } : {}),
    operands: operands.map(({ index, negatedGuard: _n, ...o }) => {
      const h = index > 0 ? outcomes.get(index) : undefined;
      if (h) return { ...o, outcome: outcomeText(h), ...(isSwallowed(h) ? { swallowed: true } : {}) };
      // FR-1.22 an alt's operand names its case (to follow it)
      return kind === 'alt' ? { ...o, case: index } : o;
    }),
    ...(node.operands[0].range ? { range: node.operands[0].range } : {}),
    ...(catches.length ? { catches } : {}),
    ...(otherCases !== undefined ? { followed: { otherCases } } : {}),
  };
}

/** FR-1.17 the error ends in the clause: not rethrown, not returned as a value (a bare `return;` counts as swallowed). */
export function isSwallowed(h: CatchHandler): boolean {
  return h.outcome === 'swallow' || h.outcome === 'skip' || (h.outcome === 'return' && !h.value);
}

/** "logged, swallowed", "↩ null", "logged, ↩ false", "skipped". */
export function outcomeText(h: CatchHandler): string {
  const what = h.outcome === 'return' && h.value ? `↩ ${h.value}` : h.outcome === 'skip' ? 'skipped' : 'swallowed';
  return h.logged ? `logged, ${what}` : what;
}

function catchRow(h: CatchHandler, errorPath: ErrorPathFold | undefined): CatchRow {
  const rethrows = h.outcome === 'rethrow';
  return {
    guard: h.guard,
    outcome: rethrows ? '' : outcomeText(h),
    swallowed: !rethrows && isSwallowed(h),
    ...(h.range ? { range: h.range } : {}),
    ...(errorPath ? { errorPath } : {}),
  };
}
