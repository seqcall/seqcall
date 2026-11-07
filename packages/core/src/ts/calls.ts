import ts from 'typescript';
import type { MethodRef } from '@seqcall/protocol';
import type { ArgumentFunction, ArgumentType, CallSite, FragmentScope, ReceiverOrigin } from '../adapter';
import { fragmentScopes, jsxHandlerScope, lambdaScope } from './fragments';
import { type CallableNode, type TsModel, instancePropertyInitializers, skipOuter } from './model';
import { tagComponent } from './react-entry-points';
import {
  type CallLike,
  type ResolvedTarget,
  argumentFunction,
  argumentOrigin,
  assignmentTarget,
  callResult,
  callReturnType,
  invokedParameter,
  invokedParameterType,
  compact,
  expressionText,
  invokedName,
  isAsyncCall,
  objectOrigin,
  receiverOrigin,
  receiverType,
  resolveTarget,
} from './resolve';

/** Nodes evaluated when the callable runs, in order: parameter defaults, field initialisers (ctor), body. */
function evaluatedRoots(model: TsModel, node: CallableNode): ts.Node[] {
  if (ts.isClassLike(node)) return instancePropertyInitializers(node);
  const roots: ts.Node[] = [];
  const fn = model.functionOf(node) as ts.FunctionLikeDeclaration | undefined;
  if (!fn) return roots;
  for (const p of fn.parameters) if (p.initializer) roots.push(p.initializer);
  if (ts.isConstructorDeclaration(node)) roots.push(...instancePropertyInitializers(node.parent));
  if (fn.body) roots.push(fn.body);
  return roots;
}

type Lambda = ts.ArrowFunction | ts.FunctionExpression;

/** A collected call with the scopes of the lambdas it is inside of (FR-1.11), outermost first. */
interface CallCollected {
  call: CallLike;
  resolved: ResolvedTarget;
  prefix: FragmentScope[];
}

/** FR-1.18 a read of a project getter / an assignment to a project setter: it runs that accessor. */
interface AccessCollected {
  access: ts.PropertyAccessExpression;
  accessor: 'get' | 'set';
  target: MethodRef;
  prefix: FragmentScope[];
}

/** FR-1.20 a JSX element of a project component (`<ShopTab widgets={w} />`): the component renders. */
interface RenderCollected {
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement;
  component: CallableNode;
  target: MethodRef;
  prefix: FragmentScope[];
}

type Collected = CallCollected | AccessCollected | RenderCollected;

/**
 * FR-1.18 `this.events` (read) / `b.rating = 5` (assigned) when that property is a getter / setter of the project:
 * the accessor it runs. Not a method being called (`x.m()`), not a field, not a library accessor.
 */
function accessorOf(model: TsModel, n: ts.PropertyAccessExpression): { accessor: 'get' | 'set'; target: MethodRef } | undefined {
  const p = n.parent;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) return undefined;
  const assigned = ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  if (ts.isDeleteExpression(p) || ts.isTypeOfExpression(p)) return undefined;
  const symbol = model.checker.getSymbolAtLocation(n.name);
  const want = assigned ? ts.SyntaxKind.SetAccessor : ts.SyntaxKind.GetAccessor;
  const decl = symbol?.declarations?.find((d) => d.kind === want) as ts.AccessorDeclaration | undefined;
  if (!decl || !decl.body || model.isLibraryFile(decl.getSourceFile())) return undefined;
  const target = model.methodRef(decl);
  return target ? { accessor: assigned ? 'set' : 'get', target } : undefined;
}

const isLambda = (n: ts.Node): n is Lambda => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/**
 * Calls in evaluation order: post-order (receivers & arguments before the call). Nested functions
 * are not entered — except lambdas passed to a library (or unresolvable) function such as
 * `map` / `then`: their calls follow the receiving call, inside a `loop` / `callback` scope
 * (FR-1.11). A lambda passed to a project function is drawn where that function invokes it. A handler given to a
 * JSX prop (`onClick={() => …}`, or a local `const onJoin = () => …` passed as `onClick={onJoin}`) is drawn there,
 * in a `callback [Button onClick: on click]` scope. A JSX element of a project component is a render of it (FR-1.20),
 * before the calls in its props and children.
 */
