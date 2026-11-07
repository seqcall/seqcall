import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPackage, packageDirProblem, runCommand, updatePlugin, type Run } from '../src/update';

// renameSync can be made to fail once for the swap's second step (the new folder moved in), to see the old one come back
let failSwapIn = false;
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (failSwapIn && String(from).includes('.seqcall-update-') && String(from).endsWith('seqcall-vim')) {
        failSwapIn = false;
        throw new Error('EXDEV: cross-device link not permitted');
      }
      return real.renameSync(from, to);
    },
  };
});

/** A folder `parent/<name>` laid out as the unpacked Vim package, with `marker` = its version. */
function pluginFolder(parent: string, name: string, marker: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, 'plugin'), { recursive: true });
  mkdirSync(join(dir, 'node'), { recursive: true });
  writeFileSync(join(dir, 'plugin', 'seqcall.vim'), '" plugin');
  writeFileSync(join(dir, 'node', 'stdio-host.cjs'), '// sidecar');
  writeFileSync(join(dir, 'VERSION'), marker);
  return dir;
}

/** The release archive: seqcall-vim/ at version `marker`. */
function archive(marker: string): Uint8Array {
  const src = mkdtempSync(join(tmpdir(), 'seqcall-pkg-'));
  pluginFolder(src, 'seqcall-vim', marker);
  execFileSync('tar', ['-czf', join(src, 'a.tar.gz'), 'seqcall-vim'], { cwd: src });
  return readFileSync(join(src, 'a.tar.gz'));
}

/** An installed plugin `~/.vim/pack/x/start/seqcall-vim` at 0.1.9. */
function installed(): { parent: string; dir: string } {
  const parent = mkdtempSync(join(tmpdir(), 'seqcall-start-'));
  return { parent, dir: pluginFolder(parent, 'seqcall-vim', '0.1.9') };
}

const RELEASE = 'https://api.github.com/repos/seqcall/seqcall/releases/latest';

function github(tag: string, assets: string[], pkg: Uint8Array = new Uint8Array()) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${url} ${init?.headers && 'Authorization' in init.headers ? 'auth' : 'no-auth'}`);
    if (url === RELEASE) return Response.json({ tag_name: tag, html_url: '', assets: assets.map((name, i) => ({ name, url: `https://api.github.com/a/${i}` })) });
    return new Response(pkg);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const noRun: Run = () => undefined;
const tarOnly: Run = (cmd, args, input) => (cmd === 'tar' ? runCommand(cmd, args, input) : undefined);

describe('FR-30.6 :SeqcallUpdate (sidecar --update)', () => {
  afterEach(() => {
    failSwapIn = false;
  });

  it('FR-30.6 only an unpacked package is replaced, not a git checkout or another folder', () => {
    const { parent, dir } = installed();
    expect(packageDirProblem(dir)).toBeUndefined();
    expect(packageDirProblem(parent)).toMatch(/is not an unpacked Seqcall package/);
    mkdirSync(join(dir, '.git'));
    expect(packageDirProblem(dir)).toMatch(/is a git checkout: update it with git/);
  });

  it('FR-30.6 a newer release is downloaded without any sign-in and replaces the plugin folder', async () => {
    const { parent, dir } = installed();
    const gh = github('v0.2.0', ['seqcall-0.2.0.vsix', 'seqcall-vim-0.2.0.tar.gz'], archive('0.2.0'));
    const lines: string[] = [];
    const code = await updatePlugin({ pluginDir: dir, version: '0.1.9', env: {}, fetch: gh.fetchFn, run: tarOnly, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe('0.2.0');
    expect(readdirSync(parent)).toEqual(['seqcall-vim']); // no work folder left
    expect(gh.calls).toEqual([`${RELEASE} no-auth`, 'https://api.github.com/a/1 no-auth']);
    expect(lines).toEqual(['Checking GitHub for a newer Seqcall (installed: 0.1.9)…', 'Seqcall 0.2.0 is installed (was 0.1.9).', 'Restart the editor to use it.']);
  });

  it('FR-30.6 up to date, no Vim package, a refused request: nothing changes, the line says why', async () => {
    const { dir } = installed();
    const run = async (o: { tag?: string; assets?: string[]; fetchFn?: typeof fetch }) => {
      const lines: string[] = [];
      const code = await updatePlugin({
        pluginDir: dir,
        version: '0.1.9',
        env: {},
        fetch: o.fetchFn ?? github(o.tag ?? 'v0.2.0', o.assets ?? ['seqcall-vim-0.2.0.tar.gz']).fetchFn,
        run: noRun,
        log: (l) => lines.push(l),
      });
      return { code, last: lines.at(-1) };
    };
    expect(await run({ tag: 'v0.1.9' })).toEqual({ code: 0, last: 'Seqcall is up to date (0.1.9).' });
    expect(await run({ assets: ['seqcall-rider-0.2.0.zip'] })).toEqual({ code: 1, last: 'The latest Seqcall release (0.2.0) has no Vim package.' });
    const refused = await run({ fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch });
    expect(refused.code).toBe(1);
    expect(refused.last).toBe('Could not update Seqcall: GitHub has no published release of seqcall/seqcall (404).');
    expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe('0.1.9');
  });

  it('FR-30.6 a folder that is not an unpacked package is left alone', async () => {
    const { parent } = installed();
    const lines: string[] = [];
    expect(await updatePlugin({ pluginDir: parent, version: '0.1.9', env: {}, fetch: github('v0.2.0', []).fetchFn, run: noRun, log: (l) => lines.push(l) })).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/is not an unpacked Seqcall package/)]);
  });

  it('FR-30.6 a broken archive, one without the plugin folder, or a failed swap keep the installed plugin', () => {
    const { parent, dir } = installed();
    expect(() => installPackage(new Uint8Array([1, 2, 3]), dir, tarOnly)).toThrow('could not unpack the release archive');
    const other = mkdtempSync(join(tmpdir(), 'seqcall-other-'));
    mkdirSync(join(other, 'something'));
    execFileSync('tar', ['-czf', join(other, 'o.tar.gz'), 'something'], { cwd: other });
    expect(() => installPackage(readFileSync(join(other, 'o.tar.gz')), dir, tarOnly)).toThrow('the release archive has no seqcall-vim/ folder');
    failSwapIn = true;
    expect(() => installPackage(archive('0.2.0'), dir, tarOnly)).toThrow('EXDEV');
    expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe('0.1.9');
    expect(readdirSync(parent)).toEqual(['seqcall-vim']);
    expect(existsSync(join(dir, 'plugin', 'seqcall.vim'))).toBe(true);
  });

  it('FR-30.6 runCommand returns stdout, or undefined for a failing or missing command', () => {
    expect(runCommand('node', ['-e', 'process.stdin.pipe(process.stdout)'], 'hi')).toBe('hi');
    expect(runCommand('node', ['-e', 'process.exit(3)'])).toBeUndefined();
    expect(runCommand('no-such-command-seqcall', [])).toBeUndefined();
  });
});
