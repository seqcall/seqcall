import type { TypeUse } from '../adapter';
import { children, nameOf, rangeOf, type PNode } from './ast';
import type { Callable, PhpModel } from './model';

/**
 * FR-12.12: project classes a PHP method / function references without calling one of their methods on an object —
 * parameter / return types (also of its closures; unions, nullable), class constants and enum cases (`Status::Paid`),
 * static members (`Money::zero()`, `Config::$x`), `X::class`, `new X`, `instanceof X`, `catch (X $e)`. A constructor
 * also uses what the class's property defaults name (`private array $kinds = [Kind::A]`). Library classes (not in the
 * project or its first-party packages) and the method's own class (`self` / `static`) are skipped; `parent` is the
 * base class, already a generalization. PHPDoc types are not read: they are claims, not code. One entry per class,
 * at its first reference (source order).
 */
export function phpTypeUses(model: PhpModel, c: Callable): TypeUse[] {
  const ctx = model.context(c);
  const own = c.cls ? model.classRef(c.cls).key : undefined;
  const out = new Map<string, TypeUse>();
  const visit = (n: PNode): void => {
    if (n.kind === 'name' && isClassPosition(n)) {
      const cls = model.project.classByFqn(model.types.classRefName(n, ctx));
      if (cls) {
        const type = model.classRef(cls);
        if (type.key !== own && !out.has(type.key)) out.set(type.key, { type, range: rangeOf(c.file.abs, n) });
      }
      return;
    }
    for (const child of children(n)) visit(child);
  };
  if (c.cls && nameOf(c.node).toLowerCase() === '__construct') {
    for (const st of c.cls.node.body) if (st.kind === 'propertystatement') for (const p of st.properties) if (p.value) visit(p.value);
  }
  visit(c.node);
  return [...out.values()];
}

/**
 * A `name` node that names a class. php-parser also makes function names (`foo()`) and global constants (`PHP_EOL`)
 * `name` nodes, so the position decides.
 */
function isClassPosition(n: PNode): boolean {
  // (a name node is never the root of a callable's tree)
  const p = n.parent!;
  switch (p.kind) {
    case 'parameter':
    case 'method':
    case 'function':
    case 'closure':
    case 'arrowfunc':
      return p.type === n;
    case 'uniontype':
    case 'intersectiontype':
      return true;
    case 'staticlookup':
    case 'new':
      return p.what === n;
    case 'bin':
      return p.type === 'instanceof' && p.right === n;
    case 'catch':
      return p.what.includes(n);
    default:
      return false;
  }
}
