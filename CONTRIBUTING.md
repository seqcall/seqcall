# Contributing to Seqcall

Bug reports, ideas and pull requests are welcome. For a security problem, see [SECURITY.md](SECURITY.md) instead of
opening an issue.

## Issues

- **Bug**: the editor and its version, your OS, the language, and the Seqcall log (the *Seqcall* output channel in
  VS Code, the `SEQCALL` lines of the IDE log in JetBrains IDEs, `:SeqcallLog` in Vim / Neovim). A small piece of
  code that shows the problem helps most.
- **Do not paste code you may not share.** Rewrite the case with made-up names (`Order`, `Invoice`, `Shop`) and the
  same shape; that is also how it becomes a test fixture.

## Pull requests

Fork the repository, work on a branch, and open the pull request against `main`. For anything larger than a small
fix, open an issue first so we can agree on the approach.

1. Set up the repository: [README.md → Development](README.md#development); tools and commands:
   [AGENTS.md](AGENTS.md).
2. Install the git hooks once: `git config core.hooksPath scripts/hooks` (comment rule and leak check,
   [docs/TESTING.md §10](docs/TESTING.md)).
3. Before you push: `npm run typecheck && npm test && npm run test:ext`, plus
   `cd packages/csharp && dotnet test` when you touched the C# sidecar. CI runs the same on the pull request.

What a change brings along (details: [AGENTS.md → Conventions](AGENTS.md#conventions)):

- **Behaviour** is specified in [docs/FUNCTIONAL-REQUIREMENTS.md](docs/FUNCTIONAL-REQUIREMENTS.md): a new or changed
  behaviour updates its FR row (or adds one), and its tests carry the FR id in their names (`it('FR-5.1 …')`).
- **UI changes** are checked visually with the browser dev host ([docs/TESTING.md §7](docs/TESTING.md)).
- **Docs** (FR row, README usage) go in the same pull request.
- **Protocol changes** (`packages/protocol`) are additive: optional fields, new message variants.
- **A new dependency** that ends up in a package needs a licence the build accepts (`ALLOWED` in
  `scripts/third-party-notices.mjs`); the build stops otherwise.

## Licence

Seqcall is licensed under the [Apache License 2.0](LICENSE). By contributing, you agree that your contribution is
licensed under it too (section 5 of the licence).
