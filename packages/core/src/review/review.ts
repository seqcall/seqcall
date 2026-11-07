import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CallPathNode, CallPathStep, ClassDiagram, EntryPoint, Finding, MethodRef, ReviewIssue, ReviewMethod, ReviewResult, SequenceDiagram } from '@seqcall/protocol';
import type { LanguageAdapter } from '../adapter';
import { layerViolationFindings, withoutTypeUses } from '../findings';
import { isAnalysedFile } from '../languages';
import type { PathsResult } from '../paths';
import { branchChanges, type BranchChanges, type FileChange } from './git-changes';

/** Bounds: changed lines looked up, changed methods walked, flows scanned for issues. */
const MAX_LINES = 3000;
const MAX_METHODS = 400;
const MAX_ENTRY_SCANS = 12;
const MAX_UNREACHED_SCANS = 8;

export interface ReviewDeps {
  root: string;
  adapter: LanguageAdapter;
  entryPoints(): Promise<EntryPoint[]>;
  /** Paths to here of a method (FR-22). */
  paths(method: MethodRef): Promise<PathsResult | undefined>;
  /** A flow opened from an entry point (or a method), expanded fully, I/O scanned: its findings and class diagram. */
  scan(start: { entryPoint?: EntryPoint; methodKey?: string }): Promise<{ diagram?: SequenceDiagram; classDiagram?: ClassDiagram }>;
  isTest(file: string): boolean;
  /** Changed methods walked up to the entry points (default 400); the rest are marked `notWalked`. */
  maxMethods?: number;
  cancelled?(): boolean;
  onProgress?(phase: string, done: number, total: number): void;
}

/** The branch's changes as the diagram's diff marks need them. */
export interface ReviewMarks {
  /** Project-relative file → changed (added) 1-based lines. */
  lines: Map<string, Set<number>>;
  methods: Map<string, 'added' | 'changed'>;
}

const rel = (root: string, file: string) => path.relative(root, file).replace(/\\/g, '/');

/**
 * FR-24 review of the current branch against `base`: the changed methods, the entry points they affect
 * (with the path to open and the tests reaching them), the design findings and layer violations of those
 * flows whose evidence is on changed lines (or in a changed class). Undefined when cancelled.
 */
