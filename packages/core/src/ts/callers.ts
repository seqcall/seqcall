import ts from 'typescript';
import type { CallerInfo, MethodRef } from '@seqcall/protocol';
import { type CallableNode, type TsModel, innermostNodeAt, isOuterExpression, skipOuter } from './model';
import { rendersJsx } from './react-entry-points';
import { compact } from './resolve';

/**
 * The language service's reference search; it throws on some syntax errors in any project file (a string as a
 * parameter name: `function onSave("save") {}`): none instead of a failed request.
 */
function referencesAt(ls: ts.LanguageService, file: string, pos: number): readonly ts.ReferencedSymbol[] {
  try {
    return ls.findReferences(file, pos) ?? [];
  } catch {
    return [];
  }
}

/** Position of the identifier to query the language service with. */
export function queryPosition(model: TsModel, node: CallableNode): { file: string; pos: number } {
  const cls = ts.isClassLike(node) ? node : ts.isConstructorDeclaration(node) ? node.parent : undefined;
  const nameNode = cls ? cls.name ?? cls : model.callableNameNode(node);
  return { file: node.getSourceFile().fileName, pos: nameNode.getStart() };
}

/** Call / new expression whose callee is exactly the referenced identifier. */
function callOfReference(id: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let callee: ts.Node = id;
  if (
    (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) ||
    (ts.isElementAccessExpression(id.parent) && id.parent.argumentExpression === id)
  ) {
    callee = id.parent;
  }
  let p = callee.parent;
  // FR-4.1 through parentheses, `!` and casts: `(s.save as any)(4)`, `(<any>s.save)(4)`
  while (p && isOuterExpression(p)) {
    callee = p;
    p = p.parent;
  }
  if (p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && skipOuter(p.expression) === skipOuter(callee as ts.Expression)) {
    return p;
  }
  return undefined;
}

/** FR-1.20 the JSX element whose tag is the referenced component (`<Panel />`, `<ui.Panel>`); not its closing tag. */
function jsxElementOfReference(id: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined {
  const tag = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
  const p = tag.parent;
  return p && (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === tag ? p : undefined;
}

/**
 * FR-1.20 the name a wrapped component is used by: `const Panel = observer(_Panel)` (`memo`, `forwardRef`, nested
 * wrappers) → `Panel`; `export default observer(Panel)` → its `default` keyword (the default imports' symbol).
 */
function componentWrapperName(id: ts.Node): ts.Node | undefined {
  let e: ts.Node = id;
  while (ts.isCallExpression(e.parent) && e.parent.arguments.includes(e as ts.Expression)) e = e.parent;
  if (e === id) return undefined;
  const p = e.parent;
  if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name) && /^[A-Z]/.test(p.name.text)) return p.name;
  // `export =` has no `default` keyword: undefined
  if (ts.isExportAssignment(p)) return p.getChildren().find((c) => c.kind === ts.SyntaxKind.DefaultKeyword);
  return undefined;
}

/** FR-4.5: the call receiving the referenced function as an argument (`items.map(parse)`, `run(this.step.bind(this))`). */
function receivingCallOfReference(id: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let arg: ts.Node = id;
  if ((ts.isPropertyAccessExpression(id.parent) && id.parent.name === id)) arg = id.parent;
  let p = arg.parent;
  while (p && isOuterExpression(p)) {
    arg = p;
    p = p.parent;
  }
  // f.bind(thisArg) passed on
  // (`arg` is the object of `p`: a property name was taken into `arg` above)
  if (p && ts.isPropertyAccessExpression(p) && p.name.text === 'bind' && ts.isCallExpression(p.parent) && p.parent.expression === p) {
    arg = p.parent;
    p = arg.parent;
  }
  // (a `new` without arguments: its callee is the reference, a call found by callOfReference)
  if (p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments!.some((a) => a === arg)) return p;
  return undefined;
}

/**
 * FR-4.1 the local a reference is taken out into by object destructuring: `const { fetchInfo } = store` (the name),
 * `const { fetchInfo: f } = store` (`f`). Nested patterns and rest elements: undefined.
 */
