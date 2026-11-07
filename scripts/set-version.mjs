// Sets one version on everything a release ships (VS Code extension, Rider plugin, Vim package, agent package):
//   node scripts/set-version.mjs 0.1.0
// The release workflow calls it with the tag's version; locally it is the step before tagging.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2]?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>  (plain x.y.z: vsce rejects pre-release suffixes)');
  process.exit(1);
}

const edit = (rel, change) => {
  const file = join(repo, rel);
  const before = readFileSync(file, 'utf8');
  const after = change(before);
  if (after === before && !before.includes(version)) throw new Error(`no version found in ${rel}`);
  writeFileSync(file, after);
  console.log(`${rel} → ${version}`);
};
for (const pkg of ['packages/vscode', 'packages/vim', 'packages/stdio-host', 'packages/cli']) {
  edit(`${pkg}/package.json`, (s) => s.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));
}
// the sidecar reports its version (initialize, FR-25.2 shared diagram states)
edit('packages/stdio-host/src/server.ts', (s) => s.replace(/(STDIO_HOST_VERSION = )'[^']*'/, `$1'${version}'`));
edit('packages/rider/build.gradle.kts', (s) => s.replace(/^version = "[^"]*"/m, `version = "${version}"`));
