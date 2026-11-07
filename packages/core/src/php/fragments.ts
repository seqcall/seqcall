import type { SourceRange } from '@seqcall/protocol';
import type { CatchHandler, EarlyExit, FragmentScope } from '../adapter';
import { compactValue, isLogCall } from '../catch-outcome';
import { children, isNestedFunction, nameOf, rangeOf, spanOf, textOf, walk, type PNode } from './ast';
import type { PhpFile } from './project';

/**
 * FR-1.10 combined fragments for PHP: `if / elseif / else` (also `else if`), `switch`, `match`,
 * `?:`, loops (`for`, `foreach`, `while`, `do`), `try / catch`. Walks from a node up to the
 * analysed body (a nested closure / arrow function is a boundary; its own scope is added by the
 * caller, FR-1.11). Scope ids are `<kind>@<offset>` and only compared within one analysis.
 */
export function fragmentScopes(node: PNode, file: PhpFile, boundary?: PNode): FragmentScope[] | undefined {
  const scopes: FragmentScope[] = [];
  let child = node;
  for (let n = node.parent; n && n !== boundary && !isNestedFunction(n) && n.kind !== 'method'; child = n, n = n.parent) {
    const scope = scopeOf(file, n, child);
    if (scope) scopes.push(scope.kind === 'loop' && LOOPS.has(n.kind) && leavesLoop(node, n) ? { ...scope, leavesLoop: true } : scope);
  }
  return scopes.length ? scopes.reverse() : undefined;
}

const LOOPS = new Set(['foreach', 'for', 'while', 'do']);

/**
 * FR-19.1 the call runs at most once per loop: its statement (in the innermost block below the loop) is a `return` /
 * `throw`, or one follows it in that block before a `continue` / `break`.
 */
function leavesLoop(node: PNode, loop: PNode): boolean {
  const exits = (s: PNode) => s.kind === 'return' || s.kind === 'throw' || (s.kind === 'expressionstatement' && s.expression?.kind === 'throw');
  for (let n = node.parent; n && n !== loop; n = n.parent) if (exits(n)) return true; // `if ($x) return f();`
  let child = node;
  for (let n = node.parent; n && n !== loop; child = n, n = n.parent) {
    if (n.kind !== 'block') continue;
    const list: PNode[] = n.children;
    const i = list.indexOf(child);
    for (let k = i; k < list.length; k++) {
      if (exits(list[k])) return true;
      if (k > i && (list[k].kind === 'continue' || list[k].kind === 'break')) return false;
    }
    return false;
  }
  return false;
}

const text = (file: PhpFile, n: PNode | undefined) => textOf(file.src, n);
const at = (file: PhpFile, n: PNode): SourceRange => rangeOf(file.abs, n);
const off = (n: PNode) => n.loc!.start.offset;

/** `!x` for display: `!$a`, `!$a->b()`, else `!(…)`. */
export function negate(guard: string): string {
  if (/^!\s*[\w$>\-:]+$/.test(guard)) return guard.replace(/^!\s*/, '');
  return /^[\w$>\-:]+(\(\))?$/.test(guard) ? `!${guard}` : `!(${guard})`;
}

/** `if … elseif … else` chain: php-parser nests `elseif` / `else if` as an `if` in `alternate`. */
function ifChain(n: PNode): { head: PNode; index: number; conditions: PNode[]; hasElse: boolean } {
  let head = n;
  let index = 0;
  while (head.parent?.kind === 'if' && head.parent.alternate === head) {
    head = head.parent;
    index++;
  }
  const conditions: PNode[] = [];
  let link: PNode | undefined = head;
  let hasElse = false;
  while (link) {
    if (link.kind === 'if') {
      conditions.push(link.test);
      link = link.alternate ?? undefined;
    } else {
      hasElse = true;
      link = undefined;
    }
  }
  return { head, index, conditions, hasElse };
}

