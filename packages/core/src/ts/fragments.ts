/**
 * Combined fragments (FR-1.10): the control-flow constructs of the analysed body that enclose
 * a call. Walks from the call up to the enclosing function: the analysed callable, or the lambda
 * whose body the call is in (the caller prepends the lambda's own scopes, FR-1.11).
 */
import ts from 'typescript';
import type { SourceRange } from '@seqcall/protocol';
import type { CatchHandler, FragmentScope } from '../adapter';
import { compactValue, isLogCall } from '../catch-outcome';
import { normalizePath } from './paths';
import { expressionText } from './resolve';

/** Array / iterable methods whose callback runs once per element (FR-1.11). */
const ITERATION = new Set(['forEach', 'map', 'flatMap', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'reduce', 'reduceRight', 'sort', 'toSorted']);

/**
 * FR-1.11: the scope of the calls inside a lambda passed to a library function — `loop` for
 * iteration methods (`each u of users`), `callback` otherwise (`[promise.then]`).
 */
export function lambdaScope(call: ts.CallExpression | ts.NewExpression, lambda: ts.ArrowFunction | ts.FunctionExpression, property?: string): FragmentScope {
  const sf = call.getSourceFile();
  const start = lambda.getStart(sf);
  const range = rangeFrom(sf, start, lambda.parameters.end + 1);
  const callee = ts.isCallExpression(call) ? call.expression : undefined;
  const method = callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  if (!property && callee && ts.isPropertyAccessExpression(callee) && method && ITERATION.has(method) && method !== 'sort' && method !== 'toSorted') {
    const element = lambda.parameters[method.startsWith('reduce') ? 1 : 0];
    const collection = chainText(callee.expression, sf);
    const guard = element ? `each ${text(element.name, sf)} of ${collection}` : `each of ${collection}`;
    return { id: `cb@${start}`, kind: 'loop', operand: 0, guard, range };
  }
  const target = ts.isNewExpression(call) ? `new ${chainText(call.expression, sf)}` : chainText(call.expression, sf);
  const when = property ? undefined : whenItRuns(call, lambda, sf);
  return { id: `cb@${start}`, kind: 'callback', operand: 0, guard: property ? `${target}: ${property}` : when ? `${target}: ${when}` : target, range };
}

/**
 * FR-1.11 a handler given to a JSX prop: `callback [BuyNowBtn onClick: on click]`; other props by name
 * (`callback [List renderItem]`).
 */
export function jsxHandlerScope(attr: ts.JsxAttribute, handler: ts.FunctionLikeDeclaration): FragmentScope {
  const sf = attr.getSourceFile();
  const start = attr.getStart(sf);
  const element = attr.parent.parent;
  const tag = element.tagName.getText(sf).split('.').pop();
  const prop = attr.name.getText(sf);
  const event = /^on[A-Z]/.test(prop) ? prop.slice(2).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : undefined;
  const guard = `${tag} ${prop}${event ? `: on ${event}` : ''}`;
  return { id: `jsx@${start}:${handler.getStart(sf)}`, kind: 'callback', operand: 0, guard, range: rangeFrom(sf, start, attr.end) };
}

/**
 * FR-1.11 when a callback runs, for the ones whose timing the code says: React effects by their dependencies
 * (`useEffect: when user changes`, `on mount`, `after every render`), `useCallback` (when called), timers
 * (`setInterval: every 5000 ms`), DOM events (`addEventListener: on click`). Other callbacks: undefined.
 */
function whenItRuns(call: ts.CallExpression | ts.NewExpression, lambda: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
  const args = call.arguments;
  if (args[0] !== lambda && name !== 'addEventListener') return undefined;
  const deps = (d: ts.Expression | undefined, none: string): string | undefined => {
    if (!d) return none;
    if (!ts.isArrayLiteralExpression(d)) return undefined;
    if (!d.elements.length) return 'on mount';
    const names = d.elements.map((e) => text(e, sf));
    return `when ${names.join(', ')} change${names.length === 1 ? 's' : ''}`;
  };
  switch (name) {
    case 'useEffect':
    case 'useLayoutEffect':
    case 'useInsertionEffect':
      return deps(args[1], 'after every render');
    case 'useMemo':
      return deps(args[1], 'every render')?.replace('on mount', 'once');
    case 'useCallback':
      return 'when called';
    case 'setInterval':
      return args[1] ? `every ${text(args[1], sf)} ms` : undefined;
    case 'setTimeout':
      return `after ${args[1] ? text(args[1], sf) : 0} ms`;
    case 'requestAnimationFrame':
      return 'next frame';
    case 'addEventListener':
      return args[1] === lambda && args[0] && ts.isStringLiteralLike(args[0]) ? `on ${args[0].text}` : undefined;
    default:
      return undefined;
  }
}

