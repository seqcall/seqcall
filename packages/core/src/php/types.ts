import { children, isNestedFunction, nameOf, walk, type PNode } from './ast';
import { docOf, docTag, templateNames, type ClassDecl, type NameScope, type PhpFile, type PhpProject } from './project';
import { cutFrom, genericArgument } from '../text';

/**
 * FR-18 type resolution, behind an interface so that the engine can be swapped later (e.g. a
 * PHPStan sidecar for untyped code) without touching call extraction: the rest of the adapter
 * only asks "which class does this expression evaluate to?" and "which method does this call?".
 */
export interface PhpTypeResolver {
  /** Fully qualified class name of the value of `expr` (project or library class), or undefined. */
  typeOf(expr: PNode, ctx: PhpContext): string | undefined;
}

/** Where an expression is: its file, the class (if any) and the function whose body contains it. */
export interface PhpContext {
  file: PhpFile;
  scope: NameScope;
  cls?: ClassDecl;
  /**
   * What `$this` is in a trait's method: the class using the trait (its methods and properties; a trait may call
   * methods only the using class declares). Default: `cls`.
   */
  thisCls?: ClassDecl;
  /** The method / function being analysed (outermost callable). */
  callable: PNode;
}

/** A method found on a class or its ancestors (or a doc `@method`). */
export interface FoundMethod {
  owner: ClassDecl;
  node?: PNode;
  /** `@method` return type text when the method is only documented (magic `__call`). */
  docReturn?: string;
}

const lower = (s: string) => s.toLowerCase();

/** PHP's built-in (non-class) type names. */
const SCALARS = new Set(
  'int integer float double string bool boolean array iterable callable object mixed void null never false true resource numeric scalar array-key class-string list non-empty-string non-empty-array positive-int negative-int'.split(' '),
);

const MANY_RELATIONS = new Set(['hasMany', 'belongsToMany', 'morphMany', 'morphToMany', 'morphedByMany', 'hasManyThrough']);
const RELATIONS = new Set([...MANY_RELATIONS, 'belongsTo', 'hasOne', 'morphOne', 'hasOneThrough']);

/** Well-known Laravel helpers whose result type is fixed (no `vendor/` needed). */
const HELPER_TYPES: Record<string, string> = {
  collect: 'Illuminate\\Support\\Collection',
  now: 'Illuminate\\Support\\Carbon',
  today: 'Illuminate\\Support\\Carbon',
  request: 'Illuminate\\Http\\Request',
  response: 'Illuminate\\Http\\Response',
  cache: 'Illuminate\\Cache\\CacheManager',
  logger: 'Illuminate\\Log\\LogManager',
  http: 'Illuminate\\Http\\Client\\Factory',
};

/** Statements that may run or not, or run one of several branches (a `try` body runs: only its `catch` is a branch). */
const BRANCHES = new Set(['if', 'switch', 'case', 'retif', 'match', 'matcharm', 'for', 'foreach', 'while', 'do', 'catch']);

/** Whether `n` sits in a branch that the code at offset `at` is not in (so it may not have run before it). */
function inBranch(n: PNode, at: number): boolean {
  for (let p = n.parent; p && !(p.loc!.start.offset <= at && at <= p.loc!.end.offset); p = p.parent) if (BRANCHES.has(p.kind)) return true;
  return false;
}

/** The expressions a function body returns (`return <expr>;`, not inside nested functions). */
export function returnedExpressions(fn: PNode): PNode[] {
  const out: PNode[] = [];
  if (fn.body) {
    walk(fn.body, (n) => {
      if (isNestedFunction(n)) return false;
      if (n.kind === 'return' && n.expr) out.push(n.expr);
    });
  }
  return out;
}

export class DeclarationTypeResolver implements PhpTypeResolver {
  constructor(private readonly project: PhpProject) {}

  /**
   * Variable types already worked out, per use and `$this` class (a trait's method runs on several), while the files
   * stay as they are: an untyped value is often the result of other methods' untyped returns, each a body walk.
   */
  private varTypes = new WeakMap<PNode, Map<string, string | undefined>>();
  private varTypesRevision = -1;

