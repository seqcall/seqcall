import { FSD_LABEL } from './classifier-impl';
import type { ClassRef, LayerHint } from '@seqcall/protocol';
import type { CallSite, ClassInfo } from './adapter';
import type { Classification } from './classifier';
import { ioKindOf, isCheckCall } from './side-effects';

export { isIoLibrary } from './side-effects';

/**
 * Layer suggestions (hints only, never a reclassification) from data the session already has:
 * class info, the already analysed calls of the class, and the layers of the types it uses.
 * A hint is produced only when the evidence clearly disagrees with the assigned layer:
 *
 * - Infrastructure: the class does I/O (HTTP, database, files, messaging, cloud SDKs).
 * - Application: a class placed in Domain depends on or calls ports/services.
 * - Domain: a class placed in Application without injected dependencies, I/O, or calls to
 *   ports/services, that is used by Domain classes of the current diagram and depends on nothing
 *   outside Domain itself (e.g. enums shared by domain rules), or that works with domain types
 *   (e.g. a static scheduling-rules utility). The class's own nested types are no evidence.
 */
export interface LayerHintInput {
  ref: ClassRef;
  layer?: string;
  info?: ClassInfo;
  /** Calls made by the class's already analysed methods. */
  calls: CallSite[];
  /** FR-7.13 a UI component (renders JSX): its I/O is a smell to see (the I/O badge), not a reason to move it. */
  component?: boolean;
  analysedMethods: number;
  classify(ref: ClassRef): Classification;
  /** Simple class name → class ref, for type names found in method signatures. */
  typeByName: Map<string, ClassRef>;
  /** FR-12.12: project types the class's already analysed methods reference (cached type uses). */
  typeUses?: ClassRef[];
  /** Names of the Domain classes of the current diagram that call or use this class. */
  usedByDomain?: string[];
  /**
   * FR-7.7 judged over the whole file / type: pure = takes no ports, does no I/O and depends only on
   * Domain or other pure code. Absent when the adapter cannot tell (then only the evidence above counts).
   */
  purity?: Purity;
  /** FR-19 an Active Record model (Eloquent …): its I/O is by design — no hint, as "I/O in Domain" exempts it. */
  activeRecord?: boolean;
}

export interface Purity {
  pure: boolean;
  reasons: string[];
}

const TECHNICAL_NAME = /(Util|Utils|Utility|Utilities|Helper|Helpers|Extensions|Constants)$/i;
const TECHNICAL_FOLDERS = new Set(['util', 'utils', 'utility', 'utilities', 'helper', 'helpers', 'common', 'shared', 'extensions']);
/** FR-7.11 DTOs: data shapes for crossing a boundary — pure, yet not domain code. */
const DTO_NAME = /(Dto|DTO|Request|Response|Resource)$/;
const DTO_FOLDERS = new Set(['dto', 'dtos', 'data', 'requests', 'responses', 'resources']);

/** FR-7.11 a DTO by name or folder: never suggested for Domain (Domain using one is the dependency to fix). */
export function isDto(ref: ClassRef): boolean {
  if (DTO_NAME.test(ref.name)) return true;
  const dir = ref.key.slice(0, ref.key.indexOf('#')).split('/').slice(0, -1);
  return dir.some((seg) => DTO_FOLDERS.has(seg.toLowerCase()));
}

/** Utilities / helpers / extensions / constants by name or folder. */
export function isTechnical(ref: ClassRef): boolean {
  if (TECHNICAL_NAME.test(ref.name)) return true;
  const dir = ref.key.slice(0, ref.key.indexOf('#')).split('/').slice(0, -1);
  return dir.some((seg) => TECHNICAL_FOLDERS.has(seg.toLowerCase()));
}

/** Framework / primitive type names that say nothing about the domain (C#, TypeScript). */
const NEUTRAL_TYPES = new Set(
  ('string String int long short byte bool boolean Boolean decimal double float number Number object Object void any unknown never ' +
    'DateTime DateTimeOffset DateOnly TimeOnly TimeSpan Guid Uri Exception Task ValueTask IAsyncEnumerable CancellationToken ' +
    'List IList IReadOnlyList ICollection IReadOnlyCollection IEnumerable Dictionary IDictionary IReadOnlyDictionary HashSet ISet ' +
    'Func Action Predicate Nullable Tuple ValueTuple KeyValuePair Lazy Span Memory Array T TKey TValue TResult ' +
    'Promise Map Set Record Partial Readonly ReadonlyArray Date RegExp Error Iterable AsyncIterable Buffer JSON Math').split(' '),
);