function destructuredLocal(id: ts.Node): ts.Identifier | undefined {
  const b = id.parent;
  if (!b || !ts.isBindingElement(b) || b.dotDotDotToken || !ts.isObjectBindingPattern(b.parent)) return undefined;
  if (b.propertyName ? b.propertyName !== id : b.name !== id) return undefined;
  return ts.isIdentifier(b.name) ? b.name : undefined;
}

/** The class whose own code a member declaration is: a method / accessor with a body, a field with a value. */
function concreteClassOf(decl: ts.Node): ts.ClassLikeDeclaration | undefined {
  if (!ts.isClassLike(decl.parent)) return undefined;
  const concrete = ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)
    ? !!decl.body
    : ts.isPropertyDeclaration(decl) && !!decl.initializer;
  return concrete ? decl.parent : undefined;
}

/** A class and the classes it extends, directly or further up (up to a base that is no class: a mixin's product). */
function classAndBases(model: TsModel, cls: ts.ClassLikeDeclaration): Set<ts.Node> {
  const out = new Set<ts.Node>();
  for (let t: ts.Type | undefined = model.checker.getTypeAtLocation(cls); t?.isClassOrInterface(); t = model.checker.getBaseTypes(t)[0]) {
    for (const d of t.symbol.declarations!) out.add(d);
  }
  return out;
}

