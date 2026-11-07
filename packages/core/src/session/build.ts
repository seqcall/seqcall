import type {
  ClassRef,
  EntryPoint,
  ExitMarker,
  DiagramOptions,
  ErrorPathFold,
  Fragment,
  HideFilter,
  HiddenFilterInfo,
  Message,
  MethodRef,
  Participant,
  ParticipantGroup,
  PolymorphicInfo,
  RouteMiddleware,
  SourceRange,
} from '@seqcall/protocol';
import type { ArgumentFunction, ArgumentOrigin, ArgumentType, CallSite, EarlyExit, FragmentScope, ReceiverOrigin, ReturnFact, ReturnValue } from '../adapter';
import type { Classifier, UsageContext } from '../classifier';
import type { AnalysisCache } from './cache';
import { buildFragments, isSwallowed, outcomeText, type ScopedChild } from './fragments';
import { holdsOnMainPath, offPathOperands, onlyBuildsFailure } from '../main-path';
import { trailingIdentifier } from '../text';
import picomatch from 'picomatch';

/** Exploration state of one root (one history entry). */
export interface ViewState {
  root: MethodRef;
  /** Expanded message ids (the root found message is always expanded). */
  expanded: Set<string>;
  /** Per-message implementation choice: class key, or null = explicitly "back to interface". */
  choices: Map<string, string | null>;
  /** FR-1.12: ids of minimized combined fragments. */
  collapsedFragments?: Set<string>;
  /** FR-1.22: followed cases — fragment id of an `alt` → the operand (case) drawn. */
  followedCases?: Map<string, number>;
  /** FR-3.11: error branches shown again after Smart folded them (`<owner>#<construct>#<operand>`). */
  shownErrorPaths?: Set<string>;
  /** FR-3.6: a smart expand ran in this view: messages carry their importance (low ones dimmed). */
  smart?: boolean;
  /** FR-16.3: the entry point this view was opened from (its root is that entry point's method). */
  entry?: EntryPoint;
}

export interface BuildInput {
  state: ViewState;
  cache: AnalysisCache;
  classifier: Classifier;
  filters: HideFilter[];
  options: DiagramOptions;
  /** Remembered implementation per interface/abstract class key (FR-8.4). */
  interfaceChoices: Map<string, string>;
  /** FR-8.7 draw the DI container building the root's object graph first (the root is an entry point). */
  containerStep?: boolean;
  /** FR-8.6 the container's implementation of `abstractKey` for `consumerKey` (contextual first, then global). */
  boundImplementation?: (consumerKey: string | undefined, abstractKey: string, typeArgs?: string[]) => { classKey: string; at: SourceRange; contextual: boolean } | undefined;
  /** FR-6.7 the container makes one object of this class (in one scope): its lifetime, else undefined. */
  serviceLifetime?: (classKey: string) => 'singleton' | 'scoped' | undefined;
  /** FR-8.6 keyed registrations of an abstraction (C#): shown in the implementation list, never chosen. */
  keyedImplementations?: (abstractKey: string) => { classKey: string; key: string; at: SourceRange; kind?: 'key' | 'condition' }[] | undefined;
  /** FR-18.14 the middleware the request passes before the root (an HTTP entry point), already filtered by the config. */
  pipeline?: RouteMiddleware[];
  autoSelectSingleImplementation: boolean;
  maxMessages: number;
}

/** Per-message analysis result kept by the session (callers, expand-all, reroot). */
export interface BuiltNode {
  id: string;
  depth: number;
  call?: CallSite;
  /** Declared target (may be an interface/abstract member). */
  declared?: MethodRef;
  /** Target actually expanded: the selected implementation or the declared target. */
  effective?: MethodRef;
  /** FR-1.11 an invoked closure (`$request()`): its body's calls, drawn below it when expanded (no target method). */
  lambdaCalls?: CallSite[];
  implementations?: MethodRef[];
  participantId: string;
  expandable: boolean;
  expanded: boolean;
  /** FR-11.7 a "don't expand" rule matches: Expand all / Smart expand leave it folded. */
  noExpand?: boolean;
}

export interface ParticipantMeta {
  ref: ClassRef;
  origin?: ReceiverOrigin;
  /** Class of the participant that first reached this one (for field-based associations). */
  senderClassKey?: string;
}

export interface BuildResult {
  messages: Message[];
  participants: Participant[];
  groups: ParticipantGroup[];
  hiddenFilters: HiddenFilterInfo[];
  nodes: Map<string, BuiltNode>;
  participantMeta: Map<string, ParticipantMeta>;
  /** Combined fragments of the visible messages (FR-1.10), outer before inner, in message order. */
  fragments: Fragment[];
  /** FR-1.15 early exits of the drawn activations (only with fragments on). */
  exits: ExitMarker[];
  /** FR-3.12 calls left out because ↯ folded their error branch: message id → the branch's key (`shownErrorPaths`). */
  foldedCalls: Map<string, string>;
  /** FR-3.12 built with ↯ Fold errors (the review's base flow is built the same way). */
  foldErrors: boolean;
}

interface PInfo {
  id: string;
  ref: ClassRef;
  instanceName?: string;
  usage: UsageContext;
  createdByMessageId?: string;
  implementsInterface?: { key: string; name: string };
  origin?: ReceiverOrigin;
  senderClassKey?: string;
  order: number;
  isClassLevel: boolean;
  /** FR-5.6 objects created in mutually exclusive places that share this lifeline. */
  alternatives?: number;
  /** FR-5.10 interchangeable objects (no state of their own) created in several places, drawn on this one lifeline. */
  instances?: number;
  /** FR-5.12 why: values (absent: FR-5.10 interchangeable). */
  instancesWhy?: 'value' | 'helper';
  /** FR-6.7 the lifelines of one container-made object (or of a class that keeps its only instance), joined. */
  service?: 'singleton' | 'scoped' | 'own';
  /** FR-6.7 the names its references have (fields, parameters), when they differ. */
  heldAs?: string[];
  /** FR-6.7 the references reaching it through an injected interface, when only some do (no «seam» then). */
  seamVia?: string[];
  /** «seam»: the interface / abstract class it was injected as. */
  seamType?: string;
}

const UNKNOWN_REF: ClassRef = { key: 'unknown', name: 'unknown', kind: 'unknown' };

/** FR-1.19 why a call's target is unknown, in words for the hover card. */
function unresolvedReason(call: CallSite): string {
  if (call.untypedReceiver) {
    return `\`${call.untypedReceiver}\` is typed any, so what it calls cannot be known. Give it a type — or, when it is a parameter, open the flow from a caller that passes a typed value: Seqcall follows the argument.`;
  }
  // the reason in the words of the call's language (a PHP call never needs node_modules)
  const file = call.range.file.toLowerCase();
  const missing = file.endsWith('.php')
    ? 'a library that is not installed (vendor/ — run composer install), a property or variable whose type is not declared (set from the container, `app()->make(…)`), or a dynamic call'
    : file.endsWith('.cs')
      ? 'a library whose packages are not restored (run dotnet restore), or a dynamic call'
      : 'a library that is not installed (node_modules), or a dynamic call';
  return `Its declaration was not found: ${missing}.`;
}

/**
 * Participant identity of an object reference, without its class (FR-6.5): the part of the
 * participant id after `<classKey>|`, e.g. `var:request`, `field:<classKey>.repo`, `new:<messageId>`.
 */
interface Binding {
  suffix: string;
  /** Receiver name for FR-6.2 naming. */
  name?: string;
}

/** One activation of a method: its parameters bound to the caller's participants, and its locals. */
interface Frame {
  params: Map<string, Binding>;
  locals: Map<string, Binding>;
  /** FR-1.13: function / delegate parameters bound to what the caller passed. */
  functions: Map<string, FunctionBinding>;
  /** FR-5.9 the classes the caller named for the method's type parameters (`TResponse` → `GetCouponsResponseDto`). */
  typeArgs?: Map<string, ClassRef>;
  /** FR-1.19 parameters declared `any` / `unknown`: the type of what the caller passed (`zodSchema` → zod's ZodObject). */
  paramTypes?: Map<string, ArgumentType>;
}

/** A function passed for a parameter; a method reference keeps its receiver as seen by the caller. */
interface FunctionBinding {
  fn: ArgumentFunction;
  receiver?: ReceiverOrigin;
  binding?: Binding;
  /** FR-19.18 a method reference: the id of the call that handed it over (passed on: that first call). */
  handedBy?: string;
  /** FR-1.11: a lambda runs in the activation that wrote it — its object and its variables. */
  definedIn?: { frame: Frame; senderPid: string };
  /**
   * FR-18.14 a middleware's `$next`: the request goes on to the next step of the pipeline (the next middleware, then
   * the action) — drawn to that lifeline, never expanded here (the step below / the root shows it).
   */
  continues?: true;
}

const suffixOf = (participantId: string): string => participantId.slice(participantId.indexOf('|') + 1);

/** FR-1.23 the parameters among `functions` (those holding a function) a library (or unresolved) call is given. */
function handedOver(call: CallSite, functions: { has(name: string): boolean }): string[] {
  if (call.kind !== 'call' || (call.target && !call.isLibrary) || call.invokedParameter !== undefined) return [];
  return (call.argOrigins ?? []).flatMap((o, i) => (o?.kind === 'parameter' && !call.argFunctions?.[i] && functions.has(o.name) ? [o.name] : []));
}

/** FR-1.23 the callee's parameters this call fills with a function: one it writes or passes, or one passed on. */
function functionParameters(call: CallSite, names: string[], frame: Frame): Set<string> {
  return new Set(names.filter((n, i) => {
    const o = call.argOrigins?.[i];
    return n && (call.argFunctions?.[i] || (o?.kind === 'parameter' && frame.functions.has(o.name)));
  }));
}

/**
 * FR-1.23 a function parameter handed to a library (or unresolved) call — `->then($work)`, `p.then(cb)` — is run by
 * it: drawn right after that call as the invocation of the parameter (FR-1.13), so the closure the caller wrote shows
 * its calls. Its own arguments come from the library: none are bound. Message id `<ordinal>:<parameter>`.
 */
function handedToLibrary(call: CallSite, frame: Frame): CallSite[] {
  // PHP names an invoked parameter as written: `$work`
  const php = call.range.file.endsWith('.php');
  return handedOver(call, frame.functions).map((name) => ({
    ordinal: call.ordinal,
    kind: 'call' as const,
    range: call.range,
    methodName: php ? `$${name}` : name,
    expressionText: call.expressionText,
    args: [],
    isLibrary: false,
    isAsync: false,
    receiver: { kind: 'none' as const },
    invokedParameter: name,
    ...(call.fragments ? { fragments: call.fragments } : {}),
  }));
}

