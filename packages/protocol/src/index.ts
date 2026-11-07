/**
 * Shared contract between the editor host (VS Code, Rider, Vim), the
 * editor-agnostic core and the webview UI. Types only — no runtime code, no deps.
 *
 * Conventions:
 * - Positions are 0-based (line, character), like LSP.
 * - File paths are absolute, using forward slashes.
 * - "Keys" are stable identifiers that survive re-analysis (e.g. "src/user.ts#UserService").
 */

// ───────────────────────────── Source locations ─────────────────────────────

export interface Position {
  line: number;
  character: number;
}

export interface SourceRange {
  file: string;
  start: Position;
  end: Position;
}

// ───────────────────────────── Code references ─────────────────────────────

export type ClassKind = 'class' | 'interface' | 'abstract' | 'module' | 'external' | 'unknown';

export interface ClassRef {
  /** Stable key, e.g. "src/services/user-service.ts#UserService", "src/util.ts#<module>", "lib:express". */
  key: string;
  name: string;
  kind: ClassKind;
  declaration?: SourceRange;
}

export interface MethodRef {
  /** Stable key, e.g. "src/services/user-service.ts#UserService.getUser". */
  key: string;
  name: string;
  owner: ClassRef;
  isStatic: boolean;
  /** Range of the method's name identifier. */
  declaration?: SourceRange;
  /** False for interface/abstract/ambient members (nothing to expand). */
  hasBody: boolean;
}

// ───────────────────────────── Sequence diagram ─────────────────────────────

export interface Participant {
  id: string;
  classKey: string;
  className: string;
  /** Receiver name used for disambiguation ("repo"), if known. */
  instanceName?: string;
  /** Display label, already computed by the core: ":UserRepository" or "repo:UserRepository" (FR-6.2). */
  label: string;
  kind: ClassKind;
  /** Without guillemets, e.g. ["service", "singleton"]. */
  stereotypes: string[];
  layer?: string;
  namespace: string;
  /** Id of the group (band) this participant belongs to. */
  groupId: string;
  declaration?: SourceRange;
  /** Set when the participant is created inside the visible diagram (FR-5). */
  createdByMessageId?: string;
  /** When this participant is a user-chosen implementation of an interface (FR-8.2). */
  implementsInterface?: { key: string; name: string };
  /** Evidence-based layer suggestion that differs from `layer` (hint only). */
  layerHint?: LayerHint;
  /** FR-7.8 why it is in its layer: the rule that decided. */
  layerReason?: LayerReason;
  /** FR-7.9 why it carries each stereotype. */
  stereotypeReasons?: StereotypeReason[];
  /**
   * FR-5.6 this lifeline stands for n objects created in mutually exclusive places (one per `return new X`, one
   * per branch): only one of them exists in a run. Absent: one object.
   */
  alternatives?: number;
  /**
   * FR-5.10 this lifeline stands for n objects of a class whose objects are interchangeable (no state of their own),
   * created in several places of the flow (one per component calling a hook that creates it). Absent: one object.
   */
  instances?: number;
  /**
   * Why `instances` objects share this lifeline. Absent: FR-5.10 interchangeable. `value` (FR-5.12): their class cannot
   * change once built, only their values differ. `helper` (FR-5.13, option `mergeHelpers`): objects created in the flow
   * and never stored in a field, one lifeline per class by the reader's choice — they may differ.
   */
  instancesWhy?: 'value' | 'helper';
  /**
   * FR-6.7 one object the DI container makes once (`singleton`, or `scoped`: once per request), or that its class keeps
   * as its only instance (`own`: private constructor, static instance), reached here in several ways (the root,
   * injected fields, parameters, static calls): drawn as one lifeline.
   */
  service?: 'singleton' | 'scoped' | 'own';
  /** FR-6.7 the names of its references here (`_primary`, `_replica`), when they differ. */
  heldAs?: string[];
  /**
   * FR-6.7 of those references, the ones that reach it through an injected interface (`ISiteKeys in Resolver`), when the
   * others do not: no «seam» then — the callers holding the class itself cannot swap it.
   */
  seamVia?: string[];
  /**
   * FR-7.8 the dependency-rule violations it takes part in, in this diagram ("depends on Infrastructure: RequestClient");
   * FR-7.16 one resting on a guessed layer ends in ` (possible: …)`.
   */
  layerViolations?: string[];
  /** FR-17.2: I/O its whole file / type does (the libraries it uses); absent = none known. */
  sideEffects?: SideEffects;
  /** FR-24.6 compared with the base version of the flow: only today's flow reaches it / only the base flow did. */
  diff?: 'added' | 'removed';
  /** FR-24.11 what the reviewed branch did to its class: new, or changed (with the members). */
  change?: ClassChange;
  /**
   * FR-28 layer zoom: this lifeline is a layer (or a band of objects without one), standing for these objects of the
   * flow (in their order). Absent = an object.
   */
  objects?: ZoomedObject[];
  /**
   * FR-28.7 layer zoom with this object's layer opened in place: the lifeline (`key`) that folds it again, and its name.
   * FR-28.8 `alone`: only this object was pulled out of its layer (folding it puts this object back, by its id).
   */
  inLayer?: { key: string; name: string; alone?: true };
  /**
   * FR-28.11 the object view (layer open): the layer lifeline (`key`) this object folds into on its own — the other
   * objects of the layer stay out; its name.
   */
  layerFold?: { key: string; name: string };
}

/** FR-28.10 an object at one end of a call drawn between layer lifelines. */
export interface ZoomEnd {
  /** The object's participant id (`setLayerOpen` pulls it out by this). */
  id: string;
  label: string;
  layer?: string;
}

/** FR-28 an object folded into a layer lifeline. */
export interface ZoomedObject {
  /** The object's participant id (FR-28.8: `setLayerOpen` pulls it out by this). */
  id: string;
  /** The object's participant label (`:UserService`, `repo:UserRepository`). */
  label: string;
  classKey: string;
  className: string;
  declaration?: SourceRange;
}

/** FR-24.11 a class the reviewed branch added (`new`) or changed (members added / changed / removed, base types). */
export interface ClassChange {
  kind: 'new' | 'changed';
  members: MemberChange[];
}

/** FR-24.11 one member of a changed class: a method (by signature), a field, or the class declaration (base types). */
export interface MemberChange {
  kind: 'method' | 'field' | 'declaration';
  /** Method / field name; for `declaration` the class name. */
  name: string;
  change: 'added' | 'changed' | 'removed';
  /** e.g. "JoinAsync(Guid, CancellationToken): Task", "_client: IFreightApi", "implements IParcelApiClient (was IShippingApi)". */
  text: string;
  /** The member's lines of the diff (around its first changed line). */
  hunk?: DiffLine[];
  /** Its first changed line in the current file (1-based); absent for a removed member. */
  line?: number;
}

/** FR-17 kinds of I/O: database, cache / key-value store (Redis, Memcached), HTTP / network, file system, message queue, cloud SDK, child process. */
export type SideEffectKind = 'db' | 'cache' | 'http' | 'file' | 'queue' | 'cloud' | 'process';

/** FR-17 I/O a call or a participant does, with the evidence (for the tooltip). */
export interface SideEffects {
  /** In a fixed order: db, cache, http, file, queue, cloud, process. */
  kinds: SideEffectKind[];
  /** A few lines of evidence: "DB: DbContext.SaveChangesAsync", "HTTP: HttpClient.GetAsync (in StripeGateway.Charge)". */
  evidence: string[];
  /** Messages only: none of it is in the called method's own body, only further down (already analysed calls). */
  below?: boolean;
}

export interface LayerHint {
  suggested: string;
  reasons: string[];
  /** FR-7.11 what to do instead of moving the file (a preset's convention: "in FSD, backend calls belong in an `api/` segment"). */
  advice?: string;
  /** FR-7.11 moving the file to `suggested` is not the fix (its folder follows a convention): no "Move to …" offered. */
  noMove?: true;
}

/** FR-7.9 why a box carries a stereotype: its source (name, decorator, folder, usage in this diagram, a config rule). */
export interface StereotypeReason {
  stereotype: string;
  /** "name ends in `Service`", "rule 1 in .seqcall.json: path `app/Jobs/**`", "called statically in this diagram". */
  text: string;
  /** Only a folder name decided (dropped when a configured rule matched). */
  weak?: boolean;
  /** Depends on how this diagram reaches the object («static», «seam»): another flow may differ. */
  inThisDiagram?: boolean;
}

/** FR-7.12 what "Move to layer" can cover: this file, its folder, or every class named like it, with the file count. */
export interface LayerScope {
  kind: 'file' | 'folder' | 'name';
  /** The glob the rule gets (relative to the project root): `app/Managers/OrderManager.php`, `app/Managers/**`, `**\/*Manager.php`. */
  glob: string;
  /** Files it covers now. */
  files: number;
}

/**
 * FR-7.8 why a class is in its layer: the classifier rule that decided (the same rule list for every
 * class, first match wins), how strong that signal is, and the earlier rules that did not apply.
 */
export interface LayerReason {
  /** `evidence` (FR-7.13): nothing declared a layer, the code decided (renders JSX → Presentation, does I/O → Infrastructure). */
  rule: 'config' | 'preset' | 'folder' | 'inbound-adapter' | 'entry-file' | 'name' | 'role-folder' | 'evidence' | 'test' | 'none';
  /** "role folder `Services/`", "name ends in `Client`", "rule 2 in .seqcall.json: `app/Http/**`". */
  text: string;
  /** weak: only a name or an ambiguous role folder decided; strong: the config or an explicit layer folder. */
  strength: 'strong' | 'weak';
  /** The rules checked before it that did not apply, in order ("no rule in .seqcall.json", …). */
  notApplied: string[];
  /**
   * FR-7.11 lines of `notApplied` that are notes, not misses: a rule that recognised the file and gave it no layer on
   * purpose (`shared/lib/` in the FSD preset). Shown with `·` instead of `✗`. Optional.
   */
  noted?: string[];
  /** The file it was judged by (relative to the project root) and the folders in it that decided, as written. */
  path?: string;
  folders?: string[];
}

export interface ParticipantGroup {
  id: string;
  /** e.g. "Application · src/services" */
  label: string;
  layer?: string;
  namespace: string;
  /**
   * FR-28.11 in the object view (no layer zoom): the layer this band belongs to (`key` = its lifeline key, as
   * `setLayerOpen` takes it) — the band's ⊖ folds the whole layer into one lifeline. Absent while zoomed.
   */
  fold?: { key: string; name: string };
}

export type MessageKind = 'found' | 'call' | 'self' | 'create';

