import type { CallerInfo, ClassRef, EntryPoint, MethodRef, UnreachableMethod, UnreachableScan } from '@seqcall/protocol';
import type { CallSite, ClassInfo, LanguageAdapter } from './adapter';
import { timeSlicer } from './time-slice';

/** FR-31.1 the walk stops after this many reached methods (the result says so). */
export const UNREACHABLE_MAX_METHODS = 50_000;

export interface UnreachableWalk {
  adapter: Pick<LanguageAdapter, 'getOutgoingCalls' | 'getImplementations' | 'getClassInfo' | 'getProjectTypes' | 'getModuleCalls' | 'getValueUses' | 'getTemplateCallNames' | 'getBindings'>;
  /** Where the walk starts (test entry points are left out here). */
  entryPoints: EntryPoint[];
  /** A test file (absolute path): its methods are not listed. */
  isTest(file: string): boolean;
  /** References query of a method (cached by the caller, FR-22). */
  callers(method: MethodRef): Promise<CallerInfo[]>;
  cancelled?(): boolean;
  /** `reach`: methods reached so far; `check`: steps done over the unreached methods (two each), of `total`. */
  onProgress?(phase: 'reach' | 'check', done: number, total?: number): void;
  maxMethods?: number;
  /**
   * FR-31.4 `unreachable.ignore` of the project config: methods a tool or the framework runs by convention (migrations,
   * listeners) — walked from like entry points, not listed.
   */
  ignored?(method: MethodRef): boolean;
}

export interface UnreachableResult extends UnreachableScan {
  /** The methods counted in `missed` (for probes: references the walk does not follow). */
  missedMethods: MethodRef[];
}

/**
 * FR-31.1 the project's methods no entry point reaches. Forward from the entry points (tests excluded) over the call
 * graph — a route's middleware and module-level code too: every call's target, all implementations / overrides of a
 * reached method (a call on an interface may run any of them), methods passed as an argument and the calls of lambdas
 * passed as one. The constructors of a class are walked when an instance method of it is reached or it is created (a
 * DI container creates objects without `new`; what a constructor calls runs with it). Each method not reached gets its reason: called by another unreached method (from their own calls),
 * else by the references query. A method a reached method, a closure or a value use refers to is `missed` — the walk
 * did not follow that reference: not listed, and walked from in another round. Undefined when cancelled.
 */
