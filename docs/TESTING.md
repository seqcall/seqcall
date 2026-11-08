# Testing Seqcall

How the functionality is verified: automated suites (every change), visual checks (after UI changes), smoke tests
on real codebases (after analysis changes), and debugging techniques.

## 1. Overview

| Level | What it proves | Where | Command | Time |
|---|---|---|---|---|
| Core integration | Analysis + session behaviour on a real TS project | `packages/core/test/*.test.ts`, fixtures `fixtures/sample-app`, `fixtures/io-app` (real `node:fs`/`fetch` calls, FR-17) | `npx vitest run packages/core` | ~3 s |
| PHP adapter | FR-18 on a Laravel-style fixture, plus the session (implementations, I/O) | `packages/core/test/php-adapter.test.ts`, fixture `fixtures/php-app` | `npx vitest run packages/core/test/php-adapter.test.ts` | <1 s |
| Golden diagrams | Every diagram of the fixtures stays as it is: each entry point (plus the main sample flows) opened, after ✦ Overview, after Expand all, and its class diagram, as text | `packages/core/test/golden.test.ts`, expected `packages/core/test/golden/<fixture>.txt` (§2a) | included in `npm test`; accept an intended change with `-u` | ~15 s |
| C# end-to-end | Same through the **real Roslyn sidecar** | `packages/core/test/csharp-integration.test.ts`, fixture `fixtures/sample-cs` | included in `npm test` (skipped if dotnet/sidecar build missing) | ~5 s |
| RPC client | Sidecar process handling (restart, timeouts, null mapping) | `packages/core/test/rpc-adapter.test.ts` + `test/fixtures/fake-sidecar.mjs` | `npm test` | <1 s |
| Webview | Layout geometry (pure) and DOM behaviour (jsdom) | `packages/webview/test/*.test.ts` | `npx vitest run packages/webview` | ~3 s |
| Sidecar | Roslyn analysis in-process + one stdio end-to-end | `packages/csharp/tests/Seqcall.CSharp.Tests` (xUnit) | `cd packages/csharp && dotnet test` | ~5 s |
| Sidecar host / browser mode | Headless controller, JSON-RPC framing, browser mode (token, SSE push, POST intents) | `packages/stdio-host/test/*.test.ts` | `npx vitest run packages/stdio-host` | ~2 s |
| Self-update (FR-30) | Release check shared by Vim and the agent CLI (versions, download, GitHub refusals — fake `fetch`); the Vim package swap (real `tar`) | `packages/core/test/update.test.ts`, `packages/stdio-host/test/update.test.ts`, `packages/cli/test/update.test.ts` (editor sides: `vim-package.test.ts`, Rider `PluginLogicTest`) | `npx vitest run packages/core/test/update.test.ts packages/stdio-host/test/update.test.ts` | <1 s |
| Browser user stories | The real page in headless Chrome against the production browser-mode stack (controller + core on `sample-app`): real clicks reach their buttons, menus, find, the entry-point list, Layers, the class page in step with the sequence page, the editor told to navigate, no overlapping boxes, no page error (§5d) | `packages/stdio-host/test/page.test.ts`, driver `test/cdp.ts` | included in `npm test` (skipped without Chrome) | ~10 s |
| Vim / Neovim plugin | Real headless Vim 9 and Neovim against the real sidecar; the test plays the browser page (FR-21) | `packages/vim/test/*.test.ts` | `npx vitest run packages/vim` (per editor: skipped without Vim / Neovim) | ~8 s |
| Rider plugin | RPC client, Node lookup, theme mapping (FR-15.3–15.6); JCEF by a sandboxed smoke run | `packages/rider/src/test/kotlin/…/PluginLogicTest.kt` (JUnit); `packages/rider/scripts/smoke.sh` | `node packages/rider/build.mjs test` (Gradle with Rider's JBR); smoke: docs/RIDER-PLUGIN.md | – |
| Extension host | Real VS Code: activation, commands, panels, webviews really render (incl. ELK under CSP), navigation, refresh, config writes | `packages/vscode/test/suite/extension.test.ts` | `npm run test:ext` (needs a display) | ~1 min |
| Visual | Looks right (overlaps, clipping, colours, both themes) | dev host + `packages/devhost/scripts/screenshot.mjs` | §7 | manual |
| Smoke | Works on real code, timings | `packages/devhost/scripts/probe.ts`, dev host | §8 | manual |
| Quality baseline | No drop on the developer's own real code since the last run / release | `scripts/baseline.mjs` | `npm run baseline` (§8a) | before a release |
| Coverage | Which lines the suites run: TS/JS (vitest, in-process only), the VS Code host (extension-host tests), the C# sidecar (xUnit), the Rider plugin (JUnit), §11 | `vitest.config.ts` (`coverage`), `scripts/coverage-vscode.mjs`, `scripts/coverage-cs.mjs`, Kover in `packages/rider/build.gradle.kts` | `npm run coverage` (~4 min), `npm run coverage:vscode` (~1 min), `npm run coverage:cs` (~30 s), `npm run coverage:kt` (~4 min) | – |
| Static analysis | No open bug, vulnerability or issue of medium severity or higher (SonarQube Cloud, release gate) | `.github/workflows/sonar.yml`, `scripts/sonar.mjs`, `sonar-project.properties` | GitHub Actions: every push to main and every release, when configured (§10) | ~10 min in CI |
| Comment rule | Added comment lines hold no history, dates or measured numbers (AGENTS.md, Conventions; pre-commit hook, blocks) | `scripts/check-comments.mjs`, `scripts/hooks/pre-commit` | `node scripts/check-comments.mjs --all` (existing hits) | < 1 s |
| Leak check | Nothing of the developers' real repositories in the repository: the tracked files, each commit and its message, the release packages (§10a; hooks and the Release workflow, block) | `scripts/leak-check.mjs`, `scripts/hooks/pre-commit`, `scripts/hooks/commit-msg`, local `.leak-check.json` | `npm run leak-check`; packages: `node scripts/leak-check.mjs release/*`; audit: `--compare` | ~2 s; audit ~1 min |

Before every commit: `npm run typecheck && npx vitest run && npm run test:ext` (+ `dotnet test` when touching
packages/csharp). CI (`.github/workflows/ci.yml`) runs the same, and the leak check, on every push to `main` and
every pull request; the Rider plugin's tests run only in the release workflow.
Test names carry FR ids (`it('FR-5.1 …')`): `grep -rn "FR-5.1" packages/*/test` finds a requirement's tests.

## 2. Core integration tests (vitest, TypeScript fixture)

- Fixture `fixtures/sample-app` is a small layered app (only analysed, never executed) with every scenario:
  controllers → services → ports with two implementations, two fields of one interface type (named participants),
  abstract base + overrides, singleton, static utility, module functions, recursion, callbacks that must not be
  expanded, functional ports (records of functions with object-literal/factory implementations), a test file with
  fakes, a deliberate Domain → Infrastructure violation, `.seqcall.json` with custom layers.
  **Add fixture code for a new scenario rather than mocking the adapter.**
- Helpers (`packages/core/test/helpers.ts`): `newSession(deps?)` (shared TsAdapter — program creation is the slow
  part), `await method(K.getUser)` → MethodRef, `K` / `C` stable keys, `positionOf(rel, needle)`, `byId(diagram, id)`.
- Pattern (session API is async):
  ```ts
  const s = newSession();
  await s.openMethod(await method(K.getUser));
  const d = (await s.expand('root/2:findUser'))!;          // message ids are call paths
  expect(d.participants.map((p) => p.label)).toContain('primary:UserRepository');
  const cd = (await s.getClassDiagram())!;
  ```
- Fragments as compact strings (`fragments.test.ts`: `alt [g1] first..last [g2] …`), so a diagram's frames fit one
  `toEqual`.
- A *counting adapter* — `Object.create(sharedAdapter())` with a wrapped method (`type-uses.test.ts`: `getTypeUses`)
  — proves that an option costs no requests while off and that results are cached.
- C# end-to-end uses the real sidecar dll (`resolveCSharpSidecar()`); build: docs/CSHARP-SIDECAR.md.

## 2a. Golden diagrams

`golden.test.ts` opens every entry point of `sample-app`, `io-app`, `php-app` and `sample-cs` (C#: only with the built
sidecar and the restored fixture), plus a list of sample flows, as ⌂ does, and writes each diagram as text
(`golden-format.ts`: participants with layers and stereotypes, calls with kind, sender → receiver, arguments, ⊕ / ⊖,
implementations, I/O, frames with their guards, exit markers, issues; the class diagram's classes and relations) in
three states per flow: opened, ✦ Overview, Expand all. No file positions (editing a fixture moves lines, not the
flow). Any difference with `golden/<fixture>.txt` fails the test; vitest prints the diff.

- An unintended change is a regression — fix the code.
- An intended change (a new feature, a better label): check the diff line by line, accept it with
  `npx vitest run packages/core/test/golden.test.ts -u` and commit the `.txt` with the change; the diff in the commit
  records what users will see differently.
- A new fixture shape reachable from an entry point is covered automatically; otherwise add its method key to
  `SAMPLE` / `IO` in the test.

## 3. Webview tests (vitest + jsdom)

- Pure layout tests (`sequence-layout.test.ts`, `class-lanes.test.ts`, `zoom.test.ts`, `class-elk.test.ts`,
  `fragments.test.ts` — frames added to a clone of the mock diagram): call `layoutSequence` / `layoutClassDiagram` /
  `layoutClassDiagramElk` and assert geometry (no overlaps, order, spacing, lanes containment,
  `edgeScore(g) < 10000` = no edge through a box).
- DOM tests: `// @vitest-environment jsdom` at the top, then
  ```ts
  const bridge = testBridge<HostToClassView, ClassViewToHost>();     // test/helpers.ts
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram: mockClassDiagram });         // dev/mock-data.ts
  fire(el, 'click');                                                  // or dispatchEvent(new MouseEvent(…))
  expect(bridge.last()).toEqual({ type: 'navigate', range: … });     // intents the view posts
  ```
- jsdom has no text measurement and no layout: always inject `estimateTextWidth`; scroll positions are plain
  properties (pan tests set/read `scrollLeft`).
- Class view: `engine: 'dagre'` renders synchronously; the default ELK engine is async → `await view.settled()`
  (see `class-elk.test.ts`).
- State persistence: start a second view on the same `testBridge` (it keeps `setState`).
- Mock data (`packages/webview/dev/mock-data.ts`) is shared with the browser harness
  (`npm run dev -w @seqcall/webview`, open `packages/webview/dev/sequence.html`).

## 4. C# sidecar tests (xUnit)

`fixtures/sample-cs` must be restored, because `Sample.Batch` uses a NuGet package (Autofac); otherwise the Autofac
registrations are not found and the FR-8.6 tests fail. Both suites restore it themselves when
`Sample.Batch/obj/project.assets.json` is missing, before loading it (xUnit: `TestPaths.SampleRoot`; vitest:
`csharp-integration.test.ts`). It is not a build step: a `dotnet restore` started from inside a build hangs the
build. By hand: `dotnet restore fixtures/sample-cs/Sample.sln`.

`SampleFixture.cs` loads `fixtures/sample-cs` once per test run; tests call the adapter in-process (`FragmentTests`:
scopes per call as `kind#operand[guard]` strings). `EndToEndTests` starts the built dll and talks JSON-RPC over stdio.
Shapes the sample solution lacks: small in-memory projects (§11).

## 5. Extension-host tests (real VS Code)

- `npm run test:ext` bundles the suite, downloads VS Code into `.vscode-test/` (first time), opens
  `fixtures/sample-app` with other extensions disabled. `VSCODE_TEST_VERSION` picks the VS Code version (default
  `stable`), `SEQCALL_TEST_WORKSPACE` another workspace.
- `activate()` returns a **test API** (`SeqcallTestApi` in `packages/vscode/src/extension.ts`):
  `sequenceMessages()` / `classMessages()` (everything the host posted), `simulateViewMessage(msg)` /
  `simulateClassViewMessage(msg)` (act as the webview), `logs()` (output channel incl. webview diagnostics), panels.
  Tests never poke into webview DOM.
- **Webviews really render**: views post `log` messages after drawing (`class view rendered N classes … (elk)`); the
  FR-12.1 test waits for them and asserts no `error` logs — this catches CSP/bundling problems.
- Tests run **in order and share state** (one extension instance): a later test may rely on the diagram an earlier
  one opened; a test that needs a specific diagram opens it itself (e.g. the FR-7.5 test re-opens `getUser` because
  the C# test ran before). Tests that write files (save refresh, `.seqcall.json`) restore them in `finally`.
- **Late renders**: an earlier action can still post after its message was handled (the I/O scan's re-render
  FR-17.5, cursor / file-watcher / setting reactions). Take the baseline count with `await settledRenders()` (or
  `await api.settled()` before `classRenders().length`): it waits until no background work runs and nothing was posted
  for 300 ms. A plain `renders().length` can take the previous action's late render for the next one.
- C# in the extension host is tested with a **fake sidecar** (`SEQCALL_DOTNET` = node,
  `SEQCALL_CSHARP_SIDECAR` = `packages/core/test/fixtures/fake-sidecar.mjs`).

## 5b. Vim and Neovim plugin tests (real headless editors)

- Every scenario runs in **both** editors (scripts per editor, shared assertions). Neovim runs as
  `nvim --headless -u NONE -i NONE -n -S <script>.lua` with `nvimPrelude()` (records URLs through `setup{browser}`,
  messages through `vim.notify`; `vim.wait` runs the job and timer callbacks). The editor's stderr is kept in
  `<script>.err`; `KEEP=1 npx vitest run packages/vim/test/vim.test.ts` keeps the temp directory for debugging a
  broken script.
- Vim runs as `vim -N -u NONE -i NONE -n --not-a-term -es -S <script>`; the generated `vim9script` loads the plugin
  (`set rtp^=`), records the URLs it would open (`g:Seqcall_browser`) and waits with `:sleep`, which runs the channel
  and timer callbacks. Scripts report by `writefile(json_encode(...))`; helpers in `packages/vim/test/helpers.ts`.
- Both editors run with `-n` (no swap files): some tests open the repository's `fixtures/sample-app`, and a test that
  copies the fixture meanwhile would copy the swap file too, so its editor opens the file read-only and quits at
  `:write`.
- `vim -es` prints no messages, not even errors, so `<script>.err` stays empty. To see them, add
  `set verbosefile=<file>` at the top of the script: every message, including errors and prompts, goes there.
- **The test plays the browser**: it connects to the page's event stream and POSTs `ready` / clicks
  (`packages/stdio-host/test/sse.ts`), the same calls the real page makes.
- `vim.test.ts`: show → page URL → click (after `ä😀`: UTF-16 ↔ byte columns) → cursor highlight → `:write` refresh →
  `:SeqcallClass` / `:SeqcallOpen`. `vim-host.test.ts`: Node lookup with fake `node` scripts (setting /
  `$SEQCALL_NODE` / PATH / nvm, numeric version order) and the error paths (no file, unsaved changes, wrong sidecar
  path, a crashing sidecar); Neovim also `:checkhealth seqcall`. `vim-package.test.ts`: `build.mjs --out <tmp>
  --no-build` → layout and tarball, then the **installed package** on TS and on C# (with `~/.dotnet` removed from
  PATH: the plugin must find it; skipped without dotnet or a C# sidecar build).
- Cost: real editors, sidecars and Roslyn run in parallel with the rest of the suite. The C# end-to-end run is done
  once (Vim); each plugin's dotnet lookup is tested without Roslyn. `hookTimeout` is 30 s like `testTimeout`, since
  loading a TS project in a setup step can exceed vitest's 10 s default under that load.
- Missing bundles are built by `packages/vim/test/global-setup.ts` (vitest `globalSetup`) when Vim or Neovim is
  installed, so a fresh checkout runs these tests instead of skipping them.

## 5c. Self-update smoke run (FR-30)

The unit and plugin tests use a fake GitHub; the real install and restart need a real editor. Recipe: build the
plugin twice, the current version and a higher one (`version` in `packages/rider/build.gradle.kts`, set it back
after); serve the higher one from a small fake GitHub on 127.0.0.1
(`/repos/seqcall/seqcall/releases/latest` with the asset, the asset url answering 302 to a "storage" url).

- **Rider**: `SEQCALL_UPDATE_API=… SEQCALL_SMOKE_UPDATE=1 packages/rider/scripts/smoke.sh …`, see docs/RIDER-PLUGIN.md.
- **Vim / Neovim**: automated — `vim-package.test.ts` runs `:SeqcallUpdate` in both editors on an installed copy of
  the package against a fake GitHub (`SEQCALL_UPDATE_API`).
- **Agent package**: install the plugin into an isolated Claude Code (`CLAUDE_CONFIG_DIR=<dir> claude plugin
  marketplace add <unpacked> && claude plugin install seqcall@seqcall`), serve a higher `seqcall-agent-*.zip`, run
  `node <dir>/plugins/cache/seqcall/seqcall/<v>/seqcall.cjs update` with `SEQCALL_UPDATE_API`;
  `installed_plugins.json` then has the new version.

What only this run checks: the download follows GitHub's redirect to storage. VS Code has no updater of its own
(FR-30.8): the marketplace updates it.

## 5d. User stories in a real browser

`packages/stdio-host/test/page.test.ts` runs the sidecar in browser mode in-process on `fixtures/sample-app` (the
production controller and core, the built page `packages/webview/dist` — rebuilt first when a webview source is
newer) and drives the page in headless Chrome over the DevTools protocol (`test/cdp.ts`, no dependency: one Chrome
per file, its own process group and a short profile path, both removed afterwards). Each story starts on a freshly
loaded page.

- Clicks are real mouse events at the element's centre and **hit-tested**: a button under a menu, card or another
  element fails the story ("covered at …"), which `el.click()` in jsdom never shows.
- Waits poll a condition (no fixed sleeps); `settled()` waits until the DOM has not changed for 400 ms (the
  background I/O scan and ELK render late).
- Every story fails on an uncaught exception or a console error in any page.
- Covered is what only a real page shows: ⊕ on a call, a click navigating the editor (the `navigate` notification),
  Hide from the context menu and ⊘ Filters, the ▾ menu, Ctrl+F and a hit in a collapsed call, ⌂, ◫ Layers, the
  class page (ELK) with a relation click highlighting calls in the sequence page; participant and class boxes do not
  overlap. Diagram content is the golden tests' (§2a); the VS Code webview under its CSP is FR-12.1's.
- Skipped when no Chrome is found: `$CHROME`, else `google-chrome-stable` / `chromium` / `google-chrome` on the PATH.
- A failing story: rerun the file alone; to see the page, add `await page.send('Page.captureScreenshot', …)` or run
  the dev host with `screenshot.mjs` on the same flow (§7).

## 6. Manual walkthrough

README → "Feature tour" lists the features on `fixtures/sample-app` with the expected result and the FR ids; walk
through it after larger changes in a real editor (VS Code: `npm run dev:host`).

## 7. Visual verification (after every UI change)

1. Build and start the dev host on a project (TS or C#):
   ```sh
   node packages/devhost/build.mjs                       # also rebuilds the webview
   node packages/devhost/dist/server.cjs fixtures/sample-app 4711 &
   ```
2. Load a diagram state by URL (the GET replays steps on the server session; every URL form, `entry=` included, and
   every replay action are listed in the header of `packages/devhost/src/server.ts`), then screenshot:
   ```sh
   curl -s -o /dev/null "http://localhost:4711/sequence?file=src/controllers/user-controller.ts&line=14&actions=expandAll,impl:root/2:findUser/0:findById=src/adapters/sql-user-repository.ts%23SqlUserRepository"
   google-chrome-stable --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
     --window-size=1500,900 --virtual-time-budget=5000 --screenshot=/tmp/seq.png "http://localhost:4711/sequence"
   ```
   Steps: `expandAll`, `collapseAll`, `expand:<messageId>`, `fold:<fragmentId>` (minimize, FR-1.12; encode `#` as
   `%23`, e.g. `fold:root%23loop0@0`), `impl:<messageId>=<classKey>`, `hide:<methodName>`, `uses` (type uses on in
   the class diagram, FR-12.12; or click `[data-cmd=uses]` in a step).
   With interaction (clicks, drags, Ctrl+wheel, JS evaluation, waiting for ELK):
   ```sh
   node packages/devhost/scripts/screenshot.mjs "http://localhost:4711/class" /tmp/cls.png 1400 900 \
     "document.querySelector('[data-cmd=view]').click();document.querySelector('[data-menu-id$=lanes]').click();'ok'" "new Promise(r=>setTimeout(r,2000)).then(()=>'w')"
   ```
   Dark theme: `DARK=1 node packages/devhost/scripts/screenshot.mjs …` (emulates `prefers-color-scheme: dark`; the
   plain Chrome command needs `--force-dark-mode --blink-settings=preferredColorScheme=0`). Compare layout engines:
   `/class?engine=dagre` vs default ELK.
3. Read the PNG and check: overlaps, clipped/truncated text, arrowheads at box edges, edges through boxes, label
   backdrops, colours in both themes, compactness (how many participants fit). Before/after screenshots for layout
   changes.
4. Real-mouse behaviour (not just synthetic DOM events): `drag:x1,y1,x2,y2` steps; a "wobbly click" is
   `drag:x,y,x+3,y+3`. Get coordinates with a JS step:
   `"(()=>{const r=document.querySelector('[data-class-key*=\"UserService\"]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()"`.
5. To observe what a view posts, wrap the bridge hook in a JS step:
   `"window.__posted=[];const o=window.__seqcallHostPost;window.__seqcallHostPost=m=>{__posted.push(m);return o(m)};'ok'"`,
   act, then `"JSON.stringify(__posted)"`.

## 8. Smoke tests on real codebases (after analysis changes)

Which real projects to use is per developer: `smoke-tests-repos.md` in the repo root (not in git, see AGENTS.md).
Real projects are **read only**. For a C# solution use a copy (MSBuild may write `obj/`):
`mkdir /tmp/app-copy && cd <solution root> && tar --exclude='*/bin' -cf - . | tar -xf - -C /tmp/app-copy`.

Text probe: participants with layer/stereotypes/hints, messages, class-diagram summary and violations, timing.

**Copy TypeScript's lib files next to the bundle**: the bundled compiler looks for `lib.*.d.ts` beside the script
(`packages/vscode` and `packages/devhost` copy them into `dist/`), else in the analysed project's own
`node_modules/typescript/lib`. Without either, a TS project is analysed with no standard library, **silently**:
`Number`, `Promise` and array types are missing, results are typed `any`, diagrams are shallower than in the editor.
Once per output folder: `cp node_modules/typescript/lib/lib*.d.ts /tmp/`.
```sh
npx esbuild --bundle --platform=node --format=cjs --log-level=error packages/devhost/scripts/probe.ts --outfile=/tmp/seqcall-probe.cjs
node /tmp/seqcall-probe.cjs <ts project> <relFile> <line0> <depth>
SEQCALL_CSHARP_SIDECAR=$PWD/packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0/Seqcall.CSharp.dll \
  node /tmp/seqcall-probe.cjs /tmp/app-copy <relFile.cs> <line0> <depth>
SMART=1 node /tmp/seqcall-probe.cjs fixtures/sample-app src/controllers/user-controller.ts 11 0   # smart expand + importance per message
# I/O badges (FR-17) are printed per message `[db below: …]` and participant `[DB: uses Npgsql…]`;
# C# copies need `dotnet restore` in the copy, otherwise library calls are unresolved;
# the background scan (FR-17.5) runs last and is timed (NOSCAN=1 skips it). The devhost waits for it.
# PHP: a root with composer.json is analysed with the PHP adapter. Resolution quality over all methods:
#   npx esbuild … packages/devhost/scripts/php-sweep.ts --outfile=/tmp/seqcall-php-sweep.cjs && node /tmp/seqcall-php-sweep.cjs <root>
# Paths to here (FR-22): the reverse tree of a method's callers up to the entry points, timed:
#   npx esbuild … packages/devhost/scripts/paths-probe.ts --outfile=/tmp/seqcall-paths.cjs && node /tmp/seqcall-paths.cjs <root> <relFile> <line0>
# Unreachable code (FR-31): the project-wide scan, timed per phase, with the listed methods by reason and the
# "missed" ones (a reference the walk does not follow — where the walk needs fixing):
#   npx esbuild … packages/devhost/scripts/unreachable-probe.ts --outfile=/tmp/seqcall-unreachable.cjs && node /tmp/seqcall-unreachable.cjs <root> [maxListed]
```
The line argument is **0-based** (the editor's line − 1); "no method at that position" usually means an off-by-one or
a line on an attribute/doc comment. Smart expand (FR-3.6): sample-app `getUser` opens `findUser` only; on a real
app's `main` it opens the main work, not the config plumbing. Good flows to try: a `main` with many collaborators
(star diagram), a use case calling ports (ports → adapters), a hexagonal module (layers), a C# controller action down
to the data layer. Expected: TS first diagram < 1 s; C# first diagram after the solution load, then < 200 ms per
expansion.

## 8a. Quality baseline on real codebases (before a release)

The fixtures are small: a change can make the analysis worse on real code and still pass every test.
`npm run baseline` measures Seqcall on the developer's own repositories (the list in `smoke-tests-repos.md`) and
compares with that developer's earlier run. The numbers stay local (`.baseline/`, not in git), so each developer has
their own baseline. `scripts/baseline.mjs`, measurement `packages/devhost/scripts/baseline-measure.ts`, tests
`scripts/test/baseline.test.ts`.

- **First run** per repository: pins it at its current commit (and keeps its layer config) and measures.
- **Later runs**: measure the **same commit** again, so new commits in the repository change nothing; exit 1 on a
  regression. A list entry that is not a folder is skipped with a note.
- **`--update [label]`**: moves the pin to the repository's current commit and measures it with the **last release**
  (`v*` tag, a git worktree under `.baseline/release/`, its own C# sidecar build), then compares the working tree
  with it: old and new Seqcall on the same code.
- Options: `--only <label>`, `--max <n>` (entry points per repository, default 40).

The repositories are only read: `git archive <commit>` of the listed folder (or a copy without `node_modules`,
`vendor`, `bin`, `obj`, `.git` when it is not in git) into a temporary folder; C# copies get `dotnet restore` there.
Each repository is measured in its own Node process, one after the other.

Measured: the entry points (tests excluded); for the first 40 by key, the opened and the Smart flow (messages,
unknown calls), the findings of the sequence and class diagrams; how the calls of the methods in those flows resolve
(project, library, unknown); PHP also the resolution of every method (as `php-sweep.ts`, so a library without entry
points is measured too); the time.

| Regression (fails) | Note (for a person to judge) |
|---|---|
| an entry point no longer found | new entry points |
| a flow that fails now | a flow that works now |
| resolved share of calls down more than 1 point | smaller changes of that share |
| PHP: more methods whose analysis fails | Smart flow sizes and unknown calls per entry point |
| | new and gone findings: the script cannot tell a true finding from a false one |
| | slower by half and more than 5 s |

TypeScript copies have no `node_modules`, so most library calls show as unknown; both runs see the same copy, so the
comparison holds.

## 9. Robustness and debugging techniques

- **Layout stress** (for "Rendering failed" layout bugs): `layout-stress.ts` opens every function of a TS project,
  expands, chooses implementations, lays out with varied text widths in TB/LR/lanes; the first failing class diagram
  is written as JSON → turn it into a regression test. Layout fallbacks also log the diagram JSON to the output
  channel.
- **Extension does not activate / panel blank**: load the bundle with a stubbed `vscode` to see the real error:
  ```js
  // node check.cjs packages/vscode/dist/extension.js
  const M = require('module'), load = M._load;
  M._load = function (r) { return r === 'vscode' ? new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => ({}), apply: () => ({}) }) }) : load.apply(this, arguments); };
  try { require(process.argv[2]); console.log('loaded ok'); } catch (e) { console.log('LOAD ERROR', e.message); }
  ```
- **What happened in a user's VS Code**: VS Code's logs (Linux: `~/.config/Code/logs/<session>/window*/`;
  `renderer.log` — "Loading development extension", extension host start; `exthost/exthost.log` — activation
  errors, debugger attach problems). Webview errors reach the "Seqcall" output channel (views post `log` messages);
  a panel shows "Rendering failed: …" instead of going blank.
- Which build a running dev host uses: compare `git log` times with `packages/vscode/dist/*` mtimes and the "Loading
  development extension" timestamp.

## 10. Static analysis (SonarQube Cloud) — the release gate

SonarQube Cloud analyses two projects in GitHub Actions (`.github/workflows/sonar.yml`); nothing runs locally:
`<org>_seqcall` (TypeScript / JavaScript / Kotlin of `packages/` and `scripts/`, settings in
`sonar-project.properties`) and `<org>_seqcall-csharp` (the C# sidecar, through the SonarScanner for .NET), with the
TS and C# coverage of §11. The workflow runs on every push to `main` (the dashboard stays current) and before every
release: `release.yml` calls it first and builds nothing when it fails. It is optional: without the secret and
variable below it is skipped with a notice, and releases go ahead ungated. The **release gate** is checked by
`scripts/sonar.mjs gate` after both scans, not by a server quality gate: no open bug, vulnerability or issue of
medium severity or higher in the whole code (not only new code: the first scan after `set-version` would have no new
code). Issues judged false positives or accepted by design are resolved on the server with the reason as a comment,
so they do not count.

**Every commit** runs the `pre-commit` hook (`scripts/hooks/`; install once per clone:
`git config core.hooksPath scripts/hooks`): the comment lines the commit adds in `packages/` and `scripts/` (not tests
or fixtures) must not hold history ("no longer shows", "used to draw"), dates or numbers measured on a run
("large app: 14 s"); a hit stops the commit with `file:line` (`git commit --no-verify` skips it). Whether a comment
only repeats the code is left to review.

**Once per repository** (free while the repository is public):

1. Sign in at https://sonarcloud.io with GitHub, create the organization for the GitHub account and import this
   repository. In the project's *Administration → Analysis Method*, turn **Automatic Analysis off** (it conflicts
   with the CI analysis). Create the second project with the key `<org>_seqcall-csharp` (*+ → Analyze new project →
   Create a project manually*).
2. *My Account → Security*: generate a token. In GitHub, *Settings → Secrets and variables → Actions*: the secret
   `SONAR_TOKEN` (the token) and the variable `SONAR_ORGANIZATION` (the organization key).
3. *Actions → SonarQube Cloud → Run workflow* once, and check that both projects show on the dashboard.

When the gate fails, the job log lists the issues and the dashboard link. Fix the issue — or, for a false positive
or an issue accepted by design, resolve it on the server with the reason (check the claim in the code first, e.g.
measure a "slow regex" on long input).

## 10a. Leak check — before anything goes public

`scripts/leak-check.mjs` looks for what must not get into the repository: words from a list (names of real
repositories, the company, the business domain, names copied from real code), home-folder paths and e-mail
addresses outside placeholder domains (except in the generated `THIRD-PARTY-NOTICES.txt`, which quotes other
projects' copyright lines). The list is **never in git** — it would leak by itself: each developer keeps
it in `.leak-check.json` (git-ignored), CI gets it as the `LEAK_WORDS` secret (one regex per line).

```json
{ "words": ["\\bacme\\b", "AcmeShop"], "allow": ["\\bacme-ui\\b"], "compare": ["~/git/acme/shop"], "libraries": ["~/.nuget/packages"] }
```

- `npm run leak-check` — all tracked files (everything in the repository is public).
- The hooks (installed as in §10): `pre-commit` checks the staged version of
  the files a commit adds or changes (`--staged`), `commit-msg` the commit message (`--message <file>`). Both block;
  `git commit --no-verify` skips them, the Release workflow still checks.
- `node scripts/leak-check.mjs release/*` — inside the packages (`.vsix`, `.zip`, `.tar.gz`); the Release workflow
  runs both and stops on a hit. `allow` drops a library's own use of a word (matched on the text around the hit).
- `--compare` — an audit, not a gate: identifiers of the tracked files that also occur in the `compare`
  repositories (read only) and in no library (`vendor/`, `node_modules/`, `libraries`). It finds the names nobody
  put on the list; judge each, rename the real ones (Order / Invoice / Shop), and add them to the list.

## 11. Coverage

```sh
npm run coverage        # the vitest suites with V8 coverage (4 workers); summary in the terminal
npm run coverage:vscode # the extension-host tests (test:ext) with V8 coverage of the VS Code host; summary per file
npm run coverage:cs     # the C# sidecar's xUnit tests with the coverlet collector; line / branch summary
npm run coverage:kt     # the Rider plugin's JUnit tests with Kover (through build.mjs: Rider's JBR); line summary
```

Reports in `coverage/` (git-ignored):

- `coverage/ts/`: `index.html` per file and line, `lcov.info` for tools. Counted:
  `packages/{protocol,core,webview,stdio-host,cli}/src` and `scripts/`. Not counted: code that runs in a child
  process — the stdio-host / CLI bundles the Vim and CLI tests start, the C# sidecar — and the VS Code host and
  Rider plugin, which vitest does not run.
- `coverage/vscode/`: `index.html` and `lcov.info` of `packages/vscode/src`. The extension host writes V8 coverage
  (`NODE_V8_COVERAGE`; the suite flushes it when mocha ends, `test/suite/index.ts`) and `scripts/coverage-vscode.mjs`
  maps `dist/extension.js` and the test bundles (`dist/test/suite/*.test.js`) back to the sources through their
  source maps: a test that imports a source file directly (`sidebar.test.ts` builds the sidebar's trees from made-up
  lists) runs the copy bundled into it. Core code these tests run is counted in `coverage/ts/`, not here. A floor:
  `THRESHOLDS` in the script; below it the command fails. The host's dialogs
  (notifications, save dialogs, pickers) go through `src/dialogs.ts`, which the tests replace (`api.dialogs`) to
  click a button or pick a file. The test VS Code has its own extensions folder (`.vscode-test/extensions`): an
  install from a test never reaches the developer's own extensions.
- `coverage/csharp/`: `coverage.cobertura.xml` and `coverage.opencover.xml` of the `Seqcall.CSharp` assembly, without
  the code the compiler generates (`obj/`, the `[GeneratedRegex]` source generator) and `Program.cs` (it runs in the
  end-to-end test's child process, like the TS bundles' `main.ts`). A floor: `THRESHOLDS` in `scripts/coverage-cs.mjs`. Shapes the sample solution lacks are tested on small in-memory projects
  (`tests/Seqcall.CSharp.Tests/Snippets.cs`: the files of a snippet, attributes and framework interfaces declared in
  it). For an HTML page use ReportGenerator (`dotnet tool install -g dotnet-reportgenerator-globaltool`, then
  `reportgenerator -reports:coverage/csharp/coverage.cobertura.xml -targetdir:coverage/csharp/html`).
- `coverage/kotlin/`: `html/index.html` and `report.xml` (JaCoCo format) of the plugin code under
  `packages/rider/src/main`. Only the JUnit tests count; the JCEF window and the actions are checked by the smoke run
  (docs/RIDER-PLUGIN.md).

SonarQube Cloud (§10) shows the TS/JS and C# coverage: the workflow runs `npm run coverage` and `npm run coverage:cs`
before the scans (`sonar-project.properties` reads the lcov files, the workflow passes the OpenCover file to the .NET
scanner). Kotlin and VS Code-host coverage stay local.

### Target: 100 % lines and branches, with tests that mean something

The TypeScript product code is held at 100 % lines and branches: `npm run coverage` fails when a package with a
threshold in `vitest.config.ts` drops below it. The dev
scripts (`scripts/`) are reported but have no target. Coverage is the result, not the goal:

- **A test checks behaviour someone cares about**, through the public function or the view, with assertions on the
  result (the diagram, the message posted, the text written). A test that only runs a line, or asserts something
  that holds whatever the code does (`toBeDefined()` on a value that is always there), is not allowed.
- **Every new test must fail when the code it covers is wrong.** Check it before committing: break the branch the
  test is for (flip the condition, drop the `else`, return early), run that test file, see it fail, restore.
- **Reach a branch with real input first**: a source file, a project, a message. Most `?.` / `??` branches on
  parser output (TypeScript, PHP ASTs) are reachable with a small piece of code of the right shape.
- **Dead code is removed**, not tested — when the types or the callers prove the branch cannot run. Such removals
  are production changes: separate commit, the evidence in the message.
- **Ignore only guards against input from outside** (editor messages, files, sidecar replies, parser results that
  the code does not produce), with the reason: `/* v8 ignore next -- <why it cannot happen in a test> */`
  (`v8 ignore start` / `stop` for a block). Never ignore to skip writing a test.
- Not counted (config `exclude`): start-up files of the bundles (`cli/src/main.ts`, `stdio-host/src/main.ts`,
  `webview/src/*-main.ts`); they run in child processes in the end-to-end tests.
- New cases get their own small fixture or an in-memory project (`packages/core/test/fixtures/gateway-repo.ts`);
  adding shapes to `fixtures/sample-app` or `fixtures/php-app` changes counts that other tests assert.

Working on one file: `npx vitest run --coverage --coverage.include=<src file> --coverage.reporter=text <test files>`.
