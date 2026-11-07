/**
 * Text dump of a sequence diagram (and class-diagram summary) for any project, through the
 * real core (TypeScript in-process, C# via the sidecar when the root contains a .sln/.slnx).
 * Fastest way to check analysis on real code without a UI.
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/probe.ts --outfile=/tmp/seqcall-probe.cjs
 *   node /tmp/seqcall-probe.cjs <projectRoot> <relFile> <line 0-based> [expandAll rounds=1] [expand ids, comma-separated]
 *
 * SMART=1 runs a smart expand (FR-3.6) after the expand-all rounds and prints each message's importance.
 * The background I/O scan (FR-17.5) runs last and is timed; NOSCAN=1 skips it.
 *
 * C#: the bundle cannot locate the sidecar from /tmp — set SEQCALL_CSHARP_SIDECAR to
 * packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0/Seqcall.CSharp.dll (build it first).
 */
import { readdirSync } from 'node:fs';
import { createClassifier, createCSharpAdapter, createPhpAdapter, createTsAdapter, DiagramSession } from '../../core/src/index';

const [root, file, line, rounds = '1', expand = ''] = process.argv.slice(2);
if (!root || !file || line === undefined) {
  console.error('usage: probe <projectRoot> <relFile> <line0> [expandAllRounds] [ids]');
  process.exit(2);
}
const isCs = readdirSync(root).some((f) => /\.slnx?$/.test(f));
const isPhp = !isCs && readdirSync(root).includes('composer.json');
const adapter = isCs ? createCSharpAdapter(root, { log: (l) => process.env.DBG && console.error('[C#]', l) }) : isPhp ? createPhpAdapter(root) : createTsAdapter(root);

(async () => {
  const t0 = Date.now();
  const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
  let d = await s.openAt(`${root}/${file}`, { line: Number(line), character: 12 });
  if (!d) throw new Error('no method at that position');
  console.log(`open: ${Date.now() - t0} ms  root: ${d.root.key}`);
  for (let i = 0; i < Number(rounds); i++) d = (await s.expandAll()) ?? d;
  for (const id of expand.split(',').filter(Boolean)) d = (await s.expand(id)) ?? d;
  if (process.env.SMART) {
    const t1 = Date.now();
    d = (await s.smartExpand()) ?? d;
    console.log(`smart expand: ${Date.now() - t1} ms, ${d.messages.length} messages`);
  }
  if (!process.env.NOSCAN) {
    const t2 = Date.now();
    const scanned = await s.scanSideEffects();
    console.log(`I/O scan (FR-17.5): ${Date.now() - t2} ms, ${scanned ? 'badges changed' : 'no change'}`);
    d = scanned ?? d;
  }
  console.log('\nparticipants (label · layer · stereotypes · hint):');
  for (const p of d.participants) {
    console.log(`  ${p.label.padEnd(34)} ${String(p.layer ?? '-').padEnd(15)} «${p.stereotypes.join(',')}»${p.sideEffects ? `  [${p.sideEffects.evidence.join('; ')}]` : ''}${p.layerHint ? `  ⚑ ${p.layerHint.suggested}: ${p.layerHint.reasons.join('; ')}` : ''}`);
  }
  console.log('\nmessages (id · kind · call):');
  for (const m of d.messages) {
    const extra = [m.isAsync && 'async', m.expandable && '[+]', m.polymorphic && `impl: ${m.polymorphic.implementations.map((i) => i.name).join('/')}${m.polymorphic.selectedKey ? ' (chosen)' : ''}`].filter(Boolean).join(' ');
    const io = m.sideEffects ? `  [${m.sideEffects.kinds.join(',')}${m.sideEffects.below ? ' below' : ''}: ${m.sideEffects.evidence.join('; ')}]` : '';
    const imp = m.importance ? `  ${m.importance.low ? '(dim) ' : ''}${m.importance.score}: ${m.importance.reasons.join('; ')}` : '';
    console.log(`  ${'  '.repeat(m.depth)}${m.id.padEnd(40 - 2 * m.depth)} ${m.kind.padEnd(6)} ${m.result ? (m.result.kind === 'return' ? '↩ ' : `${m.result.target} ${m.result.operator} `) : ''}${m.methodName}(${m.args.join(', ').slice(0, 40)})${m.returnType ? `: ${m.returnType}` : ''} ${extra}${m.expanded ? ' ▾' : ''}${io}${imp}`);
  }
  for (const x of d.exits ?? []) console.log(`  exit ${x.id} ${x.kind === 'return' ? '↩' : '↯'}${x.guard ? ` [${x.guard}]` : ''}${x.exception ? ` ${x.exception}` : ''} before ${x.beforeId ?? '(end)'}  line ${x.range.start.line + 1}`);
  for (const f of d.fragments ?? []) console.log(`  frame ${f.id} ${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}] ${o.firstMessageId}..${o.lastMessageId}`).join(' | ')}`);
  for (const f of d.findings ?? []) console.log(`  ⚠ ${f.title}  [${(f.messageIds ?? []).slice(0, 4).join(', ')}]`);
  const cd = await s.getClassDiagram();
  for (const f of cd?.findings ?? []) console.log(`  ⚠ class: ${f.title}`);
  console.log(`\nclass diagram: ${cd?.classes.length} classes, ${cd?.relations.length} relations, layers ${cd?.layers?.join(' > ')}, violations ${cd?.relations.filter((r) => r.violation).length}`);
  for (const r of cd?.relations.filter((x) => x.violation) ?? []) console.log(`  ⚠ ${r.from.split('#')[1]} → ${r.to.split('#')[1]}: ${r.violation}`);
  await adapter.dispose();
})().catch(async (e) => {
  console.error(e);
  await adapter.dispose();
  process.exit(1);
});