function scopeOf(file: PhpFile, n: PNode, child: PNode): FragmentScope | undefined {
  switch (n.kind) {
    case 'if': {
      const chain = ifChain(n);
      const kind = chain.conditions.length === 1 && !chain.hasElse ? 'opt' : 'alt';
      const id = `if@${off(chain.head)}`;
      const link = (operand: number): FragmentScope =>
        operand < chain.conditions.length
          ? // (`if (` being typed has no condition yet: the range is the if's)
            { id, kind, operand, guard: text(file, chain.conditions[operand]), range: at(file, chain.conditions[operand] ?? n) }
          : {
              id,
              kind,
              operand,
              guard: 'else',
              ...(chain.conditions.length === 1 ? { negatedGuard: negate(text(file, chain.conditions[0])) } : {}),
              range: at(file, child),
            };
      if (child === n.test) return chain.index === 0 ? undefined : link(chain.index);
      if (child === n.body) return link(chain.index);
      if (child === n.alternate && n.alternate.kind !== 'if') return link(chain.index + 1);
      return undefined; // elseif: the inner link reports it
    }
    case 'retif': {
      const id = `cond@${off(n)}`;
      if (child === n.trueExpr) return { id, kind: 'alt', operand: 0, guard: text(file, n.test), range: at(file, n.test) };
      if (child === n.falseExpr) return { id, kind: 'alt', operand: 1, guard: 'else', negatedGuard: negate(text(file, n.test)), range: at(file, child) };
      return undefined;
    }
    case 'case':
      return switchScope(file, n);
    case 'matcharm':
      return matchScope(file, n, child);
    case 'for':
      if (n.init.includes(child)) return undefined;
      return loopScope(file, n, n.test.map((t: PNode) => text(file, t)).join(', ') || undefined, n.test[0]);
    case 'foreach': {
      if (child === n.source) return undefined;
      const v = n.key ? `${text(file, n.key)} => ${text(file, n.value)}` : text(file, n.value);
      return loopScope(file, n, `each ${v} of ${text(file, n.source)}`, n.source);
    }
    case 'while':
    case 'do':
      return loopScope(file, n, text(file, n.test), n.test);
    case 'try': {
      const id = `try@${off(n)}`;
      const handlers = catchHandlers(file, n);
      if (child === n.body) return { id, kind: 'try', operand: 0, range: { file: file.abs, start: at(file, n).start, end: { line: at(file, n).start.line, character: at(file, n).start.character + 3 } }, handlers };
      const i = n.catches.indexOf(child);
      if (i >= 0) return { id, kind: 'try', operand: i + 1, guard: catchGuard(child), range: at(file, child), handlers };
      return undefined; // finally always runs
    }
    default:
      return undefined;
  }
}

function catchGuard(c: PNode): string {
  const types = c.what.map((w: PNode) => nameOf(w).replace(/^.*\\/, '')).join(' | ');
  return types ? `catch ${types}` : 'catch'; // `catch ($e)` being typed: no type yet
}

/** FR-1.17 what each catch clause does with the error (statements inside closures do not count). */
function catchHandlers(file: PhpFile, n: PNode): CatchHandler[] {
  return n.catches.map((c: PNode, i: number) => {
    let outcome: CatchHandler['outcome'] = 'swallow';
    let value: string | undefined;
    let logged = false;
    walk(c.body, (x) => {
      if (isNestedFunction(x)) return false;
      if (x.kind === 'throw') outcome = 'rethrow';
      else if (x.kind === 'return' && outcome !== 'rethrow') {
        outcome = 'return';
        value ??= x.expr ? compactValue(text(file, x.expr)) : undefined;
      } else if (x.kind === 'continue' && outcome === 'swallow') outcome = 'skip';
      else if (x.kind === 'call') {
        const w = x.what;
        if (w?.kind === 'propertylookup' || w?.kind === 'nullsafepropertylookup' || w?.kind === 'staticlookup') {
          if (isLogCall(text(file, w.what), nameOf(w.offset))) logged = true;
        } else if (w?.kind === 'name' && isLogCall(undefined, nameOf(w).replace(/^.*\\/, ''))) logged = true;
      }
    });
    return { operand: i + 1, guard: catchGuard(c), outcome, ...(value ? { value } : {}), logged, range: at(file, c) };
  });
}

function loopScope(file: PhpFile, n: PNode, guard: string | undefined, cond: PNode | undefined): FragmentScope {
  return { id: `loop@${off(n)}`, kind: 'loop', operand: 0, ...(guard ? { guard } : {}), range: cond ? at(file, cond) : at(file, n) };
}

