import ts from 'typescript';
import type { ClassRef, MemberVisibility } from '@seqcall/protocol';
import type { ClassInfo, FieldInfo } from '../adapter';
import { type CallableNode, type TsModel, type TypeDeclNode, skipOuter } from './model';
import { normalizePath } from './paths';

export function extractClassInfo(model: TsModel, classKey: string): ClassInfo | undefined {
  if (classKey.endsWith('#<module>')) return moduleInfo(model, classKey);
  if (model.isSyntheticOwner(classKey)) return syntheticInfo(model, classKey);
  const decl = model.findTypeDecl(classKey);
  if (!decl) return undefined;
  return ts.isClassLike(decl) ? classInfo(model, decl) : interfaceInfo(model, decl);
}

function emptyInfo(ref: ClassRef, file?: string): ClassInfo {
  return {
    ref,
    file,
    decorators: [],
    implements: [],
    fields: [],
    constructorParams: [],
    hasPrivateConstructor: false,
    hasStaticInstance: false,
    allMembersStatic: false,
    isExportedInstance: false,
    methods: [],
  };
}

function moduleInfo(model: TsModel, classKey: string): ClassInfo | undefined {
  const sf = model.getSourceFile(`${model.projectRoot}/${classKey.slice(0, -'#<module>'.length)}`);
  if (!sf) return undefined;
  const info = emptyInfo(model.moduleRef(sf), normalizePath(sf.fileName));
  const exported = exportedSymbols(model, sf);
  for (const [key, node] of model.callablesOf(sf)) {
    if (key.startsWith(`${classKey}.`)) {
      const name = model.callableName(node);
      const visibility = isExported(model, node, exported) ? {} : { visibility: 'private' as const };
      info.methods.push({ name, isStatic: false, signature: callableSignature(model, name, node), ...visibility });
    }
  }
  return info;
}

/**
 * FR-12.18 what a module exports, aliases (`export { a as b }`, `export default a`) resolved to their declarations;
 * undefined for a script (no import / export): its top-level functions are global.
 */
function exportedSymbols(model: TsModel, sf: ts.SourceFile): Set<ts.Symbol> | undefined {
  const moduleSymbol = model.checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return undefined;
  const out = new Set<ts.Symbol>();
  for (const e of model.checker.getExportsOfModule(moduleSymbol)) {
    out.add(e);
    if (e.flags & ts.SymbolFlags.Alias) out.add(model.checker.getAliasedSymbol(e));
  }
  return out;
}

/** FR-12.18 a module-level function is public when the module exports it (or the file is a script); otherwise it is private to the file. */
function isExported(model: TsModel, node: CallableNode, exported: Set<ts.Symbol> | undefined): boolean {
  if (!exported || ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) return true;
  // (module callables are named: functions, consts, object-literal members; an unnamed one is `export default`)
  const symbol = model.checker.getSymbolAtLocation((node as ts.NamedDeclaration).name!);
  return !!symbol && exported.has(symbol);
}

/** FR-12.18 a class member's visibility: `private`, `#name` or `protected` (absent: public). */
function memberVisibility(m: ts.Node): { visibility?: MemberVisibility } {
  const name = (m as ts.NamedDeclaration).name;
  const flags = ts.getCombinedModifierFlags(m as ts.Declaration);
  if ((name && ts.isPrivateIdentifier(name)) || flags & ts.ModifierFlags.Private) return { visibility: 'private' };
  if (flags & ts.ModifierFlags.Protected) return { visibility: 'protected' };
  return {};
}

/** Object literal / closure owner of functional code (see SyntheticCallable). */
function syntheticInfo(model: TsModel, classKey: string): ClassInfo | undefined {
  // (isSyntheticOwner found the file)
  const sf = model.getSourceFile(`${model.projectRoot}/${classKey.slice(0, classKey.indexOf('#'))}`)!;
  let info: ClassInfo | undefined;
  for (const [key, node] of model.callablesOf(sf)) {
    if (!key.startsWith(`${classKey}.`)) continue;
    info ??= {
      ...emptyInfo(model.ownerOf(node)!, normalizePath(sf.fileName)),
      synthetic: true,
      ...(model.isLocalFunctionsOwner(sf, classKey.slice(classKey.indexOf('#') + 1)) ? { localFunctions: true } : {}),
    };
    const name = model.callableName(node);
    info.methods.push({ name, isStatic: false, signature: callableSignature(model, name, node) });
  }
  return info;
}

