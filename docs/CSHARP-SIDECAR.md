# C# adapter: Roslyn sidecar

The C# `LanguageAdapter` runs as a separate .NET process ("sidecar", `packages/csharp`) that
loads the solution with Roslyn (`MSBuildWorkspace`). The Node side (`RpcLanguageAdapter` in
`packages/core`) starts it and forwards every `LanguageAdapter` call. In Rider and Vim the Node sidecar
(`packages/stdio-host`) starts it the same way.

## Build, run, test

```sh
cd packages/csharp
dotnet build -c Release src/Seqcall.CSharp/Seqcall.CSharp.csproj
# → src/Seqcall.CSharp/bin/Release/net10.0/Seqcall.CSharp.dll  (where the Node side looks by default)
dotnet test
```

The output folder must be kept as a whole: next to `Seqcall.CSharp.dll` it contains Roslyn, the
`BuildHost-*` folders (the out-of-process design-time build host) and MSBuildLocator. MSBuild
itself is **not** shipped.

To try it by hand, start it in the project root (see *Process and transport*) and send one JSON object per line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"projectRoot":"/repo"}}
{"jsonrpc":"2.0","id":2,"method":"findEnclosingCallable","params":{"file":"/repo/src/A.cs","position":{"line":10,"character":4}}}
{"jsonrpc":"2.0","id":3,"method":"shutdown","params":{}}
```

`--verbose` also logs per-request timings and compilation error counts to stderr; `shutdown` (or EOF on stdin) ends
the process.

Tests (xUnit in-process against `fixtures/sample-cs`, one stdio end-to-end test): docs/TESTING.md §4.

## Process and transport

- `Program.cs` registers MSBuildLocator before any MSBuild type loads.
- Started as `dotnet <dir>/Seqcall.CSharp.dll --root <projectRoot> [--solution <path.sln|.slnx>]`
  with the **working directory set to `<projectRoot>`**, so the project's `global.json` selects
  the SDK that MSBuildLocator registers. If no installed SDK satisfies it, `initialize` fails with
  a message naming the `global.json`, the required and the installed SDKs and how to install it.
  There is no fallback to another SDK: MSBuildWorkspace's build host resolves the SDK again per
  project from the project's folder, so the pin applies there anyway.
- Started with `DOTNET_TieredPGO=0` and `DOTNET_TC_CallCountingDelayMs=0` (core `csharpSidecarEnv`; values set by
  the user win), inherited by the MSBuild build host: the project load runs mostly cold code, and these settings let
  .NET optimize hot methods sooner. ReadyToRun is not used: it would need per-platform packages.
- The hosting runtime must be at least the SDK's MSBuild runtime.
- **Newline-delimited JSON-RPC 2.0** over stdio: exactly one JSON object per line on stdin
  (requests) and stdout (responses). Nothing else is ever written to stdout; diagnostics go to
  stderr.
- Requests are processed in order. A failing request returns a JSON-RPC `error`
  (`{ code, message }`); the process keeps running.

## Conventions

- File paths: **absolute, forward slashes** (`/home/u/repo/src/A.cs`; on Windows `c:/repo/...`).
- Positions: **0-based** `{ line, character }` (LSP-style, UTF-16 columns).
- Keys are stable strings; the relative path is relative to `projectRoot`, forward slashes:
  - type: `<relPath>#<TypeName>`; nested `Outer.Inner`; generic arity as `Repo`1`
    (`ClassRef.name` is the display name, e.g. `Repo<T>`). Partial types use the file of the
    first declaration (by path order).
  - method: `<typeKey>.<Name>(<paramTypes>)`, parameter types as short display names, e.g.
    `src/App.Core/Services/OrderService.cs#OrderService.GetAsync(int, CancellationToken)`.
  - constructor: `<typeKey>..ctor(<paramTypes>)`; its `MethodRef.name` and the `CallSite.methodName`
    of `new` are `constructor` (protocol convention shared with TypeScript).
  - property/indexer accessors (only when explicitly modelled): `<typeKey>.<Prop>.get` / `.set`.
  - C# 14 extension block members (FR-1.21) are keyed like classic extension methods: on the static class, receiver
    first, block type parameters in the arity — `extension<T>(IReadOnlyList<T> items) { T? FirstOrNone() }` in
    `UserExtensions` → `<file>#UserExtensions.FirstOrNone`1(IReadOnlyList<T>)`. The block itself never appears as a type.
  - types/members from metadata (NuGet, framework): `lib:<AssemblyName>#<Namespace.Type>` and
    `lib:<AssemblyName>#<Namespace.Type>.<Name>(...)`; `isLibrary: true`, `libraryName` = assembly name.
  - unresolved: no `target` (the Node side draws an «unknown» participant).
