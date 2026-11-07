import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-hint-ignore-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false, types: [] }, include: ['src'] }));
write('node_modules/axios/package.json', JSON.stringify({ name: 'axios', types: 'index.d.ts' }));
write('node_modules/axios/index.d.ts', 'declare const axios: { get(url: string): Promise<unknown> };\nexport default axios;\n');
// an application service doing I/O itself: the ⚑ says Infrastructure
write('src/application/prices.ts', `import axios from 'axios';
export async function loadPrices() { return axios.get('/prices'); }
`);
write('src/application/main.ts', `import { loadPrices } from './prices';
export async function run() { return loadPrices(); }
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-7.11 layerHints.ignore', () => {
  const hintOf = async () => {
    const session = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    await session.openMethodByKey('src/application/main.ts#<module>.run');
    const d = (await session.expandEverything())!;
    return d.participants.find((p) => p.classKey === 'src/application/prices.ts#<module>')?.layerHint;
  };

  it('FR-7.11 a file glob in layerHints.ignore silences the file\'s ⚑ hint; other files keep theirs', async () => {
    expect((await hintOf())?.suggested).toBe('Infrastructure');
    write('.seqcall.json', JSON.stringify({ layerHints: { ignore: ['src/application/prices.ts'] } }));
    expect(await hintOf()).toBeUndefined();
    write('.seqcall.json', JSON.stringify({ layerHints: { ignore: ['src/other/**'] } }));
    expect((await hintOf())?.suggested).toBe('Infrastructure');
  });
});