/** Builds the filtered, labelled and grouped diagram content for a view state. */
export function buildDiagram(input: BuildInput): BuildResult {
  const { state, cache, options } = input;
  // FR-11.7 "don't expand" rules keep their calls drawn; only the others hide
  const filters = input.filters.filter((f) => !f.noExpand);
  const stops = input.filters.filter((f) => f.noExpand);
  // FR-11.8 the stereotypes a «category» rule looks at (the classifier's with «data» FR-7.15, once per class)
  const stereotypeMemo = new Map<string, string[]>();
  const stereotypesOf = (ref: ClassRef): string[] => {
    let st = stereotypeMemo.get(ref.key);
    if (!st) stereotypeMemo.set(ref.key, (st = cache.peekClassify(ref).stereotypes));
    return st;
  };
  const messages: Message[] = [];
  const nodes = new Map<string, BuiltNode>();
  const pinfos = new Map<string, PInfo>();
  // every filter counts from 0 (each lookup below finds its entry)
  const hiddenCounts = new Map<string, number>(input.filters.map((f) => [f.id, 0]));

  const ensureParticipant = (id: string, init: () => Omit<PInfo, 'id' | 'order'>): string => {
    if (!pinfos.has(id)) pinfos.set(id, { id, order: pinfos.size, ...init() });
    return id;
  };

  // ── root ──
  const root = state.root;
  const rootSynthetic = cache.isSynthetic(root.owner.key);
  const rootPid = ensureParticipant(rootIdentity(root, rootSynthetic), () => ({
    ref: root.owner,
    usage: { staticAccess: root.isStatic && root.owner.kind !== 'module' },
    isClassLevel: root.isStatic || root.owner.kind === 'module' || rootSynthetic,
  }));
  let makesScope = false;
  /** Objects created into fields: `<classKey>.<field>` → created participant (FR-6.5). */
  const fieldBindings = new Map<string, Binding>();

  /** FR-11 a framework step (FR-8.7 container, FR-18.14 pipeline) is hidden like any call: by its class or its method's name. */
  const stepHiddenBy = (ref: ClassRef, method: string) =>
    filters.find((f) =>
      f.kind === 'class' ? f.classKey === ref.key : f.kind === 'classPattern' || f.kind === 'stereotype' ? classInCategory(f, ref.name, stereotypesOf(ref)) : f.methodName === method && (f.kind === 'methodName' || f.classKey === ref.key),
    );

  // ── FR-8.7 before an entry point runs, the DI container builds its object graph (collapsed until opened) ──
  if (input.containerStep && input.boundImplementation && !root.isStatic && root.owner.kind === 'class') {
    const plan = containerPlan(cache, root.owner, input.boundImplementation);
    const container = containerOf(root.owner.key);
    // FR-11 hidden like any call: by the container's class or the method's name
    const hiddenBy = stepHiddenBy(container.ref, container.method);
    if (hiddenBy && plan.length > 1) hiddenCounts.set(hiddenBy.id, hiddenCounts.get(hiddenBy.id)! + 1);
    if (plan.length > 1 && !hiddenBy) {
      const containerPid = `${container.ref.key}|container`;
      pinfos.set(containerPid, { id: containerPid, order: -1, ref: container.ref, usage: {}, isClassLevel: true });
      const expanded = state.expanded.has('container');
      messages.push({
        id: 'container',
        parentId: null,
        depth: 0,
        kind: 'found',
        from: null,
        to: containerPid,
        methodName: container.method,
        classKey: container.ref.key,
        className: container.ref.name,
        args: [container.arg(root.owner.name)],
        ...(root.owner.declaration ? { callSite: root.owner.declaration } : {}),
        isAsync: false,
        isLibrary: false,
        expandable: true,
        expanded,
        recursive: false,
      });
      nodes.set('container', { id: 'container', depth: 0, participantId: containerPid, expandable: true, expanded });
      if (expanded) {
        plan.forEach((step, i) => {
          const id = `container/${i}:constructor`;
          // the same participant the flow reaches later through that field (FR-6.5 identity): its head starts here
          const pid = step.consumer ? `${step.ref.key}|field:${step.consumer}.${step.param}` : rootPid;
          // new only for a dependency (the root object is drawn already): it has its consumer and field
          if (!pinfos.has(pid)) {
            pinfos.set(pid, { id: pid, order: pinfos.size, ref: step.ref, usage: {}, isClassLevel: false, instanceName: step.param, origin: { kind: 'field' as const, name: step.param! }, senderClassKey: step.consumer });
          }
          pinfos.get(pid)!.createdByMessageId = id;
          messages.push({
            id,
            parentId: 'container',
            depth: 1,
            kind: 'create',
            from: containerPid,
            to: pid,
            methodName: 'constructor',
            classKey: step.ref.key,
            className: step.ref.name,
            args: [],
            ...(step.param ? { result: { kind: 'assign' as const, target: step.param, operator: '=' } } : {}),
            // clicking it opens where the container is told to give this class (else the class)
            ...((step.bound?.at ?? step.ref.declaration) ? { callSite: step.bound?.at ?? step.ref.declaration } : {}),
            isAsync: false,
            isLibrary: false,
            expandable: false,
            expanded: false,
            recursive: false,
          });
          nodes.set(id, { id, depth: 1, participantId: pid, expandable: false, expanded: false });
        });
      }
    }
  }

  messages.push({
    id: 'root',
    parentId: null,
    depth: 0,
    kind: 'found',
    from: null,
    to: rootPid,
    methodName: root.name,
    methodKey: root.key,
    classKey: root.owner.key,
    className: root.owner.name,
    args: [],
    callSite: root.declaration,
    ...(root.declaration ? { targetDeclaration: root.declaration } : {}),
    isAsync: false,
    isLibrary: false,
    expandable: root.hasBody,
    expanded: root.hasBody,
    recursive: false,
  });
  nodes.set('root', {
    id: 'root',
    depth: 0,
    declared: root,
    effective: root,
    participantId: rootPid,
    expandable: root.hasBody,
    expanded: root.hasBody,
  });

  const fragments: Fragment[] = [];
  const showFragments = options.showFragments !== false;
  const off0 = showFragments && options.foldErrors !== false;
  /**
   * Whether a body has a call that expanding would draw: not a hidden library call, not hidden by
   * a filter (judged on the declared target — implementations are only resolved on expansion).
   */
  const hasVisibleCalls = (method: MethodRef, functions?: Set<string>): boolean => hasVisibleCallsIn(cache.outgoing(method), functions);
  /** `functions`: the parameters holding a function — handed to a library call, it runs there (FR-1.23). */
  const hasVisibleCallsIn = (calls: CallSite[], functions?: Set<string>): boolean =>
    calls.some((c) => {
      if (functions?.size && handedOver(c, functions).length) return true;
      if (c.isLibrary && !options.showLibraryCalls) return false;
      const ref = c.target?.owner ?? UNKNOWN_REF;
      return !filters.some((f) => matchesFilter(f, c, c.target, c.target, ref, stereotypesOf));
    });
  const exits: ExitMarker[] = [];
  const foldedCalls = new Map<string, string>();
  /** FR-5.6 each activation's early `return` / `throw` statements (nothing after one of them runs). */
  const exitsByActivation = new Map<string, EarlyExit[]>();
  /** FR-5.8 each expanded activation's `return` statements (absent: the adapter cannot tell). */
  const returnsByActivation = new Map<string, ReturnFact[]>();
  const walk = (parentId: string, depth: number, ownCalls: CallSite[], senderPid: string, path: string[], frame: Frame, bodyExits: EarlyExit[] = []): void => {
    const calls = ownCalls.flatMap((c) => [c, ...handedToLibrary(c, frame)]);
    if (bodyExits.length) exitsByActivation.set(parentId, bodyExits);
    const visibleChildren: ScopedChild[] = [];
    /** Adapter construct id → stable id: kind, nesting and ordinal of the construct's first call. */
    const stableIds = new Map<string, string>();
    for (const raw of calls) {
      raw.fragments?.forEach((s, nesting) => {
        if (!stableIds.has(s.id)) stableIds.set(s.id, `${s.kind}${nesting}@${raw.ordinal}`);
      });
    }
    const stable = (scopes: FragmentScope[] | undefined, fallback: string) =>
      scopes?.map((s, nesting) => {
        let sid = stableIds.get(s.id);
        if (!sid) stableIds.set(s.id, (sid = `${s.kind}${nesting}@${fallback}`));
        return { ...s, id: sid };
      });
    /** FR-1.12: minimized fragments of this owner → folded call count. */
    const folded = new Map<string, number>();
    const isFolded = (scopes: FragmentScope[] | undefined) =>
      !!state.collapsedFragments?.size && (scopes ?? []).some((s) => state.collapsedFragments!.has(`${parentId}#${s.id}`));
    // FR-1.22 a followed case: the other cases of its alt are left out (their count is on the frame)
    const followedHere = new Map<string, number>();
    for (const [fid, c] of state.followedCases ?? []) if (showFragments && fid.startsWith(`${parentId}#`) && !fid.slice(parentId.length + 1).includes('#')) followedHere.set(fid, c);
    const otherCases = new Map<string, Set<number>>();
    const otherCase = (scopes: FragmentScope[] | undefined) =>
      followedHere.size ? scopes?.find((s) => followedHere.has(`${parentId}#${s.id}`) && followedHere.get(`${parentId}#${s.id}`) !== s.operand) : undefined;
    // FR-3.11 / FR-3.12 with ↯ Fold errors, the error branches of the body fold into a short trace: the exit marker of a branch that
    // throws / returns, the row of a catch, else a branch marker of its own (`⤷ [guard]`)
    const off = off0 ? offPathOperands(calls, bodyExits, (c) => onlyBuildsFailure(cache.outgoing(c.target!))) : undefined;
    const exitOperands = new Set(bodyExits.flatMap((e) => (e.fragments?.length ? [`${e.fragments.at(-1)!.id}#${e.fragments.at(-1)!.operand}`] : [])));
    const errorFolds = new Map<string, ErrorPathFold>();
    const isShown = (s: FragmentScope) => state.shownErrorPaths?.has(`${parentId}#${stableIds.get(s.id)}#${s.operand}`) ?? false;
    const errorBranch = (raw: FragmentScope[] | undefined, scopes: FragmentScope[] | undefined) => {
      if (!off?.size) return undefined;
      for (let i = 0; i < (raw ?? []).length; i++) {
        const s = raw![i];
        const reason = off.get(`${s.id}#${s.operand}`);
        const key = `${parentId}#${scopes![i].id}#${s.operand}`;
        if (!reason || state.shownErrorPaths?.has(key)) continue;
        const trace = s.kind === 'try' ? (heldTries.has(s.id) ? 'branch' : 'catch') : exitOperands.has(`${s.id}#${s.operand}`) ? 'exit' : 'branch';
        return { key, reason, trace, depth: i, range: s.range };
      }
      return undefined;
    };
    const foldInto = (err: { key: string; reason: string }) => {
      const fold = errorFolds.get(err.key);
      errorFolds.set(err.key, { key: err.key, calls: (fold?.calls ?? 0) + 1, reason: err.reason });
    };
    // an alt whose other branches all folded: on the main path its condition just holds — no frame around the rest
    const operandsOf = new Map<string, Set<number>>();
    const holds = new Map<string, number>();
    for (const f of [...calls.flatMap((c) => c.fragments ?? []), ...bodyExits.flatMap((e) => e.fragments ?? [])]) {
      if (f.kind === 'alt') (operandsOf.get(f.id) ?? operandsOf.set(f.id, new Set()).get(f.id)!).add(f.operand);
      // so does a success check — unless it returns from inside: then what follows is the failure, and the frame says so
      else if (off && holdsOnMainPath(f) && !exitOperands.has(`${f.id}#${f.operand}`)) holds.set(f.id, f.operand);
    }
    for (const [id, ops] of operandsOf) {
      const kept = [...ops].filter((o) => !off?.has(`${id}#${o}`) || isShown({ id, operand: o } as FragmentScope));
      if (ops.size > 1 && kept.length === 1 && stableIds.has(id)) holds.set(id, kept[0]);
    }
    // so does a try whose catches all folded: its block is the main path; each catch becomes a marker after it, saying what
    // it does with the error (a clause that only rethrows, without calls, hides nothing: no marker)
    const heldTries = new Map<string, FragmentScope[]>();
    const place = (p: { line: number; character: number }) => p.line * 1e6 + p.character;
    const catchCalls = new Set(calls.flatMap((c) => (c.fragments ?? []).filter((f) => f.kind === 'try' && f.operand > 0).map((f) => `${f.id}#${f.operand}`)));
    if (off) {
      for (const c of calls) {
        c.fragments?.forEach((f, i) => {
          if (f.kind !== 'try' || heldTries.has(f.id)) return;
          const catches = [...(f.handlers ?? []).map((h) => h.operand), ...[...catchCalls].filter((k) => k.startsWith(`${f.id}#`)).map((k) => Number(k.slice(k.lastIndexOf('#') + 1)))];
          if (!catches.some((o) => isShown({ id: f.id, operand: o } as FragmentScope))) heldTries.set(f.id, c.fragments!.slice(0, i + 1));
        });
      }
      for (const id of heldTries.keys()) holds.set(id, 0);
    }
    const pendingCatches = [...heldTries.values()]
      .flatMap((chain) => (chain.at(-1)!.handlers ?? []).filter((h) => h.range && (h.outcome !== 'rethrow' || catchCalls.has(`${chain.at(-1)!.id}#${h.operand}`))).map((h) => ({ h, chain })))
      .sort((a, b) => place(a.h.range!.start) - place(b.h.range!.start));
    let nextCatch = 0;
    const catchesBefore = (pos?: { line: number; character: number }) => {
      for (; nextCatch < pendingCatches.length; nextCatch++) {
        const { h, chain } = pendingCatches[nextCatch];
        const at = h.range!.start;
        if (pos && place(at) > place(pos)) return;
        const raw = [...chain.slice(0, -1), { ...chain.at(-1)!, operand: h.operand, guard: h.guard }];
        const scopes = stable(raw, `c${nextCatch}`)!;
        if (isFolded(scopes) || otherCase(scopes)) continue;
        const marker = {
          id: `${parentId}!branch${branches++}`, ownerMessageId: parentId, kind: 'branch' as const, range: h.range!, scopes, errorKey: `${parentId}#${scopes.at(-1)!.id}#${h.operand}`,
          ...(h.outcome !== 'rethrow' ? { outcome: outcomeText(h), ...(isSwallowed(h) ? { swallowed: true } : {}) } : {}),
        };
        ownExits.push(marker);
        visibleChildren.push({ id: marker.id, scopes });
      }
    };
    const drawnScopes = (raw: FragmentScope[] | undefined, scopes: FragmentScope[] | undefined) =>
      holds.size && scopes ? scopes.filter((_, i) => holds.get(raw![i].id) !== raw![i].operand) : scopes;
    let branches = 0;
    const branchMarker = (err: { key: string; depth: number; range?: SourceRange }, at: SourceRange, scopes: FragmentScope[]) => {
      if (errorFolds.has(err.key) || ownExits.some((x) => x.errorKey === err.key)) return;
      const marker = { id: `${parentId}!branch${branches++}`, ownerMessageId: parentId, kind: 'branch' as const, range: err.range ?? at, scopes: scopes.slice(0, err.depth + 1), errorKey: err.key };
      ownExits.push(marker);
      visibleChildren.push({ id: marker.id, scopes: marker.scopes });
    };
    // FR-1.15: early exits join the children in source order (inside a minimized fragment they are folded)
    const ownExits: (ExitMarker & { scopes?: FragmentScope[]; errorKey?: string })[] = [];
    let nextExit = 0;
    const exitsBefore = (pos?: { line: number; character: number }) => {
      for (; nextExit < bodyExits.length; nextExit++) {
        const e = bodyExits[nextExit];
        if (pos && !(e.range.end.line < pos.line || (e.range.end.line === pos.line && e.range.end.character <= pos.character))) return;
        const scopes = stable(e.fragments, `x${nextExit}`);
        const err = errorBranch(e.fragments, scopes);
        if (isFolded(scopes) || otherCase(scopes)) continue;
        // an exit deeper inside a folded branch: the branch's marker stands for it
        if (err && err.trace !== 'exit' && err.trace !== 'catch') {
          branchMarker(err, e.range, scopes!);
          continue;
        }
        const shown = drawnScopes(e.fragments, scopes);
        const marker = { id: `${parentId}!exit${nextExit}`, ownerMessageId: parentId, kind: e.kind, range: e.range, ...(e.exception ? { exception: e.exception } : {}), scopes: shown, ...(err?.trace === 'exit' ? { errorKey: err.key } : {}) };
        ownExits.push(marker);
        visibleChildren.push({ id: marker.id, scopes: shown });
      }
    };
    for (const raw of calls) {
      if (messages.length >= input.maxMessages) break;
      if (showFragments) {
        catchesBefore(raw.range.start);
        exitsBefore(raw.range.start);
      }
      const scopes = stable(raw.fragments, String(raw.ordinal));
      // FR-1.13: invoking a function parameter runs what the caller passed (a method reference)
      const passed = raw.invokedParameter !== undefined ? frame.functions.get(raw.invokedParameter) : undefined;
      const bound = passed?.fn.kind === 'method' ? passed : undefined;
      const base: CallSite = bound && bound.fn.kind === 'method'
        ? {
            ...raw,
            methodName: bound.fn.target.name,
            target: bound.fn.target,
            receiver: bound.receiver!,
            receiverType: bound.fn.receiverType,
            isLibrary: bound.fn.isLibrary,
            libraryName: bound.fn.libraryName,
          }
        : raw;
      // FR-5.9 `new TResponse { … }`: the class the caller named for it, else its constraint
      const generic = raw.kind === 'create' && raw.typeParameter && !raw.target ? (frame.typeArgs?.get(raw.typeParameter) ?? raw.receiverType) : undefined;
      // FR-1.19 a call on a parameter declared `any`: the type the caller passed for it (a library type → a library call)
      const passedType = !raw.target && raw.kind === 'call' && raw.receiver.kind === 'parameter' ? frame.paramTypes?.get(raw.receiver.name) : undefined;
      const call: CallSite = generic
        ? { ...base, receiverType: generic, target: { key: `${generic.key}.constructor`, name: 'constructor', owner: generic, isStatic: false, hasBody: false }, isLibrary: generic.key.startsWith('lib:') }
        : passedType
          ? {
              ...base,
              receiverType: passedType.type,
              target: { key: `${passedType.type.key}.${raw.methodName}`, name: raw.methodName, owner: passedType.type, isStatic: false, hasBody: false },
              isLibrary: passedType.isLibrary,
              ...(passedType.libraryName ? { libraryName: passedType.libraryName } : {}),
              untypedReceiver: undefined,
            }
          : base;
      const unboundDelegate = (raw.invokedParameter !== undefined && !bound) || !!raw.invokesResult;
      // FR-1.11: a lambda passed by the caller — drawn back to the object that wrote it, its body below
      const lambda = passed?.fn.kind === 'lambda' && passed.fn.calls && passed.definedIn ? { ...passed.fn, ...passed.definedIn, calls: passed.fn.calls } : undefined;
      const lambdaKey = lambda ? `λ:${lambda.range.file}:${lambda.range.start.line}:${lambda.range.start.character}` : undefined;
      // FR-6.7 a flow that makes a DI scope (hidden as a library call, or not)
      if (/^Create(?:Async)?Scope$/.test(call.methodName)) makesScope = true;
      if (call.isLibrary && !options.showLibraryCalls) continue;
      const id = `${parentId}/${raw.ordinal}:${raw.methodName}`;
      const declared = unboundDelegate ? undefined : call.target;
      const sender = pinfos.get(senderPid)!;

      /** FR-6.5: the participant an object reference stands for in this activation. */
      const bindingOf = (origin: ArgumentOrigin | Extract<ReceiverOrigin, { kind: ArgumentOrigin['kind'] }>): Binding => {
        switch (origin.kind) {
          case 'parameter':
            return frame.params.get(origin.name) ?? { suffix: `var:${origin.name}`, name: origin.name };
          case 'local':
            return frame.locals.get(origin.name) ?? { suffix: `var:${origin.name}`, name: origin.name };
          case 'field':
            return fieldBindings.get(`${sender.ref.key}.${origin.name}`) ??
              { suffix: `field:${sender.ref.key}.${origin.name}`, name: origin.name };
          case 'self':
            return { suffix: suffixOf(sender.id), name: sender.instanceName };
          case 'created':
            return { suffix: `new:${parentId}/${origin.ordinal}:constructor` };
        }
      };
      const receiverBinding = bound ? bound.binding : call.kind === 'call' &&
        (call.receiver.kind === 'parameter' || call.receiver.kind === 'local' || call.receiver.kind === 'field' || call.receiver.kind === 'created')
        ? bindingOf(call.receiver)
        : undefined;
      if (call.kind === 'create' && call.assignedTo && !call.isLibrary) {
        const b: Binding = { suffix: `new:${id}`, name: call.assignedTo.name };
        if (call.assignedTo.kind === 'local') frame.locals.set(call.assignedTo.name, b);
        else fieldBindings.set(`${sender.ref.key}.${call.assignedTo.name}`, b);
      }

      // polymorphism (FR-8)
      let effective = declared;
      let polymorphic: PolymorphicInfo | undefined;
      let implementations: MethodRef[] | undefined;
      if (declared && !declared.hasBody && !call.isLibrary && call.kind === 'call' && !bound?.continues) {
        implementations = cache.implementations(declared);
        if (implementations.length > 0) {
          // a receiver bound to an object created in the diagram has a known concrete class
          const created = receiverBinding?.suffix.startsWith('new:')
            ? [...pinfos.values()].find((p) => p.id.endsWith(`|${receiverBinding.suffix}`))?.ref.key
            : undefined;
          // `this.m()` / `$this->m()` on an abstract method: the object is the sender itself, its class decides
          const own = call.receiver.kind === 'self' ? sender.ref.key : undefined;
          // FR-8.6 the DI container decides: an injected field gets what the container binds for the sender's class
          const typeArgs = call.typeArguments?.flatMap((a) => (a.type ? [a.type.key] : []));
          const bound = input.boundImplementation?.(call.receiver.kind === 'field' ? sender.ref.key : undefined, declared.owner.key, typeArgs);
          // a bound class that inherits the method (`RetryingRequestSender extends RequestSender`):
          // the object is that class, the method its ancestor's implementation
          const inherited = bound && !implementations.some((i) => i.owner.key === bound.classKey) ? inheritedImplementation(cache, bound.classKey, implementations) : undefined;
          const boundHere = bound && (inherited || implementations.some((i) => i.owner.key === bound.classKey)) ? bound : undefined;
          const keyed = input.keyedImplementations?.(declared.owner.key)?.filter((k) => implementations!.some((i) => i.owner.key === k.classKey));
          const selectedKey = chooseImplementation(input, id, declared, implementations, created ?? own, boundHere?.classKey);
          const selected = implementations.find((i) => i.owner.key === selectedKey) ?? (inherited && selectedKey === boundHere?.classKey ? inherited.method : undefined);
          effective = selected;
          polymorphic = {
            interfaceKey: declared.owner.key,
            interfaceName: declared.owner.name,
            implementations: [...implementations.map((i) => i.owner), ...(inherited ? [inherited.object] : [])],
            selectedKey: selected ? (inherited && selected === inherited.method ? inherited.object.key : selected.owner.key) : undefined,
            ...(boundHere ? { bound: boundHere } : {}),
            ...(keyed?.length ? { keyed } : {}),
          };
        }
      } else if (declared?.hasBody && !call.isLibrary && call.kind === 'call' && call.receiver.kind === 'self' && sender.ref.key !== declared.owner.key) {
        // `$this->m()` in an inherited method: the object's class may override `m` (RetryingRequestSender::handleRequest)
        const override = cache.implementations(declared).find((i) => i.owner.key === sender.ref.key);
        if (override) effective = override;
      }

      // an unresolved delegate (a lambda, or the caller is not in the diagram) stays with its sender
      const writer = lambda && lambda.senderPid !== sender.id ? pinfos.get(lambda.senderPid) : undefined;
      const resolvedTarget: TargetParticipant = writer
        ? { id: writer.id, ref: writer.ref, selfCall: false }
        : unboundDelegate
        ? { id: sender.id, ref: sender.ref, selfCall: true }
        : resolveParticipant({ call, declared, effective, polymorphic, implementations, sender, messageId: id, binding: receiverBinding, cache });
      // FR-1.13: invoked through a typed port (`listBranches: BranchLister`): the sender depends on the
      // port, not on whatever interface the caller's expression happened to name (`Host.listBranches`)
      const port = bound && raw.invokedParameterType ? { key: raw.invokedParameterType.key, name: raw.invokedParameterType.name } : undefined;
      const target: TargetParticipant = port && !resolvedTarget.selfCall
        ? { ...resolvedTarget, implementsInterface: undefined, init: (c) => ({ ...resolvedTarget.init!(c), implementsInterface: undefined }) }
        : resolvedTarget;

      const hiddenBy = filters.find((f) => matchesFilter(f, call, declared, effective, target.ref, stereotypesOf));
      if (hiddenBy) {
        hiddenCounts.set(hiddenBy.id, hiddenCounts.get(hiddenBy.id)! + 1);
        continue;
      }
      const other = otherCase(scopes);
      if (other) {
        const fid = `${parentId}#${other.id}`;
        otherCases.set(fid, (otherCases.get(fid) ?? new Set()).add(other.operand));
        continue;
      }
      // FR-1.12: calls inside a minimized fragment are folded into its stub; FR-3.11 those of an error branch into its
      // trace (the outer of the two wins)
      const foldAt = showFragments && state.collapsedFragments?.size
        ? (scopes ?? []).findIndex((s) => state.collapsedFragments!.has(`${parentId}#${s.id}`))
        : -1;
      const err = errorBranch(raw.fragments, scopes);
      if (err && (foldAt < 0 || err.depth < foldAt)) {
        if (err.trace === 'branch') branchMarker(err, raw.range, scopes!);
        foldInto(err);
        foldedCalls.set(id, err.key);
        continue;
      }
      if (foldAt >= 0) {
        const fid = `${parentId}#${scopes![foldAt].id}`;
        if (!folded.has(fid)) visibleChildren.push({ id: fid, scopes: scopes!.slice(0, foldAt + 1) });
        folded.set(fid, (folded.get(fid) ?? 0) + 1);
        continue;
      }

      const to = target.selfCall ? senderPid : ensureParticipant(target.id, () => target.init!(cache));
      // FR-5.11 the object runs a method one of its project base classes declares (not a creation: the object's class is made)
      const inheritedFrom = !call.isLibrary && call.kind !== 'create' && effective ? inheritedOwner(cache, pinfos.get(to)!.ref, effective.owner) : undefined;
      // «seam» if any path reaching the participant is an injected behavioural abstraction
      const reached = pinfos.get(to)!;
      if (!target.selfCall && !reached.usage.injectedAsAbstraction && target.seam?.(cache)) {
        reached.usage = { ...reached.usage, injectedAsAbstraction: true };
        reached.seamType = target.seamType;
      }
      // a participant first reached directly, later as the chosen implementation of an interface
      if (!target.selfCall && target.implementsInterface && !reached.implementsInterface) reached.implementsInterface = target.implementsInterface;
      const continues = !!bound?.continues;
      const recursive = !continues && ((!!effective && path.includes(effective.key)) || (!!lambdaKey && path.includes(lambdaKey)));
      // FR-3.5: no ⊕ when expanding would show nothing (one level of look-ahead); an already
      // expanded call keeps its ⊖ (and its hidden-call counts) until the developer collapses it
      const expandable = continues
        ? false
        : lambda
        ? !recursive && (state.expanded.has(id) || hasVisibleCallsIn(lambda.calls, new Set(lambda.frame.functions.keys())))
        : !!effective && effective.hasBody && !call.isLibrary && !recursive &&
          (state.expanded.has(id) || hasVisibleCalls(effective, functionParameters(call, cache.parameterNames(effective), frame)));
      const expanded = expandable && state.expanded.has(id);
      const stoppedBy = stops.find((f) => matchesFilter(f, call, declared, effective, target.ref, stereotypesOf));
      if (stoppedBy) hiddenCounts.set(stoppedBy.id, hiddenCounts.get(stoppedBy.id)! + 1);
      const kind = call.kind === 'create' ? 'create' : to === senderPid ? 'self' : 'call';

      messages.push({
        id,
        parentId,
        depth: depth + 1,
        kind,
        from: senderPid,
        to,
        methodName: declared || unboundDelegate ? call.methodName : calleeText(call),
        ...(raw.invokedParameter !== undefined ? { viaParameter: raw.invokedParameter } : {}),
        ...(passed?.fn.kind === 'lambda' ? { viaLambda: true } : {}),
        ...(bound ? { handedBy: bound.handedBy } : {}),
        ...(call.fragments?.some((f) => f.kind === 'loop' && f.leavesLoop) ? { leavesLoop: true as const } : {}),
        ...(call.accessor ? { accessor: call.accessor } : {}),
        ...(call.render ? { render: true } : {}),
        ...(continues ? { continuesPipeline: true as const } : {}),
        ...(port ? { port } : {}),
        methodKey: (effective ?? declared)?.key,
        ...(!declared && !unboundDelegate && !lambda ? { unresolved: unresolvedReason(call) } : {}),
        classKey: declared?.owner.key ?? (unboundDelegate ? (writer ?? sender).ref.key : UNKNOWN_REF.key),
        className: call.isLibrary && call.kind === 'create' ? createdTypeName(call) : declared?.owner.name ?? (unboundDelegate ? (writer ?? sender).ref.name : UNKNOWN_REF.name),
        args: call.args,
        callSite: call.range,
        ...(lambda
          ? { targetDeclaration: lambda.range }
          : !call.isLibrary && (effective ?? declared)?.declaration ? { targetDeclaration: (effective ?? declared)!.declaration } : {}),
        isAsync: call.isAsync,
        isLibrary: call.isLibrary,
        ...(call.result ? { result: call.result } : {}),
        ...(call.returnType ? { returnType: call.returnType } : {}),
        expandable,
        expanded,
        recursive,
        polymorphic,
        ...(stoppedBy ? { noExpand: stoppedBy.id } : {}),
        ...(inheritedFrom ? { inheritedFrom: { key: inheritedFrom.key, name: inheritedFrom.name } } : {}),
      });
      visibleChildren.push({ id, scopes: drawnScopes(raw.fragments, scopes) });
      nodes.set(id, {
        id,
        depth: depth + 1,
        call,
        declared,
        effective,
        implementations,
        ...(lambda ? { lambdaCalls: lambda.calls } : {}),
        participantId: to,
        expandable,
        expanded,
        ...(stoppedBy ? { noExpand: true } : {}),
      });
      /** FR-6.5 / FR-1.13: the callee's parameters bound to the caller's arguments (participants, functions). */
      const bindArguments = (names: string[]) => {
        const params = new Map<string, Binding>();
        const functions = new Map<string, FunctionBinding>();
        const paramTypes = new Map<string, ArgumentType>();
        names.forEach((name, i) => {
          if (!name) return;
          const origin = call.argOrigins?.[i];
          const b = origin ? bindingOf(origin) : undefined;
          if (b) params.set(name, b);
          // FR-1.19 the type passed for an `any` parameter (or passed on from this activation's own)
          const t = call.argTypes?.[i] ?? (origin?.kind === 'parameter' ? frame.paramTypes?.get(origin.name) : undefined);
          if (t) paramTypes.set(name, t);
          // FR-1.13: functions passed for parameters, seen from this (the caller's) activation
          const fn = call.argFunctions?.[i];
          if (fn?.kind === 'method') {
            const r = fn.receiver;
            if (r.kind === 'self') functions.set(name, { fn, receiver: { kind: 'local', name: '' }, binding: bindingOf(r), handedBy: id });
            else if (r.kind === 'field' || r.kind === 'parameter' || r.kind === 'local') functions.set(name, { fn, receiver: r, binding: bindingOf(r), handedBy: id });
            else functions.set(name, { fn, receiver: r, handedBy: id });
          } else if (fn) {
            functions.set(name, { fn, definedIn: { frame, senderPid } });
          } else if (origin?.kind === 'parameter' && frame.functions.has(origin.name)) {
            functions.set(name, frame.functions.get(origin.name)!); // passed on
          }
        });
        return { params, functions, paramTypes };
      };
      if (expanded && lambda) {
        // the body sees the writer's variables plus its own parameters (bound to this invocation)
        const own = bindArguments(lambda.params ?? []);
        walk(id, depth + 1, lambda.calls, to, [...path, lambdaKey!], {
          typeArgs: lambda.frame.typeArgs,
          params: new Map([...lambda.frame.params, ...own.params]),
          locals: lambda.frame.locals,
          functions: new Map([...lambda.frame.functions, ...own.functions]),
          paramTypes: new Map([...(lambda.frame.paramTypes ?? []), ...own.paramTypes]),
        });
      } else if (expanded && effective) {
        const { params, functions, paramTypes } = bindArguments(cache.parameterNames(effective));
        const facts = cache.returns(effective);
        if (facts) returnsByActivation.set(id, facts);
        // FR-5.9 type arguments: named by this call, or this activation's own passed on
        const typeArgs = new Map<string, ClassRef>();
        for (const a of call.typeArguments ?? []) {
          const t = a.type ?? (a.parameter ? frame.typeArgs?.get(a.parameter) : undefined);
          if (t) typeArgs.set(a.name, t);
        }
        walk(id, depth + 1, cache.outgoing(effective), to, [...path, effective.key], { params, locals: new Map(), functions, typeArgs, paramTypes }, cache.earlyExits(effective));
      }
    }
    if (!showFragments) return;
    catchesBefore();
    exitsBefore();
    const exitIds = new Set(ownExits.map((e) => e.id));
    const followed = new Map([...followedHere.keys()].map((fid) => [fid, otherCases.get(fid)?.size ?? 0]));
    const own = buildFragments(parentId, visibleChildren, folded, exitIds, { followed, errorPaths: errorFolds });
    fragments.push(...own);
    const order = visibleChildren.map((c) => c.id);
    /** Frame id → the children its drawn operands span (a marker outside them states its own guard). */
    const covers = new Map(
      own.map((f) => [
        f.id,
        new Set(f.operands.flatMap((op) => order.slice(order.indexOf(op.firstMessageId), order.indexOf(op.lastMessageId) + 1))),
      ]),
    );
    for (const { scopes, errorKey, ...marker } of ownExits) {
      const beforeId = order[order.indexOf(marker.id) + 1];
      const guard = exitGuard(scopes, (sid) => !!covers.get(`${parentId}#${sid}`)?.has(marker.id));
      // FR-3.11 the marker is what is left of an error branch Smart folded
      const errorPath = errorKey ? errorFolds.get(errorKey) : undefined;
      exits.push({ ...marker, ...(guard ? { guard } : {}), ...(beforeId ? { beforeId } : {}), ...(errorPath ? { errorPath } : {}) });
    }
  };
  // ── FR-18.14 before the action, the request passes the route's middleware: one row (collapsed until opened) to
  // :Pipeline, one `handle` per middleware below it, each expandable into its body. Built here, once `walk` exists and
  // before the flow's own participants, then moved in front of `root` (the container step and root stay untouched).
  const pipelineStep = (middleware: RouteMiddleware[]) => {
    const pipelinePid = `${PIPELINE_REF.key}|pipeline`;
    pinfos.set(pipelinePid, { id: pipelinePid, order: -0.5, ref: PIPELINE_REF, usage: {}, isClassLevel: true });
    const expanded = state.expanded.has(PIPELINE_MESSAGE_ID);
    messages.push({
      id: PIPELINE_MESSAGE_ID,
      parentId: null,
      depth: 0,
      kind: 'found',
      from: null,
      to: pipelinePid,
      methodName: PIPELINE_METHOD,
      classKey: PIPELINE_REF.key,
      className: PIPELINE_REF.name,
      args: middleware.map(middlewareLabel),
      callSite: middleware[0].at,
      isAsync: false,
      isLibrary: false,
      expandable: true,
      expanded,
      recursive: false,
    });
    nodes.set(PIPELINE_MESSAGE_ID, { id: PIPELINE_MESSAGE_ID, depth: 0, participantId: pipelinePid, expandable: true, expanded });
    if (!expanded) return;
    // one lifeline per middleware class, left to right in the order the request passes them
    const steps = middleware.map((m, i) => {
      const ref: ClassRef = m.method?.owner ?? { key: `lib:${m.className ?? m.name}`, name: shortClassName(m.className ?? m.name.split(':')[0]), kind: 'external' };
      const pid = `${ref.key}|middleware`;
      if (!pinfos.has(pid)) pinfos.set(pid, { id: pid, order: -0.4 + i / 1000, ref, usage: {}, isClassLevel: !m.method });
      return { m, ref, pid };
    });
    steps.forEach(({ m, ref, pid }, i) => {
      const id = `${PIPELINE_MESSAGE_ID}/${i}:handle`;
      const method = m.method;
      const expandable = !!method?.hasBody && (state.expanded.has(id) || hasVisibleCalls(method));
      const open = expandable && state.expanded.has(id);
      messages.push({
        id,
        parentId: PIPELINE_MESSAGE_ID,
        depth: 1,
        kind: 'call',
        from: pipelinePid,
        to: pid,
        methodName: 'handle',
        ...(method ? { methodKey: method.key } : {}),
        classKey: ref.key,
        className: ref.name,
        args: ['$request', '$next', ...(m.params ?? [])],
        callSite: m.at,
        ...(method?.declaration ? { targetDeclaration: method.declaration } : {}),
        isAsync: false,
        isLibrary: false,
        expandable,
        expanded: open,
        recursive: false,
      });
      nodes.set(id, { id, depth: 1, ...(method ? { declared: method, effective: method } : {}), participantId: pid, expandable, expanded: open });
      if (!open || !method) return;
      // its `$next` (the handle's second parameter) goes on to the next middleware, after the last one to the action
      const next = steps[i + 1];
      const target: MethodRef = next ? next.m.method ?? { key: `${next.ref.key}#handle`, name: 'handle', owner: next.ref, isStatic: false, hasBody: false } : root;
      const receiver: ReceiverOrigin = { kind: 'local', name: '' };
      const functions = new Map<string, FunctionBinding>();
      const nextName = cache.parameterNames(method)[1];
      if (nextName) functions.set(nextName, { fn: { kind: 'method', target, receiver, isLibrary: false }, receiver, binding: { suffix: suffixOf(next ? next.pid : rootPid) }, continues: true });
      walk(id, 1, cache.outgoing(method), pid, [method.key], { params: new Map(), locals: new Map(), functions }, cache.earlyExits(method));
    });
  };
  const pipelineHiddenBy = input.pipeline?.length ? stepHiddenBy(PIPELINE_REF, PIPELINE_METHOD) : undefined;
  if (pipelineHiddenBy) hiddenCounts.set(pipelineHiddenBy.id, hiddenCounts.get(pipelineHiddenBy.id)! + 1);
  else if (input.pipeline?.length) {
    const rootAt = messages.findIndex((m) => m.id === 'root');
    const start = messages.length;
    pipelineStep(input.pipeline);
    messages.splice(rootAt, 0, ...messages.splice(start));
  }

  const rootFacts = cache.returns(root);
  if (rootFacts) returnsByActivation.set('root', rootFacts);
  if (root.hasBody) walk('root', 0, cache.outgoing(root), rootPid, [root.key], { params: new Map(), locals: new Map(), functions: new Map() }, cache.earlyExits(root));

  groupAlternativeCreations(messages, fragments, pinfos, exitsByActivation);
  bindReturnedObjects(messages, pinfos, cache, exitsByActivation, returnsByActivation, nodes);
  mergeInterchangeableObjects(messages, pinfos, cache, nodes);
  mergeValueObjects(messages, pinfos, cache);
  if (options.mergeHelpers === true) mergeHelperObjects(messages, pinfos, nodes);
  if (input.serviceLifetime) {
    mergeSharedServices(messages, pinfos, input.serviceLifetime, rootPid, makesScope);
    // FR-6.7 «singleton»: an object the container makes once (not one the code creates with `new`)
    for (const p of pinfos.values()) {
      if (!p.isClassLevel && !p.instances && SINGLETON_REF.test(p.id) && input.serviceLifetime(p.ref.key) === 'singleton') p.usage = { ...p.usage, containerSingleton: true };
    }
  }
  mergeOwnSingletons(messages, pinfos, cache, rootPid);
  // FR-9.4 Results off only hides `user = …` / `↩`: dropped after the passes above, which follow returned objects through them
  if (options.showResults === false) for (const m of messages) delete m.result;
  const { participants, groups } = finishParticipants(input, [...pinfos.values()], rootPid);
  const participantMeta = new Map<string, ParticipantMeta>();
  for (const p of pinfos.values()) {
    participantMeta.set(p.id, { ref: p.ref, origin: p.origin, senderClassKey: p.senderClassKey });
  }
  return {
    messages,
    participants,
    groups,
    hiddenFilters: input.filters.map((f) => ({ filter: f, hiddenCount: hiddenCounts.get(f.id)! })),
    nodes,
    participantMeta,
    fragments: sortFragments(fragments, messages, exits),
    exits,
    foldedCalls,
    foldErrors: !!off0,
  };
}

