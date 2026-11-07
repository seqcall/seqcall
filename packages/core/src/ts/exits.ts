import ts from 'typescript';
import type { EarlyExit } from '../adapter';
import { fragmentScopes } from './fragments';
import { type CallableNode, type TsModel } from './model';
import { expressionText } from './resolve';

/**
 * FR-1.15: `return` / `throw` statements of a callable body that are not in tail position — on
 * some other path the method continues after them. Nested functions (lambdas, local functions,
 * classes) are not part of the body.
 */
export function earlyExits(model: TsModel, node: CallableNode): EarlyExit[] {
  if (ts.isClassLike(node)) return [];
  const fn = model.functionOf(node) as ts.FunctionLikeDeclaration | undefined;
  const body = fn?.body;
  if (!body || !ts.isBlock(body)) return [];
  const sf = body.getSourceFile();
  const out: EarlyExit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if ((ts.isReturnStatement(n) || ts.isThrowStatement(n)) && !isTail(n, body)) {
      const scopes = fragmentScopes(n);
      out.push({
        kind: ts.isReturnStatement(n) ? 'return' : 'throw',
        range: model.range(n, sf),
        ...(ts.isThrowStatement(n) && n.expression ? { exception: thrown(n.expression, sf) } : {}),
        ...(ts.isReturnStatement(n) ? { value: n.expression ? expressionText(n.expression, sf) : '' } : {}),
        ...(scopes ? { fragments: scopes } : {}),
      });
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/** `throw new NotFound(…)` → NotFound; `throw err` → err. */
function thrown(e: ts.Expression, sf: ts.SourceFile): string {
  return ts.isNewExpression(e) ? e.expression.getText(sf) : expressionText(e, sf);
}

/** Nothing of the method runs after `stmt` on its path: last statement all the way up to the body. */
export function isTail(stmt: ts.Statement, body: ts.Block): boolean {
  let node: ts.Node = stmt;
  for (;;) {
    // `stmt` is inside `body`: the walk ends at `body` at the latest
    const parent = node.parent;
    if (ts.isBlock(parent)) {
      const rest = parent.statements.slice(parent.statements.indexOf(node as ts.Statement) + 1);
      if (rest.some((s) => !ts.isFunctionDeclaration(s) && !ts.isEmptyStatement(s))) return false;
      if (parent === body) return true;
    } else if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      const rest = parent.statements.slice(parent.statements.indexOf(node as ts.Statement) + 1);
      if (rest.some((s) => !ts.isBreakStatement(s) && !ts.isEmptyStatement(s))) return false;
    } else if (ts.isIterationStatement(parent, false)) {
      return false; // the loop goes on
    } else if (
      !ts.isIfStatement(parent) && !ts.isCaseBlock(parent) && !ts.isSwitchStatement(parent) && !ts.isTryStatement(parent) &&
      !ts.isCatchClause(parent) && !ts.isLabeledStatement(parent)
    ) {
      return false;
    }
    node = parent;
  }
}
