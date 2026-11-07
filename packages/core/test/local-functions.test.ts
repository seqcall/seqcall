import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-local-')).replace(/\\/g, '/');
fs.mkdirSync(`${root}/src`);
fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
fs.writeFileSync(`${root}/src/clear.ts`, `export function clear(items: string[]) {
  const ending = (n: number) => ({ cleared: n });
  function count() { return items.length; }
  if (!items.length) return ending(0);
  return ending(count());
}
export function makeStore() {
  const save = (x: string) => x;
  return { save };
}
export function useStore() { return makeStore().save('a'); }
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-6.6 local functions participant', () => {
  const adapter = createTsAdapter(root);
  const session = () => new DiagramSession({ adapter, classifier: createClassifier(root) });

  it('FR-6.6 helpers declared inside a function are «locals» named after it, e.g. clear()', async () => {
    const d = (await session().openAt(`${root}/src/clear.ts`, { line: 3, character: 8 }))!;
    const helpers = d.participants.find((p) => p.classKey === 'src/clear.ts#clear')!;
    expect(helpers.label).toBe('clear()');
    expect(helpers.stereotypes).toEqual(['locals']);
    expect(d.participants.find((p) => p.kind === 'module')!.label).toBe('clear'); // the module itself
    expect(d.messages.filter((m) => m.to === helpers.id).map((m) => m.methodName)).toEqual(['ending', 'count', 'ending']);
  });

  it('FR-6.6 a factory handing its local functions out as an object stays an object participant', async () => {
    const d = (await session().openAt(`${root}/src/clear.ts`, { line: 10, character: 30 }))!;
    const store = d.participants.find((p) => p.classKey === 'src/clear.ts#makeStore')!;
    expect(store.label).toBe('makeStore');
    expect(store.stereotypes).not.toContain('locals');
  });
});
