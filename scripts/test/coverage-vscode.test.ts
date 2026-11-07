import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { belowThresholds, remap, scriptCoverages } from '../coverage-vscode.mjs';

describe('VS Code host coverage (scripts/coverage-vscode.mjs)', () => {
  it('maps V8 coverage of a bundle back to its own sources only, with the lines that never ran', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-v8cov-')));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'helper.ts'), 'export function twice(n: number): number {\n  return n * 2;\n}\n');
      fs.writeFileSync(
        path.join(dir, 'src', 'main.ts'),
        [
          "import { twice } from '../lib/helper';",
          'export function used(n: number): number {',
          '  return twice(n);',
          '}',
          'export function unused(n: number): number {',
          '  const m = n + 1;',
          '  return m * 3;',
          '}',
          'console.log(used(2));',
          '',
        ].join('\n'),
      );
      const bundle = path.join(dir, 'dist', 'main.js');
      await esbuild.build({ entryPoints: [path.join(dir, 'src', 'main.ts')], bundle: true, platform: 'node', format: 'cjs', sourcemap: true, outfile: bundle, logLevel: 'silent' });
      const raw = path.join(dir, 'raw');
      execFileSync(process.execPath, [bundle], { env: { ...process.env, NODE_V8_COVERAGE: raw } });

      const coverages = scriptCoverages(raw, bundle);
      expect(coverages).toHaveLength(1);
      const map = await remap(bundle, coverages, path.join(dir, 'src') + path.sep);
      expect(map.files()).toEqual([path.join(dir, 'src', 'main.ts')]);
      const lines = map.fileCoverageFor(path.join(dir, 'src', 'main.ts')).getLineCoverage();
      expect(lines[3]).toBeGreaterThan(0); // return twice(n)
      expect(lines[6]).toBe(0); // const m = n + 1 (unused)
      expect(lines[7]).toBe(0);
      // 5 of 9 lines ran: below 60 % fails, branches are met (none)
      expect(belowThresholds(map, { lines: 60, branches: 50 })).toEqual(['lines 55.55 % < 60 %']);
      expect(belowThresholds(map, { lines: 50, branches: 50 })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
