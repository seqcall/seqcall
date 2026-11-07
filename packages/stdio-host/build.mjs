import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { saveBundleMeta } from '../../scripts/third-party-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(here, 'dist/stdio-host.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  metafile: true,
});
saveBundleMeta('stdio-host', result, process.cwd());
// The bundled TypeScript compiler looks for its lib.*.d.ts next to the bundle.
const tsLib = dirname(createRequire(import.meta.url).resolve('typescript/lib/typescript.js'));
mkdirSync(join(here, 'dist'), { recursive: true });
for (const f of readdirSync(tsLib)) if (/^lib\..*\.d\.ts$/.test(f)) cpSync(join(tsLib, f), join(here, 'dist', f));