/** `users.filter(…).map` — a call chain with argument lists collapsed. */
function chainText(e: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isCallExpression(e)) return `${chainText(e.expression, sf)}(${e.arguments.length ? '…' : ''})`;
  if (ts.isPropertyAccessExpression(e)) return `${chainText(e.expression, sf)}.${e.name.text}`;
  return text(e, sf);
}

export function fragmentScopes(call: ts.Node): FragmentScope[] | undefined {
  const sf = call.getSourceFile();
  const scopes: FragmentScope[] = [];
  let child: ts.Node = call;
  for (let n = call.parent; n && !ts.isFunctionLike(n) && !ts.isClassLike(n) && !ts.isSourceFile(n); child = n, n = n.parent) {
    const scope = scopeOf(sf, n, child);
    if (scope) scopes.push(scope.kind === 'loop' && ts.isIterationStatement(n, false) && leavesLoop(call, n) ? { ...scope, leavesLoop: true } : scope);
  }
  return scopes.length ? scopes.reverse() : undefined;
}

/**
 * FR-19.1 the call runs at most once per loop: its statement (in the innermost block below the loop) is a `return` /
 * `throw`, or one follows it in that block before a `continue` / `break`.
 */
function leavesLoop(call: ts.Node, loop: ts.Node): boolean {
  const exits = (s: ts.Node) => ts.isReturnStatement(s) || ts.isThrowStatement(s);
  for (let n = call.parent; n && n !== loop; n = n.parent) if (exits(n)) return true; // `if (x) return f();`
  let child = call;
  for (let n = call.parent; n && n !== loop; child = n, n = n.parent) {
    const list = ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : undefined;
    if (!list) continue;
    const i = list.indexOf(child as ts.Statement);
    if (i < 0) return false;
    for (let k = i; k < list.length; k++) {
      if (exits(list[k])) return true;
      if (k > i && (ts.isContinueStatement(list[k]) || ts.isBreakStatement(list[k]))) return false;
    }
    return false;
  }
  return false;
}

const text = (n: ts.Node, sf: ts.SourceFile): string => expressionText(n, sf);

function rangeFrom(sf: ts.SourceFile, start: number, end: number): SourceRange {
  return {
    file: normalizePath(sf.fileName),
    start: sf.getLineAndCharacterOfPosition(start),
    end: sf.getLineAndCharacterOfPosition(end),
  };
}

/** Negation for display: `!x`, `!a.b()`, otherwise `!(…)`. */
export function negate(guard: string): string {
  if (/^!\s*[\w$.]+$/.test(guard)) return guard.replace(/^!\s*/, '');
  return /^[\w$.]+(\(\))?$/.test(guard) ? `!${guard}` : `!(${guard})`;
}

/** A chain of `if … else if … else` (links share the head) or of nested `?:` in the false branch. */
interface Chain {
  head: ts.Node;
  /** Conditions of the links, in order. */
  conditions: ts.Expression[];
  hasElse: boolean;
}

function ifChain(n: ts.IfStatement): { chain: Chain; index: number } {
  let head = n;
  let index = 0;
  while (ts.isIfStatement(head.parent) && head.parent.elseStatement === head) {
    head = head.parent;
    index++;
  }
  const conditions: ts.Expression[] = [];
  let link: ts.Statement | undefined = head;
  let hasElse = false;
  while (link) {
    if (ts.isIfStatement(link)) {
      conditions.push(link.expression);
      link = link.elseStatement;
    } else {
      hasElse = true;
      link = undefined;
    }
  }
  return { chain: { head, conditions, hasElse }, index };
}

