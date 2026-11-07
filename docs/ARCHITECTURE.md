# Seqcall: Architecture

How Seqcall is built and why. Features: [FUNCTIONAL-REQUIREMENTS.md](FUNCTIONAL-REQUIREMENTS.md); how it is tested:
[TESTING.md](TESTING.md); Rider / stdio host: [RIDER-PLUGIN.md](RIDER-PLUGIN.md); Vim / browser mode:
[VIM-PLUGIN.md](VIM-PLUGIN.md); C# sidecar: [CSHARP-SIDECAR.md](CSHARP-SIDECAR.md).

## Overview

```
┌──────────────────────────── VS Code extension host (Node) ─────────────────────────────┐
│ packages/vscode  (thin editor glue — the ONLY package importing `vscode`)              │
│   commands, editor context menu, follow-cursor, reveal/highlight, file watcher,        │
│   workspace-state persistence, webview panel hosting                                   │
│        │ uses                                                                          │
│        ▼                                                                               │
│ packages/core   (editor-agnostic, language-agnostic)                                   │
│   DiagramSession  — exploration state machine: root, expansions, impl choices,         │
│                     hide filters, history → SequenceDiagram + ClassDiagram models      │
│   Classifier      — stereotypes & layers (heuristics + .seqcall.json)                  │
│   LanguageAdapter — interface; implemented by:                                         │
│     core/src/ts/TsAdapter  (TypeScript compiler API + LanguageService)                 │
│     core/src/php/          (php-parser, in-process)                                    │
│     core/src/rpc/RpcLanguageAdapter → C# Roslyn sidecar (packages/csharp)              │
└────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ postMessage (JSON, typed by packages/protocol)
          ▼
┌──────────────────────────── Webview (browser sandbox) ─────────────────────────────────┐
│ packages/webview  (no editor API; only the protocol)                                   │
│   sequence view: layout engine (pure), SVG renderer, frozen header, drag, tidy,        │
│                  context menus, toolbar, hidden-filters dropdown                       │
│   class view:    ELK layout (dagre fallback), SVG renderer                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Other editors:** `core` runs as a Node sidecar (`packages/stdio-host`) speaking the same JSON
messages over stdio (JSON-RPC). Rider / PhpStorm (`packages/rider`, Kotlin) load the `webview` bundle into a JCEF
browser; Vim / Neovim (`packages/vim`) use the sidecar's browser mode, which serves the views to a browser tab.

**Other languages:** implement `LanguageAdapter` (one level of outgoing calls,
implementations, callers, class info). Everything above it is reused.

### Packages (npm workspaces)

| Package | Purpose | Key deps |
|---|---|---|
| `packages/protocol` | Types only: diagram and class models, host⇄view messages. **The contract.** | – |
| `packages/core` | Editor-agnostic engine: `LanguageAdapter` (`adapter.ts`), `TsAdapter` (`src/ts/`), PHP adapter (`src/php/`), `RpcLanguageAdapter` + `createCSharpAdapter` (`src/rpc/`), `Classifier` (layers, stereotypes, `.seqcall.json`), `DiagramSession` (`session.ts`, `session/`), class-diagram derivation, layer hints, config editing (`config-edit.ts`). | `typescript`, `php-parser`, `picomatch`, `jsonc-parser` (ESM build: the UMD build breaks bundling) |
| `packages/webview` | Editor-agnostic UI (vanilla TS + SVG): sequence view (`src/sequence/`), class view (`src/class/`: ELK `elk.ts`, dagre fallback `layout.ts`), shared pan / zoom / menus / layers. Bundles `dist/sequence.js`, `dist/class.js`, `dist/styles.css`. | `elkjs`, `@dagrejs/dagre` |
| `packages/vscode` | VS Code host: commands, panels, navigation, persistence, refresh, output channel *Seqcall*; bundles core + webview into `dist/`. | `@types/vscode` |
| `packages/csharp` | Roslyn sidecar `Seqcall.CSharp`, JSON-RPC over stdio, + xUnit tests ([CSHARP-SIDECAR.md](CSHARP-SIDECAR.md)). | Roslyn, MSBuildWorkspace |
| `packages/stdio-host` | Core as a Node sidecar: `HeadlessController` + JSON-RPC on stdio, `--browser` mode (`src/browser.ts`); bundle `dist/stdio-host.cjs` ([RIDER-PLUGIN.md](RIDER-PLUGIN.md), [VIM-PLUGIN.md](VIM-PLUGIN.md)). | – |
| `packages/rider` | JetBrains plugin (Kotlin, Gradle), JCEF tool window, starts the Node sidecar. | IntelliJ Platform |
| `packages/vim` | Vim 9 (Vim9 script) and Neovim (Lua) plugin in one package; diagrams in a browser tab. | – |
| `packages/cli` | CLI and MCP server for AI agents and scripts, Claude Code plugin in `agent/` (FR-27). | – |
| `packages/devhost` | Browser host (real core + webview) for visual checks; scripts for screenshots, probes and sweeps (`scripts/`). | – |
| `fixtures/sample-app` | Layered TS app (controllers / services / ports / adapters / domain, functional ports, a deliberate Domain→Infrastructure violation). | – |
| `fixtures/sample-cs` | Layered C# solution (Web / Core / Infrastructure). | – |
| `fixtures/php-app` | Layered Laravel-style PHP app (interfaces with one / two implementations, facades, enums, closures, abstract self-calls). | – |
| `fixtures/io-app` | Small TS app with real I/O (`node:fs/promises`, `fetch`, `process.stdout`) for FR-17. | – |

Build: `esbuild` (extension → CJS with `vscode` external; webview → IIFE). Tests: [TESTING.md](TESTING.md).

## Key design decisions

1. **Lazy, one-level analysis.** `LanguageAdapter.getOutgoingCalls(method)` returns only the
   direct call sites of one method body. The session expands on demand, so a diagram is fast and
   expand / collapse comes naturally.
2. **Stable message ids = call path.** `id = parentId + "/" + ordinal + ":" + methodName`,
   where `ordinal` is the call site's index in the parent body (`root/2:findUser/0:findById`).
   Expansion state, implementation choices and hide decisions are keyed by these ids / keys, so a
   refresh after an edit keeps the state wherever the path still exists (FR-13.1).
3. **Participant identity** (FR-6.5): `(classKey, receiverOrigin)`, where the origin is
   `this` / field name / parameter name / local name / static. Static calls → one «static»
   participant per class. Labels are computed *after* filtering, so naming (FR-6.2) reflects only
   the visible participants.
4. **Filtering happens in the session**, not in the view: the view receives exactly what to draw,
   plus the hidden-filter list with counts. The class diagram is derived from the same filtered
   model, so the two views always agree (FR-12.4). A problem of the code (layer violation, finding,
   review change) is computed once in core, with evidence for both views (FR-19.17).
5. **Layout in the webview.** The sequence layout engine is a pure function (model + options +
   manual x-positions → geometry), unit-tested without a DOM; text is measured through an
   injectable `measureText` (canvas in the browser, an estimate in tests). Dragged positions go to
   the host (`savePositions`), which keeps them per root method.
6. **Frozen header:** the participant heads are a separate SVG in a `position: sticky` element
   inside the same scroll container, so they scroll sideways with the body but not down.
7. **Lists in the webview, not native pickers** (callers, implementations, entry points), so the
   interaction is the same in every editor.
8. **Class layout with ELK** (layered algorithm, orthogonal or spline routing, partitions for the
   *Layers* lanes): ELK gives each edge its own channel and port, where dagre with hand-written
   lane corridors merges edges into shared channels and crosses boxes. Costs: a ~1.5 MB class bundle, an asynchronous layout (cached per diagram / lanes / routing;
   a drag only re-assembles), the EPL-2.0 licence. dagre stays as the synchronous fallback.
9. **Asynchronous adapters.** `LanguageAdapter` and `DiagramSession` are async, so an adapter can
   live in another process: the C# adapter is `RpcLanguageAdapter` talking to the Roslyn sidecar.
   The host picks the adapter per file (`.cs` → the nearest `.sln` / `.slnx` / `.csproj`).

## Contracts

- `packages/protocol/src/index.ts`: diagram models (`SequenceDiagram`, `ClassDiagram`, …),
  `DiagramOptions`, and the host ⇄ view messages (`HostToSequenceView`, `SequenceViewToHost`,
  `HostToClassView`, `ClassViewToHost`). Changes are additive (optional fields, new variants).
- `packages/core/src/adapter.ts`: `LanguageAdapter` and its DTOs (`CallSite`, `ReceiverOrigin`,
  `ClassInfo`, …) — what a new language implements.
- `packages/core/src/session.ts`: `DiagramSession`, the exploration state machine
  (`session/build.ts`, `session/cache.ts`, `session/fragments.ts`).

## TypeScript analysis (`packages/core/src/ts/`)

- **Program** (`host.ts`, `ts-adapter.ts`): `ts.createLanguageService` over the workspace
  `tsconfig.json` (or `jsconfig.json`; fallback: all `*.{ts,tsx,js,jsx}` with `allowJs`), updated
  incrementally through a versioned in-memory `LanguageServiceHost`.
- **Enclosing callable**: walk up from the token at the position to the nearest method,
  constructor, accessor, function declaration or variable initialised with a function.
- **Outgoing calls** (`calls.ts`): depth-first post-order walk of the body (receivers and
  arguments before the call → evaluation order), collecting `CallExpression` and `NewExpression`.
  Nested functions are not entered, except lambdas passed to a library or unresolved function
  (`map`, `forEach`, `then`), whose calls follow the receiving call in a loop / callback scope
  (FR-1.11). A lambda passed to a project function is drawn where that function invokes it
  (`argFunctions`, FR-1.13).
- **Resolution** (`resolve.ts`): `checker.getResolvedSignature(call).declaration`, falling back to
  the symbol of the callee expression (aliases resolved). The declaration's owner → `ClassRef`; a
  source file in `node_modules` or the default lib → library call.
- **Combined fragments** (FR-1.10, `fragments.ts`): each call site carries the enclosing
  control-flow scopes of the body (`CallSite.fragments`: construct id, kind, operand, guard,
  range); `DiagramSession` turns runs of visible children with equal scopes into nested
  `Fragment`s (`session/fragments.ts`), and the view lays them out as extra rows
  (`placeFragments` in `webview/src/sequence/layout.ts`).
- **Receiver origin**: `this.x` → field `x`; an identifier → parameter / local / imported module;
  `this` → self; `super` → super; `ClassName.m()` → static; `new X().m()` → the created object;
  anything else → expression.
- **Implementations and callers** (`callers.ts`): `getImplementationAtPosition` on the interface
  member, filtered to class members; `findReferences` on the method name, keeping call references,
  mapped to their enclosing callable.
- **Class info** (`class-info.ts`): decorators, `extends`, `implements`, constructor parameter
  and property types (associations, «seam»), private constructor / static instance («singleton»).

PHP (`src/php/`) follows the same shape on php-parser with declaration-based types; C# is in
[CSHARP-SIDECAR.md](CSHARP-SIDECAR.md).

## Sequence view (`packages/webview/src/sequence/`)

- **Geometry** (`layout.ts`): a participant column is as wide as its label or stereotype line plus
  padding; one row per message (a self message takes two); activation bars come from the message
  nesting; a «create» message places the participant head at its row.
- **Group bands**: one rectangle per (layer, namespace) group above the participant heads, in the
  frozen header, with an extra gap where the group changes.
- **Tidy up** (`tidyPositions`): x positions recomputed so that each gap is the larger of the
  minimum gap and the widest label between two adjacent lifelines.
- **Interactions**: a view only posts intents (`navigate`, `expand`, `collapse`, `savePositions`,
  menu commands …); the host runs them on the session and posts a new `render`.
- **Theme**: `--vscode-*` CSS variables with fallbacks; the Rider host sets them from the IDE theme
  (`IdeTheme.kt`), the browser mode uses the fallbacks.