/** Signature of any callable: from its function, else from its (function) type. */
function callableSignature(model: TsModel, name: string, node: CallableNode): string {
  const fn = model.functionOf(node);
  if (fn) return signatureOf(model, name, fn);
  // a function-typed property: isFunctionTyped found a call signature on this same type
  try {
    const t = model.checker.getNonNullableType(model.checker.getTypeAtLocation(node));
    const sig = t.getCallSignatures()[0];
    const params = sig.parameters
      .map((p) => `${p.name}: ${model.checker.typeToString(model.checker.getTypeOfSymbolAtLocation(p, node))}`)
      .join(', ');
    return `${name}(${params}): ${model.checker.typeToString(sig.getReturnType())}`;
    /* v8 ignore start -- TypeScript's checker throws on some broken code; no known input throws here, an unknown one must not fail the whole request */
  } catch {
    return `${name}()`;
  }
  /* v8 ignore stop */
}

function heritageRefs(model: TsModel, decl: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, token: ts.SyntaxKind): ClassRef[] {
  const out: ClassRef[] = [];
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token !== token) continue;
    for (const t of clause.types) {
      const sym = model.checker.getSymbolAtLocation(t.expression);
      const target = sym && model.typeDeclFromSymbol(sym);
      const ref = target ? model.classRef(target) : model.classRefFromType(model.checker.getTypeAtLocation(t));
      if (ref) out.push(ref);
    }
  }
  return out;
}

function typeRefOf(model: TsModel, node: ts.Node): ClassRef | undefined {
  try {
    return model.classRefFromType(model.checker.getTypeAtLocation(node));
    /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here (1M+ calls on damaged sources) */
  } catch {
    return undefined;
  }
  /* v8 ignore stop */
}

/** Library collection types whose last type argument is the element (Map / Record-like: the value). */
const COLLECTIONS = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Map', 'ReadonlyMap', 'WeakSet', 'WeakMap', 'Iterable', 'AsyncIterable', 'IterableIterator', 'Record']);

/**
 * FR-12.15 a field's class: for a collection (`User[]`, `readonly User[]`, `Set<User>`, `Map<string, User>`,
 * `Record<string, User>`) the element's class, flagged `collection`.
 */
function fieldTypeOf(model: TsModel, node: ts.Node): Pick<FieldInfo, 'type' | 'collection'> {
  try {
    const t = model.checker.getNonNullableType(model.checker.getTypeAtLocation(node));
    let element: ts.Type | undefined;
    if (model.checker.isArrayType(t) || model.checker.isTupleType(t)) element = model.checker.getTypeArguments(t as ts.TypeReference)[0];
    else {
      const name = t.aliasSymbol?.getName() ?? t.getSymbol()?.getName();
      const args = t.aliasTypeArguments ?? ((t as ts.TypeReference).target ? model.checker.getTypeArguments(t as ts.TypeReference) : undefined);
      if (name && COLLECTIONS.has(name) && args?.length) element = args[args.length - 1];
    }
    if (element) {
      const type = model.classRefFromType(element);
      return type ? { type, collection: true } : {};
    }
    const type = model.classRefFromType(t);
    return type ? { type } : {};
    /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here (1M+ calls on damaged sources) */
  } catch {
    return {};
  }
  /* v8 ignore stop */
}

