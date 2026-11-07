// Coverage of the VS Code host (docs/TESTING.md §11): runs the extension-host tests (`npm run test:ext`) with
// NODE_V8_COVERAGE set, then maps the V8 coverage of dist/extension.js back to packages/vscode/src through its
// source map. Reports in coverage/vscode/ (index.html, lcov.info) and a summary in the terminal.
// (not c8: its --exclude-after-remap, like v8-to-istanbul's excludePath below, reports every line as covered.)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import v8ToIstanbul from 'v8-to-istanbul';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const vscode = join(repo, 'packages', 'vscode');
const bundle = join(vscode, 'dist', 'extension.js');
const sources = join(vscode, 'src') + sep;
const suites = join(vscode, 'dist', 'test', 'suite');
const OUT = join(repo, 'coverage', 'vscode');

/** The floor of the VS Code host's coverage (%): a change that drops below it fails `npm run coverage:vscode`. */
export const THRESHOLDS = { lines: 87, branches: 77 };

/** What is below `thresholds` in the coverage `map`, one line each (empty: all met). */
export function belowThresholds(map, thresholds = THRESHOLDS) {
  const summary = map.getCoverageSummary();
  return Object.entries(thresholds)
    .filter(([key, min]) => summary[key].pct < min)
    .map(([key, min]) => `${key} ${summary[key].pct} % < ${min} %`);
}

/** The V8 script coverages of `script` in the NODE_V8_COVERAGE files of `dir`. */
export function scriptCoverages(dir, script) {
  const found = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    for (const s of JSON.parse(readFileSync(join(dir, f), 'utf8')).result ?? []) {
      if (s.url.startsWith('file:') && fileURLToPath(s.url) === script) found.push(s.functions);
    }
  }
  return found;
}

/** Istanbul coverage of the sources under `keep` from V8 coverages of the bundle `script` (with its .map). */
export async function remap(script, coverages, keep) {
  const map = libCoverage.createCoverageMap({});
  for (const functions of coverages) {
    // no excludePath: with one, v8-to-istanbul counts every line of the kept sources as covered
    const converter = v8ToIstanbul(script);
    await converter.load();
    converter.applyCoverage(functions);
    map.merge(converter.toIstanbul());
    converter.destroy();
  }
  map.filter((file) => file.startsWith(keep));
  return map;
}

async function main() {
  const raw = join(OUT, 'raw');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  execFileSync(process.execPath, ['build.mjs', '--test'], { cwd: vscode, stdio: 'inherit' });
  const test = spawnSync(process.execPath, ['dist/test/runTest.js'], { cwd: vscode, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: raw } });
  const coverages = existsSync(raw) ? scriptCoverages(raw, bundle) : [];
  if (!coverages.length) {
    console.error(`[coverage:vscode] no V8 coverage of ${relative(repo, bundle)} in ${relative(repo, raw)}`);
    process.exit(1);
  }
  const map = await remap(bundle, coverages, sources);
  // a test that imports a source file directly (a pure helper) runs the copy bundled into its own test file
  for (const f of readdirSync(suites).filter((n) => n.endsWith('.test.js'))) {
    const script = join(suites, f);
    map.merge(await remap(script, scriptCoverages(raw, script), sources));
  }
  rmSync(raw, { recursive: true, force: true });
  const context = libReport.createContext({ dir: OUT, coverageMap: map, defaultSummarizer: 'nested' });
  for (const r of ['text', 'html', 'lcovonly']) reports.create(r).execute(context);
  console.log(`[coverage:vscode] ${OUT}`);
  if (test.status !== 0) process.exit(test.status ?? 1);
  const below = belowThresholds(map);
  if (below.length) {
    console.error(`[coverage:vscode] below the thresholds: ${below.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