/**
 * FR-1.15: the condition shown on an exit marker — that of its innermost `if` / `switch` / `catch`
 * unless that construct is drawn as a frame (then the frame's guard says it). Loops say nothing.
 */
function exitGuard(scopes: FragmentScope[] | undefined, isDrawn: (stableId: string) => boolean): string | undefined {
  const s = scopes?.[scopes.length - 1];
  if (!s || isDrawn(s.id) || s.kind === 'loop' || s.kind === 'callback') return undefined;
  if (s.kind === 'try') return s.operand > 0 ? s.guard ?? 'catch' : undefined;
  return s.guard === 'else' ? s.negatedGuard : s.guard;
}

/** Outer before inner, in message order (fragments of nested owners were collected first). */
function sortFragments(fragments: Fragment[], messages: Message[], exits: ExitMarker[]): Fragment[] {
  const index = new Map(messages.map((m, i) => [m.id, i]));
  const byId = new Map(fragments.map((f) => [f.id, f]));
  const exitById = new Map(exits.map((e) => [e.id, e]));
  const level = (f: Fragment): number => (f.parentId && byId.has(f.parentId) ? 1 + level(byId.get(f.parentId)!) : 0);
  // an operand boundary is a message, a collapsed fragment's stub or an early exit (`if (a) { if (b) return; … }`);
  // a stub or an exit sits just before the next child (or at the end of its owner, a drawn message); a small step, so
  // a run of them (`if (b) return; if (c) return; save()`) stays after the call before it
  const pos = (id: string): number => {
    const at = index.get(id);
    if (at !== undefined) return at;
    const marker = byId.get(id) ?? exitById.get(id)!;
    return marker.beforeId ? pos(marker.beforeId) - 0.01 : index.get(marker.ownerMessageId)! + 0.5;
  };
  const start = (f: Fragment): number => pos(f.operands[0].firstMessageId);
  return [...fragments].sort((a, b) => start(a) - start(b) || level(a) - level(b));
}

