import * as fs from 'node:fs';
import * as path from 'node:path';
import { appMapEntryKey, bindingLookup, createAdapter, createClassifier, DEFAULT_OPTIONS, DiagramSession, entryLabel, flowResult, httpRoutes, httpTestCalls, lineOf, methodLabel, mocksUsedBy, nameOfKey, rel, TestFileMatcher, testSources, toIssue, where, type ContainerBinding, type FlowResult, type Issue, type LanguageAdapter } from '@seqcall/core';
import type { CallPathNode, EntryPoint, EntryPointKind, MethodRef, SequenceDiagram, SideEffectKind, StructureRowKind, UnreachableReason } from '@seqcall/protocol';
import { locateProject, locateWorkspace, type ProjectLanguage } from '@seqcall/stdio-host';

/**
 * FR-27 the agent interface: one command in, a plain JSON result out (the text form is rendered from it,
 * format.ts). No layout, no view state — what an agent needs to act: names, file:line, layers, I/O,
 * issues, and what was *not* looked at (`complete`, `limits`).
 */

export const SCHEMA = 'seqcall/v1';

export interface Project {
  root: string;
  language: ProjectLanguage;
  adapter: LanguageAdapter;
  session: DiagramSession;
}

export interface OpenOptions {
  /** Project directory; default: the target file's project, else the current directory's. */
  root?: string;
  csharpSidecar?: string;
  log?(line: string): void;
}

/** The project a command works on: `root`, else the target file's project, else the current directory's. */
export function locate(opts: { root?: string; file?: string; cwd: string }): { root: string; language: ProjectLanguage } {
  return opts.root ? locateWorkspace(path.resolve(opts.cwd, opts.root)) : opts.file ? locateProject(opts.file) : locateWorkspace(opts.cwd);
}

