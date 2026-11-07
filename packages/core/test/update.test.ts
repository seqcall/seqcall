import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, due, effectiveVersion, repoOf, type Release, type UpdateDeps } from '../src/update';

const RELEASE_URL = 'https://api.github.com/repos/org/seqcall/releases/latest';
const ASSET_URL = 'https://api.github.com/repos/org/seqcall/releases/assets/7';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake GitHub: the latest release `tag` with `assets`, or an error status. */
function github(opts: { tag?: string; assets?: { name: string; url: string }[]; status?: number; assetStatus?: number; rateLimited?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url === RELEASE_URL) {
      if (opts.status) return new Response('', { status: opts.status, headers: opts.rateLimited ? { 'x-ratelimit-remaining': '0' } : {} });
      return Response.json({ tag_name: opts.tag ?? 'v0.2.0', html_url: 'https://github.com/org/seqcall/releases/tag/v0.2.0', assets: opts.assets ?? [{ name: 'seqcall-0.2.0.vsix', url: ASSET_URL }] });
    }
    // the asset is served from signed storage (fetch follows GitHub's redirect there)
    if (url === ASSET_URL) return opts.assetStatus ? new Response('', { status: opts.assetStatus }) : new Response(new Uint8Array([1, 2, 3]));
    return new Response('', { status: 500 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function deps(over: Partial<UpdateDeps> & { fetchFn?: typeof fetch } = {}) {
  const installed: { bytes: number[]; release: Release }[] = [];
  const asked: Release[] = [];
  const d: UpdateDeps = {
    repo: 'org/seqcall',
    currentVersion: '0.1.9',
    asset: (name) => name.endsWith('.vsix'),
    userAgent: 'seqcall-test',
    fetch: over.fetchFn ?? github().fetchFn,
    install: async (bytes, release) => void installed.push({ bytes: [...bytes], release }),
    confirm: async (release) => (asked.push(release), true),
    ...over,
  };
  return { d, installed, asked };
}

describe('FR-30 updates from the GitHub releases', () => {
  it('FR-30.1 compares x.y.z versions numerically, ignoring a leading v and a suffix', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.9', '1.0.0')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
  });

  it('FR-30.1 reads owner/repo from package.json repository', () => {
    expect(repoOf({ type: 'git', url: 'https://github.com/seqcall/seqcall' })).toBe('seqcall/seqcall');
    expect(repoOf('git@github.com:org/tool.git')).toBe('org/tool');
    expect(repoOf('https://github.com/org/tool.git')).toBe('org/tool');
    expect(repoOf('org/tool')).toBe('org/tool');
    expect(repoOf({ url: 'https://gitlab.com/org' })).toBeUndefined();
    expect(repoOf(undefined)).toBeUndefined();
  });

  it('FR-30.1 checks at most once per interval; a clock that went back counts as due', () => {
    const day = 24 * 3600_000;
    expect(due(undefined, 1000, day)).toBe(true);
    expect(due(0, day - 1, day)).toBe(false);
    expect(due(0, day, day)).toBe(true);
    expect(due(5000, 1000, day)).toBe(true);
  });

  it('FR-30.1 install mode downloads the .vsix of a newer release without any sign-in and installs it', async () => {
    const gh = github();
    const { d, installed, asked } = deps({ fetchFn: gh.fetchFn });
    const r = await checkForUpdate(d, 'install');
    expect(r).toMatchObject({ kind: 'installed', release: { version: '0.2.0', tag: 'v0.2.0', assetName: 'seqcall-0.2.0.vsix' } });
    expect(installed).toEqual([{ bytes: [1, 2, 3], release: expect.objectContaining({ version: '0.2.0' }) }]);
    expect(asked).toEqual([]);
    expect(gh.calls.map((c) => c.url)).toEqual([RELEASE_URL, ASSET_URL]);
    expect(gh.calls.every((c) => c.headers.Authorization === undefined)).toBe(true);
    expect(gh.calls[1].headers.Accept).toBe('application/octet-stream');
  });

  it('FR-30.1 the same or an older release is up to date: nothing downloaded', async () => {
    for (const tag of ['v0.1.9', 'v0.1.8']) {
      const gh = github({ tag });
      const { d, installed } = deps({ fetchFn: gh.fetchFn });
      expect(await checkForUpdate(d, 'install')).toEqual({ kind: 'upToDate', latest: tag.slice(1) });
      expect(installed).toEqual([]);
      expect(gh.calls).toHaveLength(1);
    }
  });

  it('FR-30.1 notify mode asks first; declined = nothing installed', async () => {
    const yes = deps();
    expect((await checkForUpdate(yes.d, 'notify')).kind).toBe('installed');
    expect(yes.asked.map((r) => r.version)).toEqual(['0.2.0']);
    const no = deps({ confirm: async () => false });
    expect((await checkForUpdate(no.d, 'notify')).kind).toBe('skipped');
    expect(no.installed).toEqual([]);
  });

  it('FR-30.1 notify mode without a way to ask installs nothing', async () => {
    const { d, installed } = deps({ confirm: undefined });
    expect((await checkForUpdate(d, 'notify')).kind).toBe('skipped');
    expect(installed).toEqual([]);
  });

  it('FR-30.1 a sparse release answer (no tag, notes url or assets; an asset without url) finds no package', async () => {
    const answer = (body: unknown) => (async () => Response.json(body)) as typeof fetch;
    expect(await checkForUpdate(deps({ fetchFn: answer({}) }).d, 'install')).toEqual({ kind: 'noAsset', latest: '' });
    expect(await checkForUpdate(deps({ fetchFn: answer({ tag_name: 'v0.2.0', assets: [{ name: 'seqcall-0.2.0.vsix' }, { url: ASSET_URL }] }) }).d, 'install')).toEqual({ kind: 'noAsset', latest: '0.2.0' });
    const noNotes = await checkForUpdate(deps({ fetchFn: answer({ tag_name: 'v0.2.0', assets: [{ name: 'seqcall-0.2.0.vsix', url: ASSET_URL }] }) }).d, 'report');
    expect(noNotes).toMatchObject({ kind: 'available', release: { url: '' } });
  });

  it('FR-30.2 report and off modes only say that a release is there', async () => {
    for (const mode of ['report', 'off'] as const) {
      const { d, installed, asked } = deps();
      expect(await checkForUpdate(d, mode)).toMatchObject({ kind: 'available', release: { version: '0.2.0' } });
      expect(installed).toEqual([]);
      expect(asked).toEqual([]);
    }
  });

  it('FR-30.3 a repository without a published release (404) and a used-up rate limit say so', async () => {
    expect(await checkForUpdate(deps({ fetchFn: github({ status: 404 }).fetchFn }).d, 'install')).toEqual({ kind: 'error', message: 'GitHub has no published release of org/seqcall (404).' });
    const limited = await checkForUpdate(deps({ fetchFn: github({ status: 403, rateLimited: true }).fetchFn }).d, 'install');
    expect(limited).toMatchObject({ kind: 'error', message: expect.stringContaining('Try again in an hour') });
  });

  it('FR-30.3 other refusals and failures become an error result, never a throw', async () => {
    expect(await checkForUpdate(deps({ fetchFn: github({ status: 403 }).fetchFn }).d, 'install')).toEqual({ kind: 'error', message: 'GitHub answered 403.' });
    expect(await checkForUpdate(deps({ fetchFn: github({ status: 502 }).fetchFn }).d, 'install')).toEqual({ kind: 'error', message: 'GitHub answered 502.' });
    expect(await checkForUpdate(deps({ fetchFn: github({ assetStatus: 403 }).fetchFn }).d, 'install')).toMatchObject({ kind: 'error', message: 'GitHub answered 403.' });
    const offline = deps({ fetchFn: (async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }) as typeof fetch });
    expect(await checkForUpdate(offline.d, 'install')).toEqual({ kind: 'error', message: 'getaddrinfo ENOTFOUND api.github.com' });
    const failingInstall = deps({ install: async () => { throw 'disk full'; } });
    expect(await checkForUpdate(failingInstall.d, 'install')).toEqual({ kind: 'error', message: 'disk full' });
  });

  it('FR-30.1 a version installed but not loaded yet is not installed again before the reload', async () => {
    expect(effectiveVersion('0.1.9', undefined)).toBe('0.1.9');
    expect(effectiveVersion('0.1.9', '0.2.0')).toBe('0.2.0');
    expect(effectiveVersion('0.2.0', '0.1.9')).toBe('0.2.0'); // reloaded since, or installed by hand
    const { d, installed } = deps({ currentVersion: effectiveVersion('0.1.9', '0.2.0') });
    expect(await checkForUpdate(d, 'install')).toEqual({ kind: 'upToDate', latest: '0.2.0' });
    expect(installed).toEqual([]);
  });

  it('FR-30.1 another API base (a fake GitHub for smoke runs) is asked instead of api.github.com', async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => (urls.push(String(input)), new Response('', { status: 404 }))) as typeof fetch;
    await checkForUpdate(deps({ fetchFn, api: 'http://127.0.0.1:4791' }).d, 'install');
    expect(urls).toEqual(['http://127.0.0.1:4791/repos/org/seqcall/releases/latest']);
  });

  it('FR-30.1 a release without a .vsix asset installs nothing', async () => {
    const { d, installed } = deps({ fetchFn: github({ assets: [{ name: 'seqcall-rider-0.2.0.zip', url: ASSET_URL }] }).fetchFn });
    expect(await checkForUpdate(d, 'install')).toEqual({ kind: 'noAsset', latest: '0.2.0' });
    expect(installed).toEqual([]);
  });
});
