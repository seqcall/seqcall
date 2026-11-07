/**
 * FR-8.6 what the DI container gives for an abstraction, for the application(s) the diagram's code runs in.
 * Later registrations win, except fallbacks (C# `TryAdd…`, Autofac `PreserveExistingDefaults`), which only fill a gap.
 * With several hosts (a solution of eight executables sharing libraries), a registration counts only for the hosts that
 * run it, and a binding is chosen only when every host the code can run in binds the same class — otherwise the
 * choice stays with the user, as without bindings. Keyed / conditional registrations are never chosen (the key or
 * the condition decides at run time); they are listed. A generic abstraction registered per type argument
 * (`INotifier<Shipment>` → A, `INotifier<Refund>` → B) is one service per argument: a call whose
 * receiver type has those arguments gets its own registration.
 */
import type { SourceRange } from '@seqcall/protocol';
import type { ContainerBinding } from '../adapter';

export interface Bound {
  classKey: string;
  at: SourceRange;
  contextual: boolean;
}

export interface KeyedBinding {
  classKey: string;
  key: string;
  at: SourceRange;
  kind?: 'key' | 'condition';
}

export interface BindingLookup {
  /** `typeArgs`: class keys of the call's type arguments (FR-5.9), to tell apart a generic abstraction's registrations. */
  bound(consumerKey: string | undefined, abstractKey: string, typeArgs?: string[]): Bound | undefined;
  keyed(abstractKey: string): KeyedBinding[] | undefined;
  /**
   * FR-6.7 `singleton` / `scoped` when the container makes one object of this class (in one scope): exactly one
   * registration has it as its implementation, with that lifetime. Two registrations (`IA` and `IB` → X) are two
   * objects; no lifetime known, transient or not registered: undefined.
   */
  lifetime(classKey: string): 'singleton' | 'scoped' | undefined;
}

export function bindingLookup(bindings: ContainerBinding[], hosts?: string[]): BindingLookup {
  const plain = new Map<string, ContainerBinding[]>();
  const keyed = new Map<string, ContainerBinding[]>();
  for (const b of bindings) {
    if (b.key !== undefined) keyed.set(b.abstract, [...(keyed.get(b.abstract) ?? []), b]);
    else {
      const k = `${b.consumer ?? '*'}|${b.abstract}`;
      plain.set(k, [...(plain.get(k) ?? []), b]);
    }
  }
  const runsIn = (b: ContainerBinding, host: string) => !b.hosts || b.hosts.includes(host);
  /** The registration in effect, in `host` (undefined: all of them). */
  const effective = (bs: ContainerBinding[], host?: string): ContainerBinding | undefined => {
    let current: ContainerBinding | undefined;
    for (const b of bs) {
      if (host !== undefined && !runsIn(b, host)) continue;
      if (b.fallback && current) continue;
      current = b;
    }
    return current;
  };
  // the registrations for these type arguments; without them (a constructor parameter, an open generic) all of them
  const forArgs = (bs: ContainerBinding[], args?: string[]): ContainerBinding[] => {
    if (!args?.length || !bs.some((b) => b.abstractArgs?.length)) return bs;
    const same = (b: ContainerBinding) => !!b.abstractArgs?.length && b.abstractArgs.length <= args.length && b.abstractArgs.every((a, i) => a === args[args.length - b.abstractArgs!.length + i]);
    const exact = bs.filter(same);
    return exact.length ? exact : bs.filter((b) => !b.abstractArgs?.length);
  };
  const pick = (k: string, args?: string[]): ContainerBinding | undefined => {
    const all = plain.get(k);
    if (!all) return undefined;
    const bs = forArgs(all, args);
    if (!bs.length) return undefined;
    if (!hosts?.length) return effective(bs);
    const per = hosts.map((h) => effective(bs, h));
    if (per.some((b) => !b) || new Set(per.map((b) => b!.concrete)).size > 1) return undefined;
    return per[0];
  };
  return {
    bound(consumer, abstract, typeArgs) {
      const contextual = consumer ? pick(`${consumer}|${abstract}`, typeArgs) : undefined;
      const b = contextual ?? pick(`*|${abstract}`, typeArgs);
      return b && { classKey: b.concrete, at: b.range, contextual: !!contextual };
    },
    lifetime(classKey) {
      const regs = bindings.filter((b) => b.concrete === classKey && (!hosts?.length || hosts.some((h) => runsIn(b, h))));
      const life = regs.length === 1 ? regs[0].lifetime : undefined;
      return life === 'singleton' || life === 'scoped' ? life : undefined;
    },
    keyed(abstract) {
      const bs = (keyed.get(abstract) ?? []).filter((b) => !hosts?.length || hosts.some((h) => runsIn(b, h)));
      return bs.length ? bs.map((b) => ({ classKey: b.concrete, key: b.key!, at: b.range, ...(b.keyKind ? { kind: b.keyKind } : {}) })) : undefined;
    },
  };
}
