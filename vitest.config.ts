import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/{protocol,core,webview,stdio-host,vim,cli}/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    testTimeout: 30000,
    // Setup that loads a TS project can pass 10 s (vitest's default) when the whole suite runs in parallel.
    hookTimeout: 30000,
    // Vim tests (FR-21): build the sidecar / webview bundles when missing instead of skipping.
    globalSetup: ['packages/vim/test/global-setup.ts'],
    // `npm run coverage`: in-process code only. Code that runs in a child process (the stdio-host / CLI bundles the
    // Vim and CLI tests spawn, the C# sidecar) is not counted.
    coverage: {
      provider: 'v8',
      include: ['packages/{protocol,core,webview,stdio-host,cli}/src/**/*.ts', 'scripts/**/*.mjs'],
      exclude: [
        'scripts/test/**',
        // start-up code of the bundles (argv, stdio, process exit): run by the end-to-end tests in a child process,
        // which is not counted (docs/TESTING.md §11)
        'packages/{cli,stdio-host}/src/main.ts',
        'packages/webview/src/*-main.ts',
      ],
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/ts',
      // docs/TESTING.md §11: a package gets its threshold when it reaches 100 %; `npm run coverage` fails below it
      thresholds: {
        'packages/cli/src/**': { lines: 100, branches: 100 },
        'packages/core/src/**': { lines: 100, branches: 100 },
        'packages/webview/src/**': { lines: 100, branches: 100 },
        'packages/stdio-host/src/**': { lines: 100, branches: 100 },
      },
    },
  },
});
