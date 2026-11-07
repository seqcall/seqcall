import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { TsAdapter } from '../src/ts/ts-adapter';

/**
 * Small TS/JS projects written to a temp dir per test (removed after each test). `tsconfig: false` writes none
 * (the adapter then scans the sources itself); the default is a plain ES2022 project over all files of the root.
 */
const dirs: string[] = [];
const fileDirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  for (const d of fileDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

export const DEFAULT_TSCONFIG = { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'node', strict: false, experimentalDecorators: true } };

/** `shared`: kept for all tests of the file (a project built once in a describe block), removed after them. */
export function writeProject(files: Record<string, string>, tsconfig: object | false = DEFAULT_TSCONFIG, shared = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-ts-')).replace(/\\/g, '/');
  (shared ? fileDirs : dirs).push(root);
  if (tsconfig) fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify(tsconfig));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
}

export function tsProject(files: Record<string, string>, tsconfig: object | false = DEFAULT_TSCONFIG, shared = false) {
  const root = writeProject(files, tsconfig, shared);
  const adapter = new TsAdapter(root);
  const session = () => new DiagramSession({ adapter, classifier: createClassifier(root) });
  /** The method by key; throws when it is not found (a typo in a test). */
  const method = async (key: string) => {
    const m = await adapter.getMethod(key);
    if (!m) throw new Error(`method not found: ${key}`);
    return m;
  };
  /** 0-based position of `needle` (plus `offset` chars) in a project file. */
  const at = (rel: string, needle: string, offset = 0) => {
    const text = fs.readFileSync(`${root}/${rel}`, 'utf8');
    const idx = text.indexOf(needle);
    if (idx < 0) throw new Error(`"${needle}" not found in ${rel}`);
    const before = text.slice(0, idx + offset).split('\n');
    return { line: before.length - 1, character: before[before.length - 1].length };
  };
  return { root, adapter, session, method, at };
}