export interface PolymorphicInfo {
  interfaceKey: string;
  interfaceName: string;
  implementations: ClassRef[];
  /** Key of the currently selected implementation, if any. */
  selectedKey?: string;
  /** FR-8.6 the implementation the DI container gives on this path, and where that binding is declared. */
  bound?: { classKey: string; at: SourceRange; contextual: boolean };
  /** FR-8.6 keyed registrations of the abstraction (C# `AddKeyedSingleton<I, B>("key")`): chosen at run time by key. */
  keyed?: { classKey: string; key: string; at: SourceRange; kind?: 'key' | 'condition' }[];
}

export interface Message {
  /** Stable path id: parentId + "/" + ordinal + ":" + methodName. Root found message id is "root". */
  id: string;
  parentId: string | null;
  depth: number;
  kind: MessageKind;
  /** Participant id; null for the found message. */
  from: string | null;
  to: string;
  methodName: string;
  /** Key of the resolved target method (absent for unknown calls). */
  methodKey?: string;
  /** FR-1.19 why the target is unknown, for the hover card (`zodSchema` is typed `any` …). */
  unresolved?: string;
  /** Key of the class declaring the target method (used for hide filters). */
  classKey?: string;
  className?: string;
  /** Raw argument source texts (untruncated; the view truncates). */
  args: string[];
  /** Call expression range. For the found message: the root method declaration. */
  callSite?: SourceRange;
  /**
   * FR-1.13: the call invokes this delegate / function parameter. With `methodKey` it was resolved
   * to the function the caller passed; without, it is drawn as a self-call (lambda or unknown caller).
   */
  viaParameter?: string;
  /** FR-18.14 with `viaParameter`: a middleware's `$next` — the request goes on to the next step (not expanded here). */
  continuesPipeline?: true;
  /** With `viaParameter` and unresolved: the caller passed an inline lambda. */
  viaLambda?: boolean;
  /**
   * FR-19.18 with `viaParameter` and resolved to a method reference: the id of the call whose arguments handed the
   * reference over (passed on through more calls before it runs: the first of them).
   */
  handedBy?: string;
  /** FR-19.1 the call leaves its loop (in a `return` / `throw`, or one follows it): it runs at most once per loop. */
  leavesLoop?: true;
  /**
   * FR-1.13: with `viaParameter`, the parameter's declared named type (a function type alias /
   * interface / delegate type) — the port the sender depends on; the target realizes it.
   */
  port?: { key: string; name: string };
  /**
   * FR-24.4 diff marks while a review is on: the call is on a changed line; the target method was added / changed.
   * FR-24.6 compared with the base version of the flow: `added` = a call the base flow does not make; `changed` = a
   * call both make, on an edited line (arguments, condition); `removed` = a call only the base flow makes (a ghost:
   * not expandable, its `callSite` is in the base version of the file). `before`: a `changed` call that reached
   * another method in the base version (`ParcelApiClient.EnrollInCouponAsync`). `inside` (FR-24.9): a collapsed
   * call below which this many of the flow's changes are (FR-24.15: changes, not changed methods), revealed with `revealChange`.
   */
  diff?: { call?: boolean; method?: 'added' | 'changed'; status?: 'added' | 'changed' | 'removed'; hunk?: DiffLine[]; before?: string; inside?: number; /** FR-28 / FR-24.9 zoomed to layers: changes of the calls folded into this one (inside its layer), each a step of the review — ▶ opens the layer. */ folded?: number;
    /** FR-24.15 the same call, only its signature changed (no `before`: it reaches the same class). */
    signature?: true;
    /**
     * a call through an interface whose method the branch changed, while the implementation drawn did not
     * change: a step of the tour of its own, after the code changes.
     */
    declared?: 'added' | 'changed';
    /**
     * FR-24.15 how many of the flow's changes this message stands for (own + below + folded + in other implementations);
     * the counts of a diagram add up to its `reviewTotal` at every zoom level and choice. 0: shown already by an earlier call.
     */
    count?: number;
    /** FR-24.15 an interface call: changes of the flow in implementations other than the one shown (▶ switches). */
    elsewhere?: { classKey: string; className: string; count: number }[];
    /** FR-24.15 the numbers (1-based, of `reviewTotal`) of the changes this message shows; `method`: the change of the method it reaches. */
    positions?: { n: number; method?: true }[];
    /** FR-24.15 the numbers of the changes it holds (below it, in another implementation, folded into it when zoomed). */
    held?: number[];
  };
  /** Declaration of the method the activation bar stands for (chosen implementation if any); not for library targets. */
  targetDeclaration?: SourceRange;
  isAsync: boolean;
  isLibrary: boolean;
  expandable: boolean;
  expanded: boolean;
  /** Target is already on the expansion path (FR-3.4). */
  recursive: boolean;
  polymorphic?: PolymorphicInfo;
  /** FR-9.4: where the call's result goes (`user = findUser(id)`, `↩ findUser(id)`); absent = unused / unknown. */
  result?: CallResult;
  /** FR-5.6 a creation that is one of n mutually exclusive ones drawn on one lifeline (index 1-based). */
  alternative?: { index: number; count: number; why: 'return' | 'branch' };
  /** FR-5.13 a creation on a lifeline of merged helper objects: which of them it makes (1-based, `«create» #2`). */
  instance?: number;
  /** FR-1.18 not written as a call: the read of a getter / the assignment to a setter (`«get» events`). */
  accessor?: 'get' | 'set';
  /** FR-1.20 a JSX element of a project component (`«render» ShopTab(widgets)`; `args` are the props' names). */
  render?: true;
  /** FR-9.5: declared return type (awaited when the call is awaited), e.g. "User"; absent for void. */
  returnType?: string;
  /**
   * FR-5.11 the method is declared in a project base class of the receiving object (`ParcelApiClient` running
   * `BaseHttpClient.PostAsync`, also `base.X()` / `super.x()` / `parent::x()`): drawn with ↑; the class diagram lists it there.
   */
  inheritedFrom?: { key: string; name: string };
  /** FR-11.7 a "don't expand" rule matches the call (the rule's id): bulk expands leave it folded (⊡ instead of ⊕). */
  noExpand?: string;
  /** FR-3.6: importance after a smart expand (score and the reasons behind it); absent otherwise. */
  importance?: Importance;
  /**
   * FR-17.1: I/O done by the called method's own body (calls hidden as library calls) and, while
   * the message is collapsed, by already analysed calls below it. Absent = none known.
   */
  sideEffects?: SideEffects;
  /**
   * FR-28 layer zoom: the calls inside the receiving layer that this call folds away (every call below it that stays
   * in one layer, until the next layer crossing): how many, their `Class.method` names (in order, a few), and how
   * many of them are still collapsed (`expand` on this message opens them). Absent = none.
   */
  /**
   * FR-28.10 layer zoom: the objects behind the lifelines this call is drawn between — set for an end a layer lifeline
   * stands for (absent outside the zoom, for an object drawn as itself, and for the root's sender).
   */
  objects?: { from?: ZoomEnd; to?: ZoomEnd };
  folded?: {
    count: number;
    names: string[];
    expandable: number;
    /** FR-23.6 every folded call (for Find): its id, `Class.method`, the object it goes to (pull it out: `setLayerOpen`). */
    calls?: { id: string; name: string; participant: string }[];
  };
}

/** FR-9.4 where a call's result goes: assigned (target as written, `this.` dropped) or returned. */
export type CallResult = { kind: 'assign'; target: string; operator: string } | { kind: 'return' };

/** FR-3.6 importance of a call: ↑/↓ reasons ("crosses Application → Infrastructure", "mapping"). */
export interface Importance {
  score: number;
  reasons: string[];
  /** Low importance: the view dims the message. */
  low: boolean;
}

/**
 * Combined fragment kinds (FR-1.10): `alt` (if/else chains, switch, conditional expression),
 * `opt` (a single guarded operand), `loop`, `try` (try block + catch operands), `callback` (calls
 * inside a lambda passed to a library function that is not an iteration, FR-1.11).
 */
export type FragmentKind = 'alt' | 'opt' | 'loop' | 'try' | 'callback';

export interface FragmentOperand {
  /** Guard source text without brackets ("user.isActive", "each u of users", "else", "catch"). Untruncated. */
  guard?: string;
  /** Where the guard/condition is in the code (clicking the guard navigates there). */
  range?: SourceRange;
  /**
   * First and last *direct child* messages of the fragment's owner inside this operand. The
   * operand spans from the first message to the end of the last message's nested subtree.
   * Either may be the id of a collapsed nested fragment (its one-row stub), see `Fragment.collapsed`.
   */
  firstMessageId: string;
  lastMessageId: string;
  /** FR-1.17 a catch operand: what happens to the error ("logged, swallowed", "↩ null"); absent when it is rethrown. */
  outcome?: string;
  /** FR-1.17 the error ends here — not rethrown, not turned into a value (drawn as a warning). */
  swallowed?: boolean;
  /** FR-1.22 `alt` only: the operand's index in the construct (the case to follow). */
  case?: number;
}

/**
 * FR-1.17 a catch clause of a drawn `try` that has no visible calls, so it is no operand: one row at the bottom of
 * the frame says what it does with the error. Clauses that rethrow are left out (nothing is hidden there).
 */
export interface CatchRow {
  /** "catch JsonException", "catch". */
  guard: string;
  /** "logged, swallowed", "↩ null", "logged, ↩ (default, …)", "skipped"; '' for a clause that rethrows (shown only folded). */
  outcome: string;
  swallowed: boolean;
  range?: SourceRange;
  /** FR-3.11 the clause's calls folded by Smart expand (an error path). */
  errorPath?: ErrorPathFold;
}

/** FR-3.11 an error branch Smart expand folded: shown again by `showErrorPath` with `key`. */
export interface ErrorPathFold {
  /** `<ownerMessageId>#<fragment construct id>#<operand>`. */
  key: string;
  /** Direct calls folded away. */
  calls: number;
  /** Why it is an error path ("catch DbException", "throws NotFound", "[!result.ok]"). */
  reason: string;
}

/** A combined fragment around messages sent within one method body (FR-1.10). */
/** FR-16 kind of entry point: where a flow starts. */
/** `route` (FR-16.6): a client route of a web UI (React); `ui` (FR-16.7): where a UI app is mounted. */
export type EntryPointKind = 'http' | 'route' | 'ui' | 'cli' | 'job' | 'handler' | 'test';

/**
 * FR-16.4 the entry-point list as every list shows it (the VS Code sidebar, the panel's ⌂ list), built once by the
 * core (`entryPointTree`): projects (FR-16.8; `tests`: several test projects together), kinds, folders of a long
 * group (`leaf`: a class / file), files of module-level calls (FR-16.5), entries by their index in the list.
 */
