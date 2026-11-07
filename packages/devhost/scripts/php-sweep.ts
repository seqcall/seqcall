/**
 * FR-18 resolution sweep: analyses every method of a PHP project (tests excluded) and reports how
 * many calls resolve to project methods, to libraries, or not at all, plus crashes and the most
 * frequent unresolved calls — the quality measure of the PHP adapter on a real codebase.
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/php-sweep.ts --outfile=/tmp/seqcall-php-sweep.cjs
 *   node /tmp/seqcall-php-sweep.cjs <projectRoot>
 */
import { createPhpAdapter } from '../../core/src/index';
import { PhpModel } from '../../core/src/php/model';
import { PhpProject } from '../../core/src/php/project';

const root = process.argv[2];
if (!root) {
  console.error('usage: php-sweep <projectRoot>');
  process.exit(2);
}

(async () => {
  const adapter = createPhpAdapter(root);
  const model = new PhpModel(new PhpProject(root));
  let methods = 0, calls = 0, project = 0, library = 0, creates = 0, unresolved = 0, crashes = 0;
  const samples = new Map<string, number>();
  const t0 = Date.now();
  for (const c of model.allCallables()) {
    if (/^tests?\//.test(c.file.rel)) continue;
    const ref = model.refOfCallable(c);
    methods++;
    try {
      for (const s of await adapter.getOutgoingCalls(ref)) {
        calls++;
        if (s.isLibrary) library++;
        else if (s.target) project++;
        else if (s.kind === 'create' && s.receiverType) creates++; // a project class without its own constructor
        else {
          unresolved++;
          const open = s.expressionText.indexOf('(');
          const k = (open < 0 ? s.expressionText : `${s.expressionText.slice(0, open)}(…)`).slice(0, 70);
          samples.set(k, (samples.get(k) ?? 0) + 1);
        }
      }
      await adapter.getEarlyExits!(ref);
      if (!ref.hasBody) await adapter.getImplementations(ref);
    } catch (e) {
      crashes++;
      if (crashes < 4) console.log('CRASH', ref.key, (e as Error).stack?.split('\n').slice(0, 3).join(' | '));
    }
  }
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(calls, 1))}%`;
  console.log(`${methods} methods, ${calls} calls: project ${project} (${pct(project)}), library ${library} (${pct(library)}), creations without own constructor ${creates} (${pct(creates)}), unresolved ${unresolved} (${pct(unresolved)}), crashes ${crashes}, ${Date.now() - t0} ms`);
  console.log(`top unresolved:\n  ${[...samples].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${v}× ${k}`).join('\n  ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
