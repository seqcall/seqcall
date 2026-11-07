import type { CallResult, ClassRef, MethodRef } from '@seqcall/protocol';
import type { ArgumentFunction, ArgumentOrigin, CallSite, FragmentScope, ReceiverOrigin } from '../adapter';
import { children, isNestedFunction, nameOf, rangeOf, textOf, type PNode } from './ast';
import { accessorFor, servesAttribute, studly } from './accessors';
import { fragmentScopes } from './fragments';
import type { Callable, PhpModel } from './model';
import { docOf, docTag, type ClassDecl } from './project';
import { returnedExpressions, type PhpContext } from './types';
import { cutFrom } from '../text';

/** What a call node invokes, as far as the declarations tell. */
export interface ResolvedCall {
  kind: 'call' | 'create';
  methodName: string;
  target?: MethodRef;
  isLibrary: boolean;
  libraryName?: string;
  receiver: ReceiverOrigin;
  receiverType?: ClassRef;
  returnType?: string;
  invokedParameter?: string;
  /** FR-1.11 `guard(…, function () {…})($x)`: calls the closure a project call returned. */
  invokesResult?: true;
  /** FR-18.15 not written as a call: an Eloquent attribute read / written (`$order->loyalty_points`) runs its accessor / mutator. */
  accessor?: 'get' | 'set';
}

const lower = (s: string) => s.toLowerCase();
const isLambda = (n: PNode | undefined): n is PNode => !!n && (n.kind === 'closure' || n.kind === 'arrowfunc');
/** `$this->m(...)`: a first-class callable — creates a Closure, does not call. */
const isFirstClassCallable = (n: PNode) => n.kind === 'call' && n.arguments?.length === 1 && n.arguments[0].kind === 'variadicplaceholder';
const isCallNode = (n: PNode) => (n.kind === 'call' && !isFirstClassCallable(n)) || (n.kind === 'new' && n.what?.kind !== 'class');

const isLookup = (n: PNode | undefined) => (n?.kind === 'propertylookup' || n?.kind === 'nullsafepropertylookup') && n.offset?.kind === 'identifier';
/** `$x->name = …`: an assignment to the property (not `+=`, which reads it first). */
const isWrite = (n: PNode) => n.parent?.kind === 'assign' && n.parent.left === n && n.parent.operator === '=';

/**
 * FR-18.15 `$order->loyalty_points` (read) / `$order->loyalty_points = …` (assigned) on a class with an Eloquent accessor
 * / mutator for that attribute: Laravel runs that method (`__get` → `getAttribute` → `getLoyaltyPointsAttribute()`).
 */
function accessorCall(model: PhpModel, n: PNode, ctx: PhpContext, params: Set<string>): ResolvedCall | undefined {
  if (!isLookup(n) || (n.parent?.kind === 'call' && n.parent.what === n)) return undefined;
  const prop = nameOf(n.offset);
  // most properties are no attribute any accessor serves: no type lookup for them
  if (!servesAttribute(model, prop)) return undefined;
  const owner = model.types.typeOf(n.what, ctx);
  const cls = owner ? model.project.classByFqn(owner) : undefined;
  const write = isWrite(n);
  const found = cls && accessorFor(model, cls.fqn, prop, write);
  if (!found) return undefined;
  return { kind: 'call', methodName: prop, target: model.methodRef(found.owner, found.node!), isLibrary: false, receiver: receiverOrigin(n.what, params, ctx.file.src), receiverType: model.classRef(cls), accessor: write ? 'set' : 'get' };
}

/** Array functions / collection methods whose callback runs once per element (FR-1.11). */
const ITERATION = new Set(
  'array_map array_filter array_walk array_reduce usort uasort uksort array_find array_any array_all each map filter reject reduce flatMap mapWithKeys mapToGroups sum sortBy sortByDesc first last contains every partition groupBy keyBy transform search where some doesntContain unique sole firstWhere avg max min'.split(' '),
);

/** Parameters of the analysed callable (not of closures inside it). */
function paramNames(c: Callable): Set<string> {
  return new Set(c.node.arguments.map((p: PNode) => nameOf(p)));
}

/**
 * The library class a project class inherits the method `name` (or a property) from (`extends Model`): the library base or trait that declares it
 * (read from `vendor/`), else the first library base class, else the first library trait — a trait of a nearer
 * ancestor (`use HasFactory`) does not hide the base class further up that declares the method (`Model::is`).
 */