- DTO shapes are exactly the TypeScript types in `packages/protocol/src/index.ts`
  (`MethodRef`, `ClassRef`, `CallerInfo`, `SourceRange`, `Position`) and
  `packages/core/src/adapter.ts` (`CallSite`, `ReceiverOrigin`, `ArgumentOrigin`, `ClassInfo`,
  `FieldInfo`). Optional fields may be omitted; `null` means "none".

## Methods

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ projectRoot, solution? }` | `{ projects: string[], documents: number, loadMs: number }` — loads the workspace (solution: given, else the single `.sln`/`.slnx` under the root, else all `.csproj`). |
| `findEnclosingCallable` | `{ file, position }` | `MethodRef \| null` — innermost method, constructor, accessor, local function or operator containing the position. |
| `getMethod` | `{ key }` | `MethodRef \| null` |
| `getOutgoingCalls` | `{ method: MethodRef }` | `CallSite[]` — direct calls of the body in evaluation order (receiver and arguments before the call); invocations, `new X()`, target-typed `new()`; lambda / anonymous-method / local-function bodies are **not** descended into, except lambdas passed to a library method (see below). |
| `getImplementations` | `{ method: MethodRef }` | `MethodRef[]` — implementations of an interface member / overrides of an abstract or virtual member, from source only. |
| `getCallers` | `{ method: MethodRef }` | `CallerInfo[]` — call sites in source, mapped to their enclosing callable, with a one-line preview. |
| `getValueUses` | `{ method: MethodRef }` | `number` (FR-31.1) — references outside test code that use the method as a value: a method group assigned, added to an event, kept in an initializer, returned; not calls, not passed as an argument (both are callers), not `nameof`, not doc comments. |
| `getClassInfo` | `{ classKey }` | `ClassInfo \| null` — `decorators` = attribute names without `Attribute` suffix (e.g. `ApiController`, `Route`); `fields` include primary-constructor parameters captured by the type and DI-injected fields (`injected: true` when assigned from a constructor parameter); `hasPrivateConstructor`, `hasStaticInstance`, `allMembersStatic`, `methods` with display signatures (`GetAsync(int id, CancellationToken ct): Task<Order>`), `nestedTypes` = simple names of the nested types, recursively (omitted when none; layer hints ignore them), `immutable: true` (FR-5.12) and `dataOnly: true` (FR-7.15) when the type meets those rows' rules (omitted otherwise). |
| `getParameterNames` | `{ method: MethodRef }` | `string[]` |
| `getTypeUses` | `{ method: MethodRef }` | `TypeUse[]` (`{ type: ClassRef, range }`, FR-12.12) — the source types the method references: signature (parameter, return types, constraints) and evaluated body (every simple name binding to a type — declarations, `var`, casts, `is`/`as`, `typeof`, `nameof`, generic arguments, `new X()` — or to a static / const member: enum constants, static properties, fields, methods incl. extension methods → the containing type). Nested types are reported as their **top-level** containing type (`Enums.OrderStatus` → `Enums`); metadata types, type parameters and the method's own type are skipped; one entry per type, at its first reference (source order). Lambdas and local functions in the body are included. |
| `getEarlyExits` | `{ method: MethodRef }` | `EarlyExit[]` (`{ kind: "return" \| "throw", range, exception?, fragments? }`, FR-1.15) — return / throw **statements** of the body not in tail position (followed by more of the method on some path: a later statement, an enclosing loop), source order. `exception`: the type of `throw new X(…)`, else the thrown expression, absent for `throw;`. `fragments`: enclosing constructs like a call site's. Lambdas, local functions and throw expressions are excluded. |
| `getReturns` | `{ method: MethodRef }` | `ReturnFact[]` (`{ range, tuple?, values: { range, variable?, empty? }[] }`, FR-5.8) — every `return` statement of the body (tail ones too; an expression body is one), source order. `tuple`: the value is a tuple literal, `values` its elements; else one value (none for `return;`). A value is unwrapped from `await`, parentheses, casts and `!`; `variable`: an identifier the body declares (not a parameter or field); `empty`: `null` / `default`. Lambdas and local functions are excluded. |
| `getEntryPoints` | `{}` | `EntryPoint[]` (`{ kind: "http" \| "cli" \| "job" \| "handler" \| "test", label, verb?, detail?, method: MethodRef }`, FR-16.1) — the C# entry points of that row; minimal APIs need a constant pattern, a lambda handler → the enclosing method; top-level statements are labelled `Program.cs (top-level statements)`. Sorted by kind (http, cli, job, handler, test), then label. |
| `getModuleFacts` | `{ classKey }` | `ModuleFacts \| null` (`{ ports, libraries, dependsOn }`, FR-7.7) — over all declarations of the type: `ports` = names of the source interfaces / abstract classes / delegates used as constructor or method parameter, field or property types; `libraries` = full names of referenced metadata types (`System.Net.Http.HttpClient`); `dependsOn` = referenced source types (top-level, not itself). `null` for unknown / metadata types. |
| `getProjectTypes` | `{}` | `FileType[]` (FR-31.1) — `getFileTypes` over every regular (not generated) file of the solution. |
| `getFileTypes` | `{ file }` (absolute) | `FileType[]` (`{ type: ClassRef, methods: MethodRef[] }`, FR-31.1) — the types declared in the file (nested ones too), each with its ordinary methods and constructors declared in that file (partial types: only this file's part). `[]` when the file is not in the solution. |
| `getBindings` | `{}` | `ContainerBinding[]` (`{ abstract, concrete, consumer?, range, key?, lifetime?, fallback?, keyKind? }`, FR-8.6, shape in `packages/core/src/adapter.ts`) — the DI registrations of the solution (`services.Add…`, keyed registrations with their key, Autofac `Register…`). |
| `getHostsOf` | `{ file }` (absolute) | `string[]` (FR-8.6) — the executable projects that can run the file's code; a binding applies only to code its hosts run. Empty = one application. |
| `getMemory` | `{}` | `{ pid, workingSet, managedHeap }` (FR-34.1) — this process's working set and managed heap, in bytes. |
| `updateFile` | `{ file, content? }` | `null` — re-read from disk (or use `content`); added/removed files are picked up. |
| `shutdown` | `{}` | `null`, then the process exits. |
| `exit` | `{}` | `null`; accepted but does nothing (only `shutdown` ends the process). |

## C# specifics for `getOutgoingCalls`

- `ReceiverOrigin`: `this.M()`/`M()` on the own type → `self`; `base.M()` → `super`;
  `_field.M()` / `this._field.M()` / a primary-constructor parameter → `field`;
  parameters → `parameter`; locals → `local`; `Type.M()` and static usings → `static`;
  extension methods and extension block members → `static` with `receiverType` = the extension class; `new X().M()` →
  `{ kind: 'created', ordinal }` (the creation's call site, FR-5.4); other expressions → `expression`.
- `receiverType`: the static type of the receiver (may be an interface or abstract class).
- `typeParameter` (FR-5.9): on a creation of a generic type parameter (`new TResponse { … }`) its name; `receiverType` is
  then its first class constraint and `target` absent.
- `typeArguments` (FR-5.9): on a generic call `{ name, type?, parameter? }[]` — the method's and its containing types' type
  arguments (`ToResponse<Dto, DtoResponse>()` → `TData`→Dto, `TResponse`→DtoResponse); `parameter` when the caller passes one
  of its own type parameters on.
- `isAsync`: the call is awaited or returns `Task`/`ValueTask`/`IAsyncEnumerable`.
- `args`: argument source texts with comments stripped and whitespace collapsed; `argOrigins`
  where the argument is a simple `this`/field/parameter/local/`new X()`. `argOrigins` and
  `argFunctions` are aligned with the target's parameters: for an extension call `x.Ext(a)` the
  receiver `x` comes first (`args` stays as written).
- `argFunctions` (FR-1.13, optional): per argument, a method group passed as a delegate →
  `{ kind: 'method', target, receiver, receiverType, isLibrary, libraryName? }` (receiver as for an
  invocation of that method), a lambda / anonymous method → `{ kind: 'lambda', range }`; when the
  receiving method is project code also `params` and `calls` (the body's call sites, own ordinals),
  drawn where that method invokes the parameter (FR-1.11).
- Lambdas passed to a library / unresolved method (LINQ, `List.ForEach`, `ContinueWith`) are entered:
  their calls follow the receiving call, with a `loop` (iteration methods, guard `each u in users`)
  or `callback` (guard `task.ContinueWith`) scope in front of their own `fragments` (FR-1.11).
- `invokedParameter` (FR-1.13, optional): the call invokes a delegate-typed parameter of the
  analysed method — `onSuccess(x)` or `onSuccess.Invoke(x)`; `target` is then absent and
  `isLibrary` false (the session resolves it to what the caller passed). `invokedParameterType`: the
  parameter's type when it is a delegate type declared in the solution (the port); absent for `Func`/`Action`.
- `assignedTo`: for `var x = new X()` / `_x = new X()` (lets the session merge participants).
- `result` (invocations only, FR-9.4): `{ kind: "assign", target, operator }` for `var x = F()`,
  `_x = F()`, `this.X ??= F()`, `var (a, b) = F()` (target as written, `this.`/`var` dropped), object
  initializer members (`Site = F()`); `{ kind: "return" }` for `return F()` and `=> F()`; absent when
  the value is an argument, a condition, a receiver of a chain or discarded.
- `returnType` (invocations only, FR-9.5): minimally qualified display string of the declared
  return type, `Task<T>`/`ValueTask<T>` unwrapped when awaited; absent for `void` / awaited `Task`.
- Property accesses are not calls (keeps diagrams clutter-free); explicit method invocations,
  constructor calls and delegate invocations of fields are.
- `fragments` (FR-1.10, optional): the enclosing control-flow constructs of the body, outermost
  first, as `FragmentScope { id, kind, operand, guard?, negatedGuard?, range? }` (shape in
  `packages/core/src/adapter.ts`). `id` is shared by all operands of one construct
  (`if@<spanStart>`, `cond@…`, `switch@…`, `loop@…`, `try@…`). Kinds: `if`/`else if`/`else`
  chains and `?:` chains → `alt` (`opt` for a lone `if`), operand = branch index, else guard
  `else` with `negatedGuard` for two-branch chains; `switch` statement → one operand per section
  (guard `x = A | B`, patterns `x is …`, `when …` appended, `default` = `else`); switch
  expression → one operand per arm (`_` = `else`); `for` (condition, incrementors, body),
  `foreach` (body only; guard `each x in xs`), `while`, `do` → `loop`; `try` block → `try`
  operand 0, `catch` clause k → operand k+1 (guard `catch Type when filter`); `finally`, the
  first `if` condition, a loop's collection expression and `for` initialisers are outside.
  `range` = the condition (navigation target).

## Behaviour notes (beyond the contract)

- **Keys.** Parameter types drop nullable reference annotations (`string?` → `string`) but keep
  `ref`/`out`/`in` modifiers. Generic methods carry their arity like types (`Where`1(...)`).
  Local functions are keyed under their containing method:
  `<methodKey>.<Name>(<paramTypes>)`. Top-level statements are
  `Program.<Main>$(string[])` (name `Main`). A delegate-typed field or property invoked like a
  method gets a body-less target `<typeKey>.<member>`.
- **Calls.** Instance and static methods of the own type (or a base type) called by simple name
  are `self`. `Type.M()` and `using static` calls are `static`. Delegate parameters and locals
  invoked directly are unresolved calls with a `parameter` / `local` receiver. Constructor
  chaining (`: base(...)`, `: this(...)`, primary-constructor base arguments) is a `call` named
  `constructor` with a `super` / `self` receiver. Constructors include the field and property
  initializers they run. Object initializers come after the creation. Query expressions only
  evaluate their first `from` source. `args` / `argOrigins` follow source order, including
  named arguments.
- **Implementations / callers.** Test code (test projects such as `*.Tests`, or `tests/`
  folders) never provides implementations. Callers list test code last. Callers include calls
  made through the interface or base members that the method implements or overrides (Find All
  References cascade). Method-group references are not calls.
- **ClassInfo.** `methods` lists ordinary methods, operators and explicit constructors
  (including the primary constructor), not properties. Fields include auto-properties.
  `kind` is `external` for every metadata type.
