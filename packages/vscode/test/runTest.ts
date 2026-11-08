import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Downloads VS Code into <repo>/.vscode-test and runs the mocha suite inside the
 * extension host, with fixtures/sample-app opened as the workspace.
 * Bundled to packages/vscode/dist/test/runTest.js.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const repo = path.resolve(extensionDevelopmentPath, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const workspace = process.env.SEQCALL_TEST_WORKSPACE ?? path.join(repo, 'fixtures', 'sample-app');
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? 'stable',
      cachePath: path.join(repo, '.vscode-test'),
      extensionDevelopmentPath,
      extensionTestsPath,
      // a real Node for the fake C# sidecar (the extension host itself runs on Electron);
      // NODE_V8_COVERAGE (set by scripts/coverage-vscode.mjs): the extension host writes V8 coverage there
      extensionTestsEnv: {
        SEQCALL_TEST_NODE: process.execPath,
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      },
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${path.join(repo, '.vscode-test', 'user-data')}`,
        // not ~/.vscode/extensions: a test run must never touch the developer's own extensions
        `--extensions-dir=${path.join(repo, '.vscode-test', 'extensions')}`,
      ],
    });
  } catch (err) {
    console.error('Extension tests failed:', err);
    process.exit(1);
  }
}

void main();
