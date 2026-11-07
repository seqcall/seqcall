import ts from 'typescript';
import type { CallResult, ClassRef, MethodRef } from '@seqcall/protocol';
import type { ArgumentFunction, ArgumentOrigin, ReceiverOrigin } from '../adapter';
import { type CallableNode, type TsModel, outerParent, skipOuter } from './model';

export type CallLike = ts.CallExpression | ts.NewExpression;

export interface ResolvedTarget {
  target?: MethodRef;
  isLibrary: boolean;
  libraryName?: string;
}

/** Map an arbitrary declaration (signature declaration, function type, class…) to a canonical callable. */
export function toCallable(model: TsModel, decl: ts.Node): CallableNode | undefined {
  let d = decl;
  if ((ts.isFunctionTypeNode(d) || ts.isConstructorTypeNode(d)) && ts.isPropertySignature(d.parent)) d = d.parent;
  if (ts.isClassLike(d)) {
    const ctor = d.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
    return ctor ?? d;
  }
  if (ts.isConstructorDeclaration(d) && !d.body) {
    const impl = d.parent.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body);
    return impl ?? d;
  }
  if (ts.isMethodDeclaration(d) && !d.body && !model.isAbstract(d) && ts.isClassLike(d.parent)) {
    // overload signature → implementation
    const name = model.callableName(d);
    const impl = d.parent.members.find(
      (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && !!m.body && model.callableName(m) === name,
    );
    if (impl) return impl;
  }
  return model.asCallable(d);
}

/** Resolve the declaration invoked by a call / new expression (aliases resolved). */
export function resolveTarget(model: TsModel, call: CallLike, methodName: string): ResolvedTarget {
  const { checker } = model;
  // FR-1.2: a function-typed property (`ports.load()`, also via a type alias) is a method of its owner
  let decl: ts.Node | undefined = functionTypedPropertyOf(model, call);
  if (!decl) {
    try {
      decl = checker.getResolvedSignature(call)?.declaration;
      /* v8 ignore start -- TypeScript's checker throws on some broken code (fuzzing found getResolvedSignature on a
         dangling decorator, getTypeAtLocation on an import clause); no input found that makes it throw for a call or
         `new` expression (1M+ calls on damaged sources). Kept for `new`: the later calls resolve only resolved ones */
    } catch {
      decl = undefined;
    }
    /* v8 ignore stop */
  }
  if (!decl || ts.isJSDocSignature(decl)) {
    const sym = calleeSymbol(model, call);
    decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  }
  // a method seen through a type that maps a class's methods (`Abortable<CatalogApi>`: each method an
  // `CancellableFn<A, R>`): the signature is the mapping type's `(...args: A): R`, the member is still the method
  if (decl && !model.isLibraryFile(decl.getSourceFile()) && !toCallable(model, decl)) {
    const mapped = calleeSymbol(model, call)?.declarations?.find((d) => toCallable(model, d));
    if (mapped) decl = mapped;
  }
  // `new X()` without explicit constructor: the signature has no declaration → fall back to the class; for a class
  // expression (`const Shop = class {…}`, `new (class {…})()`) the class of the created instance
  if (ts.isNewExpression(call) && !(decl && isConstructorLike(decl))) {
    const sym = calleeSymbol(model, call);
    const classDecl = (sym && model.typeDeclFromSymbol(sym)) ?? model.typeDeclFromType(model.checker.getTypeAtLocation(call));
    if (classDecl && ts.isClassLike(classDecl)) decl = classDecl;
  }
  if (!decl) return { isLibrary: false };
  return targetOfDeclaration(model, decl, methodName);
}

/** The callable a declaration stands for: a library member, or a project method / function. */
function targetOfDeclaration(model: TsModel, decl: ts.Node, methodName: string): ResolvedTarget {
  const sf = decl.getSourceFile();
  if (model.isLibraryFile(sf)) {
    const owner = model.externalRef(decl);
    const ownerName = libraryOwnerName(decl);
    return {
      isLibrary: true,
      libraryName: owner.name,
      target: { key: `${owner.key}#${ownerName}.${methodName}`, name: methodName, owner, isStatic: false, hasBody: false },
    };
  }
  const callable = toCallable(model, decl);
  const target = callable && model.methodRef(callable);
  return { target, isLibrary: false };
}