const SERVICE_LIKE = new Set(['service', 'repository', 'controller', 'client', 'adapter', 'gateway', 'port', 'seam']);

const short = (key: string) => key.slice(key.lastIndexOf('#') + 1);

function isIo(key: string | undefined, libraryName?: string): boolean {
  return !!key && (ioKindOf(key) !== undefined || (!!libraryName && ioKindOf(`lib:${libraryName}`) !== undefined));
}

export function suggestLayer(input: LayerHintInput): LayerHint | undefined {
  const hint = fromEvidence(input);
  if (hint?.suggested === 'Infrastructure') {
    // ⚑ must not contradict ⚠ ("I/O in Domain" exempts Active Record models)
    if (input.activeRecord) return undefined;
    // FR-7.11 a model / ui file of an FSD slice doing I/O: the call belongs in an api/ segment, the file stays where it is
    if (fsdPlaced(input)) return { ...hint, advice: 'in FSD, backend calls belong in an `api/` segment', noMove: true };
    // a controller doing I/O stays a controller: the call is what moves
    if (isController(input)) return { ...hint, advice: 'a controller doing I/O: move the call into a service or repository', noMove: true };
  }
  if (hint?.suggested !== 'Domain') return hint;
  // FR-7.11 a DTO is pure, yet no domain code: Domain using it is the dependency to fix, not its place
  if (isDto(input.ref)) return undefined;
  // FR-7.11 placed by the FSD preset: a slice's model / ui follows FSD's segments — a page's model is page state,
  // however pure (its entities are FSD's Domain already)
  return fsdPlaced(input) ? undefined : hint;
}

/** An inbound adapter (controller, Presentation): it never moves to Infrastructure for its I/O. */
function isController(input: LayerHintInput): boolean {
  return input.layer === 'Presentation' || input.classify(input.ref).stereotypes.includes('controller');
}

/** FR-7.11 the Feature-Sliced Design preset placed the class (its segment decided). */
function fsdPlaced(input: LayerHintInput): boolean {
  const reason = input.classify(input.ref).layerReason;
  return reason?.rule === 'preset' && reason.text.startsWith(`${FSD_LABEL} preset`);
}

