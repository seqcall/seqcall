import type { GitRefs } from '@seqcall/protocol';
import { git } from './git-changes';

/**
 * FR-24.13 what a review can compare with: the branches (local and remote, most recently committed first), tags,
 * the last commits of HEAD, the current branch and its upstream, and the usual target (develop / main / master).
 * Three git commands; a missing piece (no upstream, no tags) is just left out.
 */
export async function gitRefs(root: string): Promise<GitRefs> {
  const lines = async (args: string[]) => (await git(root, args).catch(() => '')).split('\n').filter(Boolean);
  const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')).trim() || undefined;
  const fmt = '%(refname)%09%(refname:short)%09%(committerdate:unix)%09%(objectname:short)%09%(subject)';
  const branches = (await lines(['for-each-ref', '--sort=-committerdate', '--count=300', `--format=${fmt}`, 'refs/heads', 'refs/remotes']))
    .map((l) => l.split('\t'))
    .filter(([full, short]) => !full.endsWith('/HEAD') && short !== current)
    // the subject is the rest of the line: it may contain tabs itself
    .map(([full, short, date, hash, ...subject]) => ({ name: short, remote: full.startsWith('refs/remotes/'), date: Number(date) * 1000, hash, subject: subject.join('\t') }));
  const tags = (await lines(['for-each-ref', '--sort=-creatordate', '--count=50', '--format=%(refname:short)%09%(creatordate:unix)%09%(objectname:short)', 'refs/tags']))
    .map((l) => l.split('\t'))
    .map(([name, date, hash]) => ({ name, date: Number(date) * 1000, hash }));
  const commits = (await lines(['log', '-40', '--format=%h%x09%ct%x09%an%x09%s', 'HEAD']))
    .map((l) => l.split('\t'))
    .map(([hash, date, author, ...subject]) => ({ hash, date: Number(date) * 1000, author, subject: subject.join('\t') }));
  const names = new Set([current, ...branches.map((b) => b.name)]);
  const target = ['develop', 'main', 'master', 'origin/develop', 'origin/main', 'origin/master'].find((n) => names.has(n));
  return { ...(current && current !== 'HEAD' ? { current } : {}), ...(upstream ? { upstream } : {}), ...(target ? { target } : {}), branches, tags, commits };
}
