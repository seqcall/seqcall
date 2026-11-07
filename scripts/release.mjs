// Builds every downloadable package into release/ (what the GitHub release workflow uploads):
//   release/seqcall-<v>.vsix           VS Code (and VS Code-based editors: Cursor, VSCodium, Windsurf)
//   release/seqcall-rider-<v>.zip      Rider, PhpStorm and other JetBrains IDEs 2026.2+
//   release/seqcall-vim-<v>.tar.gz     Vim 9 and Neovim
//   release/seqcall-agent-<v>.zip      AI agents: Claude Code plugin (MCP server + skill), MCP server for other clients, CLI
//   release/SHA256SUMS
//   node scripts/release.mjs [--no-rider] [--no-tests]
// Needs the .NET 10 SDK (C# sidecar; without it the packages support TS/JS and PHP only) and for Rider
// either the local Rider or RIDER_VERSION + a Java 25 in SEQCALL_JAVA_HOME (packages/rider/build.mjs).
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: repo });
const { version } = JSON.parse(readFileSync(join(repo, 'packages/vscode/package.json'), 'utf8'));
const out = join(repo, 'release');

// The .vsix build also publishes the C# sidecar to packages/vscode/dist/csharp, which Vim and Rider bundle,
// and rebuilds its bin/Release, which the C# tests use: package first, so they never test a stale sidecar.
run('npm run package -w @seqcall/vscode');
if (!args.has('--no-tests')) {
  run('npm test');
  if (existsSync(join(repo, 'packages/vscode/dist/csharp/Seqcall.CSharp.dll'))) run('dotnet test packages/csharp -c Release --nologo -nodeReuse:false');
}
run('node packages/vim/build.mjs');
run('node packages/cli/build.mjs --package');
if (!args.has('--no-rider')) run(`node packages/rider/build.mjs ${args.has('--no-tests') ? 'buildPlugin' : 'test buildPlugin'}`);

if (!existsSync(join(repo, 'packages/vscode/dist/csharp/Seqcall.CSharp.dll'))) {
  console.warn('\n⚠ C# sidecar missing (no .NET 10 SDK?): the packages support TS/JS and PHP only');
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const artifacts = [
  `packages/vscode/seqcall-${version}.vsix`,
  `packages/vim/dist/seqcall-vim-${version}.tar.gz`,
  `packages/cli/dist/seqcall-agent-${version}.zip`,
  ...(args.has('--no-rider') ? [] : [`packages/rider/build/distributions/seqcall-rider-${version}.zip`]),
];
const sums = artifacts.map((rel) => {
  const file = join(out, basename(rel));
  copyFileSync(join(repo, rel), file);
  return `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(rel)}`;
});
writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`\nrelease/ (${version}):\n${sums.join('\n')}`);