function collect(model: TsModel, roots: ts.Node[]): Collected[] {
  const out: Collected[] = [];
  let prefix: FragmentScope[] = [];
  const drawnHandlers = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    // FR-1.20 an element of a project component: it renders before what its props and children run
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const component = tagComponent(model, n.tagName);
      const target = component && model.methodRef(component);
      if (component && target) out.push({ element: n, component, target, prefix });
    }
    ts.forEachChild(n, visit);
    if (ts.isJsxAttribute(n)) {
      const handler = jsxHandler(model, n, roots);
      if (handler && !drawnHandlers.has(handler)) {
        drawnHandlers.add(handler);
        const outer = prefix;
        prefix = [...outer, ...(fragmentScopes(n) ?? []), jsxHandlerScope(n, handler)];
        visit(handler.body!);
        prefix = outer;
      }
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      const a = accessorOf(model, n);
      if (a) out.push({ access: n, ...a, prefix });
      return;
    }
    if ((ts.isCallExpression(n) && n.expression.kind !== ts.SyntaxKind.ImportKeyword) || ts.isNewExpression(n)) {
      const resolved = resolveTarget(model, n, invokedName(n));
      out.push({ call: n, resolved, prefix });
      if (resolved.target && !resolved.isLibrary) return;
      const inline = (lambda: Lambda, property?: string) => {
        const outer = prefix;
        prefix = [...outer, ...(fragmentScopes(n) ?? []), lambdaScope(n, lambda, property)];
        visit(lambda.body);
        prefix = outer;
      };
      for (const arg of n.arguments ?? []) {
        const value = ts.isParenthesizedExpression(arg) ? arg.expression : arg;
        if (isLambda(value)) inline(value);
        // FR-1.11: options objects with callbacks — `route({ handler: async (req) => … })`
        else if (ts.isObjectLiteralExpression(value)) {
          for (const p of value.properties) {
            if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue;
            const init = ts.isParenthesizedExpression(p.initializer) ? p.initializer.expression : p.initializer;
            if (isLambda(init)) inline(init, p.name.text);
          }
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return out;
}

/**
 * The function a JSX prop runs: written in place (`onClick={() => …}`), or a function local to the method being
 * drawn (`const onJoin = async () => …` / `function onJoin() {…}` → `onClick={onJoin}`). A `useCallback(() => …)`
 * is drawn at `useCallback` already; module-level functions and methods are keyed and not inlined.
 */
function jsxHandler(model: TsModel, attr: ts.JsxAttribute, roots: ts.Node[]): Lambda | ts.FunctionDeclaration | undefined {
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined;
  const value = skipOuter(init.expression);
  // (an arrow function / function expression always has a body)
  if (isLambda(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  // an overloaded local function: its implementation
  const sym = model.checker.getSymbolAtLocation(value);
  const decl = sym?.declarations?.find((d) => ts.isFunctionDeclaration(d) && d.body) ?? sym?.valueDeclaration;
  if (!decl || !roots.some((r) => r.pos <= decl.pos && decl.end <= r.end)) return undefined;
  if (ts.isFunctionDeclaration(decl)) return decl.body ? decl : undefined;
  const fn = ts.isVariableDeclaration(decl) && decl.initializer ? skipOuter(decl.initializer) : undefined;
  return fn && isLambda(fn) && fn.body ? fn : undefined;
}

export function outgoingCalls(model: TsModel, node: CallableNode): CallSite[] {
  return callSites(model, collect(model, evaluatedRoots(model, node)), node.getSourceFile(), node);
}

/** FR-31.1 the calls of a file's module-level code (outside functions and classes): they run when the module loads. */
export function moduleCalls(model: TsModel, sf: ts.SourceFile): CallSite[] {
  return callSites(model, collect(model, [...sf.statements]), sf);
}

/**
 * FR-5.10 where a creation's arguments come from: `fixed` when they use no parameter of the functions the line is in
 * (`owner` or a lambda in it) and no `this`; `constructorParams` when the only parameters are `owner`'s, a constructor.
 */
function argsFrom(model: TsModel, call: ts.NewExpression, owner: CallableNode | undefined): CallSite['argsFrom'] {
  let params = false;
  let other = false;
  const visit = (n: ts.Node): void => {
    if (other) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) other = true;
    else if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
      const d = model.checker.getSymbolAtLocation(n)?.valueDeclaration;
      if (d && (ts.isParameter(d) || (ts.isBindingElement(d) && ts.isParameter(ts.walkUpBindingElementsAndPatterns(d))))) {
        if (owner && ts.isConstructorDeclaration(owner) && ts.isParameter(d) && d.parent === owner) params = true;
        else other = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const a of call.arguments ?? []) visit(a);
  return other ? undefined : params ? 'constructorParams' : 'fixed';
}

/** `new X().m()`: the message goes to the object the call site `ordinal` creates (not to a second X). */
function createdReceiver(call: CallLike, createOrdinal: (n: ts.NewExpression) => number | undefined): ReceiverOrigin | undefined {
  if (ts.isNewExpression(call)) return undefined;
  const callee = skipOuter(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const obj = skipOuter(callee.expression);
  const ordinal = ts.isNewExpression(obj) ? createOrdinal(obj) : undefined;
  return ordinal === undefined ? undefined : { kind: 'created', ordinal };
}

function callSites(model: TsModel, calls: Collected[], sf: ts.SourceFile, owner?: CallableNode): CallSite[] {
  const ordinals = new Map<ts.Node, number>(calls.map((c, i) => ['call' in c ? c.call : 'access' in c ? c.access : c.element, i]));
  const createOrdinal = (n: ts.NewExpression): number | undefined => ordinals.get(n);
  return calls.map((c, ordinal): CallSite => {
    if ('access' in c) return accessorSite(model, c, ordinal, sf);
    if ('element' in c) return renderSite(c, ordinal, model, sf);
    const { call, prefix } = c;
    // FR-1.19 a String / Number method on a value typed any (`path.toLowerCase()` in JS): the built-in, as when typed
    const resolved = c.resolved.target ? c.resolved : builtinOnUntyped(model, call) ?? c.resolved;
    const methodName = invokedName(call);
    const receiver = createdReceiver(call, createOrdinal) ?? receiverOrigin(model, call);
    const args = call.arguments ?? [];
    const argOrigins = args.map((a) => argumentOrigin(model, a, createOrdinal));
    // FR-1.11: a lambda passed to a project function carries its body, drawn where it is invoked
    const argFunctions = args.map((a) => {
      const fn = argumentFunction(model, a, sf);
      return fn?.kind === 'lambda' && resolved.target && !resolved.isLibrary ? lambdaBody(model, a, fn) : fn;
    });
    // FR-1.19 what is passed for a parameter the target declares `any`; why an unresolved call stays unknown
    const argTypes = resolved.target && !resolved.isLibrary ? args.map((a, i) => untypedParameterArgument(model, call, a, i)) : [];
    const untyped = resolved.target ? undefined : untypedReceiverText(model, call, sf);
    const viaParam = invokedParameter(model, call);
    const viaParamType = viaParam ? invokedParameterType(model, call) : undefined;
    const assignedTo = ts.isNewExpression(call) ? assignmentTarget(call) : undefined;
    const result = callResult(call);
    const returnType = ts.isCallExpression(call) ? callReturnType(model, call) : undefined;
    const fragments = [...prefix, ...(fragmentScopes(call) ?? [])];
    const from = ts.isNewExpression(call) && resolved.target && !resolved.isLibrary ? argsFrom(model, call, owner) : undefined;
    return {
      ordinal,
      kind: ts.isNewExpression(call) ? 'create' : 'call',
      ...(from ? { argsFrom: from } : {}),
      range: model.range(call, sf),
      methodName,
      expressionText: compact(call.getText(sf)),
      args: args.map((a) => expressionText(a, sf)),
      ...(argOrigins.some(Boolean) ? { argOrigins } : {}),
      ...(argFunctions.some(Boolean) ? { argFunctions } : {}),
      ...(argTypes.some(Boolean) ? { argTypes } : {}),
      ...(untyped ? { untypedReceiver: untyped } : {}),
      ...(viaParam ? { invokedParameter: viaParam } : {}),
      ...(viaParamType ? { invokedParameterType: viaParamType } : {}),
      ...(assignedTo ? { assignedTo } : {}),
      ...(result ? { result } : {}),
      ...(returnType ? { returnType } : {}),
      receiver,
      receiverType: receiverType(model, call, receiver, resolved.target),
      target: resolved.target,
      isAsync: isAsyncCall(model, call),
      isLibrary: resolved.isLibrary,
      libraryName: resolved.libraryName,
      ...(fragments.length ? { fragments } : {}),
    };
  });
}

/**
 * FR-1.19 names only String / Number have — not ones project objects use as well (`get`, `find`, `map`, `replace`,
 * `match`, `includes`, `slice`, `toString`): those stay unknown on a value typed any.
 */
const BUILTIN_ON_ANY = new Map<string, string>([
  ...['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd',
    'padStart', 'padEnd', 'charAt', 'charCodeAt', 'codePointAt', 'substring', 'substr', 'split', 'replaceAll', 'localeCompare'].map((n) => [n, 'String'] as const),
  ...['toFixed', 'toPrecision', 'toExponential'].map((n) => [n, 'Number'] as const),
]);

/** FR-1.19 `x.toLowerCase()` with `x` typed any: the String method, a library call like on a typed string. */
function builtinOnUntyped(model: TsModel, call: CallLike): ResolvedTarget | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = skipOuter(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const owner = BUILTIN_ON_ANY.get(callee.name.text);
  if (!owner || !isUntyped(model.checker.getTypeAtLocation(skipOuter(callee.expression)))) return undefined;
  const lib = { key: 'lib:lib', name: 'lib', kind: 'external' as const };
  return { isLibrary: true, libraryName: 'lib', target: { key: `lib:lib#${owner}.${callee.name.text}`, name: callee.name.text, owner: lib, isStatic: false, hasBody: false } };
}

const isUntyped = (t: ts.Type) => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

/**
 * FR-1.19 the argument's type when the called project function declares that parameter `any` / `unknown`
 * (`#zodResponse(zodSchema: any, …)` called with `createOrderResponseZod`, a `ZodObject`): the callee's calls on
 * the parameter can then be resolved through the flow. Undefined when the parameter is typed or the argument is too.
 */
function untypedParameterArgument(model: TsModel, call: CallLike, arg: ts.Expression, i: number): ArgumentType | undefined {
  if (ts.isSpreadElement(arg)) return undefined;
  const sig = model.checker.getResolvedSignature(call);
  const param = sig?.parameters[i];
  const decl = param?.valueDeclaration;
  if (!param || !decl || !ts.isParameter(decl) || decl.dotDotDotToken) return undefined;
  if (!isUntyped(model.checker.getTypeOfSymbolAtLocation(param, decl))) return undefined;
  const typeDecl = model.typeDeclFromType(model.checker.getTypeAtLocation(arg));
  if (!typeDecl) return undefined;
  const isLibrary = model.isLibraryFile(typeDecl.getSourceFile());
  return { type: model.classRef(typeDecl), isLibrary, ...(isLibrary ? { libraryName: model.libraryNameOf(typeDecl) } : {}) };
}

/** FR-1.19 `x.m()` on a value typed `any` / `unknown`: `x` (what made the call unresolvable). */
function untypedReceiverText(model: TsModel, call: CallLike, sf: ts.SourceFile): string | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = skipOuter(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const obj = skipOuter(callee.expression);
  return isUntyped(model.checker.getTypeAtLocation(obj)) ? compact(obj.getText(sf)) : undefined;
}

/** FR-1.18 the accessor a property read / assignment runs, as a call of it (`«get» events`). */
function accessorSite(model: TsModel, c: AccessCollected, ordinal: number, sf: ts.SourceFile): CallSite {
  const n = c.access;
  const receiver = objectOrigin(model, skipOuter(n.expression));
  const result = c.accessor === 'get' ? callResult(n as unknown as ts.CallExpression) : undefined;
  const fragments = [...c.prefix, ...(fragmentScopes(n) ?? [])];
  return {
    ordinal,
    kind: 'call',
    range: model.range(n, sf),
    methodName: n.name.text,
    expressionText: compact(n.getText(sf)),
    args: [],
    accessor: c.accessor,
    ...(result ? { result } : {}),
    receiver,
    receiverType: c.target.owner,
    target: c.target,
    isAsync: false,
    isLibrary: false,
    ...(fragments.length ? { fragments } : {}),
  };
}

/**
 * FR-1.20 `<ShopTab widgetIds={ids} {...rest} />` as a call named by its tag: the component's function (a class
 * component's `render`, on one «static» lifeline per class), the props by name as its arguments.
 */
function renderSite(c: RenderCollected, ordinal: number, model: TsModel, sf: ts.SourceFile): CallSite {
  const n = c.element;
  const isClass = ts.isMethodDeclaration(c.component);
  const tag = n.tagName.getText(sf);
  const args = n.attributes.properties.map((p) => (ts.isJsxAttribute(p) ? p.name.getText(sf) : `...${compact(p.expression.getText(sf))}`));
  const fragments = [...c.prefix, ...(fragmentScopes(n) ?? [])];
  return {
    ordinal,
    kind: 'call',
    range: model.range(n, sf),
    methodName: tag.split('.').pop()!, // as written: `ProductTab`, not the `_ProductTab` that `observer(_ProductTab)` wraps
    expressionText: compact(n.getText(sf)),
    args,
    render: true,
    receiver: isClass ? { kind: 'static' } : { kind: 'module', name: tag },
    receiverType: c.target.owner,
    target: c.target,
    isAsync: false,
    isLibrary: false,
    ...(fragments.length ? { fragments } : {}),
  };
}

function lambdaBody(model: TsModel, arg: ts.Expression, fn: ArgumentFunction): ArgumentFunction {
  const lambda = (ts.isParenthesizedExpression(arg) ? arg.expression : arg) as Lambda;
  const sf = lambda.getSourceFile();
  const roots: ts.Node[] = [];
  for (const p of lambda.parameters) if (p.initializer) roots.push(p.initializer);
  roots.push(lambda.body);
  const params = lambda.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  return { ...fn, params, calls: callSites(model, collect(model, roots), sf) } as ArgumentFunction;
}