function fromEvidence(input: LayerHintInput): LayerHint | undefined {
  const { ref, layer, info, calls } = input;
  if (ref.kind === 'interface' || ref.kind === 'external' || ref.kind === 'unknown') return undefined;

  // I/O evidence: library calls/receivers, and injected or field types.
  const io = new Set<string>();
  for (const c of calls) {
    if (!c.isLibrary || isCheckCall(c)) continue;
    const key = c.target?.key ?? c.receiverType?.key;
    // either test needs a key: `key` is set when one holds
    if (isIo(key, c.libraryName) || isIo(c.receiverType?.key, c.libraryName)) io.add(short(key!));
    else if (c.libraryName === 'lib' && c.methodName === 'fetch') io.add('fetch');
  }
  for (const t of [...(info?.fields ?? []).map((f) => f.type), ...(info?.constructorParams ?? []).map((p) => p.type)]) {
    if (t && t.key.startsWith('lib:') && isIo(t.key)) io.add(t.name);
  }
  if (io.size) {
    return layer === 'Infrastructure' || input.component ? undefined : { suggested: 'Infrastructure', reasons: [`does I/O: ${[...io].slice(0, 3).join(', ')}`] };
  }

  // Dependencies on services/ports (project types only).
  // Services/ports outside the Domain layer; abstractions inside Domain (strategies, policies,
  // specifications) are domain-internal and don't make a class "application".
  const isServiceLike = (t: ClassRef) => {
    if (t.key.startsWith('lib:') || t.key === ref.key) return false;
    const c = input.classify(t);
    if (c.layer === 'Domain') return false;
    return t.kind === 'interface' || t.kind === 'abstract' || c.stereotypes.some((s) => SERVICE_LIKE.has(s));
  };
  const injected = (info?.fields ?? []).filter((f) => f.injected && f.type && isServiceLike(f.type)).map((f) => f.type!.name);
  const ctorDeps = (info?.constructorParams ?? []).filter((p) => p.type && isServiceLike(p.type)).map((p) => p.type!.name);
  const calledPorts = calls.filter((c) => !c.isLibrary && c.receiver.kind !== 'self' && c.target && isServiceLike(c.target.owner)).map((c) => `${c.target!.owner.name}.${c.methodName}`);
  const deps = [...new Set([...injected, ...ctorDeps])];

  if (layer === 'Domain') {
    if (!deps.length && !calledPorts.length) return undefined;
    const reasons = [];
    if (deps.length) reasons.push(`depends on ${deps.slice(0, 3).join(', ')}`);
    if (calledPorts.length) reasons.push(`calls ${[...new Set(calledPorts)].slice(0, 3).join(', ')}`);
    return { suggested: 'Application', reasons };
  }

  if (layer === 'Application' && input.purity) {
    // FR-7.7: the whole file decides — a partial view of the analysed calls must not
    if (!input.purity.pure) return undefined;
    const users = input.usedByDomain ?? [];
    // pure technical code (utilities, helpers, extensions, constants) is not domain code by itself
    if (isTechnical(ref) && !users.length) return undefined;
    const usedBy = users.length ? [`used by Domain: ${users.slice(0, 3).join(', ')}${users.length > 3 ? ` (+${users.length - 3})` : ''}`] : [];
    return { suggested: 'Domain', reasons: [...usedBy, ...input.purity.reasons] };
  }

  if (layer === 'Application' && !deps.length && !calledPorts.length) {
    // the class's own nested types (C# `Enums.ProviderStatus`) say nothing about its layer
    const nested = new Set(info?.nestedTypes ?? []);
    const isOwn = (t: ClassRef) => t.key === ref.key || t.key.startsWith(`${ref.key}.`);
    const used = new Map<string, ClassRef>();
    const add = (t?: ClassRef) => t && !t.key.startsWith('lib:') && !isOwn(t) && used.set(t.key, t);
    for (const f of info?.fields ?? []) add(f.type);
    for (const p of info?.constructorParams ?? []) add(p.type);
    for (const c of calls) if (!c.isLibrary) add(c.target?.owner ?? c.receiverType);
    for (const t of input.typeUses ?? []) add(t);
    const classified = () => [...used.values()].map((t) => ({ t, layer: input.classify(t).layer, stereo: input.classify(t).stereotypes }));
    const isForeign = (x: { layer?: string; stereo: string[] }) => (!!x.layer && x.layer !== 'Domain') || x.stereo.some((st) => SERVICE_LIKE.has(st));

    // Used by Domain classes and depending on nothing outside Domain: it belongs to Domain.
    const users = input.usedByDomain ?? [];
    if (users.length && !classified().some(isForeign)) {
      const more = users.length > 3 ? ` (+${users.length - 3})` : '';
      return {
        suggested: 'Domain',
        reasons: [`used by Domain: ${users.slice(0, 3).join(', ')}${more}`, 'no dependencies on Application or outer layers', 'no I/O'],
      };
    }

    // Needs evidence of behaviour (analysed code or an all-static utility) and of domain types.
    if (!input.analysedMethods && !info?.allMembersStatic) return undefined;
    // Type names in signatures: resolved ones are checked by layer; unresolved, non-framework
    // names (not seen elsewhere in this session) count as candidate domain types.
    const unresolved = new Set<string>();
    for (const m of info?.methods ?? []) {
      // parameters and return type only (the text before "(" is the method name)
      const types = m.signature.slice(Math.max(0, m.signature.indexOf('(')));
      for (const name of types.match(/\b[A-Z]\w*/g) ?? []) {
        if (NEUTRAL_TYPES.has(name) || name === ref.name || nested.has(name)) continue;
        const known = input.typeByName.get(name);
        if (known) add(known);
        else unresolved.add(name);
      }
    }
    const layers = classified();
    const domain = [...layers.filter((x) => x.layer === 'Domain').map((x) => x.t.name), ...unresolved];
    const foreign = layers.filter(isForeign);
    if (!domain.length || foreign.length) return undefined;
    return {
      suggested: 'Domain',
      reasons: ['no injected dependencies', 'no I/O and no calls to services or ports', `works with domain types: ${domain.slice(0, 3).join(', ')}`],
    };
  }
  return undefined;
}
