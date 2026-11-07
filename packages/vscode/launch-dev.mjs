// Builds the extension and opens an Extension Development Host WITHOUT a debugger:
//   node packages/vscode/launch-dev.mjs [folder]     (default: fixtures/sample-app)
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(process.argv[2] ?? join(here, '../../fixtures/sample-app'));
// the Node running this script (an absolute path), not the first `node` on PATH
execFileSync(process.execPath, ['build.mjs'], { cwd: here, stdio: 'inherit' });
const code = process.env.CODE_CLI ?? (process.platform === 'win32' ? 'code.cmd' : 'code');
spawn(code, ['--new-window', `--extensionDevelopmentPath=${here}`, folder], {
  stdio: 'ignore',
  detached: true,
  shell: process.platform === 'win32',
}).unref();
console.log(`Opened an Extension Development Host on ${folder}`);