export type EntryPointListNode =
  | { type: 'project'; name: string; tests?: true; children: EntryPointListNode[] }
  | { type: 'group'; kind: EntryPointKind; children: EntryPointListNode[] }
  | { type: 'folder'; label: string; path: string; leaf?: true; children: EntryPointListNode[] }
  | { type: 'file'; file: string; children: EntryPointListNode[] }
  | { type: 'entry'; index: number };

/** FR-16.1 a place where a flow starts (an HTTP endpoint, `main`, a job, a message handler, a test). */
export interface EntryPoint {
  kind: EntryPointKind;
  /** HTTP: "GET /users/:id"; route: "/orders/:id"; ui: "#app"; otherwise "Class.method". */
  label: string;
  /** HTTP verb (upper case) for kind http. */
  verb?: string;
  /** What made it an entry point: "BackgroundService", "MediatR handler", "xUnit", "module-level call". */
  detail?: string;
  /** FR-16.5 a module-level call: the file it runs in (project-relative); the lists group these by file. */
  file?: string;
  /**
   * FR-16.8 the project it belongs to when the root holds several (a solution's .csproj, a monorepo's package.json,
   * a Composer package): set only then; the lists put the projects first.
   */
  project?: string;
  /** FR-18.13 an HTTP route's name (Laravel `->name('api.user')`, with its groups' `as` prefixes): tests call `route('…')`. */
  routeName?: string;
  method: MethodRef;
  /** FR-18.14 HTTP: the middleware the request passes before the action, in execution order (absent: none). */
  middleware?: RouteMiddleware[];
  /** FR-19.23 not an entry point: a method no entry point reaches, scanned for design issues as if it were one. */
  unreached?: true;
  /**
   * FR-19.23 why it was scanned, as the list names it: `no entry point reaches it: only tests call it` (its group in the
   * unreachable-code list, FR-31, as ∅ names it), or `not opened by any entry point's flow` (reached, but no flow opened it).
   */
  unreachedWhy?: string;
}

/** FR-18.14 one middleware of a route, as the framework resolves it. */
export interface RouteMiddleware {
  /** As registered, after evaluation: `'auth'`, `'api'`, `'App\\Http\\Middleware\\RequireFeature:refunds,403'`. */
  name: string;
  /** Fully qualified class when `name` is (or resolves to) a class. */
  className?: string;
  /** The parameters after `:` (`RequireFeature:refunds,403` → `['refunds', '403']`). */
  params?: string[];
  /** The class's `handle` method, when it has a body in the project. */
  method?: MethodRef;
  /** Where it is attached: the `->middleware(…)` call, the group's `'middleware'` key. */
  at: SourceRange;
  /** `group`: from an enclosing route group (or the mount of the route file); `route`: on the route itself. */
  source: 'route' | 'group' | 'global' | 'controller';
  /** The alias / group name it was resolved from (`auth.api`, `api`). */
  via?: string;
}

/**
 * FR-1.15 an early exit of an activation: a `return` / `throw` that is not the method's last step,
 * drawn as a small muted marker (`↩ [!user]`, `↯ [!valid] ValidationException`) on the owner's
 * activation bar, in its own half-height row.
 */
export interface ExitMarker {
  /** `<ownerMessageId>!exit<n>` (`!branch<n>`); usable as an operand boundary in `fragments`. */
  id: string;
  ownerMessageId: string;
  /** `branch` (FR-3.11): an error branch Smart folded that has no exit of its own — the marker stands for it. */
  kind: 'return' | 'throw' | 'branch';
  /** Condition of the innermost enclosing construct when that construct is not drawn as a frame. */
  guard?: string;
  /** throw: the exception type (`ValidationException`), or the thrown expression. */
  exception?: string;
  /** The return / throw statement. */
  range: SourceRange;
  /** Next visible direct child of the owner (message, minimized fragment or exit id); absent = end of the activation. */
  beforeId?: string;
  /** FR-3.11 the calls of its branch folded by Smart expand (the marker is what is left of the error path). */
  errorPath?: ErrorPathFold;
  /** FR-3.11 `branch` of a catch whose try frame Smart dropped: what it does with the error (FR-1.17 "logged, swallowed"). */
  outcome?: string;
  /** FR-3.11 with `outcome`: the error ends there (drawn as a warning). */
  swallowed?: boolean;
}

export interface Fragment {
  /**
   * `<ownerMessageId>#<kind><nesting>@<ordinal of the construct's first call>` — unique in the
   * diagram and, like message ids, stable across edits elsewhere in the file (FR-1.12).
   */
  id: string;
  kind: FragmentKind;
  /** The message whose activation contains the fragment ("root" for the root method body). */
  ownerMessageId: string;
  /** Enclosing fragment of the same owner, if nested. */
  parentId?: string;
  /** Non-empty operands in order (operands without visible messages are dropped). */
  operands: FragmentOperand[];
  /** The construct in the code (clicking the tag navigates there). */
  range?: SourceRange;
  /**
   * FR-1.12: minimized by the user — drawn as a one-row stub (tag, first guard, call count); its
   * calls are not in `messages` (nor in the class diagram). The single operand points at the
   * fragment's own id.
   */
  collapsed?: boolean;
  /** Collapsed only: direct calls folded away. */
  hiddenCount?: number;
  /**
   * Collapsed only: the next visible direct child of the owner (a message id or another collapsed
   * fragment's id) the stub is drawn before; absent = at the end of the owner's activation.
   */
  beforeId?: string;
  /** FR-1.17 `try` only: catch clauses without visible calls that handle the error, drawn as rows at the bottom. */
  catches?: CatchRow[];
  /**
   * FR-1.22 `alt` only: the user follows one case — the one operand drawn; the other cases' calls are not in
   * `messages` (nor in the class diagram). `otherCases`: how many cases with calls are left out.
   */
  followed?: { otherCases: number };
}

/**
 * A filter rule (FR-11): hides the matching calls, or with `noExpand` (FR-11.7) keeps them drawn but leaves them
 * folded on Expand all / Expand all below / Smart expand (a click on the call still expands it).
 */
export type HideFilter =
  | { id: string; kind: 'methodName'; methodName: string; noExpand?: true }
  | { id: string; kind: 'classMethod'; classKey: string; className: string; methodName: string; noExpand?: true }
  | { id: string; kind: 'class'; classKey: string; className: string; noExpand?: true }
  /** FR-11.8 every class whose name matches a glob (`*Mapper`). */
  | { id: string; kind: 'classPattern'; pattern: string; noExpand?: true }
  /** FR-11.8 every class with this stereotype (`static`, `logger` …, without guillemets). */
  | { id: string; kind: 'stereotype'; stereotype: string; noExpand?: true };

/** HideFilter without id, as requested by the view. */
export type HideFilterSpec =
  | { kind: 'methodName'; methodName: string; noExpand?: true }
  | { kind: 'classMethod'; classKey: string; className: string; methodName: string; noExpand?: true }
  | { kind: 'class'; classKey: string; className: string; noExpand?: true }
  | { kind: 'classPattern'; pattern: string; noExpand?: true }
  | { kind: 'stereotype'; stereotype: string; noExpand?: true };

export interface HiddenFilterInfo {
  filter: HideFilter;
  /** Number of messages currently suppressed by this filter in the current diagram (`noExpand`: drawn calls it matches). */
  hiddenCount: number;
}

export interface DiagramOptions {
  showArguments: boolean;
  maxArgumentLength: number;
  showLibraryCalls: boolean;
  followCursor: boolean;
  /** Draw combined fragments (alt/opt/loop/try) around conditional and repeated calls (FR-1.10). Absent = true. */
  showFragments?: boolean;
  /** FR-18.14: before an entry point's action, the step through what the framework runs first (middleware). Absent = true. */
  showPipeline?: boolean;
  /** List callers in test files too in "Show callers" (FR-4.4). Absent = false. */
  includeTestCallers?: boolean;
  /**
   * FR-12.12: the class diagram also shows the project types the shown methods reference
   * (signatures, enum constants, static members, casts, generic arguments …), not only calls.
   * Absent = false (costs one extra analysis request per shown method).
   */
  showTypeUses?: boolean;
  /** FR-9.4: show where results go (`user = findUser(id)`, `↩`). Absent = true. */
  showResults?: boolean;
  /** FR-9.8: the short return type after a call whose value the label does not show (`isValid(v): boolean`). Absent = true. */
  showReturnTypes?: boolean;
  /**
   * FR-5.13 one lifeline per helper type: objects of one class created in the drawn calls and never stored in a field
   * share one lifeline (`×n`, each «create» numbered). Absent = false (FR-5.5: every creation is its own object).
   */
  mergeHelpers?: boolean;
  /** FR-17: I/O badges (DB, HTTP, FILE …) on messages and participants. Absent = true. */
  showSideEffects?: boolean;
  /** FR-19: design findings (⚠ N in the toolbar / class legend). Absent = true. */
  showFindings?: boolean;
  /** FR-24.11 the review's marks on the diagrams (calls, objects, classes, members). Absent = true. */
  showReviewMarks?: boolean;
  /** FR-10.3: tidy up (FR-10.2) after every expand / collapse and after hiding / unhiding. Absent = true. */
  autoTidy?: boolean;
  /**
   * FR-17.5: after each render, analyse the bodies below collapsed calls in the background (bounded)
   * so their I/O badges do not depend on what was explored. Absent = true.
   */
  scanSideEffects?: boolean;
  /**
   * FR-28 layer zoom: one lifeline per layer (objects without a layer keep their band), only the calls that cross
   * a layer drawn, the calls inside a layer folded into them (`+n`); the class diagram shows one package per layer.
   * Absent = false.
   */
  layerZoom?: boolean;
  /**
   * FR-3.12 ↯ Fold errors: the error branches (catch, a branch that throws, a guard clause returning early) fold into
   * one-line markers at every depth, whatever is expanded; ⊕ on a marker shows that branch. Absent = true.
   */
  foldErrors?: boolean;
  /** FR-28.7 while zoomed: the layers (lifeline keys, `layer:Application`) opened in place — drawn as their objects / classes. */
  openLayers?: string[];
  /** FR-28.8 objects (participant ids) pulled out of their folded layer onto their own lifeline. */
  openObjects?: string[];
  /**
   * FR-28.11 not zoomed: the layers (lifeline keys) folded in the object view — one lifeline each, the other layers'
   * objects drawn as they are. Layers not listed (also those a later expand reaches) stay open.
   */
  foldedLayers?: string[];
}

