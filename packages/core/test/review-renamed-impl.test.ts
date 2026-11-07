import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

// FR-24.6 an implementation chosen in today's diagram whose file the branch renamed: the base version takes the same
// class at its old path. On the branch SqlStore moves to db/ and its save() syncs instead of flushing.
let root = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-renamed-impl-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  const sql = (store: string, first: string) =>
    `import { Store } from '${store}';\nexport class SqlStore implements Store {\n  save(n: number) {\n    ${first}\n    return n;\n  }\n  flush() {\n    return 1;\n  }\n  sync() {\n    return 2;\n  }\n}\n`;
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
  write('src/store.ts', `export interface Store {\n  save(n: number): number;\n}\n`);
  write('src/sql-store.ts', sql('./store', 'this.flush();'));
  write('src/mem-store.ts', `import { Store } from './store';\nexport class MemStore implements Store {\n  save(n: number) {\n    return n;\n  }\n}\n`);
  write('src/shop.ts', `import { Store } from './store';\nexport class Shop {\n  constructor(private store: Store) {}\n  place() {\n    return this.store.save(1);\n  }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  fs.rmSync(path.join(root, 'src/sql-store.ts'));
  write('src/db/sql-store.ts', sql('../store', 'this.sync();'));
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('FR-24.6 an implementation of a renamed file chosen: compared with the same class at its old path — no new participant, its removed and added calls', async () => {
  const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
  await s.reviewChanges();
  await s.openMethodByKey('src/shop.ts#Shop.place');
  await s.selectImplementation('root/0:save', 'src/db/sql-store.ts#SqlStore');
  const d = (await s.expandEverything())!;
  expect(d.participants.map((p) => `${p.classKey} ${p.diff ?? '-'}`)).toEqual(['src/shop.ts#Shop -', 'src/db/sql-store.ts#SqlStore -']);
  expect(d.messages.map((m) => `${m.id} ${m.diff?.status ?? '-'}`)).toEqual(['root -', 'root/0:save -', 'root/0:save/~0:flush removed', 'root/0:save/0:sync added']);
  const cd = (await s.getClassDiagram())!;
  expect(cd.classes.filter((c) => c.name === 'SqlStore').map((c) => `${c.key} ${c.diff ?? '-'}`)).toEqual(['src/db/sql-store.ts#SqlStore -']);
  await s.dispose();
}, 60_000);
