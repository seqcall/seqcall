/**
 * Entry of the bundled sidecar:
 * `node stdio-host.cjs [--workspace <dir>] [--csharp-sidecar <Seqcall.CSharp.dll>] [--browser [--port <n>] [--webview <dir>]]`.
 * stdout carries JSON-RPC only; diagnostics go to stderr. `--browser` (FR-21) serves the views to a
 * browser tab; the webview bundles are looked up next to the bundle (`webview/`, plugin layout) or in
 * packages/webview/dist (repository layout).
 * `node stdio-host.cjs --update [<pluginDir>]` (FR-30.6, Vim / Neovim `:SeqcallUpdate`): replaces the plugin folder
 * (default: the one this bundle is in) by the latest release, prints what it did, exits.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, STDIO_HOST_VERSION } from './server';
import { runCommand, updatePlugin } from './update';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function webviewDir(): string {
  const candidates = [arg('--webview'), join(__dirname, 'webview'), join(__dirname, '../../webview/dist')];
  return candidates.find((d): d is string => !!d && existsSync(join(d, 'sequence.js'))) ?? join(__dirname, 'webview');
}

if (process.argv.includes('--update')) {
  const dir = arg('--update');
  void updatePlugin({
    pluginDir: dir && !dir.startsWith('--') ? dir : join(__dirname, '..'),
    version: STDIO_HOST_VERSION,
    env: process.env,
    fetch,
    run: runCommand,
    log: (line) => process.stdout.write(`${line}\n`),
  }).then((code) => process.exit(code));
} else {
  // Anything printed by libraries must not corrupt the JSON-RPC stream.
  console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);

  const handle = startServer(process.stdin, process.stdout, {
    workspace: arg('--workspace'),
    csharpSidecar: arg('--csharp-sidecar'),
    browser: process.argv.includes('--browser') ? { webviewDir: webviewDir(), port: Number(arg('--port') ?? 0) } : undefined,
  });
  void handle.closed.then(() => process.exit(0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
}