function conditionalChain(n: ts.ConditionalExpression): { chain: Chain; index: number } {
  let head = n;
  let index = 0;
  while (ts.isConditionalExpression(head.parent) && head.parent.whenFalse === head) {
    head = head.parent;
    index++;
  }
  const conditions: ts.Expression[] = [];
  let link: ts.Expression = head;
  while (ts.isConditionalExpression(link)) {
    conditions.push(link.condition);
    link = link.whenFalse;
  }
  return { chain: { head, conditions, hasElse: true }, index };
}

function chainScope(sf: ts.SourceFile, chain: Chain, operand: number, elseNode: ts.Node | undefined): FragmentScope {
  const kind = chain.conditions.length === 1 && !chain.hasElse ? 'opt' : 'alt';
  const id = `${chain.head.kind === ts.SyntaxKind.IfStatement ? 'if' : 'cond'}@${chain.head.getStart(sf)}`;
  if (operand < chain.conditions.length) {
    const cond = chain.conditions[operand];
    return { id, kind, operand, guard: text(cond, sf), range: rangeFrom(sf, cond.getStart(sf), cond.getEnd()) };
  }
  // the else operand: scopeOf passes the `else` keyword / the `:` token (an if with an else statement has the keyword)
  const start = elseNode!.getStart(sf);
  return {
    id,
    kind,
    operand,
    guard: 'else',
    ...(chain.conditions.length === 1 ? { negatedGuard: negate(text(chain.conditions[0], sf)) } : {}),
    range: rangeFrom(sf, start, start),
  };
}

/** The `else` keyword before an else statement (navigation target of an else operand). */
function elseKeyword(n: ts.IfStatement, sf: ts.SourceFile): ts.Node | undefined {
  return n.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ElseKeyword);
}

function isJsx(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e);
}

function scopeOf(sf: ts.SourceFile, n: ts.Node, child: ts.Node): FragmentScope | undefined {
  if (ts.isIfStatement(n)) {
    const { chain, index } = ifChain(n);
    if (child === n.expression) return index === 0 ? undefined : chainScope(sf, chain, index, undefined);
    if (child === n.thenStatement) return chainScope(sf, chain, index, undefined);
    if (child === n.elseStatement && !ts.isIfStatement(n.elseStatement)) return chainScope(sf, chain, index + 1, elseKeyword(n, sf));
    return undefined; // else-if: the inner link reports the scope
  }
  if (ts.isConditionalExpression(n)) {
    const { chain, index } = conditionalChain(n);
    if (child === n.condition) return index === 0 ? undefined : chainScope(sf, chain, index, undefined);
    if (child === n.whenTrue) return chainScope(sf, chain, index, undefined);
    if (child === n.whenFalse && !ts.isConditionalExpression(n.whenFalse)) {
      const colon = n.colonToken;
      return chainScope(sf, chain, index + 1, colon);
    }
    return undefined;
  }
  // FR-1.20 `cond && <Panel />`: the element renders only when `cond` holds
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === n.right && isJsx(n.right)) {
    return { id: `and@${n.getStart(sf)}`, kind: 'opt', operand: 0, guard: text(n.left, sf), range: rangeFrom(sf, n.left.getStart(sf), n.left.getEnd()) };
  }
  if (ts.isCaseClause(n) || ts.isDefaultClause(n)) return switchScope(sf, n);
  if (ts.isForStatement(n)) {
    if (child === n.initializer) return undefined;
    return loopScope(sf, n, n.condition ? text(n.condition, sf) : undefined, n.condition);
  }
  if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
    if (child !== n.statement) return undefined;
    const init = n.initializer;
    const variable = ts.isVariableDeclarationList(init) ? init.declarations.map((d) => text(d.name, sf)).join(', ') : text(init, sf);
    const guard = `each ${variable} ${ts.isForOfStatement(n) ? 'of' : 'in'} ${text(n.expression, sf)}`;
    return loopScope(sf, n, guard, undefined, n.expression.getEnd() + 1);
  }
  if (ts.isWhileStatement(n) || ts.isDoStatement(n)) return loopScope(sf, n, text(n.expression, sf), n.expression);
  if (ts.isTryStatement(n)) {
    const id = `try@${n.getStart(sf)}`;
    const handlers = catchHandlers(sf, n);
    if (child === n.tryBlock) {
      const start = n.getStart(sf);
      return { id, kind: 'try', operand: 0, range: rangeFrom(sf, start, start + 3), handlers };
    }
    if (child === n.catchClause) {
      const c = n.catchClause;
      return { id, kind: 'try', operand: 1, guard: catchGuard(sf, c), range: rangeFrom(sf, c.getStart(sf), c.block.getStart(sf)), handlers };
    }
    return undefined; // finally always runs
  }
  return undefined;
}

