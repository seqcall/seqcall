import { describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { DEFAULT_TSCONFIG, tsProject } from './ts-project';

// FR-16.1 / FR-16.5 / FR-16.12 entry points of TS projects, for the less common registrations, on small projects.

const show = (eps: EntryPoint[]) => eps.map((e) => `${e.kind} ${e.label} → ${e.method.key.split('#')[1]}${e.detail ? ` (${e.detail})` : ''}`);

const pkg = (name: string, dts: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: 'index.d.ts' }),
  [`node_modules/${name}/index.d.ts`]: dts,
});

describe('FR-16.12 background jobs (TS)', () => {
  it('FR-16.12 node-cron, node-schedule, cron and BullMQ registrations, NestJS / Bull decorators; not a project function of the same name, a string or a missing callback', async () => {
    const { adapter } = tsProject({
      ...pkg('node-cron', 'export function schedule(expr: string, fn: () => void): void;\n'),
      ...pkg('node-schedule', 'export function scheduleJob(name: string, rule: unknown, fn: () => void): void;\n'),
      ...pkg('cron', 'export class CronJob { constructor(expr: string, fn: () => void); }\n'),
      ...pkg('bullmq', 'export class Worker { constructor(queue?: string, fn?: (job: unknown) => Promise<void>); }\n'),
      'src/decorators.ts': 'export const Cron = (e: string) => (t: any, k: string) => undefined;\nexport const Interval = (ms: number) => (t: any, k: string) => undefined;\nexport const Process = () => (t: any, k: string) => undefined;\n',
      'src/own.ts': 'export function schedule(expr: string, fn: () => void) { fn(); }\n',
      'src/own-jobs.ts': "import { schedule } from './own';\nexport function cleanup() {}\nschedule('x', cleanup);\n",
      'src/globals.d.ts': 'declare function setInterval(cb: unknown, ms: number): number;\n',
      'src/jobs.ts': `import * as cron from 'node-cron';
import { schedule } from 'node-cron';
import { scheduleJob } from 'node-schedule';
import { CronJob } from 'cron';
import { Worker } from 'bullmq';
import { Cron, Interval, Process } from './decorators';
export function nightly() {}
export function hourly() {}
export function weekly() {}
export async function work(job: unknown) {}
export function tick() {}
export function tock() {}
const EXPR = '0 * * * *';
cron.schedule('0 0 * * *', nightly);
schedule(EXPR, hourly);
scheduleJob('weekly', '0 0 * * 0', weekly);
new CronJob('* * * * *', tick);
new Worker('mail', work);
new Worker;
setInterval(tock, 1000);
export class Tasks {
  @Cron('0 1 * * *') report() {}
  @Interval(5000) poll() {}
  @Process() handle() {}
}
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, lib: ['ES2022'], types: [] } });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'job'))).toEqual([
      'job hourly → <module>.hourly (cron)',
      'job nightly → <module>.nightly (cron 0 0 * * *)',
      'job Tasks.handle → Tasks.handle (queue worker)',
      'job Tasks.poll → Tasks.poll (interval)',
      'job Tasks.report → Tasks.report (cron 0 1 * * *)',
      'job tick → <module>.tick (cron * * * * *)',
      'job weekly → <module>.weekly (schedule weekly)',
      'job work → <module>.work (queue worker mail)',
    ]);
  });

  it('FR-16.12 the TypeScript lib: its setInterval is a job (not with code as a string); its Web Worker is not a BullMQ worker; an unresolved `schedule` is nothing', async () => {
    const { adapter } = tsProject({
      'src/jobs.ts': `export function tick() {}
setInterval(tick, 1000);
new Worker('worker.js');
schedule('x', tick);
export function startLegacy() { setInterval('tick()', 1000); }
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, lib: ['ES2022', 'DOM'], types: [] } });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'job'))).toEqual(['job tick → <module>.tick (setInterval)']);
  });
  it('FR-16.12 a TypeScript lib outside node_modules (`…/typescript/lib/lib.*.d.ts`): its setInterval is a job, its Worker no BullMQ worker', async () => {
    const { adapter } = tsProject({
      'tools/typescript/lib/lib.timers.d.ts': 'declare function setInterval(cb: () => void, ms: number): number;\ndeclare class Worker { constructor(q: string, fn?: (job: unknown) => Promise<void>); }\n',
      'src/jobs.ts': 'export function tick() {}\nexport async function work(job: unknown) {}\nsetInterval(tick, 1000);\nnew Worker(\'q\', work);\n',
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, lib: ['ES2022'], types: [] } });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'job'))).toEqual(['job tick → <module>.tick (setInterval)']);
  });
});