export interface SequenceDiagram {
  root: MethodRef;
  /** Ordered: by group order, then first appearance. */
  participants: Participant[];
  groups: ParticipantGroup[];
  /** Pre-order flattened tree (render order). messages[0] is the found message. */
  messages: Message[];
  hiddenFilters: HiddenFilterInfo[];
  options: DiagramOptions;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Layers a class can be moved to ("Move to layer"), in architectural order. */
  layerChoices?: string[];
  /**
   * Combined fragments of the visible messages (FR-1.10), outer before inner, in message order.
   * Only fragments with at least one visible message; absent when `options.showFragments` is false.
   */
  fragments?: Fragment[];
  /** FR-1.15 early exits of the drawn activations; absent when `options.showFragments` is false. */
  exits?: ExitMarker[];
  /**
   * FR-16.3 the entry points the root method is (HTTP route, command, job, test …): the one the diagram
   * was opened from first, then the others already known. Drawn as a tag at the found message's gate.
   */
  entryPoints?: EntryPoint[];
  /**
   * FR-3.3 set on the render right after an expand-everything that could not open all calls: it stopped at the
   * message budget or the depth limit, `folded` calls (in its scope) are still collapsed.
   */
  expandNotice?: ExpandNotice;
  /** FR-24.15 during a review: the flow's changes, the same number whatever is expanded, chosen or zoomed (the messages' `diff.count` add up to it). */
  reviewTotal?: number;
  /** FR-25.3 the layer config in use is a shared diagram's, not the project's file (until `useSharedConfig` off). */
  borrowedConfig?: BorrowedConfig;
  /** FR-19 design findings in the visible flow (absent when there are none or `options.showFindings` is false). */
  findings?: Finding[];
  /** issues of this flow inside folded calls (the fully expanded flow has them, the shown calls not). */
  issuesBelow?: IssuesBelow;
  /** FR-32.2 the root is an entry point: what its whole flow touches (absent until the background scan has it, and with I/O off). */
  outcome?: FlowOutcome;
  /** FR-19.22 what .seqcall.json silences (listed in the ⚠ menu, with Stop ignoring); absent when nothing. */
  ignored?: IgnoredPatterns;
}

/** FR-19.22 the project's silenced patterns: `findings.ignore` and `layerHints.ignore` (only non-empty lists). */
export interface IgnoredPatterns {
  findings?: string[];
  layerHints?: string[];
}

/**
 * FR-19 design findings: short, clickable markers for likely design flaws in what the diagram shows
 * (not a metrics dashboard). The evidence is the messages / classes / relations to highlight.
 */
/** `layer-violation`: FR-24 a dependency-rule violation reported as a finding (review of a branch). */
export type FindingKind = 'io-in-loop' | 'io-in-domain' | 'layer-ping-pong' | 'cyclic-collaboration' | 'dependency-cycle' | 'too-many-dependencies' | 'god-class' | 'layer-violation';

export interface Finding {
  /** Stable within one render (kind + evidence). */
  id: string;
  kind: FindingKind;
  /** One line: "I/O in a loop: CustomerRepository.findById (DB)". */
  title: string;
  /** Why it matters / what was seen (hover, second line). */
  detail?: string;
  messageIds?: string[];
  classKeys?: string[];
  relationIds?: string[];
  /** FR-19.10 what `findings.ignore` matches to silence this finding (`Class.method` / a class name); absent = kind-wide only. */
  ignoreKey?: string;
  /** FR-19.14 the concrete case, one line each: what the classes are, which calls / fields / type uses close a cycle. */
  evidence?: string[];
  /** FR-7.16 `layer-violation`: it rests on a guessed layer, one line per guessed end (as `ClassRelation.possible`). */
  possible?: string[];
}

/** FR-19.9 a finding of the project-wide scan: where it was found (the first entry point reaching it). */
export interface ProjectFinding {
  finding: Finding;
  entryPoint: EntryPoint;
  /** How many other entry points reach the same finding. */
  others?: number;
  /** FR-19.9 project-relative files of the evidence (its classes, the senders / receivers of its messages). */
  files?: string[];
}

/**
 * FR-31.1 why no entry point reaches a method: nothing in the project calls it (`no-callers`), only methods no entry
 * point reaches call it (`unreached-callers`), or only test code calls it (`tests-only`).
 */
export type UnreachableReason = 'no-callers' | 'unreached-callers' | 'tests-only';

/** FR-31.1 a project method no entry point reaches (tests excluded). */
export interface UnreachableMethod {
  method: MethodRef;
  reason: UnreachableReason;
  /** References found in the project (calls, passed as an argument), test code included. */
  callers: number;
  /**
   * FR-31.2 why the framework may call it although the project does not: its class extends / implements a library
   * type, a magic method (`__toString`). Listed apart: probably not dead.
   */
  framework?: string;
  /**
   * FR-31.3 calls of this name the analysis could not resolve (an untyped receiver, a facade, a template it does not
   * parse): it may be called. Listed apart.
   */
  unresolved?: number;
  /** FR-31.3 with `unresolved`: called from this listed method (`Class.method`), whose name the unresolved calls have. */
  via?: string;
}

/** FR-31.1 the project-wide unreachable-code scan. */
export interface UnreachableScan {
  methods: UnreachableMethod[];
  /** Project methods considered (with a body, outside test code). */
  total: number;
  /** Of those, reached from an entry point. */
  reached: number;
  /** Entry points walked from (tests excluded); 0: a library — nothing is listed. */
  entryPoints: number;
  /**
   * Methods the walk did not reach although a reached method refers to them (a reference the walk does not follow:
   * stored in a variable, an array …). Not listed: they are probably reached.
   */
  missed: number;
  /** The walk hit its method limit: more may be reached than it saw (the list may hold live code). */
  truncated: boolean;
  /** FR-31.4 methods `unreachable.ignore` of the project config names (walked from, not listed). */
  ignored?: number;
  /** The code changed while the walk ran: the list mixes old and new code (not kept; ↻ checks again). */
  changed?: true;
  /** The code changed since the walk (kept across saves): a method added, newly called or no longer called shows after ↻. */
  stale?: true;
}

/** FR-3.3 why "Expand all" stopped before everything was open. */
export interface ExpandNotice {
  /** `smart`: FR-3.10 Smart expand reached its cap; `folded` = the calls still worth opening. */
  reason: 'messages' | 'depth' | 'smart';
  messages: number;
  /** Deepest expanded level. */
  depth: number;
  /** Calls still collapsed (⊕) in the expanded scope. */
  folded: number;
  limit: number;
}

export interface CallerInfo {
  id: string;
  /** The method containing the reference. */
  enclosing: MethodRef;
  /** Range of the call expression. */
  range: SourceRange;
  /** One-line code preview of the call. */
  preview: string;
  /** The reference is in a test file (`testFiles` globs); hidden unless `includeTestCallers` (FR-4.4). */
  inTest?: boolean;
  /**
   * FR-4.5: the method is not called here but passed as an argument (method group / function
   * reference); `range` is the call that receives it (which invokes it through a parameter, FR-1.13).
   */
  passed?: boolean;
}

/** FR-34 memory of a process Seqcall started for a project (the C# sidecar), as the process reports it. */
export interface ProcessMemory {
  pid: number;
  /** Bytes in RAM (working set / resident set). */
  workingSet: number;
  /** Bytes in the .NET managed heap (part of the working set). */
  managedHeap?: number;
}

/**
 * FR-33 what the editor's hover says about the code under the cursor: a call (what runs, its I/O) or a method's
 * name (who reaches it, its I/O). Only what the analysis knows within the hover's time budget; a part still being
 * worked out is named in `pending` (the next hover has it).
 */
export interface CodeInfo {
  /** The method the cursor is in (on a call) or on (its name). */
  method: MethodRef;
  /** The cursor is on a call in `method`. */
  call?: CodeCallInfo;
  /** On a method's name: the entry points its callers lead to (FR-22). */
  reach?: CodeReach;
  /** On a method's name: the last unreachable-code scan lists it (FR-31), in the list's words ("only tests call it"). */
  unreachable?: string;
  /** On a method's name: the I/O its body does, itself or below (FR-17). Absent: none found. */
  io?: SideEffects;
  /** Parts not worked out within the time budget (still running). */
  pending?: ('reach' | 'io')[];
}

export interface CodeCallInfo {
  /** The called method as written (`IOrderRepository.save`); absent for an unresolved call. */
  target?: MethodRef;
  /**
   * What runs when the target has no body: the implementation the DI container binds (FR-8.6), the object created in
   * the same method (`new X()` then `x.m()`), the class's own override (`this.m()`), or the only implementation.
   */
  runs?: { method: MethodRef; why: 'container' | 'created' | 'self' | 'only-implementation'; at?: SourceRange };
  /** No single implementation known here: some of them (up to 5), `more` the rest. */
  candidates?: ClassRef[];
  more?: number;
  /** The receiver is a parameter: the caller decides which object it is. */
  fromCaller?: boolean;
  /** FR-8.6 keyed / conditional registrations: chosen at run time. */
  keyed?: { className: string; key: string }[];
  /** The I/O the call does (a library call) or that runs below it (FR-17). */
  io?: SideEffects;
}

export interface CodeReach {
  /** Entry points the callers lead to (not tests), up to 5. */
  entryPoints: EntryPoint[];
  /** Further entry points not listed. */
  more: number;
  /** Test methods among the callers. */
  tests: number;
  /** A walk limit cut some paths: there may be more. */
  cut: boolean;
  /**
   * FR-33.7 every entry point the callers lead to (the listed ones first, in the same order), each with its shortest
   * path down to the method, as `openPath` steps.
   */
  routes?: { entryPoint: EntryPoint; steps: CallPathStep[] }[];
}

/**
 * FR-22 paths to here: a method on the call paths leading to the target, as a reverse tree (the root
 * is the target, `callers` are the methods calling it, up to entry points).
 */
export interface CallPathNode {
  method: MethodRef;
  /** The call in this method leading to its parent (towards the target); absent at the root. */
  call?: {
    range: SourceRange;
    /** One-line code preview of the call. */
    preview: string;
    /** FR-4.5: the parent is passed as an argument to this call (which invokes it). */
    passed?: boolean;
    /** Calls from this method to the parent (the first one is `range`). */
    count?: number;
  };
  /** The method is in a test file. */
  inTest?: boolean;
  /** FR-16 the entry points this method is (routes, commands, jobs, handlers, tests). */
  entryPoints?: EntryPoint[];
  /**
   * Why the walk stops here: `entry` — an entry point; `top` — nothing in the project calls it;
   * `test` — test code; `limit` — the depth / size limit cut the walk here.
   */
  end?: 'entry' | 'top' | 'test' | 'limit';
  callers?: CallPathNode[];
}