function classInfo(model: TsModel, decl: ts.ClassLikeDeclaration): ClassInfo {
  const ref = model.classRef(decl);
  const sf = decl.getSourceFile();
  const info = emptyInfo(ref, normalizePath(sf.fileName));
  // (a class declaration or expression can have decorators)
  info.decorators = (ts.getDecorators(decl) ?? []).map((d) => {
    const e = ts.isCallExpression(d.expression) ? d.expression.expression : d.expression;
    return ts.isPropertyAccessExpression(e) ? e.name.text : e.getText(sf);
  });
  info.extends = heritageRefs(model, decl, ts.SyntaxKind.ExtendsKeyword)[0];
  info.implements = heritageRefs(model, decl, ts.SyntaxKind.ImplementsKeyword);

  const fields = new Map<string, FieldInfo>();
  let staticMembers = 0;
  let instanceMembers = 0;
  const isStatic = (m: ts.Node): boolean => (ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

  for (const m of decl.members) {
    if (ts.isConstructorDeclaration(m)) {
      if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword)) {
        info.hasPrivateConstructor = true;
      }
      if (!m.body && decl.members.some((o) => ts.isConstructorDeclaration(o) && o.body && o !== m)) continue;
      info.constructorParams = m.parameters.map((p) => ({ name: p.name.getText(sf), type: typeRefOf(model, p) }));
      for (const p of m.parameters) {
        if (ts.isParameterPropertyDeclaration(p, m) && ts.isIdentifier(p.name)) {
          fields.set(p.name.text, { name: p.name.text, ...fieldTypeOf(model, p), isStatic: false, injected: true, declaration: model.range(p.name) });
          instanceMembers++;
        }
      }
      collectAssignedFields(model, m, fields);
      info.methods.push({ name: 'constructor', isStatic: false, signature: signatureOf(model, 'constructor', m), ...memberVisibility(m) });
      continue;
    }
    const staticMember = isStatic(m);
    if (ts.isPropertyDeclaration(m) && m.name && !model.asCallable(m)) {
      const name = m.name.getText(sf);
      const ft = fieldTypeOf(model, m);
      // declared after the constructor that assigns it from a parameter: still injected
      fields.set(name, { name, ...ft, isStatic: staticMember, injected: fields.get(name)?.injected ?? false, declaration: model.range(m.name) });
      if (staticMember && !ft.collection && ft.type?.key === ref.key) info.hasStaticInstance = true;
    } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m) || model.asCallable(m)) {
      if (ts.isMethodDeclaration(m) && !m.body && !model.isAbstract(m)) continue; // overload
      const name = m.name!.getText(sf); // methods, accessors, function-typed properties are named
      const signature = ts.isPropertyDeclaration(m)
        ? callableSignature(model, name, m)
        : signatureOf(model, name, m as ts.SignatureDeclaration);
      info.methods.push({ name, isStatic: staticMember, signature: accessorPrefix(m) + signature, ...memberVisibility(m) });
      if (staticMember && (name === 'getInstance' || (name === 'instance' && ts.isGetAccessorDeclaration(m)))) {
        info.hasStaticInstance = true;
      }
    } else if (!ts.isClassStaticBlockDeclaration(m) && !ts.isSemicolonClassElement(m)) {
      // index signatures etc.
      if (!staticMember) instanceMembers++;
      continue;
    } else {
      continue;
    }
    if (staticMember) staticMembers++;
    else instanceMembers++;
  }
  info.fields = [...fields.values()];
  if (decl.members.every(holdsData)) info.dataOnly = true;
  info.allMembersStatic = staticMembers > 0 && instanceMembers === 0;
  info.isExportedInstance = hasExportedInstance(model, decl, sf);
  if (isInterchangeable(model, decl, 0, false)) info.interchangeable = true;
  if (info.interchangeable || isInterchangeable(model, decl, 0, true)) info.sameArgsInterchangeable = true;
  return info;
}

const COMPOUND_ASSIGNMENT = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
]);

/**
 * FR-5.10 objects of the class cannot differ (`withArgs`: when built with the same constructor arguments): no
 * constructor parameters (unless `withArgs`), no field written outside the constructor (a method, an accessor, a
 * function the constructor stores — they run later), and no field holding something of its own that can change — an
 * array / object literal, a library object (`new Map()`), or a project object that is not interchangeable itself
 * (`new CartView(cart)`: interchangeable with the same arguments, given only literals or this constructor's
 * parameters). A base class must pass the same checks (`super(…)` given literals / the parameters). Fields taken
 * from what everyone shares (`getAppStore().catalog`) are fine: every object gets the same.
 */
