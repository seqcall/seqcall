---
name: seqcall
description: Static call-flow analysis of TypeScript/JavaScript, C# and PHP projects. Use it for impact questions ("what breaks / which endpoints and tests are affected if I change X", "who calls X"), for what a request or method really runs (DB / HTTP / queue calls, loops, background work, through DI and interfaces), to find the code behind a route, job or command, for implementations of an interface and what the DI container injects, for the design issues of a project, for dead-code candidates (methods no entry point reaches), and to review what a branch changed.
---

# Seqcall

Seqcall follows calls the way a reader of the code would, but through DI registrations, interfaces, callbacks
and framework routing, and it knows where requests and jobs start. One call replaces many grep / read steps.

Use the seqcall MCP tools when they are available (`flow`, `paths`, `entrypoints`, `outcomes`, `impls`, `issues`, `unreachable`, `review`), otherwise the CLI:
`seqcall <command> …` (or `node <path>/seqcall.cjs <command> …`; Node 20+). Run the CLI from the project
directory; C# projects need the .NET 10 runtime.

## Which command for which question

| Question | Command |
|---|---|
| What is affected if I change this method? Who calls it, up to which routes / jobs / commands? | `paths <file>:<line>` (`--tests`: the tests by class, which of them mock the way down, tests calling the routes over HTTP) |
| What does this endpoint / method do: DB, HTTP, queue, file calls, in loops, run later? | `flow <file>:<line>` (`--tree`: every call with layers, frames, file:line) |
| Which code handles `POST /orders`? Which jobs / commands / listeners exist? | `entrypoints <words…>` |
| Which routes / jobs write to the DB, call other APIs, touch files or queues — and through which classes? | `outcomes [<words…>]` (`--detail`: the library calls with file:line) |
| Who implements this interface method? Which class does DI inject? | `impls <file>:<line>` (a line of the interface or base method) |
| What design problems does the project have (N+1, layer violations, cycles)? | `issues` |
| Which methods are dead code (no entry point reaches them)? | `unreachable` (candidates: check the "maybe called" and "framework" groups by hand) |
| What did my branch change, and which entry points and tests reach the changes? | `review [--base <branch>]` |

`<file>:<line>` is 1-based, any line inside the method (or of its declaration). The method keys in JSON output
(`--format json`, MCP `format: "json"`) are targets too, e.g. the key of an `entrypoints` row for `flow`.

## How far to trust it

- **Trust**: caller trees, entry points, implementations, DI choices, I/O kinds and their lines, loops. They come
  from the compiler's symbols (C#: Roslyn; TS: the TypeScript checker; PHP: declarations and types). Don't
  re-derive them with grep.
- **Check by hand**:
  - lines starting with `# INCOMPLETE` (a limit cut the result);
  - calls marked `unresolved` or `lib`;
  - code reached by reflection, string-based dispatch, or dynamic `require`;
  - whether a test really gets past its early returns to the method (`paths --tests` lists the tests that *can* reach it);
  - `possible` issues (the I/O is further down, behind calls that may be cached).
- Use grep for what seqcall does not do: text in config, SQL strings, comments, and "find every mention" lists
  (all call sites of a signature you are about to change, including mocks).

## Cost

The first call loads the project: a few seconds for TS / PHP, 10–30 s for a C# solution. The MCP server keeps it
loaded, so later calls take seconds and see files changed on disk. Each CLI run loads it again, so run at most one at a time.
`issues` and `outcomes` walk every entry point's flow (one walk serves both), `unreachable` the whole call graph: slow on a large project the first time.
