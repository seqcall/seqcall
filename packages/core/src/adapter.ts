import type { CallerInfo, CallResult, ClassRef, EntryPoint, MemberVisibility, MethodRef, Position, ProcessMemory, SourceRange } from '@seqcall/protocol';

/**
 * Language-specific analysis. One implementation per language (TsAdapter in-process, the C#
 * Roslyn sidecar via RpcLanguageAdapter, PhpAdapter in-process). Everything above this interface is
 * language-agnostic. All results describe ONE level only (lazy analysis). Every method is
 * asynchronous so that out-of-process adapters fit; in-process adapters simply resolve.
 */
export interface LanguageAdapter {
  readonly projectRoot: string;

  /** The innermost method/function whose body contains the position (FR-1.1, FR-1.2). */
  findEnclosingCallable(file: string, position: Position): Promise<MethodRef | undefined>;

  /** Re-resolve a method by its stable key (used after refresh / for history). */
  getMethod(key: string): Promise<MethodRef | undefined>;

  /** Direct call sites in the method body, in evaluation order (FR-1.4). */
  getOutgoingCalls(method: MethodRef): Promise<CallSite[]>;

  /**
   * Concrete methods implementing/overriding an interface or abstract method (FR-8).
   * Returns [] for concrete methods with no overrides.
   */
  getImplementations(method: MethodRef): Promise<MethodRef[]>;

  /** All call sites in the project that call the method (FR-4.1). */
  getCallers(method: MethodRef): Promise<CallerInfo[]>;

  /** Structural info used for stereotypes, layers and the class diagram. */
  getClassInfo(classKey: string): Promise<ClassInfo | undefined>;

  /**
   * Parameter names of a method, in order ('' for destructured parameters). Used to bind the
   * callee's parameters to the caller's argument participants (FR-6.5). Optional.
   */
  getParameterNames?(method: MethodRef): Promise<string[]>;

  /**
   * FR-12.12: the project types the method references — signature (parameter and return types)
   * and body (type syntax, static / enum member access → the containing type, casts, `is`/`as`,
   * `typeof`/`nameof`, generic arguments, creations). No library types, no type parameters, not
   * the method's own class; nested types are reported as their top-level containing type (layers
   * are per file, class-diagram nodes are top-level types). One entry per type (first reference).
   * Optional: only requested for the class diagram when the developer turns "Uses" on.
   */
  getTypeUses?(method: MethodRef): Promise<TypeUse[]>;

  /**
   * FR-16.1: where flows start — HTTP endpoints (with their routes), `main` / module-level calls,
   * hosted jobs, message handlers, tests — over the whole project. Optional.
   */
  getEntryPoints?(): Promise<EntryPoint[]>;

  /**
   * FR-7.7: facts about the whole file of a TS module / class, or the whole C# type, for the purity
   * layer hint (the core decides what "pure" means). Optional.
   */
  getModuleFacts?(classKey: string): Promise<ModuleFacts | undefined>;

  /**
   * FR-7.14: the base class of a library class (`lib:` key), read from the package's source (PHP: `vendor/` through
   * Composer's map): the base, `null` when it has none, `undefined` when its source could not be read. Optional.
   */
  getLibraryBase?(classKey: string): Promise<ClassRef | null | undefined>;

  /**
   * FR-1.15: `return` / `throw` statements of the body that are not in tail position (something
   * of the method may still run after them on another path), in source order. Not inside nested
   * functions / lambdas. Optional: without it no exits are drawn.
   */
  getEarlyExits?(method: MethodRef): Promise<EarlyExit[]>;
  /**
   * FR-5.8: every `return` of the body (tail ones too; an expression body counts as one), with what it returns —
   * a tuple / array literal element by element. Not inside nested functions / lambdas. Optional: without it
   * only returned calls and creations are followed (FR-5.7).
   */
  getReturns?(method: MethodRef): Promise<ReturnFact[]>;

  /**
   * FR-8.6 the dependency-injection container's bindings: which implementation the container gives for an
   * abstraction — to every class (`bind(I, B)`), or to one consumer (`when(A)->needs(I)->give(B)`). Optional;
   * without it every implementation is offered.
   */
  getBindings?(): Promise<ContainerBinding[]>;

  /**
   * FR-8.6 the executable projects (hosts) that can run the file's code — a binding applies only to code its hosts
   * run. Optional; undefined / empty = one application (every binding applies).
   */
  getHostsOf?(file: string): Promise<string[] | undefined>;

