import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { joinRoute } from '../src/ts/entry-points';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-ep-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;
export const Get = (p?: string) => (t: any, k: string) => undefined;
export const Post = (p?: string) => (t: any, k: string) => undefined;`);
write('src/users.controller.ts', `import { Controller, Get, Post } from './decorators';
import { load } from './service';
@Controller('users')
export class UsersController {
  @Get(':id') find(id: string) { return load(id); }
  @Post() create() { return load('new'); }
}`);
write('src/service.ts', `export function load(id: string) { return id; }
export function audit(line: string) { return line; }
export function loadEnv() { return 1; }
export function knexSetup() { return 2; }`);
write('src/routes.ts', `import { load, audit } from './service';
import { log } from './config/logger';
declare const app: { get(p: string, ...h: Function[]): void };
declare const fastify: { route(o: object): void };
export function listOrders(req: unknown) { return load('x'); }
app.get('/orders', listOrders);
export async function ordersPlugin() {
  fastify.route({ method: ['GET', 'HEAD'], url: '/orders/:id', handler: async (req: unknown) => audit(load('y')) });
}`);
// HTTP client calls look like route registrations (`x.post('/path', …)`), but the last argument is no handler
write('src/api-client.ts', `declare const axios: { post(url: string, body?: unknown): Promise<unknown>; get(url: string, config?: object): Promise<unknown> };
export class ApiInstance {
  constructor(private ajax: typeof axios) {}
  getValidPrices(data: string) { return this.ajax.post('/mobile/api/validPrices', data); }
  list() { return axios.get('/items', { params: { page: 1 } }); }
}`);
// FR-16.5 two module-level calls in one file: each an entry, with the file
write('src/bootstrap.ts', `import { load, audit } from './service';
load('boot');
audit('boot');`);
write('src/main.ts', `import { load } from './service';
async function main() { load('cli'); }
void main();`);
// FR-16.5 not programs: top-level calls of a module the app imports (they run on import), a tool's config file
write('src/config/logger.ts', `import { loadEnv } from '../service';
loadEnv();
export const log = (s: string) => s;`);
write('src/knexfile.ts', `import { knexSetup } from './service';
knexSetup();
export default { client: 'pg' };`);
write('src/routes.test.ts', `import './main'; // a test importing the program does not make it a library module
declare const app: { get(p: string, ...h: Function[]): void };
export function fake() { return 1; }
app.get('/fake', fake);`);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-16.1 entry points (TS)', () => {
  const adapter = createTsAdapter(root);

  it('FR-16.1 / FR-16.5 finds decorator routes, router registrations, route() objects and main; skips test files, HTTP client calls, top-level calls of imported modules and tool config files', async () => {
    const eps = await adapter.getEntryPoints!();
    expect(eps.map((e) => `${e.kind} ${e.label} → ${e.method.key.split('#')[1]}`)).toEqual([
      'http GET /orders → <module>.listOrders',
      'http GET /orders/:id → <module>.ordersPlugin', // inline handler: the registering function
      'http GET /users/:id → UsersController.find',
      'http HEAD /orders/:id → <module>.ordersPlugin',
      'http POST /users → UsersController.create',
      'cli main → <module>.main', // also called at module level: one entry
      'cli src/bootstrap.ts: audit() → <module>.audit',
      'cli src/bootstrap.ts: load() → <module>.load',
    ]);
    expect(eps.filter((e) => e.file).map((e) => `${e.file} ${e.method.name}`)).toEqual(['src/bootstrap.ts audit', 'src/bootstrap.ts load']);
    expect(eps.find((e) => e.label === 'GET /users/:id')).toMatchObject({ verb: 'GET', detail: 'controller' });
    expect(joinRoute('/api/', '/x/')).toBe('/api/x');
    expect(joinRoute('', '')).toBe('/');
  });

  it('FR-16.2 an entry point opens as a diagram; an inline route handler shows inside its callback frame', async () => {
    const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
    const eps = await s.getEntryPoints();
    expect(await s.getEntryPoints()).toBe(eps); // cached
    const d = (await s.openMethodByKey(eps.find((e) => e.label === 'GET /orders/:id')!.method.key))!;
    expect(d.root.name).toBe('ordersPlugin');
    // (`fastify` is declared in this project, so its route() call is drawn; from node_modules it is a hidden library call)
    expect(d.messages.map((m) => m.methodName)).toEqual(['ordersPlugin', 'fastify.route', 'load', 'audit']);
    expect(d.fragments![0]).toMatchObject({ kind: 'callback' });
    expect(d.fragments![0].operands[0].guard).toBe('fastify.route: handler');
    expect(await s.openMethodByKey('src/nope.ts#<module>.gone')).toBeUndefined();
  });
});
