import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { compare, configOf, copyAt, labels, parseArgs, parseRepoList, pinOf, run } from '../baseline.mjs';

const temp: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-baseline-test-'));
  temp.push(d);
  return d;
};
afterAll(() => temp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });

/** A measurement with two entry points; `over` replaces parts of it. */
const measurement = (over: Record<string, unknown> = {}) => ({
  language: 'typescript',
  entryPoints: ['a#A.run', 'b#B.run'],
  entries: {
    'a#A.run': { label: 'GET /a', opened: 2, smart: 6, unknown: 1, ms: 10 },
    'b#B.run': { label: 'GET /b', opened: 2, smart: 4, unknown: 0, ms: 10 },
  },
  findings: ['layer-violation: Layer violation: Order → Db'],
  calls: { project: 90, library: 5, unknown: 5 },
  ms: 1000,
  ...over,
});

describe('quality baseline (scripts/baseline.mjs)', () => {
  it('reads the repositories of the local list: backticked absolute paths of list items, the missing ones apart', () => {
    const md = [
      '# Smoke-test repositories',
      'Prose with `/prose/path` is not a repository.',
      '## TypeScript',
      '- `/repos/shop` — layered TS (entry `src/main.ts`).',
      '- `/repos/billing/` (99%), `/repos/stock` (95%), again `/repos/shop`',
      '## C#',
      '* `/repos/gone` — removed since',
      '- `~/relative` and `/repos/shop/src/x.ts` (not a folder)',
    ].join('\n');
    const dirs = new Set(['/repos/shop', '/repos/billing', '/repos/stock', '/prose/path']);
    expect(parseRepoList(md, (p: string) => dirs.has(p))).toEqual({
      paths: ['/repos/shop', '/repos/billing', '/repos/stock'],
      missing: ['/repos/gone', '/repos/shop/src/x.ts'],
    });
  });

  it('names each repository by its folder, with the parent folder when two share a name', () => {
    expect(labels(['/a/shop/api', '/b/billing/api', '/c/stock', '/d/my repo'])).toEqual(['shop-api', 'billing-api', 'stock', 'my_repo']);
  });

  it('reads its options', () => {
    expect(parseArgs(['--update', 'shop', '--max', '10', '--dir', '/x'])).toMatchObject({ update: true, only: 'shop', max: 10, dir: '/x' });
    expect(parseArgs(['--update', '--only', 'shop'])).toMatchObject({ update: true, only: 'shop', max: 40 });
    expect(() => parseArgs(['--fast'])).toThrow('unknown option --fast');
  });

  it('the same measurement twice: no regression, nothing to report', () => {
    expect(compare(measurement(), measurement())).toEqual({ regressions: [], notes: [] });
  });

  it('a lost entry point, a flow that fails now and a drop of resolved calls are regressions', () => {
    const now = measurement({
      entryPoints: ['a#A.run', 'c#C.run'],
      entries: { 'a#A.run': { label: 'GET /a', opened: 0, smart: 0, unknown: 0, ms: 5, error: 'boom' } },
      calls: { project: 80, library: 5, unknown: 15 },
    });
    const { regressions, notes } = compare(measurement(), now);
    expect(regressions).toEqual(['1 entry point(s) no longer found: b#B.run', 'fails now: GET /a: boom', 'resolved calls in the flows 95.0 % → 85.0 %']);
    expect(notes).toEqual(['1 new entry point(s): c#C.run']);
  });

  it('a drop of at most one point, other flow sizes, new and gone findings and a fixed flow are notes for a person to judge', () => {
    const base = measurement();
    base.entries['b#B.run'] = { ...base.entries['b#B.run'], error: 'boom' } as never;
    const now = measurement({
      entries: { 'a#A.run': { label: 'GET /a', opened: 2, smart: 9, unknown: 2, ms: 10 }, 'b#B.run': { label: 'GET /b', opened: 2, smart: 4, unknown: 0, ms: 10 } },
      findings: ['io-in-loop: I/O in a loop: Shop.sync (DB)'],
      calls: { project: 89, library: 5, unknown: 6 },
      ms: 9000,
    });
    const { regressions, notes } = compare(base, now);
    expect(regressions).toEqual([]);
    expect(notes).toEqual([
      'works now: GET /b',
      'resolved calls in the flows 95.0 % → 94.0 %',
      'Smart flow changed in 1 entry point(s):',
      '  GET /a: 6 → 9 messages, 1 → 2 unknown',
      '1 new finding(s), true or false?',
      '  + io-in-loop: I/O in a loop: Shop.sync (DB)',
      '1 finding(s) gone:',
      '  - layer-violation: Layer violation: Order → Db',
      'slower: 1.0 s → 9.0 s',
    ]);
  });

  it('PHP: the resolution of all methods and methods whose analysis fails count too', () => {
    const all = (unknown: number, crashes: number) => ({ methods: 10, project: 90 - unknown, library: 10, unknown, crashes });
    const { regressions } = compare(measurement({ allCalls: all(0, 0) }), measurement({ allCalls: all(5, 1) }));
    expect(regressions).toEqual(['resolved calls of all 10 methods 100.0 % → 95.0 %', 'methods whose analysis fails: 0 → 1']);
    expect(compare(measurement({ allCalls: all(0, 0) }), measurement({ allCalls: all(0, 0) }))).toEqual({ regressions: [], notes: [] });
  });

  it('copies a folder of a repository as it was at the pinned commit, with the layer config given; the repository is only read', () => {
    const repo = tempDir();
    fs.mkdirSync(path.join(repo, 'apps', 'api', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps', 'api', 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'top.txt'), 'outside the folder');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const folder = path.join(repo, 'apps', 'api');
    const pin = pinOf(folder);
    expect(pin).toMatchObject({ prefix: 'apps/api/' });
    // later: a new commit and an uncommitted layer config
    fs.writeFileSync(path.join(folder, 'src', 'a.ts'), 'export const a = 2;\n');
    git(repo, 'commit', '-q', '-am', 'two');
    fs.writeFileSync(path.join(folder, '.seqcall.json'), '{"layers": []}');
    const copy = copyAt(folder, pin, configOf(folder));
    temp.push(copy);
    expect(fs.readFileSync(path.join(copy, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(fs.readFileSync(path.join(copy, '.seqcall.json'), 'utf8')).toBe('{"layers": []}');
    expect(fs.existsSync(path.join(copy, 'top.txt'))).toBe(false);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('?? apps/api/.seqcall.json\n');
  });

  it('a folder outside git: its current files, without dependencies and build output', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'a');
    fs.writeFileSync(path.join(dir, 'src', 'bin', 'b.dll'), 'b');
    expect(pinOf(dir)).toBeUndefined();
    const copy = copyAt(dir, undefined, undefined);
    temp.push(copy);
    expect(fs.readdirSync(copy)).toEqual(['src']);
    expect(fs.readdirSync(path.join(copy, 'src'))).toEqual(['a.ts']);
  });

  it('first run pins and measures, the next compares on the same commit (end to end on the sample app)', async () => {
    const repo = tempDir();
    fs.cpSync(path.join(__dirname, '../../fixtures/sample-app'), repo, { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const list = path.join(tempDir(), 'smoke-tests-repos.md');
    fs.writeFileSync(list, `## TypeScript\n- \`${repo}\` — the sample\n- \`${repo}-gone\`\n`);
    const dir = tempDir();
    const said: string[] = [];
    const log = (s: string) => said.push(s);
    expect(await run({ list, dir, max: 5, update: false }, log)).toBe(0);
    const name = path.basename(repo);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    expect(saved.pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.measurement.entryPoints.length).toBeGreaterThan(0);
    // a new commit does not change what is measured
    fs.rmSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'commit', '-q', '-am', 'two');
    expect(await run({ list, dir, max: 5, update: false }, log)).toBe(0);
    expect(said.filter((s) => !/s → /.test(s))).toEqual([
      `[baseline] not found, skipped: ${repo}-gone`,
      `[baseline] ${name} (${repo} at ${saved.pin.commit.slice(0, 10)})`,
      expect.stringMatching(/^ {2}baseline created: 1 of 1 entry points, /),
      `[baseline] not found, skipped: ${repo}-gone`,
      `[baseline] ${name} (${repo} at ${saved.pin.commit.slice(0, 10)})`,
      '  no change',
    ]);
    said.length = 0;
    expect(await run({ list, dir, max: 5, update: false, only: 'nope' }, log)).toBe(1);
    expect(said.at(-1)).toBe(`[baseline] no repository named nope (${name})`);
    expect(await run({ list: path.join(dir, 'none.md'), dir, max: 5, update: false }, log)).toBe(0);
    expect(said.at(-1)).toMatch(/no repository list/);
  });
});