/** `switch`: one operand per group of cases (empty cases fall through); the `default` group is `else`. */
function switchScope(file: PhpFile, c: PNode): FragmentScope | undefined {
  // (a case is always in its switch's block: php-parser reads no case elsewhere)
  const sw = c.parent!.parent!;
  const cases: PNode[] = sw.body.children;
  const groups: PNode[][] = [];
  let current: PNode[] = [];
  for (const k of cases) {
    current.push(k);
    if (k.body?.children?.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  const operand = groups.findIndex((g) => g.includes(c));
  const group = groups[operand];
  const hasDefault = groups.some((g) => g.some((k) => !k.test));
  const disc = text(file, sw.test);
  const guard = group.some((k) => !k.test) ? 'else' : `${disc} = ${group.map((k) => text(file, k.test)).join(' | ')}`;
  return { id: `switch@${off(sw)}`, kind: groups.length === 1 && !hasDefault ? 'opt' : 'alt', operand, guard, range: spanOf(file.abs, group[0], group[0].test ?? group[0]) };
}

/** `match`: one operand per arm; `default` is `else`. */
function matchScope(file: PhpFile, arm: PNode, child: PNode): FragmentScope | undefined {
  // (an arm is always in its match)
  const m = arm.parent!;
  if (child !== arm.body) return undefined;
  const operand = m.arms.indexOf(arm);
  const conds: PNode[] | null = arm.conds;
  const guard = conds ? `${text(file, m.cond)} = ${conds.map((x) => text(file, x)).join(' | ')}` : 'else';
  return { id: `match@${off(m)}`, kind: 'alt', operand, guard, range: conds?.length ? spanOf(file.abs, conds[0], conds[conds.length - 1]) : at(file, arm) };
}

/**
 * FR-1.15 `return` / `throw` that are not the last thing the method does on their path.
 * `throw` is an expression in PHP 8; it counts when it is a statement of its own.
 */
export function earlyExits(body: PNode | undefined, file: PhpFile): EarlyExit[] {
  if (!body) return [];
  const out: EarlyExit[] = [];
  const visit = (n: PNode) => {
    if (isNestedFunction(n)) return;
    const stmt = n.kind === 'return' ? n : n.kind === 'throw' && (n.parent?.kind === 'expressionstatement' || n.parent?.kind === 'block' || n.parent?.kind === 'if') ? n : undefined;
    if (stmt) {
      // (a parenthesised `(throw …);` statement: the throw has the statement's range, the statement passes through)
      if (!isTail(stmt, body)) {
        const scopes = fragmentScopes(stmt, file);
        out.push({
          kind: stmt.kind === 'return' ? 'return' : 'throw',
          range: rangeOf(file.abs, stmt),
          ...(stmt.kind === 'throw' ? { exception: thrown(stmt.what, file) } : { value: stmt.expr ? text(file, stmt.expr) : '' }),
          ...(scopes ? { fragments: scopes } : {}),
        });
      }
    }
    for (const c of children(n)) visit(c);
  };
  for (const c of children(body)) visit(c);
  return out;
}

function thrown(e: PNode | undefined, file: PhpFile): string | undefined {
  if (!e) return undefined;
  // `new X()` → X; `new $class()` → $class
  if (e.kind === 'new') return e.what.kind === 'name' ? nameOf(e.what).replace(/^.*\\/, '') : text(file, e.what);
  return text(file, e);
}

const STATEMENT_LISTS = new Set(['block', 'program', 'namespace', 'declare']);

/** Nothing of the body runs after `stmt` on its path: last statement all the way up to the body. */
function isTail(stmt: PNode, body: PNode): boolean {
  let node = stmt;
  for (;;) {
    // (the body is above every statement of it)
    const parent = node.parent!;
    // a case's statements are in its body block, checked like any other; the switch's block of cases is no
    // sequence (the cases after this one do not run after it): it passes through like the case and the switch
    const cases = parent.kind === 'block' && parent.parent?.kind === 'switch';
    if (STATEMENT_LISTS.has(parent.kind) && !cases) {
      const list: PNode[] = parent.children;
      const rest = list.slice(list.indexOf(node) + 1);
      if (rest.some((s) => s.kind !== 'break' && s.kind !== 'noop' && s.kind !== 'inline')) return false;
      if (parent === body) return true;
    } else if (LOOPS.has(parent.kind)) {
      return false; // the loop goes on
    }
    // if / else, switch / case, try / catch / finally pass through (php-parser's other statements hold no statements)
    node = parent;
  }
}