  typeOf(expr: PNode, ctx: PhpContext): string | undefined {
    return this.type(expr, ctx, 0);
  }

  private type(e: PNode | undefined, ctx: PhpContext, depth: number): string | undefined {
    if (!e || depth > 12) return undefined;
    switch (e.kind) {
      case 'variable':
        if (e.name === 'this') return (ctx.thisCls ?? ctx.cls)?.fqn;
        return typeof e.name === 'string' ? this.cachedVariableType(e, e.name, ctx, depth) : undefined;
      case 'new':
        return this.classRefName(e.what, ctx); // (an anonymous class `new class {…}` names none)
      case 'propertylookup':
      case 'nullsafepropertylookup': {
        const owner = this.type(e.what, ctx, depth + 1);
        return owner ? this.propertyType(owner, nameOf(e.offset), depth) : undefined;
      }
      case 'staticlookup': {
        // a static property (`X::$p`); `X::class` and constants (`X::C`) are no objects
        const owner = this.classRefName(e.what, ctx);
        return owner && e.offset?.kind === 'variable' ? this.propertyType(owner, nameOf(e.offset), depth) : undefined;
      }
      case 'call': {
        const made = this.containerMade(e, ctx, depth);
        if (made) return made;
        const found = this.calledMethod(e, ctx, depth);
        if (found === 'helper') return this.helperType(e, ctx);
        if (!found) return this.enumCase(e, ctx) ?? this.libraryCallType(e, ctx, depth);
        const receiver = e.what?.kind === 'staticlookup' ? this.classRefName(e.what.what, ctx) : this.type(e.what?.what, ctx, depth + 1);
        return this.returnType(found, receiver, depth);
      }
      case 'clone':
        return this.type(e.what, ctx, depth + 1);
      case 'retif':
        return this.type(e.trueExpr ?? e.test, ctx, depth + 1) ?? this.type(e.falseExpr, ctx, depth + 1);
      case 'bin':
        return e.type === '??' ? this.type(e.left, ctx, depth + 1) ?? this.type(e.right, ctx, depth + 1) : undefined;
      case 'assign':
        return this.type(e.right, ctx, depth + 1);
      // (php-parser 3 has no parenthesis node: `($a)` is `$a` with `parenthesizedExpression`)
      default:
        return undefined;
    }
  }

  /** A backed enum's built-in `Status::from($v)` / `tryFrom($v)`: one of its cases. */
  private enumCase(call: PNode, ctx: PhpContext): string | undefined {
    const what = call.what;
    if (what?.kind !== 'staticlookup' || !/^(try)?from$/i.test(nameOf(what.offset))) return undefined;
    const owner = this.classRefName(what.what, ctx);
    return owner && this.project.classByFqn(owner)?.kind === 'enum' ? owner : undefined;
  }

  /** `self` / `static` / `parent` / a class name node → fully qualified name. */
  classRefName(what: PNode | undefined, ctx: PhpContext): string | undefined {
    if (!what) return undefined; // `new ` being typed: no class yet
    if (what.kind === 'selfreference' || what.kind === 'staticreference') return ctx.cls?.fqn;
    if (what.kind === 'parentreference') return ctx.cls?.extends[0];
    // (`self` / `parent` are never name nodes: php-parser makes them selfreference / parentreference)
    if (what.kind === 'name') return this.project.resolveClassName(nameOf(what), ctx.scope);
    return undefined;
  }