export async function reviewBranch(deps: ReviewDeps, base?: string, read?: BranchChanges): Promise<{ result: ReviewResult; marks: ReviewMarks; changes: BranchChanges } | undefined> {
  const progress = (phase: string, done: number, total: number) => deps.onProgress?.(phase, done, total);
  progress('Reading the changes (git)', 0, 1);
  const changes = read ?? (await branchChanges(deps.root, base || 'develop'));
  const files = changes.files.filter((f) => f.status !== 'deleted');
  const byFile = new Map(files.map((f) => [f.file, f]));
  const changedLine = (file: string, line: number) => byFile.get(file)?.added.has(line) ?? false;

  // 1. changed methods: the method around each changed line
  const methods = new Map<string, ReviewMethod>();
  let otherLines = 0;
  let looked = 0;
  const source = files.filter((f) => isAnalysedFile(`/${f.file}`) && !deps.isTest(f.file));
  const totalLines = Math.min(MAX_LINES, source.reduce((n, f) => n + f.added.size + f.removedAt.length, 0));
  for (const f of source) {
    const text = await fs.readFile(path.join(deps.root, f.file), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const srcLines = text.split('\n');
    const lines = [...new Set([...f.added, ...f.removedAt])].sort((a, b) => a - b);
    for (const line of lines) {
      if (deps.cancelled?.()) return undefined;
      if (looked++ >= MAX_LINES) break;
      if (looked % 50 === 0) progress('Finding the changed methods', looked, totalLines);
      // FR-24.15 a blank line added between two methods belongs to neither (Roslyn counts it as the next one's trivia)
      if (f.added.has(line) && !f.removedAt.includes(line) && !(srcLines[line - 1] ?? '').trim()) continue;
      const col = Math.max(0, (srcLines[line - 1] ?? '').search(/\S/));
      const m = await deps.adapter.findEnclosingCallable(path.join(deps.root, f.file).replace(/\\/g, '/'), { line: line - 1, character: col });
      if (!m || m.owner.kind === 'external') {
        if (f.added.has(line)) otherLines++;
        continue;
      }
      let rm = methods.get(m.key);
      if (!rm) {
        const declLine = m.declaration ? m.declaration.start.line + 1 : -1;
        rm = { method: m, status: f.status === 'added' || f.added.has(declLine) ? 'added' : 'changed', lines: [], reachedFrom: [], tests: 0 };
        methods.set(m.key, rm);
      }
      if (f.added.has(line)) rm.lines.push(line);
    }
  }

  // 2. who reaches them: entry points (with the path to open) and tests
  const eps = await deps.entryPoints().catch(() => [] as EntryPoint[]);
  const epsOf = new Map<string, EntryPoint[]>();
  for (const e of eps) epsOf.set(e.method.key, [...(epsOf.get(e.method.key) ?? []), e]);
  const all = [...methods.values()];
  const list = all.slice(0, deps.maxMethods ?? MAX_METHODS);
  // past the limit nothing is known about the callers: never shown as "no entry point reaches it"
  for (const rm of all.slice(list.length)) rm.notWalked = true;
  for (let i = 0; i < list.length; i++) {
    if (deps.cancelled?.()) return undefined;
    progress('Walking the callers up to the entry points', i, list.length);
    const rm = list[i];
    for (const e of epsOf.get(rm.method.key) ?? []) if (e.kind !== 'test') rm.reachedFrom.push({ entryPoint: e, steps: [{ methodKey: rm.method.key }] });
    const r = await deps.paths(rm.method).catch(() => undefined);
    if (!r) continue;
    if (r.truncated) rm.truncated = true;
    const seen = new Set<string>();
    for (const chain of leaves(r.tree)) {
      const start = chain[0];
      if (start === r.tree) continue;
      const own = start.entryPoints?.filter((e) => e.kind !== 'test') ?? [];
      if (!own.length && (start.inTest || start.entryPoints?.length)) {
        rm.tests++;
        continue;
      }
      for (const e of own) {
        const id = `${e.kind}|${e.label}`;
        if (seen.has(id)) continue;
        seen.add(id);
        rm.reachedFrom.push({ entryPoint: e, steps: stepsOf(chain) });
      }
    }
  }

  // 3. issues of the affected flows whose evidence is on changed lines
  const affected = new Map<string, { entryPoint: EntryPoint; reach: number }>();
  for (const rm of methods.values()) {
    for (const { entryPoint: e } of rm.reachedFrom) {
      const id = `${e.kind}|${e.label}`;
      const a = affected.get(id);
      if (a) a.reach++;
      else affected.set(id, { entryPoint: e, reach: 1 });
    }
  }
  const starts: { entryPoint?: EntryPoint; methodKey?: string }[] = [
    ...[...affected.values()].sort((a, b) => b.reach - a.reach).slice(0, MAX_ENTRY_SCANS).map((a) => ({ entryPoint: a.entryPoint })),
    ...[...methods.values()].filter((m) => !m.reachedFrom.length && !m.notWalked && m.method.hasBody).slice(0, MAX_UNREACHED_SCANS).map((m) => ({ methodKey: m.method.key })),
  ];
  const issues = new Map<string, ReviewIssue>();
  for (let i = 0; i < starts.length; i++) {
    if (deps.cancelled?.()) return undefined;
    progress('Looking for issues in the affected flows', i, starts.length);
    const start = starts[i];
    const { diagram, classDiagram } = await deps.scan(start).catch(() => ({}) as { diagram?: SequenceDiagram; classDiagram?: ClassDiagram });
    for (const issue of issuesOf(diagram, classDiagram, deps.root, changedLine, (key) => changedClass(key, byFile))) {
      const key = `${issue.finding.kind}|${issue.finding.title}`;
      const known = issues.get(key);
      if (known && (known.where === 'changed-lines' || issue.where !== 'changed-lines')) continue;
      issues.set(key, { ...issue, ...(start.entryPoint ? { entryPoint: start.entryPoint } : { methodKey: start.methodKey }) });
    }
  }
  progress('Done', 1, 1);

  const result: ReviewResult = {
    base: changes.base,
    resolvedBase: changes.resolvedBase,
    compare: { mode: changes.mode, point: changes.mergeBase.slice(0, 9), commits: changes.commits, behind: changes.behind, outside: changes.outside.slice(0, 20) },
    ...(changes.branch ? { branch: changes.branch } : {}),
    files: changes.files.map((f) => ({ file: f.file, path: path.join(deps.root, f.file).replace(/\\/g, '/'), status: f.status, added: f.addedCount, removed: f.removedCount, ...(deps.isTest(f.file) ? { test: true } : {}) })),
    methods: [...methods.values()],
    issues: [...issues.values()].sort((a, b) => Number(a.where !== 'changed-lines') - Number(b.where !== 'changed-lines')),
    scanned: starts.length,
    notScanned: Math.max(0, affected.size - MAX_ENTRY_SCANS),
    otherLines,
  };
  const marks: ReviewMarks = { lines: new Map(files.map((f) => [f.file, f.added])), methods: new Map([...methods.values()].map((m) => [m.method.key, m.status])) };
  return { result, marks, changes };

  function changedClass(classKey: string, changed: Map<string, FileChange>): boolean {
    const file = classKey.slice(0, classKey.indexOf('#'));
    return (changed.get(file)?.added.size ?? 0) > 0;
  }
}

/** Root-to-leaf chains of the reverse tree, leaf (the start) first. */
function* leaves(n: CallPathNode, chain: CallPathNode[] = []): Generator<CallPathNode[]> {
  const here = [n, ...chain];
  if (!n.callers?.length) yield here;
  else for (const c of n.callers) yield* leaves(c, here);
}

function stepsOf(chain: CallPathNode[]): CallPathStep[] {
  return chain.map((n) => ({ methodKey: n.method.key, ...(n.call ? { call: { range: n.call.range, ...(n.call.passed ? { passed: true } : {}) } } : {}) }));
}

/** The findings and layer violations of one scanned flow, with where their evidence is. */
function issuesOf(
  d: SequenceDiagram | undefined,
  cd: ClassDiagram | undefined,
  root: string,
  changedLine: (file: string, line: number) => boolean,
  changedClass: (classKey: string) => boolean,
): Omit<ReviewIssue, 'entryPoint' | 'methodKey'>[] {
  const out: Omit<ReviewIssue, 'entryPoint' | 'methodKey'>[] = [];
  const byId = new Map((d?.messages ?? []).map((m) => [m.id, m]));
  const onLine = (range: { file: string; start: { line: number } } | undefined) => {
    if (!range) return undefined;
    const file = rel(root, range.file);
    return changedLine(file, range.start.line + 1) ? { file, line: range.start.line + 1 } : undefined;
  };
  const placeOf = (f: Finding): Pick<ReviewIssue, 'where' | 'at'> | undefined => {
    for (const id of f.messageIds ?? []) {
      const at = onLine(byId.get(id)?.callSite);
      if (at) return { where: 'changed-lines', at };
    }
    for (const rid of f.relationIds ?? []) {
      const r = cd?.relations.find((x) => x.id === rid);
      for (const c of r?.calls ?? []) {
        const at = onLine(c.callSite);
        if (at) return { where: 'changed-lines', at };
      }
      for (const u of r?.uses ?? []) {
        const at = onLine(u.range);
        if (at) return { where: 'changed-lines', at };
      }
    }
    if ((f.classKeys ?? []).some(changedClass)) return { where: 'changed-class' };
    return undefined;
  };
  // FR-19.17 both diagrams carry the same issues (layer violations included); the class diagram's violations also
  // when design findings are off
  const seen = new Set<string>();
  const all = [...(d?.findings ?? []), ...(cd?.findings ?? []), ...(cd ? layerViolationFindings(withoutTypeUses(cd).classes, withoutTypeUses(cd).relations) : [])];
  for (const f of all) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    // a violation is the depending class's: changed there, or on its calls
    const place = placeOf(f.kind === 'layer-violation' ? { ...f, classKeys: (f.classKeys ?? []).slice(0, 1) } : f);
    if (place) out.push({ finding: f, ...place });
  }
  return out;
}
