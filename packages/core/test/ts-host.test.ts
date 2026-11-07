import * as fs from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverProject, ProjectHost } from '../src/ts/host';
import { tsProject, writeProject } from './ts-project';

// FR-15.1 / FR-13.1 which files the TS program is made of: tsconfig / jsconfig / a scan of the sources, and the
// files the editor reports as changed.

const rels = (root: string, files: string[]) => files.map((f) => f.slice(root.length + 1)).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discoverProject (FR-15.1)', () => {
  it('FR-15.1 tsconfig.json first: its files and options (no emit)', () => {
    const root = writeProject({ 'src/a.ts': '', 'other/b.ts': '', 'jsconfig.json': '{}' }, { compilerOptions: { strict: true }, include: ['src'] });
    const p = discoverProject(root);
    expect(rels(root, p.fileNames)).toEqual(['src/a.ts']);
    expect(p.configFile).toBe(`${root}/tsconfig.json`);
    expect(p.options.strict).toBe(true);
    expect(p.options.noEmit).toBe(true);
  });

  it('FR-15.1 jsconfig.json when there is no tsconfig.json: JavaScript files are part of the program (allowJs)', () => {
    const root = writeProject({ 'jsconfig.json': JSON.stringify({ include: ['lib'] }), 'lib/a.js': '', 'lib/b.ts': '', 'c.js': '' }, false);
    const p = discoverProject(root);
    expect(rels(root, p.fileNames)).toEqual(['lib/a.js', 'lib/b.ts']);
    expect(p.configFile).toBe(`${root}/jsconfig.json`);
    expect(p.options.allowJs).toBe(true);
    // a jsconfig copied with `allowJs: false`: still a JavaScript project
    const off = writeProject({ 'jsconfig.json': JSON.stringify({ compilerOptions: { allowJs: false }, include: ['lib'] }), 'lib/a.js': '', 'lib/b.ts': '' }, false);
    expect(rels(off, discoverProject(off).fileNames)).toEqual(['lib/a.js', 'lib/b.ts']);
  });

  it('FR-15.1 a tsconfig.json that matches no file falls back to jsconfig.json, then to a scan of the sources', () => {
    const root = writeProject({ 'jsconfig.json': JSON.stringify({ include: ['nothing'] }), 'src/a.ts': '' }, { include: ['nothing'] });
    const p = discoverProject(root);
    expect(rels(root, p.fileNames)).toEqual(['src/a.ts']);
    expect(p.configFile).toBeUndefined();
    expect(p.options.allowJs).toBe(true);
  });

  it('FR-15.1 an unreadable tsconfig.json (a folder of that name) is skipped: the sources are scanned', () => {
    const root = writeProject({ 'tsconfig.json/x.txt': '', 'src/a.ts': '' }, false);
    const p = discoverProject(root);
    expect(rels(root, p.fileNames)).toEqual(['src/a.ts']);
    expect(p.configFile).toBeUndefined();
  });

  it('FR-15.1 without a config, all JS/TS sources below the root, not those of dependencies, build output or hidden folders', () => {
    const root = writeProject({
      'index.js': '', 'src/a.ts': '', 'src/deep/b.tsx': '', 'src/c.mjs': '', 'src/d.cts': '', 'src/readme.md': '', 'src/data.json': '',
      'node_modules/x/index.js': '', 'dist/a.js': '', 'out/a.js': '', 'build/a.js': '', 'coverage/a.js': '', '.vscode-test/a.js': '', '.cache/a.js': '',
    }, false);
    const p = discoverProject(root);
    expect(rels(root, p.fileNames)).toEqual(['index.js', 'src/a.ts', 'src/c.mjs', 'src/d.cts', 'src/deep/b.tsx']);
    expect(p.options.allowJs).toBe(true);
    expect(p.configFile).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('FR-15.1 a folder that cannot be read is left out of the scan; the rest is analysed', () => {
    const root = writeProject({ 'src/a.ts': '', 'locked/b.ts': '' }, false);
    fs.chmodSync(`${root}/locked`, 0o000);
    try {
      expect(rels(root, discoverProject(root).fileNames)).toEqual(['src/a.ts']);
    } finally {
      fs.chmodSync(`${root}/locked`, 0o755);
    }
  });
});