  /**
   * FR-18.10: the type of a call the project does not declare, from the library's declarations
   * (`$items->map(…)` on a Collection → `@return static` → Collection; `$user->newQuery()` → Builder).
   */
  private libraryCallType(call: PNode, ctx: PhpContext, depth: number): string | undefined {
    const what = call.what;
    if (what?.offset?.kind !== 'identifier') return undefined;
    // (only the lookups ->, ?->, :: have an identifier offset)
    const receiver = what.kind === 'staticlookup' ? this.classRefName(what.what, ctx) : this.type(what.what, ctx, depth + 1);
    if (!receiver) return undefined;
    const found = this.project.libraryMethod(receiver, nameOf(what.offset));
    if (!found) return undefined;
    const { owner, node } = found;
    if (!node) return this.typeNodeName(found.docReturn, owner.scope, owner, receiver);
    const templates = templateNames(docOf(node));
    return this.typeNodeName(node.type ?? undefined, owner.scope, owner, receiver, templates) ?? this.typeNodeName(docTag(docOf(node), 'return'), owner.scope, owner, receiver, templates);
  }

  /** A type node (or doc type text) → the first class type in it; `@template` names are not classes. */
  typeNodeName(t: PNode | string | undefined, scope: NameScope, self?: ClassDecl, receiver?: string, templates?: Set<string>): string | undefined {
    if (!t) return undefined;
    if (typeof t === 'string') return this.docTypeName(t, scope, self, receiver, templates);
    // php-parser's type nodes (read_type / read_types): name, typereference, selfreference, parentreference,
    // uniontype, intersectiontype; `?Foo` is a flag on the declaration, not a node
    if (t.kind === 'name') return this.docTypeName(nameOf(t), scope, self, receiver, templates);
    if (t.kind === 'typereference' && !/^(self|static|\$this)$/i.test(nameOf(t))) return undefined; // int, array, mixed…
    // `: static`, a declared `: self`
    if (t.kind === 'typereference' || t.kind === 'selfreference') return receiver ?? self?.fqn;
    if (t.kind === 'parentreference') return self?.extends[0];
    // union / intersection (DNF types nest them): the first class in it; a union of several classes, the base they share
    const names: string[] = [];
    for (const part of t.types) {
      const n = this.typeNodeName(part, scope, self, receiver, templates);
      if (n) names.push(n);
    }
    return t.kind === 'uniontype' ? this.oneOf(names) : names[0];
  }

  /** One of several classes a union names (`Card|Cash`): the base they share, else the first. */
  private oneOf(names: string[]): string | undefined {
    const distinct = names.filter((n, i) => names.findIndex((m) => lower(m) === lower(n)) === i);
    return distinct.length > 1 ? (this.commonBase(distinct) ?? distinct[0]) : distinct[0];
  }

  /** `?Foo|null`, `Collection<int, Foo>`, `Foo[]`, `static`, `$this` → a class name. */
  private docTypeName(text: string, scope: NameScope, self?: ClassDecl, receiver?: string, templates?: Set<string>): string | undefined {
    const names: (string | undefined)[] = [];
    for (let part of text.split(/[|&]/)) {
      part = cutFrom(part.trim().replace(/^\?/, ''), '<').replace(/\[\]$/, '').replace(/^\(|\)$/g, '');
      if (!part || SCALARS.has(lower(part)) || self?.templates?.has(part) || templates?.has(part)) continue;
      if (/^(self|static|\$this)$/i.test(part)) names.push(receiver ?? self?.fqn);
      else if (/^[\\A-Za-z_][\\\w]*$/.test(part)) names.push(this.project.resolveClassName(part, scope));
    }
    // `@return bool|Card|Cash`: the base they share; with an intersection (`Foo&Countable`), the first
    return text.includes('&') ? names[0] : this.oneOf(names.filter((n): n is string => !!n));
  }

  /**
   * Declared (or documented) type of a property, through the class's ancestors; an untyped one
   * (`private $api;`) takes the type of what the class assigns to it (`$this->api = $client;`).
   */
  propertyType(classFqn: string, prop: string, depth = 0): string | undefined {
    for (const c of this.project.ancestors(classFqn)) {
      const p = c.properties.get(prop);
      if (p) return this.typeNodeName(p.type, c.scope, c) ?? this.typeNodeName(p.docType, c.scope, c) ?? this.assignedPropertyType(c, prop, depth);
      const doc = c.docProperties.get(prop);
      if (doc) return this.typeNodeName(doc, c.scope, c);
    }
    return this.relationType(classFqn, prop);
  }