/** FR-1.13: a bare identifier callee that is a parameter of function type (`cb(x)`). */
export function invokedParameter(model: TsModel, call: CallLike): string | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = skipOuter(call.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  const decl = symbolDecl(model, callee);
  return decl && ts.isParameter(decl) ? callee.text : undefined;
}

/**
 * FR-1.13: the declared type of an invoked function parameter when it is a named project type
 * (`listBranches: BranchLister` with `type BranchLister = (repo: string) => …`): the port the
 * callee depends on, whatever function the caller passes.
 */
export function invokedParameterType(model: TsModel, call: CallLike): ClassRef | undefined {
  // called for an invoked parameter only (invokedParameter): a call of an identifier
  const callee = skipOuter((call as ts.CallExpression).expression) as ts.Identifier;
  const decl = symbolDecl(model, callee);
  if (!decl || !ts.isParameter(decl) || !decl.type || !ts.isTypeReferenceNode(decl.type)) return undefined;
  let sym = model.checker.getSymbolAtLocation(decl.type.typeName);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
  const typeDecl = sym?.declarations?.find((d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d));
  if (!typeDecl || model.isLibraryFile(typeDecl.getSourceFile())) return undefined;
  return model.classRef(typeDecl as ts.TypeAliasDeclaration | ts.InterfaceDeclaration);
}

/**
 * FR-1.13: a function passed as an argument — a reference to a project / library function or
 * method (`toDto`, `Mapper.toDto`, `this.handle`, `this.handle.bind(this)`), or an inline lambda.
 * Parameters passed on are not functions here: they are bound through `argOrigins`.
 */
export function argumentFunction(model: TsModel, arg: ts.Expression, sf: ts.SourceFile): ArgumentFunction | undefined {
  let e = skipOuter(arg);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { kind: 'lambda', range: model.range(e, sf) };
  // f.bind(thisArg) still runs f
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(skipOuter(e.expression))) {
    const callee = skipOuter(e.expression) as ts.PropertyAccessExpression;
    if (callee.name.text === 'bind') e = skipOuter(callee.expression);
  }
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
  const nameNode = ts.isPropertyAccessExpression(e) ? e.name : e;
  let sym = model.checker.getSymbolAtLocation(nameNode);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
  if (!decl || ts.isParameter(decl)) return undefined;
  const isFunction =
    ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) ||
    ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) && !!model.asCallable(decl));
  if (!isFunction) return undefined;
  const resolved = targetOfDeclaration(model, decl, nameNode.text);
  if (!resolved.target) return undefined;
  const receiver: ReceiverOrigin = ts.isPropertyAccessExpression(e) ? objectOrigin(model, skipOuter(e.expression)) : { kind: 'module', name: e.text };
  const receiverTypeRef = ts.isPropertyAccessExpression(e)
    ? receiver.kind === 'self' || receiver.kind === 'super'
      ? (() => { const cls = enclosingClass(e); return cls ? model.classRef(cls) : undefined; })()
      : model.classRefFromType(model.checker.getTypeAtLocation(e.expression))
    : undefined;
  return {
    kind: 'method',
    target: resolved.target,
    receiver,
    ...(receiverTypeRef ? { receiverType: receiverTypeRef } : {}),
    isLibrary: resolved.isLibrary,
    ...(resolved.libraryName ? { libraryName: resolved.libraryName } : {}),
  };
}

/** Callee `x.prop` / `x['prop']` declared as a function-typed property signature / class property. */
function functionTypedPropertyOf(model: TsModel, call: CallLike): ts.Node | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = skipOuter(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const sym = calleeSymbol(model, call);
  for (const d of sym?.declarations ?? []) {
    if ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && model.asCallable(d)) return d;
  }
  return undefined;
}

function isConstructorLike(decl: ts.Node): boolean {
  return ts.isConstructorDeclaration(decl) || ts.isConstructSignatureDeclaration(decl) || ts.isConstructorTypeNode(decl);
}

