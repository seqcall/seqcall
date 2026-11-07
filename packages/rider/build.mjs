// Builds what the Rider plugin bundles (webview, Node sidecar, C# sidecar if missing), then runs
// Gradle with Rider's own Java runtime (Rider 2026.2 needs Java 25):
//   node packages/rider/build.mjs [gradle task …]     default: test buildPlugin
// Env: RIDER_PATH (default: the Toolbox install), RIDER_VERSION (build against that Rider from JetBrains' Maven
// repository instead, e.g. in CI), SEQCALL_JAVA_HOME (a Java 25; default: <rider>/jbr).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNotices } from '../../scripts/third-party-notices.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: repo, ...opts });
const rider = process.env.RIDER_PATH ?? join(homedir(), '.local/share/JetBrains/Toolbox/apps/rider');
const javaHome = process.env.SEQCALL_JAVA_HOME ?? join(rider, 'jbr');

run('npm run build -w @seqcall/webview');
run('npm run build -w @seqcall/stdio-host');
if (!existsSync(join(repo, 'packages/vscode/dist/csharp/Seqcall.CSharp.dll'))) run('npm run build -w @seqcall/vscode');
// copied into the plugin folder by build.gradle.kts (prepareSandbox)
writeNotices(join(here, 'build/THIRD-PARTY-NOTICES.txt'), { bundles: ['stdio-host', 'webview'], csharp: join(repo, 'packages/vscode/dist/csharp') });
const tasks = process.argv.slice(2);
run(`./gradlew --no-daemon -Dorg.gradle.java.installations.paths=${javaHome} ${(tasks.length ? tasks : ['test', 'buildPlugin']).join(' ')}`, {
  cwd: here,
  env: { ...process.env, JAVA_HOME: javaHome, RIDER_PATH: rider },
});
