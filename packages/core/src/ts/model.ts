import ts from 'typescript';
import type { ClassRef, MethodRef, SourceRange } from '@seqcall/protocol';
import { isInNodeModules, isUnder, moduleNameOf, normalizePath, packageNameOf, relativePath } from './paths';

/**
 * A callable declaration in canonical form:
 * - class methods, constructors, accessors, class properties initialised with a function
 *   or typed as a function (the latter without body)
 * - module-level function declarations and `const x = () => … / function () {…}` (VariableDeclaration)
 * - interface / type-literal method signatures and function-typed property signatures (no body)
 * - a ClassDeclaration/ClassExpression stands for its implicit constructor.
 * - "synthetic" callables of functional code (see {@link SyntheticCallable}): object-literal
 *   members (PropertyAssignment with a function initializer, object-literal methods/accessors),
 *   functions declared locally inside a callable (VariableDeclaration / FunctionDeclaration) and
 *   functions returned by a callable (ArrowFunction / FunctionExpression).
 */
export type CallableNode =
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.PropertyDeclaration
  | ts.FunctionDeclaration
  | ts.VariableDeclaration
  | ts.MethodSignature
  | ts.PropertySignature
  | ts.PropertyAssignment
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.ClassLikeDeclaration;

/**
 * A callable of functional code that is not a class member or module-level function.
 * Its owner is a synthetic, class-like participant named after the object / closure it belongs to:
 * - members of `const x = { … }` (or of a nested `prop: { … }`) → owner `x` (`prop`);
 * - members of any other object literal (returned, passed as argument, …), functions declared
 *   locally inside a callable F and functions returned by F → owner named after F
 *   (`gitHost`, `branchesIn`; class members: `Class.method`);
 * - at module level outside any function → the module itself.
 * Returned functions are named `<returned>`. Clashing names get a `~2`, `~3` … suffix
 * (source order). Key: `<relPath>#<owner>.<member>`, owner key `<relPath>#<owner>`.
 */
export interface SyntheticCallable {
  node: CallableNode;
  /** Object literal, enclosing callable, or the source file (module owner). */
  anchor: ts.Node;
  ownerName: string;
  memberName: string;
}

interface SyntheticIndex {
  byNode: Map<ts.Node, SyntheticCallable>;
  /** ownerName → anchor (non-module owners only). */
  owners: Map<string, ts.Node>;
  /** How each owner got its members: helpers declared inside a function ('local') or object / returned members. */
  ownerKinds: Map<string, Set<'local' | 'object'>>;
}

export const RETURNED = '<returned>';

export type TypeDeclNode = ts.ClassLikeDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

const MODULE = '<module>';

/**
 * Program-bound view used by the adapter: callable detection, stable keys and
 * ClassRef/MethodRef construction. Re-created whenever the program changes.
 */
export class TsModel {
  readonly checker: ts.TypeChecker;
  private readonly callableIndex = new Map<string, Map<string, CallableNode>>();
  private readonly syntheticIndex = new Map<string, SyntheticIndex>();
  private readonly functionTypedCache = new Map<ts.Node, boolean>();

  constructor(
    readonly program: ts.Program,
    readonly projectRoot: string,
  ) {
    this.checker = program.getTypeChecker();
  }

  // ───────────── files ─────────────

  getSourceFile(file: string): ts.SourceFile | undefined {
    return this.program.getSourceFile(normalizePath(file));
  }

  /** Declared outside the project sources (node_modules, default lib, outside the root). */
  isLibraryFile(sf: ts.SourceFile): boolean {
    return (
      this.program.isSourceFileDefaultLibrary(sf) ||
      this.program.isSourceFileFromExternalLibrary(sf) ||
      isInNodeModules(sf.fileName) ||
      !isUnder(this.projectRoot, sf.fileName)
    );
  }

