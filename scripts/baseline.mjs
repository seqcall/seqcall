// Quality baseline on the developer's own real repositories (docs/TESTING.md §8a). The repositories are the ones
// listed in smoke-tests-repos.md (local, not in git); the numbers stay local too (.baseline/, not in git), so each
// developer compares Seqcall with its own earlier run on the same code:
//   npm run baseline                       first run: pins each repository at its HEAD and measures it;
//                                          later runs: measure the same commit again and compare (exit 1 on a regression)
//   npm run baseline -- --update [label]   moves the pin to the repository's current HEAD and measures it with the last
//                                          release (v*), so the next runs compare against the release on the new code
// Options: --only <label>, --max <entry points, 40>, --list <file>, --dir <baseline folder>.
// The repositories are never written: `git archive <commit>` (or a copy of a folder that is no git repository) into a
// temporary folder, where C# solutions are restored. Library calls of a TS copy have no node_modules: both runs see
// the same copy, so the comparison holds.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '.seqcall.json';
const SIDECAR = 'packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0/Seqcall.CSharp.dll';

/** A drop of the resolved share of calls above this (percentage points) is a regression. */
export const MAX_RESOLVED_DROP = 1;

/** The repositories of a smoke-tests-repos.md: the backticked absolute paths of its list items; `missing`: not a folder. */
export function parseRepoList(md, isDir = (p) => existsSync(p) && statSync(p).isDirectory()) {
  const paths = [];
  const missing = [];
  for (const line of md.split('\n')) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    for (const [, p] of line.matchAll(/`(\/[^`\s]+)`/g)) {
      let clean = p;
      while (clean.endsWith('/')) clean = clean.slice(0, -1);
      if (paths.includes(clean) || missing.includes(clean)) continue;
      (isDir(clean) ? paths : missing).push(clean);
    }
  }
  return { paths, missing };
}

/** A short, unique, file-safe name per path: the folder name, with its parent's when two share it. */
export function labels(paths) {
  const base = (p) => basename(p);
  const two = (p) => `${basename(dirname(p))}-${basename(p)}`;
  return paths.map((p) => (paths.filter((q) => base(q) === base(p)).length > 1 ? two(p) : base(p)).replace(/[^\w.-]/g, '_'));
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The commit a folder is at (the repository's HEAD, the folder's path inside it), or undefined outside git. */
export function pinOf(path) {
  try {
    return { commit: git(path, 'rev-parse', 'HEAD'), prefix: git(path, 'rev-parse', '--show-prefix') };
  } catch {
    return undefined;
  }
}

/**
 * The project as it was at `pin` in a new temporary folder (the repository is only read): `git archive`, or without a
 * pin a copy of the folder without dependencies, build output and .git. `config`: the layer config to put there.
 */
export function copyAt(path, pin, config) {
  const dest = mkdtempSync(join(tmpdir(), 'seqcall-baseline-'));
  const tar = pin
    ? // run inside the folder: only its files, rooted at it
      spawnSync('sh', ['-c', 'git -C "$1" archive "$2" . | tar -x -C "$3"', 'sh', path, pin.commit, dest])
    : spawnSync('tar', ['-c', '--exclude=./.git', '--exclude=node_modules', '--exclude=./vendor', '--exclude=bin', '--exclude=obj', '-C', path, '.'], { maxBuffer: 1 << 30 });
  if (!pin && tar.status === 0) spawnSync('tar', ['-x', '-C', dest], { input: tar.stdout });
  if (tar.status !== 0) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(`could not copy ${path}${pin ? ` at ${pin.commit}` : ''}`);
  }
  if (config !== undefined) writeFileSync(join(dest, CONFIG), config);
  return dest;
}

/** The layer config of the working tree (also when it is not committed), or undefined. */
export function configOf(path) {
  const file = join(path, CONFIG);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

const share = (c) => {
  const all = c.project + c.library + c.unknown;
  return all ? ((c.project + c.library) / all) * 100 : 100;
};

/** What changed from `base` to `now` (two measurements): regressions fail the run, notes are for a person to judge. */
export function compare(base, now) {
  const regressions = [];
  const notes = [];
  const lost = base.entryPoints.filter((k) => !now.entryPoints.includes(k));
  const added = now.entryPoints.filter((k) => !base.entryPoints.includes(k));
  if (lost.length) regressions.push(`${lost.length} entry point(s) no longer found: ${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ' …' : ''}`);
  if (added.length) notes.push(`${added.length} new entry point(s): ${added.slice(0, 5).join(', ')}${added.length > 5 ? ' …' : ''}`);
  const sizes = [];
  for (const [key, b] of Object.entries(base.entries)) {
    const n = now.entries[key];
    if (!n) continue;
    if (n.error && !b.error) regressions.push(`fails now: ${b.label}: ${n.error}`);
    else if (b.error && !n.error) notes.push(`works now: ${b.label}`);
    else if (n.smart !== b.smart || n.unknown !== b.unknown) sizes.push(`${b.label}: ${b.smart} → ${n.smart} messages, ${b.unknown} → ${n.unknown} unknown`);
  }
  const resolution = (what, b, n) => {
    const [sb, sn] = [share(b), share(n)];
    const text = `resolved ${what} ${sb.toFixed(1)} % → ${sn.toFixed(1)} %`;
    if (sb - sn > MAX_RESOLVED_DROP) regressions.push(text);
    else if (sb !== sn) notes.push(text);
  };
  resolution('calls in the flows', base.calls, now.calls);
  if (base.allCalls && now.allCalls) {
    resolution(`calls of all ${now.allCalls.methods} methods`, base.allCalls, now.allCalls);
    if (now.allCalls.crashes > base.allCalls.crashes) regressions.push(`methods whose analysis fails: ${base.allCalls.crashes} → ${now.allCalls.crashes}`);
  }
  if (sizes.length) notes.push(`Smart flow changed in ${sizes.length} entry point(s):`, ...sizes.slice(0, 10).map((s) => `  ${s}`), ...(sizes.length > 10 ? ['  …'] : []));
  const gone = base.findings.filter((f) => !now.findings.includes(f));
  const found = now.findings.filter((f) => !base.findings.includes(f));
  if (found.length) notes.push(`${found.length} new finding(s), true or false?`, ...found.slice(0, 10).map((f) => `  + ${f}`), ...(found.length > 10 ? ['  …'] : []));
  if (gone.length) notes.push(`${gone.length} finding(s) gone:`, ...gone.slice(0, 10).map((f) => `  - ${f}`), ...(gone.length > 10 ? ['  …'] : []));
  if (now.ms > base.ms * 1.5 && now.ms - base.ms > 5000) notes.push(`slower: ${(base.ms / 1000).toFixed(1)} s → ${(now.ms / 1000).toFixed(1)} s`);
  return { regressions, notes };
}

function dotnetPath() {
  for (const dir of [process.env.DOTNET_ROOT, join(homedir(), '.dotnet')]) if (dir && existsSync(join(dir, 'dotnet'))) return join(dir, 'dotnet');
  return 'dotnet';
}

function dotnet(args, cwd) {
  const bin = dotnetPath();
  const env = { ...process.env, MSBUILDDISABLENODEREUSE: '1', ...(bin !== 'dotnet' ? { DOTNET_ROOT: dirname(bin) } : {}) };
  const r = spawnSync(bin, [...args, '-nodeReuse:false'], { cwd, stdio: 'ignore', env });
  spawnSync(bin, ['build-server', 'shutdown'], { stdio: 'ignore', env });
  return r.status === 0;
}

/** The measure script bundled against the core of `checkout` (this one or a release's worktree). */
async function bundle(checkout, out) {
  const { build } = await import('esbuild');
  const core = join(checkout, 'packages/core/src');
  await build({
    entryPoints: [join(repo, 'packages/devhost/scripts/baseline-measure.ts')],
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', outfile: out,
    nodePaths: [join(repo, 'node_modules')],
    // the measure script's `../../core/src/<module>` imports: that checkout's core
    plugins: [{ name: 'core', setup: (b) => b.onResolve({ filter: /^\.\.\/\.\.\/core\/src\// }, (a) => ({ path: join(core, `${a.path.slice('../../core/src/'.length)}.ts`) })) }],
  });
  // TypeScript's lib files beside the bundle: without them a TS project is analysed with no standard library (TESTING.md §8)
  const lib = join(repo, 'node_modules/typescript/lib');
  for (const f of readdirSync(lib)) if (/^lib.*\.d\.ts$/.test(f)) copyFileSync(join(lib, f), join(dirname(out), f));
  return { checkout, script: out };
}

/** The C# sidecar of a checkout, built when missing (only for a C# project). */
function sidecarOf(checkout) {
  const dll = join(checkout, SIDECAR);
  if (!existsSync(dll)) dotnet(['build', '-c', 'Release', 'packages/csharp/src/Seqcall.CSharp/Seqcall.CSharp.csproj'], checkout);
  return dll;
}

/** A worktree of the last release (v* tag) under the baseline folder, and its name. */
function releaseCheckout(dir) {
  const tag = git(repo, 'tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0];
  if (!tag) throw new Error('no release tag (v*) to measure with');
  const tree = join(dir, 'release', tag);
  if (!existsSync(tree)) git(repo, 'worktree', 'add', '--detach', tree, tag);
  return { tag, tree };
}

function measureIn(tool, root, max, keys, work) {
  const out = join(work, 'measurement.json');
  const args = [tool.script, root, out, String(max)];
  if (keys) {
    writeFileSync(join(work, 'keys.json'), JSON.stringify(keys));
    args.push(join(work, 'keys.json'));
  }
  const csharp = readdirSync(root).some((f) => /\.slnx?$/.test(f));
  const env = { ...process.env, ...(csharp ? { SEQCALL_CSHARP_SIDECAR: sidecarOf(tool.checkout) } : {}) };
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', ...args], { stdio: ['ignore', 'ignore', 'inherit'], env });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`the measurement failed (exit ${r.status})`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

function prepare(path, pin, config) {
  const root = copyAt(path, pin, config);
  const sln = readdirSync(root).find((f) => /\.slnx?$/.test(f));
  if (sln) dotnet(['restore', sln], root); // a copy without restored packages shows library calls as unknown
  return root;
}

export function parseArgs(argv) {
  const o = { list: join(repo, 'smoke-tests-repos.md'), dir: join(repo, '.baseline'), max: 40, update: false, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') {
      o.update = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) o.only = argv[++i];
    } else if (a === '--only') o.only = argv[++i];
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--list') o.list = resolve(argv[++i]);
    else if (a === '--dir') o.dir = resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Runs the baseline over the listed repositories; the number of repositories with a regression. */
export async function run(o, log = console.log) {
  if (!existsSync(o.list)) {
    log(`[baseline] no repository list (${o.list}): see AGENTS.md "Smoke tests on real codebases"`);
    return 0;
  }
  const { paths, missing } = parseRepoList(readFileSync(o.list, 'utf8'));
  for (const m of missing) log(`[baseline] not found, skipped: ${m}`);
  const names = labels(paths);
  if (o.only && !names.includes(o.only)) {
    log(`[baseline] no repository named ${o.only} (${names.join(', ')})`);
    return 1;
  }
  mkdirSync(o.dir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'seqcall-baseline-run-'));
  let failed = 0;
  try {
    const current = await bundle(repo, join(work, 'current.cjs'));
    const head = git(repo, 'rev-parse', '--short', 'HEAD');
    let release;
    for (const [i, path] of paths.entries()) {
      const label = names[i];
      if (o.only && o.only !== label) continue;
      const file = join(o.dir, `${label}.json`);
      const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
      const fresh = !old || o.update;
      const pin = fresh ? pinOf(path) : old.pin;
      const config = fresh ? configOf(path) : old.config;
      log(`[baseline] ${label} (${path}${pin ? ` at ${pin.commit.slice(0, 10)}` : ', no git: its current files'})`);
      let root;
      try {
        root = prepare(path, pin, config);
        if (!old) {
          const m = measureIn(current, root, o.max, undefined, work);
          writeFileSync(file, JSON.stringify({ path, pin, config, measuredWith: head, date: new Date().toISOString(), measurement: m }, null, 1));
          log(`  baseline created: ${Object.keys(m.entries).length} of ${m.entryPoints.length} entry points${m.allCalls ? `, ${m.allCalls.methods} methods` : ''}, ${(m.ms / 1000).toFixed(1)} s`);
          continue;
        }
        let base = old.measurement;
        if (o.update) {
          if (!release) {
            const r = releaseCheckout(o.dir);
            release = { ...r, tool: await bundle(r.tree, join(work, 'release.cjs')) };
          }
          base = measureIn(release.tool, root, o.max, undefined, work);
          writeFileSync(file, JSON.stringify({ path, pin, config, measuredWith: release.tag, date: new Date().toISOString(), measurement: base }, null, 1));
          log(`  pin moved, baseline measured with ${release.tag}`);
        }
        const now = measureIn(current, root, o.max, Object.keys(base.entries), work);
        const { regressions, notes } = compare(base, now);
        log(`  against ${o.update ? release.tag : old.measuredWith}: ${(base.ms / 1000).toFixed(1)} s → ${(now.ms / 1000).toFixed(1)} s`);
        for (const r of regressions) log(`  REGRESSION ${r}`);
        for (const n of notes) log(`  ${n}`);
        if (!regressions.length && !notes.length) log('  no change');
        if (regressions.length) failed++;
      } catch (err) {
        log(`  REGRESSION ${err.message}`);
        failed++;
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return failed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(parseArgs(process.argv.slice(2))).then(
    (failed) => process.exit(failed ? 1 : 0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