function libraryBase(model: PhpModel, fqn: string, name?: string): string | undefined {
  const bases: string[] = [];
  const traits: string[] = [];
  for (const c of model.project.ancestors(fqn)) {
    for (const p of c.extends) if (!model.project.classByFqn(p)) bases.push(p);
    for (const p of c.traits) if (!model.project.classByFqn(p)) traits.push(p);
  }
  // a property (no method name): the base class
  for (const b of name ? [...bases, ...traits] : []) {
    const found = model.project.libraryMethod(b, name!);
    if (found) return found.owner.fqn;
  }
  return bases[0] ?? traits[0];
}

export function receiverOrigin(e: PNode, params: Set<string>, src: string): ReceiverOrigin {
  if (e.kind === 'variable') {
    if (e.name === 'this') return { kind: 'self' };
    if (typeof e.name === 'string') return params.has(e.name) ? { kind: 'parameter', name: e.name } : { kind: 'local', name: e.name };
  }
  if ((e.kind === 'propertylookup' || e.kind === 'nullsafepropertylookup') && e.what?.kind === 'variable' && e.what.name === 'this' && e.offset?.kind === 'identifier') {
    return { kind: 'field', name: nameOf(e.offset) };
  }
  if (e.kind === 'parentreference' || (e.kind === 'name' && /^parent$/i.test(nameOf(e)))) return { kind: 'super' };
  if (e.kind === 'selfreference' || e.kind === 'staticreference' || e.kind === 'name') return { kind: 'static' };
  return { kind: 'expression', text: textOf(src, e) };
}

/** Return type text as declared (`?CreateRefundResponseDTO`), or the `@return` text; void → undefined. */
function returnTypeText(owner: ClassDecl | undefined, node: PNode, src: string): string | undefined {
  // php-parser keeps the `?` of `?Foo` as a flag on the function, outside the type node
  const declared = node.type ? `${node.nullable ? '?' : ''}${textOf(owner?.file.src ?? src, node.type)}` : docTag(docOf(node), 'return');
  return declared && !/^(void|never)$/i.test(declared) ? declared : undefined;
}

/** The library class a receiver expression comes from: a library call or a chain on one. */
function libraryOrigin(model: PhpModel, e: PNode | undefined, ctx: PhpContext, params: Set<string>, depth = 0): string | undefined {
  if (!e || depth > 8) return undefined;
  if (e.kind === 'call' || e.kind === 'new') {
    const r = resolveCall(model, e, ctx, params);
    // (every library call resolveCall gives has a `lib:` target)
    if (r.isLibrary) return cutFrom(r.target!.owner.key.slice(4), '#');
    // a project method without a return type that returns a library value (`return cache()->getRedis()…;`)
    if (e.kind === 'call' && r.target) {
      const found = model.types.calledMethod(e, ctx);
      if (found && found !== 'helper' && found.node && !found.node.type && !docTag(docOf(found.node), 'return')) {
        const callee: PhpContext = { file: found.owner.file, scope: found.owner.scope, cls: found.owner, callable: found.node };
        const calleeParams = new Set<string>(found.node.arguments.map((p: PNode) => nameOf(p)));
        for (const ret of returnedExpressions(found.node)) {
          const lib = libraryOrigin(model, ret, callee, calleeParams, depth + 1);
          if (lib) return lib;
        }
      }
      return undefined;
    }
    return e.kind === 'call' && !r.target && e.what?.what ? libraryOrigin(model, e.what.what, ctx, params, depth + 1) : undefined;
  }
  if (e.kind === 'variable' && typeof e.name === 'string' && e.name !== 'this') {
    // assigned from a library value (`$d = now(); $d->copy()`)
    const assigned = model.types.lastAssignment(e, e.name);
    if (assigned) return libraryOrigin(model, assigned, ctx, params, depth + 1);
    // an untyped parameter of a closure handed to a library call (`$router->group(fn ($router) => …)`)
    const closure = model.types.closureOfParam(e, e.name);
    const receiving = closure?.parent?.kind === 'namedargument' ? closure.parent.parent : closure?.parent;
    if (closure && receiving && (receiving.kind === 'call' || receiving.kind === 'new')) {
      const param = closure.arguments.find((p: PNode) => nameOf(p) === e.name);
      if (!param.type) {
        const r = resolveCall(model, receiving, ctx, params);
        if (r.isLibrary) return cutFrom(r.target!.owner.key.slice(4), '#');
      }
    }
    return undefined;
  }
  if (e.kind === 'propertylookup' || e.kind === 'nullsafepropertylookup') {
    const owner = model.types.typeOf(e.what, ctx);
    if (owner && !model.project.classByFqn(owner)) return owner;
    // a property the project does not declare, inherited from a library base (`$this->app` in a ServiceProvider)
    if (owner && !model.project.ancestors(owner).some((c) => c.properties.has(nameOf(e.offset)) || c.docProperties.has(nameOf(e.offset)))) return libraryBase(model, owner);
    return owner ? undefined : libraryOrigin(model, e.what, ctx, params, depth + 1);
  }
  return undefined;
}