  /**
   * FR-31.1: the types declared in a file (for module-level functions: the file's module), each with
   * the methods declared there.
   * Optional; undefined = cannot tell (an older sidecar).
   */
  getFileTypes?(file: string): Promise<FileType[] | undefined>;

  /**
   * FR-31.1 every type of the project's own files (not libraries / vendor, test files included) with its methods,
   * as `getFileTypes` gives them per file. Optional; undefined = cannot tell (an older sidecar).
   */
  getProjectTypes?(): Promise<FileType[] | undefined>;

  /**
   * FR-31.1 the calls of module-level code in the project's own files (not test files) — TS / JS statements outside
   * functions and classes, which run when the module loads (`export const shopModule = withAudit(shopRoutes)`). Optional.
   */
  getModuleCalls?(): Promise<CallSite[]>;

  /**
   * FR-31.1 how often the method is used as a value outside test code — kept in an object or array, assigned, returned
   * (`formatters: { invoice: formatInvoice }`) — not counting calls, passing it to a call, imports / exports. Optional.
   */
  getValueUses?(method: MethodRef): Promise<number>;

  /**
   * FR-31.3 names called in templates the analysis does not parse (Laravel Blade views), lower case, with how often.
   * Optional.
   */
  getTemplateCallNames?(): Promise<Map<string, number>>;

  /** Notify of a changed (content given / re-read from disk) or deleted file. */
  /**
   * FR-34.1 memory of the adapter's own process (an out-of-process sidecar), only while it runs — asking never starts
   * it. Optional; undefined = in-process, not running or cannot tell.
   */
  getMemory?(): Promise<ProcessMemory | undefined>;

  /** FR-34.2 stops the adapter's own process to give its memory back; the next request starts it again. Optional. */
  release?(): Promise<void>;

  updateFile(file: string, content?: string): Promise<void>;
  /** FR-16.10 loads the project now (TS program, PHP index, the C# workspace) so the first diagram does not wait. Optional. */
  warmUp?(): Promise<void>;

  dispose(): Promise<void>;
}

/** FR-31.1 a type declared in a file, with its methods declared there. */
export interface FileType {
  type: ClassRef;
  methods: MethodRef[];
}

/** FR-8.6 one container binding: the abstraction's class key, the implementation's, and (contextual) the consumer's. */
export interface ContainerBinding {
  abstract: string;
  concrete: string;
  /** Only for this class (Laravel `when(A)->needs(I)->give(B)`); absent = for every class. */
  consumer?: string;
  /** Where it is declared (the service provider). */
  range: SourceRange;
  /** FR-8.6 a keyed registration (C# `AddKeyedSingleton<I, B>("key")`): chosen at run time by key, never by default. */
  key?: string;
  /** singleton | scoped | transient, when the container says. */
  lifetime?: string;
  /** Registered only if nothing is yet (C# `TryAdd…`): an earlier binding wins. */
  fallback?: boolean;
  /** `key`: a keyed / named service; `condition`: registered when `key` (a run-time condition) holds. */
  keyKind?: 'key' | 'condition';
  /** The executable projects that run the registration (C#); absent = every one. */
  hosts?: string[];
  /** C# a constructed generic abstraction (`INotifier<Shipment>`): the class keys of its type arguments. */
  abstractArgs?: string[];
}

/** FR-12.12: a project type referenced by a method, at its first reference. */
export interface TypeUse {
  type: ClassRef;
  range: SourceRange;
}

export type ReceiverOrigin =
  | { kind: 'self' } // this.m()
  | { kind: 'super' } // super.m()
  | { kind: 'field'; name: string } // this.repo.m()
  | { kind: 'parameter'; name: string } // repo.m() where repo is a parameter
  | { kind: 'local'; name: string } // const r = ...; r.m()
  | { kind: 'static' } // ClassName.m()
  | { kind: 'module'; name: string } // imported function / namespace import: fn(), ns.fn()
  | { kind: 'expression'; text: string } // a().b(), arr[0].m()
  | { kind: 'created'; ordinal: number } // new X().m(): the object created by the call site `ordinal`
  | { kind: 'none' }; // new X()

/**
 * How an argument expression is reached (FR-6.5 parameter binding): `this`, `this.f`, a
 * parameter, a local, or a `new X()` nested in the call (by the create call site's ordinal).
 */