export async function findUnreachable(walk: UnreachableWalk): Promise<UnreachableResult | undefined> {
  const entryPoints = walk.entryPoints.filter((e) => e.kind !== 'test');
  const types = (await walk.adapter.getProjectTypes?.()) ?? [];
  const all = new Map<string, MethodRef>();
  for (const t of types) for (const m of t.methods) if (m.hasBody && !(m.declaration && walk.isTest(m.declaration.file))) all.set(m.key, m);
  const empty: UnreachableResult = { methods: [], total: all.size, reached: 0, entryPoints: entryPoints.length, missed: 0, truncated: false, missedMethods: [] };
  // a library: nothing starts a flow, so everything would be listed
  if (!entryPoints.length) return empty;

  const max = walk.maxMethods ?? UNREACHABLE_MAX_METHODS;
  const slice = timeSlicer();
  const reached = new Set<string>();
  const reachedClasses = new Set<string>();
  const queue: MethodRef[] = [];
  let truncated = false;
  // a class whose code runs has been constructed: its constructors ran too (a DI container calls them; what they call —
  // an event subscription, a client set up — runs with them)
  const constructors = new Map<string, MethodRef[]>();
  for (const m of all.values()) if (isConstructor(m)) constructors.set(m.owner.key, [...(constructors.get(m.owner.key) ?? []), m]);
  const reachClass = (key: string) => {
    if (reachedClasses.has(key)) return;
    reachedClasses.add(key);
    for (const c of constructors.get(key) ?? []) reach(c);
  };
  const methodsOf = new Map<string, MethodRef[]>();
  for (const m of all.values()) methodsOf.set(m.owner.key, [...(methodsOf.get(m.owner.key) ?? []), m]);
  // FR-8.6 a container binding: a call on the bound type runs the bound class's method of that name, also when the class
  // does not implement the type (`singleton(SettingsContract::class, SettingsRepository::class)`)
  const bound = new Map<string, string[]>();
  for (const b of (await walk.adapter.getBindings?.().catch(() => [])) ?? []) bound.set(b.abstract, [...(bound.get(b.abstract) ?? []), b.concrete]);
  const reach = (m: MethodRef | undefined) => {
    if (!m || m.owner.kind === 'external' || reached.has(m.key)) return;
    reached.add(m.key);
    queue.push(m);
    if (!m.isStatic) reachClass(m.owner.key);
    for (const k of bound.get(m.owner.key) ?? []) for (const b of methodsOf.get(k) ?? []) if (b.name === m.name) reach(b);
  };
  const visit = (c: CallSite) => {
    if (c.kind === 'create' && c.receiverType && !c.isLibrary) reachClass(c.receiverType.key);
    // a project class named as a library call's type argument is created by the library: `services.AddScoped<IShop,
    // Shop>()`, `app.UseMiddleware<AuditMiddleware>()` (which then calls its `Invoke` / `InvokeAsync` by convention)
    if (c.isLibrary) {
      for (const a of c.typeArguments ?? []) {
        if (!a.type || isLibrary(a.type)) continue;
        reachClass(a.type.key);
        if (c.methodName === 'UseMiddleware') for (const m of methodsOf.get(a.type.key) ?? []) if (MIDDLEWARE_METHODS.has(m.name)) reach(m);
      }
    }
    targetsOf(c, reach);
  };
  for (const e of entryPoints) {
    reach(e.method);
    // FR-18.14 the framework runs a route's middleware before its action
    for (const mw of e.middleware ?? []) reach(mw.method);
  }
  // FR-31.4 what the project says a tool runs
  let ignored = 0;
  for (const m of all.values()) {
    if (!walk.ignored?.(m)) continue;
    ignored++;
    reach(m);
  }
  // module-level code runs when its module loads (every module is taken as loaded: no false "unreached")
  const moduleCalls = (await walk.adapter.getModuleCalls?.().catch(() => [])) ?? [];
  for (const c of moduleCalls) visit(c);
  const callsMemo = new Map<string, Promise<CallSite[]>>();
  const callsOf = (m: MethodRef) => {
    if (!callsMemo.has(m.key)) callsMemo.set(m.key, walk.adapter.getOutgoingCalls(m).catch(() => []));
    return callsMemo.get(m.key)!;
  };
  const infos = new Map<string, Promise<ClassInfo | undefined>>();
  const infoOf = (key: string) => {
    if (!infos.has(key)) infos.set(key, walk.adapter.getClassInfo(key).catch(() => undefined));
    return infos.get(key)!;
  };
  // the class and the project's base classes above it
  const chainOf = async (key: string): Promise<ClassInfo[]> => {
    const chain: ClassInfo[] = [];
    for (let k: string | undefined = key; k && chain.length < MAX_BASES; ) {
      const info = await infoOf(k);
      if (!info) break;
      chain.push(info);
      k = info.extends && !isLibrary(info.extends) ? info.extends.key : undefined;
    }
    return chain;
  };
  // non-public, without parameters (the class declares no other constructor) and calling nothing
  const blocksCreation = async (m: MethodRef): Promise<boolean> => {
    const own = (await infoOf(m.owner.key))?.methods.filter((x) => x.name === 'constructor') ?? [];
    return own.length === 1 && !!own[0].visibility && /\(\s*\)$/.test(own[0].signature) && !(await callsOf(m)).length;
  };
  const missedMethods: MethodRef[] = [];
  let methods: UnreachableMethod[] = [];
  // rounds: a method found probably reached (below) is walked from in the next round, until none is found
  for (let walked = 0; ; ) {
    for (; walked < queue.length; walked++) {
      if (reached.size > max) {
        truncated = true;
        break;
      }
      await slice();
      if (walk.cancelled?.()) return undefined;
      const m = queue[walked];
      // a module function, a static method or a constructor has no overrides (the query is slow: a references search)
      if (m.owner.kind !== 'module' && !m.isStatic && !isConstructor(m)) for (const impl of await walk.adapter.getImplementations(m).catch(() => [])) reach(impl);
      if (m.hasBody) for (const c of await callsOf(m)) visit(c);
      walk.onProgress?.('reach', reached.size);
    }

    const unreached = [...all.values()].filter((m) => !reached.has(m.key));
    // who calls an unreached method among the unreached ones, from their own calls (no reference search)
    const unreachedKeys = new Set(unreached.map((m) => m.key));
    const calledBy = new Map<string, Set<string>>();
    for (let i = 0; i < unreached.length; i++) {
      await slice();
      if (walk.cancelled?.()) return undefined;
      const m = unreached[i];
      walk.onProgress?.('check', i + 1, unreached.length * 2);
      for (const c of await callsOf(m)) {
        targetsOf(c, (t) => {
          if (t.key !== m.key && unreachedKeys.has(t.key)) calledBy.set(t.key, (calledBy.get(t.key) ?? new Set()).add(m.key));
        });
      }
    }
    methods = [];
    const found: MethodRef[] = [];
    for (let i = 0; i < unreached.length; i++) {
      await slice();
      if (walk.cancelled?.()) return undefined;
      const m = unreached[i];
      walk.onProgress?.('check', unreached.length + i + 1, unreached.length * 2);
      // a constructor that only stops others from creating the class (`protected Program() { }`): nothing to delete
      if (isConstructor(m) && (await blocksCreation(m))) continue;
      const framework = frameworkHint(m, await chainOf(m.owner.key));
      const known = calledBy.get(m.key);
      if (known) {
        methods.push({ method: m, reason: 'unreached-callers', callers: known.size, ...(framework ? { framework } : {}) });
        continue;
      }
      // the references query (slow on a large project): only for methods no unreached method calls — it also finds what
      // the walk does not follow
      const callers = (await walk.callers(m).catch(() => [] as CallerInfo[])).filter((c) => c.enclosing.key !== m.key);
      // called from a reached method, or from a function the method list does not hold (a closure, a local function:
      // run when the method around it is), or used as a value (stored, assigned): probably reached
      const unknown = (c: CallerInfo) => !c.inTest && (reached.has(c.enclosing.key) || !all.has(c.enclosing.key));
      if (callers.some(unknown) || (!isConstructor(m) && (await walk.adapter.getValueUses?.(m).catch(() => 0)))) {
        found.push(m);
        continue;
      }
      const reason = callers.some((c) => !c.inTest) ? 'unreached-callers' : callers.length ? 'tests-only' : 'no-callers';
      methods.push({ method: m, reason, callers: callers.length, ...(framework ? { framework } : {}) });
    }
    if (!found.length || truncated) break;
    missedMethods.push(...found);
    for (const m of found) reach(m);
  }

  // what a listed method reaches follows it: a walk from the given ones over the listed methods, each method found
  // mapped to the first one reaching it (a constructor through its class)
  const spread = async (roots: MethodRef[]): Promise<((m: MethodRef) => MethodRef | undefined) | undefined> => {
    const via = new Map<string, MethodRef>();
    const viaClasses = new Map<string, MethodRef>();
    const todo: [MethodRef, MethodRef][] = roots.map((m) => [m, m]);
    for (const m of roots) via.set(m.key, m);
    for (const m of roots) if (!m.isStatic && !viaClasses.has(m.owner.key)) {
      viaClasses.set(m.owner.key, m);
      // (a reached constructor is not listed: what it is mapped to is never asked)
      for (const c of constructors.get(m.owner.key) ?? []) if (!via.has(c.key)) (via.set(c.key, m), todo.push([c, m]));
    }
    for (let i = 0; i < todo.length && via.size <= max; i++) {
      await slice();
      if (walk.cancelled?.()) return undefined;
      const [m, root] = todo[i];
      const next = (t: MethodRef) => {
        if (via.has(t.key) || reached.has(t.key) || t.owner.kind === 'external') return;
        via.set(t.key, root);
        todo.push([t, root]);
        // as in the walk: an instance method's class was constructed, its constructors ran
        if (t.isStatic || viaClasses.has(t.owner.key)) return;
        viaClasses.set(t.owner.key, root);
        for (const c of constructors.get(t.owner.key) ?? []) next(c);
      };
      if (m.owner.kind !== 'module' && !m.isStatic && !isConstructor(m)) for (const impl of await walk.adapter.getImplementations(m).catch(() => [])) next(impl);
      for (const c of await callsOf(m)) targetsOf(c, next);
    }
    return (m) => via.get(m.key);
  };
  // FR-31.2 what the framework-called methods reach is called by the framework too (a console kernel's schedule, a
  // service provider's boot)
  const fromFramework = await spread(methods.filter((u) => u.framework).map((u) => u.method));
  if (!fromFramework) return undefined;
  for (const u of methods) {
    const root = u.framework ? undefined : fromFramework(u.method);
    if (root) u.framework = `called from ${root.owner.name}.${root.name}, which the framework calls`;
  }
  // FR-31.3 calls the analysis could not resolve (an untyped receiver, a facade) in reached code, and calls in templates
  // it does not parse (Blade views): a listed method of that name may be called — and what it reaches with it
  const unresolved = new Map<string, number>((await walk.adapter.getTemplateCallNames?.().catch(() => undefined)) ?? []);
  const count = (c: CallSite) => {
    if (c.kind === 'call' && !c.target && !c.isLibrary) unresolved.set(c.methodName.toLowerCase(), (unresolved.get(c.methodName.toLowerCase()) ?? 0) + 1);
    for (const f of c.argFunctions ?? []) if (f?.kind === 'lambda') for (const inner of f.calls ?? []) count(inner);
  };
  for (const c of moduleCalls) count(c);
  for (const key of reached) for (const c of (await callsMemo.get(key)) ?? []) count(c);
  const maybe = methods.filter((u) => !u.framework && unresolved.has(u.method.name.toLowerCase()));
  for (const u of maybe) u.unresolved = unresolved.get(u.method.name.toLowerCase());
  const fromMaybe = await spread(maybe.map((u) => u.method));
  if (!fromMaybe) return undefined;
  for (const u of methods) {
    const root = u.framework || u.unresolved ? undefined : fromMaybe(u.method);
    if (root) Object.assign(u, { unresolved: unresolved.get(root.name.toLowerCase()), via: `${root.owner.name}.${root.name}` });
  }

  methods.sort((a, b) => (a.method.declaration?.file ?? '').localeCompare(b.method.declaration?.file ?? '') || (a.method.declaration?.start.line ?? 0) - (b.method.declaration?.start.line ?? 0));
  return { ...empty, methods, reached: [...all.keys()].filter((k) => reached.has(k)).length, missed: missedMethods.length, truncated, missedMethods, ...(ignored ? { ignored } : {}) };
}

