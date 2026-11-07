/**
 * FR-31 unreachable-code probe: runs the project-wide scan and prints its size, time and lists — the methods no
 * entry point reaches (by reason, framework-called apart) and the `missed` ones (a reached method refers to them but
 * the walk did not follow the reference: where the walk needs fixing).
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/unreachable-probe.ts --outfile=/tmp/seqcall-unreachable.cjs
 *   node /tmp/seqcall-unreachable.cjs <projectRoot> [maxListed=40]
 * C#: set SEQCALL_CSHARP_SIDECAR (see probe.ts).
 */
import { readdirSync } from 'node:fs';
import type { MethodRef } from '@seqcall/protocol';
import { createAdapter, createClassifier, DiagramSession } from '../../core/src/index';

const [root, maxListed = '40'] = process.argv.slice(2);
if (!root) {
  console.error('usage: unreachable-probe <projectRoot> [maxListed]');
  process.exit(2);
}
const files = readdirSync(root);
const lang = files.some((f) => /\.slnx?$/.test(f)) ? 'csharp' : files.includes('composer.json') ? 'php' : 'typescript';
const where = (m: MethodRef) => `${m.declaration ? `${m.declaration.file.slice(root.length + 1)}:${m.declaration.start.line + 1}` : m.key}`;

(async () => {
  const adapter = createAdapter(lang, root);
  const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
  const t0 = Date.now();
  await s.getEntryPoints();
  const t1 = Date.now();
  let checkStart = 0;
  let shown = 0;
  const r = (await s.findUnreachableCode({
    onProgress: (phase, done, total) => {
      if (phase === 'check' && !checkStart) checkStart = Date.now();
      if (Date.now() - shown < 5000) return;
      shown = Date.now();
      console.error(`  ${phase} ${done}${total ? ` / ${total}` : ''}  (${Math.round((Date.now() - t1) / 1000)} s)`);
    },
  }))!;
  const t2 = Date.now();
  console.log(`maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  console.log(`${lang}: ${r.entryPoints} entry points (${t1 - t0} ms); ${r.total} methods, ${r.reached} reached (walk ${(checkStart || t2) - t1} ms), ${r.methods.length} listed, ${r.missed} missed${r.ignored ? `, ${r.ignored} ignored by config` : ''} (callers check ${checkStart ? t2 - checkStart : 0} ms)${r.truncated ? ', TRUNCATED' : ''}`);
  const groups = new Map<string, typeof r.methods>();
  for (const u of r.methods) {
    const g = u.framework ? 'framework?' : u.unresolved ? 'maybe called (unresolved calls of the name)' : u.reason;
    groups.set(g, [...(groups.get(g) ?? []), u]);
  }
  for (const [g, list] of groups) {
    console.log(`\n== ${g}: ${list.length}`);
    for (const u of list.slice(0, Number(maxListed))) console.log(`  ${u.method.owner.name}.${u.method.name}  ${where(u.method)}${u.framework ? `  [${u.framework}]` : ''}${u.unresolved ? `  [${u.unresolved} unresolved${u.via ? ` via ${u.via}` : ''}]` : ''}${u.callers ? `  (${u.callers} refs)` : ''}`);
  }
  console.log(`\n== missed: ${r.missed}`);
  for (const m of r.missedMethods.slice(0, Number(maxListed))) console.log(`  ${m.owner.name}.${m.name}  ${where(m)}`);
  await s.dispose();
  await adapter.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
