import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-hide-unresolved-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', allowJs: true, strict: true }, include: ['src'] }));
// as a route set up through a framework that is not installed: the calls stay unknown and show as their expression
write('src/routes.js', `export const register = (app) => {
  app.withTypeProvider().route({ url: '/orders' });
  app.log('registered');
};
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const open = async () => {
  const session = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
  const d = (await session.openMethodByKey('src/routes.js#<module>.register'))!;
  return { session, d };
};

describe('FR-11.1 hide rules on unresolved calls', () => {
  it('FR-11.1 "Hide every call named X" with the shown expression hides the unknown call and counts it', async () => {
    const { session, d } = await open();
    const unknown = d.messages.filter((m) => m.classKey === 'unknown').map((m) => m.methodName);
    expect(unknown).toContain('app.withTypeProvider().route');
    const hidden = (await session.hide({ kind: 'methodName', methodName: 'app.withTypeProvider().route' }))!;
    expect(hidden.messages.map((m) => m.methodName)).not.toContain('app.withTypeProvider().route');
    expect(hidden.messages.map((m) => m.methodName)).toContain('app.log');
    expect(hidden.hiddenFilters?.[0]?.hiddenCount).toBe(1);
  });

  it('FR-11.1 "Hide calls to unknown.X only" with the shown expression hides it too', async () => {
    const { session } = await open();
    const hidden = (await session.hide({ kind: 'classMethod', classKey: 'unknown', className: 'unknown', methodName: 'app.log' }))!;
    expect(hidden.messages.map((m) => m.methodName)).not.toContain('app.log');
    expect(hidden.messages.map((m) => m.methodName)).toContain('app.withTypeProvider().route');
  });
});