/** FR-22 one path, from its start (an entry point) down to the target: what `openPath` opens. */
export interface CallPathStep {
  methodKey: string;
  /** The call in this method to the next step's method (absent on the last step, the target). */
  call?: { range: SourceRange; passed?: boolean };
}

/**
 * FR-23 a call found below a collapsed message by the find bar: the path from that message down to
 * the call, expanded on demand (`revealSearchHit`).
 */
export interface SearchHit {
  /** The visible, collapsed message below which the call is. */
  anchorId: string;
  /** The methods from the anchor's method down to the one making the call; the last step's `call` is the hit. */
  steps: CallPathStep[];
  /** `Class.method` of each step (for display). */
  labels: string[];
  hit: { label: string; range: SourceRange; isLibrary?: boolean };
}

/** FR-24 a method the branch changed. */
export interface ReviewMethod {
  method: MethodRef;
  /** `added`: its declaration line is new; `changed`: lines of its body changed. */
  status: 'added' | 'changed';
  /** Changed lines (1-based) in the method's file. */
  lines: number[];
  /** Entry points that reach it (tests excluded), each with the path to open (start first). */
  reachedFrom: { entryPoint: EntryPoint; steps: CallPathStep[] }[];
  /** Tests that reach it. */
  tests: number;
  /** The walk up the callers stopped at its limits (more may reach it). */
  truncated?: boolean;
  /** Not walked up the callers at all (too many changed methods): who reaches it is unknown, not "nobody". */
  notWalked?: boolean;
}

/** FR-24 a design finding or layer violation in a flow the branch changes. */
export interface ReviewIssue {
  finding: Finding;
  /** `changed-lines`: its evidence (a call, a field) is on a line the branch added or changed; `changed-class`: in a class the branch changed. */
  where: 'changed-lines' | 'changed-class';
  /** The flow it was found in: an entry point, else the changed method itself. */
  entryPoint?: EntryPoint;
  methodKey?: string;
  /** Where the evidence is (project-relative file, 1-based line). */
  at?: { file: string; line: number };
}

/** FR-24 review of the current branch against a base. */
/** FR-24.13 what a review can compare with (the picker's lists). Dates in ms. */
export interface GitRefs {
  current?: string;
  upstream?: string;
  /** The usual target of a pull request: develop, else main / master. */
  target?: string;
  branches: { name: string; remote: boolean; date: number; hash: string; subject: string }[];
  tags: { name: string; date: number; hash: string }[];
  /** The last commits of HEAD. */
  commits: { hash: string; date: number; author: string; subject: string }[];
}

export interface ReviewResult {
  base: string;
  resolvedBase: string;
  /**
   * FR-24.13 what was compared: `split` = since the branch split off the base (a pull request), `direct` = tip
   * against tip; the compare point (short hash), HEAD's commits after it, the base's commits HEAD lacks (direct),
   * and changed files outside the project folder (they explain an empty review).
   */
  compare?: { mode: 'split' | 'direct'; point: string; commits: number; behind: number; outside: string[] };
  branch?: string;
  files: { file: string; path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; added: number; removed: number; /** Test code (`testFiles`). */ test?: boolean }[];
  methods: ReviewMethod[];
  issues: ReviewIssue[];
  /** Entry-point flows scanned for issues, and those left out by the limit. */
  scanned: number;
  notScanned: number;
  /** Changed lines outside methods (fields, imports, class headers) per file. */
  otherLines: number;
  /** FR-24.8 when it was computed (ISO time). */
  computedAt?: string;
  /** FR-24.8 shown again: nothing changed since it was computed (same base, HEAD, diff). */
  reused?: boolean;
  /** FR-29 the structural delta of the branch (Level 0); absent when no base version could be loaded. */
  structure?: ReviewStructure;
}

/**
 * FR-29 Level 0 of a review: what the branch changed in the *shape* of the application — over every entry point's
 * flow, compared with the same flows on the base version. A list; empty = "no structural change". Each row opens
 * the level below (the zoomed flow of the first entry point reaching it, FR-28).
 */
export interface ReviewStructure {
  rows: StructureRow[];
  /** Entry points whose flows were analysed on the base version (they touch changed files, or exist only there). */
  compared: number;
  /** Entry points whose flows touch no changed file: identical in both versions, taken from the branch's scan. */
  copied: number;
  /** Affected entry points left out by the limit (their flows counted as unchanged). */
  notCompared: number;
}

export type StructureRowKind =
  | 'edge-added'
  | 'edge-removed'
  | 'violation-added'
  | 'violation-removed'
  | 'entry-added'
  | 'entry-removed'
  // FR-29.7 … 28.9 (Level 0 A2)
  | 'io-added'
  | 'io-removed'
  | 'cycle-added'
  | 'cycle-removed'
  | 'layer-changed'
  // FR-29.10 / 28.11
  | 'client-added'
  | 'client-removed'
  | 'role-changed';

/**
 * FR-29 one structural change. Edges, violations and cycles are between layers (`level: layer`), or between the map's
 * packages (FR-26.3) when both classes are in one layer. I/O kinds and clients are per layer; `layer-changed` / `role-changed` are per class.
 */
export interface StructureRow {
  kind: StructureRowKind;
  /** One line: `Domain → Infrastructure`, `Layer violation: Domain → Infrastructure`, `GET /orders/:id`, `Application: HTTP`, `Cycle: Application → Infrastructure → Application`, `OrderRepo: Domain → Infrastructure`. */
  title: string;
  /** Second line: the class pairs behind an edge (`Order → Db`), the rule a violation breaks, an entry point's method, the classes doing an I/O kind. */
  detail?: string;
  level?: 'layer' | 'package';
  /** Edges / violations: the lifeline keys of FR-28 (`layer:Domain`) or the package paths, and the class pairs behind them (first call each). I/O kind: `from` is the layer. Layer changed: the class's old and new layer. */
  from?: string;
  to?: string;
  pairs?: StructurePair[];
  /** FR-7.16 a violation row: it rests on a guessed layer (as `ClassRelation.possible`). */
  possible?: string[];
  /** FR-29.7 the I/O kind added / removed (FR-29.10: the kind of the client). */
  io?: SideEffectKind;
  /** FR-29.10 the I/O client technology added / removed in the layer (`Confluent.Kafka`, `@aws-sdk`, `axios`). */
  client?: string;
  /** FR-29.8 a cycle's members (lifeline keys or package paths), in cycle order. */
  members?: string[];
  /** FR-29.7 / 28.9 / 28.10 / 28.11 the classes behind the row (an I/O kind's or client's classes, the class that changed layer or role). */
  classKeys?: string[];
  /** The first entry point whose flow has the change (on the branch; for a removed one, on the base — it opens nothing then). */
  entryPoint?: EntryPoint;
}

export interface StructurePair {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  /** The first call behind the pair (`place → save`), where it is. */
  call?: { label: string; callSite?: SourceRange };
}

/** Manual layout: participant id → x of the lifeline centre. */
export type ParticipantPositions = Record<string, number>;

// ───────────────────────────── Diagram state to share (FR-25.2) ─────────────────────────────

/**
 * FR-25.2 what makes a sequence diagram, to open the same diagram on another machine (same code): the root,
 * what is expanded, the implementations chosen, hidden calls, view options, positions — plus what the code was
 * (commit, uncommitted files, layer config) and what the sender saw, so the receiver learns what differs.
 * Keys and paths are project-relative; nothing absolute. New fields are optional; a newer `schemaVersion` is refused.
 */
export interface DiagramStateSnapshot {
  format: 'seqcall-state';
  schemaVersion: 1;
  /** For a person reading the file: how to open it (ignored when reading). */
  open?: string;
  createdAt: string;
  tool?: { version?: string; host?: string };
  project: {
    name: string;
    /** typescript | csharp | php */
    language: string;
    /** The project root relative to the git top-level ('' = the same; absent = no git). */
    dir?: string;
  };
  git?: { commit: string; branch?: string; /** Uncommitted (changed / untracked) files of the project, project-relative. */ changed: string[] };
  /** Text of the project's .seqcall.json (absent = none). */
  config?: string;
  root: { key: string; label: string };
  /** FR-16.3 the entry point the diagram was opened from. */
  entry?: { kind: EntryPointKind; label: string };
  expanded: string[];
  /** Per message id: the implementation chosen (class key), null = back to the interface. */
  choices: Record<string, string | null>;
  collapsedFragments?: string[];
  /** FR-1.22 followed cases: fragment id → the case (operand index) followed. */
  followedCases?: Record<string, number>;
  /** FR-3.11 error paths shown again after Smart expand folded them (their keys). */
  shownErrorPaths?: string[];
  smart?: boolean;
  /** FR-8.4 remembered implementation per interface / abstract class key. */
  interfaceChoices: Record<string, string>;
  /** FR-8.5 (a host setting; reported when it differs, not changed). */
  autoSelectSingleImplementation?: boolean;
  filters: HideFilter[];
  /** Without `followCursor` (an editor setting, not part of the diagram). */
  options: Partial<DiagramOptions>;
  positions?: ParticipantPositions;
  /** FR-24 a review was on (its marks are not replayed). */
  review?: { base: string; mode?: 'split' | 'direct' };
  /** What the sender saw. */
  seen: { messages: number; participants: number };
}

/** FR-25.2 how far an opened state matches what the sender had. */
export interface DiagramStateReport {
  /** Who / when / where the state came from (`UserController.getUser · sample-app · c9cbbc2 · 2026-10-10`). */
  source: string;
  /** Differences found, one sentence each (empty = the same as the sender, as far as can be checked). */
  differences: string[];
  /** Expanded calls / chosen implementations / minimized fragments the state names that are not in this diagram. */
  missing: string[];
  seen: { messages: number; participants: number };
  now: { messages: number; participants: number };
  /** The receiver had other hide filters / view options: they were replaced (`restoreSettings` takes them back). */
  settingsReplaced: boolean;
  /** FR-25.3 the sender's .seqcall.json differs from this project's: it can be used instead (`useSharedConfig`). */
  configDiffers?: boolean;
}

/** FR-25.3 a shared diagram's layer config used instead of the project's file (in memory only). */
export interface BorrowedConfig {
  /** Where it came from (the report's `source`). */
  source: string;
}

// ───────────────────────────── Class diagram ─────────────────────────────

