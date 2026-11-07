/**
 * FR-30.6 / FR-30.7 updates of an unpacked release package: the Vim / Neovim plugin (`node stdio-host.cjs --update
 * <pluginDir>`, `:SeqcallUpdate`) and the agent package (`seqcall update`, packages/cli). Looks for a newer release
 * on GitHub (shared check in @seqcall/core), downloads the package's archive and puts it in place of the unpacked folder.
 * One line of text per step; exit code 0 = up to date or installed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkForUpdate, type CheckResult } from '@seqcall/core';

export const REPO = 'seqcall/seqcall';

/** Runs a command (stdin `input`), returns its stdout, or undefined when it failed or is not installed. */
export type Run = (command: string, args: string[], input?: string) => string | undefined;

export const runCommand: Run = (command, args, input) => {
  try {
    return execFileSync(command, args, {
      input,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/** One kind of release package: how to find it in a release, recognise it unpacked and unpack it. */
export interface PackageKind {
  /** The single folder inside the archive. */
  folder: string;
  /** The release asset's name. */
  asset: RegExp;
  /** Files of an unpacked package (relative). */
  markers: string[];
  /** In messages: "has no <noun>". */
  noun: string;
  userAgent: string;
  /** Unpacks `file` into `into`; false when it could not. */
  unpack(file: string, into: string, run: Run): boolean;
}

export const VIM_PACKAGE: PackageKind = {
  folder: 'seqcall-vim',
  asset: /^seqcall-vim-.*\.tar\.gz$/,
  markers: ['plugin/seqcall.vim', 'node/stdio-host.cjs'],
  noun: 'Vim package',
  userAgent: 'seqcall-vim',
  unpack: (file, into, run) => run('tar', ['-xzf', file, '-C', into]) !== undefined,
};

/** Why `dir` cannot be replaced by a release package of `kind` (undefined: it can). */
export function packageDirProblem(dir: string, kind: PackageKind = VIM_PACKAGE): string | undefined {
  if (kind.markers.some((m) => !existsSync(join(dir, m))))
    return `${dir} is not an unpacked Seqcall package (${kind.markers.join(', ')}): update it the way you installed it.`;
  if (existsSync(join(dir, '.git'))) return `${dir} is a git checkout: update it with git.`;
  return undefined;
}

/**
 * Unpacks the release archive next to the package folder and swaps it in; the old folder comes back when the swap
 * fails. The archive holds one folder, `kind.folder`.
 */
export function installPackage(archive: Uint8Array, pluginDir: string, run: Run, kind: PackageKind = VIM_PACKAGE): void {
  const work = mkdtempSync(join(dirname(pluginDir), '.seqcall-update-'));
  try {
    const file = join(work, 'package.archive');
    writeFileSync(file, archive);
    if (!kind.unpack(file, work, run)) throw new Error('could not unpack the release archive');
    const unpacked = join(work, kind.folder);
    if (packageDirProblem(unpacked, kind)) throw new Error(`the release archive has no ${kind.folder}/ folder`);
    const old = join(work, 'old');
    renameSync(pluginDir, old);
    try {
      renameSync(unpacked, pluginDir);
    } catch (e) {
      renameSync(old, pluginDir);
      throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface UpdateOptions {
  pluginDir: string;
  /** Default: the Vim package. */
  kind?: PackageKind;
  /** The installed version (the bundle's). */
  version: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  run: Run;
  log(line: string): void;
}

function describe(r: CheckResult, version: string, kind: PackageKind): string {
  switch (r.kind) {
    case 'upToDate':
      return `Seqcall is up to date (${version}).`;
    case 'noAsset':
      return `The latest Seqcall release (${r.latest}) has no ${kind.noun}.`;
    case 'error':
      return `Could not update Seqcall: ${r.message}`;
    default: // installed (install mode never stops at available / skipped)
      return `Seqcall ${r.release.version} is installed (was ${version}).`;
  }
}

/** One update: the check's result, or undefined when `pluginDir` is no unpacked package (both logged). */
export async function updatePackage(o: UpdateOptions): Promise<CheckResult | undefined> {
  const kind = o.kind ?? VIM_PACKAGE;
  const problem = packageDirProblem(o.pluginDir, kind);
  if (problem) {
    o.log(problem);
    return undefined;
  }
  o.log(`Checking GitHub for a newer Seqcall (installed: ${o.version})…`);
  const r = await checkForUpdate(
    {
      repo: REPO,
      // smoke runs against a fake GitHub (docs/TESTING.md §5c)
      api: o.env.SEQCALL_UPDATE_API,
      currentVersion: o.version,
      asset: (name) => kind.asset.test(name),
      userAgent: kind.userAgent,
      fetch: o.fetch,
      install: async (bytes) => installPackage(bytes, o.pluginDir, o.run, kind),
    },
    'install',
  );
  o.log(describe(r, o.version, kind));
  return r;
}

/** FR-30.6 the Vim / Neovim plugin (`--update`): 0 when it is up to date or was updated. */
export async function updatePlugin(o: UpdateOptions): Promise<number> {
  const r = await updatePackage(o);
  if (r?.kind === 'installed') o.log('Restart the editor to use it.');
  return r?.kind === 'upToDate' || r?.kind === 'installed' ? 0 : 1;
}