function loopScope(sf: ts.SourceFile, n: ts.IterationStatement, guard: string | undefined, cond: ts.Node | undefined, headerEnd?: number): FragmentScope {
  const start = n.getStart(sf);
  const range = cond ? rangeFrom(sf, cond.getStart(sf), cond.getEnd()) : rangeFrom(sf, start, headerEnd ?? start);
  return { id: `loop@${start}`, kind: 'loop', operand: 0, guard, range }; // no guard: `for (;;)`
}

/**
 * `switch`: one operand per group of clauses (empty clauses fall through into the next one).
 * Guard `x = A | B`; the group containing `default` is `else`.
 */
function switchScope(sf: ts.SourceFile, clause: ts.CaseClause | ts.DefaultClause): FragmentScope {
  const sw = clause.parent.parent;
  const groups: (ts.CaseClause | ts.DefaultClause)[][] = [];
  let current: (ts.CaseClause | ts.DefaultClause)[] = [];
  for (const c of clause.parent.clauses) {
    current.push(c);
    if (c.statements.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  const operand = groups.findIndex((g) => g.includes(clause));
  const group = groups[operand];
  const hasDefault = groups.some((g) => g.some(ts.isDefaultClause));
  const kind = groups.length === 1 && !hasDefault ? 'opt' : 'alt';
  const disc = text(sw.expression, sf);
  const guard = group.some(ts.isDefaultClause)
    ? 'else'
    : `${disc} = ${group.map((c) => text((c as ts.CaseClause).expression, sf)).join(' | ')}`;
  const first = group[0];
  const labelEnd = (first as ts.CaseClause).expression?.getEnd() ?? first.getStart(sf) + 'default'.length;
  return { id: `switch@${sw.getStart(sf)}`, kind, operand, guard, range: rangeFrom(sf, first.getStart(sf), labelEnd) };
}

function catchGuard(sf: ts.SourceFile, c: ts.CatchClause): string {
  return c.variableDeclaration?.type ? `catch ${text(c.variableDeclaration.type, sf)}` : 'catch';
}

/** FR-1.17 what the catch clause does with the error (statements inside nested functions do not count). */
function catchHandlers(sf: ts.SourceFile, n: ts.TryStatement): CatchHandler[] {
  const c = n.catchClause;
  if (!c) return [];
  let outcome: CatchHandler['outcome'] = 'swallow';
  let value: string | undefined;
  let logged = false;
  const visit = (x: ts.Node): void => {
    if (ts.isFunctionLike(x) || ts.isClassLike(x)) return;
    if (ts.isThrowStatement(x)) outcome = 'rethrow';
    else if (ts.isReturnStatement(x) && outcome !== 'rethrow') {
      outcome = 'return';
      value ??= x.expression ? compactValue(x.expression.getText(sf)) : undefined;
    } else if (ts.isContinueStatement(x) && outcome === 'swallow') outcome = 'skip';
    else if (ts.isCallExpression(x)) {
      const e = x.expression;
      if (ts.isPropertyAccessExpression(e) ? isLogCall(e.expression.getText(sf), e.name.text) : ts.isIdentifier(e) && isLogCall(undefined, e.text)) logged = true;
    }
    ts.forEachChild(x, visit);
  };
  visit(c.block);
  return [{ operand: 1, guard: catchGuard(sf, c), outcome, ...(value ? { value } : {}), logged, range: rangeFrom(sf, c.getStart(sf), c.block.getStart(sf)) }];
}