export type ArgumentOrigin =
  | { kind: 'self' }
  | { kind: 'field'; name: string }
  | { kind: 'parameter'; name: string }
  | { kind: 'local'; name: string }
  | { kind: 'created'; ordinal: number };

/** FR-1.19 the static type of an argument (a library type keeps its package). */
export interface ArgumentType {
  type: ClassRef;
  isLibrary: boolean;
  libraryName?: string;
}

/**
 * A function passed as an argument (FR-1.13): a method / function reference (`Mapper.toDto`,
 * `this.handle`, a C# method group), or an inline lambda. The receiver is relative to the caller.
 */
export type ArgumentFunction =
  | { kind: 'method'; target: MethodRef; receiver: ReceiverOrigin; receiverType?: ClassRef; isLibrary: boolean; libraryName?: string }
  | {
      kind: 'lambda';
      range: SourceRange;
      /** FR-1.11: parameter names and the calls of the body (own ordinals), for drawing it where it is invoked. */
      params?: string[];
      calls?: CallSite[];
    };

export interface CallSite {
  /** Index of the call site within the method body (stable part of message ids). */
  ordinal: number;
  kind: 'call' | 'create';
  /** Range of the whole call / new expression. */
  range: SourceRange;
  /** Invoked member name; 'constructor' for create. */
  methodName: string;
  /** Source text of the call expression (used for unknown targets). */
  expressionText: string;
  /** Source text of each argument (comments stripped, whitespace collapsed). */
  args: string[];
  /**
   * Origin of each argument (undefined = not trackable), for parameter binding (FR-6.5), aligned
   * with the target's parameters: a C# extension call `x.Ext(a)` lists the receiver `x` first. Optional.
   */
  argOrigins?: (ArgumentOrigin | undefined)[];
  /** Functions passed as arguments, aligned like `argOrigins` (FR-1.13). Optional. */
  argFunctions?: (ArgumentFunction | undefined)[];
  /**
   * FR-1.19 the type of an argument passed for a parameter the target declares `any` / `unknown` (`zodResponse(schema: any)`
   * called with a `ZodObject`), aligned like `argOrigins`: calls on that parameter in the callee resolve to it. Optional.
   */
  argTypes?: (ArgumentType | undefined)[];
  /** FR-1.19 the receiver of an unresolved call is typed `any` / `unknown`: its expression (`zodSchema`). Optional. */
  untypedReceiver?: string;
  /**
   * The call invokes a delegate- / function-typed parameter of the analysed callable
   * (`onSuccess(x)`, `onSuccess.Invoke(x)`, `cb(x)`) — what runs depends on the caller (FR-1.13).
   */
  invokedParameter?: string;
  /**
   * With `invokedParameter`: its declared type when that is a named project type (a function type
   * alias / interface, a C# delegate type) — the port the callee depends on (FR-1.13).
   */
  invokedParameterType?: ClassRef;
  /**
   * FR-1.11 the call invokes the function a project call returned (PHP `$this->guard('…', function () {…})($x)`): the
   * returned closure runs code of the sender, so it is drawn as the sender's own call, not as an unresolved one. The
   * closures handed to that project call follow it in a `callback` frame (the returned closure runs them). Optional.
   */
  invokesResult?: true;
  /** For creates: the local / field the new object is assigned to (`const r = new X()`) (FR-6.5). Optional. */
  assignedTo?: { kind: 'local' | 'field'; name: string };
  /** FR-9.4: calls and creates — the result is assigned (`user = …`, `this.cache = …`, `{ a, b } = …`) or returned. Optional. */
  result?: CallResult;
  /** FR-9.5: calls only — declared return type, awaited when the call is awaited; absent for void / unknown. Optional. */
  returnType?: string;
  receiver: ReceiverOrigin;
  /** Static type of the receiver (may be an interface or abstract class). For create: the created class. */
  receiverType?: ClassRef;
  /** FR-1.18 not written as a call: a read of a getter / an assignment to a setter (`this.events`, `b.rating = 5`). */
  accessor?: 'get' | 'set';
  /** FR-1.20 not written as a call: a JSX element of a project component (`<ShopTab />`); `args` are the props' names. */
  render?: true;
  /**
   * FR-5.10 creations: where the arguments come from — `fixed`: no parameter of the functions the line is in and no
   * `this` (every run of this line passes what the same code computes: `new X(cart)` in a hook);
   * `constructorParams`: only the parameters of the constructor it is in. Absent: anything else. Optional (TS only).
   */
  argsFrom?: 'fixed' | 'constructorParams';
  /**
   * FR-5.9 a creation of a generic type parameter (`new TResponse { … }`): its name; `receiverType` is then its
   * constraint (`where TResponse : ApiResponse<TData>`) and `target` absent. Optional.
   */
  typeParameter?: string;
  /**
   * FR-5.9 a generic call's type arguments (`ToResponse<Dto, DtoResponse>()` → TData → Dto, TResponse → DtoResponse;
   * also a generic receiver type's). `parameter`: the caller passes one of its own type parameters on. Optional.
   */
  typeArguments?: TypeArgument[];
  /** Resolved declaration (may be an interface/abstract member with hasBody=false). Undefined = unresolvable (FR-1.8). */
  target?: MethodRef;
  /** Awaited or returns a Promise/thenable (FR-1.9). */
  isAsync: boolean;
  /** Declared outside the project sources (node_modules, lib.d.ts) (FR-1.6). */
  isLibrary: boolean;
  /** Package name for library calls ("express", "node:fs", "lib" for builtins). */
  libraryName?: string;
  /**
   * Control-flow constructs of the analysed method body that enclose the call, outermost first
   * (FR-1.10). Constructs outside the method (callers, nested functions) are never included.
   * Optional: absent = the call is unconditional.
   */
  fragments?: FragmentScope[];
}

