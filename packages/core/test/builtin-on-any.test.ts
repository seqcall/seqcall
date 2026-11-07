import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DEFAULT_OPTIONS, DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-builtin-any-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', allowJs: true, strict: true }, include: ['src'] }));
// as a React front end's openExternalLink.js: an untyped parameter, string work on it, and calls on an untyped object
write('src/navigate.js', `export const navigate = (path, history) => {
  const lower = path.toLowerCase();
  if (lower.trim().startsWith('http')) return path.padStart(2, ' ');
  history.replace(path);
  history.get(path.split('/')[0]).toFixed(2);
};
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-1.19 String / Number methods on values typed any', () => {
  it('FR-1.19 `path.toLowerCase()` on an untyped parameter is the built-in (a library call, hidden by default); `replace` / `get` stay unknown', async () => {
    const session = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } });
    let d = (await session.openMethodByKey('src/navigate.js#<module>.navigate'))!;
    expect(d.messages.filter((m) => m.classKey === 'unknown').map((m) => m.methodName)).toEqual(['history.replace', 'history.get']);
    d = (await session.setOption('showLibraryCalls', true))!;
    const builtins = d.messages.filter((m) => m.isLibrary).map((m) => m.methodName);
    // chained on the any a built-in returns too (`lower.trim().startsWith`), and toFixed on what an unknown call returns
    for (const n of ['toLowerCase', 'trim', 'startsWith', 'padStart', 'split', 'toFixed']) expect(builtins, n).toContain(n);
    expect(d.messages.filter((m) => m.classKey === 'unknown').map((m) => m.methodName)).toEqual(['history.replace', 'history.get']);
  });
});
