import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// the webview's build script (`node build.mjs`), run with this Node (an absolute path) instead of npm from PATH
execFileSync(process.execPath, ['build.mjs'], { cwd: join(here, '../webview'), stdio: 'inherit' });
await build({
  entryPoints: [join(here, 'src/server.ts')],
  outfile: join(here, 'dist/server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
});
// The bundled TypeScript compiler looks for its lib.*.d.ts next to the bundle.
const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync(join(here, 'dist'), { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) cpSync(join(tsLib, f), join(here, 'dist', f));
