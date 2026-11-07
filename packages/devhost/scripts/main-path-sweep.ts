/**
 * FR-3.9 main path sweep: opens the project's entry points (tests excluded), expands each flow fully (SMART=1: an
 * uncapped Smart expand) and counts the messages on an error path — in an off-path branch of their body, or below a
 * call that is — with the branches that cause most of it. To judge the rules of `main-path.ts` on a real codebase.
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/main-path-sweep.ts --outfile=/tmp/seqcall-main-path.cjs
 *   node /tmp/seqcall-main-path.cjs <projectRoot> [maxEntryPoints=60] [samples=25]
 * C#: set SEQCALL_CSHARP_SIDECAR (see probe.ts).
 */
import { readdirSync } from 'node:fs';
import { createAdapter, createClassifier, DiagramSession } from '../../core/src/index';
import type { CallSite } from '../../core/src/adapter';
import { offPathOperands, offPathReason, onlyBuildsFailure } from '../../core/src/main-path';

const [root, maxEps = '60', samples = '25'] = process.argv.slice(2);
if (!root) {
  console.error('usage: main-path-sweep <projectRoot> [maxEntryPoints] [samples]');
  process.exit(2);
}
const files = readdirSync(root);
const lang = files.some((f) => /\.slnx?$/.test(f)) ? 'csharp' : files.includes('composer.json') ? 'php' : 'typescript';

(async () => {
  const adapter = createAdapter(lang, root);
  const classifier = createClassifier(root);
  const own = classifier.smartExpandConfig?.bind(classifier);
  if (process.env.SMART) Object.assign(classifier, { smartExpandConfig: () => ({ ...(own?.() ?? {}), budget: 100000 }) });
  const s = new DiagramSession({ adapter, classifier });
  const eps = (await s.getEntryPoints()).filter((e) => e.kind !== 'test').slice(0, Number(maxEps));
  const bodies = new Map<string, { calls: CallSite[]; off: Map<string, string> }>();
  const body = async (key: string) => {
    let b = bodies.get(key);
    if (!b) {
      const m = await adapter.getMethod(key);
      const calls = m ? await adapter.getOutgoingCalls(m) : [];
      const exits = m && adapter.getEarlyExits ? await adapter.getEarlyExits(m) : [];
      // the bodies of the project helpers called (a helper that only builds a failure makes a guard clause)
      const helpers = new Map<string, CallSite[]>();
      for (const c of calls) if (c.target?.hasBody && !helpers.has(c.target.key)) helpers.set(c.target.key, await adapter.getOutgoingCalls(c.target));
      bodies.set(key, (b = { calls, off: offPathOperands(calls, exits, (c) => onlyBuildsFailure(helpers.get(c.target!.key) ?? [])) }));
    }
    return b;
  };
  const t0 = Date.now();
  let total = 0;
  let hidden = 0;
  for (const e of eps) {
    await s.openMethodByKey(e.method.key, e);
    await (process.env.SMART ? s.smartExpand() : s.expandEverything());
    const d = s.current()!;
    const byId = new Map(d.messages.map((m) => [m.id, m]));
    const cause = new Map<string, string | null>([['root', null]]);
    const causeOf = async (id: string): Promise<string | null> => {
      if (cause.has(id)) return cause.get(id)!;
      const m = byId.get(id)!;
      const parent = byId.get(m.parentId!)!;
      let why = await causeOf(parent.id);
      const key = parent.selectedKey ?? parent.methodKey;
      if (!why && key) {
        const b = await body(key);
        const site = b.calls.find((c) => c.ordinal === Number(/\/(\d+):[^/]*$/.exec(id)?.[1]));
        const r = offPathReason(site?.fragments, b.off);
        if (r) why = `${r.slice(0, 60)}  ${site!.range.file.split('/').pop()}:${site!.range.start.line + 1}`;
      }
      cause.set(id, why);
      return why;
    };
    const counts = new Map<string, number>();
    let n = 0;
    for (const m of d.messages) {
      if (!m.parentId) continue;
      n++;
      const why = await causeOf(m.id);
      if (why) counts.set(why, (counts.get(why) ?? 0) + 1);
    }
    const off = [...counts.values()].reduce((a, b) => a + b, 0);
    total += n;
    hidden += off;
    console.log(`${String(n).padStart(5)} msgs  error paths ${String(n ? Math.round((100 * off) / n) : 0).padStart(3)}%   ${e.label}`);
    for (const [why, k] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`        ${k} ← ${why}`);
  }
  console.log(`\n${lang}: ${eps.length} flows in ${Math.round((Date.now() - t0) / 1000)} s, ${total} msgs, ${total ? ((100 * hidden) / total).toFixed(1) : 0}% on error paths`);
  const reasons = [...bodies.values()].flatMap((b) => [...b.off.values()]);
  console.log(`\nOff-path branches of the ${bodies.size} bodies reached: ${reasons.length}; a sample:`);
  const step = Math.max(1, Math.floor(reasons.length / Number(samples)));
  for (let i = 0; i < reasons.length; i += step) console.log(`  ${reasons[i].slice(0, 120)}`);
  await adapter.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
