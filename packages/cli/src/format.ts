import { atLeastWhy, flowLines, issueLines } from '@seqcall/core';
import type { EntryPointsResult, Envelope, FlowResult, ImplsResult, OutcomesResult, PathNode, PathsResult, ProjectIssue, ReviewOutput, UnreachableResult, UnreachableRow } from './commands';

/**
 * FR-27.2 the text form: an indented tree with file:line, few tokens, as an agent reads it best. The JSON
 * form (`--format json`) carries the same content plus ids and keys.
 */

function header(e: Envelope<unknown>): string[] {
  const out = [`# seqcall ${e.command} · ${e.project.language} · ${e.project.root} · ${e.elapsedMs} ms`];
  if (!e.complete) for (const l of e.limits) out.push(`# INCOMPLETE: ${l}`);
  return out;
}

/** FR-27.6 short by default (the method, its I/O and issues); the call tree with `tree`. */
export function flowText(e: Envelope<FlowResult>, opts: { tree?: boolean } = {}): string {
  return [...header(e), ...flowLines(e.result, opts)].join('\n');
}

function pathLines(n: PathNode, depth: number, out: string[], code: boolean): void {
  const pad = '  '.repeat(depth);
  const tags = [
    n.entryPoints?.length && `[entry: ${n.entryPoints.join(', ')}]`,
    n.end === 'top' && '[no callers in the project]',
    n.end === 'limit' && '[cut by limit]',
    n.call?.passed && 'passed as argument',
    n.call?.count && `×${n.call.count}`,
    n.tests && `+${n.tests} test caller${n.tests > 1 ? 's' : ''}`,
  ].filter(Boolean);
  out.push(`${pad}${depth ? '← ' : ''}${n.method}${n.call?.at ? `  ${n.call.at}` : ''}${n.call && code ? `  \`${n.call.code}\`` : ''}${tags.length ? `  ${tags.join('  ')}` : ''}`);
  for (const c of n.callers ?? []) pathLines(c, depth + 1, out, code);
}

/** `code`: each call's source line too (FR-27.6: left out by default). */
export function pathsText(e: Envelope<PathsResult>, opts: { code?: boolean } = {}): string {
  const r = e.result;
  const out = header(e);
  const kinds = Object.entries(r.reachedFrom);
  out.push(
    kinds.length || r.tests
      ? `reached from: ${[...kinds.map(([k, v]) => `${v.length} ${k}`), ...(r.tests ? [`${r.tests} tests`] : [])].join(', ')}`
      : 'reached from: no entry point (nothing in the project calls it, or only through code the analysis cannot follow)',
  );
  for (const [k, v] of kinds) out.push(`  ${k}: ${v.join(', ')}`);
  if (r.testsMocking) out.push(`  ${r.testsMocking} of the ${r.tests} tests mock a type on the way (their file or a helper it uses): they reach its interface, not this code`);
  if (r.httpTests?.length) {
    const files = new Set(r.httpTests.map((h) => h.at.replace(/:\d+$/, '')));
    out.push(`  over HTTP from test code (found by URL / route-name text, not in the tree): ${r.httpTests.length} call${r.httpTests.length > 1 ? 's' : ''} in ${files.size} file${files.size > 1 ? 's' : ''}${r.testList ? '' : ' (--tests lists them)'}`);
  }
  out.push(`${r.methodsSearched} methods searched; tree (each line is called by the lines below it; test code only counted):`);
  pathLines(r.target, 0, out, !!opts.code);
  if (r.testList) {
    out.push(`tests (${r.tests}):`);
    for (const t of r.testList) out.push(`  ${t.class}${t.file ? `  ${t.file}` : ''}: ${t.methods.join(', ')}${t.mocks ? `  [mocks ${t.mocks.join(', ')}]` : ''}`);
    if (r.httpTests?.length) {
      out.push(`tests over HTTP (${r.httpTests.length}, by text):`);
      for (const h of r.httpTests) out.push(`  ${h.route}  ← ${h.in ?? '(no method)'}  ${h.at}${h.by === 'name' ? '  (route name)' : ''}`);
    }
  }
  return out.join('\n');
}

export function reviewText(e: Envelope<ReviewOutput>): string {
  const r = e.result;
  const out = header(e);
  out.push(`${r.branch ?? 'HEAD'} compared ${r.compared}`);
  out.push(`files (${r.files.length}): ${r.files.map((f) => `${f.path} ${f.status === 'modified' ? '' : `${f.status} `}+${f.added}/-${f.removed}${f.test ? ' (test)' : ''}`).join(', ') || 'none'}`);
  out.push(r.methods.length ? `changed methods (${r.methods.length}):` : 'changed methods: none');
  for (const m of r.methods) {
    const reach = m.reachedFrom.length ? `← ${m.reachedFrom.join(', ')}` : m.notWalked ? '← not walked (limit)' : '← no entry point';
    out.push(`  ${m.method}  ${m.status}  ${m.lines}  ${reach}${m.tests ? `  (+${m.tests} tests)` : ''}${m.truncated ? '  [callers cut by limit]' : ''}`);
  }
  if (r.structure) {
    const s = r.structure;
    const nouns: Record<string, string> = { edge: 'dependency', violation: 'layer violation', entry: 'entry point', io: 'I/O kind', client: 'I/O client', cycle: 'cycle', layer: 'class changed layer', role: 'class changed role' };
    const noun = (k: string) => nouns[k.replace(/-(added|removed|changed)$/, '')];
    out.push(s.rows.length ? `structure (${s.rows.length} changes against the base; ${s.compared} flows compared, ${s.copied} unchanged):` : `structure: unchanged (${s.compared} flows compared, ${s.copied} unchanged)`);
    for (const row of s.rows) {
      const what = `${row.kind.endsWith('-added') ? '+' : row.kind.endsWith('-removed') ? '-' : '~'} ${noun(row.kind)}${row.level === 'package' ? ' (packages)' : ''}`;
      out.push(`  ${what}  ${row.title}${row.detail ? `  ${row.detail}` : ''}${row.flow ? `  ← ${row.flow}` : ''}`);
    }
  }
  out.push(r.issues.length ? `issues in the changed flows (${r.issues.length}):` : 'issues in the changed flows: none');
  out.push(...issueLines(r.issues));
  return out.join('\n');
}

/** Entry points by kind: `GET /users/:id  UserController.getUser  src/x.ts:12`. */
export function entryPointsText(e: Envelope<EntryPointsResult>): string {
  const r = e.result;
  const out = header(e);
  const shown = r.entryPoints.length;
  out.push(r.filter ? `${shown} of ${r.total} entry points match "${r.filter}"` : `${shown} entry points`);
  const kinds = [...new Set(r.entryPoints.map((x) => x.kind))];
  for (const k of kinds) {
    const rows = r.entryPoints.filter((x) => x.kind === k);
    out.push(`${k} (${rows.length}):`);
    for (const x of rows) {
      const label = x.label === x.method ? x.method : `${x.label}  ${x.method}`;
      const tags = [x.routeName && `name: ${x.routeName}`, x.detail, x.project && `project: ${x.project}`, x.file && `runs in ${x.file}`].filter(Boolean);
      out.push(`  ${label}${x.at ? `  ${x.at}` : ''}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    }
  }
  return out.join('\n');
}

