import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-mapped-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
// as a React front end's abortable: a proxy whose type maps every method to a callable interface
write('src/abort.ts', `interface CancellableFn<A extends any[], R> {
  (...args: A): R;
  abort: () => void;
}
type Abortable<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? CancellableFn<A, R> : T[K] };
export function abortable<T extends object>(api: T): Abortable<T> {
  return new Proxy(api, {}) as unknown as Abortable<T>;
}
`);
write('src/api.ts', `import { abortable } from './abort';
export class CatalogApi {
  async vendors(): Promise<string[]> { return this.load('/vendors'); }
  private async load(url: string): Promise<string[]> { return [url]; }
}
export const catalogApi = abortable(new CatalogApi());
`);
write('src/vendors.ts', `import { catalogApi } from './api';
type Handler = (x: string) => void;
export function showVendors(onDone: Handler) {
  catalogApi.vendors().then((v) => onDone(v[0]));
  catalogApi.vendors.abort();
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-1.2 calls through a type that maps a class\'s methods', () => {
  it('FR-1.2 `catalogApi.vendors()` on `Abortable<CatalogApi>` is CatalogApi.vendors, expandable; a function-typed parameter stays a parameter call', async () => {
    const session = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    const d = (await session.openMethodByKey('src/vendors.ts#<module>.showVendors'))!;
    const vendors = d.messages.find((m) => m.methodName === 'vendors')!;
    expect(vendors.methodKey).toBe('src/api.ts#CatalogApi.vendors');
    expect(vendors.className).toBe('CatalogApi');
    expect(vendors.unresolved).toBeUndefined();
    const expanded = (await session.expand(vendors.id))!;
    expect(expanded.messages.filter((m) => m.parentId === vendors.id).map((m) => m.methodName)).toEqual(['load']);
    // FR-1.13 unchanged: `onDone(…)` invokes the parameter, not a method found through its type
    expect(d.messages.find((m) => m.methodName === 'onDone')?.viaParameter).toBe('onDone');
  });
});
