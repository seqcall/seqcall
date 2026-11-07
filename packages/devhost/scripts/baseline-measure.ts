/**
 * Quality baseline, one measurement (scripts/baseline.mjs runs it in a child process per repository and compares the
 * result with the developer's own earlier run, docs/TESTING.md §8a): the entry points of a project, and for the first
 * `max` of them (by key, or the keys given) the opened and Smart-expanded flow, its unknown calls and findings, the
 * class diagram's findings, and how the calls of the methods in those flows resolve (project, library, unknown).
 *
 *   node <bundle> <projectRoot> <out.json> [max=40] [keys.json]
 * C#: set SEQCALL_CSHARP_SIDECAR. Uses only the core API of the last release (the script also measures that version).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createAdapter, createClassifier, DiagramSession } from '../../core/src/index';
import { PhpModel } from '../../core/src/php/model';
import { PhpProject } from '../../core/src/php/project';
import type { CallSite } from '../../core/src/adapter';

export interface EntryResult {
  label: string;
  opened: number;
  smart: number;
  /** Messages of the Smart flow whose target is unknown. */
  unknown: number;
  ms: number;
  error?: string;
}

export interface Measurement {
  language: 'typescript' | 'csharp' | 'php';
  /** Every entry point found (tests excluded), by key. */
  entryPoints: string[];
  entries: Record<string, EntryResult>;
  /** The distinct findings of the sequence and class diagrams, `kind: title`. */
  findings: string[];
  /** The outgoing calls of every method shown in the Smart flows. */
  calls: { project: number; library: number; unknown: number };
  /** PHP: the outgoing calls of every method of the project, tests excluded (as php-sweep.ts; a library has no entry points). */
  allCalls?: { methods: number; project: number; library: number; unknown: number; crashes: number };
  ms: number;
}

export function languageOf(root: string): Measurement['language'] {
  const files = readdirSync(root);
  return files.some((f) => /\.slnx?$/.test(f)) ? 'csharp' : files.includes('composer.json') ? 'php' : 'typescript';
}

export async function measure(root: string, max = 40, keys?: string[]): Promise<Measurement> {
  const t0 = Date.now();
  const language = languageOf(root);
  const adapter = createAdapter(language, root);
  const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
  try {
    const all = (await s.getEntryPoints()).filter((e) => e.kind !== 'test').sort((a, b) => (a.method.key < b.method.key ? -1 : a.method.key > b.method.key ? 1 : 0));
    const byKey = new Map(all.map((e) => [e.method.key, e]));
    const chosen = keys ?? [...byKey.keys()].slice(0, max);
    const entries: Record<string, EntryResult> = {};
    const findings = new Set<string>();
    const shown = new Set<string>();
    for (const key of chosen) {
      const e = byKey.get(key);
      if (!e) continue; // gone: the comparison reports it from the entry-point list
      const t = Date.now();
      try {
        const opened = (await s.openMethodByKey(key, e))?.messages.length ?? 0;
        const d = await s.smartExpand();
        const cd = await s.getClassDiagram();
        for (const f of [...(d?.findings ?? []), ...(cd?.findings ?? [])]) findings.add(`${f.kind}: ${f.title}`);
        for (const m of d?.messages ?? []) if (m.methodKey) shown.add(m.methodKey);
        const unknown = (d?.messages ?? []).filter((m) => m.kind !== 'found' && !m.methodKey).length;
        entries[key] = { label: e.label, opened, smart: d?.messages.length ?? 0, unknown, ms: Date.now() - t };
      } catch (err) {
        entries[key] = { label: e.label, opened: 0, smart: 0, unknown: 0, ms: Date.now() - t, error: String((err as Error).message ?? err).slice(0, 200) };
      }
    }
    const calls = { project: 0, library: 0, unknown: 0 };
    for (const key of [...shown].sort((a, b) => Number(a > b) - Number(a < b))) {
      const m = await adapter.getMethod(key).catch(() => undefined);
      if (!m?.hasBody) continue;
      for (const c of await adapter.getOutgoingCalls(m).catch(() => [])) {
        if (c.isLibrary) calls.library++;
        else if (resolved(c)) calls.project++;
        else calls.unknown++;
      }
    }
    const allCalls = language === 'php' ? await phpCalls(root, adapter) : undefined;
    return { language, entryPoints: [...byKey.keys()], entries, findings: [...findings].sort((a, b) => Number(a > b) - Number(a < b)), calls, ...(allCalls ? { allCalls } : {}), ms: Date.now() - t0 };
  } finally {
    await s.dispose();
  }
}

/**
 * A call of the project: its target, a created project class, or the function a project call returned (FR-1.11
 * `invokesResult`, drawn as the sender's own call — no method of its own to name).
 */
function resolved(c: CallSite): boolean {
  return !!c.target || (c.kind === 'create' && !!c.receiverType) || !!c.invokesResult;
}

async function phpCalls(root: string, adapter: ReturnType<typeof createAdapter>): Promise<NonNullable<Measurement['allCalls']>> {
  const r = { methods: 0, project: 0, library: 0, unknown: 0, crashes: 0 };
  const model = new PhpModel(new PhpProject(root));
  for (const c of model.allCallables()) {
    if (/^tests?\//.test(c.file.rel)) continue;
    r.methods++;
    try {
      for (const s of await adapter.getOutgoingCalls(model.refOfCallable(c))) {
        if (s.isLibrary) r.library++;
        else if (resolved(s)) r.project++;
        else r.unknown++;
      }
    } catch {
      r.crashes++;
    }
  }
  return r;
}

if (require.main === module) {
  const [root, out, max = '40', keysFile] = process.argv.slice(2);
  if (!root || !out) {
    console.error('usage: baseline-measure <projectRoot> <out.json> [max] [keys.json]');
    process.exit(2);
  }
  const keys = keysFile ? (JSON.parse(readFileSync(keysFile, 'utf8')) as string[]) : undefined;
  measure(root, Number(max), keys).then(
    (m) => {
      writeFileSync(out, JSON.stringify(m, null, 1)); // a file, not stdout: the analysis may log
      process.exit(0); // the C# sidecar / TS program keep handles open
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
