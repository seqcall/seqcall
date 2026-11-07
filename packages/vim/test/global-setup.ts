import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * The Vim tests (FR-21) run the real sidecar and serve the real webview: build the bundles once when
 * they are missing (a fresh checkout), so the tests run instead of being skipped. Only when Vim is
 * installed — otherwise those tests skip and nothing needs building.
 */
export default function setup(): void {
  const repo = path.resolve(__dirname, '../../..');
  if (spawnSync('vim', ['--version'], { stdio: 'ignore' }).status !== 0) return;
  for (const [pkg, artefact] of [
    ['stdio-host', 'dist/stdio-host.cjs'],
    ['webview', 'dist/sequence.js'],
  ]) {
    if (existsSync(path.join(repo, 'packages', pkg, artefact))) continue;
    console.log(`[vim tests] building packages/${pkg} (missing ${artefact})`);
    execFileSync(process.execPath, [path.join(repo, 'packages', pkg, 'build.mjs')], { stdio: 'inherit', cwd: repo });
  }
}
