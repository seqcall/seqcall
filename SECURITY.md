# Security

Please report a vulnerability privately, not in a public issue: on GitHub, **Security → Report a vulnerability**
in this repository. Once a fix is released, the advisory is published with credit to you unless you prefer
otherwise.

Fixes go into the latest release only.

Worth knowing when you assess an issue: Seqcall analyses code locally; it sends no code and no telemetry anywhere. It starts local
processes (a Node sidecar for JetBrains IDEs and Vim, a .NET sidecar for C#) that talk over stdio; the Vim / Neovim
browser mode serves the diagrams on `127.0.0.1` with a random token in the URL (FR-21); the update check reads the
public GitHub releases API (FR-30).