export interface ClassMember {
  name: string;
  /** FR-28.8 a row of a layer package (zoomed): the class's key (to pull it out). */
  key?: string;
  isStatic: boolean;
  /** e.g. "getUser(id: string): Promise<User>" */
  signature: string;
  /** FR-12.13: the method's definition — the implementation the sequence diagram runs (absent on interface rows). */
  declaration?: SourceRange;
  /** FR-12.13: the visible sequence-diagram messages that run this method ("from UserService.findUser"). */
  calls?: RelationCall[];
  /** FR-24.11 the reviewed branch added / changed / removed this member (a removed one is listed from the base version). */
  diff?: 'added' | 'changed' | 'removed';
  /** FR-24.11 a field row (listed while reviewing: added, retyped or removed fields). */
  field?: boolean;
  /** FR-12.18 not public: hidden in the class box until shown for that class. Absent = public (C# `internal` too). */
  visibility?: MemberVisibility;
}

/** FR-12.18 private: TS `private` / `#name`, a module's not exported function, C# / PHP `private`; protected: `protected`. */
export type MemberVisibility = 'private' | 'protected';

export interface ClassNode {
  key: string;
  name: string;
  kind: ClassKind;
  stereotypes: string[];
  layer?: string;
  namespace: string;
  methods: ClassMember[];
  declaration?: SourceRange;
  /** Evidence-based layer suggestion that differs from `layer` (hint only). */
  layerHint?: LayerHint;
  /** FR-7.8 why it is in its layer: the rule that decided. */
  layerReason?: LayerReason;
  /** FR-7.9 why it carries each stereotype. */
  stereotypeReasons?: StereotypeReason[];
  /** Methods of the class that take no part in the visible interaction (not listed). */
  otherMethodCount?: number;
  /** FR-12.12: in the diagram only because shown methods reference the type (no calls to it). */
  usedOnly?: boolean;
  /** FR-17.2: I/O its whole file / type does (the libraries it uses), as on its participant; absent = none known. */
  sideEffects?: SideEffects;
  /** FR-24.6 compared with the base version of the flow: only today's flow reaches it / only the base flow did. */
  diff?: 'added' | 'removed';
  /** FR-24.11 what the reviewed branch did to the class (members listed in the box are marked too). */
  change?: ClassChange;
  /**
   * FR-26 codebase map: this node is a folder (a UML package) and its `methods` are the classes in
   * it (their `declaration`s). `external`: a folder outside the one shown, drawn for its relations.
   */
  group?: {
    path: string;
    classes: number;
    external?: boolean;
    /** Dependency-rule violations between classes inside it. */
    violations?: number;
    /** FR-26.7 shown because this package (folder path) is open in place. */
    in?: string;
    /** FR-28 a layer of the zoomed flow (its `methods` are the flow's classes in it), not a folder: nothing to open. */
    zoom?: true;
    /** FR-26.3 a folder whose classes are in more than one layer: classes per layer, most first (no `layer`: none). */
    layers?: { layer?: string; classes: number }[];
  };
  /** FR-26.7 codebase map: a class shown because this package (folder path) is open in place. */
  inPackage?: string;
  /** FR-28.7 layer zoom: a class drawn because its layer is opened in place (`key` folds it again); FR-28.8 `alone`: pulled out by itself. */
  inLayer?: { key: string; name: string; alone?: true };  /** FR-28.11 in the object view (no layer zoom): the layer the class belongs to — *Fold ‹name›* folds it into one package. */
  layerFold?: { key: string; name: string };
}

/** `use` (FR-12.12): a shown method references the type without calling it (enum constant, signature, cast …). */
export type RelationKind = 'realization' | 'generalization' | 'association' | 'dependency' | 'use';

export interface ClassRelation {
  id: string;
  kind: RelationKind;
  from: string;
  to: string;
  /** e.g. field name for associations, "«create»" for creation dependencies. */
  label?: string;
  /** The label only repeats the target's name (`_coupon: Coupon`): views may omit it. */
  labelObvious?: boolean;
  /** Set when the relation breaks the dependency rule (an inner layer depending on an outer one). */
  violation?: string;
  /**
   * FR-7.16 the violation rests on a guessed layer (a weak rule: a name, a role folder, the code's evidence): one line
   * per guessed end (`` `Cart` is Domain by a guess: role folder `Models/` ``). Absent = both layers are certain. On a
   * codebase-map edge: every broken relation it merges is possible.
   */
  possible?: string[];
  /**
   * The visible sequence-diagram calls this relation was derived from (dependencies and
   * associations: calls; «create»: creations). Empty for realization/generalization.
   */
  calls?: RelationCall[];
  /** FR-12.12, `use` relations: where the shown methods reference the type (first reference per method). */
  uses?: RelationUse[];
  /**
   * FR-12.15 an association whose field holds a collection of the target: drawn as an aggregation
   * (hollow diamond at the owner) with multiplicity `*` at the target.
   */
  aggregation?: boolean;
  /** FR-12.15 multiplicity at the target's end (`*` for a collection). */
  multiplicity?: string;
  /** FR-24.6 compared with the base version of the flow: all its calls are new / all were removed. */
  diff?: 'added' | 'removed';
  /** FR-26 codebase map: the edge merges this many relations between the classes of two nodes (listed in `calls`). */
  count?: number;
}

export interface RelationUse {
  /** "Class.method" that references the type. */
  method: string;
  /** The first reference in that method (signature or body). */
  range: SourceRange;
  /** A visible message that runs the method ("root" for the root method), for highlighting. */
  messageId?: string;
}

export interface RelationCall {
  messageId: string;
  /** "callerMethod → calledMethod" */
  label: string;
  callSite?: SourceRange;
}

/** issues inside folded calls: how many, and their titles. */
/**
 * FR-32.1 what an entry point's whole flow touches, whatever is expanded in the diagram: its I/O by kind, each kind with
 * the project classes whose bodies do it and their library calls.
 */
export interface FlowOutcome {
  /** In the fixed order of `SideEffects.kinds`; empty: no I/O found. */
  io: OutcomeIo[];
  /** Not followed to its end (calls left folded by the expand limit or a rule, an interface call with too many implementations, the I/O walk's limit): there may be more. */
  atLeast?: true;
  /** With `atLeast`: how many calls stayed folded with calls of their own. */
  folded?: number;
  /** With `atLeast`: the interface calls not followed, each with its implementations (`OrderHandler.handle`, 22), once per call name. */
  wide?: { call: string; implementations: number }[];
  /** With `atLeast`: the methods where the I/O walk stopped (its depth or size limit, a body not analysed): `OrderClient.post`. */
  deep?: string[];
  /** With `atLeast`: why, in words (`3 calls left folded, OrderHandler.handle has 22 implementations`). */
  why?: string;
  /** Calls the analysis could not resolve: what they do is not known. */
  unresolved?: number;
}

/** FR-32.4 an entry point's outcome in the lists: its I/O kinds (`atLeast`: there may be more). By `kind|label|methodKey`. */
export interface EntryOutcome {
  kinds: SideEffectKind[];
  atLeast?: true;
}

export interface OutcomeIo {
  kind: SideEffectKind;
  via: OutcomeVia[];
}

/** FR-32.1 a project class doing I/O of one kind, with its library calls (`NpgsqlCommand.ExecuteReaderAsync`). */
export interface OutcomeVia {
  className: string;
  /** Absent when only found below a folded call (known by name). */
  classKey?: string;
  calls: { call: string; at?: SourceRange }[];
}

export interface IssuesBelow {
  count: number;
  titles: string[];
}

export interface ClassDiagram {
  classes: ClassNode[];
  relations: ClassRelation[];
  /** Layers present, in architectural order (lane order for "group by layer"). */
  layers?: string[];
  /** FR-12.12: type uses are shown (the session option `showTypeUses`); the view's Uses toggle reflects it. */
  typeUses?: boolean;
  /** FR-19 design findings among the visible classes (dependency cycles, too many injected dependencies). */
  findings?: Finding[];
  /** class pairs that break the dependency rule only through type uses (Uses on): drawn, not issues. */
  typeUseViolations?: number;
  /** issues of this flow inside folded calls (its fully expanded flow has them, the shown calls not). */
  issuesBelow?: IssuesBelow;
  /** FR-19.22 what .seqcall.json silences, as the sequence diagram's. */
  ignored?: IgnoredPatterns;
}

/** FR-26 one step of the codebase map's breadcrumb. */
export interface AppMapCrumb {
  label: string;
  /** Folder it opens (relative to the project). */
  path: string;
}

/**
 * FR-26 one level of the codebase map: the classes the entry points' flows reach, merged, under
 * the folder `path` — sub-folders as packages, the folder's own classes as classes.
 */
export interface AppMapLevel {
  path: string;
  crumbs: AppMapCrumb[];
  diagram: ClassDiagram;
  /** Entry points scanned (tests excluded), those that failed, those whose flow hit the expand limit. */
  entryPoints: number;
  failed: number;
  truncated: number;
  /** Totals of the whole map. */
  classes: number;
  relations: number;
  violations: number;
  /** FR-7.16 of `violations`, those resting on a guessed layer. */
  possibleViolations?: number;
  /** When the scans were made (ISO); entry points re-scanned after a change count from then on. */
  computedAt: string;
  /** Entry points scanned again for this answer (the others came from the cache). */
  rescanned?: number;
  /** FR-26.7 the packages open in place at this level (folder paths), as asked for. */
  open?: string[];
  /**
   * Every dependency-rule violation of the map (not only those drawn at this level): `folder` is where it is
   * drawn as an edge (the deepest folder holding both classes).
   */
  violationList?: AppMapViolation[];
  /** the design issues of the map's flows (project-wide, as ⌂ ⚠ Design issues lists them; violations apart). */
  findings?: ProjectFinding[];
}

/** FR-26.6 a dependency-rule violation of the codebase map. */
export interface AppMapViolation {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  violation: string;
  folder: string;
  /** The classes' layers and ⚑ hints, for the same violation card as in a flow's class diagram. */
  fromLayer?: string;
  toLayer?: string;
  fromHint?: LayerHint;
  toHint?: LayerHint;
  /** FR-7.16 it rests on a guessed layer (as `ClassRelation.possible`). */
  possible?: string[];
}

// ───────────────────────────── Messages: host ⇄ sequence view ─────────────────────────────

/** Diagnostics a view reports to its host (shown in the host's log/output channel). */
export type ViewLog = { type: 'log'; level: 'info' | 'error'; message: string };

