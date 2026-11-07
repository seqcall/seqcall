/**
 * FR-30 self-update from the GitHub releases of the public repository, shared by the VS Code extension, the
 * Vim / Neovim sidecar (`--update`) and the agent CLI. No sign-in: GitHub's API serves a public repository's releases
 * without a token (rate-limited per IP address, far above one check a day). The editor parts (install, messages)
 * come in through `UpdateDeps`.
 */

export interface Release {
  version: string;
  tag: string;
  url: string;
  /** The asset's API url (download with `Accept: application/octet-stream`). */
  assetUrl: string;
  assetName: string;
}

export type CheckResult =
  | { kind: 'upToDate'; latest: string }
  | { kind: 'noAsset'; latest: string }
  | { kind: 'error'; message: string }
  | { kind: 'available'; release: Release }
  | { kind: 'installed'; release: Release }
  | { kind: 'skipped'; release: Release };

export type UpdateMode = 'install' | 'notify' | 'off';

export interface UpdateDeps {
  /** owner/repo of the releases. */
  repo: string;
  /** The API base (default api.github.com; SEQCALL_UPDATE_API points it at a fake GitHub for smoke runs). */
  api?: string;
  currentVersion: string;
  /** Which release asset is this editor's package (e.g. the `.vsix`). */
  asset(name: string): boolean;
  /** Sent as User-Agent (GitHub's API requires one). */
  userAgent: string;
  fetch: typeof fetch;
  /** Writes the downloaded package and installs it. */
  install(bytes: Uint8Array, release: Release): Promise<void>;
  /** notify mode: asks whether to install; false = not now (none: never installs in notify mode). */
  confirm?(release: Release): Promise<boolean>;
}

const API = 'https://api.github.com';

/** 1 / 0 / -1 for x.y.z versions; a leading `v` and a pre-release / build suffix are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** The version a check compares with: the running one, or a newer one installed but not yet loaded (no reload yet). */
export function effectiveVersion(running: string, installedPending: string | undefined): string {
  return installedPending && compareVersions(installedPending, running) > 0 ? installedPending : running;
}

/** owner/repo from a package.json `repository` (string or { url }). */
export function repoOf(repository: unknown): string | undefined {
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string') return undefined;
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:github:)?([^/:]+)\/([^/]+)$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** True when the last check is older than `intervalMs` (or there was none). */
export function due(lastCheck: number | undefined, now: number, intervalMs: number): boolean {
  return lastCheck === undefined || now - lastCheck >= intervalMs || now < lastCheck;
}

function headers(accept: string, userAgent: string): Record<string, string> {
  return { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent };
}

/** Why GitHub refused, in words a user can act on. */
function httpError(res: Response, repo: string): string {
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0')
    return `GitHub's limit for requests without sign-in is used up for this network (${res.status}). Try again in an hour.`;
  if (res.status === 404) return `GitHub has no published release of ${repo} (404).`;
  return `GitHub answered ${res.status}.`;
}

export async function latestRelease(deps: Pick<UpdateDeps, 'repo' | 'fetch' | 'api' | 'asset' | 'userAgent'>): Promise<Release | { error: string } | { noAsset: string }> {
  const res = await deps.fetch(`${deps.api ?? API}/repos/${deps.repo}/releases/latest`, { headers: headers('application/vnd.github+json', deps.userAgent) });
  if (!res.ok) return { error: httpError(res, deps.repo) };
  const body = (await res.json()) as { tag_name?: string; html_url?: string; assets?: { name?: string; url?: string }[] };
  const tag = body.tag_name ?? '';
  const version = tag.replace(/^v/, '');
  const asset = (body.assets ?? []).find((a) => a.name && a.url && deps.asset(a.name));
  if (!asset) return { noAsset: version };
  return { version, tag, url: body.html_url ?? '', assetUrl: asset.url!, assetName: asset.name! };
}

export async function download(deps: Pick<UpdateDeps, 'repo' | 'fetch' | 'userAgent'>, release: Release): Promise<Uint8Array> {
  // GitHub redirects to a signed storage url
  const res = await deps.fetch(release.assetUrl, { headers: headers('application/octet-stream', deps.userAgent) });
  if (!res.ok) throw new Error(httpError(res, deps.repo));
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * One check: the latest release against the installed version; a newer one is installed (`install`), offered
 * (`notify`) or only reported (`report`: the manual check in `off` mode).
 */
export async function checkForUpdate(deps: UpdateDeps, mode: UpdateMode | 'report'): Promise<CheckResult> {
  try {
    const latest = await latestRelease(deps);
    if ('error' in latest) return { kind: 'error', message: latest.error };
    if ('noAsset' in latest) return { kind: 'noAsset', latest: latest.noAsset };
    if (compareVersions(latest.version, deps.currentVersion) <= 0) return { kind: 'upToDate', latest: latest.version };
    if (mode === 'off' || mode === 'report') return { kind: 'available', release: latest };
    if (mode === 'notify' && !(await deps.confirm?.(latest))) return { kind: 'skipped', release: latest };
    await deps.install(await download(deps, latest), latest);
    return { kind: 'installed', release: latest };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