const CONTAINER_REF: ClassRef = { key: 'lib:Illuminate\\Container\\Container', name: 'Container', kind: 'external' };
const SERVICE_PROVIDER_REF: ClassRef = { key: 'lib:Microsoft.Extensions.DependencyInjection#IServiceProvider', name: 'ServiceProvider', kind: 'external' };
const CONTAINER_KEYS = new Set([CONTAINER_REF.key, SERVICE_PROVIDER_REF.key]);

/** FR-8.7 the container of the root's language: Laravel's `resolve(X::class)`, .NET's `GetRequiredService(typeof(X))`. */
function containerOf(rootKey: string): { ref: ClassRef; method: string; arg: (name: string) => string } {
  return /\.cs#/.test(rootKey)
    ? { ref: SERVICE_PROVIDER_REF, method: 'GetRequiredService', arg: (n) => `typeof(${n})` }
    : { ref: CONTAINER_REF, method: 'resolve', arg: (n) => `${n}::class` };
}

/** FR-18.14 the framework part that runs the middleware before the action. */
const PIPELINE_REF: ClassRef = { key: 'lib:Illuminate\\Pipeline\\Pipeline', name: 'Pipeline', kind: 'external' };
const PIPELINE_METHOD = 'through';
/** FR-18.14 id of the step's row; its handles are `middleware/<i>:handle`. */
export const PIPELINE_MESSAGE_ID = 'middleware';