/**
 * the calls that start a mock expectation (Mockery, PHPUnit): on a receiver whose type is unknown or does not
 * declare them, they are the mocking library's — and so is the chain after them (`->once()->andReturn(…)`, a library value).
 */
const MOCK_CALLS = /^(shouldReceive|shouldNotReceive|shouldHaveReceived|shouldNotHaveReceived|shouldIgnoreMissing|allows|expects|makePartial)$/;
const MOCK = 'Mockery\\MockInterface';
const mockCall = (model: PhpModel, name: string, receiver: ResolvedCall['receiver'], receiverType?: ResolvedCall['receiverType']): ResolvedCall | undefined =>
  MOCK_CALLS.test(name) ? { kind: 'call', methodName: name, target: model.libraryMethodRef(MOCK, name, false), isLibrary: true, libraryName: model.libraryName(MOCK), receiver, ...(receiverType ? { receiverType } : {}) } : undefined;

export function resolveCall(model: PhpModel, n: PNode, ctx: PhpContext, params: Set<string>): ResolvedCall {
  const src = ctx.file.src;
  const types = model.types;
  if (n.kind === 'new') {
    const fqn = types.classRefName(n.what, ctx);
    if (!fqn) return { kind: 'create', methodName: 'constructor', isLibrary: false, receiver: { kind: 'none' } };
    const cls = model.project.classByFqn(fqn);
    if (!cls) {
      return { kind: 'create', methodName: 'constructor', isLibrary: true, libraryName: model.libraryName(fqn), target: model.libraryMethodRef(fqn, 'constructor', false), receiver: { kind: 'none' }, receiverType: model.libraryClassRef(fqn) };
    }
    const ctor = types.findMethod(fqn, '__construct');
    // no constructor in the project (none declared, or inherited from a library base such as an Eloquent
    // model): the class's implicit constructor — the creation still needs a target to place it
    const target = ctor?.node && ctor.owner.kind !== 'interface' ? model.methodRef(ctor.owner, ctor.node) : model.implicitConstructorRef(cls);
    return {
      kind: 'create',
      methodName: 'constructor',
      target,
      isLibrary: false,
      receiver: { kind: 'none' },
      receiverType: model.classRef(cls),
    };
  }
  const what = n.what;
  if (what?.kind === 'propertylookup' || what?.kind === 'nullsafepropertylookup' || what?.kind === 'staticlookup') {
    const raw = what.offset?.kind === 'identifier' ? nameOf(what.offset) : textOf(src, what.offset);
    // `parent::__construct()`: the constructor, named like everywhere else
    const name = /^__construct$/i.test(raw) ? 'constructor' : raw;
    const isStatic = what.kind === 'staticlookup';
    const receiver = receiverOrigin(what.what, params, src);
    const owner = isStatic ? types.classRefName(what.what, ctx) : types.typeOf(what.what, ctx);
    if (!owner || what.offset?.kind !== 'identifier') {
      // a call on the result of a library call (`$money->getCurrency()->getCode()`): library too
      const lib = !isStatic ? libraryOrigin(model, what.what, ctx, params) : undefined;
      if (lib && what.offset?.kind === 'identifier') {
        return { kind: 'call', methodName: name, target: model.libraryMethodRef(lib, name, false), isLibrary: true, libraryName: model.libraryName(lib), receiver };
      }
      return mockCall(model, name, receiver) ?? { kind: 'call', methodName: name, isLibrary: false, receiver };
    }
    const cls = model.project.classByFqn(owner);
    if (!cls) {
      return { kind: 'call', methodName: name, target: model.libraryMethodRef(owner, name, isStatic), isLibrary: true, libraryName: model.libraryName(owner), receiver, receiverType: model.libraryClassRef(owner) };
    }
    const found = types.findMethod(owner, name === 'constructor' ? '__construct' : name);
    // PHP's built-in enum methods: `Status::cases()`, `Status::from($v)`, `Status::tryFrom($v)`
    if (!found && cls.kind === 'enum' && /^(cases|from|tryFrom)$/i.test(name)) {
      return { kind: 'call', methodName: name, target: model.libraryMethodRef('BackedEnum', name, true), isLibrary: true, libraryName: 'php', receiver, receiverType: model.classRef(cls) };
    }
    if (found?.node) {
      return {
        kind: 'call',
        methodName: name,
        target: model.methodRef(found.owner, found.node),
        isLibrary: false,
        receiver,
        receiverType: model.classRef(cls),
        ...(returnTypeText(found.owner, found.node, src) ? { returnType: returnTypeText(found.owner, found.node, src) } : {}),
      };
    }
    const base = libraryBase(model, owner, raw);
    if (base && !found) {
      return { kind: 'call', methodName: name, target: model.libraryMethodRef(base, name, isStatic), isLibrary: true, libraryName: model.libraryName(base), receiver, receiverType: model.classRef(cls) };
    }
    // a mock of a project class (`$this->repo = Mockery::mock(Repo::class)` typed Repo): its expectations
    return (!found && mockCall(model, name, receiver, model.classRef(cls))) || { kind: 'call', methodName: name, isLibrary: false, receiver, receiverType: model.classRef(cls), ...(found?.docReturn ? { returnType: found.docReturn } : {}) };
  }
  if (what?.kind === 'name') {
    const raw = nameOf(what);
    const fqn = model.project.resolveFunctionName(raw, ctx.scope);
    const fn = model.project.functionByFqn(fqn);
    if (fn) {
      const rt = returnTypeText(undefined, fn.node, fn.file.src);
      return { kind: 'call', methodName: fn.name, target: model.functionRef(fn), isLibrary: false, receiver: { kind: 'module', name: fn.name }, ...(rt ? { returnType: rt } : {}) };
    }
    return { kind: 'call', methodName: raw.replace(/^.*\\/, ''), target: model.libraryFunctionRef(fqn), isLibrary: true, libraryName: model.libraryName(fqn), receiver: { kind: 'module', name: raw } };
  }
  if (what?.kind === 'variable' && typeof what.name === 'string') {
    // `$callback($x)`: invoking a callable parameter (FR-1.13)
    return { kind: 'call', methodName: `$${what.name}`, isLibrary: false, receiver: { kind: 'none' }, ...(params.has(what.name) ? { invokedParameter: what.name } : {}) };
  }
  if (what?.kind === 'call' && what.what && !isFirstClassCallable(what)) {
    // `$this->guard('…', function () {…})($x)`: calls what the inner call returned — named without the closure's body
    const inner = resolveCall(model, what, ctx, params);
    const name = chainText(what, src).replace(/^\$this->/, '');
    if (inner.target && !inner.isLibrary) return { kind: 'call', methodName: name, isLibrary: false, receiver: { kind: 'none' }, invokesResult: true };
    return { kind: 'call', methodName: name, isLibrary: false, receiver: { kind: 'expression', text: chainText(what, src) } };
  }
  return { kind: 'call', methodName: textOf(src, what), isLibrary: false, receiver: { kind: 'expression', text: textOf(src, what) } };
}