  /** "express", "node:fs", "lib" for default-lib/builtins. */
  libraryNameOf(node: ts.Node): string {
    const sf = node.getSourceFile();
    if (this.program.isSourceFileDefaultLibrary(sf)) return 'lib';
    // `declare module "fs" { … }` inside @types/node etc.
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) {
        const name = n.name.text;
        return packageNameOf(sf.fileName) === 'node' && !name.startsWith('node:') ? `node:${name}` : name;
      }
    }
    return packageNameOf(sf.fileName) ?? 'lib';
  }

  rel(file: string): string {
    return relativePath(this.projectRoot, file);
  }

  range(node: ts.Node, sf: ts.SourceFile = node.getSourceFile()): SourceRange {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(node.getEnd());
    return { file: normalizePath(sf.fileName), start, end };
  }

  // ───────────── type declarations / ClassRef ─────────────

  typeDeclName(decl: TypeDeclNode): string {
    if (decl.name) return decl.name.text;
    if (ts.isClassExpression(decl) && ts.isVariableDeclaration(decl.parent) && ts.isIdentifier(decl.parent.name)) {
      return decl.parent.name.text;
    }
    return 'default';
  }

  isAbstract(decl: ts.Node): boolean {
    return (ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0;
  }

  externalRef(node: ts.Node): ClassRef {
    const lib = this.libraryNameOf(node);
    return { key: `lib:${lib}`, name: lib, kind: 'external' };
  }

  moduleRef(sf: ts.SourceFile): ClassRef {
    if (this.isLibraryFile(sf)) return this.externalRef(sf);
    const rel = this.rel(sf.fileName);
    return {
      key: `${rel}#${MODULE}`,
      name: moduleNameOf(rel),
      kind: 'module',
      declaration: { file: normalizePath(sf.fileName), start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  classRef(decl: TypeDeclNode): ClassRef {
    const sf = decl.getSourceFile();
    if (this.isLibraryFile(sf)) return this.externalRef(decl);
    const name = this.typeDeclName(decl);
    const kind = ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)
      ? 'interface'
      : this.isAbstract(decl)
        ? 'abstract'
        : 'class';
    const nameNode = decl.name ?? decl;
    return { key: `${this.rel(sf.fileName)}#${name}`, name, kind, declaration: this.range(nameNode, sf) };
  }

  /** ClassRef for a type (class instance type, interface, `typeof Class`); undefined for unions, primitives, any. */
  classRefFromType(type: ts.Type): ClassRef | undefined {
    const decl = this.typeDeclFromType(type);
    return decl ? this.classRef(decl) : undefined;
  }

  typeDeclFromType(type: ts.Type): TypeDeclNode | undefined {
    const t = this.checker.getNonNullableType(type);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    for (const sym of [t.getSymbol(), t.aliasSymbol]) {
      const decl = sym && this.typeDeclFromSymbol(sym);
      if (decl) return decl;
    }
    return undefined;
  }

  typeDeclFromSymbol(symbol: ts.Symbol): TypeDeclNode | undefined {
    const sym = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const decls = sym.declarations ?? [];
    return (decls.find((d) => ts.isClassLike(d)) ??
      decls.find((d) => ts.isInterfaceDeclaration(d)) ??
      decls.find((d) => ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type))) as TypeDeclNode | undefined;
  }

  /** Class / interface / module that owns a callable. */
  ownerOf(node: CallableNode): ClassRef | undefined {
    const syn = this.synthetic(node);
    if (syn) return this.syntheticOwnerRef(syn);
    if (ts.isClassLike(node)) return this.classRef(node);
    const parent = ts.isVariableDeclaration(node) ? undefined : node.parent;
    if (parent && (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent))) return this.classRef(parent);
    if (parent && ts.isTypeLiteralNode(parent)) {
      return ts.isTypeAliasDeclaration(parent.parent) ? this.classRef(parent.parent) : undefined;
    }
    if (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) return this.moduleRef(node.getSourceFile());
    // e.g. an accessor of an object literal inside a callback (not a synthetic callable)
    return undefined;
  }

  // ───────────── callables ─────────────

  /** Is `node` a supported callable (FR-1.2)? Returns its canonical form. */
  asCallable(node: ts.Node): CallableNode | undefined {
    return this.canonicalCallable(node) ?? this.synthetic(node)?.node;
  }

  /** Class members, module-level functions and interface members (no synthetic callables). */
  private canonicalCallable(node: ts.Node): CallableNode | undefined {
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return ts.isClassLike(node.parent) ? node : undefined;
    }
    if (ts.isConstructorDeclaration(node)) return node;
    if (ts.isFunctionDeclaration(node)) {
      return ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent) ? node : undefined;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const p = node.parent;
      if (ts.isVariableDeclaration(p) && p.initializer === node) return this.canonicalCallable(p);
      if (ts.isPropertyDeclaration(p) && p.initializer === node) return this.canonicalCallable(p);
      return undefined;
    }
    if (ts.isVariableDeclaration(node)) {
      const init = node.initializer && skipOuter(node.initializer);
      const list = node.parent;
      if (
        ts.isIdentifier(node.name) &&
        init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
        ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) &&
        (ts.isSourceFile(list.parent.parent) || ts.isModuleBlock(list.parent.parent))
      ) {
        return node;
      }
      return undefined;
    }
    if (ts.isPropertyDeclaration(node)) {
      // (a PropertyDeclaration is always a class member: object literals have PropertyAssignments)
      const init = node.initializer && skipOuter(node.initializer);
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return node;
      return this.isFunctionTyped(node) ? node : undefined;
    }
    if (ts.isMethodSignature(node)) return node;
    if (ts.isPropertySignature(node)) return this.isFunctionTyped(node) ? node : undefined;
    return undefined;
  }

  /** Property whose type is a plain function type (also through aliases): call signatures, no members. */
  isFunctionTyped(node: ts.PropertySignature | ts.PropertyDeclaration): boolean {
    if (node.type && ts.isFunctionTypeNode(node.type)) return true;
    let cached = this.functionTypedCache.get(node);
    if (cached === undefined) {
      cached = false;
      if (node.type || (ts.isPropertyDeclaration(node) && node.initializer)) {
        try {
          const t = this.checker.getNonNullableType(this.checker.getTypeAtLocation(node));
          cached = t.getCallSignatures().length > 0 && t.getProperties().length === 0 && t.getConstructSignatures().length === 0;
          /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an
             import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here */
        } catch {
          cached = false;
        }
        /* v8 ignore stop */
      }
      this.functionTypedCache.set(node, cached);
    }
    return cached;
  }

  // ───────────── synthetic callables (functional code) ─────────────

  /** The synthetic callable represented by `node` (its canonical node or its function node). */
  synthetic(node: ts.Node): SyntheticCallable | undefined {
    if (!ts.isFunctionLike(node) && !ts.isPropertyAssignment(node) && !ts.isVariableDeclaration(node)) return undefined;
    return this.syntheticsOf(node.getSourceFile()).byNode.get(node);
  }

  syntheticOwnerRef(syn: SyntheticCallable): ClassRef {
    const sf = syn.anchor.getSourceFile();
    if (ts.isSourceFile(syn.anchor)) return this.moduleRef(sf);
    // an object literal is an anchor only when it has a name (objectAnchor)
    const anchorName = ts.isObjectLiteralExpression(syn.anchor)
      ? objectLiteralNameNode(syn.anchor)!
      : this.anchorNameNode(syn.anchor as CallableNode);
    return {
      key: `${this.rel(sf.fileName)}#${syn.ownerName}`,
      // helpers declared inside a function: named after that function, `clear()` (not to be read as the module `clear`)
      name: this.isLocalFunctionsOwner(sf, syn.ownerName) ? `${syn.ownerName.replace(/~\d+$/, '')}()` : syn.ownerName,
      kind: 'class',
      declaration: this.range(anchorName, sf),
    };
  }

  /**
   * The synthetic owner groups only functions declared inside another function that are *not* handed
   * out — a closure's helpers (`clear()`), not a factory returning them as an object (`fileStore`,
   * `return { store, flush }`), which is a port implementation.
   */
  isLocalFunctionsOwner(sf: ts.SourceFile, ownerName: string): boolean {
    const index = this.syntheticsOf(sf);
    const kinds = index.ownerKinds.get(ownerName);
    if (!kinds || kinds.size !== 1 || !kinds.has('local')) return false;
    // functions declared inside another one: the owner is that callable, its body a block (it declares them)
    const anchor = index.owners.get(ownerName) as CallableNode;
    const body = (this.functionOf(anchor) as ts.FunctionLikeDeclaration).body as ts.Block;
    const members = new Set([...index.byNode.values()].filter((x) => x.ownerName === ownerName).map((x) => x.memberName));
    const handsOut = (obj: ts.ObjectLiteralExpression) =>
      obj.properties.some((p) =>
        (ts.isShorthandPropertyAssignment(p) && members.has(p.name.text)) ||
        (ts.isPropertyAssignment(p) && ts.isIdentifier(skipOuter(p.initializer)) && members.has((skipOuter(p.initializer) as ts.Identifier).text)));
    let factory = false;
    const visit = (n: ts.Node): void => {
      if (factory || (n !== body && ts.isFunctionLike(n))) return;
      const returned = ts.isReturnStatement(n) ? n.expression : undefined;
      if (returned && ts.isObjectLiteralExpression(skipOuter(returned)) && handsOut(skipOuter(returned) as ts.ObjectLiteralExpression)) factory = true;
      ts.forEachChild(n, visit);
    };
    visit(body);
    return !factory;
  }

  /** A returned function is named after the callable returning it (its anchor: never the module, never an object). */
  private anchorNameNode(anchor: CallableNode): ts.Node {
    const syn = this.synthetic(anchor);
    if (syn && syn.memberName === RETURNED) return this.anchorNameNode(syn.anchor as CallableNode);
    return this.callableNameNode(anchor);
  }

  /** Synthetic owner (object / closure) by class key, if `classKey` names one. */
  isSyntheticOwner(classKey: string): boolean {
    const hash = classKey.indexOf('#');
    if (hash < 0 || classKey.startsWith('lib:')) return false;
    const sf = this.getSourceFile(`${this.projectRoot}/${classKey.slice(0, hash)}`);
    return !!sf && !this.isLibraryFile(sf) && this.syntheticsOf(sf).owners.has(classKey.slice(hash + 1));
  }

  /** Synthetic callables of one file, named deterministically in source order. */
  syntheticsOf(sf: ts.SourceFile): SyntheticIndex {
    let index = this.syntheticIndex.get(sf.fileName);
    if (index) return index;
    index = { byNode: new Map(), owners: new Map(), ownerKinds: new Map() };
    this.syntheticIndex.set(sf.fileName, index);
    if (this.isLibraryFile(sf)) return index;

    const reserved = new Set<string>([MODULE]);
    const collectTypeNames = (statements: ts.NodeArray<ts.Statement>): void => {
      for (const st of statements) {
        if ((ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st)) && st.name) {
          reserved.add(st.name.text);
        } else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) collectTypeNames(st.body.statements);
      }
    };
    collectTypeNames(sf.statements);
    // members of the module owner must not clash with module-level callables
    const moduleMembers = new Set<string>();
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) moduleMembers.add(st.name.text);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) moduleMembers.add(d.name.text);
      }
    }

    const anchorNames = new Map<ts.Node, string>();
    const membersByAnchor = new Map<ts.Node, Set<string>>([[sf, moduleMembers]]);
    const ownerNameOf = (anchor: ts.Node, wanted: string): string => {
      if (ts.isSourceFile(anchor)) return MODULE;
      let name = anchorNames.get(anchor);
      if (name) return name;
      name = wanted;
      for (let i = 2; reserved.has(name); i++) name = `${wanted}~${i}`;
      reserved.add(name);
      anchorNames.set(anchor, name);
      index!.owners.set(name, anchor);
      return name;
    };
    const memberNameOf = (anchor: ts.Node, wanted: string, setter: boolean): string => {
      let set = membersByAnchor.get(anchor);
      if (!set) membersByAnchor.set(anchor, (set = new Set()));
      let name = wanted;
      for (let i = 2; set.has(name + (setter ? '=' : '')); i++) name = `${wanted}~${i}`;
      set.add(name + (setter ? '=' : ''));
      return name;
    };
    const nameOfCallable = (c: CallableNode): string => {
      const syn = index!.byNode.get(c);
      if (syn) return syn.memberName === RETURNED ? syn.ownerName : syn.memberName;
      const name = this.callableName(c);
      // (an enclosing callable has a body: never a class; a constructor's parent is its class)
      if (ts.isClassLike(c.parent)) return `${this.typeDeclName(c.parent)}.${name}`;
      return name;
    };
    const record = (node: CallableNode, fn: ts.Node, anchor: ts.Node, wantedOwner: string, member: string, local = false): CallableNode => {
      const ownerName = ownerNameOf(anchor, wantedOwner);
      let kinds = index!.ownerKinds.get(ownerName);
      if (!kinds) index!.ownerKinds.set(ownerName, (kinds = new Set()));
      kinds.add(local ? 'local' : 'object');
      const setter = ts.isSetAccessorDeclaration(node);
      const syn: SyntheticCallable = { node, anchor, ownerName, memberName: memberNameOf(anchor, member, setter) };
      index!.byNode.set(node, syn);
      index!.byNode.set(fn, syn);
      return node;
    };
    const anchorFor = (enclosing: CallableNode | undefined): [ts.Node, string] =>
      enclosing ? [enclosing, nameOfCallable(enclosing)] : [sf, MODULE];

    /** Synthetic callable for a function-like node, given its nearest enclosing callable. */
    const classify = (fn: ts.SignatureDeclaration, enclosing: CallableNode | undefined): CallableNode | undefined => {
      const p = outerParent(fn);
      // object-literal members
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isPropertyAssignment(p) &&
        skipOuter(p.initializer) === fn && ts.isObjectLiteralExpression(p.parent)) {
        const [anchor, owner] = objectAnchor(p.parent, enclosing);
        return record(p, fn, anchor, owner, propName(p.name));
      }
      if ((ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) &&
        ts.isObjectLiteralExpression(fn.parent)) {
        const [anchor, owner] = objectAnchor(fn.parent, enclosing);
        return record(fn, fn, anchor, owner, propName(fn.name));
      }
      // local functions
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(p) &&
        p.initializer && skipOuter(p.initializer) === fn && ts.isIdentifier(p.name)) {
        const [anchor, owner] = anchorFor(enclosing);
        return record(p, fn, anchor, owner, p.name.text, !ts.isSourceFile(anchor));
      }
      if (ts.isFunctionDeclaration(fn) && fn.body && fn.name && enclosing) {
        const [anchor, owner] = anchorFor(enclosing);
        return record(fn, fn, anchor, owner, fn.name.text, true);
      }
      // returned functions
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && enclosing) {
        const encFn = this.functionOf(enclosing);
        const returned = ts.isReturnStatement(p) ||
          (encFn && ts.isArrowFunction(encFn) && skipOuter(encFn.body as ts.Expression) === fn);
        if (returned) {
          const [anchor, owner] = anchorFor(enclosing);
          return record(fn, fn, anchor, owner, RETURNED);
        }
      }
      return undefined;
    };
    const objectAnchor = (obj: ts.ObjectLiteralExpression, enclosing: CallableNode | undefined): [ts.Node, string] => {
      const nameNode = objectLiteralNameNode(obj);
      return nameNode ? [obj, nameNode.text] : anchorFor(enclosing);
    };

    const visit = (node: ts.Node, enclosing: CallableNode | undefined, inCallback: boolean): void => {
      if (ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined) {
        const fn = node as ts.FunctionLikeDeclaration;
        let callable: CallableNode | undefined = this.canonicalCallable(fn);
        if (!callable && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          const p = outerParent(fn);
          if ((ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) && p.initializer && skipOuter(p.initializer) === fn) {
            callable = this.canonicalCallable(p);
          }
        }
        if (!callable && !inCallback) callable = classify(fn, enclosing);
        ts.forEachChild(node, (c) => visit(c, callable ?? enclosing, callable ? false : true));
        return;
      }
      if (ts.isClassLike(node)) {
        ts.forEachChild(node, (c) => visit(c, enclosing, false));
        return;
      }
      ts.forEachChild(node, (c) => visit(c, enclosing, inCallback));
    };
    ts.forEachChild(sf, (c) => visit(c, undefined, false));
    return index;
  }

  callableName(node: CallableNode): string {
    const syn = this.synthetic(node);
    if (syn) return syn.memberName;
    if (ts.isClassLike(node) || ts.isConstructorDeclaration(node)) return 'constructor';
    const name = node.name;
    if (!name) return 'default'; // `export default function () {}` (an arrow function is always synthetic)
    // (the text of a quoted or numeric name; the source text of others: `#run`, `[Symbol.iterator]`)
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return name.getText();
  }

  /** Stable key "<relPath>#<Class>.<member>" / "<relPath>#<module>.<fn>". Undefined for library callables. */
  callableKey(node: CallableNode): string | undefined {
    const owner = this.ownerOf(node);
    if (!owner || owner.kind === 'external') return undefined;
    const name = this.callableName(node);
    const suffix = ts.isSetAccessorDeclaration(node) ? '=' : '';
    return `${owner.key}.${name}${suffix}`;
  }

  callableNameNode(node: CallableNode): ts.Node {
    if (ts.isClassLike(node)) return node.name ?? node;
    if (ts.isConstructorDeclaration(node)) {
      return node.getChildren().find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword) ?? node;
    }
    if (ts.isArrowFunction(node)) return node;
    return node.name ?? node;
  }

  /** Function-like node holding the body (for parameters/body walking). */
  functionOf(node: CallableNode): ts.SignatureDeclaration | undefined {
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
      const init = node.initializer && skipOuter(node.initializer);
      return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
    }
    if (ts.isClassLike(node) || ts.isPropertySignature(node)) return undefined;
    return node;
  }

  hasBody(node: CallableNode): boolean {
    if (this.isLibraryFile(node.getSourceFile())) return false;
    if (ts.isClassLike(node)) return instancePropertyInitializers(node).length > 0;
    if (ts.isConstructorDeclaration(node)) return !!node.body || instancePropertyInitializers(node.parent).length > 0;
    const fn = this.functionOf(node);
    return !!fn && !!(fn as ts.FunctionLikeDeclaration).body;
  }

  isStatic(node: CallableNode): boolean {
    if (ts.isClassLike(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) ||
      ts.isPropertyAssignment(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
    if (this.synthetic(node)) return false;
    return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
  }

  methodRef(node: CallableNode): MethodRef | undefined {
    const owner = this.ownerOf(node);
    // a library callable has no key (library call targets are built by resolve.ts)
    if (!owner || owner.kind === 'external') return undefined;
    const name = this.callableName(node);
    const sf = node.getSourceFile();
    return {
      key: this.callableKey(node)!,
      name,
      owner,
      isStatic: this.isStatic(node),
      declaration: this.range(this.callableNameNode(node), sf),
      hasBody: this.hasBody(node),
    };
  }

  /** All callables of a project file, indexed by key (cached per program). */
  callablesOf(sf: ts.SourceFile): Map<string, CallableNode> {
    let index = this.callableIndex.get(sf.fileName);
    if (index) return index;
    index = new Map();
    const add = (n: CallableNode): void => {
      const key = this.callableKey(n);
      if (key && !index!.has(key)) index!.set(key, n);
    };
    const addClass = (cls: ts.ClassLikeDeclaration): void => {
      let hasCtor = false;
      for (const m of cls.members) {
        if (ts.isConstructorDeclaration(m)) {
          if (m.body) {
            hasCtor = true;
            add(m);
          }
          continue;
        }
        if (ts.isMethodDeclaration(m) && !m.body && !this.isAbstract(m)) continue; // overload signature
        const c = this.asCallable(m);
        if (c) add(c);
      }
      if (!hasCtor) add(cls);
    };
    const visitStatements = (statements: ts.NodeArray<ts.Statement>): void => {
      for (const st of statements) {
        if (ts.isClassDeclaration(st)) addClass(st);
        else if (ts.isInterfaceDeclaration(st)) {
          for (const m of st.members) {
            const c = this.asCallable(m);
            if (c) add(c);
          }
        } else if (ts.isFunctionDeclaration(st) && st.body) add(st);
        else if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            const c = this.asCallable(d);
            if (c) add(c);
            else if (d.initializer && ts.isClassExpression(skipOuter(d.initializer))) {
              addClass(skipOuter(d.initializer) as ts.ClassExpression);
            }
          }
        } else if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) {
          for (const m of st.type.members) {
            const c = this.asCallable(m);
            if (c) add(c);
          }
        } else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) {
          visitStatements(st.body.statements);
        }
      }
    };
    visitStatements(sf.statements);
    for (const syn of this.syntheticsOf(sf).byNode.values()) add(syn.node);
    this.callableIndex.set(sf.fileName, index);
    return index;
  }

  findCallableByKey(key: string): CallableNode | undefined {
    const hash = key.indexOf('#');
    if (hash < 0 || key.startsWith('lib:')) return undefined;
    const sf = this.getSourceFile(`${this.projectRoot}/${key.slice(0, hash)}`);
    return sf ? this.callablesOf(sf).get(key) : undefined;
  }

  /** Innermost supported callable containing the offset. */
  enclosingCallable(sf: ts.SourceFile, offset: number): CallableNode | undefined {
    let node = innermostNodeAt(sf, offset);
    for (; node && !ts.isSourceFile(node); node = node.parent) {
      const c = this.asCallable(node);
      if (c && (ts.isClassLike(c) || ts.isConstructorDeclaration(c) || this.functionOf(c))) return c;
    }
    return undefined;
  }

  /** Class or interface declaration by class key. */
  findTypeDecl(classKey: string): TypeDeclNode | undefined {
    const hash = classKey.indexOf('#');
    if (hash < 0 || classKey.startsWith('lib:')) return undefined;
    const sf = this.getSourceFile(`${this.projectRoot}/${classKey.slice(0, hash)}`);
    if (!sf) return undefined;
    const name = classKey.slice(hash + 1);
    let found: TypeDeclNode | undefined;
    const visit = (statements: ts.NodeArray<ts.Statement>): void => {
      for (const st of statements) {
        if (found) return;
        if ((ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
          this.typeDeclName(st) === name) {
          found = st;
        } else if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            const init = d.initializer && skipOuter(d.initializer);
            if (init && ts.isClassExpression(init) && this.typeDeclName(init) === name) found = init;
          }
        } else if (ts.isModuleDeclaration(st) && st.body && ts.isModuleBlock(st.body)) {
          visit(st.body.statements);
        }
      }
    };
    visit(sf.statements);
    return found;
  }
}

