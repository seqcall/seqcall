// Builds the webview bundles (IIFE, browser) into dist/. `--dev` also bundles the dev
// harness into dev/out/; `--watch` keeps rebuilding.
import * as esbuild from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBundleMeta } from '../../scripts/third-party-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'firefox115', 'safari16'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: { sequence: join(here, 'src/sequence-main.ts'), class: join(here, 'src/class-main.ts') }, outdir: join(here, 'dist'), metafile: true },
  { ...common, entryPoints: { styles: join(here, 'src/styles.css') }, outdir: join(here, 'dist'), sourcemap: false },
];
if (dev) {
  builds.push({
    ...common,
    entryPoints: { 'sequence-dev': join(here, 'dev/sequence-dev.ts'), 'class-dev': join(here, 'dev/class-dev.ts') },
    outdir: join(here, 'dev/out'),
  });
}

await mkdir(join(here, 'dist'), { recursive: true });
if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching…');
} else {
  const [bundles] = await Promise.all(builds.map((b) => esbuild.build(b)));
  saveBundleMeta('webview', bundles, process.cwd());
}
if (dev) console.log(`Open file://${join(here, 'dev/sequence.html')} and file://${join(here, 'dev/class.html')}`);