/** FR-18.14 how a middleware is named on the step's row: the class's short name, an alias as written (no parameters). */
function middlewareLabel(m: RouteMiddleware): string {
  return m.className ? shortClassName(m.className) : m.params ? m.name.slice(0, m.name.indexOf(':')) : m.name;
}

const shortClassName = (fqn: string): string => fqn.slice(fqn.lastIndexOf('\\') + 1);

interface ContainerStep {
  ref: ClassRef;
  /** The class it is injected into, and the constructor parameter (absent: the root object). */
  consumer?: string;
  param?: string;
  bound?: { classKey: string; at: SourceRange; contextual: boolean };
}

/**
 * FR-8.7 what the container builds to run `root`: its constructor dependencies (project classes; an interface by
 * its binding — contextual for the consumer, else global — or skipped when unbound), theirs, …, dependencies before
 * their consumers (the order the container creates them), the root object last. 3 levels, at most 25 objects; a
 * class built again is not expanded again.
 */
function containerPlan(
  cache: AnalysisCache,
  rootRef: ClassRef,
  bound: NonNullable<BuildInput['boundImplementation']>,
): ContainerStep[] {
  const steps: ContainerStep[] = [];
  const expanded = new Set<string>();
  const visit = (ref: ClassRef, depth: number, consumer?: string, param?: string, b?: ContainerStep['bound']) => {
    if (steps.length >= 25) return;
    if (depth < 3 && !expanded.has(ref.key)) {
      expanded.add(ref.key);
      const info = cache.classInfo(ref.key);
      for (const p of info?.constructorParams ?? []) {
        const t = p.type;
        if (!t || t.key.startsWith('lib:') || !t.key.includes('#')) continue;
        const via = bound(ref.key, t.key);
        const concrete = via ? cache.classInfo(via.classKey)?.ref : t.kind === 'class' ? t : undefined;
        if (concrete) visit(concrete, depth + 1, ref.key, fieldOf(info!.fields, p.name, t.key), via);
      }
    }
    steps.push({ ref, ...(consumer ? { consumer, param } : {}), ...(b ? { bound: b } : {}) });
  };
  visit(rootRef, 0);
  return steps;
}

/**
 * FR-8.7 the field a constructor parameter is stored in — the object the flow later calls through it: the parameter
 * itself (PHP promoted parameters, C# primary constructors), else the injected field named like it (`service` →
 * `_service`), else the only injected field of its type.
 */
function fieldOf(fields: { name: string; type?: ClassRef; injected: boolean }[], param: string, typeKey: string): string {
  const norm = (n: string) => n.replace(/^(_+|m_)/, '').toLowerCase();
  if (fields.some((f) => f.name === param)) return param;
  const injected = fields.filter((f) => f.injected && f.type?.key === typeKey);
  const field = injected.find((f) => norm(f.name) === norm(param)) ?? (injected.length === 1 ? injected[0] : undefined);
  return field ? field.name : param;
}

/**
 * FR-5.6 objects of one class created in **mutually exclusive** places of one activation share a lifeline: each
 * `return new X` ends the method (`if (…) return new Reply { DbError }; … return new Reply
 * { Ok }`), and different branches of one `alt` frame never both run — only one of them exists in a run, so
 * twelve side-by-side boxes would suggest twelve live objects. Not merged: creations that can coexist (the same
 * branch, a try block that goes on after the creation and its catch, a loop body). The lifeline says how many it stands for; each creation its index.
 */