/** FR-7.7 what a module / class depends on, over its whole file (TS) or type (C#). */
export interface ModuleFacts {
  /**
   * Ports it takes: parameter / constructor-parameter / field types that are service abstractions —
   * records of functions, interfaces / abstract classes of the project, named function types.
   */
  ports: string[];
  /** Libraries it uses: npm package / Node module specifiers, .NET namespaces of the types it references. */
  libraries: string[];
  /** Project types / modules it references (not itself, not its nested types). */
  dependsOn: ClassRef[];
  /** FR-7.13 a UI component: the file renders JSX (`.tsx` / `.jsx`). Optional. */
  jsx?: boolean;
}

/** FR-1.15 one early exit of a body. */
export interface EarlyExit {
  kind: 'return' | 'throw';
  /** The whole statement. */
  range: SourceRange;
  /** throw: exception type of `throw new X(…)`, else the thrown expression; absent for a rethrow. */
  exception?: string;
  /** FR-3.9 return: the returned expression, compacted ('' for a bare `return;`). Optional: absent = not known. */
  value?: string;
  /** Enclosing constructs, outermost first — same ids as the call sites' scopes. */
  fragments?: FragmentScope[];
}

/** FR-5.9 one type argument of a generic call: a class, or the caller's own type parameter passed on. */
export interface TypeArgument {
  name: string;
  type?: ClassRef;
  parameter?: string;
}

/** FR-5.8 a `return` statement (or an expression body) and what it returns. */
export interface ReturnFact {
  /** The whole statement (the expression for an expression body). */
  range: SourceRange;
  /** `return (a, b)` / `return [$a, $b]` / `return [a, b]`: the literal's elements, in order. Else one value. */
  tuple?: boolean;
  /** Empty for a bare `return;`. */
  values: ReturnValue[];
}

/**
 * FR-5.8 one returned value: `variable` — a local variable of the body (not a parameter or field), `empty` —
 * null / default / undefined (no object), else an expression (its calls are matched by `range`).
 */
export interface ReturnValue {
  range: SourceRange;
  variable?: string;
  empty?: boolean;
}

/**
 * One enclosing control-flow construct of a call site (FR-1.10). All operands of one construct
 * share `id`; the core turns runs of calls with equal scopes into combined fragments.
 */
