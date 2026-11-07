import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand, type Run } from '@seqcall/stdio-host';
import { AGENT_PACKAGE, findPackageDir, runUpdate, type UpdateIo } from '../src/update';

/** `parent/seqcall-agent` laid out as the unpacked agent package, `VERSION` = `marker`. */
function agentFolder(parent: string, marker: string): string {
  const dir = join(parent, 'seqcall-agent');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), '{}');
  writeFileSync(join(dir, 'plugin', 'seqcall.cjs'), '// cli');
  writeFileSync(join(dir, 'VERSION'), marker);
  return dir;
}

/** The release zip of the agent package at `marker` (Python's zipfile, as build.mjs without zip). */
function agentZip(marker: string): Uint8Array {
  const src = mkdtempSync(join(tmpdir(), 'seqcall-agent-zip-'));
  agentFolder(src, marker);
  execFileSync('python3', ['-m', 'zipfile', '-c', join(src, 'a.zip'), 'seqcall-agent'], { cwd: src });
  return readFileSync(join(src, 'a.zip'));
}

function github(zip: Uint8Array, tag = 'v0.2.0') {
  return (async (input: string | URL | Request) =>
    String(input).endsWith('/releases/latest')
      ? Response.json({ tag_name: tag, assets: [{ name: 'seqcall-vim-0.2.0.tar.gz', url: 'https://x/1' }, { name: 'seqcall-agent-0.2.0.zip', url: 'https://x/2' }] })
      : new Response(zip)) as typeof fetch;
}

/** Real unzip / python3; `claude` recorded and answered by `claude`. */
function runner(claude: (args: string[]) => string | undefined, noUnzip = false) {
  const calls: string[] = [];
  const run: Run = (cmd, args, input) => {
    if (cmd === 'claude') {
      calls.push(`claude ${args.join(' ')}`);
      return claude(args);
    }
    return noUnzip && cmd === 'unzip' ? undefined : runCommand(cmd, args, input);
  };
  return { calls, run };
}

function io(over: Partial<UpdateIo>): UpdateIo & { lines: string[] } {
  const lines: string[] = [];
  return { bundleDir: '/nowhere/plugin', env: {}, home: '/nowhere', version: '0.1.9', fetch: github(agentZip('0.2.0')), run: runner(() => '').run, log: (l) => lines.push(l), lines, ...over };
}

describe('FR-30.7 seqcall update (agent package)', () => {
  it('FR-30.7 finds the package: --dir, the package the CLI runs from, else the marketplace Claude Code knows', () => {
    const parent = mkdtempSync(join(tmpdir(), 'seqcall-agent-'));
    const pkg = agentFolder(parent, '0.1.9');
    expect(findPackageDir({ dir: pkg, bundleDir: '/x/plugin', env: {}, home: '/nowhere' })).toBe(pkg);
    expect(findPackageDir({ bundleDir: join(pkg, 'plugin'), env: {}, home: '/nowhere' })).toBe(pkg);
    // Claude Code's copy of the plugin: the marketplace's folder from known_marketplaces.json
    const config = join(parent, 'claude-config');
    mkdirSync(join(config, 'plugins'), { recursive: true });
    writeFileSync(join(config, 'plugins', 'known_marketplaces.json'), JSON.stringify({ seqcall: { source: { source: 'directory', path: pkg } } }));
    expect(findPackageDir({ bundleDir: '/cache/seqcall/0.1.9', env: { CLAUDE_CONFIG_DIR: config }, home: '/nowhere' })).toBe(pkg);
    mkdirSync(join(parent, 'home', '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(parent, 'home', '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ seqcall: { source: { source: 'github', repo: 'x/y' } } }));
    expect(findPackageDir({ bundleDir: '/cache/x', env: {}, home: join(parent, 'home') })).toBeUndefined();
    expect(findPackageDir({ bundleDir: '/cache/x', env: {}, home: '/nowhere' })).toBeUndefined();
  });

  it('FR-30.7 a newer release replaces the package folder (unzip, else Python) and refreshes Claude Code', async () => {
    for (const noUnzip of [false, true]) {
      const parent = mkdtempSync(join(tmpdir(), 'seqcall-agent-'));
      const pkg = agentFolder(parent, '0.1.9');
      const r = runner(() => 'ok', noUnzip);
      const o = io({ dir: pkg, run: r.run });
      expect(await runUpdate(o)).toBe(0);
      expect(readFileSync(join(pkg, 'VERSION'), 'utf8')).toBe('0.2.0');
      expect(readdirSync(parent)).toEqual(['seqcall-agent']);
      expect(r.calls).toEqual(['claude plugin marketplace update seqcall', 'claude plugin update seqcall@seqcall']);
      expect(o.lines.slice(-2)).toEqual(['Seqcall 0.2.0 is installed (was 0.1.9).', 'Claude Code has the new plugin: restart Claude Code to use it.']);
    }
  });

  it('FR-30.7 without Claude Code (or its update failing) the commands to run are named', async () => {
    const pkg = agentFolder(mkdtempSync(join(tmpdir(), 'seqcall-agent-')), '0.1.9');
    const o = io({ dir: pkg, run: runner(() => undefined).run });
    expect(await runUpdate(o)).toBe(0);
    expect(o.lines.at(-1)).toBe('For Claude Code: claude plugin marketplace update seqcall && claude plugin update seqcall@seqcall, then restart it.');
  });

  it('FR-30.7 up to date 0, no package folder 2, a failed update 3', async () => {
    const pkg = agentFolder(mkdtempSync(join(tmpdir(), 'seqcall-agent-')), '0.1.9');
    const r = runner(() => 'ok');
    const same = io({ dir: pkg, fetch: github(new Uint8Array(), 'v0.1.9'), run: r.run });
    expect(await runUpdate(same)).toBe(0);
    expect(same.lines.at(-1)).toBe('Seqcall is up to date (0.1.9).');
    expect(r.calls).toEqual([]);
    const none = io({});
    expect(await runUpdate(none)).toBe(2);
    expect(none.lines).toEqual(['No unpacked seqcall-agent folder found: name it with seqcall update --dir <folder>.']);
    const broken = io({ dir: pkg, fetch: github(new Uint8Array([1, 2, 3])) });
    expect(await runUpdate(broken)).toBe(3);
    expect(broken.lines.at(-1)).toBe('Could not update Seqcall: could not unpack the release archive');
    expect(await runUpdate(io({ dir: mkdtempSync(join(tmpdir(), 'seqcall-agent-')) }))).toBe(3);
    expect(readFileSync(join(pkg, 'VERSION'), 'utf8')).toBe('0.1.9');
  });

  it('FR-30.7 the release asset is the agent zip', () => {
    expect(AGENT_PACKAGE.asset.test('seqcall-agent-0.2.0.zip')).toBe(true);
    expect(AGENT_PACKAGE.asset.test('seqcall-vim-0.2.0.tar.gz')).toBe(false);
  });
});