function groupAlternativeCreations(messages: Message[], fragments: Fragment[], pinfos: Map<string, PInfo>, exitsByActivation: Map<string, EarlyExit[]>): void {
  const children = new Map<string, string[]>();
  for (const m of messages) if (m.parentId) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m.id]);
  /** The alt operand a direct child is in, per alt frame of its owner: frame id → operand index. */
  const operandsOf = (m: Message): Map<string, number> => {
    const out = new Map<string, number>();
    // m is a child: its parent's list holds it
    const order = children.get(m.parentId!)!;
    const at = order.indexOf(m.id);
    for (const f of fragments) {
      if (f.kind !== 'alt' || f.ownerMessageId !== m.parentId || f.collapsed) continue;
      f.operands.forEach((op, i) => {
        if (at >= order.indexOf(op.firstMessageId) && at <= order.indexOf(op.lastMessageId)) out.set(f.id, i);
      });
    }
    return out;
  };
  const pos = (r: SourceRange['start']) => r.line * 1e6 + r.character;
  const within = (inner: SourceRange, outer: SourceRange) => inner.file === outer.file && pos(inner.start) >= pos(outer.start) && pos(inner.end) <= pos(outer.end);
  /** `a` is inside an early return / throw and `b` comes after that statement: once `a`'s statement runs, `b` never does. */
  const endsBefore = (a: Message, b: Message): boolean => {
    // creations have their call site
    const exit = (exitsByActivation.get(a.parentId!) ?? []).find((e) => within(a.callSite!, e.range));
    return !!exit && exit.range.file === b.callSite!.file && pos(b.callSite!.start) >= pos(exit.range.end);
  };
  const exclusive = (a: Message, b: Message): boolean => {
    if (a.result?.kind === 'return' && b.result?.kind === 'return') return true;
    if (endsBefore(a, b) || endsBefore(b, a)) return true;
    const oa = operandsOf(a);
    const ob = operandsOf(b);
    for (const [frame, i] of oa) if (ob.has(frame) && ob.get(frame) !== i) return true;
    return tryExclusive(a, b) || tryExclusive(b, a);
  };
  /**
   * Different clauses of one try: only one catch runs; a try block's last call and a catch never both finish —
   * when the catch runs, the try block did not complete, so its object never got past it (`return (r, new D
   * { Ok })` in the try, `return (default, new D { Error })` in each catch).
   */
  const tryExclusive = (a: Message, b: Message): boolean => {
    const order = children.get(a.parentId!)!;
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return fragments.some((f) => {
      if (f.kind !== 'try' || f.ownerMessageId !== a.parentId || f.collapsed) return false;
      const operand = (i: number) => f.operands.findIndex((op) => i >= order.indexOf(op.firstMessageId) && i <= order.indexOf(op.lastMessageId));
      const [oa, ob] = [operand(ia), operand(ib)];
      if (oa < 0 || ob < 0 || oa === ob) return false;
      // catch clauses are guarded "catch …" (the try block is absent when it has no visible calls)
      const inTry = (i: number) => !/^catch\b/.test(f.operands[i].guard ?? '');
      if (!inTry(oa) && !inTry(ob)) return true; // two catch clauses
      return inTry(oa) && f.operands[oa].lastMessageId === a.id; // the try block's last call against a catch
    });
  };
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    if (m.kind !== 'create' || !m.parentId || !m.to.includes('|new:')) continue;
    // every message's target is a participant at this point (merges come later)
    const ref = pinfos.get(m.to)!.ref.key;
    const key = `${m.parentId}|${ref}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  for (const creates of groups.values()) {
    if (creates.length < 2) continue;
    // greedy clusters: a creation joins the first cluster it excludes entirely
    const clusters: Message[][] = [];
    for (const c of creates) {
      const home = clusters.find((cl) => cl.every((x) => exclusive(x, c)));
      if (home) home.push(c);
      else clusters.push([c]);
    }
    for (const cl of clusters) {
      if (cl.length < 2) continue;
      const keep = cl[0].to;
      const why = cl.some((c) => (exitsByActivation.get(c.parentId!) ?? []).some((e) => c.callSite && within(c.callSite, e.range))) || cl.every((c) => c.result?.kind === 'return') ? 'return' : 'branch';
      const drop = new Set(cl.slice(1).map((c) => c.to));
      for (const m of messages) {
        if (drop.has(m.to)) m.to = keep;
        if (m.from && drop.has(m.from)) m.from = keep;
      }
      for (const pid of drop) pinfos.delete(pid);
      pinfos.get(keep)!.alternatives = cl.length;
      cl.forEach((c, i) => (c.alternative = { index: i + 1, count: cl.length, why }));
    }
  }
}

/**
 * FR-5.10 objects whose class makes them interchangeable (no state of their own, e.g. a React hook's
 * `useMemo(() => new CatalogViewHandler(), [])` in every component that calls it, and its fields reached through
 * `const { catalogView } = useCatalogViewHandler()`): one lifeline per class — which object a call goes to cannot change
 * what happens. The first creation draws the lifeline's head, later ones arrive
 * as create messages on it; the lifeline says how many objects it stands for.
 */
function mergeInterchangeableObjects(messages: Message[], pinfos: Map<string, PInfo>, cache: AnalysisCache, nodes: Map<string, BuiltNode>): void {
  const byClass = new Map<string, PInfo[]>();
  // objects built by the same line with the same arguments (`new CartViewHandler(cart)` in a hook
  // every component calls, and what its constructor builds from its parameters): one lifeline per line
  const repeatable = new Set<string>();
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const m of messages) {
    if (m.kind !== 'create' || !m.callSite || !m.to.includes('|new:')) continue;
    const p = pinfos.get(m.to);
    const info = p && cache.classInfo(p.ref.key);
    if (!p || !info?.sameArgsInterchangeable || info.interchangeable) continue;
    const from = nodes.get(m.id)?.call?.argsFrom;
    const parent = byId.get(m.parentId!);
    if (from !== 'fixed' && !(from === 'constructorParams' && parent && repeatable.has(parent.id))) continue;
    repeatable.add(m.id);
    const site = `${p.ref.key}@${m.callSite.file}:${m.callSite.start.line}:${m.callSite.start.character}`;
    byClass.set(site, [...(byClass.get(site) ?? []), p]);
  }
  for (const p of pinfos.values()) {
    // a lifeline for one object of the class: created here, or reached through a variable / field / expression typed
    // by the class itself — not one reached through an interface (`primary` / `replica: UserRepository` are two roles,
    // a container may set them up differently; the implementation shown is only the one chosen)
    if (p.isClassLevel || !/\|(?:(?:new|var|field|expr):|instance$)/.test(p.id) || !cache.classInfo(p.ref.key)?.interchangeable) continue;
    if (!p.id.includes('|new:') && p.implementsInterface) continue;
    byClass.set(p.ref.key, [...(byClass.get(p.ref.key) ?? []), p]);
  }
  for (const same of byClass.values()) {
    if (same.length < 2) continue;
    // the created lifeline keeps its place and name (`catalogView:CatalogView`), else the first one drawn
    same.sort((a, b) => Number(!a.id.includes('|new:')) - Number(!b.id.includes('|new:')) || a.order - b.order);
    const keep = same[0];
    keep.order = Math.min(...same.map((p) => p.order));
    const drop = new Set(same.slice(1).map((p) => p.id));
    for (const m of messages) {
      if (drop.has(m.to)) m.to = keep.id;
      if (m.from && drop.has(m.from)) m.from = keep.id;
    }
    for (const id of drop) pinfos.delete(id);
    keep.instances = messages.filter((m) => m.kind === 'create' && m.to === keep.id).length;
  }
}

/**
 * FR-5.12 values on one lifeline per class: created objects whose class cannot change once built (a C# `record`, only
 * `readonly` fields — `ClassInfo.immutable`). Which one a call goes to changes nothing; each call shows its values.
 * Mutable objects keep one lifeline each (FR-5.5). A value created by a value of its own class (`price.Add(…)` →
 * `new Price`) keeps its own lifeline, which would otherwise create itself. FR-5.6 one-of-n lifelines of the class join
 * in. Runs after FR-5.7, so calls on a returned value already reach it.
 */
function mergeValueObjects(messages: Message[], pinfos: Map<string, PInfo>, cache: AnalysisCache): void {
  const creation = new Map<string, Message>();
  for (const m of messages) if (m.kind === 'create') creation.set(m.to, m);
  const byClass = new Map<string, PInfo[]>();
  for (const p of pinfos.values()) {
    if (p.isClassLevel || !p.id.includes('|new:') || p.instances || !creation.has(p.id) || cache.classInfo(p.ref.key)?.immutable !== true) continue;
    byClass.set(p.ref.key, [...(byClass.get(p.ref.key) ?? []), p]);
  }
  for (const all of byClass.values()) {
    const ids = new Set(all.map((p) => p.id));
    // a creation always has a sender (only the found message has none)
    const same = all.filter((p) => !ids.has(creation.get(p.id)!.from!));
    if (same.length < 2) continue;
    same.sort((a, b) => a.order - b.order);
    const keep = same[0];
    const drop = new Set(same.slice(1).map((p) => p.id));
    for (const m of messages) {
      if (drop.has(m.to)) m.to = keep.id;
      if (m.from && drop.has(m.from)) m.from = keep.id;
    }
    for (const id of drop) pinfos.delete(id);
    // one object's variable name (`error:`) would name them all
    if (same.some((p) => p.instanceName !== keep.instanceName)) delete keep.instanceName;
    keep.instances = messages.filter((m) => m.kind === 'create' && m.to === keep.id).length;
    keep.instancesWhy = 'value';
    delete keep.alternatives;
  }
}

/**
 * FR-5.13 one lifeline per helper type (option `mergeHelpers`, off by default — FR-5.5): objects of one class created in
 * the drawn calls and never stored in a field (`new OrderQuery(…).run()`, a local formatter) share one lifeline, `×n`,
 * each «create» numbered. Unlike FR-5.10 / FR-5.12 they may differ: the reader asked for fewer columns. Objects of a
 * class that call one another stay apart (one lifeline would draw a self call that is not one), and so does an object
 * created by an object of its own class (it would create itself).
 */
function mergeHelperObjects(messages: Message[], pinfos: Map<string, PInfo>, nodes: Map<string, BuiltNode>): void {
  const creation = new Map<string, Message>();
  for (const m of messages) if (m.kind === 'create') creation.set(m.to, m);
  const byClass = new Map<string, PInfo[]>();
  for (const p of pinfos.values()) {
    const created = creation.get(p.id);
    if (p.isClassLevel || !p.id.includes('|new:') || p.instances || !created || nodes.get(created.id)?.call?.assignedTo?.kind === 'field') continue;
    byClass.set(p.ref.key, [...(byClass.get(p.ref.key) ?? []), p]);
  }
  for (const all of byClass.values()) {
    const ids = new Set(all.map((p) => p.id));
    // a call or a creation from one of them to another
    if (all.length < 2 || messages.some((m) => m.from !== m.to && ids.has(m.to) && ids.has(m.from!))) continue;
    all.sort((a, b) => a.order - b.order);
    const keep = all[0];
    const drop = new Set(all.slice(1).map((p) => p.id));
    for (const m of messages) {
      if (drop.has(m.to)) m.to = keep.id;
      if (m.from && drop.has(m.from)) m.from = keep.id;
    }
    for (const id of drop) pinfos.delete(id);
    if (all.some((p) => p.instanceName !== keep.instanceName)) delete keep.instanceName;
    const creates = messages.filter((m) => m.kind === 'create' && m.to === keep.id);
    creates.forEach((m, i) => (m.instance = i + 1));
    keep.instances = creates.length;
    keep.instancesWhy = 'helper';
    delete keep.alternatives;
  }
}

/** FR-6.7 the references a container singleton can be: the root's object, injected fields, parameters, locals, expressions. */
const SINGLETON_REF = /\|(?:root$|instance$|(?:field|var|expr):)/;

/**
 * FR-6.7 one lifeline per service the container makes once: lifelines of a class registered as a singleton (or
 * scoped: one per request) — the root's object, injected fields, parameters — are one object, however the code reaches
 * it (`_orders:OrderService «IOrderService»` in the controller and `:OrderService` in the job). A scoped service joins
 * only the root's object and injected fields, and only when the drawn flow makes no scope of its own. Objects created
 * with `new`, static access and lifelines already standing for several objects stay as they are.
 */
function mergeSharedServices(messages: Message[], pinfos: Map<string, PInfo>, lifetime: (classKey: string) => 'singleton' | 'scoped' | undefined, rootPid: string, newScope: boolean): void {
  // scoped is one object per scope: a flow that makes a scope (`CreateScope()`) may hold two; a local or an expression may
  // come from another scope (`sp.GetRequiredService<T>()`) — only the root's object and injected fields are the request's
  const byClass = new Map<string, PInfo[]>();
  for (const p of pinfos.values()) {
    const life = p.isClassLevel || p.instances ? undefined : lifetime(p.ref.key);
    if (!life || !(life === 'singleton' ? SINGLETON_REF : /\|(?:root$|field:)/).test(p.id) || (life === 'scoped' && newScope)) continue;
    byClass.set(p.ref.key, [...(byClass.get(p.ref.key) ?? []), p]);
  }
  for (const all of byClass.values()) {
    if (all.length < 2) continue;
    // the root's object keeps its place, else the first one drawn
    all.sort((a, b) => Number(b.id === rootPid) - Number(a.id === rootPid) || a.order - b.order);
    const keep = all[0];
    keep.order = Math.min(...all.map((p) => p.order));
    const drop = new Set(all.slice(1).map((p) => p.id));
    for (const m of messages) {
      if (drop.has(m.to)) m.to = keep.id;
      if (m.from && drop.has(m.from)) m.from = keep.id;
      // a call from one reference to another is the object calling itself
      if (m.kind === 'call' && m.from === m.to) m.kind = 'self';
    }
    for (const id of drop) pinfos.delete(id);
    // the names it is held under (`_primary`, `_replica`) go to the tooltip when they differ
    const names = [...new Set(all.flatMap((p) => (p.instanceName ? [p.instanceName] : [])))];
    if (names.length > 1) keep.heldAs = names;
    if (all.some((p) => p.instanceName !== keep.instanceName)) delete keep.instanceName;
    if (all.some((p) => p.implementsInterface?.key !== keep.implementsInterface?.key)) delete keep.implementsInterface;
    // «seam» only when every reference is an injected interface: a caller holding the class itself cannot swap it
    const seams = all.filter((p) => p.usage.injectedAsAbstraction);
    keep.usage = { ...keep.usage, injectedAsAbstraction: seams.length === all.length };
    if (seams.length && seams.length < all.length) {
      // the sender is drawn (a reference of this class itself: the kept lifeline)
      keep.seamVia = seams.map((p) => `${p.seamType} in ${[...pinfos.values()].find((q) => q.ref.key === p.senderClassKey)!.ref.name}`);
    }
    keep.service = lifetime(keep.ref.key);
  }
}

/**
 * FR-6.7 a class that keeps its only instance (a private constructor and a static instance of its own type:
 * `Database.Instance`, `getInstance()`): its «static» lifeline, the lifelines of that instance, and the object the class
 * makes of itself are one object — a UML reader would see two (`Database «static»` beside `:Database`).
 */
function mergeOwnSingletons(messages: Message[], pinfos: Map<string, PInfo>, cache: AnalysisCache, rootPid: string): void {
  const creator = new Map(messages.filter((m) => m.kind === 'create').map((m) => [m.to, m.from]));
  const byClass = new Map<string, PInfo[]>();
  for (const p of pinfos.values()) {
    const info = cache.classInfo(p.ref.key);
    if (!info?.hasStaticInstance || !info.hasPrivateConstructor || p.instances || p.service) continue;
    // made by the class itself (its getInstance): that one object; made elsewhere cannot be (private constructor)
    const made = p.id.includes('|new:') && pinfos.get(creator.get(p.id)!)?.ref.key === p.ref.key;
    if (!made && !/\|(?:static$|root$|instance$|(?:field|var|expr):)/.test(p.id)) continue;
    byClass.set(p.ref.key, [...(byClass.get(p.ref.key) ?? []), p]);
  }
  for (const all of byClass.values()) {
    if (all.length < 2) continue;
    // the root's object keeps its place, then an object's lifeline (not the class's)
    all.sort((a, b) => Number(b.id === rootPid) - Number(a.id === rootPid) || Number(a.isClassLevel) - Number(b.isClassLevel) || a.order - b.order);
    const keep = all[0];
    keep.order = Math.min(...all.map((p) => p.order));
    const drop = new Set(all.slice(1).map((p) => p.id));
    for (const m of messages) {
      if (drop.has(m.to)) m.to = keep.id;
      if (m.from && drop.has(m.from)) m.from = keep.id;
      if (m.kind === 'call' && m.from === m.to) m.kind = 'self';
    }
    for (const id of drop) pinfos.delete(id);
    // the class's one object: named by the class (`:Db`), not by one of the ways to it
    delete keep.instanceName;
    keep.isClassLevel = false;
    keep.usage = { ...keep.usage, staticAccess: false };
    keep.service = 'own';
  }
}

/**
 * FR-5.7 an object a call returns is the caller's object: `$details = $this->validate(…)`, where the expanded
 * `validate` returns an object it created (`return new Reply(…)` — after FR-5.6 one lifeline for all its
 * alternatives) or what a call of its own returns (`return $this->factory->make()`, followed down). The caller's
 * later calls on `$details` (in that activation) go to that object instead of a separate `$details` participant.
 * Only when the returned object is known exactly once and its class fits the variable (the same class, or the
 * variable's type is an interface / abstract class). Not followed: collapsed calls, fields.
 *
 * FR-5.8 with the adapter's return facts also: a returned local variable (`var p = new P(); … return p;` — what
 * the body assigned to it), tuples / arrays element by element (`return (p, Status.Ok)`) and the caller's
 * destructuring (`(var p, status) = await Enroll()`, `[$p, $status] = …`, `const [p, status] = …`).
 * `null` / `default` returns are no object (an early `return (null, status)` does not make it unknown).
 */
function bindReturnedObjects(
  messages: Message[],
  pinfos: Map<string, PInfo>,
  cache: AnalysisCache,
  exitsByActivation: Map<string, EarlyExit[]>,
  returnsByActivation: Map<string, ReturnFact[]>,
  nodes: Map<string, BuiltNode>,
): void {
  const pos = (r: SourceRange['start']) => r.line * 1e6 + r.character;
  const within = (inner: SourceRange, outer: SourceRange) => inner.file === outer.file && pos(inner.start) >= pos(outer.start) && pos(inner.end) <= pos(outer.end);
  const children = new Map<string, Message[]>();
  for (const m of messages) if (m.parentId) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
  const memo = new Map<string, string | undefined>();
  /** The participant an expanded call's body returns (element `index` of a returned tuple), if exactly one is known. */
  const returned = (m: Message, index: number | undefined, depth = 0): string | undefined => {
    const key = `${m.id}|${index ?? ''}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, undefined);
    if (depth > 6 || !m.expanded) return undefined;
    const facts = returnsByActivation.get(m.id);
    // no facts (an adapter or older sidecar that cannot tell; a body without `return` returns nothing anyway)
    const out = facts?.length ? fromFacts(m, facts, index, depth) : index === undefined ? fromCalls(m, depth) : undefined;
    memo.set(key, out);
    return out;
  };
  /** FR-5.8 every return statement must give the same object (or none: null / default). */
  const fromFacts = (m: Message, facts: ReturnFact[], index: number | undefined, depth: number): string | undefined => {
    const kids = children.get(m.id) ?? [];
    const found = new Set<string>();
    for (const f of facts) {
      // a returned call's tuple passes through: `return await Inner();` with the caller destructuring it
      const v = f.tuple ? (index === undefined ? undefined : f.values[index]) : f.values[0];
      if (!v) return undefined;
      if (v.empty) continue;
      const pid = valueOf(kids, v, f.tuple ? undefined : index, f.range, depth);
      if (!pid) return undefined;
      found.add(pid);
    }
    return found.size === 1 ? [...found][0] : undefined;
  };
  /**
   * FR-5.10 React keeps what its initialiser returns: `useMemo(() => new X(…), deps)` is that X,
   * `const [x] = useState(() => new X())` too — the one creation the initialiser returns.
   */
  const initialised = (k: Message, i: number | undefined): string | undefined => {
    if (!k.isLibrary || !k.callSite || !((k.methodName === 'useMemo' && i === undefined) || (k.methodName === 'useState' && i === 0))) return undefined;
    const made = children.get(k.parentId!)!.filter((c) => c.kind === 'create' && c.result?.kind === 'return' && c.callSite && within(c.callSite, k.callSite!));
    return made.length === 1 ? made[0].to : undefined;
  };
  const innermostCallback = (k: Message): string => nodes.get(k.id)?.call?.fragments?.filter((f) => f.kind === 'callback').at(-1)?.guard ?? '';
  const valueOf = (kids: Message[], v: ReturnValue, index: number | undefined, statement: SourceRange, depth: number): string | undefined => {
    const of = (k: Message, i: number | undefined): string | undefined =>
      // a returned value's message is a call, a self call or a creation (only the root is a found message)
      k.kind === 'create' ? (i === undefined ? k.to : undefined) : initialised(k, i) ?? returned(k, i, depth + 1);
    if (v.variable) {
      // what the body assigned to it before the return — every assignment we see must give the same object
      const found = new Set<string>();
      for (const k of kids) {
        if (!k.callSite || k.callSite.file !== statement.file || pos(k.callSite.start) >= pos(statement.start)) continue;
        if (k.result?.kind !== 'assign') continue;
        const names = targetNames(k.result.target);
        let pid: string | undefined;
        if (names) {
          const j = names.indexOf(v.variable);
          if (j < 0) continue;
          pid = k.kind === 'create' || index !== undefined ? undefined : of(k, j);
        } else {
          if (plainName(k.result.target) !== v.variable) continue;
          pid = k.result.operator === '=' || k.result.operator === '??=' ? of(k, index) : undefined;
        }
        if (!pid) return undefined;
        found.add(pid);
      }
      return found.size === 1 ? [...found][0] : undefined;
    }
    // an expression: the call or creation it starts with (`await` and parentheses are not part of the value)
    const inside = kids.filter((k) => k.callSite && within(k.callSite, v.range));
    const outer = inside.filter((k) => !inside.some((o) => o !== k && within(k.callSite!, o.callSite!)));
    if (outer.length !== 1 || pos(outer[0].callSite!.start) !== pos(v.range.start)) {
      // FR-5.10 `return useMemo(() => new X(…), deps)` with library calls hidden: the one creation its initialiser returns
      const memo = index === undefined ? inside.filter((k) => k.kind === 'create' && k.result?.kind === 'return' && /^useMemo\b/.test(innermostCallback(k))) : [];
      return memo.length === 1 ? memo[0].to : undefined;
    }
    return of(outer[0], index);
  };
  /** FR-5.7 without return facts: every return must be a visible call or creation. */
  const fromCalls = (m: Message, depth: number): string | undefined => {
    const found = new Set<string>();
    let unknown = false;
    const kids = children.get(m.id) ?? [];
    // every return must be one we see: `return $existing;` is no call — then the returned object is unknown
    const returns = kids.filter((c) => c.result?.kind === 'return');
    const early = (exitsByActivation.get(m.id) ?? []).filter((e) => e.kind === 'return');
    // the final return must be one of them too: the last message, returned, and not inside an early exit
    const last = kids.at(-1);
    if (!returns.length || last?.result?.kind !== 'return' || early.some((e) => last.callSite && within(last.callSite, e.range))) unknown = true;
    if (early.some((e) => !returns.some((c) => c.callSite && within(c.callSite, e.range)))) unknown = true;
    for (const c of returns) {
      if (c.kind === 'create') found.add(c.to);
      else {
        const r = returned(c, undefined, depth + 1);
        if (r) found.add(r);
        else unknown = true;
      }
    }
    return !unknown && found.size === 1 ? [...found][0] : undefined;
  };
  const subtree = (id: string): Message[] => (children.get(id) ?? []).flatMap((c) => [c, ...subtree(c.id)]);
  /** The caller's later messages in this activation (and below them) that reach the variable `name` go to `pid`. */
  const bind = (call: Message, name: string, pid: string): void => {
    // a returned object is the target of a drawn message: a participant
    const object = pinfos.get(pid)!;
    const siblings = children.get(call.parentId!)!;
    const later = siblings.slice(siblings.indexOf(call) + 1).flatMap((s) => [s, ...subtree(s.id)]);
    const suffix = `|var:${name}`;
    const fits = (vid: string) => {
      // a participant is dropped only when no message names it any more
      const v = pinfos.get(vid)!;
      if (v.ref.key === object.ref.key) return true;
      const kind = cache.classInfo(v.ref.key)?.ref.kind ?? v.ref.kind;
      return kind === 'interface' || kind === 'abstract';
    };
    const renamed = new Set<string>();
    for (const m of later) {
      if (m.to.endsWith(suffix) && fits(m.to)) {
        renamed.add(m.to);
        m.to = pid;
      }
      if (m.from && m.from.endsWith(suffix) && fits(m.from)) {
        renamed.add(m.from);
        m.from = pid;
      }
    }
    for (const vid of renamed) if (!messages.some((m) => m.to === vid || m.from === vid)) pinfos.delete(vid);
  };
  /** FR-5.10 the object an expanded creation of `pid` (below `call`) stored in its field: `this.view = new View(…)`. */
  const fieldObject = (call: Message, pid: string, field: string): string | undefined => {
    const created = subtree(call.id).filter((m) => m.kind === 'create' && m.to === pid && m.expanded);
    if (created.length !== 1) return undefined;
    const stored = subtree(created[0].id).filter((k) => k.kind === 'create' && k.result?.kind === 'assign' && k.result.operator === '=' && plainName(k.result.target) === field);
    return stored.length === 1 ? stored[0].to : undefined;
  };
  /**
   * FR-5.10 a created object any call of its method would give alike: built by a line whose arguments use no parameter
   * (`new X(cart)` in a hook), of a class whose objects built so cannot differ.
   */
  const alike = (pid: string): boolean => {
    const made = messages.find((m) => m.kind === 'create' && m.to === pid);
    const p = pinfos.get(pid);
    return !!made && !!p && nodes.get(made.id)?.call?.argsFrom === 'fixed' && !!cache.classInfo(p.ref.key)?.sameArgsInterchangeable;
  };
  for (const call of messages) {
    if (call.kind !== 'call' && call.kind !== 'self') continue;
    if (call.result?.kind !== 'assign' || !call.parentId) continue;
    // FR-5.10 `const { view, handler: h } = useViewHandler()`: the fields of the object the call returns; a collapsed
    // call takes them from an expanded call of the same method when that object is one any call gives alike
    const fields = objectTargets(call.result.target);
    if (fields) {
      let from = call;
      let pid = call.expanded ? returned(call, undefined) : undefined;
      if (!call.expanded && call.methodKey) {
        const twin = messages.find((m) => m !== call && m.expanded && m.methodKey === call.methodKey && m.result?.kind === 'assign');
        const object = twin && returned(twin, undefined);
        if (twin && object && alike(object)) [from, pid] = [twin, object];
      }
      if (pid) for (const f of fields) {
        const object = fieldObject(from, pid, f.field);
        if (object) bind(call, f.name, object);
      }
      continue;
    }
    if (!call.expanded) continue;
    const names = targetNames(call.result.target);
    if (names) {
      names.forEach((name, i) => {
        const pid = name ? returned(call, i) : undefined;
        if (pid) bind(call, name, pid);
      });
      continue;
    }
    const name = plainName(call.result.target);
    const pid = name ? returned(call, undefined) : undefined;
    if (pid) bind(call, name!, pid);
  }
}