function libraryOwnerName(decl: ts.Node): string {
  for (let n: ts.Node | undefined = decl.parent; n; n = n.parent) {
    if ((ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n) || ts.isModuleDeclaration(n)) && n.name) {
      return (n.name as ts.Identifier | ts.StringLiteral).text;
    }
    if (ts.isSourceFile(n)) break;
  }
  return '<module>';
}

function calleeNameNode(call: CallLike): ts.Node {
  const e = skipOuter(call.expression);
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return e;
}

function calleeSymbol(model: TsModel, call: CallLike): ts.Symbol | undefined {
  let sym = model.checker.getSymbolAtLocation(calleeNameNode(call));
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
  return sym;
}

/** Name of the invoked member ("constructor" for new / super()). */
export function invokedName(call: CallLike): string {
  if (ts.isNewExpression(call)) return 'constructor';
  const e = skipOuter(call.expression);
  if (e.kind === ts.SyntaxKind.SuperKeyword) return 'constructor';
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return compact(e.getText());
}

export function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Source text of an expression without comments, whitespace collapsed (argument labels). */
export function expressionText(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const text = sf.text;
  const comments: ts.CommentRange[] = [];
  const seen = new Set<number>();
  const visitTokens = (n: ts.Node): void => {
    // comments on the previous token's line are "trailing", later ones "leading"
    const ranges = [...(ts.getTrailingCommentRanges(text, n.pos) ?? []), ...(ts.getLeadingCommentRanges(text, n.pos) ?? [])];
    for (const c of ranges) {
      if (c.pos >= start && c.end <= end && !seen.has(c.pos)) {
        seen.add(c.pos);
        comments.push(c);
      }
    }
    for (const child of n.getChildren(sf)) visitTokens(child);
  };
  visitTokens(node);
  if (comments.length === 0) return compact(text.slice(start, end));
  comments.sort((a, b) => a.pos - b.pos);
  let out = '';
  let at = start;
  for (const c of comments) {
    out += text.slice(at, c.pos).trimEnd();
    // keep tokens apart, but no space before closing punctuation / existing whitespace
    // (a comment inside the node is followed by more of it)
    out += /[\s,;)\]}]/.test(text[c.end]) ? '' : ' ';
    at = c.end;
  }
  out += text.slice(at, end);
  return compact(out);
}

/** How the receiver is reached (FR-6.5). */
export function receiverOrigin(model: TsModel, call: CallLike): ReceiverOrigin {
  if (ts.isNewExpression(call)) return { kind: 'none' };
  const callee = skipOuter(call.expression);
  if (callee.kind === ts.SyntaxKind.SuperKeyword) return { kind: 'super' };
  if (ts.isIdentifier(callee)) {
    const decl = symbolDecl(model, callee);
    if (decl && ts.isParameter(decl)) return { kind: 'parameter', name: callee.text };
    // `const { clear } = store; clear()`: a call on the store, the object it was taken out of (FR-6.5)
    const source = decl && destructuredFrom(decl);
    if (source) return objectOrigin(model, source);
    if (decl && ((ts.isVariableDeclaration(decl) && !model.asCallable(decl)) || ts.isBindingElement(decl))) {
      return { kind: 'local', name: callee.text };
    }
    return { kind: 'module', name: callee.text };
  }
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return { kind: 'expression', text: compact(callee.getText()) };
  }
  return objectOrigin(model, skipOuter(callee.expression));
}

/**
 * The object a local was taken out of by object destructuring (`const { clear } = store`, `= useStore()`,
 * `= await getStore()`); not for nested patterns, rest elements or parameters.
 */
function destructuredFrom(decl: ts.Node): ts.Expression | undefined {
  if (!ts.isBindingElement(decl) || decl.dotDotDotToken || !ts.isObjectBindingPattern(decl.parent)) return undefined;
  const v = decl.parent.parent;
  if (!ts.isVariableDeclaration(v) || !v.initializer) return undefined;
  let init = skipOuter(v.initializer);
  if (ts.isAwaitExpression(init)) init = skipOuter(init.expression);
  return init;
}

