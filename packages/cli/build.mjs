import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { saveBundleMeta, writeNotices } from '../../scripts/third-party-notices.mjs';

// Builds dist/seqcall.cjs; with --package also the downloadable package for agents (FR-27.11):
//   dist/seqcall-agent/{.claude-plugin/marketplace.json, README.md, plugin/{seqcall.cjs, csharp/, .mcp.json, skills/, …}}
//   and dist/seqcall-agent-<version>.zip — a Claude Code marketplace with the plugin (MCP server + skill), the CLI
//   for any agent or script (node plugin/seqcall.cjs …), an npm package (npm install -g ./plugin).
//   node packages/cli/build.mjs [--package]
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const result = await build({
  entryPoints: [join(here, 'src/main.ts')],
  banner: { js: '#!/usr/bin/env node' },
  outfile: join(here, 'dist/seqcall.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  define: { SEQCALL_VERSION: JSON.stringify(version) },
  metafile: true,
});
saveBundleMeta('cli', result, process.cwd());
// The bundled TypeScript compiler looks for its lib.*.d.ts next to the bundle.
const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync(join(here, 'dist'), { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) cpSync(join(tsLib, f), join(here, 'dist', f));

if (process.argv.includes('--package')) {
  const pkg = join(here, 'dist/seqcall-agent');
  const plugin = join(pkg, 'plugin');
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
  for (const f of readdirSync(join(here, 'dist'))) if (f === 'seqcall.cjs' || /^lib\..*\.d\.ts$/.test(f)) cpSync(join(here, 'dist', f), join(plugin, f));
  cpSync(join(here, 'agent/skills'), join(plugin, 'skills'), { recursive: true });
  // C#: the published sidecar (npm run build), else the Release build of packages/csharp; found next to seqcall.cjs
  const csharp = [join(repo, 'packages/vscode/dist/csharp'), join(repo, 'packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0')].find((d) => existsSync(join(d, 'Seqcall.CSharp.dll')));
  if (csharp) cpSync(csharp, join(plugin, 'csharp'), { recursive: true });
  else console.warn('C# sidecar not built (npm run build): the package supports TS/JS and PHP only');
  const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const description = 'Call flows of TypeScript/JavaScript, C# and PHP code for AI agents: who reaches a method, what a request runs (DB / HTTP / queues), entry points, implementations and DI, design issues, branch reviews.';
  json(join(plugin, '.claude-plugin/plugin.json'), { name: 'seqcall', version, description, author: { name: 'Seqcall' }, license: 'Apache-2.0' });
  json(join(plugin, '.mcp.json'), { mcpServers: { seqcall: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/seqcall.cjs', 'mcp'] } } });
  json(join(plugin, 'package.json'), { name: 'seqcall', version, description, bin: { seqcall: 'seqcall.cjs' }, engines: { node: '>=20' } });
  json(join(pkg, '.claude-plugin/marketplace.json'), { name: 'seqcall', owner: { name: 'Seqcall' }, description: 'Seqcall: call-flow analysis for AI agents.', plugins: [{ name: 'seqcall', source: './plugin', description, version }] });
  cpSync(join(here, 'agent/README.md'), join(pkg, 'README.md'));
  for (const dir of [pkg, plugin]) cpSync(join(repo, 'LICENSE'), join(dir, 'LICENSE'));
  writeNotices(join(plugin, 'THIRD-PARTY-NOTICES.txt'), { bundles: ['cli'], csharp });
  cpSync(join(plugin, 'THIRD-PARTY-NOTICES.txt'), join(pkg, 'THIRD-PARTY-NOTICES.txt'));
  const zip = join(here, `dist/seqcall-agent-${version}.zip`);
  rmSync(zip, { force: true });
  // zip is not installed everywhere; Python's zipfile writes the same archive
  try { execSync('zip -v', { stdio: 'ignore' }); execSync(`zip -qr ${JSON.stringify(zip)} seqcall-agent`, { cwd: join(here, 'dist') }); }
  catch { execSync(`python3 -m zipfile -c ${JSON.stringify(zip)} seqcall-agent`, { cwd: join(here, 'dist') }); }
  console.log(`→ ${zip}`);
}
