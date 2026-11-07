import type { ClassRef, MethodRef } from '@seqcall/protocol';
import type { CallSite, ClassInfo, EarlyExit, LanguageAdapter, ModuleFacts, ReturnFact, TypeUse } from '../adapter';
import { activeRecordBase, type ActiveRecordBase, type LibraryBase, type UnreadBase } from '../active-record';
import { isIoLibrary } from '../side-effects';
import type { Classification, Classifier, UsageContext } from '../classifier';

/**
 * Memoises adapter/classifier results between renders; cleared on refresh.
 *
 * The adapter is asynchronous, but building, classifying, labelling and grouping a diagram are
 * synchronous. The synchronous accessors (`outgoing`, `classInfo`, …) therefore only read the
 * cache: on a miss they record the missing request and return an empty placeholder. `resolve()`
 * runs a synchronous computation, fetches everything it missed (in parallel), and repeats until
 * a run completes without misses — that last run saw only real data, so its result is exactly
 * what a synchronous adapter would have produced.
 */
export class AnalysisCache {
  private readonly outgoingCache = new Map<string, CallSite[]>();
  private readonly implCache = new Map<string, MethodRef[]>();
  private readonly classInfoCache = new Map<string, ClassInfo | undefined>();
  private readonly classifyCache = new Map<string, Classification>();
  private readonly paramCache = new Map<string, string[]>();
  /** FR-12.12: type uses per method key (only requested for the class diagram with "Uses" on). */
  private readonly typeUseCache = new Map<string, TypeUse[]>();
  /** FR-7.7: module / type facts per class key. */
  private readonly factsCache = new Map<string, ModuleFacts | undefined>();
  /** FR-7.14: the base class of a library class, read from its package (`'unread'`: could not be read). */
  private readonly libBaseCache = new Map<string, ClassRef | null | 'unread'>();
  /** FR-1.15: early exits per method key. */
  private readonly exitCache = new Map<string, EarlyExit[]>();
  private readonly returnCache = new Map<string, ReturnFact[]>();
  /** Owner class key of every method whose outgoing calls were requested (for per-class views). */
  private readonly methodOwner = new Map<string, string>();
  /**
   * The same, per owner class (in `methodOwner`'s order): the layer hints ask for one class's calls / type uses per
   * participant of every build, and walking all methods for each would make a long scan quadratic.
   */
  private readonly methodsOfClass = new Map<string, Set<string>>();

  private setOwner(method: MethodRef): void {
    const owner = method.owner.key;
    const before = this.methodOwner.get(method.key);
    if (before === owner) return;
    this.methodOwner.set(method.key, owner);
    if (before === undefined) {
      let set = this.methodsOfClass.get(owner);
      if (!set) this.methodsOfClass.set(owner, (set = new Set()));
      set.add(method.key);
      return;
    }
    // (an owner that changes keeps the method's first place in `methodOwner`: both classes' lists are rebuilt)
    for (const cls of [before, owner]) this.methodsOfClass.set(cls, new Set([...this.methodOwner].filter(([, o]) => o === cls).map(([k]) => k)));
  }
  /** Requests missed by the current synchronous run, by cache slot. */
  private readonly misses = new Map<string, () => Promise<unknown>>();
  /** In-flight adapter requests, by cache slot (deduplicated). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Bumped by clear(): results of requests started before are discarded. */
  private generation = 0;

  constructor(
    private readonly adapter: LanguageAdapter,
    private readonly classifier: Classifier,
  ) {}

  /**
   * Runs `compute` (synchronous, reading this cache) until it no longer misses data, fetching
   * the missed adapter results in parallel between runs. Adapter errors reject.
   */
  async resolve<T>(compute: () => T): Promise<T> {
    for (;;) {
      this.misses.clear();
      const result = compute();
      if (this.misses.size === 0) return result;
      const fetches = [...this.misses.values()];
      this.misses.clear();
      await Promise.all(fetches.map((f) => f()));
    }
  }

  // ───────────── synchronous reads (record misses) ─────────────

  /** FR-1.15 early exits of a body (miss → [] and fetched by resolve()). */
  earlyExits(method: MethodRef): EarlyExit[] {
    const exits = this.exitCache.get(method.key);
    if (exits) return exits;
    if (this.adapter.getEarlyExits) this.miss(`x:${method.key}`, () => this.fetchEarlyExits(method));
    return [];
  }