/**
 * Results per program, class and mode: bases and nested classes are asked again for every class that uses them. Per
 * program — TypeScript keeps unchanged files across edits, and a class's answer depends on its base's file.
 */
const interchangeableCache = new WeakMap<ts.Program, WeakMap<ts.Node, Map<string, boolean>>>();

function isInterchangeable(model: TsModel, decl: ts.ClassLikeDeclaration, depth: number, withArgs: boolean, asBase = false): boolean {
  const mode = `${withArgs}|${asBase}`;
  let cache = interchangeableCache.get(model.program);
  if (!cache) interchangeableCache.set(model.program, (cache = new WeakMap()));
  const known = cache.get(decl)?.get(mode);
  if (known !== undefined) return known;
  const result = checkInterchangeable(model, decl, depth, withArgs, asBase);
  // a result cut short by the depth limit is not the class's own answer
  if (depth === 0 || result) cache.set(decl, (cache.get(decl) ?? new Map()).set(mode, result));
  return result;
}

function checkInterchangeable(model: TsModel, decl: ts.ClassLikeDeclaration, depth: number, withArgs: boolean, asBase: boolean): boolean {
  if (depth > 4 || !ts.isClassDeclaration(decl) || model.isLibraryFile(decl.getSourceFile()) || (!asBase && model.isAbstract(decl))) return false;
  const ctor = decl.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
  if (ctor && ctor.parameters.length && !withArgs) return false;
  const params = new Set(ctor?.parameters.map((p) => p.name) ?? []);
  /** Literals and (when the objects are compared by their arguments) this constructor's parameters. */
  const sameEachTime = (args: readonly ts.Expression[] | undefined): boolean =>
    (args ?? []).every((a) => {
      const x = skipOuter(a);
      if (ts.isLiteralExpression(x) || x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword) return true;
      if (!ts.isIdentifier(x)) return false;
      if (x.text === 'undefined') return true;
      const d = model.checker.getSymbolAtLocation(x)?.valueDeclaration;
      return !!d && ts.isParameter(d) && params.has(d.name);
    });
  const base = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (base) {
    const baseDecl = model.typeDeclFromType(model.checker.getTypeAtLocation(base.expression));
    if (!baseDecl || !ts.isClassLike(baseDecl) || !isInterchangeable(model, baseDecl, depth + 1, true, true)) return false;
    const superCall = ctor?.body?.statements
      .map((st) => (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && st.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? st.expression : undefined))
      .find(Boolean);
    if (superCall && !sameEachTime(superCall.arguments)) return false;
  }
  const thisField = (e: ts.Expression): boolean => {
    const x = skipOuter(e);
    return (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && skipOuter(x.expression).kind === ts.SyntaxKind.ThisKeyword;
  };
  const ownValue = (init: ts.Expression): boolean => {
    const v = skipOuter(init);
    if (ts.isArrayLiteralExpression(v) || ts.isObjectLiteralExpression(v)) return true;
    if (!ts.isNewExpression(v)) return false;
    const created = model.typeDeclFromType(model.checker.getTypeAtLocation(v));
    return !created || !ts.isClassLike(created) || !sameEachTime(v.arguments) || !isInterchangeable(model, created, depth + 1, true);
  };
  let ok = true;
  const visit = (n: ts.Node, inCtor: boolean): void => {
    if (!ok) return;
    if (ts.isFunctionLike(n) && n !== ctor) return ts.forEachChild(n, (c) => visit(c, false));
    if (ts.isBinaryExpression(n) && COMPOUND_ASSIGNMENT.has(n.operatorToken.kind) && thisField(n.left)) {
      if (!inCtor || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || ownValue(n.right)) ok = false;
    } else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) && thisField(n.operand)) {
      ok = false;
    } else if (ts.isDeleteExpression(n) && thisField(n.expression)) ok = false;
    ts.forEachChild(n, (c) => visit(c, inCtor));
  };
  for (const m of decl.members) {
    if (ts.isPropertyDeclaration(m) && !(ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Static) && m.initializer && !model.asCallable(m) && ownValue(m.initializer)) return false;
    visit(m, m === ctor);
  }
  return ok;
}

