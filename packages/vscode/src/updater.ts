import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { setting } from './config';
import { dialogs } from './dialogs';
import { checkForUpdate, due, effectiveVersion, repoOf, type CheckResult, type UpdateDeps, type UpdateMode } from '@seqcall/core';

/** FR-30.1 at most one automatic check a day, a while after startup. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const LAST_CHECK_KEY = 'update.lastCheck';
/** A version installed by an update and not loaded yet (the window was not reloaded): not installed again. */
const INSTALLED_KEY = 'update.installed';

type Log = (level: 'info' | 'error', message: string) => void;

export function updateMode(): UpdateMode {
  const m = setting<string>('autoUpdate', 'install');
  return m === 'notify' || m === 'off' ? m : 'install';
}

/** The editor side of a check; `overrides` replace parts of it (tests). */
export function updateDeps(context: vscode.ExtensionContext, log: Log, overrides: Partial<UpdateDeps> = {}): UpdateDeps | undefined {
  const pkg = context.extension.packageJSON as { version: string; repository?: unknown };
  const repo = repoOf(pkg.repository);
  if (!repo) return undefined;
  return {
    repo,
    asset: (name) => name.endsWith('.vsix'),
    userAgent: 'seqcall-vscode',
    currentVersion: effectiveVersion(pkg.version, context.globalState.get<string>(INSTALLED_KEY)),
    // smoke runs against a fake GitHub (docs/TESTING.md §5c)
    api: process.env.SEQCALL_UPDATE_API,
    fetch: (...args) => fetch(...args),
    install: async (bytes, release) => {
      // a file: uri — VS Code installs a .vsix only from there (globalStorageUri may be vscode-userdata:)
      const file = vscode.Uri.file(path.join(os.tmpdir(), `${Date.now()}-${release.assetName}`));
      await vscode.workspace.fs.writeFile(file, bytes);
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      } finally {
        await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
      }
      await context.globalState.update(INSTALLED_KEY, release.version);
      log('info', `update: installed ${release.assetName}`);
      void dialogs.info(`Seqcall ${release.version} is installed. Reload the window to use it.`, 'Reload').then((a) => {
        if (a === 'Reload') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    },
    confirm: async (release) => {
      const a = await dialogs.info(`Seqcall ${release.version} is available (you have ${pkg.version}).`, 'Install', 'Release Notes');
      if (a === 'Release Notes' && release.url) void vscode.env.openExternal(vscode.Uri.parse(release.url));
      return a === 'Install';
    },
    ...overrides,
  };
}

function describe(r: CheckResult, current: string): string {
  switch (r.kind) {
    case 'upToDate':
      return `Seqcall is up to date (${current}).`;
    case 'noAsset':
      return `The latest Seqcall release (${r.latest}) has no .vsix.`;
    case 'error':
      return `Could not check for Seqcall updates: ${r.message}`;
    case 'available':
      return `Seqcall ${r.release.version} is available (you have ${current}).`;
    case 'installed':
      return `Seqcall ${r.release.version} is installed.`;
    case 'skipped':
      return `Seqcall ${r.release.version} was not installed.`;
  }
}

/** FR-30.2 Check for Updates: says what it found; in `off` mode it offers the install. */
export async function checkManually(context: vscode.ExtensionContext, log: Log, overrides: Partial<UpdateDeps> = {}): Promise<CheckResult | undefined> {
  const deps = updateDeps(context, log, overrides);
  if (!deps) return undefined;
  const mode = updateMode();
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Seqcall: checking for updates' }, () =>
    checkForUpdate(deps, mode === 'install' ? 'install' : 'notify'),
  );
  void context.globalState.update(LAST_CHECK_KEY, Date.now());
  log(r.kind === 'error' ? 'error' : 'info', `update: ${describe(r, deps.currentVersion)}`);
  if (r.kind === 'error') void dialogs.error(describe(r, deps.currentVersion));
  else if (r.kind !== 'installed' && r.kind !== 'skipped') void dialogs.info(describe(r, deps.currentVersion));
  return r;
}

/** FR-30.1 the automatic check: quiet unless there is something to install. */
export async function checkAutomatically(context: vscode.ExtensionContext, log: Log, overrides: Partial<UpdateDeps> = {}): Promise<CheckResult | undefined> {
  const mode = updateMode();
  if (mode === 'off' || !due(context.globalState.get<number>(LAST_CHECK_KEY), Date.now(), CHECK_INTERVAL_MS)) return undefined;
  const deps = updateDeps(context, log, overrides);
  if (!deps) return undefined;
  await context.globalState.update(LAST_CHECK_KEY, Date.now());
  const r = await checkForUpdate(deps, mode);
  log(r.kind === 'error' ? 'error' : 'info', `update: ${describe(r, deps.currentVersion)}`);
  return r;
}

/** Registers Check for Updates and schedules the automatic check (only in an installed extension). */
export function registerUpdater(context: vscode.ExtensionContext, log: Log): void {
  context.subscriptions.push(vscode.commands.registerCommand('seqcall.checkForUpdates', () => checkManually(context, log)));
  if (context.extensionMode !== vscode.ExtensionMode.Production) return;
  const timer = setTimeout(() => void checkAutomatically(context, log), STARTUP_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