const IO_LABEL: Record<string, string> = { db: 'DB', cache: 'CACHE', http: 'HTTP', file: 'FILE', queue: 'MQ', cloud: 'CLOUD', process: 'PROC' };

/**
 * FR-32.5 one line per entry point — `POST /orders  OrderController.create  DB via OrderRepository · HTTP via
 * InvoiceClient` — after a summary line; `detail`: each class's library calls with file:line below it.
 */
export function outcomesText(e: Envelope<OutcomesResult>, opts: { detail?: boolean } = {}): string {
  const r = e.result;
  const out = header(e);
  const rows = r.entryPoints;
  const count = new Map<string, number>();
  for (const x of rows) for (const k of x.io) count.set(k.kind, (count.get(k.kind) ?? 0) + 1);
  // in the fixed order of the kinds (as the rows)
  const kinds = Object.keys(IO_LABEL).flatMap((k) => (count.has(k) ? [`${k} ${count.get(k)}`] : [])).join(', ');
  const withIo = rows.filter((x) => x.io.length).length;
  const scope = r.filter ? `${rows.length} of ${r.total} entry points match "${r.filter}"` : `${rows.length} entry points (tests excluded)`;
  out.push(`outcomes: ${scope}, ${withIo} with I/O${kinds ? ` — ${kinds}` : ''}`);
  for (const x of rows) {
    const label = x.label === x.method ? x.method : `${x.label}  ${x.method}`;
    const notes = [x.atLeast && `at least: ${atLeastWhy(x)}`, x.unresolved && `${x.unresolved} call${x.unresolved > 1 ? 's' : ''} not resolved`].filter(Boolean);
    const io = x.failed ? 'could not be analysed' : x.io.length ? x.io.map((k) => `${IO_LABEL[k.kind]} via ${k.via.map((v) => v.class).join(', ')}`).join(' · ') : 'no I/O found';
    out.push(`  ${label}${opts.detail && x.at ? `  ${x.at}` : ''}  ${io}${notes.length ? `  (${notes.join('; ')})` : ''}`);
    if (!opts.detail) continue;
    for (const k of x.io) for (const v of k.via) out.push(`      ${IO_LABEL[k.kind]}  ${v.class}: ${v.calls.map((c) => `${c.call}${c.at ? `  ${c.at}` : ''}`).join(', ')}`);
  }
  return out.join('\n');
}

