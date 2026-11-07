import ts from 'typescript';
import type { ReturnFact, ReturnValue } from '../adapter';
import { type CallableNode, skipOuter, type TsModel } from './model';

/**
 * FR-5.8: every `return` of a callable body (an arrow function's expression body counts as one) and what it
 * returns — an array literal element by element (`return [user, status]`). Nested functions are not the body.
 */
export function returnFacts(model: TsModel, node: CallableNode): ReturnFact[] {
  if (ts.isClassLike(node)) return [];
  const fn = model.functionOf(node) as ts.FunctionLikeDeclaration | undefined;
  const body = fn?.body;
  if (!fn || !body) return [];
  const sf = body.getSourceFile();
  if (!ts.isBlock(body)) return [fact(model, fn, body, body, sf)];
  const out: ReturnFact[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isReturnStatement(n)) out.push(n.expression ? fact(model, fn, n, n.expression, sf) : { range: model.range(n, sf), values: [] });
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

function fact(model: TsModel, fn: ts.FunctionLikeDeclaration, statement: ts.Node, expression: ts.Expression, sf: ts.SourceFile): ReturnFact {
  const e = skipOuter(expression);
  const range = model.range(statement, sf);
  if (ts.isArrayLiteralExpression(e) && e.elements.length > 1 && !e.elements.some(ts.isSpreadElement)) {
    return { range, tuple: true, values: e.elements.map((x) => value(model, fn, x, sf)) };
  }
  return { range, values: [value(model, fn, e, sf)] };
}

function value(model: TsModel, fn: ts.FunctionLikeDeclaration, expression: ts.Expression, sf: ts.SourceFile): ReturnValue {
  let e = skipOuter(expression);
  if (ts.isAwaitExpression(e)) e = skipOuter(e.expression);
  const range = model.range(e, sf);
  if (e.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(e) || ts.isOmittedExpression(e) || (ts.isIdentifier(e) && e.text === 'undefined')) {
    return { range, empty: true };
  }
  if (ts.isIdentifier(e)) {
    // a local variable of this body (not a parameter, not a variable of an enclosing scope)
    const decl = model.checker.getSymbolAtLocation(e)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && enclosingFunction(decl) === fn) return { range, variable: e.text };
  }
  return { range };
}

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  let p = n.parent;
  while (p && !ts.isFunctionLike(p)) p = p.parent;
  return p;
}