/** Callers sorted by location, production code first and test code last (FR-4.1). */
export function findCallers(
  model: TsModel,
  ls: ts.LanguageService,
  node: CallableNode,
  method: MethodRef,
  isTestFile: (relPath: string) => boolean,
): CallerInfo[] {
  const { file, pos } = queryPosition(model, node);
  const isCtor = method.name === 'constructor';
  // FR-4.1 a getter runs when its property is read, a setter when it is assigned
  const accessor = ts.isGetAccessorDeclaration(node) ? 'get' : ts.isSetAccessorDeclaration(node) ? 'set' : undefined;
  // FR-1.20 a function component is called by the elements that render it
  const component = !accessor && !isCtor && !ts.isMethodDeclaration(node) && rendersJsx(node);
  const seen = new Set<string>();
  const out: CallerInfo[] = [];
  const addCaller = (sf: ts.SourceFile, at: ts.Node, passed: boolean): void => {
    const enclosingNode = model.enclosingCallable(sf, at.getStart(sf));
    const enclosing = enclosingNode && model.methodRef(enclosingNode);
    if (!enclosing) return;
    const range = model.range(at, sf);
    const id_ = `${model.rel(sf.fileName)}:${range.start.line + 1}:${range.start.character + 1}`;
    if (seen.has(id_)) return;
    seen.add(id_);
    // the line as TypeScript counts lines (also a lone CR, U+2028 / U+2029)
    const starts = sf.getLineStarts();
    const lineText = sf.text.slice(starts[range.start.line], starts[range.start.line + 1]); // the last line: to the end
    out.push({ id: id_, enclosing, range, preview: compact(lineText), ...(passed ? { passed: true } : {}) });
  };
  const groups = (f: string, at: number) => referencesAt(ls, f, at);
  // FR-4.1 a member of a class or interface: the language service also returns the references of the members it
  // implements and of its sibling implementations. A call reaches this member through itself, an interface /
  // abstract member or a base class's member it inherits, never through another class's own code (`d.save()` on a
  // `DbStore` is no caller of `MemStore.save`; a call on a concrete class is no caller of the interface member).
  const memberDecl = innermostNodeAt(node.getSourceFile(), pos).parent;
  const owner = memberDecl.parent;
  const own = ts.isClassLike(owner) ? classAndBases(model, owner) : ts.isInterfaceDeclaration(owner) ? new Set<ts.Node>() : undefined;
  const reaches = (g: ts.ReferencedSymbol): boolean => {
    const sf = model.program.getSourceFile(g.definition.fileName)!;
    const cls = concreteClassOf(innermostNodeAt(sf, g.definition.textSpan.start).parent);
    return !cls || own!.has(cls);
  };
  // (the search from a destructured local returns the member's groups again)
  const references = (f: string, at: number) => groups(f, at).filter((g) => !own || reaches(g)).flatMap((g) => g.references);
  // FR-4.1 `const { m } = store` / `const { m: f } = store`: the calls go through the local, a symbol of its own
  const queue = references(file, pos);
  const followed = new Set<string>();
  for (let k = 0; k < queue.length; k++) {
    const ref = queue[k];
    {
      if (ref.isDefinition) continue;
      const sf = model.program.getSourceFile(ref.fileName);
      if (!sf || model.isLibraryFile(sf)) continue;
      const id = innermostNodeAt(sf, ref.textSpan.start);
      const local = destructuredLocal(id);
      if (local && !isCtor) {
        const key = `${sf.fileName}:${local.getStart(sf)}`;
        if (!followed.has(key)) {
          followed.add(key);
          queue.push(...references(sf.fileName, local.getStart(sf)).filter((r) => !r.isDefinition));
        }
        continue;
      }
      if (accessor) {
        // `this.events.toSorted(…)`, `...this.events` read the property; `x.value = v` writes it
        if ((accessor === 'set') !== !!ref.isWriteAccess) continue;
        addCaller(sf, ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id, false);
        continue;
      }
      if (component) {
        const element = jsxElementOfReference(id);
        if (element) {
          addCaller(sf, element, false);
          continue;
        }
        const name = componentWrapperName(id);
        if (name) {
          const key = `${sf.fileName}:${name.getStart(sf)}`;
          if (!followed.has(key)) {
            followed.add(key);
            queue.push(...references(sf.fileName, name.getStart(sf)).filter((r) => !r.isDefinition));
          }
          continue;
        }
      }
      let call = callOfReference(id);
      let passed = false;
      if (!call && !isCtor) {
        call = receivingCallOfReference(id);
        passed = !!call;
      }
      if (!call || (isCtor ? !ts.isNewExpression(call) : !passed && !ts.isCallExpression(call))) continue;
      addCaller(sf, call, passed);
    }
  }
  const isTest = (c: CallerInfo): boolean => isTestFile(model.rel(c.range.file));
  for (const c of out) if (isTest(c)) c.inTest = true;
  return out.sort(
    (a, b) => Number(isTest(a)) - Number(isTest(b)) || a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

/**
 * FR-31.1 references to a function / method outside test code that use it as a value — kept in an object or an
 * array, assigned, returned — not calls, not passed to a call (both are callers), not imports / exports and not types.
 */
export function countValueUses(model: TsModel, ls: ts.LanguageService, node: CallableNode, isTestFile: (relPath: string) => boolean): number {
  const { file, pos } = queryPosition(model, node);
  let uses = 0;
  for (const ref of referencesAt(ls, file, pos).flatMap((g) => g.references)) {
    if (ref.isDefinition) continue;
    const sf = model.program.getSourceFile(ref.fileName);
    if (!sf || model.isLibraryFile(sf) || isTestFile(model.rel(sf.fileName))) continue;
    const id = innermostNodeAt(sf, ref.textSpan.start);
    if (callOfReference(id) || receivingCallOfReference(id) || jsxElementOfReference(id)) continue;
    // the name of another declaration: an override, the interface member it implements
    if ((id.parent as ts.NamedDeclaration).name === id && !ts.isPropertyAccessExpression(id.parent) && !ts.isShorthandPropertyAssignment(id.parent)) continue;
    // a type (`typeof f`), an import / export (`export { f as g }`): the statement or type it is in tells
    const at = ts.findAncestor(id, (n) => ts.isTypeNode(n) || ts.isStatement(n))!;
    if (ts.isTypeNode(at) || ts.isImportDeclaration(at) || ts.isImportEqualsDeclaration(at) || ts.isExportDeclaration(at) || ts.isExportAssignment(at)) continue;
    uses++;
  }
  return uses;
}

/**
 * Concrete members implementing / overriding an interface or abstract member (FR-8), including
 * functional implementations of function-typed / method members: object-literal members
 * contextually typed by the interface, resolved to the function they hold (inline function,
 * referenced function, a factory's returned function, or another interface member's implementations).
 */
export function findImplementations(
  model: TsModel,
  ls: ts.LanguageService,
  node: CallableNode,
  method: MethodRef,
  isTestFile: (relPath: string) => boolean,
  /** false: search even where mayHaveImplementations rules implementations out (tests compare both). */
  check = true,
): MethodRef[] {
  if (check && !mayHaveImplementations(model, node, isTestFile)) return [];
  const out = new Map<string, MethodRef>();
  const finder = new ImplementationFinder(model, ls, isTestFile);
  for (const c of finder.implementationsOf(node)) {
    if (isTestFile(model.rel(c.getSourceFile().fileName))) continue;
    const ref = model.methodRef(c);
    if (!ref || ref.key === method.key || ref.owner.kind === 'interface' || !ref.hasBody) continue;
    out.set(ref.key, ref);
  }
  return [...out.values()].sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.key.localeCompare(b.key));
}

/** Text of a declaration's name (identifier, `#private`, string / number literal); undefined for a computed name. */
function declaredName(n: ts.Node): string | undefined {
  return ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) ? n.text : undefined;
}