describe('ProjectHost: files the editor reports (FR-13.1)', () => {
  const host = (files: Record<string, string>, tsconfig: object = { compilerOptions: {}, include: ['src'] }) => {
    const root = writeProject(files, tsconfig);
    return { root, h: new ProjectHost(root, discoverProject(root)) };
  };

  it('FR-13.1 a new source file of the project joins the program (with content from the editor, or from disk)', () => {
    const { root, h } = host({ 'src/a.ts': '' });
    h.updateFile(`${root}/src/new.ts`, 'export const x = 1;\n');
    fs.writeFileSync(`${root}/src/saved.ts`, 'export const y = 2;\n');
    h.updateFile(`${root}/src/saved.ts`);
    expect(rels(root, h.getScriptFileNames())).toEqual(['src/a.ts', 'src/new.ts', 'src/saved.ts']);
    expect(h.getScriptSnapshot(`${root}/src/new.ts`)!.getText(0, 20)).toBe('export const x = 1;\n');
    expect(h.readFile(`${root}/src/new.ts`)).toBe('export const x = 1;\n');
    expect(h.fileExists(`${root}/src/new.ts`)).toBe(true);
  });

  it('FR-13.1 files that are not project sources do not join: other file types, dependencies, files outside the root, JS without allowJs', () => {
    const { root, h } = host({ 'src/a.ts': '', 'src/b.js': '' });
    h.updateFile(`${root}/src/notes.md`, '# notes');
    h.updateFile(`${root}/node_modules/x/index.ts`, 'export const x = 1;');
    h.updateFile(`${root}/../elsewhere.ts`, 'export const x = 1;');
    h.updateFile(`${root}/src/c.js`, 'export const c = 1;');
    h.updateFile(`${root}/src/b.js`); // on disk, still not a source of this program
    expect(rels(root, h.getScriptFileNames())).toEqual(['src/a.ts']);
  });

  it('FR-13.1 with allowJs a JavaScript file joins the program', () => {
    const { root, h } = host({ 'src/a.ts': '' }, { compilerOptions: { allowJs: true }, include: ['src'] });
    h.updateFile(`${root}/src/c.js`, 'export const c = 1;');
    expect(rels(root, h.getScriptFileNames())).toEqual(['src/a.ts', 'src/c.js']);
  });

  it('FR-13.1 a deleted file leaves the program; closing an editor without saving goes back to the disk content', () => {
    const { root, h } = host({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': '' });
    const before = h.getScriptSnapshot(`${root}/src/a.ts`)!;
    expect(h.getScriptSnapshot(`${root}/src/a.ts`)).toBe(before); // unchanged: the same snapshot (the parsed file is reused)
    h.updateFile(`${root}/src/a.ts`, 'export const a = 2;\n');
    expect(h.getScriptSnapshot(`${root}/src/a.ts`)!.getText(0, 20)).toBe('export const a = 2;\n');
    expect(h.getScriptVersion(`${root}/src/a.ts`)).toBe('1');
    h.updateFile(`${root}/src/a.ts`);
    expect(h.getScriptSnapshot(`${root}/src/a.ts`)!.getText(0, 20)).toBe('export const a = 1;\n');
    expect(h.getScriptVersion(`${root}/src/a.ts`)).toBe('2');
    fs.unlinkSync(`${root}/src/b.ts`);
    h.updateFile(`${root}/src/b.ts`);
    expect(rels(root, h.getScriptFileNames())).toEqual(['src/a.ts']);
    expect(h.getProjectVersion()).toBe('3');
  });

  it('FR-13.1 a file deleted before the first analysis (the change not reported yet): the program builds without it, calls into it stay unresolved', async () => {
    const { root, adapter, method } = tsProject({
      'src/a.ts': 'import { other } from "./b";\nexport function run() { other(); }\n',
      'src/b.ts': 'export function other() {}\n',
    });
    fs.unlinkSync(`${root}/src/b.ts`);
    expect(await adapter.getMethod('src/b.ts#<module>.other')).toBeUndefined();
    const calls = await adapter.getOutgoingCalls(await method('src/a.ts#<module>.run'));
    expect(calls.map((c) => [c.methodName, c.target?.key])).toEqual([['other', undefined]]);
  });
});

describe('ProjectHost: the default library (FR-1.6 calls through Promise, Array …)', () => {
  const host = () => {
    const root = writeProject({ 'src/a.ts': '' });
    return { root, h: new ProjectHost(root, discoverProject(root)) };
  };

  it("FR-1.6 TypeScript's own lib file when it is there", () => {
    const { root, h } = host();
    const own = ts.getDefaultLibFilePath({});
    const exists = ts.sys.fileExists;
    // also when the project has its own TypeScript
    vi.spyOn(ts.sys, 'fileExists').mockImplementation((f) => f.startsWith(`${root}/node_modules/typescript/lib/`) || exists(f));
    expect(h.getDefaultLibFileName({})).toBe(own);
  });

  it("FR-1.6 a bundle without the lib files beside it: the project's TypeScript lib, else the missing path (calls into the lib stay unknown)", () => {
    const { root, h } = host();
    const own = ts.getDefaultLibFilePath({});
    const name = own.split(/[\\/]/).pop()!;
    const exists = ts.sys.fileExists;
    let projectHasTs = true;
    vi.spyOn(ts.sys, 'fileExists').mockImplementation((f) => (f === own ? false : f === `${root}/node_modules/typescript/lib/${name}` ? projectHasTs : exists(f)));
    expect(h.getDefaultLibFileName({})).toBe(`${root}/node_modules/typescript/lib/${name}`);
    projectHasTs = false;
    expect(h.getDefaultLibFileName({})).toBe(own);
  });
});
