/**
 * FR-22 paths to here on any project: the reverse tree of a method's callers up to the entry points,
 * with timing (entry-point scan, walk).
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/paths-probe.ts --outfile=/tmp/seqcall-paths.cjs
 *   node /tmp/seqcall-paths.cjs <projectRoot> <relFile> <line 0-based>
 *
 * C#: set SEQCALL_CSHARP_SIDECAR as for probe.ts.
 */
import { readdirSync } from 'node:fs';
import type { CallPathNode } from '@seqcall/protocol';
import { createClassifier, createCSharpAdapter, createPhpAdapter, createTsAdapter, DiagramSession } from '../../core/src/index';

const [root, file, line] = process.argv.slice(2);
if (!root || !file || line === undefined) {
  console.error('usage: paths-probe <projectRoot> <relFile> <line0>');
  process.exit(2);
}
const isCs = readdirSync(root).some((f) => /\.slnx?$/.test(f));
const isPhp = !isCs && readdirSync(root).includes('composer.json');
const adapter = isCs ? createCSharpAdapter(root, { log: (l) => process.env.DBG && console.error('[C#]', l) }) : isPhp ? createPhpAdapter(root) : createTsAdapter(root);

const name = (n: CallPathNode) => (n.method.owner.kind === 'module' ? n.method.name : `${n.method.owner.name}.${n.method.name}`);
function print(n: CallPathNode, depth = 0): void {
  const ep = n.entryPoints?.[0];
  const tags = [ep ? `[${ep.kind} ${ep.label}]` : '', n.call?.passed ? 'passed' : '', n.call?.count ? `x${n.call.count}` : '', n.inTest ? 'test' : '', n.end && depth ? `<${n.end}>` : ''].filter(Boolean).join(' ');
  console.log(`${'  '.repeat(depth)}${depth ? '← ' : ''}${name(n)} ${tags}`);
  for (const c of n.callers ?? []) print(c, depth + 1);
}

(async () => {
  const t0 = Date.now();
  const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
  const d = await s.openAt(`${root}/${file}`, { line: Number(line), character: 0 });
  if (!d) throw new Error('no method there');
  console.log(`opened ${d.root.key} in ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const eps = await s.getEntryPoints();
  console.log(`entry points: ${eps.length} in ${Date.now() - t1} ms`);
  const t2 = Date.now();
  const r = await s.findPathsToHere('root');
  if (!r) throw new Error('no result');
  console.log(`walk: ${r.methods} methods in ${Date.now() - t2} ms, truncated=${r.truncated}`);
  print(r.tree);
  await adapter.dispose?.();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
