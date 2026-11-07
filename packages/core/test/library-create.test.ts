import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DEFAULT_OPTIONS, DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-library-create-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['src'] }));
write('src/orders.ts', `export class Orders {
  find(id: string): Map<string, number> {
    if (!id) throw new Error(\`Order \${id} not found\`);
    const totals = new Map<string, number>();
    new globalThis.Date();
    return totals;
  }
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-10.6 «create» of a library class', () => {
  it('FR-10.6 the label names the class made (`new Error(…)` → Error), not the library ("lib")', async () => {
    const options = { ...DEFAULT_OPTIONS, foldErrors: false, showLibraryCalls: true };
    const session = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), initialState: { options } });
    const d = (await session.openMethodByKey('src/orders.ts#Orders.find'))!;
    const creates = d.messages.filter((m) => m.kind === 'create' && m.isLibrary);
    expect(creates.map((m) => m.className)).toEqual(['Error', 'Map', 'Date']);
    // the lifeline is still the library's
    expect(new Set(creates.map((m) => d.participants.find((p) => p.id === m.to)?.className))).toEqual(new Set(['lib']));
  });
});
