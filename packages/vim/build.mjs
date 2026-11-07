// Builds the Vim plugin package (FR-21.4): webview + Node sidecar bundles (+ C# sidecar if built), then
//   packages/vim/dist/seqcall-vim/{plugin,autoload,vim9,lua,doc,node,csharp} (Vim 9 and Neovim)  and  dist/seqcall-vim-<version>.tar.gz
// Install: docs/INSTALL.md.
//   node packages/vim/build.mjs [--out <dir>] [--no-build] [--no-tar]
//   --out: package directory (default packages/vim/dist/seqcall-vim); --no-build: use the existing
//   bundles; --no-tar: only the directory (tests).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from '../../scripts/third-party-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const run = (cmd, cwd = repo) => execSync(cmd, { stdio: 'inherit', cwd });
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (!args.includes('--no-build')) {
  run('npm run build -w @seqcall/webview');
  run('npm run build -w @seqcall/stdio-host');
}

const out = resolve(option('--out') ?? join(here, 'dist/seqcall-vim'));
rmSync(out, { recursive: true, force: true });
for (const dir of ['plugin', 'autoload', 'vim9', 'lua', 'doc']) cpSync(join(here, dir), join(out, dir), { recursive: true });
cpSync(join(repo, 'LICENSE'), join(out, 'LICENSE'));
// The sidecar finds the webview next to itself (node/webview) and its TypeScript libs (lib.*.d.ts).
cpSync(join(repo, 'packages/stdio-host/dist'), join(out, 'node'), { recursive: true });
mkdirSync(join(out, 'node/webview'), { recursive: true });
for (const f of readdirSync(join(repo, 'packages/webview/dist'))) cpSync(join(repo, 'packages/webview/dist', f), join(out, 'node/webview', f));
// C#: the published sidecar (npm run build), else the Release build of packages/csharp.
const csharp = [join(repo, 'packages/vscode/dist/csharp'), join(repo, 'packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0')].find((d) =>
  existsSync(join(d, 'Seqcall.CSharp.dll')),
);
if (csharp) cpSync(csharp, join(out, 'csharp'), { recursive: true });
else console.warn('C# sidecar not built (npm run build): the package supports TS/JS and PHP only');
writeNotices(join(out, 'THIRD-PARTY-NOTICES.txt'), { bundles: ['stdio-host', 'webview'], csharp });
try {
  // :help seqcall works right after unpacking (otherwise `:helptags ALL`).
  execSync(`vim -N -u NONE -i NONE --not-a-term -es -c "helptags ${join(out, 'doc')}" -c qa!`, { stdio: 'ignore' });
} catch {
  console.warn('vim not found: doc/tags not generated (run :helptags ALL after installing)');
}
if (!args.includes('--no-tar')) {
  const tarball = join(dirname(out), `seqcall-vim-${version}.tar.gz`);
  run(`tar -czf ${JSON.stringify(tarball)} ${JSON.stringify(basename(out))}`, dirname(out));
  console.log(`→ ${tarball}`);
}
