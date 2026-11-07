import type { ReturnFact, ReturnValue } from '../adapter';
import { children, isNestedFunction, nameOf, rangeOf, type PNode } from './ast';
import type { PhpFile } from './project';

/**
 * FR-5.8 every `return` of a method body and what it returns — an array literal without keys element by element
 * (`return [$order, 'ok']`). Closures and arrow functions are not the body.
 */
export function returnFacts(node: PNode, file: PhpFile): ReturnFact[] {
  const body: PNode | undefined = node.body ?? undefined;
  if (!body) return [];
  const params = new Set<string>(node.arguments.map((p: PNode) => nameOf(p)));
  const out: ReturnFact[] = [];
  const visit = (n: PNode) => {
    if (isNestedFunction(n)) return;
    if (n.kind === 'return') out.push(fact(n, file, params));
    for (const c of children(n)) visit(c);
  };
  for (const c of children(body)) visit(c);
  return out;
}

function fact(n: PNode, file: PhpFile, params: Set<string>): ReturnFact {
  const range = rangeOf(file.abs, n);
  const e: PNode | undefined = n.expr ?? undefined;
  if (!e) return { range, values: [] };
  const items: PNode[] = e.kind === 'array' ? e.items : [];
  if (items.length > 1 && items.every((i) => i && (i.kind !== 'entry' || (!i.key && !i.unpack && !i.byRef)))) {
    return { range, tuple: true, values: items.map((i) => value(i.kind === 'entry' ? i.value : i, file, params)) };
  }
  return { range, values: [value(e, file, params)] };
}

function value(e: PNode, file: PhpFile, params: Set<string>): ReturnValue {
  const range = rangeOf(file.abs, e);
  if (e.kind === 'nullkeyword') return { range, empty: true };
  // a local variable of the body (not `$this`, not a parameter)
  if (e.kind === 'variable' && typeof e.name === 'string' && e.name !== 'this' && !params.has(e.name)) return { range, variable: e.name };
  return { range };
}
