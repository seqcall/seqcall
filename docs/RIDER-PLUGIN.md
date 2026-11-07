# Rider plugin (also PhpStorm)

**Core (Node) and the webview (HTML/SVG) run unchanged in JetBrains Rider**: the plugin hosts the views in JCEF
and runs core as a Node sidecar. Install: docs/INSTALL.md.

## Architecture

```
Rider (JVM, packages/rider, Kotlin)            Node sidecar (packages/stdio-host)       C# sidecar
 ├─ action "Show Sequence Diagram" ──openAt──▶  HeadlessController ── DiagramSession ── Seqcall.CSharp.dll
 ├─ tool window "Seqcall"               (core: TsAdapter / RpcLanguageAdapter)   (child of the
 │   ├─ Sequence tab: JBCefBrowser ◀──post──    one session per project root               Node sidecar)
 │   └─ Class tab:    JBCefBrowser ◀──post──
 │        └─ window.__seqcallHostPost → JBCefJSQuery ──view──▶
 ├─ navigate ◀──────────────────────────────── navigate
 └─ VFS changes / caret ──filesChanged / caretMoved──▶
```

- **Only `packages/rider` knows the IntelliJ SDK** (same rule as `packages/vscode`). It contains
  no analysis or view logic: view messages go to the sidecar unchanged, `post` notifications go
  to the views unchanged.
- **`packages/stdio-host`**: `HeadlessController` is the editor-agnostic counterpart of
  `packages/vscode/src/controller.ts` (renders, live class view, highlight, setLayer, refresh);
  `server.ts` wraps it in newline-delimited JSON-RPC. Bundled with esbuild to
  `dist/stdio-host.cjs` (incl. TypeScript; lib.*.d.ts copied next to it). It partly duplicates the
  VS Code controller.
- **Webview unchanged.** The window bridge (`packages/webview/src/bridge.ts`) posts via
  `window.__seqcallHostPost` when a host defines it. The plugin writes a small HTML page per view
  (temp dir) that defines it — calling the `JBCefJSQuery` — **before** the bundle runs, and maps
  the IDE colours/fonts to the `--vscode-*` variables (`IdeTheme.kt`, body class
  `vscode-dark`/`vscode-light`). Scripts and CSS load from the plugin directory via `file://`.
  Host → view: `window.postMessage(<json>, '*')`; messages before the view's `ready` are dropped
  (the sidecar answers `ready` with the current state).
- **Node** (FR-15.5): `NodeLocator.kt`, which also tries common install locations after nvm.
- **dotnet**: if `dotnet` is not on the IDE's PATH, `~/.dotnet/dotnet` is passed as `SEQCALL_DOTNET`
  (+ `DOTNET_ROOT`).

## Sidecar protocol (stdio, newline-delimited JSON-RPC 2.0)

Same framing as the C# sidecar: one JSON object per line; stdout is protocol only (the bundle
redirects `console.log` to stderr), stderr is diagnostics. Messages are processed strictly in
arrival order. Host → sidecar (request with `id` → answered, or notification without `id`):