/** Declarations whose name may be an implementation location (or lead to one: a shorthand, a re-export's alias). */
function isNamedDeclaration(n: ts.Node): n is ts.NamedDeclaration {
  return (
    ts.isMethodDeclaration(n) || ts.isMethodSignature(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) ||
    ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) ||
    ts.isImportSpecifier(n) || ts.isExportSpecifier(n)
  );
}

/** What mayHaveImplementations needs of a program, built once per program. */
interface ImplementationIndex {
  /** How often each name is declared in the project's own non-test files. */
  names: Map<string, number>;
  /** Object-literal members by name (project files): typed by a class, they implement its members. */
  objectMembers: Map<string, ts.ObjectLiteralElementLike[]>;
  /** Classes / interfaces an `extends` / `implements` clause in the project names. */
  bases: Set<ts.Symbol>;
  /** A clause names a value (`extends Base` of `const Base = …`): any class may have subclasses. */
  basesUnknown: boolean;
}

const implementationIndexes = new WeakMap<ts.Program, ImplementationIndex>();

function implementationIndex(model: TsModel, isTestFile: (relPath: string) => boolean): ImplementationIndex {
  const known = implementationIndexes.get(model.program);
  if (known) return known;
  const checker = model.checker;
  const index: ImplementationIndex = { names: new Map(), objectMembers: new Map(), bases: new Set(), basesUnknown: false };
  const add = (name: ts.Node | undefined) => {
    const text = name && declaredName(name);
    if (text !== undefined) index.names.set(text, (index.names.get(text) ?? 0) + 1);
  };
  const base = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      let sym = checker.getSymbolAtLocation(n);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      if (!sym) index.basesUnknown = true;
      else if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) index.bases.add(sym);
      // a variable, parameter or property may hold any class (a mixin's function name holds none)
      else if (sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property | ts.SymbolFlags.Accessor)) index.basesUnknown = true;
    }
    ts.forEachChild(n, base);
  };
  const visit = (n: ts.Node, own: boolean): void => {
    if (ts.isHeritageClause(n)) for (const t of n.types) base(t.expression);
    if (own && isNamedDeclaration(n)) {
      add(n.name);
      // `export { save as store }`, `import { save as store }`: both names
      if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName) add(n.propertyName);
    }
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const text = p.name && declaredName(p.name);
        if (text !== undefined) index.objectMembers.set(text, [...(index.objectMembers.get(text) ?? []), p]);
      }
    }
    ts.forEachChild(n, (c) => visit(c, own));
  };
  // subclasses and typed object literals are looked for in test files too (fewer skips, never a missed one)
  for (const sf of model.program.getSourceFiles()) {
    if (!model.isLibraryFile(sf)) visit(sf, !isTestFile(model.rel(sf.fileName)));
  }
  implementationIndexes.set(model.program, index);
  return index;
}

/**
 * A member found as its own implementation location is itself, nothing more: a method, accessor or function, or one
 * holding an inline function. One holding another value (`save = makeSaver()`) leads to the function it evaluates to.
 */
function implementsOnlyItself(node: ts.NamedDeclaration): boolean {
  if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) {
    const init = node.initializer && skipOuter(node.initializer);
    return !init || ts.isArrowFunction(init) || ts.isFunctionExpression(init);
  }
  return ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isFunctionDeclaration(node);
}

