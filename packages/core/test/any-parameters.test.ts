import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

// a helper taking `any` (like an admin app's `#zodResponse(zodSchema: any, …)`), called with a typed value
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-any-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022'], strict: false }, include: ['src'] }));
write('src/schema.ts', `export class Schema { parse(v: unknown) { return v; } }`);
write('src/api.ts', `import { Schema } from './schema';
export class Api {
  private readonly cache = new Map<string, string>();
  load() { return this.respond(this.cache, 'k'); }
  check() { return this.validate(new Schema(), 1); }
  respond(store: any, key: string) { return store.get(key); }
  validate(schema: any, v: unknown) { return this.inner(schema, v); }
  inner(s: any, v: unknown) { return s.parse(v); }
}`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const adapter = createTsAdapter(root);
const session = (showLibraryCalls = false) =>
  new DiagramSession({ adapter, classifier: createClassifier(root), initialState: { options: { showArguments: true, maxArgumentLength: 30, showLibraryCalls, followCursor: false } } });
const target = (d: SequenceDiagram, name: string) => {
  const m = d.messages.find((x) => x.methodName === name || x.methodName.endsWith(`.${name}`))!;
  return { label: d.participants.find((p) => p.id === m.to)?.label, unresolved: m.unresolved, methodKey: m.methodKey };
};

describe('FR-1.19 calls on parameters typed any', () => {
  it('FR-1.19 opened alone: the call stays unknown and says why', async () => {
    const d = (await session().openMethodByKey('src/api.ts#Api.respond'))!;
    expect(target(d, 'get')).toMatchObject({ label: 'unknown', unresolved: expect.stringContaining('`store` is typed any') });
  });

  it('FR-1.19 reached from a caller passing a typed value: a library type makes it a library call (hidden by default, shown with Library calls)', async () => {
    const s = session();
    await s.openMethodByKey('src/api.ts#Api.load');
    const hidden = (await s.expand('root/0:respond'))!;
    expect(hidden.messages.some((m) => m.methodName.endsWith('get'))).toBe(false); // a library call now: hidden
    const t = session(true);
    await t.openMethodByKey('src/api.ts#Api.load');
    const shown = (await t.expand('root/0:respond'))!;
    expect(target(shown, 'get')).toMatchObject({ label: 'lib', unresolved: undefined });
  });

  it('FR-1.19 a project type passed on through another any parameter: the call goes to that class', async () => {
    const s = session();
    await s.openMethodByKey('src/api.ts#Api.check');
    await s.expand('root/1:validate');
    const d = (await s.expand('root/1:validate/0:inner'))!;
    expect(target(d, 'parse')).toMatchObject({ label: ':Schema', methodKey: 'src/schema.ts#Schema.parse' });
  });
});
