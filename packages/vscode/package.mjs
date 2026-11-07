// Packages the extension as a .vsix you can install into a regular VS Code:
//   node packages/vscode/package.mjs   →   packages/vscode/seqcall-<version>.vsix
// vsce rejects the scoped workspace name (@seqcall/vscode), so we stage dist/ with a
// rewritten manifest. Everything is already bundled, hence --no-dependencies.
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stage = join(here, '.vsix-stage');
// the Node running this script (an absolute path), not the first `node` on PATH
execFileSync(process.execPath, ['build.mjs'], { cwd: here, stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
// no source maps: they carry the whole source with its comments, and the published package needs neither
// (dist/ keeps them for debugging and coverage)
cpSync(join(here, 'dist'), join(stage, 'dist'), { recursive: true, filter: (src) => !src.includes(`${join('dist', 'test')}`) && !src.endsWith('.map') && !src.endsWith('THIRD-PARTY-NOTICES.txt') });
cpSync(join(here, 'media/icon.png'), join(stage, 'media/icon.png'));
cpSync(join(here, 'media/activity.svg'), join(stage, 'media/activity.svg')); // FR-16.4 activity bar icon
// The extension's Details page: a short user-facing README, not the developer docs (repo README.md).
cpSync(join(here, 'README.marketplace.md'), join(stage, 'README.md'));
cpSync(join(here, '../../LICENSE'), join(stage, 'LICENSE'));
cpSync(join(here, 'dist/THIRD-PARTY-NOTICES.txt'), join(stage, 'THIRD-PARTY-NOTICES.txt'));

const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
manifest.name = 'seqcall';
delete manifest.scripts;
delete manifest.dependencies;
delete manifest.devDependencies;
// the stage holds only what ships; naming it keeps vsce from warning about a missing .vscodeignore
manifest.files = ['dist', 'media', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'];
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));

const out = join(here, `seqcall-${manifest.version}.vsix`);
const vsce = join(here, '../../node_modules/.bin/vsce');
execSync(`"${vsce}" package --no-dependencies --allow-missing-repository --out "${out}"`, { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });
console.log(`\nInstall with: code --install-extension ${out}`);
