import type { ClassRef, SideEffectKind, StereotypeReason } from '@seqcall/protocol';
import type { ClassInfo, ModuleFacts } from './adapter';
import { libraryIo, SIDE_EFFECT_LABEL } from './side-effects';

/**
 * FR-7.10 «adapter» and «port» from evidence, not names (hexagonal architecture):
 *
 * - **adapter**: a concrete class that implements a project interface / extends a project abstract class
 *   **and** does I/O itself (its whole file uses a database / HTTP / file / queue / cloud / process library,
 *   FR-17.2) or through its project base classes (`ParcelApiClient : BaseHttpClient` with the HttpClient), or
 *   **delegates** it: holds (field / constructor parameter) a concrete project class that does I/O, up to two
 *   levels (`ApiProductsRepository implements ProductRepositoryPort` → `ShopApiClient` → `fetch`;
 *   a caching wrapper → the real client). A held port (interface / abstract class) is no delegate: the
 *   application core reaches I/O through ports too, an adapter through a concrete client.
 * - **port**: a project interface that such an adapter implements, or an abstract class it extends that does
 *   no I/O itself (a base class holding the HttpClient is implementation, not a boundary).
 *
 * «seam» stays what it is — how a diagram reaches an object (through an injected abstraction); a seam's
 * implementation without I/O (a policy, a pure service) is no adapter, an I/O client used directly (no
 * interface in front of it) is no adapter either. Test code never counts (implementations exclude tests).
 */
export interface RoleEvidenceInput {
  /** Classes to judge: the diagram's concrete classes and the implementations its polymorphic calls know. */
  candidates: Iterable<string>;
  classInfo(classKey: string): ClassInfo | undefined;
  moduleFacts(classKey: string): ModuleFacts | undefined;
}

const isProjectAbstraction = (t: ClassRef) => t.key.includes('#') && !t.key.startsWith('lib:') && (t.kind === 'interface' || t.kind === 'abstract');

/** The project base classes of a class, nearest first (at most 4). */
export function projectBases(classInfo: (key: string) => ClassInfo | undefined, key: string): ClassRef[] {
  const out: ClassRef[] = [];
  for (let base = classInfo(key)?.extends; base && out.length < 4; base = classInfo(base.key)?.extends) {
    if (!base.key.includes('#') || base.key.startsWith('lib:') || out.some((b) => b.key === base!.key)) break;
    out.push(base);
  }
  return out;
}

/** Levels of held concrete classes followed for a delegating adapter (the client, the client's client). */
export const MAX_DELEGATE_DEPTH = 2;

const isProjectClass = (t: ClassRef | undefined): t is ClassRef => !!t && t.kind === 'class' && t.key.includes('#') && !t.key.startsWith('lib:');

/** The concrete project classes a class holds: field and constructor parameter types (not itself, not ports). */
export function heldClasses(info: ClassInfo | undefined): ClassRef[] {
  const out = new Map<string, ClassRef>();
  for (const t of [...(info?.fields ?? []).filter((f) => !f.isStatic).map((f) => f.type), ...(info?.constructorParams ?? []).map((p) => p.type)]) {
    if (isProjectClass(t) && t.key !== info!.ref.key) out.set(t.key, t);
  }
  return [...out.values()];
}

/** The I/O of a class's own file, else of its nearest project base class that does I/O. */
function ioWithBases(input: RoleEvidenceInput, key: string): { kinds: SideEffectKind[]; via?: string } | undefined {
  const own = libraryIo(input.moduleFacts(key)?.libraries ?? []);
  if (own) return { kinds: own.kinds };
  for (const base of projectBases(input.classInfo, key)) {
    const io = libraryIo(input.moduleFacts(base.key)?.libraries ?? []);
    if (io) return { kinds: io.kinds, via: base.name };
  }
  return undefined;
}

/** I/O a class delegates: the first held concrete class (breadth first, MAX_DELEGATE_DEPTH levels) that does I/O. */
function ioThroughHeld(input: RoleEvidenceInput, key: string): { kinds: SideEffectKind[]; path: string[] } | undefined {
  const seen = new Set([key]);
  let level: { key: string; path: string[] }[] = [{ key, path: [] }];
  for (let depth = 0; depth < MAX_DELEGATE_DEPTH && level.length; depth++) {
    const next: typeof level = [];
    for (const { key: k, path } of level) {
      for (const held of heldClasses(input.classInfo(k))) {
        if (seen.has(held.key)) continue;
        seen.add(held.key);
        const io = ioWithBases(input, held.key);
        if (io) return { kinds: io.kinds, path: [...path, held.name] };
        next.push({ key: held.key, path: [...path, held.name] });
      }
    }
    level = next;
  }
  return undefined;
}

/** class key → the evidence-based stereotypes it gets («adapter» for implementations, «port» for abstractions). */
export function portsAndAdapters(input: RoleEvidenceInput): Map<string, StereotypeReason[]> {
  const out = new Map<string, StereotypeReason[]>();
  const adaptersOf = new Map<string, { names: string[]; port: ClassRef }>();
  for (const key of new Set(input.candidates)) {
    const info = input.classInfo(key);
    if (!info || info.ref.kind !== 'class') continue;
    const abstractions = [...info.implements, ...(info.extends ? [info.extends] : [])]
      .filter(isProjectAbstraction)
      .filter((a) => a.kind === 'interface' || !libraryIo(input.moduleFacts(a.key)?.libraries ?? []));
    if (!abstractions.length) continue;
    const found = ioWithBases(input, key);
    const delegated = found ? undefined : ioThroughHeld(input, key);
    if (!found && !delegated) continue;
    const kinds = (found ?? delegated)!.kinds.map((k) => SIDE_EFFECT_LABEL[k]).join(', ');
    const where = delegated ? ` through ${delegated.path.map((n) => `\`${n}\``).join(' → ')}` : found!.via ? ` through its base \`${found!.via}\`` : ' itself';
    out.set(key, [{ stereotype: 'adapter', text: `implements ${abstractions.map((a) => `\`${a.name}\``).join(', ')} and does ${kinds}${where}` }]);
    for (const a of abstractions) {
      const entry = adaptersOf.get(a.key) ?? { names: [], port: a };
      entry.names.push(`${info.ref.name} (${kinds})`);
      adaptersOf.set(a.key, entry);
    }
  }
  for (const [key, { names }] of adaptersOf) {
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')}, +${names.length - 3}` : names.join(', ');
    out.set(key, [...(out.get(key) ?? []), { stereotype: 'port', text: `an adapter implements it: ${list}` }]);
  }
  return out;
}

/** Adds evidence-based stereotypes to a box (replacing a weaker name / folder reason for the same stereotype). */
export function applyRoles(target: { stereotypes: string[]; stereotypeReasons?: StereotypeReason[] }, roles: StereotypeReason[] | undefined): void {
  for (const r of roles ?? []) {
    if (!target.stereotypes.includes(r.stereotype)) target.stereotypes.push(r.stereotype);
    const reasons = (target.stereotypeReasons ??= []);
    const at = reasons.findIndex((x) => x.stereotype === r.stereotype);
    if (at >= 0) reasons[at] = r;
    else reasons.push(r);
  }
}