/** A collected call with the scopes of the closures it is inside of (FR-1.11), outermost first. */
interface Collected {
  node: PNode;
  resolved: ResolvedCall;
  prefix: FragmentScope[];
}

/** Text of a call chain with argument lists collapsed: `collect(…)->map`. */
function chainText(e: PNode | undefined, src: string): string {
  if (!e) return ''; // half-typed code: a call without a callee
  if (e.kind === 'call') return `${chainText(e.what, src)}(${e.arguments?.length ? '…' : ''})`;
  if (e.kind === 'propertylookup' || e.kind === 'nullsafepropertylookup') return `${chainText(e.what, src)}->${textOf(src, e.offset)}`;
  if (e.kind === 'staticlookup') return `${textOf(src, e.what)}::${textOf(src, e.offset)}`;
  return textOf(src, e);
}

/** FR-1.11 the scope of the calls inside a closure passed to a library function: `loop` for iteration, else `callback`. */
function lambdaScope(call: PNode, lambda: PNode, src: string, file: string): FragmentScope {
  const start = lambda.loc!.start.offset;
  const range = rangeOf(file, lambda);
  range.end = { line: range.start.line, character: range.start.character + 8 };
  const what = call.what;
  const method = what?.kind === 'name' ? nameOf(what).replace(/^.*\\/, '') : nameOf(what?.offset);
  const param = lambda.arguments?.[0] ? `$${nameOf(lambda.arguments[0])}` : undefined;
  if (method && ITERATION.has(method)) {
    let collection: string;
    if (what?.kind === 'name') {
      const other = call.arguments.find((a: PNode) => a !== lambda && !isLambda(a));
      collection = other ? textOf(src, other) : '…';
    } else collection = chainText(what.what, src);
    return { id: `cb@${start}`, kind: 'loop', operand: 0, guard: param ? `each ${param} of ${collection}` : `each of ${collection}`, range };
  }
  return { id: `cb@${start}`, kind: 'callback', operand: 0, guard: chainText(what, src), range };
}