/** The whole project's issues, each with the flow that shows it. */
export function issuesText(e: Envelope<{ issues: ProjectIssue[]; entryPoints: number }>): string {
  const r = e.result;
  const out = header(e);
  out.push(`${r.issues.length ? `issues (${r.issues.length})` : 'issues: none'} in the flows of ${r.entryPoints} entry points (tests excluded):`);
  for (const i of r.issues) {
    out.push(...issueLines([{ ...i, flow: `${i.flow}${i.others ? ` (+${i.others} more entry points)` : ''}` }]));
    if (i.files?.length) out.push(`      files: ${i.files.slice(0, 6).join(', ')}${i.files.length > 6 ? ` +${i.files.length - 6}` : ''}`);
  }
  return out.join('\n');
}

/** FR-31 the methods no entry point reaches: dead-code candidates by reason, then the maybe- and framework-called. */
export function unreachableText(e: Envelope<UnreachableResult>): string {
  const r = e.result;
  const out = header(e);
  if (!r.entryPoints) {
    out.push(`no entry points (tests excluded) — a library? Nothing is listed (${r.total} methods).`);
    return out.join('\n');
  }
  const extra = [r.missed && `${r.missed} probably reached (a reference the walk does not follow), not listed`, r.ignored && `${r.ignored} ignored by the config`].filter(Boolean);
  out.push(`unreachable: ${r.methods.length} of ${r.total} methods (from ${r.entryPoints} entry points, tests excluded)${extra.length ? `; ${extra.join('; ')}` : ''}`);
  const line = (u: UnreachableRow, note: string) => `  ${u.method}${u.at ? `  ${u.at}` : ''}${note ? `  (${note})` : ''}`;
  const group = (title: string, rows: UnreachableRow[], note: (u: UnreachableRow) => string) => {
    if (!rows.length) return;
    out.push(`${title} (${rows.length}):`);
    for (const u of rows) out.push(line(u, note(u)));
  };
  const plain = r.methods.filter((u) => !u.framework && !u.unresolved);
  const refs = (u: UnreachableRow) => (u.callers ? `${u.callers} caller${u.callers > 1 ? 's' : ''}` : '');
  group('no callers', plain.filter((u) => u.reason === 'no-callers'), () => '');
  group('called only from unreached code', plain.filter((u) => u.reason === 'unreached-callers'), refs);
  group('only tests call it', plain.filter((u) => u.reason === 'tests-only'), refs);
  group('maybe called — calls of the name the analysis could not resolve', r.methods.filter((u) => !u.framework && u.unresolved), (u) => `${u.unresolved} unresolved${u.via ? `, via ${u.via}` : ''}`);
  group('probably called by the framework', r.methods.filter((u) => u.framework), (u) => u.framework!);
  return out.join('\n');
}

/** Implementations of a method and the DI registrations of its type. */
export function implsText(e: Envelope<ImplsResult>): string {
  const r = e.result;
  const out = header(e);
  out.push(`${r.method.label}${r.method.abstract ? '  (no body: interface / abstract)' : ''}${r.method.at ? `  ${r.method.at}` : ''}`);
  out.push(r.implementations.length ? `implementations (${r.implementations.length}):` : 'implementations: none in the project');
  for (const i of r.implementations) out.push(`  ${i.method}${i.at ? `  ${i.at}` : ''}`);
  if (r.registrations.length) {
    out.push(`DI registrations (${r.registrations.length}):`);
    for (const b of r.registrations) {
      const tags = [
        b.lifetime,
        b.key !== undefined && (b.keyKind === 'condition' ? `when ${b.key}` : `keyed ${b.key}`),
        b.consumer && `only for ${b.consumer}`,
        b.fallback && 'only if none yet',
        b.typeArgs && `for <${b.typeArgs.join(', ')}>`,
        b.hosts && `in ${b.hosts.join(', ')}`,
      ].filter(Boolean);
      out.push(`  ${b.concrete}  ${b.at}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    }
  } else out.push('DI registrations: none found');
  for (const b of r.bound ?? []) out.push(`the container gives${b.host ? ` in ${b.host}` : ''}: ${b.concrete ? `${b.concrete}  (${b.at})` : 'chosen at run time (keyed / conditional registrations)'}`);
  if (!r.bound && r.registrations.length) out.push('the container gives: chosen at run time (keyed / conditional registrations)');
  return out.join('\n');
}