  /** Cached early exits without recording a miss (undefined = not fetched yet). */
  peekEarlyExits(method: MethodRef): EarlyExit[] | undefined {
    return this.exitCache.get(method.key);
  }

  /** FR-5.8 the returns of a body; undefined when the adapter cannot tell (miss → undefined, fetched by resolve()). */
  returns(method: MethodRef): ReturnFact[] | undefined {
    if (!this.adapter.getReturns) return undefined;
    const facts = this.returnCache.get(method.key);
    if (facts) return facts;
    this.miss(`r:${method.key}`, () => this.fetchReturns(method));
    return undefined;
  }

  /** Cached body calls without recording a miss (undefined = not analysed yet). */
  peekOutgoing(method: MethodRef): CallSite[] | undefined {
    return this.outgoingCache.get(method.key);
  }

  outgoing(method: MethodRef): CallSite[] {
    this.setOwner(method);
    const calls = this.outgoingCache.get(method.key);
    if (calls) return calls;
    this.miss(`o:${method.key}`, () => this.fetchOutgoing(method));
    return [];
  }

  /** Cached implementations without requesting them (undefined = not requested yet). */
  peekImplementations(method: MethodRef): MethodRef[] | undefined {
    return this.implCache.get(method.key);
  }

  implementations(method: MethodRef): MethodRef[] {
    const impls = this.implCache.get(method.key);
    if (impls) return impls;
    this.miss(`i:${method.key}`, () => this.fetchImplementations(method));
    return [];
  }

  /** All already analysed calls made by methods of a class (no adapter requests). */
  callsOfClass(classKey: string): { analysedMethods: number; calls: CallSite[] } {
    let analysedMethods = 0;
    const calls: CallSite[] = [];
    for (const methodKey of this.methodsOfClass.get(classKey) ?? []) {
      const c = this.outgoingCache.get(methodKey);
      if (!c) continue;
      analysedMethods++;
      calls.push(...c);
    }
    return { analysedMethods, calls };
  }

  /** Cached base of a library class without requesting it (FR-7.14). */
  readonly peekLibraryBase: LibraryBase = (key) => this.libBaseCache.get(key);

  /** Cached class info without requesting it (undefined when not fetched). */
  peekClassInfo(classKey: string): ClassInfo | undefined {
    return this.classInfoCache.get(classKey);
  }

  /**
   * Every project class seen so far (class infos, call targets/receivers, field and ctor types) — kept up to date as
   * entries arrive (`noteRefs`): rebuilding it from all cached entries for every render would make long scans
   * quadratic. Order: class infos' types first, then calls'.
   */
  knownClassRefs(): ClassRef[] {
    if (!this.knownList) {
      const out = [...this.knownFromInfos.values()];
      for (const [key, ref] of this.knownFromCalls) if (!this.knownFromInfos.has(key)) out.push(ref);
      this.knownList = out;
    }
    return this.knownList;
  }

  private readonly knownFromInfos = new Map<string, ClassRef>();
  private readonly knownFromCalls = new Map<string, ClassRef>();
  private knownList: ClassRef[] | undefined;

  /** Records the project classes of a newly cached class info / call list (for `knownClassRefs`). */
  private noteRefs(cache: Map<string, unknown>, value: unknown): void {
    const into = cache === (this.classInfoCache as Map<string, unknown>) ? this.knownFromInfos : cache === (this.outgoingCache as Map<string, unknown>) ? this.knownFromCalls : undefined;
    if (!into || !value) return;
    const add = (r?: ClassRef) => {
      if (r && !r.key.startsWith('lib:') && r.key !== 'unknown' && !into.has(r.key)) {
        into.set(r.key, r);
        this.knownList = undefined;
      }
    };
    if (into === this.knownFromInfos) {
      const ci = value as ClassInfo;
      add(ci.ref);
      ci.fields.forEach((f) => add(f.type));
      ci.constructorParams.forEach((p) => add(p.type));
      add(ci.extends);
      ci.implements.forEach(add);
    } else {
      for (const c of value as CallSite[]) {
        add(c.receiverType);
        add(c.target?.owner);
      }
    }
  }

  /** Parameter names of a method (FR-6.5 binding); [] when the adapter cannot tell. */
  parameterNames(method: MethodRef): string[] {
    if (!this.adapter.getParameterNames) return [];
    const names = this.paramCache.get(method.key);
    if (names) return names;
    this.miss(`p:${method.key}`, () => this.fetchParameterNames(method));
    return [];
  }

