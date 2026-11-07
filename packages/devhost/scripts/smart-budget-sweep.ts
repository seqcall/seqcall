/**
 * FR-3.6 how often the budget, not the importance threshold, stops Smart expand: runs Smart on every entry point
 * with the configured budget and with an unlimited one, and prints both sizes.
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/smart-budget-sweep.ts --outfile=/tmp/seqcall-smart.cjs
 *   node /tmp/seqcall-smart.cjs <projectRoot> [maxEntryPoints=60] [budgets=25,100000]
 * C#: set SEQCALL_CSHARP_SIDECAR (see probe.ts).
 */
import { readdirSync } from 'node:fs';
import { createAdapter, createClassifier, DiagramSession } from '../../core/src/index';

const [root, maxEps = '60', budgets = '25,100000'] = process.argv.slice(2);
const files = readdirSync(root);
const lang = files.some((f) => /\.slnx?$/.test(f)) ? 'csharp' : files.includes('composer.json') ? 'php' : 'typescript';

function withBudget(budget: number) {
  const c = createClassifier(root);
  const own = c.smartExpandConfig?.bind(c);
  return Object.assign(c, { smartExpandConfig: () => ({ ...(own?.() ?? {}), budget }) });
}

(async () => {
  const adapter = createAdapter(lang, root);
  const runs = budgets.split(',').map(Number).map((b) => new DiagramSession({ adapter, classifier: withBudget(b) }));
  const eps = (await runs[0].getEntryPoints()).filter((e) => e.kind !== 'test').slice(0, Number(maxEps));
  const sizes: number[][] = [];
  let capped = 0;
  for (const e of eps) {
    const row: number[] = [];
    for (const s of runs) {
      await s.openMethodByKey(e.method.key, e);
      const d = await s.smartExpand();
      row.push(d?.messages.length ?? 0);
      if (d?.expandNotice) capped++;
    }
    sizes.push(row);
    console.log(`${row.map((n) => String(n).padStart(6)).join('')}   ${e.label}`);
  }
  const sorted = sizes.map((r) => r.at(-1)!).sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  console.log(`\n${lang}: ${eps.length} flows; cap notices ${capped} (all runs); last run's sizes: median ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)}, max ${sorted.at(-1)}`);
  await adapter.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
