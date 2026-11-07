/**
 * Robustness sweep for the class-diagram layout (dagre path): opens every exported function /
 * arrow const in `src/` of a TypeScript project, expands up to 3 rounds, chooses
 * implementations, and lays the class diagram out with varied text widths in TB, LR and lanes.
 * Prints failures (and writes the first failing class diagram as JSON for a regression test).
 *
 *   npx esbuild --bundle --platform=node --format=cjs --log-level=error \
 *     packages/devhost/scripts/layout-stress.ts --outfile=/tmp/seqcall-stress.cjs
 *   node /tmp/seqcall-stress.cjs <tsProjectRoot> [failing-class.json]   (default: in a new temp directory)
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassifier, createTsAdapter, DiagramSession } from '../../core/src/index';
import { layoutClassDiagram } from '../../webview/src/class/layout';
import { estimateTextWidth } from '../../webview/src/measure';

// not a fixed name in the shared temp directory: another user could have put a symlink there
const [root, failOut = join(mkdtempSync(join(tmpdir(), 'seqcall-stress-')), 'failing-class.json')] = process.argv.slice(2);
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules') walk(p);
    } else if (/\.tsx?$/.test(f) && !/\.spec\.|\.test\.|\.d\.ts/.test(f)) files.push(p);
  }
};
walk(join(root, 'src'));
const adapter = createTsAdapter(root);
const session = new DiagramSession({ adapter, classifier: createClassifier(root) });

(async () => {
  let tried = 0;
  let failed = 0;
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*(export\s+)?(async\s+)?function\s|^\s*(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(lines[i])) continue;
      if (!(await session.openAt(f, { line: i + 1, character: 2 }))) continue;
      for (let k = 0; k < 3; k++) {
        let d = (await session.expandAll())!;
        for (const m of d.messages) {
          if (m.polymorphic && !m.polymorphic.selectedKey && m.polymorphic.implementations.length) {
            d = (await session.selectImplementation(m.id, m.polymorphic.implementations[(i + k) % m.polymorphic.implementations.length].key)) ?? d;
          }
        }
        const cd = (await session.getClassDiagram())!;
        tried++;
        try {
          for (const factor of [0.7, 1, 1.3]) {
            const measure = (t: string, st: Parameters<typeof estimateTextWidth>[1]) => Math.round(estimateTextWidth(t, st) * factor);
            layoutClassDiagram(cd, measure, {}, { viewportWidth: 1000, viewportHeight: 700 });
            layoutClassDiagram(cd, measure, {}, { direction: 'LR' });
            layoutClassDiagram(cd, measure, {}, { lanes: true });
          }
        } catch (e) {
          if (!failed++) {
            writeFileSync(failOut, JSON.stringify(cd));
            console.log('first failing class diagram:', failOut);
          }
          console.log('FAIL', f.slice(root.length), i + 1, String(e).slice(0, 100));
        }
      }
    }
  }
  console.log({ tried, failed });
  await adapter.dispose();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