  /** FR-12.12: project types the method references; [] when the adapter cannot tell. */
  typeUses(method: MethodRef): TypeUse[] {
    if (!this.adapter.getTypeUses) return [];
    this.setOwner(method);
    const uses = this.typeUseCache.get(method.key);
    if (uses) return uses;
    this.miss(`u:${method.key}`, () => this.fetchTypeUses(method));
    return [];
  }

  /** Already fetched type uses of a class's methods (no adapter requests; layer hints). */
  typeUsesOfClass(classKey: string): TypeUse[] {
    const out: TypeUse[] = [];
    for (const methodKey of this.methodsOfClass.get(classKey) ?? []) {
      const u = this.typeUseCache.get(methodKey);
      if (u) out.push(...u);
    }
    return out;
  }

  /** Synthetic owner of functional code (object literal / closure): one class-level participant. */
  isSynthetic(classKey: string): boolean {
    return !!this.classInfo(classKey)?.synthetic;
  }

  classInfo(classKey: string): ClassInfo | undefined {
    if (!hasClassInfo(classKey)) return undefined;
    if (this.classInfoCache.has(classKey)) return this.classInfoCache.get(classKey);
    this.miss(`c:${classKey}`, () => this.fetchClassInfo(classKey));
    return undefined;
  }

  /** FR-7.14 the base of a library class (requested on a miss; `undefined` while fetched). */
  private readonly libraryBase: LibraryBase = (key) => {
    if (this.libBaseCache.has(key)) return this.libBaseCache.get(key);
    this.miss(`b:${key}`, () => this.fetchLibraryBase(key));
    return undefined;
  };

  private fetchLibraryBase(key: string): Promise<ClassRef | null | 'unread'> {
    return this.fetch(`b:${key}`, this.libBaseCache, key, async () => {
      const base = await this.adapter.getLibraryBase!(key);
      return base === undefined ? 'unread' : base;
    });
  }

  classify(ref: ClassRef, usage: UsageContext): Classification {
    const key = `${ref.key}|${usage.staticAccess ? 's' : ''}${usage.injectedAsAbstraction ? 'i' : ''}${usage.containerSingleton ? 'd' : ''}|${ref.kind}`;
    const cached = this.classifyCache.get(key);
    if (cached) return cached;
    let known = !hasClassInfo(ref.key) || this.classInfoCache.has(ref.key);
    let c = this.classifier.classify(ref, this.classInfo(ref.key), usage);
    // FR-7.13 nothing declared a layer: the whole file's facts decide (stable — not what the diagram analysed so far)
    if (!c.layer && c.layerReason?.rule === 'none' && this.adapter.getModuleFacts && hasClassInfo(ref.key)) {
      const facts = this.factsCache.get(ref.key);
      if (facts === undefined && !this.factsCache.has(ref.key)) {
        this.miss(`f:${ref.key}`, () => this.fetchModuleFacts(ref.key));
        known = false;
      } else if (facts) {
        c = withEvidence(c, facts);
      }
    }
    // FR-7.14 / FR-7.15 (the chain of its base classes is fetched as it goes)
    const folder = modelFolderRules(c, ref.key, (k) => this.classInfo(k), this.adapter.getLibraryBase && this.libraryBase);
    if (folder) c = folder;
    else known = false;
    const data = dataMark(c, ref.key, (k) => this.classInfo(k), (k) => this.classInfoCache.has(k));
    if (data) c = data;
    else known = false;
    // a classification made without the class info / file facts (still being fetched) is provisional
    if (known) this.classifyCache.set(key, c);
    return c;
  }

  /** The classifier's answer with FR-7.14 / FR-7.15 applied from cached class infos only (nothing fetched). */
  peekClassify(ref: ClassRef): Classification {
    let c = this.classifier.classify(ref, this.peekClassInfo(ref.key));
    c = modelFolderRules(c, ref.key, (k) => this.peekClassInfo(k), this.adapter.getLibraryBase && this.peekLibraryBase) ?? c;
    // a class info not fetched yet: no mark until it is
    return dataMark(c, ref.key, (k) => this.peekClassInfo(k), () => true)!;
  }

  // ───────────── asynchronous fetches (fill the cache) ─────────────

  fetchOutgoing(method: MethodRef): Promise<CallSite[]> {
    this.setOwner(method);
    return this.fetch(`o:${method.key}`, this.outgoingCache, method.key, () => this.adapter.getOutgoingCalls(method));
  }

