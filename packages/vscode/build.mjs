// Build the VS Code extension:
//   node build.mjs              extension bundle + webview build/copy
//   node build.mjs --watch      rebuild the extension on change (webview copied once)
//   node build.mjs --test       additionally bundle the extension-host tests into dist/test
//   node build.mjs --no-webview skip building/copying the webview bundles
//   node build.mjs --no-csharp  skip publishing the C# sidecar (packages/csharp) to dist/csharp
//                               (also skipped by --test and when SEQCALL_SKIP_CSHARP is set)
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { saveBundleMeta, writeNotices } from '../../scripts/third-party-notices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const withTests = args.has('--test');
const withWebview = !args.has('--no-webview');
// Test builds skip it: the extension then falls back to SEQCALL_CSHARP_SIDECAR / the packages/csharp build.
const withCSharp = !withTests && !args.has('--no-csharp') && !process.env.SEQCALL_SKIP_CSHARP;

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: here,
};

/**
 * The TypeScript compiler is NOT bundled: `import 'typescript'` is rewritten to
 * `require('./typescript.js')`, a verbatim copy placed in dist/ (see copyTypeScript).
 * Bundled, it makes extension.js and its source map so large that the debugger cannot
 * load them before VS Code's extension-host start timeout — F5 fails.
 */
const typescriptAsSibling = {
  name: 'typescript-as-sibling',
  setup(build) {
    build.onResolve({ filter: /^typescript$/ }, () => ({ path: './typescript.js', external: true }));
  },
};

/** Extension: bundles @seqcall/core; `vscode` and the TypeScript compiler stay external. */
const extensionOptions = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
  metafile: true,
  plugins: [typescriptAsSibling],
};

function testOptions() {
  const suiteDir = path.join(here, 'test', 'suite');
  const entries = fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `test/suite/${f}`);
  return [
    // Runner (plain node): downloads VS Code and launches it.
    {
      ...common,
      entryPoints: ['test/runTest.ts'],
      outfile: 'dist/test/runTest.js',
      packages: 'external',
    },
    // Suite (runs inside the extension host). Each file separately: mocha loads them by path.
    {
      ...common,
      entryPoints: entries,
      outdir: 'dist/test/suite',
      external: ['vscode', 'mocha'],
    },
  ];
}

function buildWebview() {
  const webviewPkg = path.join(repo, 'packages', 'webview');
  const pkg = JSON.parse(fs.readFileSync(path.join(webviewPkg, 'package.json'), 'utf8'));
  if (pkg.scripts?.build) {
    // its build script is `node build.mjs`: run it with this Node (an absolute path) instead of npm from PATH
    execFileSync(process.execPath, ['build.mjs'], { cwd: webviewPkg, stdio: 'inherit' });
  } else {
    console.warn('[build] @seqcall/webview has no "build" script yet; copying whatever is in its dist/');
  }
  const outDir = path.join(here, 'dist', 'webview');
  fs.mkdirSync(outDir, { recursive: true });
  const missing = [];
  for (const f of ['sequence.js', 'class.js', 'styles.css']) {
    const src = path.join(webviewPkg, 'dist', f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outDir, f));
      if (fs.existsSync(src + '.map')) fs.copyFileSync(src + '.map', path.join(outDir, f + '.map'));
    } else missing.push(f);
  }
  if (missing.length) console.warn(`[build] webview files missing (panels will be blank): ${missing.join(', ')}`);
  else console.log('[build] webview bundles copied to dist/webview');
}

/**
 * Copies typescript.js and its default libs (lib.*.d.ts) to dist/. TypeScript resolves the
 * libs next to the running script (ts.getDefaultLibFilePath uses __dirname), i.e. dist/.
 */
function copyTypeScript() {
  const tsLib = path.dirname(createRequire(path.join(repo, 'packages', 'core', 'package.json')).resolve('typescript'));
  const outDir = path.join(here, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(tsLib)) {
    if (f === 'typescript.js' || /^lib\..*\.d\.ts$|^lib\.d\.ts$/.test(f)) {
      fs.copyFileSync(path.join(tsLib, f), path.join(outDir, f));
      n++;
    }
  }
  console.log(`[build] copied typescript.js and ${n - 1} lib .d.ts files to dist/`);
}

/** The sidecar project in packages/csharp: Seqcall.CSharp.csproj, else the only non-test .csproj (depth ≤ 2). */
function findSidecarProject(dir) {
  const found = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && depth < 2 && !['bin', 'obj', 'node_modules'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith('.csproj')) found.push(path.join(d, e.name));
    }
  };
  walk(dir, 0);
  return found.find((f) => path.basename(f) === 'Seqcall.CSharp.csproj') ?? found.filter((f) => !/test/i.test(path.basename(f)))[0];
}

/**
 * Publishes the C# Roslyn sidecar (framework-dependent) to dist/csharp, where the extension
 * looks for Seqcall.CSharp.dll. Skipped with a warning when dotnet or packages/csharp is missing
 * or the publish fails: the TypeScript part of the extension works without it.
 */
function publishCSharp() {
  const csharpDir = path.join(repo, 'packages', 'csharp');
  if (!fs.existsSync(csharpDir)) {
    console.warn('[build] packages/csharp not found: C# support not bundled');
    return;
  }
  try {
    execSync('dotnet --version', { stdio: 'ignore' });
  } catch {
    console.warn('[build] dotnet not found on the PATH: C# sidecar not bundled (C# files will not be analysed)');
    return;
  }
  const project = findSidecarProject(csharpDir);
  if (!project) {
    console.warn('[build] no sidecar .csproj in packages/csharp: C# support not bundled');
    return;
  }
  const outDir = path.join(here, 'dist', 'csharp');
  try {
    // -nodeReuse:false: MSBuild would otherwise leave one idle worker per CPU for 15 minutes after every build
    execSync(`dotnet publish "${project}" -c Release -o "${outDir}" --self-contained false -nologo -nodeReuse:false`, { cwd: repo, stdio: 'inherit' });
    console.log(`[build] C# sidecar published to ${path.relative(repo, outDir)}`);
  } catch (e) {
    console.warn(`[build] dotnet publish failed, C# sidecar not bundled: ${e.message}`);
  }
}

async function main() {
  const configs = [extensionOptions, ...(withTests ? testOptions() : [])];
  copyTypeScript();
  if (withWebview) buildWebview();
  if (withCSharp) publishCSharp();
  if (watch) {
    for (const c of configs) {
      const ctx = await esbuild.context(c);
      await ctx.watch();
    }
    console.log('[build] watching…');
  } else {
    const [extension] = await Promise.all(configs.map((c) => esbuild.build(c)));
    saveBundleMeta('vscode', extension, here);
    // typescript.js is copied as it is (copyTypeScript), not bundled
    writeNotices(path.join(here, 'dist/THIRD-PARTY-NOTICES.txt'), {
      bundles: ['vscode', ...(withWebview ? ['webview'] : [])],
      npm: ['typescript'],
      csharp: path.join(here, 'dist/csharp'),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
