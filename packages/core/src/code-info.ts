/**
 * FR-33 what the editor's hover says about the code under the cursor: which call it is, what runs there (the same
 * choice the sequence diagram makes, FR-8.6), who reaches a method (FR-22) — and the hover's text, shared by hosts.
 */
import type { CallPathNode, CallPathStep, ClassRef, CodeCallInfo, CodeInfo, CodeReach, EntryPoint, MethodRef, Position, SourceRange } from '@seqcall/protocol';
import type { CallSite } from './adapter';
import type { BindingLookup } from './session/bindings';
import { SIDE_EFFECT_LABEL, withLambdaCalls } from './side-effects';

/** Entry points / candidates a hover lists before "+n". */
export const CODE_INFO_LISTED = 5;

/** A line starting with this is an item of the line above it (a host may show it as a list item). */
export const CODE_INFO_ITEM = '  · ';

const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character < b.character);
const holds = (r: SourceRange, p: Position) => !before(p, r.start) && !before(r.end, p);
/** Smaller first: fewer lines, then fewer characters on the last line. */
const span = (r: SourceRange) => [r.end.line - r.start.line, r.end.character - (r.end.line === r.start.line ? r.start.character : 0)];

/**
 * The call under the cursor: the innermost call whose range holds the position (`a(b())` on `b`: `b`). With `word`
 * (the name under the cursor) only a call of that name — a hover on an argument or a variable is no hover on the call.
 */
export function callAt(calls: CallSite[], position: Position, word?: string): CallSite | undefined {
  const named = (c: CallSite) => word === undefined || c.methodName === word || (c.kind === 'create' && c.receiverType?.name === word);
  const hits = withLambdaCalls(calls).filter((c) => holds(c.range, position) && named(c));
  return hits.sort((a, b) => {
    const [la, ca] = span(a.range);
    const [lb, cb] = span(b.range);
    return la - lb || ca - cb;
  })[0];
}

/**
 * What runs at a call whose target has no body (an interface or abstract member), decided as the diagram decides it
 * without a path from an entry point: the object created in the same method, the class's own override, the
 * container's binding, the only implementation. Otherwise the candidates (`fromCaller`: a parameter — the caller's
 * object decides).
 */
export function whatRuns(
  call: CallSite,
  enclosing: MethodRef,
  calls: CallSite[],
  implementations: MethodRef[],
  opts: { bindings?: BindingLookup; autoSelect?: boolean } = {},
): Omit<CodeCallInfo, 'target' | 'io'> {
  const target = call.target;
  if (!target || target.hasBody || call.isLibrary || call.kind !== 'call' || !implementations.length) return {};
  const of = (classKey: string | undefined) => (classKey ? implementations.find((i) => i.owner.key === classKey) : undefined);
  const r = call.receiver;
  // `new X().m()`, or `const x = new X(); x.m()` earlier in the same body
  const all = withLambdaCalls(calls);
  const created =
    r.kind === 'created'
      ? all.find((c) => c.kind === 'create' && c.ordinal === r.ordinal)
      : r.kind === 'local'
        ? all.filter((c) => c.kind === 'create' && c.assignedTo?.kind === 'local' && c.assignedTo.name === r.name && before(c.range.start, call.range.start)).pop()
        : undefined;
  const made = of(created?.receiverType?.key);
  if (made) return { runs: { method: made, why: 'created' } };
  const own = r.kind === 'self' ? of(enclosing.owner.key) : undefined;
  if (own) return { runs: { method: own, why: 'self' } };
  const typeArgs = call.typeArguments?.flatMap((a) => (a.type ? [a.type.key] : []));
  const bound = opts.bindings?.bound(r.kind === 'field' ? enclosing.owner.key : undefined, target.owner.key, typeArgs);
  const boundImpl = of(bound?.classKey);
  if (bound && boundImpl) return { runs: { method: boundImpl, why: 'container', at: bound.at } };
  if (opts.autoSelect !== false && implementations.length === 1) return { runs: { method: implementations[0], why: 'only-implementation' } };
  const keyed = opts.bindings?.keyed(target.owner.key)?.flatMap((k) => {
    const impl = of(k.classKey);
    return impl ? [{ className: impl.owner.name, key: k.key }] : [];
  });
  const candidates: ClassRef[] = implementations.slice(0, CODE_INFO_LISTED).map((i) => i.owner);
  return {
    candidates,
    ...(implementations.length > CODE_INFO_LISTED ? { more: implementations.length - CODE_INFO_LISTED } : {}),
    ...(r.kind === 'parameter' ? { fromCaller: true } : {}),
    ...(keyed?.length ? { keyed } : {}),
  };
}