/**
 * False when no implementation can exist, so the language service's implementation search (a reference search over
 * the whole program) is skipped.
 * - By name: what the search reports is a declaration named like the member in the project's own non-test code (a
 *   method, property, accessor, function or variable, or a shorthand / import / re-export leading to one), so a name
 *   no other such declaration has has none.
 * - A class member: only a class / interface extending or implementing the class, or an object literal typed by it,
 *   implements it — none of them in the project, none (a value object's `get value()` among many other `value`s).
 * Not for a class or a constructor (a subclass names its base only in `extends`).
 */
export function mayHaveImplementations(model: TsModel, node: CallableNode, isTestFile: (relPath: string) => boolean): boolean {
  if (ts.isClassLike(node) || ts.isConstructorDeclaration(node) || !isNamedDeclaration(node) || !implementsOnlyItself(node)) return true;
  const name = node.name && declaredName(node.name);
  if (name === undefined) return true;
  const index = implementationIndex(model, isTestFile);
  const sf = node.getSourceFile();
  const own = !model.isLibraryFile(sf) && !isTestFile(model.rel(sf.fileName)) ? 1 : 0;
  if ((index.names.get(name) ?? 0) <= own) return false;
  const cls = node.parent;
  if (!(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) || !cls.name || index.basesUnknown) return true;
  const checker = model.checker;
  const sym = checker.getSymbolAtLocation(cls.name);
  if (!sym || index.bases.has(sym)) return true;
  // an object literal typed by the class (or a type made of it: a union, `Partial<…>`) whose member is this one
  for (const p of index.objectMembers.get(name) ?? []) {
    const type = checker.getContextualType(p.parent as ts.ObjectLiteralExpression);
    if (!type) continue;
    for (const t of type.isUnionOrIntersection() ? [type, ...type.types] : [type]) {
      if (checker.getPropertyOfType(t, name)?.declarations?.includes(node)) return true;
    }
  }
  return false;
}

const MAX_DEPTH = 6;

class ImplementationFinder {
  private readonly visited = new Set<ts.Node>();
  private depth = 0;

  constructor(
    private readonly model: TsModel,
    private readonly ls: ts.LanguageService,
    /** Test code never provides implementations (fakes, test wiring). */
    private readonly isTestFile: (relPath: string) => boolean,
  ) {}

  /** Implementations of an interface / abstract member (or class property) as callables. */
  implementationsOf(node: CallableNode): CallableNode[] {
    // no visited / depth check needed: symbolCallables skips visited declarations and runs within valueCallables' depth limit
    this.visited.add(node);
    this.depth++;
    try {
      // a class field with a value (`save = makeSaver()`) is its own implementation location: handled below
      const out: CallableNode[] = [];
      const { file, pos } = queryPosition(this.model, node);
      let impls: readonly ts.ImplementationLocation[] = [];
      try {
        impls = this.ls.getImplementationAtPosition(file, pos) ?? [];
      } catch {
        impls = [];
      }
      for (const impl of impls) {
        const sf = this.model.program.getSourceFile(impl.fileName);
        if (!sf || this.model.isLibraryFile(sf) || this.isTestFile(this.model.rel(sf.fileName))) continue;
        out.push(...this.atImplementation(innermostNodeAt(sf, impl.textSpan.start)));
      }
      return out;
    } finally {
      this.depth--;
    }
  }