export type HostToSequenceView =
  | { type: 'render'; diagram: SequenceDiagram; positions?: ParticipantPositions }
  /** FR-24.13 the answer to `requestGitRefs` (`error`: not a git repository). */
  | { type: 'gitRefs'; refs?: GitRefs; error?: string }
  /** FR-7.12 the answer to `requestLayerScopes`. */
  | { type: 'layerScopes'; classKey: string; scopes: LayerScope[] }
  /**
   * FR-25.2 the answer to `copyState`: the JSON to copy, or (`save`) to download as `name`; `done`: the host copied /
   * saved it itself (VS Code); `error`: why there is none.
   */
  | { type: 'diagramState'; text?: string; error?: string; save?: boolean; name?: string; done?: boolean }
  /** FR-25.4 the answer to `copyText`: the shown flow as an indented text tree, to copy; `done`: the host copied it (VS Code); `error`: why there is none. */
  | { type: 'diagramText'; text?: string; error?: string; done?: boolean }
  /** FR-25.2 a state was opened (`openState`): how far it matches; `error` = it could not be opened. */
  | { type: 'stateReport'; report?: DiagramStateReport; error?: string }
  /** FR-25.2 open the paste card (a host command asked for it). */
  | { type: 'openStatePrompt' }
  /** FR-16.2 the entry points of `project` (its root's folder name), or why there are none. */
  | {
      type: 'entryPoints';
      entryPoints: EntryPoint[];
      project?: string;
      error?: string;
      /** Open the list (a command asked for it). */
      show?: boolean;
      /** FR-16.11 the host can list another project's entry points (`switchEntryPointsProject`). */
      canSwitchProject?: boolean;
      /** FR-16.4 how to show them, the same as the VS Code sidebar (without it: by kind, a flat list). */
      tree?: EntryPointListNode[];
    }
  | { type: 'empty'; reason: string }
  /** FR-16.14 a slow first load (analysing the project): a spinner with `text` until the next render, empty or error. */
  | { type: 'busy'; text: string }
  /**
   * FR-19.9 project-wide design issues: progress while `running` (entry points done / total), the
   * findings when `done` (`total` = entry points scanned); `show` = open the panel (a command asked for it).
   */
  /** FR-16.15 the answer to `searchMethods`: the first matches (production code first) and how many more there are. */
  | { type: 'methodResults'; query: string; methods: MethodRef[]; more: number }
  | { type: 'projectFindings'; state: 'running' | 'done' | 'cancelled' | 'error'; done?: number; total?: number; findings?: ProjectFinding[]; project?: string; error?: string; show?: boolean; /** flows cut by the expand limit. */ truncated?: number; /** FR-19.23 methods no entry point reaches: scanned too, and left out by the limit; `stale`: from a list older than the code (FR-31). */ unreached?: { scanned: number; skipped: number; stale?: boolean }; /** The code changed while the scan ran: not kept, ↻ scans again. */ changed?: boolean; /** FR-19.23 while running: the entry points are done (their `findings`), the methods none reaches are looked for. */ walking?: boolean; /** FR-32.4 when `done`: the outcomes known (the scanned flows and the ones opened), by `kind|label|methodKey`. */ outcomes?: Record<string, EntryOutcome> }
  /** FR-31 progress / result of the unreachable-code scan (`phase`: walking from the entry points, checking what is left). */
  | { type: 'unreachable'; state: 'running' | 'done' | 'cancelled' | 'error'; phase?: 'reach' | 'check'; done?: number; total?: number; result?: UnreachableScan; project?: string; error?: string; show?: boolean }
  | { type: 'callers'; messageId: string; callers: CallerInfo[] }
  /** FR-23: calls matching `query` below the collapsed messages (progress while `running`); `truncated` = the limits stopped the search. */
  | { type: 'searchResults'; query: string; state: 'running' | 'done' | 'cancelled' | 'error'; hits?: SearchHit[]; methods?: number; truncated?: boolean; deeper?: boolean; error?: string }
  /** FR-24 review of the branch: progress while `running` (phase, done / total), the result when `done`; `show` = open the panel. */
  | { type: 'review'; state: 'running' | 'done' | 'cancelled' | 'error'; phase?: string; done?: number; total?: number; result?: ReviewResult; error?: string; show?: boolean }
  /** FR-23: open the find bar (a host shortcut or the class view asked for it), optionally with a query. */
  | { type: 'openFind'; query?: string }
  /**
   * FR-22 paths to here of `messageId`'s method: progress while `running` (`methods` = methods whose
   * callers were searched), the reverse tree when `done`; `truncated` = a limit cut some paths.
   */
  | { type: 'paths'; messageId: string; state: 'running' | 'done' | 'cancelled' | 'error'; methods?: number; tree?: CallPathNode; truncated?: boolean; error?: string }
  /** open Show callers / Paths to here of this message (asked from a class method row). */
  | { type: 'openPanel'; panel: 'callers' | 'paths'; messageId: string }
  | { type: 'highlight'; messageId: string | null; /** Several messages at once (e.g. a class-diagram relation); the first is scrolled into view. */ messageIds?: string[]; /** FR-19.7: reveal this finding (its messages and the participants involved). */ finding?: Finding }
  | { type: 'error'; message: string };

/** FR-24.7 a line of a diff hunk (`+` added, `-` removed, ` ` context); `at` = the call's own line. */
export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
  at?: boolean;
}

/** FR-24.7 what a host needs to show a call's change side by side: the file now, its base version, the line. */
export interface DiffTarget {
  /** Absolute path of the file now (for a removed call: where it was). */
  file: string;
  /** 0-based line in the current file. */
  line: number;
  /** The file's content at the merge base ('' when the branch added it). */
  baseText: string;
  /** e.g. "OrderService.ts (develop ↔ feature/x)". */
  title: string;
}

export type SequenceViewToHost =
  | { type: 'ready' }
  /** FR-12.17 an object was clicked: the class diagram, if open, shows its class. */
  | { type: 'focusClass'; classKey: string }
  | { type: 'navigate'; range: SourceRange }
  /** FR-24.7 open the side-by-side diff of a reviewed call (its file, base ↔ now, at the call); FR-24.11 or of a changed class (at `member`). */
  | { type: 'openDiff'; messageId?: string; classKey?: string; member?: string; /** FR-24.15 a step of the review tour: the diagram keeps the focus (N / P go on). */ keepFocus?: boolean; /** FR-24.15 the change of the method the call reaches (its declaration), not of the call. */ method?: true }
  /** FR-24.9 expand a collapsed call down to the first changed method below it; answered with render + highlight. */
  | { type: 'revealChange'; messageId: string }
  /** FR-24.15 the review tour: show the flow's change number `n` (of `reviewTotal`); the host renders and highlights it. */
  | { type: 'showChange'; n: number }
  /** FR-24.10 open a flow of the review tour: from its start, expanded along every path to its changed methods; render + highlight of the first. */
  | { type: 'openChangeFlow'; paths: CallPathStep[][]; entryPoint?: EntryPoint }
  | { type: 'expand'; messageId: string }
  | { type: 'collapse'; messageId: string }
  /**
   * FR-3.3 expand everything (level by level, capped), or below one message (`messageId`, FR-3.7);
   * `oneLevel`: only one more level of the whole diagram.
   */
  | { type: 'expandAll'; messageId?: string; oneLevel?: boolean }
  /** FR-16.2: list the project's entry points (answered with `entryPoints`). */
  | { type: 'requestEntryPoints' }
  /** FR-16.11 choose which project's entry points the list shows (the host asks, then sends `entryPoints`). */
  | { type: 'switchEntryPointsProject' }
  /** FR-19.17 a layer violation's "Adjust the rule", as in the class view (FR-12.16). */
  | { type: 'openDependencyRule' }
  /** FR-19.9: scan the project's entry points for design issues (answered with `projectFindings`); cancel a running scan. */
  | { type: 'requestProjectFindings'; /** FR-19.9: scan again even when a cached result exists. */ rescan?: boolean }
  /** FR-26 open the class view on the codebase map. */
  | { type: 'openAppMap'; /** FR-26.8 only these entry points (`kind|label|methodKey`); absent = all. */ entryPoints?: string[] }
  | { type: 'cancelProjectFindings' }
  /** FR-31: the methods no entry point reaches (answered with `unreachable`, cached until a file changes); cancel a running scan. */
  | { type: 'requestUnreachable'; rescan?: boolean }
  | { type: 'cancelUnreachable' }
  /** FR-19.9: open the flow a project finding was found in, expanded, with its evidence highlighted. */
  | { type: 'openFinding'; entryPoint: EntryPoint; finding: Finding }
  /** FR-16.2: open the diagram of a method by key (an entry point); FR-16.3 `entryPoint` = the one chosen. */
  | { type: 'openMethod'; methodKey: string; entryPoint?: EntryPoint }
  /** FR-3.6: expand the important calls up to a budget (the whole diagram, or below `messageId`). */
  /** FR-3.6; `more` (FR-3.10): continue after the cap stopped it — another cap's worth of messages. */
  | { type: 'smartExpand'; messageId?: string; more?: boolean; /** FR-3.12 `changes`: open only the paths to the review's changed methods (default: Overview, the important calls). */ view?: 'changes' }
  | { type: 'collapseAll' }
  /** FR-1.12: minimize / restore a combined fragment. */
  | { type: 'collapseFragment'; fragmentId: string }
  | { type: 'expandFragment'; fragmentId: string }
  /** FR-1.22: follow one case of an `alt` (its other cases leave both diagrams) / show all its cases again. */
  | { type: 'followCase'; fragmentId: string; case: number }
  | { type: 'showAllCases'; fragmentId: string }
  /** FR-3.11: show an error branch Smart expand folded (`ErrorPathFold.key`). */
  | { type: 'showErrorPath'; key: string }
  | { type: 'selectImplementation'; messageId: string; classKey: string }
  | { type: 'revertImplementation'; messageId: string }
  | { type: 'requestCallers'; messageId: string }
  | { type: 'reroot'; messageId: string; callerId: string }
  /** FR-22: walk the callers of the message's method up to the entry points (answered with `paths`); cancel a running walk. */
  | { type: 'requestPaths'; messageId: string }
  | { type: 'cancelPaths' }
  /** FR-22: open a path top-down, from its start expanded down to the target (`steps`: start first). */
  | { type: 'openPath'; steps: CallPathStep[]; entryPoint?: EntryPoint }
  /** FR-24 review the branch against `base` (default `develop`); answered with `review`. Cancel a running one; open an issue's flow; end the review (no diff marks). */
  /** `force`: compute again even when nothing changed since the last review (FR-24.8). */
  | { type: 'requestReview'; base?: string; force?: boolean; /** FR-24.13 default `split`. */ mode?: 'split' | 'direct' }
  /** FR-24.13 the branches, tags and commits the review picker offers (answered with `gitRefs`). */
  | { type: 'requestGitRefs' }
  | { type: 'cancelReview' }
  | { type: 'openReviewIssue'; issue: ReviewIssue }
  /** FR-29 open the flow behind a structure row: its entry point, expanded fully, zoomed to layers for a layer row; the first call of the pair highlighted. */
  | { type: 'openReviewStructure'; row: StructureRow }
  | { type: 'endReview' }
  /** FR-23: search the collapsed calls for `query` (answered with `searchResults`); `deeper` = the larger limits. */
  | { type: 'searchCollapsed'; query: string; deeper?: boolean }
  | { type: 'cancelSearch' }
  /** FR-23: expand the path to a found call and highlight it. */
  | { type: 'revealSearchHit'; hit: SearchHit }
  /** FR-4.6: make the message's method the root (keeps what is expanded below it). */
  | { type: 'focus'; messageId: string }
  | { type: 'hide'; filter: HideFilterSpec }
  | { type: 'unhide'; filterId: string }
  | { type: 'unhideAll' }
  | { type: 'setOption'; option: keyof DiagramOptions; value: boolean | number }
  /**
   * FR-28.7 layer zoom: open a layer in place (its objects / classes drawn) or fold it again. FR-28.8 `layer` may also be
   * a participant id (pull that object out of its layer / put it back) or a class key (every object of the class).
   */
  | { type: 'setLayerOpen'; layer: string; open: boolean }
  /** FR-28.9 layer zoom: fold every opened layer and put every pulled-out object back (the zoom stays on). */
  | { type: 'foldLayers' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'openClassDiagram' }
  | { type: 'savePositions'; rootKey: string; positions: ParticipantPositions }
  /** FR-25.2 the diagram's state to share (answered with `diagramState`); `save`: as a file instead of the clipboard. */
  | { type: 'copyState'; save?: boolean }
  /**
   * FR-25.4 Share → Copy as text: the shown flow as an indented text tree (answered with `diagramText`). FR-25.5 with
   * `messageId`: Ask AI about this call — a prompt about that call, then the flow.
   */
  | { type: 'copyText'; messageId?: string }
  /** FR-25.2 open a shared state (the pasted text; answered with a render and `stateReport`). */
  | { type: 'openState'; text: string }
  /** FR-25.2 take back the hide filters and view options an opened state replaced. */
  | { type: 'restoreSettings' }
  /** FR-25.3 use the last opened state's layer config instead of the project's file (on), or the file again (off). */
  | { type: 'useSharedConfig'; on: boolean }
  /** Put the class's file into a layer (writes a rule to the project's .seqcall.json). */
  /** FR-7.5 / FR-7.12 move to a layer: a rule for `match` (a glob from `layerScopes`), else for the class's file. */
  | { type: 'setLayer'; classKey: string; className: string; layer: string; match?: string }
  /** FR-7.12 the scopes "Move to layer" can cover for a class (answered with `layerScopes`). */
  | { type: 'requestLayerScopes'; classKey: string; className: string }
  /** FR-25 save the diagram as an image (VS Code: a save dialog); `data` is base64 for PNG, the text for SVG. */
  | { type: 'saveImage'; name: string; format: 'png' | 'svg'; data: string }
  /** FR-19.10: add `pattern` to `findings.ignore` in .seqcall.json (an explicit user action; Undo in the host). */
  | { type: 'ignoreFinding'; pattern: string }
  /** FR-7.11: add `pattern` (a file glob) to `layerHints.ignore` in .seqcall.json (an explicit user action; Undo in the host). */
  | { type: 'ignoreLayerHint'; pattern: string }
  /** FR-16.15 the project's methods named like the ⌂ filter's text (answered with `methodResults`). */
  | { type: 'searchMethods'; query: string }
  /** FR-19.22: remove `pattern` from `findings.ignore` / `layerHints.ignore` (Stop ignoring in the ⚠ menu). */
  | { type: 'unignoreFinding'; pattern: string }
  | { type: 'unignoreLayerHint'; pattern: string }
  | ViewLog;

