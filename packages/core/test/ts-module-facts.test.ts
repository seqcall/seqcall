import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-7.7 module facts of a TS file (ports taken, libraries used, project types referenced), on small projects.

const NONE = { ports: [], libraries: [], dependsOn: [] };

describe('FR-7.7 module facts (TS)', () => {
  it('FR-7.7 a file that is not in the program, or a library file: no facts', async () => {
    const { adapter } = tsProject({
      'src/a.ts': `import { pad } from 'text';\nexport const x = pad();\n`,
      'node_modules/text/package.json': '{"name":"text","main":"index.ts"}',
      'node_modules/text/index.ts': `import * as fs from 'node:fs';\nexport function pad() { return fs.readFileSync('x'); }\n`,
    });
    expect(await adapter.getModuleFacts('src/missing.ts#X')).toEqual(NONE);
    expect(await adapter.getModuleFacts('node_modules/text/index.ts#<module>')).toEqual(NONE);
    expect((await adapter.getModuleFacts('src/a.ts#<module>')).libraries).toEqual(['text']);
  });

  it('FR-7.13 imports that count as using a library: for its effects, namespace, default, empty braces; not types or checks only', async () => {
    const { adapter } = tsProject({
      'src/a.ts': `import 'polyfill';
import * as ns from 'ns-lib';
import def from 'def-lib';
import {} from 'empty-lib';
import type { T } from 'type-lib';
import { type U, isThing, LibError } from 'checks-lib';
import mixed, { isOther } from 'mixed-lib';
export const x = [ns, def, mixed];
`,
    });
    expect((await adapter.getModuleFacts('src/a.ts#<module>')).libraries).toEqual(['polyfill', 'ns-lib', 'def-lib', 'empty-lib', 'mixed-lib']);
  });

  it('FR-17.2 a call of the global fetch is the library "fetch", also without a declaration of it (no DOM lib); a project function named fetch is not', async () => {
    const { adapter } = tsProject({
      'src/a.ts': `export async function load() { return fetch('https://shop.example/orders'); }\n`,
      'src/b.ts': `function fetch(url: string) { return url; }\nexport function load() { return fetch('x'); }\n`,
    }, { compilerOptions: { target: 'ES2022', lib: ['ES2022'], module: 'ESNext', moduleResolution: 'node' } });
    expect((await adapter.getModuleFacts('src/a.ts#<module>')).libraries).toEqual(['fetch']);
    expect((await adapter.getModuleFacts('src/b.ts#<module>')).libraries).toEqual([]);
  });

  it('FR-7.7 ports: records of functions also through mapped types (Record over literal keys, Readonly, Pick); a record with data or of library members is not one', async () => {
    const { adapter } = tsProject({
      'src/ports.ts': `export interface Store { save(x: string): void; load(): string }
export type ByName = Record<'save' | 'load', (x: string) => void>;
export type Mapped = { [K in 'run']: () => void };
export type Frozen = Readonly<Store>;
export type Saver = Pick<Store, 'save'>;
export type WithData = Record<'save' | 'size', number>;
export type LibFrozen = Readonly<LibStore>;
import type { LibStore } from 'store-lib';
`,
      'node_modules/store-lib/package.json': '{"name":"store-lib","types":"index.d.ts"}',
      'node_modules/store-lib/index.d.ts': 'export interface LibStore { save(x: string): void }\n',
      'src/svc.ts': `import type { ByName, Mapped, Frozen, Saver, WithData, LibFrozen } from './ports';
export class Svc { constructor(a: ByName, b: Mapped, c: Frozen, d: Saver, e: WithData, f: LibFrozen) {} }
`,
    });
    expect((await adapter.getModuleFacts('src/svc.ts#Svc')).ports).toEqual(['ByName', 'Mapped', 'Frozen', 'Saver']);
  });
});
