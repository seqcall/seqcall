import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverProjects, folderProject } from '../src/projects';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-projects-')).replace(/\\/g, '/');
const touch = (rel: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), '{}');
};
// like a large C# solution: the solution one level down; a web app beside it; dependencies and build output not searched
touch('suite/Platform/Platform.sln');
touch('suite/Platform/Api/Api.csproj');
touch('suite/web/tsconfig.json');
touch('suite/web/node_modules/lib/tsconfig.json');
touch('suite/Platform/Api/bin/x/composer.json');
touch('shop/composer.json');
touch('shop/vendor/acme/pkg/composer.json');
touch('app/tsconfig.json');
touch('app/packages/core/tsconfig.json');
fs.mkdirSync(path.join(root, 'empty'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-16.4 projects of a workspace folder', () => {
  it('FR-16.4 finds the projects below a folder by their markers; dependency and build folders are skipped', () => {
    expect(discoverProjects([`${root}/suite`]).map((p) => `${p.language} ${p.root.slice(root.length)}`)).toEqual(['csharp /suite/Platform', 'typescript /suite/web']);
    expect(discoverProjects([`${root}/shop`]).map((p) => p.language)).toEqual(['php']);
    // a folder that cannot be read has no projects
    expect(discoverProjects([`${root}/missing`, `${root}/shop`]).map((p) => p.language)).toEqual(['php']);
  });

  it('FR-16.4 a folder that is a C# and a TypeScript root at once is both (C# first); five levels down at most', () => {
    touch('both/App.sln');
    touch('both/tsconfig.json');
    touch('deep/1/2/3/4/5/tsconfig.json');
    touch('deep/1/2/3/4/5/6/composer.json');
    const found = (dir: string) => discoverProjects([`${root}/${dir}`]).map((p) => `${p.language} ${p.root.slice(root.length)}`);
    expect(found('both')).toEqual(['csharp /both', 'typescript /both']);
    expect(found('deep')).toEqual(['typescript /deep/1/2/3/4/5']);
  });

  it('FR-16.4 nothing open: the folder when it is a project, else the project nearest below it (suite → Platform), else none', () => {
    expect(folderProject(`${root}/suite`)).toEqual({ root: `${root}/suite/Platform`, language: 'csharp' });
    expect(folderProject(`${root}/app`)).toEqual({ root: `${root}/app`, language: 'typescript' });
    expect(folderProject(`${root}/shop`)).toEqual({ root: `${root}/shop`, language: 'php' });
    expect(folderProject(`${root}/empty`)).toBeUndefined();
    expect(folderProject(`${root}/missing`)).toBeUndefined();
  });
});