  /** `$this->prop = <expr>` in the class's methods, constructor first: the first assignment whose type is known. */
  private assignedPropertyType(c: ClassDecl, prop: string, depth: number): string | undefined {
    if (depth > 6) return undefined;
    const ctor = c.methods.get('__construct');
    for (const m of [ctor, ...[...c.methods.values()].filter((x) => x !== ctor)]) {
      if (!m?.body) continue;
      let found: string | undefined;
      walk(m.body, (n) => {
        if (found !== undefined || isNestedFunction(n)) return false;
        if (n.kind !== 'assign' || n.operator !== '=' || n.left?.kind !== 'propertylookup' || n.left.what?.name !== 'this' || nameOf(n.left.offset) !== prop) return;
        found = this.type(n.right, { file: c.file, scope: c.scope, cls: c, callable: m }, depth + 2);
      });
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Eloquent relation properties: `$order->user` reads the relation method `user()`. A to-one relation
   * (`belongsTo`, `hasOne`, `morphOne`, `hasOneThrough`) gives the related model, a to-many one a Collection.
   */
  private relationType(classFqn: string, prop: string): string | undefined {
    const found = this.findMethod(classFqn, prop);
    if (!found?.node?.body) return undefined;
    let related: string | undefined;
    walk(found.node.body, (n) => {
      if (related !== undefined || isNestedFunction(n)) return false;
      if (n.kind !== 'call' || n.what?.kind !== 'propertylookup' || n.what.what?.name !== 'this') return;
      const rel = nameOf(n.what.offset);
      const arg = n.arguments?.[0];
      if (!RELATIONS.has(rel) || arg?.kind !== 'staticlookup' || nameOf(arg.offset) !== 'class') return;
      related = MANY_RELATIONS.has(rel) ? 'Illuminate\\Database\\Eloquent\\Collection' : this.classRefName(arg.what, { file: found.owner.file, scope: found.owner.scope, cls: found.owner, callable: found.node! });
    });
    return related;
  }

  /**
   * The nearest class or interface every one of `types` is (the first type's parents before its interfaces), or
   * undefined when they share none in the project. Traits do not count: a call through one names no contract.
   */
  commonBase(types: string[]): string | undefined {
    return this.project
      .ancestors(types[0])
      .find((c) => c.kind !== 'trait' && types.every((t) => this.project.isSubtype(t, c.fqn)))?.fqn;
  }

  /** The method `name` of a class: declared on it or an ancestor, else documented with `@method`. */
  findMethod(classFqn: string, name: string): FoundMethod | undefined {
    const all = this.project.ancestors(classFqn);
    // concrete declarations first (a class before the interfaces it implements; a trait's body before another trait's
    // `abstract` declaration of the same method)
    for (const c of all) {
      const node = c.methods.get(lower(name));
      if (node && c.kind !== 'interface' && !node.isAbstract) return { owner: c, node };
    }
    for (const c of all) {
      const node = c.methods.get(lower(name));
      if (node) return { owner: c, node };
    }
    for (const c of all) {
      const doc = c.docMethods.get(lower(name));
      if (doc) return { owner: c, docReturn: doc };
    }
    const own = all[0];
    return own && (own.isAbstract || own.kind === 'interface') ? this.sharedBySubclasses(own, name) : undefined;
  }

  /**
   * An abstract class or interface without the method: the declaration all its concrete subclasses share (an
   * interface they implement besides it) — `Base|Interface` reached as their common base `Base`. Once per class and
   * name while the files stay as they are.
   */
  private sharedBySubclasses(base: ClassDecl, name: string): FoundMethod | undefined {
    if (this.sharedRevision !== this.project.revision) {
      this.shared.clear();
      this.sharedRevision = this.project.revision;
    }
    const key = `${lower(base.fqn)}#${lower(name)}`;
    if (!this.shared.has(key)) {
      const subs = this.project.subtypesOf(base.fqn).filter((c) => c.kind === 'class' && !c.isAbstract);
      const owner = subs.length
        ? this.project.ancestors(subs[0].fqn).find((c) => c.methods.has(lower(name)) && subs.every((s) => this.project.isSubtype(s.fqn, c.fqn)))
        : undefined;
      this.shared.set(key, owner && { owner, node: owner.methods.get(lower(name)) });
    }
    return this.shared.get(key);
  }

  private readonly shared = new Map<string, FoundMethod | undefined>();
  private sharedRevision = -1;

  /** The method a call invokes (project code only); 'helper' for a known global helper. */
  calledMethod(call: PNode, ctx: PhpContext, depth = 0): FoundMethod | 'helper' | undefined {
    const what = call.what;
    if (!what) return undefined; // half-typed code: php-parser makes calls without a callee
    if (what.kind === 'propertylookup' || what.kind === 'nullsafepropertylookup') {
      if (what.offset?.kind !== 'identifier') return undefined;
      const owner = this.type(what.what, ctx, depth + 1);
      return owner ? this.findMethod(owner, nameOf(what.offset)) : undefined;
    }
    if (what.kind === 'staticlookup') {
      if (what.offset?.kind !== 'identifier') return undefined;
      const owner = this.classRefName(what.what, ctx);
      return owner ? this.findMethod(owner, nameOf(what.offset)) : undefined;
    }
    if (what.kind === 'name') {
      const n = nameOf(what);
      if (HELPER_TYPES[lower(n)] || /^(app|resolve)$/i.test(n)) return 'helper';
    }
    return undefined;
  }

  /**
   * an object the container builds by class: `app()->make(Foo::class)`, `$this->app->make(…)`, `$app->makeWith(…)`,
   * `App::make(…)`, or `->make(…)` on a Container / Application — Foo. (A string id, `make('orders')`, says no class.)
   */
  private containerMade(call: PNode, ctx: PhpContext, depth: number): string | undefined {
    const what = call.what;
    if (what?.offset?.kind !== 'identifier' || !/^make(with)?$/i.test(nameOf(what.offset))) return undefined;
    const arg = call.arguments?.[0];
    if (arg?.kind !== 'staticlookup' || nameOf(arg.offset) !== 'class') return undefined;
    const r = what.what;
    const container =
      what.kind === 'staticlookup'
        ? /(^|\\)App$/.test(this.classRefName(r, ctx) ?? '')
        : (r?.kind === 'call' && lower(nameOf(r.what)) === 'app' && !r.arguments?.length) ||
          (r?.kind === 'propertylookup' && nameOf(r.offset) === 'app') ||
          (r?.kind === 'variable' && /^(app|container)$/i.test(String(r.name))) ||
          /\\(Container|Application)$/.test(this.type(r, ctx, depth + 1) ?? '');
    return container ? this.classRefName(arg.what, ctx) : undefined;
  }

  /** Result of `collect()`, `app(Foo::class)`, `resolve(Foo::class)`. */
  private helperType(call: PNode, ctx: PhpContext): string | undefined {
    const n = lower(nameOf(call.what));
    if (n === 'app' || n === 'resolve') {
      const arg = call.arguments?.[0];
      if (arg?.kind === 'staticlookup' && nameOf(arg.offset) === 'class') return this.classRefName(arg.what, ctx);
      return undefined;
    }
    return HELPER_TYPES[n];
  }

  /**
   * Declared return type (or `@return`) of a found method; `static`/`self`/`$this` → the receiver.
   * Without either, the type of what it returns (`return new Foo(…)`, `return $this->repo;`).
   */
  returnType(found: FoundMethod, receiver: string | undefined, depth = 0): string | undefined {
    const { owner, node } = found;
    if (!node) return this.typeNodeName(found.docReturn, owner.scope, owner, receiver);
    if (node.type || docTag(docOf(node), 'return')) {
      return this.typeNodeName(node.type, owner.scope, owner, receiver) ?? this.typeNodeName(docTag(docOf(node), 'return'), owner.scope, owner, receiver);
    }
    if (depth > 6) return undefined;
    const ctx: PhpContext = { file: owner.file, scope: owner.scope, cls: owner, callable: node };
    const types: string[] = [];
    for (const r of returnedExpressions(node)) {
      const t = this.type(r, ctx, depth + 2);
      if (t && !types.some((x) => lower(x) === lower(t))) types.push(t);
    }
    // different classes from different returns: what they share, else the first
    return types.length > 1 ? (this.commonBase(types) ?? types[0]) : types[0];
  }

  /** The expression last assigned to `$name` before `use` in the same function (`$d = now();`), if any. */
  lastAssignment(use: PNode, name: string): PNode | undefined {
    // (a use is always inside the analysed method / function, so there is one; nodes always have positions)
    let fn = use.parent!;
    while (!(fn.kind === 'closure' || fn.kind === 'arrowfunc' || fn.kind === 'method' || fn.kind === 'function')) fn = fn.parent!;
    const at = use.loc!.start.offset;
    let best: PNode | undefined;
    const visit = (n: PNode) => {
      if (n !== fn && isNestedFunction(n)) return;
      if (n.loc!.start.offset >= at) return;
      if (n.kind === 'assign' && n.operator === '=' && n.left?.kind === 'variable' && n.left.name === name && n.loc!.end.offset <= at) best = n.right;
      for (const c of children(n)) visit(c);
    };
    for (const c of children(fn)) visit(c);
    // captured from the enclosing function: `function () use ($d) { … }` / arrow functions capture implicitly
    const captured = (fn.kind === 'closure' && fn.uses.some((u: PNode) => nameOf(u) === name)) || fn.kind === 'arrowfunc';
    if (!best && captured && !fn.arguments.some((p: PNode) => nameOf(p) === name)) {
      return this.lastAssignment({ kind: 'variable', name, parent: fn.parent, loc: fn.loc }, name);
    }
    return best;
  }

  /** The closure / arrow function whose untyped parameter `$name` is, when `use` is inside it. */
  closureOfParam(use: PNode, name: string): PNode | undefined {
    for (let fn = use.parent; fn; fn = fn.parent) {
      if (fn.kind === 'method' || fn.kind === 'function') return undefined;
      if ((fn.kind === 'closure' || fn.kind === 'arrowfunc') && fn.arguments.some((p: PNode) => nameOf(p) === name)) return fn;
    }
    return undefined;
  }

  private cachedVariableType(use: PNode, name: string, ctx: PhpContext, depth: number): string | undefined {
    if (this.varTypesRevision !== this.project.revision) {
      this.varTypes = new WeakMap();
      this.varTypesRevision = this.project.revision;
    }
    const thisKey = (ctx.thisCls ?? ctx.cls)?.fqn ?? '';
    const known = this.varTypes.get(use);
    if (known?.has(thisKey)) return known.get(thisKey);
    const t = this.variableType(use, name, ctx, depth);
    // (deep in a chain the depth limit may have cut the answer short: kept only when worked out from the top)
    if (depth <= 1 && this.varTypesRevision === this.project.revision) {
      if (known) known.set(thisKey, t);
      else this.varTypes.set(use, new Map([[thisKey, t]]));
    }
    return t;
  }

  /** A variable: the type of its last assignment before the use, an `@var` hint, or its parameter type. */
  private variableType(use: PNode, name: string, ctx: PhpContext, depth: number): string | undefined {
    // the innermost function around the use (closures have their own parameters)
    // (a use is always inside ctx.callable — a method, a function or a route file's program — so there is one)
    let fn = use.parent!;
    while (!(fn === ctx.callable || fn.kind === 'closure' || fn.kind === 'arrowfunc' || fn.kind === 'method' || fn.kind === 'function')) fn = fn.parent!;
    // a parameter keeps its declared type until it is assigned a typed value (`$hints = $this->collect(...$hints)`)
    const param = (fn.arguments ?? []).find((p: PNode) => nameOf(p) === name);
    const paramType = param ? (this.typeNodeName(param.type, ctx.scope, ctx.cls) ?? this.typeNodeName(docTag(docOf(fn), 'param', name), ctx.scope, ctx.cls)) : undefined;
    const at = use.loc!.start.offset;
    let best: { offset: number; type?: string } | undefined;
    // the last assignment whose type is known: `if (…) $x = <typed>; else $x = <untyped>;` keeps the type
    let known: { offset: number; type?: string } | undefined;
    // the classes the variable may hold at the use: an assignment on every path to it replaces them, one in a branch
    // the use is not in adds to them (`switch ($kind) { case 'card': $p = new Card(); break; case 'cash': $p = new Cash(); … }`)
    // (an assignment in a branch adds to the parameter's type, one on every path replaces it)
    let may: string[] = paramType ? [paramType] : [];
    const visit = (n: PNode) => {
      if (n !== fn && isNestedFunction(n)) return;
      if (n.loc!.start.offset >= at) return;
      // (the walk is in source order: a later node never starts before an earlier one)
      if (n.kind === 'assign' && n.operator === '=' && n.left?.kind === 'variable' && n.left.name === name && n.loc!.end.offset <= at) {
        const t = this.type(n.right, ctx, depth + 1);
        const o = n.loc!.start.offset;
        // (an `@var` hint on this assignment's statement starts at the same offset and wins)
        if (!best || o > best.offset) best = { offset: o, type: t };
        if (t) {
          known = { offset: o, type: t };
          may = inBranch(n, at) ? [...may, t] : [t];
        }
      }
      const doc = docOf(n);
      // an inline `/** @var Type $x */` before any statement (an assignment, a foreach, an if, …)
      if (doc) {
        const hinted = docTag(doc, 'var', name);
        if (hinted) best = { offset: n.loc!.start.offset, type: this.typeNodeName(hinted, ctx.scope, ctx.cls) };
      }
      // `catch (ApiStatusException $e)`: the first caught type
      // (a catch always names at least one type)
      if (n.kind === 'catch' && n.variable?.kind === 'variable' && n.variable.name === name && n.loc!.start.offset < at && n.loc!.end.offset >= at) {
        best = { offset: n.loc!.start.offset, type: this.typeNodeName(n.what[0], ctx.scope, ctx.cls) };
      }
      if (n.kind === 'foreach' && n.value?.kind === 'variable' && n.value.name === name && n.loc!.start.offset < at) {
        // `foreach ($items as $item)` with `@param Item[] $items` / `@var Item[]`
        const src = n.source?.kind === 'variable' ? n.source.name : undefined;
        const doc = src ? docTag(docOf(fn!), 'param', src) : undefined;
        // (a doc type with an unclosed `<` never reaches here: docTag reads it to the end and finds no variable after it)
        if (doc && (doc.includes('[]') || doc.includes('<'))) {
          const inner = doc.includes('<') ? genericArgument(doc) : doc.replace(/\[\]/g, '');
          best = { offset: n.loc!.start.offset, type: this.typeNodeName(inner, ctx.scope, ctx.cls) };
        }
      }
      for (const c of children(n)) visit(c);
    };
    for (const c of children(fn)) visit(c);
    // several classes from branches: what they share (an interface, an abstract base), so a call reaches each one's
    if (best && best.offset === known?.offset && new Set(may.map(lower)).size > 1) return this.commonBase(may) ?? known.type;
    const assigned = best && (best.type ?? known?.type);
    if (assigned || paramType) return assigned ?? paramType;
    if (best) return undefined;
    // closure `use ($x)`: the variable comes from the enclosing function
    if ((fn.kind === 'closure' && fn.uses.some((u: PNode) => nameOf(u) === name)) || fn.kind === 'arrowfunc') {
      return this.variableType({ ...use, parent: fn.parent, loc: fn.loc }, name, ctx, depth + 1);
    }
    return undefined;
  }
}