| Method | Params | Effect |
|---|---|---|
| `initialize` | `{ workspace?, csharpSidecar? }` | (Re)creates the controller; result `{ name, version, node }`. CLI args `--workspace`, `--csharp-sidecar` give the defaults. |
| `openAt` | `{ file, position }` | FR-1.1 diagram of the callable at the 0-based position. |
| `showEntryPoints` | – | FR-21.2 the entry-point list in the sequence view (browser mode: opens the page when none is connected), also before any diagram. |
| `view` | `{ view: 'sequence' \| 'class', message }` | A `SequenceViewToHost` / `ClassViewToHost` message (protocol package). |
| `viewClosed` | `{ view: 'class' }` | Stop deriving class diagrams. |
| `filesChanged` | `{ files }` | FR-13.1 refresh (`.seqcall.json` reloads the classifier). |
| `caretMoved` | `{ file, position }` | FR-2.4 highlight of the visible call at the caret. |
| `describeAt` | `{ file, position, word? }` | FR-33.6 Info at Caret: `{ lines, item, plain, routes, onName }` or `null` (a line starting with `item` belongs to the line above; `plain`: the lines with the items numbered). |
| `openReach` | `{ file, position, word?, index? }` | FR-33.7 entry point `index` of `routes` opens its flow down to the method; no `index`: the method's diagram with its Paths to here. |
| `memory` | – | FR-34.4 `{ lines, summary }`. |
| `freeMemory` | – | FR-34.4; result: what it did, as a sentence. |
| `shutdown` | – | Disposes adapters (C# sidecar) and ends the process. |

Browser mode (`--browser`, used by the Vim plugin) adds `showView`, `openBrowser` and the page URLs in the
`initialize` result: docs/VIM-PLUGIN.md.

Sidecar → host (notifications): `post { view, message }` (`HostToSequenceView` /
`HostToClassView`), `navigate { range }`, `showClassDiagram {}`, `log { level, message }`,
`progress { title | null }` (first analysis of a project; shown in the status bar).

## Build and run

```sh
npm run build:rider      # webview + stdio-host bundles (+ C# publish if missing), then Gradle test buildPlugin
RIDER_PATH=/opt/rider npm run build:rider   # Rider not installed by Toolbox: point RIDER_PATH at its folder
# → packages/rider/build/distributions/seqcall-rider-<version>.zip
```

- Builds **against the installed Rider** (`local(...)`, default the Toolbox path, override `RIDER_PATH` /
  `-PriderPath`) — no IDE download. `build.mjs` runs Gradle with Rider's bundled JBR (`SEQCALL_JAVA_HOME` overrides), so `JAVA_HOME` does not matter. Gradle's *JAVA_HOME is set to
  an invalid directory* means Rider is not at the path used: set `RIDER_PATH`.
- `prepareSandbox*` copies `webview/` (sequence.js, class.js, styles.css), `node/`
  (stdio-host.cjs + lib.*.d.ts) and `csharp/` (from `packages/vscode/dist/csharp`) into the plugin dir.
- Commands in the IDE (FR-15.4, FR-33.6, FR-34.4; install and use: docs/INSTALL.md). **Info at Caret**:
  `InfoAtCaret.kt` (`InfoHtml` builds the popup's HTML, IDE-free and JUnit-tested). A request that needs its answer
  uses `SidecarProcess.request(method, params) { response -> … }` (the callback is registered before the line is
  sent). Diagnostics: Help → Show Log (`SEQCALL` lines).
- **Self-update (FR-30.4/30.5)**: `Updates.kt` (release check and download; no IntelliJ classes, JUnit-tested) and
  `Updater.kt` (startup activity, action, notifications, settings). The
  install uses `loadDescriptorFromArtifact` + `PluginInstaller.installAfterRestart` — platform-internal API (what
  *Install Plugin from Disk* does), so check it on each new IDE major. Off in the `runIde` sandbox
  (`idea.plugin.in.sandbox.mode`); the action works there.
  Smoke run of the whole update: build a zip with a higher version, serve it from a fake GitHub (release JSON, the
  asset as a 302 to "storage"), then `SEQCALL_UPDATE_API=http://127.0.0.1:<port> SEQCALL_SMOKE_UPDATE=1 scripts/smoke.sh …`
  (the check runs at startup: `SEQCALL update: … installs at the next restart` in idea.log), stop and start the sandbox
  again: the new version is loaded. Delete `plugins_runIde/seqcall-rider` afterwards (the previous jar name stays).
  Other editors: docs/TESTING.md §5c.

## Tests

Suites: docs/TESTING.md §1 (stdio host: `packages/stdio-host/test/`). `packages/rider/src/test/.../PluginLogicTest.kt`
(JUnit, FR-15.3–15.6, FR-30.4/30.5): RPC parsing, view messages forwarded as JSON, Node lookup, HTML shell (hook
before the bundle, theme variables), the self-update against a fake GitHub, and a **JCEF-free bridge test** driving
the real bundled sidecar from the JVM (skipped when the bundle or Node 20+ is missing). JCEF itself: the smoke run
below and a DevTools screenshot (`scripts/jcef-screenshot.mjs`).

## Unattended smoke runs (`runIde`)

`packages/rider/scripts/smoke.sh <project> <file> <line>` starts a sandboxed Rider via `runIde`
with `SEQCALL_SMOKE_OPEN` (startup activity `SmokeStartup` opens the diagram after `DELAY` s, `CLASS=1`
the class view) and prints the plugin's `SEQCALL` log lines incl. a traffic trace. Sandbox-only
settings in `build.gradle.kts`: trust check off (Rider's "Trust solution?" dialog blocks),
`idea.is.integration.test` during smoke runs (Full Line's modal AI promo blocks the EDT), JCEF
DevTools on port 9223 (`scripts/jcef-screenshot.mjs` captures the rendered sequence / class view). The script also
removes stale Chromium `Singleton*` locks left by a killed sandbox. `runIde` gives the IDE `TMPDIR=/tmp` when the
inherited one is longer than 40 characters: Chromium puts its socket under `$TMPDIR`, and Unix socket paths are
limited to ~107 bytes (`cef_server` crashes otherwise). Keep the sandbox folder
`.intellijPlatform/sandbox/seqcall-rider/`: a fresh one has no licence and opens *Manage Licenses*, which blocks the
plugin. `smoke.sh stop` stops only processes whose config path is inside `packages/rider/.intellijPlatform`.

## Platform notes

- **JCEF**: bundled with the IDE as `com.intellij.modules.jcef` (declared dependency); a fallback label when
  unsupported.
- **Theming**: IDE colours are mapped when a view opens; a theme change needs the tool window reopened.
- **C#**: the sidecar is independent of Rider's ReSharper backend (a second Roslyn workspace in memory).

## Limitations

No persistence across restarts (filters, options, positions are in memory), no follow cursor, no undo for
"Move to layer" (writes the config directly), no settings for depth / arguments / maxMethods, no bundled Node
runtime, no Marketplace packaging/signing, own root detection instead of Rider's project
model.

## PhpStorm (and other IntelliJ IDEs)

The plugin uses only the common platform (`com.intellij.modules.platform` + `jcef`, no Rider APIs), so the same
zip runs in PhpStorm unchanged. Smoke run: `IDE_PATH=<phpstorm folder> packages/rider/scripts/smoke.sh …`
(sandbox in `.intellijPlatform/sandbox/seqcall-rider/PS-<version>/`; license it once). The default shortcut
**Ctrl+Alt+Shift+K** avoids Ctrl+Alt+Shift+U, JetBrains' own *Show Diagram*.