  /** The implementing member found at an implementation location (its name identifier). */
  private atImplementation(at: ts.Node): CallableNode[] {
    const { model } = this;
    const decl = at.parent;
    // only a declaration named here implements the member; a value only typed like it (`const f: typeof ports.save =
    // (n) => {}`, a method returning one) does not
    if (ts.getNameOfDeclaration(decl as ts.Declaration) !== at) return [];
    if (ts.isPropertyAssignment(decl)) return this.valueCallables(decl.initializer);
    if (ts.isVariableDeclaration(decl)) {
      const c = model.asCallable(decl);
      if (c && model.hasBody(c)) return [c];
      return decl.initializer ? this.valueCallables(decl.initializer) : [];
    }
    if (ts.isPropertyDeclaration(decl)) {
      const c = model.asCallable(decl);
      if (c && model.functionOf(c)) return [c];
      return decl.initializer ? this.valueCallables(decl.initializer) : [];
    }
    // (callables without a body are dropped by findImplementations)
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
      const c = model.asCallable(decl);
      return c ? [c] : [];
    }
    // a parameter or destructured name (`{ save }` of a parameter: not a stable callable), an import (the language
    // service also reports the declaration it names, as for a shorthand property), an interface augmentation
    return [];
  }

  /** Functions an expression evaluates to (FR-8 for functional code). */
  valueCallables(expr: ts.Expression): CallableNode[] {
    if (this.depth > MAX_DEPTH) return [];
    const { model } = this;
    let e = skipOuter(expr);
    if (ts.isAwaitExpression(e)) e = skipOuter(e.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const c = model.asCallable(e);
      return c ? [c] : [];
    }
    if (ts.isConditionalExpression(e)) return [...this.valueCallables(e.whenTrue), ...this.valueCallables(e.whenFalse)];
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return [...this.valueCallables(e.left), ...this.valueCallables(e.right)];
    }
    if (ts.isIdentifier(e)) return this.symbolCallables(this.symbolOf(e));
    if (ts.isPropertyAccessExpression(e)) return this.symbolCallables(this.symbolOf(e.name));
    if (ts.isCallExpression(e)) return this.factoryProducts(e);
    return [];
  }

  private symbolOf(id: ts.Node): ts.Symbol | undefined {
    let sym = this.model.checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.model.checker.getAliasedSymbol(sym);
    return sym;
  }

  private symbolCallables(sym: ts.Symbol | undefined): CallableNode[] {
    if (!sym) return [];
    const { model } = this;
    const out: CallableNode[] = [];
    for (const d of sym.declarations ?? []) {
      if (model.isLibraryFile(d.getSourceFile()) || this.visited.has(d)) continue;
      if (ts.isShorthandPropertyAssignment(d)) {
        this.visited.add(d);
        out.push(...this.symbolCallables(model.checker.getShorthandAssignmentValueSymbol(d)));
        continue;
      }
      if (ts.isPropertyAssignment(d)) {
        this.visited.add(d);
        out.push(...this.valueCallables(d.initializer));
        continue;
      }
      const c = model.asCallable(d);
      if (c && model.hasBody(c)) {
        out.push(c);
        continue;
      }
      if (c && (ts.isPropertySignature(c) || ts.isMethodSignature(c) || ts.isPropertyDeclaration(c) ||
        (ts.isMethodDeclaration(c) && model.isAbstract(c)))) {
        out.push(...this.implementationsOf(c)); // another abstraction: its implementations
        continue;
      }
      if (ts.isVariableDeclaration(d) && d.initializer) {
        this.visited.add(d);
        out.push(...this.valueCallables(d.initializer));
      }
    }
    return out;
  }

  /** `factory(args)`: the functions the factory returns, or the factory itself. */
  private factoryProducts(call: ts.CallExpression): CallableNode[] {
    const { model } = this;
    const factory = this.calleeCallable(call);
    if (!factory) return [];
    const fn = model.functionOf(factory) as ts.FunctionLikeDeclaration & { body: ts.ConciseBody }; // has a body (calleeCallable)
    // followed already (recursion, or the same factory reached again): its products are listed once, it is none itself
    if (this.visited.has(fn)) return [];
    this.visited.add(fn);
    const returned: ts.Expression[] = [];
    if (!ts.isBlock(fn.body)) returned.push(fn.body);
    else {
      const visit = (n: ts.Node): void => {
        if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
        if (ts.isReturnStatement(n) && n.expression) returned.push(n.expression);
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn.body, visit);
    }
    this.depth++;
    try {
      const products = returned.flatMap((r) => this.valueCallables(r));
      return products.length > 0 ? products : [factory];
    } finally {
      this.depth--;
    }
  }

  private calleeCallable(call: ts.CallExpression): CallableNode | undefined {
    const { model } = this;
    // (the symbol of `a.make` is that of `make`; a library callable has no body here)
    for (const d of this.symbolOf(skipOuter(call.expression))?.declarations ?? []) {
      const c = model.asCallable(d);
      if (c && model.hasBody(c)) return c;
    }
    return undefined;
  }
}