/**
 * Calls in evaluation order (receivers and arguments before the call). Closures are not entered,
 * except closures passed to a library or unresolved call (`array_map`, `->each`, `transaction`):
 * their calls follow that call inside a `loop` / `callback` scope (FR-1.11).
 */
function collect(model: PhpModel, roots: readonly PNode[], ctx: PhpContext, params: Set<string>): Collected[] {
  const out: Collected[] = [];
  let prefix: FragmentScope[] = [];
  const visit = (n: PNode): void => {
    if (isNestedFunction(n)) return;
    for (const c of children(n)) visit(c);
    // FR-18.15 an attribute's accessor runs where it is read; its mutator after the assigned value is computed
    const access = isLookup(n) && !isWrite(n) ? n : n.kind === 'assign' && isLookup(n.left) && isWrite(n.left) ? n.left : undefined;
    const accessor = access && accessorCall(model, access, ctx, params);
    if (accessor) out.push({ node: access, resolved: accessor, prefix });
    if (!isCallNode(n)) return;
    const resolved = resolveCall(model, n, ctx, params);
    out.push({ node: n, resolved, prefix });
    if (resolved.target && !resolved.isLibrary) return;
    // the returned closure runs the closures handed to the project call that made it (`guard(…, function () {…})($x)`)
    const handed = resolved.invokesResult ? n.what.arguments : [];
    for (const arg of [...n.arguments, ...handed]) {
      const lambda = arg.kind === 'namedargument' ? arg.value : arg;
      if (!isLambda(lambda)) continue;
      const outer = prefix;
      const scope = lambdaScope(n, lambda, ctx.file.src, ctx.file.abs);
      prefix = [...outer, ...(fragmentScopes(n, ctx.file) ?? []), resolved.invokesResult ? { ...scope, guard: `${resolved.methodName}(…)` } : scope];
      for (const c of lambda.kind === 'arrowfunc' ? [lambda.body] : children(lambda.body ?? { kind: 'block' })) if (c) visit(c);
      prefix = outer;
    }
  };
  for (const root of roots) visit(root);
  return out;
}

export function outgoingCalls(model: PhpModel, c: Callable): CallSite[] {
  if (!c.node.body) return [];
  const ctx = model.context(c);
  const params = paramNames(c);
  return callSites(model, collect(model, children(c.node.body), ctx, params), ctx, params);
}

function callResult(call: PNode, src: string): CallResult | undefined {
  let n = call;
  let p = n.parent;
  // the value passes through `$c ? f() : g()` / `$a ?: f()` (not the condition) and `$a ?? f()` (parentheses are no nodes)
  // (PHP's `||` gives a bool, not the operand)
  while (p && ((p.kind === 'retif' && (p.trueExpr === n || p.falseExpr === n)) || (p.kind === 'bin' && p.type === '??'))) {
    n = p;
    p = n.parent;
  }
  if (p?.kind === 'assign' && p.right === n) return { kind: 'assign', target: textOf(src, p.left).replace(/^\$this->/, ''), operator: p.operator };
  if (p?.kind === 'return') return { kind: 'return' };
  if (p?.kind === 'arrowfunc' && p.body === n) return { kind: 'return' };
  return undefined;
}

