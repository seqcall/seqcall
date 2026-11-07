import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-evidence-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], strict: false, jsx: 'preserve', moduleResolution: 'node' }, include: ['src'] }));
write('node_modules/axios/package.json', JSON.stringify({ name: 'axios', types: 'index.d.ts' }));
write('node_modules/axios/index.d.ts', 'declare const axios: { get(url: string): Promise<unknown> };\nexport default axios;\nexport function isCancel(e: unknown): boolean;\nexport interface AxiosStatic {}\n');
// no layer folder, no telling name, no role folder: only the code says what these are
write('src/helpers/api.ts', `import axios from 'axios';
export class ApiInstance {
  async load(id: string) { return axios.get('/coupons/' + id); }
}
`);
// imports only an error check from axios: no I/O
write('src/helpers/errors.ts', "import { isCancel, type AxiosStatic } from 'axios';\nexport class Errors {\n  cancelled(e: unknown) { return isCancel(e); }\n}\n");
write('src/helpers/math.ts', 'export class Percent {\n  of(a: number, b: number) { return (a * b) / 100; }\n}\n');
write('src/widgets/card.tsx', `import axios from 'axios';
import { ApiInstance } from '../helpers/api';
import { Percent } from '../helpers/math';
import { Errors } from '../helpers/errors';
export function Card({ id }: { id: string }) {
  void new ApiInstance().load(id);
  void axios.get('/direct');
  void new Percent().of(1, 2);
  void new Errors().cancelled(null);
  return <div />;
}
`);
// a declared layer (role folder) is kept, I/O there stays a hint
write('src/services/report-service.ts', `import axios from 'axios';
export class ReportService {
  async send() { return axios.get('/report'); }
  run() { return this.send(); }
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-7.13 layer from evidence when nothing declared one', () => {
  const adapter = createTsAdapter(root);
  const open = async (key: string): Promise<SequenceDiagram> => {
    const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await s.openMethodByKey(key);
    return (await s.expandAll())!;
  };
  const box = (d: SequenceDiagram, name: string) => d.participants.find((p) => p.className === name)!;

  it('FR-7.13 a class doing I/O is Infrastructure, a component Presentation, both weak, from the code; a pure class keeps no layer', async () => {
    const d = await open('src/widgets/card.tsx#<module>.Card');
    const card = box(d, 'card');
    expect([card.layer, card.layerReason?.rule, card.layerReason?.strength, card.layerReason?.text]).toEqual(['Presentation', 'evidence', 'weak', 'the code: renders JSX (a UI component)']);
    const api = box(d, 'ApiInstance');
    expect([api.layer, api.layerReason?.rule, api.layerReason?.text]).toEqual(['Infrastructure', 'evidence', 'the code: does I/O (uses axios)']);
    expect(api.layerReason?.notApplied.length).toBeGreaterThan(0); // the declared rules checked first are still listed
    expect(api.layerHint).toBeUndefined(); // decided: no ⚑ any more
    expect(box(d, 'Percent').layer).toBeUndefined();
    // only an error check imported from axios: no I/O, no layer, no badge
    expect([box(d, 'Errors').layer, box(d, 'Errors').sideEffects, box(d, 'Errors').layerHint]).toEqual([undefined, undefined, undefined]);
    expect(d.messages.find((m) => m.methodName === 'cancelled')?.sideEffects).toBeUndefined(); // isCancel(e) is a check
    // the component does I/O itself: a smell to see (its badge), not a reason to move it to Infrastructure
    expect(card.layerHint).toBeUndefined();
  });

  it('FR-7.13 a declared layer is never overridden: I/O in a role-folder service stays a ⚑ hint', async () => {
    const d = await open('src/services/report-service.ts#ReportService.run');
    const svc = box(d, 'ReportService');
    expect([svc.layer, svc.layerReason?.rule]).toEqual(['Application', 'role-folder']);
    expect(svc.layerHint?.suggested).toBe('Infrastructure');
  });
});