/** Parentheses, `as`, `satisfies`, `<T>` or `!` around an expression. */
export type OuterExpression = ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression |
  ts.TypeAssertion | ts.NonNullExpression;

export function isOuterExpression(n: ts.Node): n is OuterExpression {
  return ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n);
}

export function skipOuter(node: ts.Expression): ts.Expression {
  let n = node;
  while (isOuterExpression(n)) n = n.expression;
  return n;
}

/** Parent of an expression, skipping parentheses / type assertions around it. */
export function outerParent(node: ts.Node): ts.Node {
  let p = node.parent;
  while (p && isOuterExpression(p)) p = p.parent;
  return p;
}

/** Name of an object literal: `const x = {…}` → x; `prop: {…}` → prop; otherwise undefined. */
export function objectLiteralNameNode(obj: ts.ObjectLiteralExpression): ts.Identifier | undefined {
  // (the object is the initializer: a name is never an object literal)
  const p = outerParent(obj);
  if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name;
  return undefined;
}

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

export function instancePropertyInitializers(cls: ts.ClassLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m) && m.initializer &&
      !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static)) {
      out.push(m.initializer);
    }
  }
  return out;
}

/** The deepest node whose span holds `offset` (the source file itself when no statement does). */
export function innermostNodeAt(sf: ts.SourceFile, offset: number): ts.Node {
  let current: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(current, (child) => {
      if (!next && child.getStart(sf, true) <= offset && offset < child.getEnd()) next = child;
    });
    if (!next) return current;
    current = next;
  }
}
