import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LanguageAdapter } from '../src/adapter';
import { createBaseAdapter } from '../src/review/base-version';
import { branchChanges } from '../src/review/git-changes';

// FR-24.6 the base version of a review: which files the base adapter sees with which content. A repository whose
// project is app/; the branch modifies, deletes, renames, adds, moves a file in from outside the project and bumps a
// submodule.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-base-'))).replace(/\\/g, '/');
const repo = `${tmp}/repo`;
const app = `${repo}/app`;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'pipe' }).toString();

beforeAll(() => {
  fs.mkdirSync(`${tmp}/lib`);
  git(`${tmp}/lib`, 'init', '-q');
  fs.writeFileSync(`${tmp}/lib/readme`, '1\n');
  git(`${tmp}/lib`, 'add', '.');
  git(`${tmp}/lib`, 'commit', '-q', '-m', 'lib 1');
  write('app/src/kept.ts', 'export const kept = 1;\n');
  write('app/src/gone.ts', 'export const gone = 1;\n');
  write('app/src/old.ts', 'export class Old {\n  m() {\n    return 1;\n  }\n}\n');
  write('shared/moved.ts', 'export class Moved {\n  m() {\n    return 1;\n  }\n}\n');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'develop');
  git(repo, 'submodule', 'add', '-q', `${tmp}/lib`, 'app/lib');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'checkout', '-q', '-b', 'feature');
  write('app/src/kept.ts', 'export const kept = 2;\n');
  fs.rmSync(`${app}/src/gone.ts`);
  git(repo, 'mv', 'app/src/old.ts', 'app/src/renamed.ts');
  git(repo, 'mv', 'shared/moved.ts', 'app/src/moved.ts');
  write('app/src/new.ts', 'export const added = 1;\n');
  fs.writeFileSync(`${app}/lib/readme`, '2\n');
  git(`${app}/lib`, 'commit', '-q', '-am', 'lib 2');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feature');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('FR-24.6 the base version of a review', () => {
  it('FR-24.6 changed files get their content at the merge base: new paths empty, a rename moves back, a submodule has none', async () => {
    const changes = await branchChanges(app, 'develop');
    expect(changes.files.map((f) => `${f.status} ${f.file}${f.from ? ` ← ${f.from}` : ''}`).sort()).toEqual([
      'added src/moved.ts',
      'added src/new.ts',
      'deleted src/gone.ts',
      'modified lib',
      'modified src/kept.ts',
      'renamed src/renamed.ts ← src/old.ts',
    ]);
    // every update, in order, each file once
    const seen: string[] = [];
    const fake = { updateFile: async (file: string, text: string) => void seen.push(`${file.slice(app.length + 1)}=${JSON.stringify(text)}`) } as unknown as LanguageAdapter;
    expect(await createBaseAdapter(() => fake, app, changes)).toBe(fake);
    const expected: Record<string, string> = {
      // a submodule's commit is not a file git can show at the base: empty
      lib: '',
      'src/gone.ts': 'export const gone = 1;\n',
      'src/kept.ts': 'export const kept = 1;\n',
      // moved into the project from outside: new in the project (git reports it as added)
      'src/moved.ts': '',
      'src/new.ts': '',
      'src/old.ts': 'export class Old {\n  m() {\n    return 1;\n  }\n}\n',
      'src/renamed.ts': '',
    };
    expect([...seen].sort()).toEqual(Object.entries(expected).map(([f, t]) => `${f}=${JSON.stringify(t)}`).sort());
    // a rename: the new path is emptied before the old one comes back
    expect(seen.indexOf('src/renamed.ts=""')).toBe(seen.findIndex((x) => x.startsWith('src/old.ts=')) - 1);
  });
});
