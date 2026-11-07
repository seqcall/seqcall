import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isInside, isSourceFile, locateProject, locateWorkspace, pathKey } from '../src/locate';

// Project trees in a temp dir. The results below assume no project marker (tsconfig.json, package.json, *.sln,
// *.csproj, composer.json) in the temp dir's own parents.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-locate-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const put = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(`${tmp}/${rel}`), { recursive: true });
  fs.writeFileSync(`${tmp}/${rel}`, text);
  return `${tmp}/${rel}`;
};

describe('FR-15.1 locating the project of a file without an editor API', () => {
  it('FR-15.1 Windows paths from the editor compare with any drive-letter case and either slash', () => {
    expect(pathKey('C:\\Work\\src\\a.ts')).toBe('c:/Work/src/a.ts');
    expect(isInside('C:\\Work\\src\\a.ts', 'c:/Work/')).toBe(true);
    expect(isInside('c:/Work', 'C:\\Work')).toBe(true);
    expect(isInside('C:\\Workshop\\a.ts', 'c:/Work')).toBe(false);
  });

  it('FR-15.1 only analysed files are source files: not node_modules, declarations or C# build output (Windows paths too)', () => {
    expect(isSourceFile('C:\\p\\src\\a.ts')).toBe(true);
    expect(isSourceFile('C:\\p\\node_modules\\x\\index.js')).toBe(false);
    expect(isSourceFile('/p/src/types.d.ts')).toBe(false);
    expect(isSourceFile('C:\\p\\bin\\Debug\\A.cs')).toBe(false);
    expect(isSourceFile('/p/README.md')).toBe(false);
  });

  it('FR-15.1 TS: the nearest tsconfig inside the IDE project, else the IDE project; outside it the nearest package.json, else the folder', () => {
    put('outer/tsconfig.json', '{}');
    // the tsconfig above the IDE's project is not this project's
    expect(locateProject(put('outer/ws/src/a.ts'), `${tmp}/outer/ws`)).toEqual({ root: `${tmp}/outer/ws`, language: 'typescript' });
    expect(locateProject(put('outer/ws/app/tsconfig.json', '{}').replace('tsconfig.json', 'main.ts'), `${tmp}/outer/ws`)).toEqual({ root: `${tmp}/outer/ws/app`, language: 'typescript' });
    // a file outside the IDE's project
    put('pkg/package.json', '{}');
    expect(locateProject(put('pkg/lib/b.ts'), `${tmp}/outer/ws`)).toEqual({ root: `${tmp}/pkg`, language: 'typescript' });
    expect(locateProject(put('loose/c.ts'))).toEqual({ root: `${tmp}/loose`, language: 'typescript' });
  });

  it('FR-15.1 C#: the nearest solution, else the nearest project, else the IDE project or the folder; a file not saved yet in a new folder too', () => {
    put('cs/App.sln');
    put('cs/Lib/Lib.csproj');
    expect(locateProject(`${tmp}/cs/Lib/New/Folder/A.cs`)).toEqual({ root: `${tmp}/cs`, language: 'csharp' });
    put('proj/Lib/Lib.csproj');
    expect(locateProject(put('proj/Lib/Model/X.cs'))).toEqual({ root: `${tmp}/proj/Lib`, language: 'csharp' });
    const bare = put('bare/src/Y.cs');
    expect(locateProject(bare, `${tmp}/bare`)).toEqual({ root: `${tmp}/bare`, language: 'csharp' });
    expect(locateProject(bare)).toEqual({ root: `${tmp}/bare/src`, language: 'csharp' });
  });

  it('FR-18.1 PHP without composer.json: the IDE project, else the folder', () => {
    const file = put('php/src/Z.php');
    expect(locateProject(file, `${tmp}/php`)).toEqual({ root: `${tmp}/php`, language: 'php' });
    expect(locateProject(file)).toEqual({ root: `${tmp}/php/src`, language: 'php' });
  });

  it('FR-16 a workspace folder: C# with a solution or a project, PHP with composer.json alone, else TypeScript', () => {
    expect(locateWorkspace(`${tmp}/cs`)).toEqual({ root: `${tmp}/cs`, language: 'csharp' });
    expect(locateWorkspace(`${tmp}/proj/Lib`)).toEqual({ root: `${tmp}/proj/Lib`, language: 'csharp' });
    put('shop/composer.json', '{}');
    expect(locateWorkspace(`${tmp}/shop`)).toEqual({ root: `${tmp}/shop`, language: 'php' });
    put('mixed/composer.json', '{}');
    put('mixed/tsconfig.json', '{}');
    expect(locateWorkspace(`${tmp}/mixed`)).toEqual({ root: `${tmp}/mixed`, language: 'typescript' });
  });
});