function argumentOrigin(a: PNode, params: Set<string>, createOrdinal: (n: PNode) => number | undefined): ArgumentOrigin | undefined {
  const e = a.kind === 'namedargument' ? a.value : a;
  if (!e) return undefined;
  if (e.kind === 'variable' && typeof e.name === 'string') {
    if (e.name === 'this') return { kind: 'self' };
    return params.has(e.name) ? { kind: 'parameter', name: e.name } : { kind: 'local', name: e.name };
  }
  if (e.kind === 'propertylookup' && e.what?.kind === 'variable' && e.what.name === 'this' && e.offset?.kind === 'identifier') return { kind: 'field', name: nameOf(e.offset) };
  if (e.kind === 'new') {
    const ordinal = createOrdinal(e);
    return ordinal === undefined ? undefined : { kind: 'created', ordinal };
  }
  return undefined;
}

/** `(new X())->m()`: the message goes to the object the call site `ordinal` creates (not to a second X). */
function createdReceiver(node: PNode, ordinals: Map<PNode, number>): ReceiverOrigin | undefined {
  const what = node.kind === 'call' ? node.what : undefined;
  if (what?.kind !== 'propertylookup' && what?.kind !== 'nullsafepropertylookup') return undefined;
  // (`(new X())` is the new node itself: php-parser marks parentheses with `parenthesizedExpression`, no node)
  const obj: PNode = what.what;
  const ordinal = obj.kind === 'new' ? ordinals.get(obj) : undefined;
  return ordinal === undefined ? undefined : { kind: 'created', ordinal };
}

function callSites(model: PhpModel, calls: Collected[], ctx: PhpContext, params: Set<string>): CallSite[] {
  const src = ctx.file.src;
  const ordinals = new Map<PNode, number>(calls.map((c, i) => [c.node, i]));
  return calls.map(({ node, resolved, prefix }, ordinal): CallSite => {
    // (an accessor has no argument list)
    const args: PNode[] = node.arguments ?? [];
    const argOrigins = args.map((a) => argumentOrigin(a, params, (x) => ordinals.get(x)));
    const argFunctions = args.map((a) => argumentFunction(model, a, ctx, params, resolved));
    const result = callResult(node, src);
    const assign = node.kind === 'new' && node.parent?.kind === 'assign' && node.parent.right === node ? node.parent.left : undefined;
    const assignedTo =
      assign?.kind === 'variable' && typeof assign.name === 'string'
        ? { kind: 'local' as const, name: assign.name }
        : assign?.kind === 'propertylookup' && assign.what?.kind === 'variable' && assign.what.name === 'this'
          ? { kind: 'field' as const, name: nameOf(assign.offset) }
          : undefined;
    const fragments = [...prefix, ...(fragmentScopes(node, ctx.file) ?? [])];
    return {
      ordinal,
      kind: resolved.kind,
      range: rangeOf(ctx.file.abs, node),
      methodName: resolved.methodName,
      // `guard('…', function () {…})($x)`: without the closure's body
      expressionText: node.what?.kind === 'call' && node.what.what ? chainText(node, src) : textOf(src, node),
      args: args.map((a) => textOf(src, a)),
      ...(argOrigins.some(Boolean) ? { argOrigins } : {}),
      ...(argFunctions.some(Boolean) ? { argFunctions } : {}),
      ...(resolved.invokedParameter ? { invokedParameter: resolved.invokedParameter } : {}),
      ...(resolved.invokesResult ? { invokesResult: true as const } : {}),
      ...(resolved.accessor ? { accessor: resolved.accessor } : {}),
      ...(assignedTo ? { assignedTo } : {}),
      ...(result ? { result } : {}),
      ...(resolved.returnType ? { returnType: resolved.returnType } : {}),
      receiver: createdReceiver(node, ordinals) ?? resolved.receiver,
      ...(resolved.receiverType ? { receiverType: resolved.receiverType } : {}),
      ...(resolved.target ? { target: resolved.target } : {}),
      isAsync: false,
      isLibrary: resolved.isLibrary,
      ...(resolved.libraryName ? { libraryName: resolved.libraryName } : {}),
      ...(fragments.length ? { fragments } : {}),
    };
  });
}

/**
 * FR-1.13 functions passed as arguments: closures / arrow functions (with their calls when the
 * receiving function is project code, drawn where it invokes them) and first-class callables
 * `$this->format(...)`, `Mapper::toDto(...)`.
 */
