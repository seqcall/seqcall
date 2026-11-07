/**
 * FR-19 findings sweep: opens the project's entry points (tests excluded), expands each flow fully,
 * runs the I/O scan and collects the distinct design findings of the sequence and class diagrams —
 * to judge the rules on a real codebase (true / false positives, noise).
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/findings-sweep.ts --outfile=/tmp/seqcall-findings.cjs
 *   node /tmp/seqcall-findings.cjs <projectRoot> [maxEntryPoints=40]
 * C#: set SEQCALL_CSHARP_SIDECAR (see probe.ts).
 */
import { readdirSync } from 'node:fs';
import { createAdapter, createClassifier, DiagramSession } from '../../core/src/index';

const [root, maxEps = '40'] = process.argv.slice(2);
if (!root) {
  console.error('usage: findings-sweep <projectRoot> [maxEntryPoints]');
  process.exit(2);
}
const files = readdirSync(root);
const lang = files.some((f) => /\.slnx?$/.test(f)) ? 'csharp' : files.includes('composer.json') ? 'php' : 'typescript';

(async () => {
  const adapter = createAdapter(lang, root);
  const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
  const eps = (await s.getEntryPoints()).filter((e) => e.kind !== 'test').slice(0, Number(maxEps));
  const seen = new Map<string, { kind: string; title: string; root: string }>();
  const t0 = Date.now();
  for (const e of eps) {
    try {
      await s.openMethodByKey(e.method.key, e);
      await s.expandEverything();
      await s.scanSideEffects();
      const d = s.current()!;
      const cd = await s.getClassDiagram();
      for (const f of [...(d.findings ?? []), ...(cd?.findings ?? [])]) if (!seen.has(f.id)) seen.set(f.id, { kind: f.kind, title: f.title, root: e.label });
    } catch (err) {
      console.log('ERR', e.label, (err as Error).message.slice(0, 80));
    }
  }
  const by = new Map<string, number>();
  for (const f of seen.values()) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  console.log(`${eps.length} entry points in ${Math.round((Date.now() - t0) / 1000)} s; distinct findings: ${[...by].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  for (const f of seen.values()) console.log(`  ${f.title.slice(0, 120)}   ← ${f.root}`);
  await adapter.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