export function openProject(opts: OpenOptions & { file?: string; cwd: string }): Project {
  const loc = locate(opts);
  const make = () => createAdapter(loc.language, loc.root, { csharp: { sidecarPath: opts.csharpSidecar, log: (l) => opts.log?.(`[C#] ${l}`) } });
  const adapter = make();
  // FR-3.12 an agent reads the whole flow: the error branches drawn (↯ Fold errors is the panels' default)
  const session = new DiagramSession({ adapter, classifier: createClassifier(loc.root), createBaseAdapter: make, initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
  return { ...loc, adapter, session };
}

/** A method: `file:line` (1-based, any line in its body or its declaration) or a stable key (`src/x.ts#Class.method`). */
export type Target = { file: string; line: number } | { methodKey: string };

export function parseTarget(text: string, cwd: string): Target {
  if (text.includes('#')) return { methodKey: text };
  const m = /^(.*):(\d+)$/.exec(text);
  if (!m) throw new UsageError(`not a method: "${text}" (use <file>:<line> or a method key such as src/x.ts#Class.method)`);
  return { file: path.resolve(cwd, m[1]).replace(/\\/g, '/'), line: Number(m[2]) };
}

export class UsageError extends Error {}

async function openTarget(p: Project, target: Target): Promise<SequenceDiagram> {
  if ('methodKey' in target) {
    const d = await p.session.openMethodByKey(target.methodKey);
    if (!d) throw new UsageError(`no method with key ${target.methodKey}`);
    return d;
  }
  if (!fs.existsSync(target.file)) throw new UsageError(`no such file: ${target.file}`);
  const text = fs.readFileSync(target.file, 'utf8').split('\n')[target.line - 1];
  if (text === undefined) throw new UsageError(`${target.file} has no line ${target.line}`);
  const d = await p.session.openAt(target.file, { line: target.line - 1, character: Math.max(0, text.search(/\S/)) });
  if (!d) throw new UsageError(`no method at ${target.file}:${target.line} (give a line inside a method, function or constructor)`);
  return d;
}

// ───────────────────────────── shared shapes ─────────────────────────────

export interface Envelope<R> {
  schema: typeof SCHEMA;
  command: string;
  project: { root: string; language: ProjectLanguage };
  /** False when a limit cut the result: more may exist than is listed (see `limits`). */
  complete: boolean;
  limits: string[];
  elapsedMs: number;
  result: R;
}

// ───────────────────────────── flow ─────────────────────────────

// FR-25.4 the flow's data and text live in core: the panels copy the same text (Share → Copy as text)
export { flowResult, stableIssueId, toIssue, type FlowCall, type FlowIo, type FlowResult, type Issue } from '@seqcall/core';

export interface FlowOptions {
  /** Levels to open below the method; undefined = everything (up to the expand limit). */
  depth?: number;
  /** Keep the call tree in the result (FR-27.6: left out by default, the I/O list and issues are the answer). */
  tree?: boolean;
}

export async function runFlow(p: Project, target: Target, opts: FlowOptions = {}): Promise<{ result: FlowResult; limits: string[] }> {
  let d = await openTarget(p, target);
  if (opts.depth === undefined) d = (await p.session.expandEverything()) ?? d;
  else for (let i = 1; i < opts.depth; i++) d = (await p.session.expandAll()) ?? d;
  d = (await p.session.scanSideEffects()) ?? d;
  const limits: string[] = [];
  const n = d.expandNotice;
  if (n) limits.push(`expand limit (${n.reason === 'messages' ? `${n.limit} calls` : `depth ${n.limit}`}): ${n.folded} calls left folded`);
  const result = flowResult(p.root, d);
  const folded = result.calls!.filter((c) => c.folded).length;
  if (opts.depth !== undefined && folded) limits.push(`--depth ${opts.depth}: ${folded} calls folded`);
  if (!opts.tree) delete result.calls;
  return { result, limits };
}

// ───────────────────────────── paths to here ─────────────────────────────

export interface PathNode {
  method: string;
  key: string;
  /** The call in this method towards the method below it in the tree (absent on the target). */
  call?: { at?: string; code: string; passed?: boolean; count?: number };
  entryPoints?: string[];
  /** Why the walk stops: an entry point, nothing in the project calls it (`top`: framework, public API or dead), a limit (a test method's `test` end is left out: tests are only counted). */
  end?: 'entry' | 'top' | 'limit';
  /** Callers of this method in test files (counted, not listed in the tree). */
  tests?: number;
  callers?: PathNode[];
}

export interface PathsResult {
  target: PathNode;
  /** Entry points reached, by kind (`http: ["GET /users/:id"]`). */
  reachedFrom: Record<string, string[]>;
  /** Test methods that reach the target (distinct). */
  tests: number;
  /** With --tests: those test methods once each, by class; `mocks`: types on their way to the target the file mocks. */
  testList?: { class: string; file?: string; methods: string[]; mocks?: string[] }[];
  /**
   * Tests among them whose file (or a test helper it uses) mocks a type on the way to the target (FR-22.5): they reach
   * its interface, not its code.
   */
  testsMocking?: number;
  /** FR-22.5 test code that calls the reached routes over HTTP (web / BDD tests the walk cannot see), found by text. */
  httpTests?: { route: string; at: string; in?: string; by: 'url' | 'name' }[];
  methodsSearched: number;
}

export function pathsResult(root: string, tree: CallPathNode, methods: number, opts: { tests?: boolean } = {}): PathsResult {
  const reached: Record<string, Set<string>> = {};
  const tests = new Map<string, CallPathNode>();
  const visit = (n: CallPathNode) => {
    for (const e of n.entryPoints ?? []) {
      if (e.kind === 'test') tests.set(n.method.key, n);
      else (reached[e.kind] ??= new Set()).add(e.label);
    }
    for (const c of n.callers ?? []) visit(c);
  };
  visit(tree);
  // the tree leaves test code out (a count on the method its tests call); --tests lists the tests once, by class
  const walk = (n: CallPathNode): PathNode => {
    const callers = (n.callers ?? []).filter((c) => !c.inTest);
    const testCount = (n.callers ?? []).length - callers.length;
    const eps = (n.entryPoints ?? []).filter((e) => e.kind !== 'test').map(entryLabel);
    return {
      method: methodLabel(n.method),
      key: n.method.key,
      ...(n.call ? { call: { at: lineOf(root, n.call.range), code: n.call.preview, ...(n.call.passed ? { passed: true } : {}), ...(n.call.count && n.call.count > 1 ? { count: n.call.count } : {}) } } : {}),
      ...(eps.length ? { entryPoints: eps } : {}),
      ...(n.end && n.end !== 'test' ? { end: n.end } : {}),
      ...(testCount ? { tests: testCount } : {}),
      ...(callers.length ? { callers: callers.map(walk) } : {}),
    };
  };
  const byClass = new Map<string, { class: string; file?: string; methods: string[] }>();
  for (const n of tests.values()) {
    const key = n.method.owner.key;
    const entry = byClass.get(key) ?? { class: n.method.owner.name, ...(n.method.declaration ? { file: rel(root, n.method.declaration.file) } : {}), methods: [] };
    entry.methods.push(n.method.name);
    byClass.set(key, entry);
  }
  return {
    target: walk(tree),
    reachedFrom: Object.fromEntries(Object.entries(reached).map(([k, v]) => [k, [...v]])),
    tests: tests.size,
    ...(opts.tests ? { testList: [...byClass.values()].sort((a, b) => a.class.localeCompare(b.class)) } : {}),
    methodsSearched: methods,
  };
}

export async function runPaths(p: Project, target: Target, opts: { tests?: boolean } = {}): Promise<{ result: PathsResult; limits: string[] }> {
  await openTarget(p, target);
  const r = await p.session.findPathsToHere('root');
  if (!r) throw new UsageError('the target is no project method');
  const result = pathsResult(p.root, r.tree, r.methods, opts);
  await addTestEvidence(p, r.tree, result);
  return { result, limits: r.truncated ? ['walk limits (depth 12, 400 methods, 300 paths): some paths cut (end: "limit")'] : [] };
}

/** FR-22.5 what the walk cannot see about the tests: HTTP tests of the reached routes, tests that mock the way down. */
async function addTestEvidence(p: Project, tree: CallPathNode, result: PathsResult): Promise<void> {
  const tests = new TestFileMatcher(p.root);
  const sources = testSources(p.root, p.language, (rel) => tests.isTest(rel));
  if (!sources.length) return;
  const byRel = new Map(sources.map((s) => [s.rel, s]));
  // the reached HTTP routes, and per test method the classes on its way down to the target (with their interfaces)
  const entryPoints: EntryPoint[] = [];
  const ways = new Map<string, { node: CallPathNode; owners: Set<string> }>();
  const visit = (n: CallPathNode, below: string[]) => {
    entryPoints.push(...(n.entryPoints ?? []));
    if (n.entryPoints?.some((e) => e.kind === 'test')) {
      const w = ways.get(n.method.key) ?? { node: n, owners: new Set<string>() };
      for (const o of below) w.owners.add(o);
      ways.set(n.method.key, w);
    }
    for (const c of n.callers ?? []) visit(c, [...below, n.method.owner.key]);
  };
  visit(tree, []);
  const interfaces = new Map<string, string[]>();
  const namesOf = async (ownerKey: string): Promise<string[]> => {
    if (!interfaces.has(ownerKey)) {
      const info = await p.adapter.getClassInfo(ownerKey).catch(() => undefined);
      interfaces.set(ownerKey, [nameOfKey(ownerKey).split('<')[0], ...(info?.implements ?? []).map((i) => i.name.split('<')[0]), ...(info?.extends ? [info.extends.name] : [])]);
    }
    return interfaces.get(ownerKey)!;
  };
  const mocksByFile = new Map<string, Set<string>>();
  let mocking = 0;
  for (const { node, owners } of ways.values()) {
    const file = node.method.declaration ? rel(p.root, node.method.declaration.file) : undefined;
    const src = file ? byRel.get(file) : undefined;
    if (!file || !src) continue;
    const names = [...new Set((await Promise.all([...owners].map(namesOf))).flat())];
    const mocks = mocksUsedBy(src, sources, names);
    if (!mocks.length) continue;
    mocking++;
    const set = mocksByFile.get(file) ?? new Set<string>();
    for (const m of mocks) set.add(m);
    mocksByFile.set(file, set);
  }
  if (mocking) result.testsMocking = mocking;
  for (const t of result.testList ?? []) {
    const m = t.file ? mocksByFile.get(t.file) : undefined;
    // a file is in mocksByFile only with a mock found
    if (m) t.mocks = [...m].sort((a, b) => a.localeCompare(b));
  }
  // one call per route, file and line: httpRoutes keys the routes by label, testSources lists each file once and
  // httpTestCalls gives each route at most once per line of that file's text (so the line is there)
  const calls = httpTestCalls(sources, httpRoutes(entryPoints));
  const http: NonNullable<PathsResult['httpTests']> = [];
  for (const c of calls) {
    const abs = `${p.root}/${c.file}`;
    const line = byRel.get(c.file)!.src.split('\n')[c.line - 1];
    const enclosing = await p.adapter.findEnclosingCallable(abs, { line: c.line - 1, character: Math.max(0, line.search(/\S/)) }).catch(() => undefined);
    http.push({ route: c.route, at: `${c.file}:${c.line}`, ...(enclosing ? { in: methodLabel(enclosing) } : {}), by: c.by });
  }
  if (http.length) result.httpTests = http;
}

// ───────────────────────────── review ─────────────────────────────

export interface ReviewOutput {
  base: string;
  compared: string;
  branch?: string;
  files: { path: string; status: string; added: number; removed: number; test?: boolean }[];
  methods: { method: string; key: string; status: 'added' | 'changed'; lines: string; reachedFrom: string[]; tests: number; truncated?: boolean; notWalked?: boolean }[];
  /** Issues in the flows the branch changes; `where: changed-lines` = on a line the branch wrote. */
  issues: (Issue & { where: 'changed-lines' | 'changed-class'; flow?: string })[];
  /**
   * FR-29 the structural delta over every entry point's flow, compared with the base version: dependencies between
   * layers (or packages inside one layer) added / removed with the class pairs behind them, layer violations added /
   * removed, entry points added / removed, I/O kinds a layer started / stopped doing, cycles between layers / packages
   * added / removed, new / removed I/O clients in a layer, classes that changed layer or role. Empty rows = the shape did not change. Absent when the base version could
   * not be analysed.
   */
  structure?: {
    rows: { kind: StructureRowKind; title: string; detail?: string; level?: 'layer' | 'package'; pairs?: string[]; flow?: string }[];
    /** Entry points analysed on the base version / taken as unchanged / left out by the limit. */
    compared: number;
    copied: number;
    notCompared: number;
  };
}

const ranges = (lines: number[]) => {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j + 1;
  }
  return out.join(',');
};

export async function runReview(p: Project, opts: { base?: string; direct?: boolean } = {}): Promise<{ result: ReviewOutput; limits: string[] }> {
  // the usual target of a pull request (develop, else main / master), as the review picker proposes it
  const base = opts.base ?? (await p.session.gitRefs().catch(() => undefined))?.target;
  const r = await p.session.reviewChanges({ ...(base ? { base } : {}), force: true, mode: opts.direct ? 'direct' : 'split' });
  if (!r) throw new Error('review cancelled');
  const limits: string[] = [];
  if (r.notScanned) limits.push(`${r.notScanned} entry-point flows not scanned for issues (limit)`);
  const cut = r.methods.filter((m) => m.truncated).length;
  if (cut) limits.push(`${cut} changed methods: walk up the callers cut by its limits`);
  const notWalked = r.methods.filter((m) => m.notWalked).length;
  if (notWalked) limits.push(`${notWalked} changed methods not walked up to the entry points (limit): who reaches them is unknown`);
  const result: ReviewOutput = {
    base: r.base,
    compared: r.compare ? `${r.compare.mode === 'split' ? 'since the branch split off' : 'tip against tip of'} ${r.base} (${r.compare.point}, ${r.compare.commits} commits${r.compare.behind ? `, ${r.compare.behind} behind` : ''})` : r.resolvedBase,
    ...(r.branch ? { branch: r.branch } : {}),
    files: r.files.map((f) => ({ path: f.file, status: f.status, added: f.added, removed: f.removed, ...(f.test ? { test: true } : {}) })),
    methods: r.methods.map((m) => ({
      method: methodLabel(m.method),
      key: m.method.key,
      status: m.status,
      lines: m.method.declaration ? `${rel(p.root, m.method.declaration.file)}:${ranges(m.lines)}` : ranges(m.lines),
      reachedFrom: [...new Set(m.reachedFrom.map((x) => entryLabel(x.entryPoint)))],
      tests: m.tests,
      ...(m.truncated ? { truncated: true } : {}),
      ...(m.notWalked ? { notWalked: true } : {}),
    })),
    issues: r.issues.map((i) => ({
      ...toIssue(p.root, i.finding),
      ...(i.at ? { at: [`${i.at.file}:${i.at.line}`] } : {}),
      where: i.where,
      ...(i.entryPoint ? { flow: entryLabel(i.entryPoint) } : i.methodKey ? { flow: nameOfKey(i.methodKey) } : {}),
    })),
    ...(r.structure
      ? {
          structure: {
            rows: r.structure.rows.map((row) => ({
              kind: row.kind,
              title: row.title,
              ...(row.detail ? { detail: row.detail } : {}),
              ...(row.level ? { level: row.level } : {}),
              ...(row.pairs?.length ? { pairs: row.pairs.map((x) => `${x.fromName} → ${x.toName}${x.call?.callSite ? `  ${where(p.root, x.call.callSite)}` : ''}`) } : {}),
              ...(row.entryPoint && !row.kind.startsWith('entry') ? { flow: entryLabel(row.entryPoint) } : {}),
            })),
            compared: r.structure.compared,
            copied: r.structure.copied,
            notCompared: r.structure.notCompared,
          },
        }
      : {}),
  };
  if (r.structure?.notCompared) limits.push(`${r.structure.notCompared} affected entry points not compared with the base (structure limit)`);
  return { result, limits };
}

// ───────────────────────────── entry points ─────────────────────────────

export interface EntryPointRow {
  kind: EntryPointKind;
  /** HTTP: `GET /users/:id`; a job / command / handler: what starts it; a module-level call: `Class.method`. */
  label: string;
  method: string;
  key: string;
  at?: string;
  detail?: string;
  routeName?: string;
  project?: string;
  /** A module-level call: the file it runs in. */
  file?: string;
}

export interface EntryPointsResult {
  entryPoints: EntryPointRow[];
  /** All entry points of the project (before the filter; tests only with `tests`). */
  total: number;
  filter?: string;
}

/** FR-27.8 where flows start: routes, jobs, commands, handlers, programs (tests with `tests`); every filter word must match. */
/** FR-27.8 the words of a filter, each found in the entry point's label, method, key, route name, detail, project or file. */
function entryMatcher(filter: string | undefined): { words: string[]; match(e: EntryPoint): boolean } {
  const words = (filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = (e: EntryPoint) => [e.label, methodLabel(e.method), e.method.key, e.routeName, e.detail, e.project, e.file].filter(Boolean).join(' ').toLowerCase();
  return { words, match: (e) => words.every((w) => text(e).includes(w)) };
}

export async function runEntryPoints(p: Project, opts: { filter?: string; tests?: boolean } = {}): Promise<{ result: EntryPointsResult; limits: string[] }> {
  const all = (await p.session.getEntryPoints()).filter((e) => opts.tests || e.kind !== 'test');
  const { words, match } = entryMatcher(opts.filter);
  const rows = all
    .filter(match)
    .map(
      (e): EntryPointRow => ({
        kind: e.kind,
        label: e.label,
        method: methodLabel(e.method),
        key: e.method.key,
        ...(e.method.declaration ? { at: where(p.root, e.method.declaration) } : {}),
        ...(e.detail ? { detail: e.detail } : {}),
        ...(e.routeName ? { routeName: e.routeName } : {}),
        ...(e.project ? { project: e.project } : {}),
        ...(e.file ? { file: rel(p.root, e.file) } : {}),
      }),
    );
  return { result: { entryPoints: rows, total: all.length, ...(words.length ? { filter: opts.filter } : {}) }, limits: [] };
}

// ───────────────────────────── entry point outcomes ─────────────────────────────

export interface OutcomeRow {
  kind: EntryPointKind;
  label: string;
  method: string;
  key: string;
  at?: string;
  /** I/O kinds in the fixed order, each with the classes doing it and their library calls (`at`: file:line). */
  io: { kind: SideEffectKind; via: { class: string; calls: { call: string; at?: string }[] }[] }[];
  /** Calls stayed folded (expand limit, a rule), an interface call has too many implementations or the I/O walk stopped: there may be more. */
  atLeast?: true;
  /** With `atLeast`: calls left folded with calls of their own. */
  folded?: number;
  /** With `atLeast`: interface calls not followed, with their implementations. */
  wide?: { call: string; implementations: number }[];
  /** With `atLeast`: the methods where the I/O walk stopped (its depth limit, a body not analysed). */
  deep?: string[];
  /** Calls the analysis could not resolve. */
  unresolved?: number;
  /** The flow could not be opened (a stale route, a missing class). */
  failed?: true;
}

export interface OutcomesResult {
  entryPoints: OutcomeRow[];
  /** All entry points of the project (tests excluded), before the filter. */
  total: number;
  filter?: string;
}

/**
 * FR-32.5 what each entry point's flow touches (tests excluded; filtered as `entrypoints`): its I/O by kind with the
 * classes doing it — the project scan of `issues`, shared with it.
 */
export async function runOutcomes(p: Project, opts: { filter?: string } = {}): Promise<{ result: OutcomesResult; limits: string[] }> {
  const all = (await p.session.getEntryPoints()).filter((e) => e.kind !== 'test');
  const { words, match } = entryMatcher(opts.filter);
  const chosen = all.filter(match);
  // nothing cancels a CLI / MCP call
  const found = (await p.session.findOutcomes({ only: new Set(chosen.map(appMapEntryKey)) }))!;
  const rows = found.map(
    ({ entry: e, outcome, failed }): OutcomeRow => ({
      kind: e.kind,
      label: e.label,
      method: methodLabel(e.method),
      key: e.method.key,
      ...(e.method.declaration ? { at: where(p.root, e.method.declaration) } : {}),
      io: (outcome?.io ?? []).map((k) => ({ kind: k.kind, via: k.via.map((v) => ({ class: v.className, calls: v.calls.map((c) => ({ call: c.call, ...(c.at ? { at: lineOf(p.root, c.at) } : {}) })) })) })),
      ...(outcome?.atLeast ? { atLeast: true as const } : {}),
      ...(outcome?.folded ? { folded: outcome.folded } : {}),
      ...(outcome?.wide ? { wide: outcome.wide } : {}),
      ...(outcome?.deep ? { deep: outcome.deep } : {}),
      ...(outcome?.unresolved ? { unresolved: outcome.unresolved } : {}),
      ...(failed ? { failed } : {}),
    }),
  );
  const cut = rows.filter((r) => r.atLeast).length;
  return {
    result: { entryPoints: rows, total: all.length, ...(words.length ? { filter: opts.filter } : {}) },
    limits: cut ? [`${cut} flow${cut > 1 ? 's' : ''} not followed to the end (calls left folded, an interface call with too many implementations, or I/O deeper than the walk goes): their I/O may be more`] : [],
  };
}

// ───────────────────────────── project issues ─────────────────────────────

export interface ProjectIssue extends Issue {
  /** The entry point whose flow shows it (open it with `flow` on `flowKey`). */
  flow: string;
  flowKey: string;
  /** Other entry points reaching the same issue. */
  others?: number;
  files?: string[];
}

/** FR-27.9 the design issues of the whole project: every entry point's flow (tests excluded), expanded and I/O-scanned. */
export async function runIssues(p: Project): Promise<{ result: { issues: ProjectIssue[]; entryPoints: number }; limits: string[] }> {
  const found = await p.session.findProjectIssues();
  if (!found) throw new Error('scan cancelled');
  const entryPoints = (await p.session.getEntryPoints()).filter((e) => e.kind !== 'test').length;
  const issues = found.map(
    (f): ProjectIssue => ({
      ...toIssue(p.root, f.finding),
      flow: entryLabel(f.entryPoint),
      flowKey: f.entryPoint.method.key,
      ...(f.others ? { others: f.others } : {}),
      ...(f.files?.length ? { files: f.files } : {}),
    }),
  );
  const cut = p.session.projectTruncatedCount;
  return { result: { issues, entryPoints }, limits: cut ? [`expand limit: ${cut} entry-point flows not fully opened, issues further down may be missing`] : [] };
}

// ───────────────────────────── unreachable code ─────────────────────────────

export interface UnreachableRow {
  method: string;
  key: string;
  at?: string;
  reason: UnreachableReason;
  /** References found (test code included). */
  callers: number;
  /** FR-31.2 why the framework may call it. */
  framework?: string;
  /** FR-31.3 calls of the name the analysis could not resolve. */
  unresolved?: number;
  via?: string;
}

export interface UnreachableResult {
  methods: UnreachableRow[];
  total: number;
  reached: number;
  entryPoints: number;
  /** Not listed: a reference the walk does not follow points at them. */
  missed: number;
  ignored?: number;
}

/** FR-31 the methods no entry point reaches (tests excluded), by reason; framework-called and maybe-called apart. */
export async function runUnreachable(p: Project): Promise<{ result: UnreachableResult; limits: string[] }> {
  const r = await p.session.findUnreachableCode();
  if (!r) throw new Error('scan cancelled');
  const methods = r.methods.map(
    (u): UnreachableRow => ({
      method: methodLabel(u.method),
      key: u.method.key,
      ...(u.method.declaration ? { at: where(p.root, u.method.declaration) } : {}),
      reason: u.reason,
      callers: u.callers,
      ...(u.framework ? { framework: u.framework } : {}),
      ...(u.unresolved ? { unresolved: u.unresolved } : {}),
      ...(u.via ? { via: u.via } : {}),
    }),
  );
  return {
    result: { methods, total: r.total, reached: r.reached, entryPoints: r.entryPoints, missed: r.missed, ...(r.ignored ? { ignored: r.ignored } : {}) },
    limits: r.truncated ? ['walk limit: more methods may be reached than the walk saw (the list may hold live code)'] : [],
  };
}

// ───────────────────────────── implementations ─────────────────────────────

export interface ImplsResult {
  method: { label: string; key: string; at?: string; abstract: boolean };
  /** Methods implementing / overriding it. */
  implementations: { method: string; key: string; at?: string }[];
  /** DI registrations of the method's class (FR-8.6). */
  registrations: { concrete: string; at: string; lifetime?: string; key?: string; keyKind?: 'key' | 'condition'; consumer?: string; fallback?: boolean; hosts?: string[]; typeArgs?: string[] }[];
  /**
   * What the container gives where nothing more specific applies; per application when they differ. No `concrete`: no
   * single class there (keyed / conditional registrations: the key or condition decides at run time).
   */
  bound?: { concrete?: string; at?: string; host?: string }[];
}

async function targetMethod(p: Project, target: Target): Promise<MethodRef> {
  if ('methodKey' in target) {
    const m = await p.adapter.getMethod(target.methodKey);
    if (!m) throw new UsageError(`no method with key ${target.methodKey}`);
    return m;
  }
  if (!fs.existsSync(target.file)) throw new UsageError(`no such file: ${target.file}`);
  const text = fs.readFileSync(target.file, 'utf8').split('\n')[target.line - 1];
  if (text === undefined) throw new UsageError(`${target.file} has no line ${target.line}`);
  const m = await p.adapter.findEnclosingCallable(target.file, { line: target.line - 1, character: Math.max(0, text.search(/\S/)) });
  if (!m) throw new UsageError(`no method at ${target.file}:${target.line} (give a line of the interface or base-class method)`);
  return m;
}

/** FR-27.10 who implements an interface / abstract / overridable method, and what the DI container gives for its type. */
export async function runImpls(p: Project, target: Target): Promise<{ result: ImplsResult; limits: string[] }> {
  const m = await targetMethod(p, target);
  const impls = await p.adapter.getImplementations(m);
  let bindings: ContainerBinding[] = [];
  try {
    bindings = (await p.adapter.getBindings?.()) ?? [];
  } catch {
    bindings = [];
  }
  const mine = bindings.filter((b) => b.abstract === m.owner.key);
  const name = (key: string) => nameOfKey(key);
  const result: ImplsResult = {
    method: { label: methodLabel(m), key: m.key, ...(m.declaration ? { at: where(p.root, m.declaration) } : {}), abstract: !m.hasBody },
    implementations: impls.map((i) => ({ method: methodLabel(i), key: i.key, ...(i.declaration ? { at: where(p.root, i.declaration) } : {}) })),
    registrations: mine.map((b) => ({
      concrete: name(b.concrete),
      at: lineOf(p.root, b.range),
      ...(b.lifetime ? { lifetime: b.lifetime } : {}),
      ...(b.key !== undefined ? { key: b.key, keyKind: b.keyKind ?? 'key' } : {}),
      ...(b.consumer ? { consumer: name(b.consumer) } : {}),
      ...(b.fallback ? { fallback: true } : {}),
      ...(b.hosts ? { hosts: b.hosts } : {}),
      ...(b.abstractArgs?.length ? { typeArgs: b.abstractArgs.map(name) } : {}),
    })),
  };
  if (mine.some((b) => b.key === undefined)) {
    const hosts = [...new Set(mine.flatMap((b) => b.hosts ?? []))];
    const per = (hosts.length ? hosts : [undefined]).map((h) => ({ h, b: bindingLookup(bindings, h ? [h] : undefined).bound(undefined, m.owner.key) }));
    const bound = per.map((x) => ({ ...(x.b ? { concrete: name(x.b.classKey), at: lineOf(p.root, x.b.at) } : {}), ...(x.h ? { host: x.h } : {}) }));
    // the same class in every application: one line
    const same = bound.every((b) => b.concrete && b.concrete === bound[0].concrete);
    result.bound = same ? [{ concrete: bound[0].concrete, at: bound[0].at }] : bound;
  }
  return { result, limits: [] };
}
