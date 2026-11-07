# Vim and Neovim plugin (FR-21)

Seqcall in **Vim 9** and **Neovim** (FR-21.5: a Lua plugin in the same package) with no change to the core, the
webview or the protocol. Neither can render HTML/SVG, so the diagrams open in a **browser tab** served by the same
Node sidecar the Rider plugin uses (`packages/stdio-host`) in *browser mode*.

## Architecture

```
Vim (packages/vim, Vim9 script)                Node sidecar (stdio-host --browser)           Browser tab
 ├─ :SeqcallShow ───────openAt──────────▶     HeadlessController ── DiagramSession          sequence / class page
 ├─ BufWritePost ─────filesChanged────────▶      │                                           (webview bundles unchanged)
 ├─ CursorMoved (150 ms) ─caretMoved──────▶      ├─ post ──── Server-Sent Events ─────────▶  window.postMessage
 ├─ xdg-open URL ◀────openBrowser──────────      │                                           __seqcallHostPost → fetch POST
 └─ :drop + cursor ◀──navigate─────────────      └─ intents ◀── POST /intent/<view> ────────
```

- **Browser mode** (FR-21.1, `packages/stdio-host/src/browser.ts`): an HTTP server on `127.0.0.1` (any free port,
  or `--port`) with a random 128-bit token in every URL. Routes: `GET /<view>` (the page),
  `GET /dist/<bundle>`, `GET /events/<view>` (SSE), `POST /intent/<view>`. The page defines
  `window.__seqcallHostPost` before the bundle runs (the webview's window bridge, as in Rider) and holds back
  outgoing messages until the event stream is open, so the view's `ready` is never answered into the void.
  The last class page closing calls `classViewClosed` (stop deriving class diagrams).
- The editors never print the URL on the message line (a narrow window would cut the token).
- In browser mode `post` is not written to stdout (diagrams can be large); the editor gets
  `openBrowser { view, url, connected? }` instead: after `openAt` when no sequence page is connected, after
  the view's "Class diagram" button (instead of `showClassDiagram`), and on `showView` / `showEntryPoints`.
- **One package, two plugins.** Neovim also sources `plugin/*.vim` but has no Vim9 script (a `vim9script`
  file there is an error at Neovim's start), and `vim9script` must be a file's first command. So
  `plugin/seqcall.vim` is a short legacy script that stops in Neovim and otherwise sources
  `vim9/commands.vim`; Vim ignores `plugin/*.lua`.
- **Vim** (`vim9/commands.vim` commands and autocmds, `autoload/seqcall.vim` logic): `job_start` with a
  newline channel, `json_encode`/`json_decode`. Positions are 0-based lines and UTF-16 columns
  (`utf16idx` / `byteidx(…, true)`, Vim ≥ 9.0.1485). The workspace is Vim's current directory.
- **Neovim** (`plugin/seqcall.lua` commands and autocmds, `lua/seqcall/init.lua` logic, loaded on first
  use; Neovim ≥ 0.10): `vim.fn.jobstart` (stdout arrives in chunks: partial lines are reassembled),
  `vim.json`, the same `utf16idx` / `byteidx` (Neovim has them), `vim.ui.open` as the default browser.
  `:checkhealth seqcall`: `lua/seqcall/health.lua`.
- Node and `dotnet` are found as FR-21.3 says; a `~/.dotnet/dotnet` is passed as `SEQCALL_DOTNET` + `DOTNET_ROOT`
  (as Rider does). The sidecar is
  `node/stdio-host.cjs` in the package or `packages/stdio-host/dist` in the repository. It finds the
  webview in `node/webview` (package) or `packages/webview/dist` (repository), or `--webview <dir>`.

## Sidecar protocol additions (all additive)

| Direction | Message | Meaning |
|---|---|---|
| CLI | `--browser [--port <n>] [--webview <dir>]` | Browser mode. |
| result | `initialize` → `browser: { sequence, class }` | The page URLs (browser mode only). |
| host → sidecar | `showView { view }` | Open a view's page (again). |
| sidecar → host | `openBrowser { view, url, connected? }` | Open this URL in the browser. |

Everything else is the Rider protocol (docs/RIDER-PLUGIN.md).

## Build

```sh
npm run build:vim     # webview + stdio-host bundles, then packages/vim/dist/seqcall-vim-<version>.tar.gz
# from source instead: set rtp^=<repo>/packages/vim  (after `npm run build -w @seqcall/stdio-host -w @seqcall/webview`)
```
The package contains the C# sidecar only if `npm run build` published it (`packages/vscode/dist/csharp`). Install and
use: docs/INSTALL.md, `:help seqcall`. `:SeqcallUpdate` (FR-30.6): the sidecar does the work
(`stdio-host.cjs --update <dir>`, `packages/stdio-host/src/update.ts`, release check shared with VS Code in
`packages/core/src/update.ts`); both plugins only start it and show its lines. `SEQCALL_UPDATE_API` points it at a fake
GitHub (tests).

## Tests

- `packages/stdio-host/test/browser.test.ts` (FR-21.1): token, page, SSE push, POST intents, `openBrowser`
  once, `navigate`, class page, `showView`, port closed on shutdown.
- `packages/vim/test/` (real headless Vim 9 and Neovim): docs/TESTING.md §5b.
- Visual: start the sidecar with `--browser`, send `initialize` + `openAt`, screenshot the `openBrowser`
  URL with `packages/devhost/scripts/screenshot.mjs`.

## Limitations

- The browser window is separate from the terminal; a click cannot raise the terminal window (OS focus).
- Diagrams use the files on disk: unsaved buffer changes appear after `:w`.
- Theme: the stylesheet's own light/dark (follows the system's `prefers-color-scheme`), not Vim's colours.
- State in memory only (as Rider); "Move to layer" writes `.seqcall.json` without Undo.
