import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DiagramStateSnapshot } from '@seqcall/protocol';
import { codeDifferences, gitState, limitChanged, locateStateFile, parseState, readConfigText, stateFileName, type GitState } from '../src/session/share';

// FR-25.2 a shared diagram's state: the code's git state, what differs on the receiving side, where its file is here.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-share-'))).replace(/\\/g, '/');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();
const state = (over: Partial<DiagramStateSnapshot> = {}): DiagramStateSnapshot =>
  ({ format: 'seqcall-state', schemaVersion: 1, createdAt: '', project: { name: 'x', language: 'typescript' }, root: { key: 'src/a.ts#A.run', label: 'A.run' }, expanded: [], choices: {}, interfaceChoices: {}, filters: [], options: {}, seen: { messages: 0, participants: 0 }, ...over }) as DiagramStateSnapshot;
const g = (commit: string, changed: string[] = [], branch?: string): GitState => ({ dir: '', commit, changed, ...(branch ? { branch } : {}) });

describe('FR-25.2 the git state of the shared code', () => {
  it('FR-25.2 a project at the top of its repository: renamed and copied files once (their new name), untracked ones; detached HEAD has no branch', async () => {
    const repo = `${tmp}/top`;
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(`${repo}/a.ts`, 'export const a = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    git(repo, 'mv', 'a.ts', 'b.ts');
    fs.writeFileSync(`${repo}/new.ts`, 'x\n');
    const s = (await gitState(repo))!;
    expect(s).toMatchObject({ dir: '', branch: 'main', changed: ['b.ts', 'new.ts'] });
    git(repo, 'checkout', '-q', '--detach');
    expect(await gitState(repo)).not.toHaveProperty('branch');
    expect(await gitState(tmp)).toBeUndefined(); // not a repository
  });

  it('FR-25.2 no layer config: none; a long list of changed files is cut', () => {
    expect(readConfigText(`${tmp}/nowhere`)).toBeUndefined();
    const many = Array.from({ length: 52 }, (_, i) => `f${i}.ts`);
    expect(limitChanged(many)).toEqual([...many.slice(0, 50), '… +2 more']);
    expect(limitChanged(['a.ts'])).toEqual(['a.ts']);
  });

  it('FR-25.2 the file name of a root without letters; a state without a root method is refused', () => {
    expect(stateFileName(state({ root: { key: 'k', label: '<>' } }))).toBe('diagram.seqcall.json');
    expect(() => parseState(JSON.stringify({ ...state(), root: { label: 'x' } }))).toThrow('The shared diagram has no root method.');
    expect(() => parseState(JSON.stringify({ ...state(), root: undefined }))).toThrow('The shared diagram has no root method.');
  });
});

describe('FR-25.2 what differs on the receiving side', () => {
  const here = (over: Partial<Parameters<typeof codeDifferences>[1]> = {}) => ({ language: 'typescript', autoSelect: true, ...over });

  it('FR-25.2 another language, another commit (with or without branches), the sender\'s and your own uncommitted files', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => `${f}.ts`);
    expect(codeDifferences(state({ project: { name: 'x', language: 'csharp' }, git: g('1111111aaaa', six, 'feature/x') }), here({ git: g('2222222bbbb', ['a.ts', 'mine.ts']) }))).toEqual([
      'The state is from a csharp project, this one is typescript.',
      'Other commit: the sender was on 1111111 (feature/x), you are on 2222222.',
      'The sender had uncommitted changes in 6 files: a.ts, b.ts, c.ts, d.ts, e.ts … +1.',
      'You have uncommitted changes the sender did not have: mine.ts.',
    ]);
    expect(codeDifferences(state({ git: g('1111111aaaa', ['a.ts']) }), here({ git: g('1111111aaaa', ['a.ts'], 'main') }))).toEqual(['The sender had uncommitted changes in 1 file: a.ts.']);
    expect(codeDifferences(state({ git: g('1111111aaaa') }), here({ git: g('3333333', [], 'main') }))).toEqual(['Other commit: the sender was on 1111111, you are on 3333333 (main).']);
  });

  it('FR-25.2 your project without git; layer configs on one side only or different; the pre-selection setting either way', () => {
    expect(codeDifferences(state({ git: g('1111111aaaa') }), here())).toEqual(["The sender's code is commit 1111111; this project is not in a git repository, so it cannot be compared."]);
    expect(codeDifferences(state(), here({ git: g('1') }))).toEqual([]);
    expect(codeDifferences(state(), here({ config: '{}' }))).toEqual(['The layer configuration (.seqcall.json) differs (the sender had none).']);
    expect(codeDifferences(state({ config: '{}' }), here())).toEqual(['The layer configuration (.seqcall.json) differs (you have none).']);
    expect(codeDifferences(state({ config: '{"a":1}' }), here({ config: '{}' }))).toEqual(['The layer configuration (.seqcall.json) differs.']);
    expect(codeDifferences(state({ autoSelectSingleImplementation: false }), here())).toEqual(['The setting "pre-select the only implementation" is on here, off for the sender.']);
    expect(codeDifferences(state({ autoSelectSingleImplementation: true }), here({ autoSelect: false }))).toEqual(['The setting "pre-select the only implementation" is off here, on for the sender.']);
    expect(codeDifferences(state({ autoSelectSingleImplementation: true }), here())).toEqual([]);
  });
});

describe('FR-25.2 where the shared root file is here', () => {
  it('FR-25.2 below a search root; or as the sender\'s project folder below the search root\'s repository; a root without a file: nowhere', async () => {
    const repo = `${tmp}/mono`;
    fs.mkdirSync(`${repo}/apps/web/src`, { recursive: true });
    fs.writeFileSync(`${repo}/apps/web/src/a.ts`, 'x');
    git(repo, 'init', '-q');
    expect(await locateStateFile(state(), [`${repo}/apps/web`])).toBe(`${repo}/apps/web/src/a.ts`);
    // opened at the repository top: the sender's project folder below it
    expect(await locateStateFile(state({ project: { name: 'web', language: 'typescript', dir: 'apps/web' } }), [repo])).toBe(`${repo}/apps/web/src/a.ts`);
    // not a repository: only the search root itself
    const plain = `${tmp}/plain`;
    fs.mkdirSync(plain);
    expect(await locateStateFile(state({ project: { name: 'web', language: 'typescript', dir: 'apps/web' } }), [plain])).toBeUndefined();
    // a key without a file part: nowhere (not the file named like the key without its last letter)
    fs.writeFileSync(`${repo}/unknow`, 'x');
    expect(await locateStateFile(state({ root: { key: 'unknown', label: 'x' } }), [repo])).toBeUndefined();
    expect(await locateStateFile(state({ root: { key: '#X.run', label: 'x' } }), [repo])).toBeUndefined();
  });
});