  fetchImplementations(method: MethodRef): Promise<MethodRef[]> {
    return this.fetch(`i:${method.key}`, this.implCache, method.key, () => this.adapter.getImplementations(method));
  }

  fetchParameterNames(method: MethodRef): Promise<string[]> {
    const get = this.adapter.getParameterNames?.bind(this.adapter);
    if (!get) return Promise.resolve([]);
    return this.fetch(`p:${method.key}`, this.paramCache, method.key, () => get(method));
  }

  /** Cached module facts without requesting them (undefined when not fetched or unknown). */
  peekModuleFacts(classKey: string): ModuleFacts | undefined {
    return this.factsCache.get(classKey);
  }

  /** FR-7.7: undefined when the adapter cannot tell. */
  fetchModuleFacts(classKey: string): Promise<ModuleFacts | undefined> {
    const get = this.adapter.getModuleFacts?.bind(this.adapter);
    if (!get || classKey.startsWith('lib:') || !classKey.includes('#')) return Promise.resolve(undefined);
    return this.fetch(`f:${classKey}`, this.factsCache, classKey, () => get(classKey));
  }

  // only asked by a miss, which is recorded only when the adapter has the method
  /** FR-1.15 / FR-3.9 early exits of a body, cached. */
  fetchEarlyExits(method: MethodRef): Promise<EarlyExit[]> {
    if (!this.adapter.getEarlyExits) return Promise.resolve([]);
    return this.fetch(`x:${method.key}`, this.exitCache, method.key, () => this.adapter.getEarlyExits!(method));
  }

  private fetchReturns(method: MethodRef): Promise<ReturnFact[]> {
    return this.fetch(`r:${method.key}`, this.returnCache, method.key, () => this.adapter.getReturns!(method));
  }

  private fetchTypeUses(method: MethodRef): Promise<TypeUse[]> {
    return this.fetch(`u:${method.key}`, this.typeUseCache, method.key, () => this.adapter.getTypeUses!(method));
  }

  fetchClassInfo(classKey: string): Promise<ClassInfo | undefined> {
    if (!hasClassInfo(classKey)) return Promise.resolve(undefined);
    return this.fetch(`c:${classKey}`, this.classInfoCache, classKey, () => this.adapter.getClassInfo(classKey));
  }

  clear(): void {
    this.generation++;
    this.knownFromInfos.clear();
    this.knownFromCalls.clear();
    this.knownList = undefined;
    this.outgoingCache.clear();
    this.implCache.clear();
    this.classInfoCache.clear();
    this.classifyCache.clear();
    this.paramCache.clear();
    this.typeUseCache.clear();
    this.exitCache.clear();
    this.returnCache.clear();
    this.factsCache.clear();
    this.libBaseCache.clear();
    this.methodOwner.clear();
    this.methodsOfClass.clear();
    this.inflight.clear();
    this.misses.clear();
  }

  private miss(slot: string, fetch: () => Promise<unknown>): void {
    if (!this.misses.has(slot)) this.misses.set(slot, fetch);
  }

  private fetch<V>(slot: string, cache: Map<string, V>, key: string, request: () => Promise<V>): Promise<V> {
    if (cache.has(key)) return Promise.resolve(cache.get(key) as V);
    const running = this.inflight.get(slot) as Promise<V> | undefined;
    if (running) return running;
    const generation = this.generation;
    const promise = request().then(
      (value) => {
        if (generation === this.generation) {
          cache.set(key, value);
          this.noteRefs(cache as Map<string, unknown>, value);
          this.inflight.delete(slot);
        }
        return value;
      },
      (e: unknown) => {
        if (generation === this.generation) this.inflight.delete(slot);
        throw e;
      },
    );
    this.inflight.set(slot, promise);
    return promise;
  }
}

/** Unknown and library classes have no class info. */
function hasClassInfo(classKey: string): boolean {
  return classKey !== 'unknown' && !classKey.startsWith('lib:');
}

/** FR-7.14 Domain only because of a role folder (`Models/`, `entities/`): an Active Record model there gets no layer. */
function isModelFolderDomain(c: Classification): boolean {
  return c.layer === 'Domain' && c.layerReason?.rule === 'role-folder';
}

/**
 * FR-7.14 a class in Domain only because of a model folder that is an Active Record model gets no layer. Undefined
 * while a class info of its base classes is not known yet.
 */