// ───────────────────────────── Messages: host ⇄ class view ─────────────────────────────

export type HostToClassView =
  | {
      type: 'render';
      diagram: ClassDiagram;
      /** Hide filters shared with the sequence view (FR-11), for the class view's "Hidden" dropdown. */
      hiddenFilters?: HiddenFilterInfo[];
      /** the session's display options: the class view's View ▾ shows the marks of both diagrams. */
      options?: DiagramOptions;
      /** Class of the root method; it cannot be hidden. */
      rootClassKey?: string;
      /** Layers a class can be moved to ("Move to layer"). */
      layerChoices?: string[];
      /** Method rows per class before "… +k more" (0 = no limit; default 5). */
      maxMethods?: number;
      /** FR-25.3 the layer config in use is a shared diagram's. */
      borrowedConfig?: BorrowedConfig;
    }
  | { type: 'empty'; reason: string }
  /** FR-16.14 a slow first load (analysing the project): a spinner with `text` until the next render, empty or error. */
  | { type: 'busy'; text: string }
  /** FR-23: open the find bar (a host shortcut asked for it). */
  | { type: 'openFind'; query?: string }
  /** FR-12.17 an object was clicked in the sequence diagram: scroll its class into view and mark it. */
  | { type: 'focusClass'; classKey: string }
  /** FR-7.12 the answer to `requestLayerScopes`. */
  | { type: 'layerScopes'; classKey: string; scopes: LayerScope[] }
  /** FR-26 switch to the codebase map (a command or the entry-point list asked for it). */
  | { type: 'showAppMap'; /** FR-26.8 the selection to map (absent = all entry points). */ entryPoints?: string[] }
  /** FR-26 the codebase map: progress while the entry points are scanned, then a level. */
  | { type: 'appMap'; state: 'running' | 'done' | 'cancelled' | 'error'; done?: number; total?: number; level?: AppMapLevel; project?: string; error?: string }
  /** FR-25.2 the answer to the class view's `copyState` (as in the sequence view). */
  | { type: 'diagramState'; text?: string; error?: string; save?: boolean; name?: string; done?: boolean }
  /** FR-25.4 the answer to the class view's `copyText` (as in the sequence view). */
  | { type: 'diagramText'; text?: string; error?: string; done?: boolean }
  /** FR-25.2 a state opened from the class view could not be opened (a success is reported in the sequence view). */
  | { type: 'stateReport'; error?: string };

export type ClassViewToHost =
  | { type: 'ready' }
  /** FR-26 the codebase map at a folder ('' / absent = the top); `rescan` drops the cached scans. */
  | { type: 'requestAppMap'; path?: string; rescan?: boolean; /** FR-26.7 packages open in place (folder paths). */ open?: string[]; /** FR-26.8 only these entry points. */ entryPoints?: string[] }
  | { type: 'cancelAppMap' }
  | { type: 'navigate'; range: SourceRange }
  /** FR-24.11 open a changed class side by side (base ↔ now), at `member` when given. */
  | { type: 'openDiff'; classKey: string; member?: string }
  /** Same hide filters as the sequence view: hiding in either view hides in both. */
  | { type: 'hide'; filter: HideFilterSpec }
  | { type: 'unhide'; filterId: string }
  | { type: 'unhideAll' }
  /** Highlight these messages in the sequence view (a clicked class-diagram relation). */
  | { type: 'highlightMessages'; messageIds: string[] }
  /** a class method row's Show callers / Paths to here: the sequence view opens that panel for this call of it. */
  | { type: 'openInSequence'; panel: 'callers' | 'paths'; messageId: string }
  /** FR-12.12: show / hide type uses (the session option `showTypeUses`); the host re-renders the class view. */
  | { type: 'setTypeUses'; value: boolean }
  /** FR-12.13: focus the sequence diagram on a call of a class-diagram method (same as the sequence view's focus). */
  | { type: 'focus'; messageId: string }
  /** Put the class's file into a layer (writes a rule to the project's .seqcall.json). */
  /** FR-7.5 / FR-7.12 move to a layer: a rule for `match` (a glob from `layerScopes`), else for the class's file. */
  | { type: 'setLayer'; classKey: string; className: string; layer: string; match?: string }
  /** FR-7.12 the scopes "Move to layer" can cover for a class (answered with `layerScopes`). */
  | { type: 'requestLayerScopes'; classKey: string; className: string }
  /** FR-25 save the diagram as an image (VS Code: a save dialog); `data` is base64 for PNG, the text for SVG. */
  | { type: 'saveImage'; name: string; format: 'png' | 'svg'; data: string }
  /** FR-19.10: add `pattern` to `findings.ignore` (as in the sequence view). */
  | { type: 'ignoreFinding'; pattern: string }
  /** FR-7.11: add `pattern` to `layerHints.ignore` (as in the sequence view). */
  | { type: 'ignoreLayerHint'; pattern: string }
  /** FR-19.22: Stop ignoring (as in the sequence view). */
  | { type: 'unignoreFinding'; pattern: string }
  | { type: 'unignoreLayerHint'; pattern: string }
  /**
   * FR-12.14: a relation without drawn calls — expand the sequence diagram until a call from `from` to `to`
   * (through `field`) appears and highlight it; nothing found: open `fallback` (the source's declaration).
   */
  | { type: 'revealRelation'; from: string; to: string; field?: string; fallback?: SourceRange }
  /** FR-23.4: nothing visible matches — search the sequence diagram (its collapsed calls too) for `query`. */
  | { type: 'findInFlow'; query: string }
  /** FR-12.16 "Adjust the rule": open .seqcall.json at `dependencyRule` (added with the default when missing; Undo in the host). */
  /** a mark of both diagrams switched in the class view's View ▾ (as the sequence view's). */
  | { type: 'setOption'; option: keyof DiagramOptions; value: boolean }
  /** FR-28.7 layer zoom: open a layer in place / fold it again (as in the sequence view; both views re-render). */
  | { type: 'setLayerOpen'; layer: string; open: boolean }
  /** FR-28.9 fold every opened layer / pulled-out class (as in the sequence view; both views re-render). */
  | { type: 'foldLayers' }
  /** a design issue picked in the codebase map's ⚠ N: its flow in the sequence diagram (as FR-19.9). */
  | { type: 'openFinding'; entryPoint: EntryPoint; finding: Finding }
  | { type: 'openDependencyRule' }
  /** FR-25.2 / FR-25.3 the same as in the sequence view (the diagram is the sequence diagram's state). */
  | { type: 'copyState'; save?: boolean }
  /** FR-25.4 Share → Copy as text: the classes of the shown flow as text (answered with `diagramText`). */
  | { type: 'copyText' }
  | { type: 'openState'; text: string }
  | { type: 'useSharedConfig'; on: boolean }
  | ViewLog;