/** FR-31 the scan as hosts send it to the view: without the probe's list of missed methods. */
export function unreachableScan(r: UnreachableResult): UnreachableScan {
  const { missedMethods: _, ...scan } = r;
  return scan;
}

/**
 * FR-19.23 the group of the unreachable-code list (FR-31) a method is in, in the list's words: a design finding in it
 * names the same group as ∅ shows it under (framework first, then maybe called, then the reason).
 */
export function unreachableGroup(u: UnreachableMethod): string {
  if (u.framework) return 'probably called by the framework';
  if (u.unresolved) return 'maybe called';
  return u.reason === 'no-callers' ? 'no callers' : u.reason === 'tests-only' ? 'only tests call it' : 'called only from unreached code';
}

/** FR-31 progress for a host: at most every `ms` (a scan reports thousands of steps). */
export function throttled<A extends unknown[]>(post: (...args: A) => void, ms = 250, now: () => number = Date.now): (...args: A) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (...args: A) => {
    const t = now();
    if (t - last < ms) return;
    last = t;
    post(...args);
  };
}

/** The project methods a call runs: its target, a method passed as an argument, the calls of a lambda passed as one. */
function targetsOf(c: CallSite, add: (m: MethodRef) => void): void {
  if (!c.isLibrary && c.target) add(c.target);
  for (const f of c.argFunctions ?? []) {
    if (f?.kind === 'method' && !f.isLibrary) add(f.target);
    else if (f?.kind === 'lambda') for (const inner of f.calls ?? []) targetsOf(inner, add);
  }
}

