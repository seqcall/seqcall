import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-callers-')).replace(/\\/g, '/');
fs.mkdirSync(`${root}/src`);
fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false, jsx: 'preserve' }, include: ['src'] }));
fs.writeFileSync(`${root}/src/store.ts`, `export class CouponStore {
  async fetchCouponInfo(couponId: string): Promise<void> {}
}
export function useStore(): CouponStore { return new CouponStore(); }
`);
fs.writeFileSync(`${root}/src/template.tsx`, `import { useStore } from './store';
export function CouponPage() {
  const { fetchCouponInfo } = useStore();
  const load = async () => { await fetchCouponInfo('a'); };
  return <button onClick={load} />;
}
export function Renamed() {
  const { fetchCouponInfo: fetchInfo } = useStore();
  void fetchInfo('b');
  return null;
}
export function Direct() {
  void useStore().fetchCouponInfo('c');
  return null;
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-4.1 callers through object destructuring', () => {
  it('FR-4.1 a method taken out of an object (`const { m } = store`, also renamed) is called through the local', async () => {
    const adapter = createTsAdapter(root);
    const m = await adapter.getMethod('src/store.ts#CouponStore.fetchCouponInfo');
    const callers = await adapter.getCallers(m!);
    expect(callers.map((c) => `${c.enclosing.name}: ${c.preview}`)).toEqual([
      "load: const load = async () => { await fetchCouponInfo('a'); };",
      "Renamed: void fetchInfo('b');",
      "Direct: void useStore().fetchCouponInfo('c');",
    ]);
  });

  it('FR-1.1 the call through the destructured local goes to the store method', async () => {
    const adapter = createTsAdapter(root);
    const d = (await new DiagramSession({ adapter, classifier: createClassifier(root) }).openMethodByKey('src/template.tsx#<module>.Renamed'))!;
    const call = d.messages.find((m) => m.methodName === 'fetchInfo' || m.methodName === 'fetchCouponInfo')!;
    expect(call.methodKey).toBe('src/store.ts#CouponStore.fetchCouponInfo');
  });
});
