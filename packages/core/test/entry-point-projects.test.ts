import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { withProjects } from '../src/entry-point-projects';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-epp-')).replace(/\\/g, '/');
const write = (rel: string, text = '') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const ep = (rel: string, label = rel): EntryPoint => ({ kind: 'http', label, method: { key: `${rel}#C.m` } }) as unknown as EntryPoint;
const projects = (r: string, list: EntryPoint[]) => withProjects(`${root}/${r}`, list).map((e) => `${e.method.key.split('#')[0]} → ${e.project ?? '-'}`);

describe('FR-16.8 the project of each entry point in a multi-project root', () => {
  it('FR-16.8 a solution: the nearest .csproj above the file (nested folders too)', () => {
    write('sln/App.sln');
    write('sln/ShopApi/ShopApi.csproj');
    write('sln/Tools/Visualizer/Visualizer.csproj');
    write('sln/Tests/UnitTests/UnitTests.csproj');
    expect(projects('sln', [ep('ShopApi/Controllers/A.cs'), ep('Tools/Visualizer/Program.cs'), ep('Tests/UnitTests/Deep/X/T.cs')])).toEqual([
      'ShopApi/Controllers/A.cs → ShopApi',
      'Tools/Visualizer/Program.cs → Visualizer',
      'Tests/UnitTests/Deep/X/T.cs → UnitTests',
    ]);
  });

  it('FR-16.8 a monorepo: the package.json name (else its folder); a file outside any package belongs to the root', () => {
    write('mono/package.json', '{"name":"mono"}');
    write('mono/apps/api/package.json', '{"name":"@acme/api"}');
    write('mono/apps/web/package.json', '{ broken');
    write('mono/scripts/c.ts');
    expect(projects('mono', [ep('apps/api/src/a.ts'), ep('apps/web/src/b.ts'), ep('scripts/c.ts')])).toEqual(['apps/api/src/a.ts → @acme/api', 'apps/web/src/b.ts → web', 'scripts/c.ts → mono']);
    // an entry point whose key names no file (an adapter's key without a path) gets no project
    const noFile = withProjects(`${root}/mono`, [ep('apps/api/src/a.ts'), ep(''), ep('apps/web/src/b.ts')]);
    expect(noFile.map((e) => e.project)).toEqual(['@acme/api', undefined, 'web']);
    expect(noFile[1]).toStrictEqual(ep(''));
  });

  it('FR-16.8 one project only: nothing set (the lists stay by kind); Composer packages in vendor are projects of their own', () => {
    write('single/package.json', '{"name":"single"}');
    expect(projects('single', [ep('src/a.ts'), ep('src/b/c.ts')])).toEqual(['src/a.ts → -', 'src/b/c.ts → -']);
    write('shop/composer.json', '{"name":"acme/shop"}');
    write('shop/vendor/acme/payments/composer.json', '{"name":"acme/payments"}');
    expect(projects('shop', [ep('app/Http/A.php'), ep('vendor/acme/payments/src/R.php')])).toEqual(['app/Http/A.php → shop', 'vendor/acme/payments/src/R.php → acme/payments']);
  });
});
