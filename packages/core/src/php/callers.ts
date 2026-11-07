import type { CallerInfo, MethodRef } from '@seqcall/protocol';
import { nameOf, rangeOf } from './ast';
import type { PNode } from './ast';
import { accessorAttribute, attributeNeedles } from './accessors';
import { allCallsIn, attributeAccessesIn, type ResolvedCall } from './calls';
import type { Callable, PhpModel } from './model';
import type { PhpFile } from './project';

const lower = (s: string) => s.toLowerCase();
/** A file's text in lower case, once per parse (a file holds many callables; FR-31 searches thousands of methods). */
const lowered = new WeakMap<PhpFile, string>();
const lowerSrc = (f: PhpFile): string => {
  let text = lowered.get(f);
  if (text === undefined) lowered.set(f, (text = lower(f.src)));
  return text;
};

/**
 * The calls of a name found over the project, per name (and constructor class): a search for one method serves the
 * next of the same name (FR-31 searches thousands of methods; a Laravel app has hundreds named `handle`). Kept by the
 * adapter until a file changes.
 */
export type CallsByName = Map<string, { c: Callable; node: PNode; resolved: ResolvedCall; passed: boolean }[]>;

/**
 * FR-8 implementations: for an interface / abstract method, the project classes deriving from
 * its class whose effective method has a body; for a concrete method, the overrides in
 * subclasses. Test files are left out.
 */
export function findImplementations(model: PhpModel, method: MethodRef, isTest: (rel: string) => boolean): MethodRef[] {
  const decl = model.callableByKey(method.key);
  if (!decl?.cls) return [];
  const owner = decl.cls;
  // an interface of a first-party package: its implementations may be anywhere in that package (FR-18.9)
  model.project.loadPackageOf(owner.file);
  const name = lower(nameOf(decl.node));
  const abstractLike = !method.hasBody;
  const out = new Map<string, MethodRef>();
  for (const c of model.project.subtypesOf(owner.fqn)) {
    if (c.kind === 'interface' || c.isAbstract || c.kind === 'trait' || isTest(c.file.rel)) continue;
    if (abstractLike) {
      const found = model.types.findMethod(c.fqn, name);
      // (an interface method has no body: php-parser never reads one there)
      if (found?.node?.body) {
        const ref = model.methodRef(found.owner, found.node);
        out.set(ref.key, ref);
      }
    } else {
      const own = c.methods.get(name);
      if (own?.body) {
        const ref = model.methodRef(c, own);
        out.set(ref.key, ref);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * FR-4.1 callers: calls (and FR-4.5 first-class callables `$this->m(...)`) whose resolved target is
 * the method, or a declaration it implements / overrides (a call through the interface reaches
 * the implementation too). Files are pre-filtered by the method name.
 */
export function findCallers(model: PhpModel, method: MethodRef, isTest: (rel: string) => boolean, memo?: CallsByName): CallerInfo[] {
  const decl = model.callableByKey(method.key);
  if (!decl) return [];
  const name = method.name;
  // a constructor is called by `new <Class>`: files that name the class
  const needle = lower(decl.cls && name === 'constructor' ? decl.cls.name : name);
  // keys that count: the method itself and the methods it implements / overrides (a constructor overrides none:
  // `new Parent()` never runs the child's; constructors are declared as `__construct`, the lookup by name misses them)
  const keys = new Set([method.key]);
  // a project method implementing a package's interface (or overriding a package method) is called from package code
  // through it: `resolve(Settings::class)->read()` in the package reaches the project's class bound to it
  let viaPackage = false;
  if (decl.cls) {
    for (const a of model.project.ancestors(decl.cls.fqn)) {
      const m = a.methods.get(lower(name));
      if (m && a !== decl.cls) {
        keys.add(model.methodRef(a, m).key);
        viaPackage ||= !!a.file.vendor;
      }
    }
  }
  const out: CallerInfo[] = [];
  // a method of a first-party package is called from that package (and others) too, not only from the project
  const packages = !!decl.file.vendor || viaPackage;
  if (packages) model.project.loadFirstPartyPackages();
  // (a generator: one per walk)
  const callables = () => (packages ? model.callablesIn(model.project.allFiles()) : model.allCallables());
  // a trait the class uses calls the class's methods on `$this` (even when other classes use the trait too)
  const traits = new Set(decl.cls ? model.project.ancestors(decl.cls.fqn).filter((a) => a.kind === 'trait') : []);
  // (the name is looked for once per file, not once per method of it)
  const named = new Map<PhpFile, boolean>();
  const names = (f: PhpFile) => named.get(f) ?? named.set(f, lowerSrc(f).includes(needle)).get(f)!;
  const scan = () =>
    [...callables()].flatMap((c) => {
      if (!names(c.file)) return [];
      const asClass = c.cls && traits.has(c.cls) ? decl.cls : undefined;
      return allCallsIn(model, c, name, asClass).map((call) => ({ c, ...call }));
    });
  // shared by the methods of one name (those with package callers apart); not when a trait the class uses resolves
  // `$this` as the class, nor for a package method itself
  const memoKey = `${packages ? 'pkg:' : ''}${lower(name)}:${needle}`;
  const found = memo && !traits.size && !decl.file.vendor ? (memo.get(memoKey) ?? memo.set(memoKey, scan()).get(memoKey)!) : scan();
  // FR-18.15 an Eloquent accessor / mutator is run by reading / assigning its attribute (`$order->loyalty_points`)
  const attribute = decl.cls && accessorAttribute(model, decl.cls, decl.node)?.attribute;
  // (not into `found`: that list is shared by the methods of one name)
  const accesses: typeof found = [];
  if (attribute) {
    const needles = attributeNeedles(attribute);
    for (const c of callables()) {
      if (!needles.some((n) => lowerSrc(c.file).includes(n))) continue;
      const asClass = c.cls && traits.has(c.cls) ? decl.cls : undefined;
      accesses.push(...attributeAccessesIn(model, c, attribute, asClass).map((a) => ({ c, ...a })));
    }
  }
  for (const { c, node, resolved, passed } of [...found, ...accesses]) {
    const target = resolved.target;
    if (!target || !keys.has(target.key)) continue;
    // through an interface: only when the receiver may be this class (not a sibling implementation)
    const range = rangeOf(c.file.abs, node);
    const line = c.file.src.split('\n')[range.start.line];
    out.push({
      id: `${c.file.rel}:${range.start.line}:${range.start.character}`,
      enclosing: model.refOfCallable(c),
      range,
      preview: line.trim().slice(0, 160),
      ...(isTest(c.file.rel) ? { inTest: true } : {}),
      ...(passed ? { passed: true } : {}),
    });
  }
  return out.sort((a, b) => Number(!!a.inTest) - Number(!!b.inTest) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

