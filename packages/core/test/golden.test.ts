import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier, createCSharpAdapter, createPhpAdapter, createTsAdapter, DEFAULT_OPTIONS, DiagramSession, resolveCSharpSidecar, type LanguageAdapter } from '../src/index';
import { classText, sequenceText } from './golden-format';

/**
 * Golden diagrams: every entry point of each fixture as opened from ⌂, after ✦ Overview and after Expand all, and the
 * class diagram of the whole flow — compared with `golden/<fixture>.txt`. A change of any diagram shows as a diff of
 * that file: review it, and when the new diagram is the intended one, accept it with
 * `npx vitest run packages/core/test/golden.test.ts -u` (commit the file with the change).
 */
const FIXTURES = path.resolve(__dirname, '../../../fixtures').replace(/\\/g, '/');

const dll = resolveCSharpSidecar();
const csharp = (() => {
  try {
    execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    return fs.existsSync(dll) && fs.existsSync(`${FIXTURES}/sample-cs/src/Sample.Batch/obj/project.assets.json`);
  } catch {
    return false;
  }
})();

// besides the entry points (sample-app and io-app have few), the flows the other tests are about
const SAMPLE = [
  'src/controllers/user-controller.ts#UserController.getUser',
  'src/controllers/user-controller.ts#UserController.renameUser',
  'src/controllers/admin-controller.ts#AdminController.audit',
  'src/services/import-service.ts#ImportService.importAll',
  'src/services/import-service.ts#ImportService.sync',
  'src/services/sync-service.ts#SyncService.syncAll',
  'src/services/export-service.ts#ExportService.exportUser',
  'src/services/shipping-service.ts#ShippingService.ship',
  'src/legacy/report.js#ReportGenerator.generate',
  'src/main.ts#<module>.bootstrap',
];
const IO = [
  'src/controllers/note-controller.ts#NoteController.show',
  'src/controllers/note-controller.ts#NoteController.share',
  'src/controllers/note-controller.ts#NoteController.archive',
  'src/services/alerter.ts#Alerter.escalate',
];

const cases: { fixture: string; adapter: (root: string) => LanguageAdapter; methods?: string[]; skip?: boolean }[] = [
  { fixture: 'sample-app', adapter: createTsAdapter, methods: SAMPLE },
  { fixture: 'io-app', adapter: createTsAdapter, methods: IO },
  { fixture: 'php-app', adapter: createPhpAdapter },
  // needs the built sidecar and a restored fixture (the C# end-to-end tests restore it)
  { fixture: 'sample-cs', adapter: (root) => createCSharpAdapter(root, { sidecarPath: dll }), skip: !csharp },
];

describe('golden diagrams of the fixtures', () => {
  const adapters: LanguageAdapter[] = [];
  afterAll(async () => {
    for (const a of adapters) await a.dispose?.();
  });

  for (const c of cases) {
    it.skipIf(c.skip)(`every entry point of ${c.fixture}: opened, Overview, Expand all, class diagram`, async () => {
      const root = `${FIXTURES}/${c.fixture}`;
      const adapter = c.adapter(root);
      adapters.push(adapter);
      const s = new DiagramSession({ adapter, classifier: createClassifier(root), initialState: { options: { ...DEFAULT_OPTIONS } } });
      const out: string[] = [];
      const eps = await s.getEntryPoints();
      const flows = [...eps.map((ep) => ({ title: `${ep.kind} ${ep.label}`, key: ep.method.key, ep })), ...(c.methods ?? []).map((key) => ({ title: 'method', key, ep: undefined }))];
      expect(flows.length).toBeGreaterThan(0);
      for (const { title, key, ep } of flows) {
        out.push(`════ ${title} (${key})`);
        const opened = await s.openMethodByKey(key, ep);
        if (!opened) {
          out.push('(no diagram)', '');
          continue;
        }
        out.push('── opened', sequenceText(opened));
        out.push('── Overview', sequenceText((await s.smartExpand())!));
        out.push('── Expand all', sequenceText((await s.expandEverything())!));
        out.push('── class diagram', classText((await s.getClassDiagram())!), '');
      }
      await expect(out.join('\n')).toMatchFileSnapshot(`golden/${c.fixture}.txt`);
    }, 300_000);
  }
});