function accessorPrefix(m: ts.Node): string {
  if (ts.isGetAccessorDeclaration(m)) return 'get ';
  if (ts.isSetAccessorDeclaration(m)) return 'set ';
  return '';
}

/**
 * `this.x = param` in the constructor (JS-style DI); FR-19.6 also from a destructured parameter
 * (`constructor({ repo, clock }: Deps)` → `this.repo = repo`) and from a parameter's property (`this.repo = deps.repo`)
 * — those two only for an abstraction (interface / abstract class: a port), since entities take their values the same
 * way (`this._id = props.id` with a value object). A field declared in the class body and assigned so is injected too.
 */
function collectAssignedFields(model: TsModel, ctor: ts.ConstructorDeclaration, fields: Map<string, FieldInfo>): void {
  if (!ctor.body) return;
  const params = new Set<string>();
  const destructured = new Set<string>();
  const names = (n: ts.BindingName, nested: boolean): void => {
    if (ts.isIdentifier(n)) (nested ? destructured : params).add(n.text);
    else for (const e of n.elements) if (ts.isBindingElement(e)) names(e.name, true);
  };
  for (const p of ctor.parameters) names(p.name, false);
  const abstraction = (e: ts.Expression): boolean => {
    const kind = fieldTypeOf(model, e).type?.kind;
    return kind === 'interface' || kind === 'abstract';
  };
  const fromParam = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && params.has(e.text)) ||
    (ts.isIdentifier(e) && destructured.has(e.text) && abstraction(e)) ||
    (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && params.has(e.expression.text) && abstraction(e));
  for (const st of ctor.body.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
    const { left, right, operatorToken } = st.expression;
    if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    if (!ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword) continue;
    const name = left.name.text;
    const r = skipOuter(right);
    const injected = fromParam(r);
    const known = fields.get(name);
    if (known) {
      if (injected) known.injected = true;
      continue;
    }
    fields.set(name, { name, ...fieldTypeOf(model, injected ? r : left), isStatic: false, injected, declaration: model.range(left.name) });
  }
}

function hasExportedInstance(model: TsModel, decl: ts.ClassLikeDeclaration, sf: ts.SourceFile): boolean {
  const name = model.typeDeclName(decl);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer && skipOuter(d.initializer);
      if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === name) return true;
    }
  }
  return false;
}

function interfaceInfo(model: TsModel, decl: TypeDeclNode): ClassInfo {
  const ref = model.classRef(decl);
  const sf = decl.getSourceFile();
  const info = emptyInfo(ref, normalizePath(sf.fileName));
  if (ts.isInterfaceDeclaration(decl)) {
    info.extends = heritageRefs(model, decl, ts.SyntaxKind.ExtendsKeyword)[0];
  }
  const members = ts.isInterfaceDeclaration(decl)
    ? decl.members
    : ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)
      ? decl.type.members
      : ([] as unknown as ts.NodeArray<ts.TypeElement>);
  for (const m of members) {
    const name = m.name ? m.name.getText(sf) : 'call';
    if (ts.isMethodSignature(m)) {
      info.methods.push({ name, isStatic: false, signature: signatureOf(model, name, m) });
    } else if (ts.isPropertySignature(m)) {
      if (m.type && ts.isFunctionTypeNode(m.type)) {
        info.methods.push({ name, isStatic: false, signature: signatureOf(model, name, m.type) });
      } else if (model.isFunctionTyped(m)) {
        info.methods.push({ name, isStatic: false, signature: callableSignature(model, name, m) });
      } else {
        info.fields.push({ name, ...fieldTypeOf(model, m), isStatic: false, injected: false, declaration: model.range(m.name) });
      }
    }
  }
  // FR-7.15 a data shape: no methods, its own or inherited (a type alias other than an object type: unknown)
  if (ts.isInterfaceDeclaration(decl) || (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type))) {
    try {
      const props = model.checker.getPropertiesOfType(model.checker.getTypeAtLocation(decl.name));
      if (!info.methods.length && props.every((p) => !(p.declarations ?? []).some((d) => ts.isMethodSignature(d) || ts.isMethodDeclaration(d) || ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && model.asCallable(d))))) info.dataOnly = true;
      /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here (1M+ calls on damaged sources) */
    } catch {
      // unknown
    }
    /* v8 ignore stop */
  }
  return info;
}

