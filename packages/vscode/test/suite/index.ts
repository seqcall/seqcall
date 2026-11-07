import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

/** Entry point loaded by VS Code via --extensionTestsPath. */
export async function run(): Promise<void> {
  // mocha 12 is ESM; load it dynamically so this CJS bundle does not depend on require(esm).
  const mod: any = await import('mocha');
  const Mocha = mod.default ?? mod;
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  // in name order: extension.test.js first, the later files reuse its activated extension
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (f.endsWith('.test.js')) mocha.addFile(path.join(__dirname, f));
  }
  await mocha.loadFilesAsync();
  try {
    await new Promise<void>((resolve, reject) => {
      mocha.run((failures: number) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
    });
  } finally {
    // coverage run (scripts/coverage-vscode.mjs): write it now, VS Code may end the extension host without a clean
    // exit. Then stop: a second write at exit (counters reset, the whole script counted once) would mark every line
    // as covered when the two are merged.
    if (process.env.NODE_V8_COVERAGE) {
      v8.takeCoverage();
      v8.stopCoverage();
    }
  }
}
