# Installing Seqcall

Seqcall is not on any marketplace yet. Every release on the GitHub **Releases** page has one
package per editor family:

| File | For |
|---|---|
| `seqcall-<version>.vsix` | VS Code 1.90+ and editors built on it (Cursor, Windsurf, VSCodium) |
| `seqcall-rider-<version>.zip` | JetBrains IDEs 2026.2 or newer: Rider, PhpStorm (verified), IntelliJ IDEA / WebStorm (should work, untested) |
| `seqcall-vim-<version>.tar.gz` | Vim 9 (9.0.1485+) and Neovim 0.10+ |
| `seqcall-agent-<version>.zip` | AI coding agents: a Claude Code plugin (MCP server + skill), an MCP server for other clients, the `seqcall` CLI |
| `SHA256SUMS` | Checksums (`sha256sum -c SHA256SUMS --ignore-missing`) |

Download them from the repository's Releases page, or with the GitHub CLI:

```sh
gh release download --repo seqcall/seqcall --pattern '*.vsix'     # latest release; or name a tag: gh release download v0.1.0 …
```

Every package works on any OS (no native code), but so far it has been tested **on Linux only**.
Please report anything odd on macOS or Windows.

## What else you need

| Language / editor | Needs |
|---|---|
| TypeScript / JavaScript | Nothing more in VS Code. A `tsconfig.json` / `jsconfig.json` gives better results. |
| PHP | Nothing more in VS Code: no PHP runtime, no `vendor/`. When `vendor/` is installed, library types and your own Composer packages are used. |
| C# | The .NET 10 runtime, plus an SDK that matches the solution's `global.json`, and restored packages (`dotnet restore`). Seqcall finds `dotnet` on the PATH or in `~/.dotnet`. If the SDK is missing, the diagram says which one to install. |
| JetBrains IDEs, Vim, Neovim, AI agents | **Node.js 20 or newer.** The analysis runs in a small Node process. Seqcall looks for Node on the PATH, in nvm and in the usual install locations. You can also set the path yourself (see the sections below). |
| Branch review | **git** (optional). |

## VS Code (and Cursor, Windsurf, VSCodium)

**From the UI:** open the Extensions view (Ctrl+Shift+X), click **⋯** at the top, choose
**Install from VSIX…**, select `seqcall-<version>.vsix` and reload the window if it asks you to.

**From a terminal:**

```sh
code --install-extension seqcall-0.1.0.vsix          # Cursor: cursor …, Windsurf: windsurf …, VSCodium: codium …
```

**Use:** open a TS/JS, C# or PHP file, put the cursor inside a function or method and press
**Ctrl+Alt+U**, or right-click and choose **Show Sequence Diagram**. Logs are in the Output panel
under **Seqcall**.

**Update:** Seqcall updates itself from the GitHub releases. It checks once a day, installs a newer
version and asks you to reload the window; no sign-in needed. **Seqcall: Check for Updates** checks now. Setting
`seqcall.autoUpdate`: `install` (default), `notify` (ask first) or `off`. You can always install a newer `.vsix` by
hand the same way as above; it replaces the old one.
**Remove:** uninstall it from the Extensions view, or run
`code --uninstall-extension seqcall.seqcall`.

## JetBrains Rider, PhpStorm and other IntelliJ IDEs (2026.2+)

1. **Settings → Plugins → ⚙ → Install Plugin from Disk…**, then pick `seqcall-rider-<version>.zip`
   (keep it zipped).
2. Restart the IDE.
3. Put the caret in a method and press **Ctrl+Alt+Shift+K**, or right-click in the editor and choose
   **Show Sequence Diagram**. The class diagram is under **Tools → Show Class Diagram**.

If Node is not found, a notification tells you. Set the path under **Settings → Tools →
Seqcall**. This happens most often when the IDE was started from the desktop and your Node
comes from nvm. Logs: **Help → Show Log in Files**, lines containing `SEQCALL`.

**Update:** Seqcall updates itself from the GitHub releases: once a day it installs a newer version for the next
restart and offers **Restart**; **Tools → Check for Seqcall Updates** checks now. **Settings → Tools → Seqcall →
Updates**: `install` (default), `notify` (ask first) or `off`. You can always install a newer zip by hand the same way as above. **Remove:** go to Settings → Plugins →
Installed → Seqcall → ⚙ → Uninstall.

## Vim 9

```sh
mkdir -p ~/.vim/pack/seqcall/start
tar -xzf seqcall-vim-0.1.0.tar.gz -C ~/.vim/pack/seqcall/start
```

## Neovim (0.10+)

```sh
mkdir -p ~/.local/share/nvim/site/pack/seqcall/start
tar -xzf seqcall-vim-0.1.0.tar.gz -C ~/.local/share/nvim/site/pack/seqcall/start
```

If you use lazy.nvim, unpack the archive anywhere and point to that folder:

```lua
{ dir = '~/opt/seqcall-vim', config = function() require('seqcall').setup({}) end }
```