/** The entry points and test methods a paths-to-here tree (FR-22) reaches; each entry point with its shortest path down. */
export function reachOf(tree: CallPathNode, truncated: boolean): CodeReach {
  const entries = new Map<string, { entryPoint: EntryPoint; steps: CallPathStep[] }>();
  const tests = new Set<string>();
  // `chain`: the nodes from here down to the target (the tree's root), as the path's steps
  const visit = (n: CallPathNode, chain: CallPathNode[]) => {
    const here = [n, ...chain];
    for (const e of n.entryPoints ?? []) {
      if (e.kind === 'test') {
        tests.add(n.method.key);
        continue;
      }
      const key = `${e.kind}|${e.label}`;
      const known = entries.get(key);
      if (!known || known.steps.length > here.length) entries.set(key, { entryPoint: e, steps: here.map(step) });
    }
    if (n.inTest) tests.add(n.method.key);
    for (const c of n.callers ?? []) visit(c, here);
  };
  visit(tree, []);
  const routes = [...entries.values()];
  return {
    entryPoints: routes.slice(0, CODE_INFO_LISTED).map((r) => r.entryPoint),
    more: Math.max(0, routes.length - CODE_INFO_LISTED),
    tests: tests.size,
    cut: truncated,
    routes,
  };
}

/** A node of the tree as an `openPath` step: the method, and the call in it towards the target. */
const step = (n: CallPathNode): CallPathStep => ({ methodKey: n.method.key, ...(n.call ? { call: { range: n.call.range, ...(n.call.passed ? { passed: true } : {}) } } : {}) });

const kinds = (io: { kinds: (keyof typeof SIDE_EFFECT_LABEL)[] }) => io.kinds.map((k) => SIDE_EFFECT_LABEL[k]).join(', ');
const named = (m: MethodRef) => `${m.owner.name}.${m.name}`;

/**
 * The hover's lines (plain text; hosts add their links): only what says something — no line for "nothing found".
 * Lines starting with CODE_INFO_ITEM belong to the line above (the entry points under their heading).
 * `root`: the project root, to write a registration's file relative to it.
 */
export function codeInfoLines(info: CodeInfo, root?: string): string[] {
  const rel = (file: string) => {
    const f = file.replace(/\\/g, '/');
    const r = root?.replace(/\\/g, '/').replace(/\/$/, '');
    return r && f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
  };
  const lines: string[] = [];
  const c = info.call;
  if (c) {
    if (c.runs) {
      const why =
        c.runs.why === 'container'
          ? `the DI container binds it${c.runs.at ? `, ${rel(c.runs.at.file)}:${c.runs.at.start.line + 1}` : ''}`
          : c.runs.why === 'created'
            ? 'the object created here'
            : c.runs.why === 'self'
              ? 'its own override'
              : 'the only implementation';
      lines.push(`→ runs ${named(c.runs.method)} (${why})`);
    } else if (c.candidates?.length) {
      const names = c.candidates.map((k) => k.name).join(', ');
      lines.push(`→ runs one of ${names}${c.more ? ` +${c.more}` : ''}${c.fromCaller ? ' (the caller decides)' : ''}`);
    }
    if (c.keyed?.length) lines.push(`→ chosen at run time: ${c.keyed.map((k) => `${k.className} (${k.key})`).join(', ')}`);
    // a library call does the I/O itself; a project call somewhere below
    if (c.io) lines.push(`↯ ${kinds(c.io)}${!c.target || c.target.key.startsWith('lib:') ? '' : ' below'}`);
    return lines;
  }
  const r = info.reach;
  if (r?.entryPoints.length) {
    // the heading with the counts, then one entry point per line (routes are long: a list reads, a sentence does not)
    const total = r.entryPoints.length + r.more;
    const tests = r.tests ? ` · ${r.tests} test${r.tests === 1 ? '' : 's'}` : '';
    lines.push(`⌂ reached from ${total} entry point${total === 1 ? '' : 's'}${tests}${r.cut ? ' (more paths not followed)' : ''}`);
    for (const e of r.entryPoints) lines.push(`${CODE_INFO_ITEM}${e.label}`);
    if (r.more) lines.push(`${CODE_INFO_ITEM}+${r.more} more`);
  } else if (r?.tests && !info.unreachable) lines.push(`⌂ only tests reach it (${r.tests})${r.cut ? ' (more paths not followed)' : ''}`);
  if (info.unreachable) lines.push(`∅ no entry point reaches it: ${info.unreachable}`);
  if (info.io) lines.push(`↯ ${kinds(info.io)}`);
  if (info.pending?.includes('reach')) lines.push('⌂ still looking for callers… (ask again in a moment)');
  return lines;
}

/**
 * FR-33.6 the lines for a plain-text popup (Vim / Neovim): items numbered (`   1. GET /orders`) so a command can open
 * entry point n; `+n more` stays as it is.
 */
export function codeInfoPlain(lines: string[]): string[] {
  let n = 0;
  return lines.map((line) => {
    if (!line.startsWith(CODE_INFO_ITEM)) return line;
    const item = line.slice(CODE_INFO_ITEM.length);
    return /^\+\d+ more$/.test(item) ? `   ${item}` : `   ${++n}. ${item}`;
  });
}
