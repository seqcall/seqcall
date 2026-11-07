import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-ts-jobs-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true, experimentalDecorators: true }, include: ['src'] }));
// as a hexagonal TS backend's reconciler: a use case driven on an interval, dependencies as one destructured object
write('src/reconcile.handler.ts', `export class ReconcileHandler {
  private readonly repo: Repo;
  constructor({ repo, clock, ids, log, http, lock, cfg }: { repo: Repo; clock: Clock; ids: Ids; log: Log; http: Http; lock: Lock; cfg: Cfg }) {
    this.repo = repo;
    this.clock = clock;
    this.ids = ids;
    this.log = log;
    this.http = http;
    this.lock = lock;
    this.cfg = cfg;
  }
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly log: Log;
  private readonly http: Http;
  private readonly lock: Lock;
  private readonly cfg: Cfg;
  async execute(): Promise<void> { await this.repo.all(); }
}
export interface Repo { all(): Promise<number[]> }
export interface Clock { now(): number }
export interface Ids { next(): string }
export interface Log { info(m: string): void }
export interface Http { post(u: string): Promise<void> }
export interface Lock { run(f: () => Promise<void>): Promise<void> }
export interface Cfg { interval: number }
`);
write('src/reconciler.ts', `import type { ReconcileHandler } from './reconcile.handler';
export class Reconciler {
  private readonly useCase: Pick<ReconcileHandler, 'execute'>;
  constructor(deps: { useCase: Pick<ReconcileHandler, 'execute'> }) { this.useCase = deps.useCase; }
  start(): void {
    setInterval(() => void this.run(), 1000);
  }
  private async run(): Promise<void> { await this.useCase.execute(); }
}
// a project function named like a scheduler is not one
export function setIntervalLike(cb: () => void): void { cb(); }
export function schedule(cron: string, cb: () => void): void { cb(); }
export const notAJob = () => schedule('* * * * *', () => undefined);
`);
// as a hexagonal TS backend's audit log entry: an entity takes its values the same way — value objects are no dependencies
write('src/entity.ts', `class Id { constructor(readonly v: string) {} }
class Name { constructor(readonly v: string) {} }
export class Entity {
  private readonly _a: Id; private readonly _b: Name; private readonly _c: Id; private readonly _d: Name;
  private readonly _e: Id; private readonly _f: Name; private readonly _g: Id; private readonly _h: Date;
  private constructor(props: { a: Id; b: Name; c: Id; d: Name; e: Id; f: Name; g: Id; h: Date }) {
    this._a = props.a; this._b = props.b; this._c = props.c; this._d = props.d;
    this._e = props.e; this._f = props.f; this._g = props.g; this._h = props.h;
  }
  static create(): Entity { return new Entity({ a: new Id('a'), b: new Name('b'), c: new Id('c'), d: new Name('d'), e: new Id('e'), f: new Name('f'), g: new Id('g'), h: new Date() }); }
  label(): string { return this._a.v + this._b.v; }
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-16.12 background jobs; FR-19.6 destructured dependencies (TypeScript)', () => {
  const session = () => new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });

  it('FR-16.12 setInterval registers a job: the registering method is the entry point and its flow reaches the use case (through Pick<…>)', async () => {
    const s = session();
    const jobs = (await s.getEntryPoints()).filter((e) => e.kind === 'job');
    expect(jobs.map((e) => [e.label, e.detail])).toEqual([['Reconciler.start', 'setInterval']]);
    await s.openMethodByKey(jobs[0].method.key, jobs[0]);
    const d = (await s.expandEverything())!;
    expect(d.messages.find((m) => m.methodName === 'execute')?.classKey).toBe('src/reconcile.handler.ts#ReconcileHandler');
  });

  it('FR-19.6 dependencies destructured from one constructor parameter (or taken from its properties) are injected: more than 6 is a finding', async () => {
    const s = session();
    await s.openMethodByKey('src/reconcile.handler.ts#ReconcileHandler.execute');
    const cd = (await s.getClassDiagram())!;
    expect(cd.findings?.map((f) => f.title)).toContain('Too many dependencies: ReconcileHandler (7 injected)');
    // `this.useCase = deps.useCase`: one injected field
    await s.openMethodByKey('src/reconciler.ts#Reconciler.run');
    expect((await s.getClassDiagram())!.findings?.some((f) => f.kind === 'too-many-dependencies' && f.title.includes('Reconciler'))).toBeFalsy();
    // an entity's value objects from `props` are not counted
    await s.openMethodByKey('src/entity.ts#Entity.create');
    expect((await s.getClassDiagram())!.findings?.some((f) => f.kind === 'too-many-dependencies')).toBeFalsy();
  });
});