/** How the object of `obj.member` is reached. */
export function objectOrigin(model: TsModel, obj: ts.Expression): ReceiverOrigin {
  if (obj.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'self' };
  if (obj.kind === ts.SyntaxKind.SuperKeyword) return { kind: 'super' };
  if (ts.isPropertyAccessExpression(obj) && skipOuter(obj.expression).kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: 'field', name: obj.name.text };
  }
  if (ts.isIdentifier(obj)) {
    const sym = aliasedSymbol(model, obj);
    if (sym) {
      if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) return { kind: 'static' };
      const vd = sym.valueDeclaration ?? sym.declarations?.[0];
      if (vd && (ts.isSourceFile(vd) || ts.isModuleDeclaration(vd))) return { kind: 'module', name: obj.text };
      if (vd && ts.isParameter(vd)) return { kind: 'parameter', name: obj.text };
    }
    return { kind: 'local', name: obj.text };
  }
  return { kind: 'expression', text: compact(obj.getText()) };
}

function aliasedSymbol(model: TsModel, id: ts.Identifier): ts.Symbol | undefined {
  let sym = model.checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
  return sym;
}

function symbolDecl(model: TsModel, id: ts.Identifier): ts.Declaration | undefined {
  const sym = aliasedSymbol(model, id);
  return sym?.valueDeclaration ?? sym?.declarations?.[0];
}

/**
 * Origin of an argument expression, for binding the callee's parameter to the caller's
 * participant (FR-6.5). `createOrdinal` maps nested `new` expressions to their call-site ordinal.
 */
export function argumentOrigin(
  model: TsModel,
  arg: ts.Expression,
  createOrdinal: (n: ts.NewExpression) => number | undefined,
): ArgumentOrigin | undefined {
  const e = skipOuter(arg);
  if (e.kind === ts.SyntaxKind.ThisKeyword) return { kind: 'self' };
  if (ts.isPropertyAccessExpression(e) && skipOuter(e.expression).kind === ts.SyntaxKind.ThisKeyword) {
    return { kind: 'field', name: e.name.text };
  }
  // (an argument `new X()` is collected with the call: collect visits the arguments first)
  if (ts.isNewExpression(e)) return { kind: 'created', ordinal: createOrdinal(e)! };
  if (ts.isIdentifier(e)) return variableOrigin(model, e);
  return undefined;
}

function variableOrigin(model: TsModel, id: ts.Identifier): ArgumentOrigin | undefined {
  const decl = symbolDecl(model, id);
  if (!decl) return undefined;
  if (ts.isParameter(decl)) return { kind: 'parameter', name: id.text };
  if ((ts.isVariableDeclaration(decl) && !model.asCallable(decl)) || ts.isBindingElement(decl)) return { kind: 'local', name: id.text };
  return undefined;
}

/** `const r = new X()` → local r; `this.x = new X()` → field x (FR-6.5). */
export function assignmentTarget(call: ts.NewExpression): { kind: 'local' | 'field'; name: string } | undefined {
  let p = outerParent(call);
  if (ts.isAwaitExpression(p)) p = outerParent(p);
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { kind: 'local', name: p.name.text };
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = skipOuter(p.left);
    if (ts.isIdentifier(left)) return { kind: 'local', name: left.text };
    if (ts.isPropertyAccessExpression(left) && skipOuter(left.expression).kind === ts.SyntaxKind.ThisKeyword) {
      return { kind: 'field', name: left.name.text };
    }
  }
  return undefined;
}

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
]);

/**
 * FR-9.4: where a call's result goes — `const user = await f()` → user, `this.cache = f()` → cache,
 * `const { a, b } = f()` → {a, b}, `x ??= f()` (operator kept), `return f()` / `=> f()` → return.
 * The value passes through `c ? f() : g()` (not the condition) and `a ?? f()` / `a || f()`.
 * Anything else (argument of another call, condition, discarded) → undefined.
 */
