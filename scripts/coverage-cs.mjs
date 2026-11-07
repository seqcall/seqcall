// Coverage of the C# sidecar (docs/TESTING.md §11): runs the xUnit tests with the coverlet collector and writes
//   coverage/csharp/coverage.cobertura.xml   for tools / ReportGenerator
//   coverage/csharp/coverage.opencover.xml   read by the SonarScanner for .NET (.github/workflows/sonar.yml)
// and prints the line / branch summary. Env: DOTNET_ROOT.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(repo, 'coverage', 'csharp');

/** The floor of the C# sidecar's coverage (%): a change that drops below it fails `npm run coverage:cs`. */
export const THRESHOLDS = { lines: 89, branches: 78 };

/** What is below `thresholds` in a summary (`coberturaSummary`), one line each (empty: all met). */
export function belowThresholds(summary, thresholds = THRESHOLDS) {
  return Object.entries(thresholds)
    .filter(([key, min]) => summary[key].rate * 100 < min)
    .map(([key, min]) => `${key} ${(summary[key].rate * 100).toFixed(2)} % < ${min} %`);
}

/** Line / branch rates (0..1) and counts from the root element of a Cobertura report. */
export function coberturaSummary(xml) {
  const root = /<coverage\b([^>]*)>/.exec(xml)?.[1];
  if (!root) throw new Error('not a Cobertura report');
  const attr = (name) => Number(new RegExp(`\\b${name}="([^"]*)"`).exec(root)?.[1] ?? Number.NaN);
  return {
    lines: { rate: attr('line-rate'), covered: attr('lines-covered'), valid: attr('lines-valid') },
    branches: { rate: attr('branch-rate'), covered: attr('branches-covered'), valid: attr('branches-valid') },
  };
}

/** The report files below `dir` (one GUID folder per run), newest first. */
export function findReports(dir, name) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) found.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function dotnetPath() {
  for (const dir of [process.env.DOTNET_ROOT, join(homedir(), '.dotnet')]) if (dir && existsSync(join(dir, 'dotnet'))) return join(dir, 'dotnet');
  return 'dotnet';
}

function main() {
  const dotnet = dotnetPath();
  const env = { ...process.env, PATH: [dirname(dotnet), process.env.PATH].join(':') };
  if (dotnet !== 'dotnet') env.DOTNET_ROOT = dirname(dotnet);
  const raw = join(OUT, 'raw');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const test = spawnSync(
    dotnet,
    [
      'test', 'tests/Seqcall.CSharp.Tests/Seqcall.CSharp.Tests.csproj', '-nodeReuse:false',
      '--collect', 'XPlat Code Coverage', '--results-directory', raw,
      '--',
      'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=cobertura,opencover',
      'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Include=[Seqcall.CSharp]*',
      // code the compiler generates (the [GeneratedRegex] source generator, obj/): not ours to test; the start-up
      // file runs in the end-to-end test's child process, where nothing is collected (as the TS bundles' main.ts)
      'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.ExcludeByFile=**/obj/**,**/Seqcall.CSharp/Program.cs',
    ],
    { cwd: join(repo, 'packages', 'csharp'), stdio: 'inherit', env },
  );
  spawnSync(dotnet, ['build-server', 'shutdown'], { stdio: 'ignore', env });
  const [cobertura] = findReports(raw, 'coverage.cobertura.xml');
  const [opencover] = findReports(raw, 'coverage.opencover.xml');
  if (!cobertura || !opencover) {
    console.error('[coverage:cs] no coverage report written');
    process.exit(1);
  }
  copyFileSync(cobertura, join(OUT, 'coverage.cobertura.xml'));
  copyFileSync(opencover, join(OUT, 'coverage.opencover.xml'));
  rmSync(raw, { recursive: true, force: true });
  const summary = coberturaSummary(readFileSync(join(OUT, 'coverage.cobertura.xml'), 'utf8'));
  const { lines, branches } = summary;
  const pct = (r) => `${(r.rate * 100).toFixed(2)}% ( ${r.covered}/${r.valid} )`;
  console.log(`[coverage:cs] Lines    : ${pct(lines)}\n[coverage:cs] Branches : ${pct(branches)}\n[coverage:cs] ${OUT}`);
  if (test.status !== 0) process.exit(test.status ?? 1);
  const below = belowThresholds(summary);
  if (below.length) {
    console.error(`[coverage:cs] below the thresholds: ${below.join(', ')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
