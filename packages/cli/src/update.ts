/**
 * FR-30.7 `seqcall update [--dir <folder>]`: puts the latest release's agent package in place of the unpacked
 * `seqcall-agent` folder (the update itself: @seqcall/stdio-host), then lets Claude Code refresh its copy of the plugin.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { updatePackage, type PackageKind, type Run } from '@seqcall/stdio-host';

export const AGENT_PACKAGE: PackageKind = {
  folder: 'seqcall-agent',
  asset: /^seqcall-agent-.*\.zip$/,
  markers: ['.claude-plugin/marketplace.json', 'plugin/seqcall.cjs'],
  noun: 'agent package',
  userAgent: 'seqcall-agent',
  // unzip is not installed everywhere; Python's zipfile reads the same archive
  unpack: (file, into, run) => run('unzip', ['-q', '-o', file, '-d', into]) !== undefined || run('python3', ['-m', 'zipfile', '-e', file, into]) !== undefined,
};

export interface UpdateIo {
  /** --dir */
  dir?: string;
  /** The folder of the running seqcall.cjs. */
  bundleDir: string;
  env: Record<string, string | undefined>;
  home: string;
  version: string;
  fetch: typeof fetch;
  run: Run;
  log(line: string): void;
}

/**
 * The unpacked agent package: `--dir`, the package this CLI runs from (`plugin/seqcall.cjs`, also behind
 * `npm install -g ./plugin`), else the directory marketplace Claude Code knows as `seqcall` (it runs the plugin
 * from its own copy, not from the package).
 */
export function findPackageDir(io: Pick<UpdateIo, 'dir' | 'bundleDir' | 'env' | 'home'>): string | undefined {
  if (io.dir) return resolve(io.dir);
  const own = dirname(io.bundleDir);
  if (existsSync(join(own, '.claude-plugin', 'marketplace.json'))) return own;
  const config = io.env.CLAUDE_CONFIG_DIR || join(io.home, '.claude');
  try {
    const known = JSON.parse(readFileSync(join(config, 'plugins', 'known_marketplaces.json'), 'utf8')) as Record<string, { source?: { source?: string; path?: unknown } }>;
    const source = known.seqcall?.source;
    return source?.source === 'directory' && typeof source.path === 'string' ? source.path : undefined;
  } catch {
    return undefined;
  }
}

/** Exit code as the other commands: 0 up to date or updated, 2 no package folder found, 3 the update failed. */
export async function runUpdate(io: UpdateIo): Promise<number> {
  const dir = findPackageDir(io);
  if (!dir) {
    io.log('No unpacked seqcall-agent folder found: name it with seqcall update --dir <folder>.');
    return 2;
  }
  const r = await updatePackage({ pluginDir: dir, kind: AGENT_PACKAGE, version: io.version, env: io.env, fetch: io.fetch, run: io.run, log: io.log });
  if (r?.kind !== 'installed') return r?.kind === 'upToDate' ? 0 : 3;
  // Claude Code runs the plugin from its own copy: refresh the marketplace, then the plugin from it
  const claude = (args: string[]) => io.run('claude', ['plugin', ...args]) !== undefined;
  if (claude(['marketplace', 'update', 'seqcall']) && claude(['update', 'seqcall@seqcall'])) io.log('Claude Code has the new plugin: restart Claude Code to use it.');
  else io.log('For Claude Code: claude plugin marketplace update seqcall && claude plugin update seqcall@seqcall, then restart it.');
  return 0;
}