/** FR-5.10 `{view, handler: h}` → [{ field: 'view', name: 'view' }, { field: 'handler', name: 'h' }]; nested / rest / defaults → undefined. */
export function objectTargets(target: string): { field: string; name: string }[] | undefined {
  const m = /^\{(.*)\}$/.exec(target.trim());
  if (!m || !m[1].trim()) return undefined;
  const out: { field: string; name: string }[] = [];
  for (const part of m[1].split(',')) {
    const p = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(part.trim());
    if (!p) return undefined;
    out.push({ field: p[1], name: p[2] ?? p[1] });
  }
  return out;
}

/** `$user` / `user` → the variable's name; anything else (`this.x`, `a[0]`) → undefined. */
function plainName(target: string): string | undefined {
  const name = target.replace(/^\$/, '');
  return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/**
 * FR-5.8 positional destructuring targets: `(a, b)` (C#, `var` already dropped; typed `(Member? p, Status s)`),
 * `[a, , b]` (TS), `[$a, $b]` / `list($a, $b)` (PHP) → names by position ('' = skipped: a hole, `_`, `...rest`).
 * Not positional (`{ a, b }`, keyed `['x' => $a]`, nested) → undefined.
 */
export function targetNames(target: string): string[] | undefined {
  const m = /^(?:list\s*\(|\(|\[)(.*)[)\]]$/s.exec(target.trim());
  if (!m || /[()[\]{}<]|=>/.test(m[1])) return undefined; // nested, keyed, generic types (`Dictionary<K, V> d`)
  const names = m[1].split(',').map((e) => {
    const t = e.trim();
    if (!t || t.startsWith('...') || t === '_') return '';
    return trailingIdentifier(t);
  });
  return names.length > 1 || names[0] ? names : undefined;
}

function rootIdentity(root: MethodRef, synthetic: boolean): string {
  if (root.owner.kind === 'module') return `${root.owner.key}|module`;
  if (synthetic) return `${root.owner.key}|object`;
  if (root.isStatic) return `${root.owner.key}|static`;
  return `${root.owner.key}|root`;
}

/** FR-8.6 the implementation a class inherits from its project ancestors (nearest first), and the class itself. */
function inheritedImplementation(cache: AnalysisCache, classKey: string, impls: MethodRef[]): { method: MethodRef; object: ClassRef } | undefined {
  const info = cache.classInfo(classKey);
  if (!info) return undefined;
  let base = info.extends;
  for (let depth = 0; base && depth < 5; depth++) {
    const hit = impls.find((i) => i.owner.key === base!.key);
    if (hit) return { method: hit, object: info.ref };
    base = cache.classInfo(base.key)?.extends;
  }
  return undefined;
}

/** FR-5.11 `owner` when it is a project base class of `object`'s class (nearest first, a few levels), else undefined. */
function inheritedOwner(cache: AnalysisCache, object: ClassRef, owner: ClassRef): ClassRef | undefined {
  if (object.key === owner.key || (object.kind !== 'class' && object.kind !== 'abstract')) return undefined;
  let base = cache.classInfo(object.key)?.extends;
  for (let depth = 0; base && depth < 8; depth++) {
    if (base.key === owner.key) return base;
    base = cache.classInfo(base.key)?.extends;
  }
  return undefined;
}

function chooseImplementation(
  input: BuildInput,
  id: string,
  declared: MethodRef,
  impls: MethodRef[],
  knownClassKey?: string,
  boundClassKey?: string,
): string | undefined {
  const explicit = input.state.choices.get(id);
  if (explicit !== undefined) return explicit ?? undefined;
  if (knownClassKey && impls.some((i) => i.owner.key === knownClassKey)) return knownClassKey;
  // FR-8.6 what the container binds here — before a choice remembered from another call site
  if (boundClassKey) return boundClassKey;
  const remembered = input.interfaceChoices.get(declared.owner.key);
  if (remembered && impls.some((i) => i.owner.key === remembered)) return remembered;
  if (input.autoSelectSingleImplementation && impls.length === 1) return impls[0].owner.key;
  return undefined;
}

interface TargetParticipant {
  id: string;
  ref: ClassRef;
  selfCall: boolean;
  /** Absent for a participant already drawn (a lambda's writer, the sender itself). */
  init?: (cache: AnalysisCache) => Omit<PInfo, 'id' | 'order'>;
  /** Whether this path reaches the participant as an injected abstraction (FR-7.1 «seam»). */
  seam?: (cache: AnalysisCache) => boolean;
  /** «seam»: the type the receiver was injected as (named in tooltips). */
  seamType?: string;
  /** Chosen implementation of this interface on this path (FR-8.2) — also for an already known participant. */
  implementsInterface?: { key: string; name: string };
}

interface ResolveInput {
  call: CallSite;
  declared: MethodRef | undefined;
  effective: MethodRef | undefined;
  polymorphic: PolymorphicInfo | undefined;
  implementations: MethodRef[] | undefined;
  sender: PInfo;
  messageId: string;
  /** Receiver bound through parameters / locals / fields (FR-6.5). */
  binding: Binding | undefined;
  cache: AnalysisCache;
}

/** Participant identity (FR-6.5): (class, receiver origin), receivers resolved through bindings. */
function resolveParticipant(input: ResolveInput): TargetParticipant {
  const { call, declared, effective, polymorphic, sender, messageId, binding, cache } = input;
  const simple = (id: string, ref: ClassRef, extra: Partial<PInfo> = {}): TargetParticipant => ({
    id,
    ref,
    selfCall: false,
    init: () => ({ ref, usage: {}, isClassLevel: true, ...extra }),
  });
  if (!declared) return simple('unknown', UNKNOWN_REF);
  if (call.isLibrary) return simple(declared.owner.key, declared.owner);

  const origin = call.receiver;
  if (call.kind === 'create') {
    // a creation runs what it names (no implementation choice: effective is declared)
    const ref = declared.owner;
    return {
      id: `${ref.key}|new:${messageId}`,
      ref,
      selfCall: false,
      init: () => ({
        ref,
        usage: {},
        createdByMessageId: messageId,
        origin,
        instanceName: call.assignedTo?.name,
        senderClassKey: sender.ref.key,
        isClassLevel: false,
      }),
    };
  }
  if (origin.kind === 'self' || origin.kind === 'super') {
    return { id: sender.id, ref: sender.ref, selfCall: true, init: () => ({ ...sender }) };
  }

  const selected = polymorphic?.selectedKey ? effective : undefined;
  // FR-8.6 a bound subclass running an inherited implementation: the object is the subclass
  const objectRef = selected && polymorphic?.selectedKey !== selected.owner.key ? polymorphic?.implementations.find((i) => i.key === polymorphic.selectedKey) : undefined;
  const ref = objectRef ?? (selected ? selected.owner : declared.owner.kind === 'module' ? declared.owner : pickClass(call.receiverType, declared.owner));
  const implementsInterface = selected ? { key: declared.owner.key, name: declared.owner.name } : undefined;

  if (ref.kind === 'module') {
    // a module-level object literal implementing a record-of-functions interface (FR-8.2)
    const id = `${ref.key}|module`;
    return { id, ref, selfCall: id === sender.id, implementsInterface, init: () => ({ ref, usage: {}, implementsInterface, isClassLevel: true }) };
  }
  if (cache.isSynthetic(ref.key)) {
    // object literal / closure of functional code: one participant per owner
    const id = `${ref.key}|object`;
    return {
      id,
      ref,
      selfCall: id === sender.id,
      implementsInterface,
      init: () => ({ ref, usage: {}, implementsInterface, origin, senderClassKey: sender.ref.key, isClassLevel: true }),
    };
  }
  if (origin.kind === 'static' || declared.isStatic) {
    const id = `${ref.key}|static`;
    return { id, ref, selfCall: id === sender.id, init: () => ({ ref, usage: { staticAccess: true }, isClassLevel: true }) };
  }

  let suffix: string;
  let instanceName: string | undefined;
  switch (origin.kind) {
    case 'field':
    case 'parameter':
    case 'local':
      // the caller binds every such receiver (a variable of its own, or `var:<name>`)
      suffix = binding!.suffix;
      instanceName = binding?.name ?? origin.name;
      break;
    case 'module':
      suffix = `module:${origin.name}`;
      break;
    case 'expression':
      suffix = `expr:${origin.text}`;
      break;
    case 'created':
      // `new X().m()`: the object just created (FR-5.1), bound by the caller; a method of it passed along
      // (`items.map(new Mapper().toDto)`) carries no binding
      suffix = binding?.suffix ?? 'instance';
      break;
    default:
      suffix = 'instance';
  }
  const id = `${ref.key}|${suffix}`;
  const seam = (c: AnalysisCache): boolean => isSeam(c, origin, declared, sender.ref, input.implementations);
  return {
    id,
    ref,
    selfCall: id === sender.id,
    seam,
    seamType: declared.owner.name,
    implementsInterface,
    init: (c) => ({
      ref,
      instanceName,
      implementsInterface,
      origin,
      senderClassKey: sender.ref.key,
      isClassLevel: false,
      usage: { injectedAsAbstraction: seam(c) },
      ...(seam(c) ? { seamType: declared.owner.name } : {}),
    }),
  };
}

/** A subclass instance calling an inherited method is drawn as the subclass. */
function pickClass(receiverType: ClassRef | undefined, owner: ClassRef): ClassRef {
  if (
    receiverType &&
    receiverType.key !== owner.key &&
    (receiverType.kind === 'class' || receiverType.kind === 'abstract') &&
    (owner.kind === 'class' || owner.kind === 'abstract')
  ) {
    return receiverType;
  }
  return owner;
}

/**
 * «seam» (FR-7.1): a behavioural abstraction — interface/abstract type with at least one behaviour
 * member (method or function-typed property) and at least one implementation in the project (of
 * the called member) — injected via constructor or parameter.
 */
function isSeam(
  cache: AnalysisCache,
  origin: ReceiverOrigin,
  declared: MethodRef,
  senderRef: ClassRef,
  implementations: MethodRef[] | undefined,
): boolean {
  const declaredOwner = declared.owner;
  if (declaredOwner.kind !== 'interface' && declaredOwner.kind !== 'abstract') return false;
  if (origin.kind !== 'parameter' && origin.kind !== 'field') return false;
  if ((cache.classInfo(declaredOwner.key)?.methods.length ?? 0) === 0) return false;
  if ((implementations ?? cache.implementations(declared)).length === 0) return false;
  if (origin.kind === 'parameter') return true;
  // a field: it may be inherited (a bound subclass object using its parent's injected dependency, FR-8.6)
  let key: string | undefined = senderRef.key;
  for (let depth = 0; key && depth < 5; depth++) {
    const info = cache.classInfo(key);
    const field = info?.fields.find((f) => f.name === origin.name);
    if (field) return !!field.injected;
    key = info?.extends?.key;
  }
  return false;
}

function matchesFilter(
  f: HideFilter,
  call: CallSite,
  declared: MethodRef | undefined,
  effective: MethodRef | undefined,
  participantRef: ClassRef,
  stereotypesOf: (ref: ClassRef) => string[],
): boolean {
  const classKeys = [declared?.owner.key, effective?.owner.key, participantRef.key];
  // an unresolved call is shown (and its hide rule named) by its expression, `app.withTypeProvider<T>().route`
  const named = (name: string) => call.methodName === name || (!declared && calleeText(call) === name);
  switch (f.kind) {
    case 'methodName':
      return named(f.methodName);
    case 'classMethod':
      return named(f.methodName) && classKeys.includes(f.classKey);
    case 'class':
      return classKeys.includes(f.classKey);
    default:
      return classInCategory(f, participantRef.name, stereotypesOf(participantRef));
  }
}

/** FR-11.8 a class in a hidden category: its name matches the glob (`*Mapper`), or it carries the stereotype. */
export function classInCategory(f: HideFilter, className: string, stereotypes: readonly string[]): boolean {
  if (f.kind === 'classPattern') return globTest(f.pattern)(className);
  return f.kind === 'stereotype' && stereotypes.includes(f.stereotype);
}

const globs = new Map<string, (name: string) => boolean>();
const globTest = (pattern: string) => {
  let test = globs.get(pattern);
  if (!test) globs.set(pattern, (test = picomatch(pattern)));
  return test;
};

/**
 * The class a library creation makes, for its «create» label: `new Error(…)` → "Error" (the lifeline is the library,
 * named after its package — "lib" for the built-ins, which says nothing about what was made).
 */
function createdTypeName(call: CallSite): string {
  const callee = calleeText(call).replace(/^new\s+/, '').split('<', 1)[0];
  return callee.slice(callee.lastIndexOf('.') + 1);
}

/** Call expression without its argument list: "this.printer.print". */
export function calleeText(call: CallSite): string {
  const text = call.expressionText;
  if (!text.endsWith(')')) return text;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      depth--;
      if (depth === 0) return text.slice(0, i).replace(/\?\.$/, '').replace(/^new\s+/, '') || text;
    }
  }
  return text;
}

