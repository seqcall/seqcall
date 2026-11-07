import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { chooseLicense, npmComponent, nugetComponents, packageDirOf, renderNotices, rtfToText } from '../third-party-notices.mjs';

const repo = resolve(__dirname, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'seqcall-notices-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('third-party notices of the release packages (scripts/third-party-notices.mjs)', () => {
  it('uses an allowed licence, picks the allowed choice of an OR, and stops on any other licence', () => {
    expect(chooseLicense('MIT', 'a')).toBe('MIT');
    expect(chooseLicense('EPL-2.0 OR GPL-3.0-or-later', 'elkjs')).toBe('EPL-2.0');
    expect(chooseLicense('(GPL-3.0-only OR Apache-2.0)', 'b')).toBe('Apache-2.0');
    expect(chooseLicense('MIT AND BSD-3-Clause', 'c')).toBe('MIT AND BSD-3-Clause');
    expect(() => chooseLicense('GPL-3.0-only', 'gpl-lib 1.0')).toThrow(/gpl-lib 1.0: licence "GPL-3.0-only" is not in the allowed list/);
    expect(() => chooseLicense('MIT AND GPL-3.0-only', 'd')).toThrow(/not in the allowed list/);
    expect(() => chooseLicense(undefined, 'e')).toThrow(/e: no licence declared/);
  });

  it('finds the package of a bundled file, scoped and nested ones included', () => {
    expect(packageDirOf('/r/node_modules/elkjs/lib/elk.bundled.js')).toBe('/r/node_modules/elkjs');
    expect(packageDirOf('/r/node_modules/@dagrejs/dagre/dist/dagre.esm.js')).toBe('/r/node_modules/@dagrejs/dagre');
    expect(packageDirOf('/r/node_modules/a/node_modules/b/index.js')).toBe('/r/node_modules/a/node_modules/b');
    expect(packageDirOf('/r/packages/core/src/index.ts')).toBeUndefined();
  });

  it('reads an npm package: licence choice, its licence file, the source to name (EPL-2.0 asks for it)', () => {
    const elk = npmComponent(join(repo, 'node_modules/elkjs'));
    expect(elk).toMatchObject({ name: 'elkjs', license: 'EPL-2.0', source: 'https://github.com/kieler/elkjs' });
    expect(elk.licenses[0]).toContain('Eclipse Public License');
    const dir = join(tmp, 'node_modules/nolicence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'nolicence', version: '1.0.0', license: 'MIT' }));
    expect(() => npmComponent(dir)).toThrow(/nolicence 1.0.0: no licence file/);
  });

  it('reads the NuGet packages a published app ships, writing the MIT text with the package copyright', () => {
    const app = join(tmp, 'app');
    const nuget = join(tmp, 'nuget');
    mkdirSync(app, { recursive: true });
    const pkg = (id: string, version: string, nuspec: string, files: Record<string, string> = {}) => {
      const dir = join(nuget, id.toLowerCase(), version);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id.toLowerCase()}.nuspec`), `<package><metadata>${nuspec}</metadata></package>`);
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    };
    pkg('Shop.Core', '1.2.0', '<license type="expression">MIT</license><copyright>© Shop Inc. All rights reserved.</copyright><repository type="git" url="https://example.com/shop" />', {
      'ThirdPartyNotices.rtf': '{\\rtf1{\\fonttbl{\\f0 Tahoma;}}\\pard Notice one\\par Notice two\\par}',
    });
    pkg('Build.Only', '1.0.0', '<license type="expression">GPL-3.0-only</license>');
    const lib = (id: string, version: string) => ({ type: 'package', path: `${id.toLowerCase()}/${version}` });
    writeFileSync(
      join(app, 'App.deps.json'),
      JSON.stringify({
        targets: { 'net10.0': { 'App/1.0.0': { runtime: {} }, 'Shop.Core/1.2.0': { runtime: { 'lib/Shop.Core.dll': {} } }, 'Build.Only/1.0.0': { compile: {} } } },
        libraries: { 'App/1.0.0': { type: 'project' }, 'Shop.Core/1.2.0': lib('Shop.Core', '1.2.0'), 'Build.Only/1.0.0': lib('Build.Only', '1.0.0') },
      }),
    );
    const [shop, ...rest] = nugetComponents(app, nuget);
    expect(rest).toEqual([]); // compile-only packages do not ship
    expect(shop).toMatchObject({ name: 'Shop.Core', version: '1.2.0', license: 'MIT', source: 'https://example.com/shop', notices: ['Notice one\nNotice two'] });
    expect(shop.licenses[0]).toMatch(/^MIT License\n\n© Shop Inc\. All rights reserved\.\n\nPermission is hereby granted/);
  });

  it('turns RTF notices into plain text', () => {
    expect(rtfToText('{\\rtf1{\\*\\generator X}{\\field{\\*\\fldinst{HYPERLINK u}}{\\fldrslt{https://x.org}}}\\par a \\{b\\}\\par}')).toBe('https://x.org\na {b}');
  });

  it('lists every component with licence and source, and writes each distinct licence and notice text once', () => {
    const c = (name: string, licence: string, notices: string[] = []) => ({ name, version: '1.0.0', license: 'MIT', source: `https://x.org/${name}`, licenses: [licence], notices });
    const text = renderNotices([c('b', 'MIT text', ['N']), c('a', 'MIT text', ['N']), c('z', 'other text'), c('a', 'MIT text', ['N'])]);
    expect(text).toContain('- a 1.0.0 (MIT): https://x.org/a\n- b 1.0.0 (MIT): https://x.org/b\n- z 1.0.0 (MIT): https://x.org/z\n');
    expect(text.match(/MIT text/g)).toHaveLength(1);
    expect(text).toContain('Licence of: a 1.0.0, b 1.0.0');
    expect(text).toContain('Notices of: a 1.0.0, b 1.0.0');
  });
});
