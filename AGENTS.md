# Seqcall — notes for coding agents and contributors

Editor plugins for **VS Code, JetBrains IDEs (Rider, PhpStorm) and Vim/Neovim** (diagrams in a browser tab) that
draw **interactive UML sequence diagrams** from code plus a **live class diagram** of the classes in the visible
interaction. Languages: **TypeScript/JavaScript** (in-process), **C#** (Roslyn sidecar) and **PHP** (in-process,
`packages/core/src/php/`). Goal: docs/VISION.md.

**Name: Seqcall.** Ids: setting/command ids `seqcall.*`, config file `.seqcall.json`, packages `@seqcall/*`,
VS Code extension id `seqcall.seqcall`, Rider plugin id `dev.seqcall`, root package name `seqcall`, env vars
`SEQCALL_*`, the C# sidecar `Seqcall.CSharp`, the Kotlin package `dev.seqcall.rider`.

**Everything in git is public.** Working notes with measurements on real code (`private/STATUS.md`,
`private/IDEAS-BACKLOG.md`) and personal agent notes are local and git-ignored, when a developer has them.

Read first in a new session: **private/STATUS.md** if you have it (what exists, decisions, backlog),
**docs/TESTING.md** (suites, visual checks, smoke tests, debugging), then docs/FUNCTIONAL-REQUIREMENTS.md (FR ids),
docs/ARCHITECTURE.md (packages, design decisions), docs/CSHARP-SIDECAR.md (C# protocol), docs/RIDER-PLUGIN.md
(Rider host, stdio protocol), docs/VIM-PLUGIN.md (Vim host, browser mode), docs/INSTALL.md (end-user install,
releases), README.md (usage).

## Toolchain

Node 22 (`.nvmrc`); the .NET 10 SDK for the C# sidecar (without it, TS/JS and PHP only); Rider 2026.2+ for the
Rider plugin (Gradle runs on Rider's bundled Java). Suites that need VS Code, Chrome, Vim or Neovim skip without them
(docs/TESTING.md §1).

## Repository layout (npm workspaces)

`packages/protocol` (types only: **the contract**), `packages/core` (editor-agnostic engine, language adapters,
`DiagramSession`), `packages/webview` (UI: sequence and class views), `packages/vscode`, `packages/rider`,
`packages/vim` (editor hosts), `packages/stdio-host` (core as a Node sidecar for Rider and Vim), `packages/csharp`
(Roslyn sidecar), `packages/cli` (CLI and MCP server for agents), `packages/devhost` (browser host for visual
checks), `fixtures/*` (TS, C#, PHP and I/O sample apps used by the tests). What each holds:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#packages-npm-workspaces).

Architecture rule: only `packages/vscode` knows VS Code, only `packages/rider` knows the IntelliJ SDK; core and
webview talk only through `packages/protocol` messages.

## Commands

```sh
npm install                     # once
npm run build                   # extension + webview + C# sidecar publish (dist/csharp)
npm test                        # vitest: protocol/core/webview (+ C# end-to-end if sidecar built)
npm run typecheck
npm run coverage                # also coverage:cs, coverage:vscode, coverage:kt (docs/TESTING.md §11)
npm run test:ext                # VS Code extension-host tests
npm run baseline                # quality on your own repos (docs/TESTING.md §8a)
cd packages/csharp && dotnet build -c Release src/Seqcall.CSharp/Seqcall.CSharp.csproj && dotnet test
npm run dev:host -- <project>   # open an Extension Development Host (no debugger) on a project
npm run package -w @seqcall/vscode # .vsix
npm run build:vim               # Vim/Neovim plugin tar.gz; test: npx vitest run packages/vim
npm run build:rider             # Rider plugin zip, runs its tests; only the tests: node packages/rider/build.mjs test
packages/rider/scripts/smoke.sh <project> <file> <line>   # sandboxed Rider smoke run (docs/RIDER-PLUGIN.md)
npm run release                 # all packages + SHA256SUMS into release/ (docs/INSTALL.md)
npm run set-version 0.1.0       # one version on vscode / vim / stdio-host / rider
npm run leak-check              # nothing of the real repos in the tracked files (docs/TESTING.md §10a)
```

Rider smoke runs: never kill the user's own Rider / `cef_server` (`smoke.sh stop` stops only the sandbox), and keep
the sandbox folder `.intellijPlatform/sandbox/seqcall-rider/` (a fresh one has no licence). Details, `RIDER_PATH`,
the short `TMPDIR`: docs/RIDER-PLUGIN.md.

Dev host (browser, for screenshots; recipes in docs/TESTING.md §7; URL forms and replay actions in the header of
`packages/devhost/src/server.ts`):
```sh
node packages/devhost/build.mjs && node packages/devhost/dist/server.cjs <projectRoot> 4711 &
```
Kill dev hosts with `ps -eo pid,comm,args | awk '$2=="node" && /devhost\/dist\/server/ {print $1}' | xargs -r kill`
(not `pkill -f <pattern>`: the pattern matches the shell running it and kills it).

## Conventions

- **Tests reference FR ids** in their names (`it('FR-5.1 …')`). Every feature gets tests; patterns (jsdom, the
  extension-host test API, class-view engines): docs/TESTING.md.
- **Verify visually** after UI changes (docs/TESTING.md §7). Layouts measure text through an injectable
  `measureText` (jsdom has none).
- **Commits**: one per finished feature/milestone (not tiny, not huge); the message body explains why (an agent adds
  its co-author trailer). Docs (FUNCTIONAL-REQUIREMENTS with a new FR row, README usage) go in the same commit.
- **Comments say why**, or what the code cannot show: a design decision, a contract (meaning of a field, edge cases),
  a quirk of an outside library or language, the FR id. They do not repeat the code and hold no history ("no
  longer", "used to", "was"), no dates and no measured numbers (timings, counts from a smoke run) — those go in the
  commit message or private/STATUS.md.
- Protocol changes are **additive** (optional fields/new message variants).
- Stable keys: `<relPath>#<Class>.<method>` (TS), `<relPath>#<Type>.<Method>(<paramTypes>)` /
  `..ctor` (C#), `lib:<pkg>#…` for libraries, `unknown`. Message ids are call paths
  (`root/2:findUser/0:findById`) so state survives refreshes.
- Webview CSP: no inline scripts/eval; style attributes via JS are fine.
- Scripts for real projects (probes, sweeps, layout stress) are in `packages/devhost/scripts/`; usage in each file's
  header and docs/TESTING.md §8–9.
- Parallel agents: disjoint directories each, no concurrent `npm install`, freeze contracts first.

## Smoke tests on real codebases

The real repositories for smoke tests are listed in **`smoke-tests-repos.md`** (repo root, not in git: each
developer has their own). Read it before a smoke test. If it is missing, ask the user which repositories to use (or
where they keep them, then suggest some per language: TS, C#, PHP) and save the answer there: path, language, what it
is good for, entry-point examples, quirks. How to run them: docs/TESTING.md §8.

- Those repositories are **READ ONLY** — never modify, build or restore them. Test on a **copy** in a
  temporary folder (docs/TESTING.md §8); loading a C# solution with MSBuildWorkspace may write `obj/`.
- **Nothing from those repositories goes into this repository** — not in docs, requirements, release notes, code
  comments, tests, fixtures or commit messages, even when the user asks to use a specific repo as an example. No
  repo, project, company or vendor names, no class / method / file / route names copied from them. Findings and
  measurements go, with neutral labels ("large Laravel app", "C# reference solution"), into private/STATUS.md, never
  into git. Requirements (docs/FUNCTIONAL-REQUIREMENTS.md) state the general rule, with no instance or measurement;
  when a concrete case is needed, add made-up code of the same shape (Order / Invoice / Shop names) in
  `docs/req-examples/FR-<id>.md` and link it from the row. Test fixtures copy the shape of the case, never the real
  code. Names of real repos and their files belong only in `smoke-tests-repos.md` and in the chat.
  `npm run leak-check` (and `--compare` against the real repos) finds what slipped through, the hooks stop it at the
  commit; add new real names to your `.leak-check.json`.
- Library calls show as unresolved in a copy without restored packages — an artifact of the copy, not of the
  analysis. Run `dotnet restore <sln>` **in the copy** (works from the local NuGet cache) to check library-based
  features (I/O badges FR-17).
