#!/usr/bin/env node
/**
 * Leak check before anything goes public (AGENTS.md, Smoke tests: nothing from the developers' real repositories,
 * no company names). The forbidden words are never in git — the check itself must not leak them: they come from
 * `.leak-check.json` (git-ignored, per developer) or the env `LEAK_WORDS` (one regex per line; a CI secret).
 * Always on, without a list: home-folder paths and e-mail addresses outside the allowed domains.
 *
 *   node scripts/leak-check.mjs                    the tracked files (all of them go public)
 *   node scripts/leak-check.mjs --staged           the staged version of the files a commit adds or changes (pre-commit)
 *   node scripts/leak-check.mjs --message <file>   a commit message (commit-msg hook)
 *   node scripts/leak-check.mjs <path>…            files, folders and packages (.vsix / .zip / .tar.gz, read inside)
 *   node scripts/leak-check.mjs --compare          also: identifiers of the tracked files that occur in the real
 *                                                  repositories (`compare` in .leak-check.json; read only) — names
 *                                                  nobody put on the list. An audit to read, not a gate.
 *
 * .leak-check.json: { "words": ["\\bacme\\b", "AcmeShop"], "allow": ["acme-free"], "compare": ["~/git/acme/shop"] }
 * Exit 1 when a word or a rule matched (not for --compare's list).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Addresses that name no one: placeholders, bots, the commit trailers. */
const ALLOWED_MAIL = /@(example\.(com|org|net)|[\w-]+\.(test|example|invalid|local)|noreply\.github\.com|users\.noreply\.github\.com|anthropic\.com|github\.com)$/i;

export const RULES = [
  // a developer's own folder: /home/<user>/…, /Users/<user>/…, C:\Users\<user>\… — placeholders like <user> are fine
  // (not a URL's path: `example.org/en/home/tables`)
  { kind: 'home path', re: /(?<![\w.-])(?:\/home\/|\/Users\/|[A-Z]:\\\\?Users\\\\?)(?!<|\$|\{|user\b|runner\b|me\b|you\b|name\b|alice\b|bob\b)[a-z][\w.-]+/g },
  { kind: 'e-mail', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, keep: (m) => !ALLOWED_MAIL.test(m) },
];

/** The generated third-party notices quote the copyright lines of other projects, e-mail addresses included. */
const THIRD_PARTY_NOTICES = /(^|[\/!])THIRD-PARTY-NOTICES\.txt$/;

/** The rules for one file: all of them, except the e-mail rule in the third-party notices. */
export function rulesFor(name, rules) {
  return THIRD_PARTY_NOTICES.test(name) ? rules.filter((r) => r.kind !== 'e-mail') : rules;
}

/**
 * The word list: `words` of the config plus LEAK_WORDS lines; each a case-insensitive regex. An `allow` regex
 * matching the text around a hit (40 characters each side — a minified bundle is one long line) drops it: a
 * library's own use of a word (`NodePromotion` of a layout engine).
 */
export function wordRules(config = {}, env = '') {
  const words = [...(config.words ?? []), ...env.split('\n').map((w) => w.trim()).filter(Boolean)];
  const allow = (config.allow ?? []).map((a) => new RegExp(a, 'i'));
  return words.map((w) => ({ kind: 'word', re: new RegExp(w, 'gi'), keep: (m, around) => !allow.some((a) => a.test(around)) }));
}

/** Hits in one text: [{ line, kind, match, text }]. */
export function hitsIn(text, rules) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const r of rules) {
      for (const m of line.matchAll(r.re)) {
        if (r.keep && !r.keep(m[0], line.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))) continue;
        const from = line.length > 160 ? Math.max(0, m.index - 60) : 0;
        out.push({ line: i + 1, kind: r.kind, match: m[0], text: line.slice(from, from + 160).trim() });
      }
    }
  });
  return out;
}

/** Identifiers worth comparing: compound names (`OrderService`, `TYPE_REFUND`), not plain words or short ones. */
export function identifiers(text) {
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{5,}/g)) {
    const w = m[0];
    // hashes and keys (a lock file's integrity, base64) are no names: long, or digits spread through them
    if (w.length > 40 || (w.match(/\d/g)?.length ?? 0) > 2) continue;
    if (/[a-z][A-Z]|[A-Z]{2,}[a-z]|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(w)) out.add(w);
  }
  return out;
}

const binary = (buf) => buf.subarray(0, 8000).includes(0);

/** The texts of a file, a folder or a package: [{ name, text }]. */
function texts(path, base) {
  const st = statSync(path);
  if (st.isDirectory()) {
    return readdirSync(path).filter((n) => n !== 'node_modules' && n !== '.git').flatMap((n) => texts(join(path, n), base));
  }
  const name = relative(base, path) || path;
  if (/\.(vsix|zip)$/i.test(path)) {
    const list = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter((f) => f && !f.endsWith('/'));
    return list.flatMap((f) => {
      // unzip reads member names as patterns: `[Content_Types].xml` of a .vsix needs its brackets escaped
      const buf = execFileSync('unzip', ['-p', path, f.replace(/[[*?]/g, '[$&]')], { maxBuffer: 512 << 20 });
      return binary(buf) ? [] : [{ name: `${name}!${f}`, text: buf.toString('utf8') }];
    });
  }
  if (/\.(tar\.gz|tgz)$/i.test(path)) {
    const list = execFileSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter((f) => f && !f.endsWith('/'));
    return list.flatMap((f) => {
      const buf = execFileSync('tar', ['-xzOf', path, f], { maxBuffer: 512 << 20 });
      return binary(buf) ? [] : [{ name: `${name}!${f}`, text: buf.toString('utf8') }];
    });
  }
  const buf = readFileSync(path);
  return binary(buf) ? [] : [{ name, text: buf.toString('utf8') }];
}

/** The check's own test: its samples are hits on purpose. */
const SELF_TEST = 'scripts/test/leak-check.test.ts';

const git = (args, opts = {}) => execFileSync('git', args, { cwd: repo, maxBuffer: 512 << 20, ...opts });

function trackedFiles() {
  return git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && f !== SELF_TEST);
}

