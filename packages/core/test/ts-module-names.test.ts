import { describe, expect, it } from 'vitest';
import { TsAdapter } from '../src/ts/ts-adapter';
import { DEFAULT_TSCONFIG, tsProject, writeProject } from './ts-project';

// FR-1.2 names of module participants and FR-1.6 of library participants.

describe('Module participants (FR-1.2)', () => {
  it('FR-1.2 a module is named after its file; an index file after its folder, the root index file stays "index"', async () => {
    const { root, adapter } = tsProject({
      'src/orders/index.ts': 'export function list() {}\n',
      'src/orders/order-list.tsx': 'export function view() {}\n',
      'index.ts': 'export function main() {}\n',
    });
    const owner = async (rel: string) => (await adapter.getFileTypes(`${root}/${rel}`)).map((t) => [t.type.key, t.type.name]);
    expect(await owner('src/orders/index.ts')).toEqual([['src/orders/index.ts#<module>', 'orders']]);
    expect(await owner('src/orders/order-list.tsx')).toEqual([['src/orders/order-list.tsx#<module>', 'order-list']]);
    expect(await owner('index.ts')).toEqual([['index.ts#<module>', 'index']]);
  });
});

describe('Library participants (FR-1.6)', () => {
  it('FR-1.6 a call into a package is owned by the package; @types/pkg is pkg, @types/scope__pkg is @scope/pkg; a file outside the project root is "lib"', async () => {
    const root = writeProject({
      'app/tsconfig.json': JSON.stringify(DEFAULT_TSCONFIG),
      'app/src/a.ts': `import { pad } from '@shop/text';\nimport { up } from '../../shared/up';\nimport { trim } from 'trim';\nimport { chunk } from 'lodash';\nexport function run(s: string) { return pad(s) + up(s) + trim(s) + chunk(s); }\n`,
      'app/node_modules/@types/shop__text/index.d.ts': 'export declare function pad(x: string): string;\n',
      'app/node_modules/trim/package.json': '{"name":"trim","types":"index.d.ts"}',
      'app/node_modules/trim/index.d.ts': 'export declare function trim(x: string): string;\n',
      'app/node_modules/@types/lodash/index.d.ts': 'export declare function chunk(x: string): string;\n',
      'shared/up.ts': 'export function up(x: string) { return x.toUpperCase(); }\n',
    }, false);
    const adapter = new TsAdapter(`${root}/app`);
    const run = (await adapter.getMethod('src/a.ts#<module>.run'))!;
    const calls = await adapter.getOutgoingCalls(run);
    expect(calls.map((c) => [c.methodName, c.target?.key, c.libraryName])).toEqual([
      ['pad', 'lib:@shop/text#<module>.pad', '@shop/text'],
      ['up', 'lib:lib#<module>.up', 'lib'],
      ['trim', 'lib:trim#<module>.trim', 'trim'],
      ['chunk', 'lib:lodash#<module>.chunk', 'lodash'],
    ]);
  });
});