/** TS `constructor`, C# `.ctor` / `.cctor`, PHP `__construct`. */
function isConstructor(m: MethodRef): boolean {
  return m.name === 'constructor' || m.name === '__construct' || m.name.startsWith('.') || m.key.endsWith('..ctor') || m.key.includes('..ctor(');
}

/** ASP.NET Core calls a middleware class's `Invoke` / `InvokeAsync` by convention (`UseMiddleware<T>()`). */
const MIDDLEWARE_METHODS = new Set(['Invoke', 'InvokeAsync']);

/** Methods the language runtime calls by name: string conversion, JSON, equality, hashing. */
const RUNTIME_METHODS = new Set(['toString', 'toJSON', 'valueOf', 'ToString', 'Equals', 'GetHashCode', 'Dispose', 'DisposeAsync', 'jsonSerialize']);

const isLibrary = (r: ClassRef | undefined): boolean => !!r && (r.kind === 'external' || r.key.startsWith('lib:'));

/** How far up the project's own base classes the framework hint looks. */
const MAX_BASES = 6;

/**
 * FR-31.2 why the framework may call it: a magic / runtime method, or — not a private method — its class (or one of the
 * project's base classes above it, `chain` from the class up) extends / implements a library type.
 */
function frameworkHint(m: MethodRef, chain: ClassInfo[]): string | undefined {
  if (m.name.startsWith('__')) return `magic method ${m.name}`;
  if (RUNTIME_METHODS.has(m.name)) return `the runtime calls ${m.name}`;
  // the framework cannot call a private method (overloads of one name: private only when all are)
  const own = chain[0]?.methods.filter((x) => x.name === m.name) ?? [];
  if (own.length && own.every((x) => x.visibility === 'private')) return undefined;
  for (let i = 0; i < chain.length; i++) {
    const through = i ? `, through ${chain[i].ref.name}` : '';
    if (isLibrary(chain[i].extends)) return `extends ${chain[i].extends!.name}${through}`;
    const impl = chain[i].implements.find(isLibrary);
    if (impl) return `implements ${impl.name}${through}`;
  }
  return undefined;
}
