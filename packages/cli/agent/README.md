# Seqcall for AI agents

Static call-flow analysis of TypeScript/JavaScript, C# and PHP projects, for coding agents and scripts: who reaches
a method (up to the routes, jobs and tests), what a request runs (DB / HTTP / queue calls, loops, background work),
the code behind a route, implementations of an interface and what DI injects, design issues, branch reviews.

Needs **Node 20+**; C# projects also the **.NET 10 runtime** (or SDK).

## Claude Code: plugin (MCP server + skill)

```sh
claude plugin install seqcall --marketplace ./seqcall-agent      # the unpacked folder of this zip
```

Or inside a session: `/plugin marketplace add ./seqcall-agent`, then `/plugin install seqcall@seqcall`.
The agent gets the tools `flow`, `paths`, `review`, `entrypoints`, `outcomes`, `issues`, `unreachable`, `impls` and a skill saying when to use
them. The project stays loaded between calls. To try it for one session without installing:
`claude --plugin-dir ./seqcall-agent/plugin`.

## Other MCP clients (Cursor, VS Code, Codex, …)

Command `node`, arguments `["<path>/seqcall-agent/plugin/seqcall.cjs", "mcp", "--root", "<project>"]`.

## The CLI (any agent, scripts)

```sh
npm install -g ./seqcall-agent/plugin       # or run: node <path>/seqcall-agent/plugin/seqcall.cjs …
seqcall --help
seqcall paths src/services/order-service.ts:42     # who reaches it, up to the routes / jobs / tests
seqcall flow  app/Http/Controllers/OrderController.php:30   # what it runs: DB / HTTP / queues, loops
```

**Update:** `seqcall update` (or `node <path>/seqcall-agent/plugin/seqcall.cjs update`) puts the latest release in
place of the unpacked `seqcall-agent` folder and refreshes Claude Code's copy of the plugin; restart Claude Code
afterwards.

For agents without the plugin, add this to the project's `AGENTS.md` / `CLAUDE.md`:

```markdown
## Call-flow analysis (seqcall)
For "what is affected if I change X / who calls X" run `seqcall paths <file>:<line>` (`--tests` lists the tests);
for "what does this request / method run (DB, HTTP, queues, loops)" `seqcall flow <file>:<line>`; to find the code
behind a route or job `seqcall entrypoints <words>`; what each route or job touches (DB, other APIs, files, queues) `seqcall outcomes`; implementations and DI `seqcall impls <file>:<line>`;
project-wide design issues `seqcall issues`; dead-code candidates `seqcall unreachable`; the current branch `seqcall review`. Lines are 1-based, any line
of the method. Trust its caller trees, entry points, implementations and I/O; check by hand only `# INCOMPLETE`
lines, `unresolved` calls and code reached by reflection or strings. Each run loads the project (C#: 10–30 s):
run one at a time.
```