/**
 * FR-7.15 a class member that only holds data: a field (not a function), a constructor that only stores values, a
 * method / accessor that only returns a field or a constant or sets a field (`return this` allowed).
 */
function holdsData(m: ts.ClassElement): boolean {
  if (ts.isPropertyDeclaration(m)) return !m.initializer || isPlain(m.initializer) || (ts.isNewExpression(m.initializer) && (m.initializer.arguments ?? []).every(isPlain));
  if (ts.isConstructorDeclaration(m)) return !m.body || m.body.statements.every((s) => storesValue(s) || isSuperCall(s));
  if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
    const body = m.body?.statements;
    if (!body) return false; // abstract or an overload
    // a getter takes no arguments
    if (body.length === 1 && ts.isReturnStatement(body[0])) return !m.parameters.length && (!body[0].expression || isPlain(body[0].expression));
    const [set, back] = body;
    return storesValue(set) && (body.length === 1 || (body.length === 2 && ts.isReturnStatement(back) && back.expression?.kind === ts.SyntaxKind.ThisKeyword));
  }
  return ts.isSemicolonClassElement(m) || ts.isIndexSignatureDeclaration(m);
}

/** `this.x = <plain>` */
function storesValue(s: ts.Statement | undefined): boolean {
  if (!s || !ts.isExpressionStatement(s) || !ts.isBinaryExpression(s.expression) || s.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const { left, right } = s.expression;
  return ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && isPlain(right);
}

function isSuperCall(s: ts.Statement): boolean {
  return ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.kind === ts.SyntaxKind.SuperKeyword && s.expression.arguments.every(isPlain);
}

/** A value read without logic: a name, a literal, `this.x`, `Enum.A`, an array / object of those. */
function isPlain(e: ts.Expression): boolean {
  e = skipOuter(e);
  if (ts.isIdentifier(e) || ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.ThisKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) return isPlain(e.operand);
  if (ts.isPropertyAccessExpression(e)) return e.expression.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(e.expression);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every(isPlain);
  if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && isPlain(p.initializer)));
  return false;
}

/** "getUser(id: string): Promise<User>" */
export function signatureOf(model: TsModel, name: string, fn: ts.SignatureDeclaration): string {
  const { checker } = model;
  const params = fn.parameters
    .map((p) => {
      const pname = p.name.getText();
      let ptype: string;
      try {
        ptype = p.type ? p.type.getText() : checker.typeToString(checker.getTypeAtLocation(p));
        /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here (1M+ calls on damaged sources) */
      } catch {
        ptype = 'any';
      }
      /* v8 ignore stop */
      return `${p.dotDotDotToken ? '...' : ''}${pname}${p.questionToken ? '?' : ''}: ${ptype}`;
    })
    .join(', ');
  if (ts.isConstructorDeclaration(fn)) return `constructor(${params})`;
  try {
    // (a signature declaration always has a signature)
    const ret = fn.type ? fn.type.getText() : checker.typeToString(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(fn)!));
    return `${name}(${params}): ${ret}`;
    /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getTypeAtLocation on an import clause, getResolvedSignature on a dangling decorator); no input found that makes it throw here (1M+ calls on damaged sources) */
  } catch {
    return `${name}(${params})`;
  }
  /* v8 ignore stop */
}