describe('FR-16.1 HTTP routes (TS)', () => {
  it('FR-16.1 route() objects: `path` or `url`, one verb or several (string keys too, non-literal verbs skipped); none without verb, literal URL, handler or object', async () => {
    const { adapter } = tsProject({
      'src/routes.ts': `declare const fastify: any;
declare const options: object;
declare const dynamicUrl: string;
declare const verbVar: string;
export function list(req: unknown) {}
export function create(req: unknown) {}
export function other(req: unknown) {}
export function dynamic(req: unknown) {}
fastify.route({ method: 'GET', path: '/d', handler: list });
fastify.route({ 'method': ['POST', verbVar], 'url': '/e', handler: create });
fastify.route({ url: '/f', handler: other });
fastify.route({ method: 'GET', url: dynamicUrl, handler: dynamic });
fastify.route({ method: 'GET', url: '/g', handler() {} });
fastify.route({ method: 'GET', url: '/h' });
fastify.route(options);
fastify.route();
`,
    });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'http'))).toEqual([
      'http GET /d → <module>.list (route())',
      'http POST /e → <module>.create (route())',
    ]);
  });

  it('FR-16.1 router handlers: typed `any` only when it is a function of the project; a bound method; a parameter → the registering function', async () => {
    const { adapter } = tsProject({
      'src/routes.ts': `declare const app: any;
declare const handlerAny: any;
const typedAny: any = (req: unknown) => {};
export class Ctrl { list(req: unknown) {} }
const ctrl = new Ctrl();
export function routesAny() { app.get('/a', handlerAny); }
app.get('/b', typedAny);
app.get('/c', ctrl.list.bind(ctrl));
export function register(server: any, h: (r: unknown) => void) { server.post('/h', h); }
`,
    });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'http'))).toEqual([
      'http GET /b → <module>.typedAny (router)',
      'http GET /c → Ctrl.list (router)',
      'http POST /h → <module>.register (router)',
    ]);
  });

  it('FR-16.1 controller prefixes: `{ path: … }`, none, not a literal; a decorator without arguments', async () => {
    const { adapter } = tsProject({
      'src/decorators.ts': 'export const Controller = (p?: unknown) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n',
      'src/shop.ts': `import { Controller, Get } from './decorators';
const PREFIX = 'x';
@Controller({ path: 'shop', version: '1' })
export class Shop { @Get('items') items() {} @Get() home() {} }
@Controller()
export class Root { @Get('health') health() {} }
@Controller(PREFIX)
export class Dynamic { @Get('y') y() {} }
@Controller({ version: '2' })
export class NoPath { @Get('z') z() {} }
`,
    });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'http'))).toEqual([
      'http GET /health → Root.health (controller)',
      'http GET /shop → Shop.home (controller)',
      'http GET /shop/items → Shop.items (controller)',
      'http GET /y → Dynamic.y (controller)',
      'http GET /z → NoPath.z (controller)',
    ]);
  });
});

describe('FR-16.5 module-level calls (TS)', () => {
  it('FR-16.5 `start().catch(…)` runs start; a `.then` on a value, an assignment, a call of an unknown function are no entries; files imported by `import = require` or dynamic import with a variable', async () => {
    const { adapter } = tsProject({
      'src/main.ts': `import lib = require('./lib');
declare const promise: Promise<number>;
declare const name: string;
export async function start() {}
start().catch(console.error);
promise.then(() => 1);
let x = 0;
x = 1;
unknownFn();
import(name);
lib.boot();
`,
      // imported (by `import = require`): its own top-level call is no program start
      'src/lib.ts': 'export function boot() {}\nfunction selfInit() {}\nselfInit();\n',
    });
    expect(show((await adapter.getEntryPoints()).filter((e) => e.kind === 'cli'))).toEqual([
      'cli src/main.ts: boot() → <module>.boot (module-level call)',
      'cli src/main.ts: start() → <module>.start (module-level call)',
    ]);
  });
});