function argumentFunction(model: PhpModel, a: PNode, ctx: PhpContext, params: Set<string>, receiving: ResolvedCall): ArgumentFunction | undefined {
  const e = a.kind === 'namedargument' ? a.value : a;
  if (!e) return undefined;
  if (isLambda(e)) {
    const lambdaParams = e.arguments.map((p: PNode) => nameOf(p));
    const project = receiving.target && !receiving.isLibrary;
    if (!project) return { kind: 'lambda', range: rangeOf(ctx.file.abs, e) };
    const roots = e.kind === 'arrowfunc' ? [e.body] : children(e.body ?? { kind: 'block' });
    const inner = new Set([...params, ...lambdaParams]);
    return { kind: 'lambda', range: rangeOf(ctx.file.abs, e), params: lambdaParams, calls: callSites(model, collect(model, roots, ctx, inner), ctx, inner) };
  }
  if (e.kind === 'call' && isFirstClassCallable(e)) {
    const r = resolveCall(model, { ...e, arguments: [] }, ctx, params);
    if (!r.target) return undefined;
    return { kind: 'method', target: r.target, receiver: r.receiver, ...(r.receiverType ? { receiverType: r.receiverType } : {}), isLibrary: r.isLibrary, ...(r.libraryName ? { libraryName: r.libraryName } : {}) };
  }
  return undefined;
}

/**
 * FR-18.15 reads / assignments of an Eloquent attribute (studly form, `LoyaltyPoints`) in a callable's body including its
 * closures that run an accessor / mutator (for callers): node + resolution.
 */
export function attributeAccessesIn(model: PhpModel, c: Callable, attribute: string, thisCls?: ClassDecl): { node: PNode; resolved: ResolvedCall; passed: boolean }[] {
  if (!c.node.body) return [];
  const ctx = model.context(c, thisCls);
  const params = paramNames(c);
  const out: { node: PNode; resolved: ResolvedCall; passed: boolean }[] = [];
  const visit = (n: PNode) => {
    if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'function') return;
    for (const ch of children(n)) visit(ch);
    if (!isLookup(n) || studly(nameOf(n.offset)) !== attribute) return;
    const resolved = accessorCall(model, n, ctx, params);
    if (resolved) out.push({ node: n, resolved, passed: false });
  };
  for (const ch of children(c.node.body)) visit(ch);
  return out;
}

/** Calls of a callable's body including inside its closures (for callers): node + resolution. */
export function allCallsIn(model: PhpModel, c: Callable, nameFilter: string, thisCls?: ClassDecl): { node: PNode; resolved: ResolvedCall; passed: boolean }[] {
  if (!c.node.body) return [];
  const want = lower(nameFilter);
  const named = callNodesOf(c.node).filter((x) => x.name === want);
  if (!named.length) return [];
  const ctx = model.context(c, thisCls);
  const params = paramNames(c);
  return named.map(({ node: n, passed }) => ({ node: n, resolved: resolveCall(model, passed ? { ...n, arguments: [] } : n, ctx, params), passed }));
}

/**
 * The calls (and first-class callables) of a body with their lower-case names (`new` → `constructor`, as
 * `parent::__construct()`), in the order `allCallsIn` resolves them; once per declaration — a callers search asks
 * every body of the project, and the unreachable-code search (FR-31) runs thousands of them. Nested functions /
 * classes are not part of the body.
 */
const callNodes = new WeakMap<PNode, { name: string; node: PNode; passed: boolean }[]>();
function callNodesOf(decl: PNode): { name: string; node: PNode; passed: boolean }[] {
  let list = callNodes.get(decl);
  if (list) return list;
  const out: { name: string; node: PNode; passed: boolean }[] = [];
  const visit = (n: PNode) => {
    if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'function') return;
    for (const ch of children(n)) visit(ch);
    const passed = isFirstClassCallable(n);
    if (!isCallNode(n) && !passed) return;
    const name = lower(n.kind === 'new' ? 'constructor' : n.what?.kind === 'name' ? nameOf(n.what).replace(/^.*\\/, '') : nameOf(n.what?.offset));
    out.push({ name: name === '__construct' ? 'constructor' : name, node: n, passed });
  };
  for (const ch of children(decl.body)) visit(ch);
  callNodes.set(decl, (list = out));
  return list;
}