export interface FragmentScope {
  /** Identifies the construct within the method body, e.g. "if@120" (only compared within one analysis result). */
  id: string;
  /**
   * `alt`: if/else-if/else chains, switch, conditional expressions (`opt` when there is one
   * branch only, e.g. an `if` without `else`); `loop`; `try` (operand 0 = try block, 1.. = catch clauses).
   */
  kind: 'alt' | 'opt' | 'loop' | 'try' | 'callback';
  /** Operand index within the construct (branch / case group / catch clause); 0 for loops and opt. */
  operand: number;
  /** Guard of the operand, compacted source text: "user.isActive", "each u of users", "else", "catch". */
  guard?: string;
  /** For the `else` operand of a two-branch alt: the negated condition, used when only the else branch is visible. */
  negatedGuard?: string;
  /** Location of the operand's condition (or the construct's keyword when it has none). */
  range?: SourceRange;
  /** FR-1.17 `try` only: every catch clause of the construct and what it does with the error. */
  handlers?: CatchHandler[];
  /**
   * FR-19.1 loop statements only: the call leaves the loop — it is in a `return` / `throw`, or one follows it in its
   * block before any `continue` / `break` — so it runs at most once per loop, not once per element.
   */
  leavesLoop?: true;
}

/** FR-1.17 a catch clause, judged from its syntax (statements in nested functions do not count). */
export interface CatchHandler {
  /** The clause's operand index (1 = first catch). */
  operand: number;
  /** "catch JsonException" — as the operand's guard. */
  guard: string;
  /** rethrow: a `throw` in the clause; return: returns a value; skip: `continue`; swallow: none of these. */
  outcome: 'rethrow' | 'return' | 'skip' | 'swallow';
  /** return: the returned expression, compacted. */
  value?: string;
  /** The clause calls a logger (`_logger.LogError`, `Log::error`, `console.error`, `report($e)`, …). */
  logged: boolean;
  range?: SourceRange;
}

export interface FieldInfo {
  name: string;
  /** The field's class — for a collection (`User[]`, `List<User>`, `@var User[]`): the element's class. */
  type?: ClassRef;
  /** FR-12.15 the field holds a collection of `type` (array, list, set, map values, iterable). */
  collection?: boolean;
  isStatic: boolean;
  /** Constructor parameter property, or assigned from a constructor parameter (dependency injection). */
  injected: boolean;
  /** FR-12.9 where the field is declared (a promoted / parameter property: the parameter). Optional. */
  declaration?: SourceRange;
}

export interface ClassInfo {
  ref: ClassRef;
  /** Absolute file path of the declaration. */
  file?: string;
  /** Decorator names without '@', e.g. ["Controller", "Injectable"]. */
  decorators: string[];
  extends?: ClassRef;
  implements: ClassRef[];
  fields: FieldInfo[];
  constructorParams: { name: string; type?: ClassRef }[];
  hasPrivateConstructor: boolean;
  /** Static field/getter of its own type, or static getInstance(). */
  hasStaticInstance: boolean;
  /** Class declares only static members (and no instance members besides an optional private ctor). */
  allMembersStatic: boolean;
  /** Module exports a module-level instance: `export const userService = new UserService()`. */
  isExportedInstance: boolean;
  /**
   * Synthetic owner of functional code (an object literal or a closure such as a factory's
   * product): drawn as one class-level participant. Optional (absent = false).
   */
  synthetic?: boolean;
  /** Synthetic owner of functions declared inside another function (named `outer()`), stereotype «locals». */
  localFunctions?: boolean;
  /**
   * FR-5.10 its objects are interchangeable: no state of their own (no field written outside the constructor, no
   * constructor parameters, fields hold only interchangeable objects or what everyone shares). Optional (TS only).
   */
  interchangeable?: boolean;
  /**
   * FR-5.10 objects built with the same constructor arguments cannot differ (as `interchangeable`, constructor
   * parameters allowed: `new CartView(cart)`). Implied by `interchangeable`. Optional (TS only).
   */
  sameArgsInterchangeable?: boolean;
  /**
   * FR-5.12 its objects cannot change once built — a value (C# `record`, only `readonly` fields and get / init
   * properties, no mutable collection, not disposable): which object a call goes to does not matter. Optional (C# only).
   */
  immutable?: boolean;
  /** `visibility`: FR-12.18 absent = public. */
  methods: { name: string; isStatic: boolean; signature: string; visibility?: MemberVisibility }[];
  /**
   * Simple names of the types declared inside the class (C# nested types). Optional. Layer hints
   * ignore them: a class's own nested types say nothing about which layer it belongs to.
   */
  nestedTypes?: string[];
  /**
   * FR-7.15 its own code only holds data: fields, constants, enum cases, a constructor that only stores values, and
   * getters / setters that only return or set a field (no other logic). Its base class is not checked (core walks
   * it). Optional: absent = it has behaviour, or the adapter cannot tell.
   */
  dataOnly?: boolean;
}