/** What a commit records: the index's version of each added / changed file, not the working tree's. */
function stagedTexts() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && f !== SELF_TEST);
  return files.flatMap((f) => {
    const buf = git(['show', `:${f}`]);
    return binary(buf) ? [] : [{ name: f, text: buf.toString('utf8') }];
  });
}

const SOURCE = /\.(cs|php|ts|tsx|js|jsx|mjs|cjs|vue|json|ya?ml|md|cshtml|razor|blade\.php)$/i;
const LOCK = /(^|[-.])lock(\.json)?$|\.lock$|lockfile/i;
const SKIP_DIR = new Set(['node_modules', 'vendor', '.git', 'bin', 'obj', 'dist', 'build', 'storage', 'public', 'coverage', '.idea', '.vs']);

/** Identifiers of a real repository's own source (dependencies, builds and assets skipped). */
function repoIdentifiers(dir, into = new Set()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) repoIdentifiers(join(dir, e.name), into);
    } else if (SOURCE.test(e.name) && !LOCK.test(e.name)) {
      let st;
      try { st = statSync(join(dir, e.name)); } catch { continue; }
      if (st.size > 2 << 20) continue;
      for (const id of identifiers(readFileSync(join(dir, e.name), 'utf8'))) into.add(id);
    }
  }
  return into;
}

const LIBRARY = /\.(d\.ts|php|xml)$/i;

/**
 * Identifiers of public libraries — `vendor/`, `node_modules/` (type declarations), the NuGet cache's API docs: a
 * name found there is the framework's, not the company's. Every folder below `dir` is read, dependencies included.
 */
function libraryIdentifiers(dir, into = new Set()) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return into; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name !== '.git' && e.name !== 'tests' && e.name !== 'test') libraryIdentifiers(join(dir, e.name), into);
    } else if (LIBRARY.test(e.name)) {
      let st;
      try { st = statSync(join(dir, e.name)); } catch { continue; }
      if (st.size > 4 << 20) continue;
      for (const id of identifiers(readFileSync(join(dir, e.name), 'utf8'))) into.add(id);
    }
  }
  return into;
}

/** The library folders: this repository's node_modules, the real repositories' vendor/ and node_modules/, `libraries`. */
function libraryFolders(compareDirs, config) {
  const own = [join(repo, 'node_modules')];
  const deps = compareDirs.flatMap((d) => findDirs(d, new Set(['vendor', 'node_modules']), 3));
  return [...own, ...deps, ...(config.libraries ?? []).map((d) => resolve(d.replace(/^~(?=\/)/, homedir())))];
}

/** Folders named like `names` up to `depth` levels below `dir` (not inside each other). */
function findDirs(dir, names, depth) {
  if (depth < 0) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .flatMap((e) => (names.has(e.name) ? [join(dir, e.name)] : findDirs(join(dir, e.name), names, depth - 1)));
}

function main(argv) {
  const configFile = join(repo, '.leak-check.json');
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  const rules = [...RULES, ...wordRules(config, process.env.LEAK_WORDS ?? '')];
  if (!config.words?.length && !process.env.LEAK_WORDS) console.warn('[leak-check] no word list (.leak-check.json or LEAK_WORDS): only home paths and e-mail addresses are checked');

  const message = argv.indexOf('--message');
  const paths = argv.filter((a, i) => !a.startsWith('--') && i !== message + 1);
  const items =
    message >= 0
      ? [{ name: 'commit message', text: readFileSync(argv[message + 1], 'utf8').replace(/^#.*\n?/gm, '') }]
      : argv.includes('--staged')
        ? stagedTexts()
        : paths.length
          ? paths.flatMap((p) => texts(resolve(p), process.cwd()))
          : trackedFiles().filter((f) => existsSync(join(repo, f))).flatMap((f) => texts(join(repo, f), repo));

  let hits = 0;
  for (const { name, text } of items) {
    for (const h of hitsIn(text, rulesFor(name, rules))) {
      hits++;
      console.log(`${name}:${h.line}  [${h.kind}] ${h.match}  — ${h.text}`);
    }
  }
  console.log(`[leak-check] ${items.length} files, ${hits} hit${hits === 1 ? '' : 's'}`);

  if (argv.includes('--compare')) {
    const dirs = (config.compare ?? []).map((d) => resolve(d.replace(/^~(?=\/)/, homedir())));
    if (!dirs.length) console.warn('[leak-check] --compare: no "compare" folders in .leak-check.json');
    const real = new Set();
    for (const d of dirs) repoIdentifiers(d, real);
    const library = new Set();
    for (const d of libraryFolders(dirs, config)) libraryIdentifiers(d, library);
    const where = new Map();
    for (const { name, text } of items) {
      if (LOCK.test(name)) continue;
      for (const id of identifiers(text)) if (real.has(id) && !library.has(id)) where.set(id, [...(where.get(id) ?? []), name]);
    }
    console.log(`\n[leak-check] --compare: ${where.size} identifiers of these files also occur in the real repositories and in no library (judge each):`);
    for (const [id, files] of [...where].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))) {
      console.log(`  ${id}  (${files.length}) ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`);
    }
  }
  return hits ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