export function callResult(call: ts.CallExpression | ts.NewExpression): CallResult | undefined {
  let node: ts.Node = call;
  let p = outerParent(node);
  while (ts.isAwaitExpression(p) || passesValue(p, skipOuterNode(node, p))) {
    node = p;
    p = outerParent(p);
  }
  if (ts.isVariableDeclaration(p) && p.initializer && skipOuter(p.initializer) === skipOuter(node as ts.Expression)) {
    return { kind: 'assign', target: compactTarget(p.name.getText()), operator: '=' };
  }
  if (ts.isBinaryExpression(p) && ASSIGNMENT_OPERATORS.has(p.operatorToken.kind) && skipOuter(p.right) === skipOuter(node as ts.Expression)) {
    return { kind: 'assign', target: compactTarget(p.left.getText()), operator: p.operatorToken.getText() };
  }
  if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === skipOuterNode(node, p))) return { kind: 'return' };
  return undefined;
}

/** `child` is a value the expression `p` can evaluate to: a branch of `?:`, an operand of `??` / `||`. */
function passesValue(p: ts.Node, child: ts.Node): boolean {
  if (ts.isConditionalExpression(p)) return child === p.whenTrue || child === p.whenFalse;
  return ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || p.operatorToken.kind === ts.SyntaxKind.BarBarToken);
}

/** The node itself or the parenthesized/asserted wrapper that is the direct child of `parent`. */
function skipOuterNode(node: ts.Node, parent: ts.Node): ts.Node {
  let n = node;
  while (n.parent && n.parent !== parent) n = n.parent;
  return n;
}

/** `this.cache` → cache, `{ a,\n b }` → {a, b}. */
function compactTarget(text: string): string {
  return text
    .replace(/^this\./, '')
    .replace(/\s+/g, ' ')
    .replace(/([{[(])\s+/g, '$1')
    .replace(/(?<!\s)\s+([}\])])/g, '$1');
}

/** FR-9.5: declared return type of the call (awaited when awaited); undefined for void / unknown. */
export function callReturnType(model: TsModel, call: ts.CallExpression): string | undefined {
  // (undefined only for a node that is not from a parsed file)
  const sig = model.checker.getResolvedSignature(call)!;
  let type = model.checker.getReturnTypeOfSignature(sig);
  if (ts.isAwaitExpression(outerParent(call))) type = model.checker.getAwaitedType(type) ?? type;
  if (type.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
  const text = model.checker.typeToString(type, call, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  return text === 'Promise<void>' ? undefined : text;
}

/** Static type of the receiver; the created class for `new`; the enclosing class for this/super. */
export function receiverType(model: TsModel, call: CallLike, origin: ReceiverOrigin, target?: MethodRef): ClassRef | undefined {
  if (ts.isNewExpression(call)) {
    const t = model.checker.getTypeAtLocation(call);
    return model.classRefFromType(t) ?? target?.owner;
  }
  const callee = skipOuter(call.expression);
  if (origin.kind === 'self' || origin.kind === 'super') {
    const cls = enclosingClass(call);
    return cls ? model.classRef(cls) : target?.owner;
  }
  if (origin.kind === 'module') return target?.owner;
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return model.classRefFromType(model.checker.getTypeAtLocation(callee.expression)) ?? target?.owner;
  }
  return target?.owner;
}

function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isClassLike(n)) return n;
  return undefined;
}

/** Awaited, or returns a thenable (FR-1.9). */
export function isAsyncCall(model: TsModel, call: CallLike): boolean {
  let p: ts.Node = call.parent;
  while (ts.isParenthesizedExpression(p)) p = p.parent;
  if (ts.isAwaitExpression(p)) return true;
  if (ts.isNewExpression(call)) return false;
  try {
    const sig = model.checker.getResolvedSignature(call)!;
    const ret = model.checker.getReturnTypeOfSignature(sig);
    if (ret.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
    return !!model.checker.getNonNullableType(ret).getProperty('then');
    /* v8 ignore start -- TypeScript's checker throws on some broken code; no known input throws here, an unknown one must not fail the whole request */
  } catch {
    return false;
  }
  /* v8 ignore stop */
}