function modelFolderRules(c: Classification, classKey: string, info: (key: string) => ClassInfo | undefined, libraryBase?: LibraryBase): Classification | undefined {
  if (!isModelFolderDomain(c)) return c;
  const ar = activeRecordBase(classKey, info, libraryBase);
  if (ar === undefined) return undefined;
  return ar ? withModelNote(c, ar) : c;
}

/**
 * FR-7.15 a class whose code only holds data carries «data», in whatever layer it is: a mark, not a layer. Its layer
 * stays — a class that only holds data can still be a domain entity (an anemic one), so the code alone cannot tell a
 * DTO from an entity. `fetched`: its class info was asked for (an absent one is no data). Undefined while a class info
 * up its base classes is not known yet.
 */
function dataMark(c: Classification, classKey: string, info: (key: string) => ClassInfo | undefined, fetched: (key: string) => boolean): Classification | undefined {
  if (!hasClassInfo(classKey) || c.stereotypes.includes('data')) return c;
  const data = isDataOnly(classKey, (k) => info(k) ?? (fetched(k) ? NO_INFO : undefined));
  if (data === undefined) return undefined;
  if (!data) return c;
  const reason = { stereotype: 'data', text: 'only holds data: fields, getters and setters, a constructor that only stores values' };
  return { ...c, stereotypes: [...c.stereotypes, 'data'], stereotypeReasons: [...(c.stereotypeReasons ?? []), reason] };
}

/** A class without class info: not data (nothing known about its code). */
const NO_INFO = { dataOnly: false } as unknown as ClassInfo;

/**
 * FR-7.15 its own code and that of its project base classes only hold data. A library base class's code is not read:
 * whether it has behaviour is unknown, so the class is not taken as data. Undefined while a class info is not known.
 */
export function isDataOnly(classKey: string, info: (key: string) => ClassInfo | undefined): boolean | undefined {
  let key: string | undefined = classKey;
  for (let depth = 0; depth < 8 && key; depth++) {
    if (key === 'unknown' || key.startsWith('lib:')) return false;
    const at = info(key);
    if (!at) return undefined;
    if (!at.dataOnly) return false;
    key = at.extends?.key;
  }
  return !key;
}

/**
 * FR-7.14 an Active Record model holds its data and its database access in one class: no layer of its own (Domain
 * would hide the database, Infrastructure would make every service using it a violation). Said on the card as a note.
 */
function withModelNote(c: Classification, ar: ActiveRecordBase | UnreadBase): Classification {
  const r = c.layerReason!;
  // a role-folder decision names its folder
  const folder = r.folders![0];
  const via = ar.via ? `\`${ar.via.name}\` → … ` : '';
  if ('unread' in ar) {
    // the package is not readable: the folder rule stands, with what could not be checked
    const note = `extends ${via}\`${ar.unread.name}\` of a package that could not be read: whether it is an Active Record model (no layer of its own) is unknown`;
    return { ...c, layerReason: { ...r, noted: [...(r.noted ?? []), note] } };
  }
  const note = `role folder \`${folder}/\` names Domain, but it is an Active Record model (extends ${via}\`${ar.base.name}\`): data and database access in one class, no layer of its own`;
  return { ...c, layer: undefined, layerReason: { ...r, rule: 'none', text: 'no rule applies', strength: 'weak', notApplied: [...r.notApplied, note], noted: [...(r.noted ?? []), note] } };
}

/**
 * FR-7.13 the layer the code shows when no rule, folder or name declared one: a UI component (renders JSX) →
 * Presentation, else I/O libraries (axios, a database driver, the file system, …) → Infrastructure. Weak.
 */
function withEvidence(c: Classification, facts: ModuleFacts): Classification {
  const io = facts.libraries.filter((l) => isIoLibrary(l));
  const decided = facts.jsx
    ? { layer: 'Presentation', text: 'the code: renders JSX (a UI component)' }
    : io.length
      ? { layer: 'Infrastructure', text: `the code: does I/O (uses ${io.slice(0, 3).join(', ')})` }
      : undefined;
  if (!decided) return c;
  // called for a `none` layer reason only (it is set)
  const before = c.layerReason!.notApplied;
  return { ...c, layer: decided.layer, layerReason: { ...c.layerReason, rule: 'evidence', text: decided.text, strength: 'weak', notApplied: before } };
}
