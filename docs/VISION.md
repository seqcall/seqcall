# Seqcall: Vision

## Problem

Developers spend most of their time *reading* code, not writing it. Understanding the
**dynamic behaviour** of an unfamiliar codebase — "what actually happens when this
endpoint is hit?" — means jumping through dozens of files, holding a mental call stack,
and repeatedly losing context. Existing tools either:

- produce **static** structure (class diagrams, dependency graphs) that say little about
  behaviour, or
- dump **everything** (call graphs, full traces) so the important interactions drown in
  noise (logging, collection helpers, framework plumbing), or
- produce diagrams that are **disconnected from the code**: a picture you look at, not a
  tool you navigate with.

## Vision

> An interactive, clutter-free sequence diagram that lives next to the code editor and
> lets a developer explore *how objects collaborate*, at exactly the level of detail they
> need, with every element one click away from the code it represents.

The diagram is a **navigation instrument**, not documentation. It is generated from the
source on demand, stays in sync with it, and is shaped by the developer: expand what
matters, collapse or hide what does not, swap an interface for the implementation of
interest, walk up to the callers. A UML class diagram of *just the classes involved in
the visible interaction* is derived live as a structural companion view.

## Target users

- Developers onboarding onto an existing codebase.
- Developers debugging or changing a feature that spans several layers.
- Reviewers and architects checking that interactions respect layering (controller →
  service → port → adapter).

## Guiding principles

1. **Clutter-free by default.** The first diagram shown is small (one level deep).
   Library/runtime calls are hidden, participants are unnamed unless disambiguation is
   needed, arguments are abbreviated. Detail is opt-in.
2. **Progressive disclosure.** Every level of detail can be added (expand, choose an
   implementation, show arguments) and removed (collapse, hide, back to interface) with
   a single gesture.
3. **Focus on the important interactions.** Stereotypes (controller, service, port,
   seam, singleton, static, …) and layer/namespace grouping make the *architectural role*
   of each object visible at a glance.
4. **Code is the source of truth.** Clicking any message highlights the call in the
   editor. Selecting code in the editor draws its diagram. Saving a file refreshes the
   diagram while preserving the developer's exploration state.
5. **The developer's curation is remembered.** Hidden methods, layout and choices persist
   per workspace and can always be undone.
6. **Portable core.** Language analysis and the diagram model are independent of the
   editor, so the same engine and UI run in VS Code, JetBrains IDEs and Vim / Neovim, and
   each language is one adapter (TS/JS, C#, PHP).

## Non-goals

- Round-trip editing (changing code by editing the diagram).
- Full UML 2.x notation compliance; we use the subset that aids understanding.
- Runtime tracing / instrumentation. Diagrams come from static analysis; where static
  analysis cannot decide (polymorphism), the developer decides.
- Documentation export pipelines (SVG/PNG export is a convenience, not a goal).

## Success criteria

- Analyses a real TypeScript/JavaScript, C# or PHP project inside the editor.
- From a cursor position inside a method, renders that method's sequence diagram in
  under ~1 s after initial project load.
- A developer can explore a request flow across ≥ 4 layers (e.g. controller → service →
  repository port → adapter) using only expand/collapse, implementation selection,
  and "show callers", without leaving the diagram except to read code.
- The live class diagram reflects exactly the classes visible in the sequence diagram.