`:checkhealth seqcall` checks Node, dotnet and the browser.

**Use (both):** start the editor in the project directory, put the cursor in a method and run
`:SeqcallShow`. The diagram opens in a browser tab, and clicking an element jumps to the code in
the editor. `:SeqcallClass` opens the class diagram, `:SeqcallLog` shows the log, and
`:help seqcall` lists the settings, e.g. `g:seqcall_node` (path to Node) and
`g:seqcall_browser` (browser command). You can add a mapping:
`nmap <Leader>cs <Plug>(seqcall-show)`.

**Update:** run `:SeqcallUpdate`, then restart the editor. It downloads the latest release and puts it in place
of the `seqcall-vim` folder. To update by hand, delete the
`seqcall-vim` folder and unpack the new archive in its place.
**Remove:** delete the folder.

## AI coding agents (Claude Code, other MCP clients, the CLI)

```sh
gh release download --repo seqcall/seqcall --pattern 'seqcall-agent-*.zip'
unzip seqcall-agent-0.1.0.zip -d ~/opt                 # → ~/opt/seqcall-agent
claude plugin install seqcall --marketplace ~/opt/seqcall-agent
```

The agent gets the tools `flow`, `paths`, `review`, `entrypoints`, `outcomes`, `issues`, `unreachable` and `impls` and a skill that says when
to use them. The MCP server starts in the project directory and keeps the project loaded between calls. `node` on
the PATH must be version 20 or newer. To try it for one session without installing:
`claude --plugin-dir ~/opt/seqcall-agent/plugin`.

**Other MCP clients** (Cursor, VS Code, Codex …): command `node`, arguments
`["~/opt/seqcall-agent/plugin/seqcall.cjs", "mcp", "--root", "<project>"]`.

**The CLI**, for any agent or script: `npm install -g ~/opt/seqcall-agent/plugin`, then `seqcall --help`.
For an agent without the plugin, paste the snippet from `seqcall-agent/README.md` into the project's
`AGENTS.md` / `CLAUDE.md`.

**Update:** `node ~/opt/seqcall-agent/plugin/seqcall.cjs update` (or `seqcall update` with the CLI installed),
then restart Claude Code. It puts the latest release in place of the unpacked folder and refreshes Claude Code's copy
of the plugin. By hand: unpack the new zip
in the same place, then `claude plugin marketplace update seqcall && claude plugin update seqcall@seqcall`.
**Remove:** `claude plugin uninstall seqcall`, delete the folder.

## Reporting problems

Please include the editor and its version, your OS, the language, and the Seqcall log:
the *Seqcall* output channel in VS Code, the `SEQCALL` lines in the IDE log for JetBrains, or
`:SeqcallLog` in Vim and Neovim.

---

## For maintainers: making a release

The workflow `.github/workflows/release.yml` runs when you push a tag `v<x.y.z>`: it sets that version on the
packages, runs the tests, builds the packages and creates the GitHub release, marked as the latest release
(`gh release download` without a tag finds only that one).

```sh
git tag v0.1.0 && git push origin v0.1.0
```

- The workflow first runs the SonarQube Cloud analysis (`.github/workflows/sonar.yml`); a failed release gate
  stops the release before anything is built. Setup: docs/TESTING.md §10.
- The release page shows `docs/release-notes/v<x.y.z>.md` when it exists, above the install link and GitHub's
  generated changelog.
- Versions must be plain `x.y.z`, because vsce rejects pre-release suffixes. Committing the version
  bump is optional, since the workflow takes the version from the tag. To keep the repository in
  step, run `npm run set-version 0.1.0`, commit, then tag.
- To try the build without releasing anything, start the workflow by hand from **Actions → Release
  → Run workflow**. The packages appear as the run's artifact `seqcall-packages`.
- To build the same files locally, run `npm run release` (`--no-rider` and `--no-tests` are
  available). The output goes to `release/`. Locally, Rider is compiled against the installed Rider.
  On CI it is compiled against `RIDER_VERSION` from JetBrains' Maven repository.
- Icon: `packages/vscode/media/icon.svg` is the source. The JetBrains copy is
  `packages/rider/src/main/resources/META-INF/pluginIcon.svg` (the same drawing at 40×40). vsce needs a PNG, so after
  changing the drawing, render it again: open an HTML page with `<img src="icon.svg" width=128>` in headless Chrome,
  `--window-size=128,128 --default-background-color=00000000 --screenshot=icon.png`.
- Every package carries `LICENSE` and a `THIRD-PARTY-NOTICES.txt`, generated by its build
  (`scripts/third-party-notices.mjs`) from what the package really bundles: the npm packages esbuild put into the
  bundles and the NuGet packages of the C# sidecar. A bundled package without a licence text, or under a licence not
  on the script's `ALLOWED` list, stops the build; decide on the licence before adding it to the list.
- The `.vsix` and the JetBrains zip include the C# sidecar only if the .NET 10 SDK was available
  during the build. CI always has it.