function finishParticipants(
  input: BuildInput,
  infos: PInfo[],
  rootPid: string,
): { participants: Participant[]; groups: ParticipantGroup[] } {
  const { classifier, cache } = input;
  const layerOrder = classifier.layerOrder();

  const instanceCount = new Map<string, number>();
  for (const p of infos) {
    if (!p.isClassLevel) instanceCount.set(p.ref.key, (instanceCount.get(p.ref.key) ?? 0) + 1);
  }

  const groups = new Map<string, ParticipantGroup & { rank: number }>();
  const participants = infos.map((p) => {
    const c = cache.classify(p.ref, p.usage);
    const groupId = `${c.layer ?? ''}::${c.namespace}`;
    if (!groups.has(groupId)) {
      const rank =
        p.ref.kind === 'external' ? layerOrder.length + 1
          : p.ref.kind === 'unknown' ? layerOrder.length + 2
            : c.layer !== undefined && layerOrder.includes(c.layer) ? layerOrder.indexOf(c.layer)
              : layerOrder.length;
      // Short band label: the last folder only (the view shows the full path as a tooltip).
      const nsLabel = c.namespace.split('/').filter(Boolean).pop() ?? '(root)';
      groups.set(groupId, {
        id: groupId,
        // the folder alone would read as library code ("lib"); the class view says "No layer" too
        label: c.layer ? `${c.layer} · ${nsLabel}` : p.ref.kind === 'external' ? 'Libraries' : p.ref.kind === 'unknown' ? 'Unresolved' : `No layer · ${nsLabel}`,
        layer: c.layer,
        namespace: c.namespace,
        rank,
      });
    }
    let label: string;
    if (p.isClassLevel) label = p.ref.name;
    // (every object's class is counted above)
    else if (instanceCount.get(p.ref.key)! >= 2 && p.instanceName) label = `${p.instanceName}:${p.ref.name}`;
    else label = `:${p.ref.name}`;
    const participant: Participant = {
      id: p.id,
      classKey: p.ref.key,
      className: p.ref.name,
      instanceName: p.instanceName,
      label,
      kind: p.ref.kind,
      stereotypes: [...c.stereotypes], // FR-7.10 the session may add evidence-based ones: never the classifier's array
      layer: c.layer,
      ...(c.layerReason ? { layerReason: c.layerReason } : {}),
      ...(c.stereotypeReasons?.length
        ? {
            // «seam»: name the interface it was injected as, when the diagram knows it
            stereotypeReasons: c.stereotypeReasons.map((r) =>
              r.stereotype === 'seam' && p.implementsInterface ? { ...r, text: `reached through the injected \`${p.implementsInterface.name}\` in this diagram` } : r,
            ),
          }
        : {}),
      namespace: c.namespace,
      groupId,
      declaration: p.ref.declaration,
      createdByMessageId: p.createdByMessageId,
      implementsInterface: p.implementsInterface,
      ...(p.alternatives ? { alternatives: p.alternatives } : {}),
      ...(p.instances && p.instances > 1 ? { instances: p.instances, ...(p.instancesWhy ? { instancesWhy: p.instancesWhy } : {}) } : {}),
      ...(p.service ? { service: p.service, ...(p.heldAs ? { heldAs: p.heldAs } : {}), ...(p.seamVia ? { seamVia: p.seamVia } : {}) } : {}),
    };
    return { participant, order: p.order };
  });

  // FR-6.4: the root participant's group first, then layer order, no-layer, external, unknown
  // Within a layer, groups follow first appearance (the call flow reads left to right), not
  // folder names (e.g. Core/Interfaces must not precede Core/Services when the service is called first).
  const rootGroup = participants.find((p) => p.participant.id === rootPid)?.participant.groupId;
  const firstSeen = new Map<string, number>();
  for (const p of participants) firstSeen.set(p.participant.groupId, Math.min(firstSeen.get(p.participant.groupId) ?? Infinity, p.order));
  // FR-8.7 the DI container stands first: it builds the objects before the root runs
  const containerGroup = participants.find((p) => CONTAINER_KEYS.has(p.participant.classKey) || p.participant.classKey === PIPELINE_REF.key)?.participant.groupId;
  // FR-18.14 then the middleware the request passes, then the root
  const pipelineGroups = new Set(participants.filter((p) => p.participant.id.endsWith('|middleware')).map((p) => p.participant.groupId));
  const sortedGroups = [...groups.values()].sort(
    (a, b) =>
      Number(b.id === containerGroup) - Number(a.id === containerGroup) ||
      Number(pipelineGroups.has(b.id)) - Number(pipelineGroups.has(a.id)) ||
      Number(b.id === rootGroup) - Number(a.id === rootGroup) ||
      a.rank - b.rank ||
      // (two groups never share a first participant: no further tie-break)
      firstSeen.get(a.id)! - firstSeen.get(b.id)!,
  );
  const groupIndex = new Map(sortedGroups.map((g, i) => [g.id, i]));
  participants.sort(
    (a, b) => groupIndex.get(a.participant.groupId)! - groupIndex.get(b.participant.groupId)! || a.order - b.order,
  );
  return {
    participants: participants.map((p) => p.participant),
    groups: sortedGroups.map(({ rank: _rank, ...g }) => g),
  };
}
