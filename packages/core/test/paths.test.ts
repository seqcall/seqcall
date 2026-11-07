import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CallerInfo, CallPathNode, CallPathStep, EntryPoint, MethodRef } from '@seqcall/protocol';
import { createClassifier } from '../src/classifier-impl';
import { findPathsToHere } from '../src/paths';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { K, byId, method, newSession } from './helpers';

// ── a fake callers graph: name → callers (enclosing names); "t:" = in a test file ──
const ref = (name: string): MethodRef => ({ key: `src/x.ts#X.${name}`, name, owner: { key: 'src/x.ts#X', name: 'X', kind: 'class' }, hasBody: true }) as MethodRef;
function graphWalk(edges: Record<string, string[]>, entryPoints: EntryPoint[] = []) {
  const asked: string[] = [];
  return {
    asked,
    walk: {
      entryPoints,
      callers: async (m: MethodRef): Promise<CallerInfo[]> => {
        asked.push(m.name);
        return (edges[m.name] ?? []).map((c, i) => {
          const inTest = c.startsWith('t:');
          const name = inTest ? c.slice(2) : c;
          return { id: `${m.name}<${name}${i}`, enclosing: ref(name), range: { file: 'src/x.ts', start: { line: i, character: 0 }, end: { line: i, character: 1 } }, preview: `${m.name}()`, ...(inTest ? { inTest } : {}) };
        });
      },
    },
  };
}
const http = (name: string, label: string): EntryPoint => ({ kind: 'http', verb: label.split(' ')[0], label, method: ref(name) });
/** "a ← b ← c" lines of a tree, depth first. */
function paths(n: CallPathNode, below: string[] = []): string[] {
  const here = [...below, n.method.name];
  if (!n.callers?.length) return [`${here.join(' ← ')}${n.end ? ` [${n.end}]` : ''}`];
  return n.callers.flatMap((c) => paths(c, here));
}

describe('Paths to here: the walk (FR-22.1)', () => {
  it('FR-22.1 walks callers up to entry points, tests and methods nothing calls', async () => {
    const { walk, asked } = graphWalk(
      { repo: ['service'], service: ['controller', 'job', 't:spec'], controller: ['t:controllerSpec'], job: [] },
      [http('controller', 'GET /users/:id')],
    );
    const r = (await findPathsToHere(ref('repo'), walk))!;
    expect(paths(r.tree)).toEqual(['repo ← service ← controller [entry]', 'repo ← service ← job [top]', 'repo ← service ← spec [test]']);
    expect(r.tree.callers![0].callers![0].entryPoints![0].label).toBe('GET /users/:id');
    // the walk stops at the entry point and in tests: their callers are never searched
    expect(asked).toEqual(['repo', 'service', 'job']);
    expect(r).toMatchObject({ methods: 3, truncated: false });
  });

  it('FR-22.1 several calls from one method are one step; recursion is not a new path', async () => {
    const { walk } = graphWalk({ find: ['chain', 'chain', 'rename'], chain: ['chain', 'main'], rename: ['find'] });
    const r = (await findPathsToHere(ref('find'), walk))!;
    expect(paths(r.tree)).toEqual(['find ← chain ← main [top]', 'find ← rename [top]']);
    expect(r.tree.callers![0].call).toMatchObject({ count: 2 });
  });

  it('FR-22.1 a method reached on several paths appears under each; limits cut the walk and say so', async () => {
    const { walk } = graphWalk({ a: ['b', 'c'], b: ['d'], c: ['d'], d: ['e'], e: ['f'] });
    expect(paths((await findPathsToHere(ref('a'), walk))!.tree)).toEqual(['a ← b ← d ← e ← f [top]', 'a ← c ← d ← e ← f [top]']);
    const cut = (await findPathsToHere(ref('a'), { ...walk, maxDepth: 3 }))!;
    expect(paths(cut.tree)).toEqual(['a ← b ← d ← e [limit]', 'a ← c ← d ← e [limit]']);
    expect(cut.truncated).toBe(true);
    const few = (await findPathsToHere(ref('a'), { ...walk, maxLeaves: 1 }))!;
    expect(paths(few.tree)).toHaveLength(1);
    expect(few.truncated).toBe(true);
  });

  it('FR-22.1 the method limit stops searching callers: the methods not searched end their paths as [limit]', async () => {
    const { walk, asked } = graphWalk({ a: ['b', 'c'], b: ['d'], c: ['e'] });
    const r = (await findPathsToHere(ref('a'), { ...walk, maxMethods: 2 }))!;
    // a and b are searched; c is next in the same breadth-first level and is not
    expect(asked).toEqual(['a', 'b']);
    expect(paths(r.tree)).toEqual(['a ← b ← d [limit]', 'a ← c [limit]']);
    expect(r).toMatchObject({ methods: 2, truncated: true });
  });

  it('FR-22.1 the target may itself be an entry point: its callers are still walked', async () => {
    const { walk } = graphWalk({ controller: ['t:spec'] }, [http('controller', 'GET /x')]);
    const r = (await findPathsToHere(ref('controller'), walk))!;
    expect(r.tree.entryPoints).toHaveLength(1);
    expect(paths(r.tree)).toEqual(['controller ← spec [test]']);
  });

  it('FR-22.1 cancelling stops the walk', async () => {
    const { walk } = graphWalk({ a: ['b'], b: ['c'] });
    expect(await findPathsToHere(ref('a'), { ...walk, cancelled: () => true })).toBeUndefined();
  });
});

describe('Paths to here in a session (FR-22.1, FR-22.3)', () => {
  it('FR-22.1 an implementation is reached through calls on its interface', async () => {
    const s = newSession();
    await s.openMethod(await method(K.sqlFindById));
    const progress: number[] = [];
    const r = (await s.findPathsToHere('root', { onProgress: (n) => progress.push(n) }))!;
    const lines = paths(r.tree);
    expect(lines).toContain('findById ← findUser ← getUser [top]');
    expect(lines).toContain('findById ← findUser ← rename ← renameUser [top]');
    expect(lines.some((l) => l.includes('managementChain ← managementChain'))).toBe(false);
    expect(progress.at(-1)).toBe(r.methods);
  });

  it('FR-22.3 opening a path expands it from its start down to the target, choosing implementations', async () => {
    const s = newSession();
    await s.openMethod(await method(K.sqlFindById));
    const r = (await s.findPathsToHere('root'))!;
    const findUser = r.tree.callers!.find((c) => c.method.key === K.findUser)!;
    const getUser = findUser.callers!.find((c) => c.method.key === K.getUser)!;
    const steps: CallPathStep[] = [
      { methodKey: K.getUser, call: { range: getUser.call!.range } },
      { methodKey: K.findUser, call: { range: findUser.call!.range } },
      { methodKey: K.sqlFindById },
    ];
    const { diagram, messageId } = (await s.openPath(steps))!;
    expect(diagram!.root.key).toBe(K.getUser);
    expect(byId(diagram!, 'root/2:findUser').expanded).toBe(true);
    const target = byId(diagram!, messageId);
    expect(target.methodKey).toBe(K.sqlFindById);
    expect(target.expanded).toBe(true);
    expect(diagram!.canGoBack).toBe(true);
  });

  it('FR-22.3 a path through a method passed as an argument expands its invocation (FR-4.5)', async () => {
    const REL = 'src/services/format-service.ts';
    const PLAIN = `${REL}#UserFormat.plain`;
    const s = newSession();
    await s.openMethod(await method(PLAIN));
    const r = (await s.findPathsToHere('root'))!;
    const first = r.tree.callers!.find((c) => c.method.name === 'first')!;
    expect(first.call?.passed).toBe(true);
    const { diagram, messageId } = (await s.openPath([{ methodKey: first.method.key, call: { range: first.call!.range, passed: true } }, { methodKey: PLAIN }]))!;
    const target = byId(diagram!, messageId);
    expect(target).toMatchObject({ methodKey: PLAIN, viaParameter: 'f' });
  });
});

describe('Paths to here end at entry points (FR-22.1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-paths-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;
export const Get = (p?: string) => (t: any, k: string) => undefined;`);
  write('src/service.ts', `export function load(id: string) { return id; }
export function find(id: string) { return load(id); }`);
  write('src/users.controller.ts', `import { Controller, Get } from './decorators';
import { find } from './service';
@Controller('users')
export class UsersController {
  @Get(':id') show(id: string) { return find(id); }
}`);
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('FR-22.1 a path ends at the route that reaches the method', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('src/service.ts#<module>.load');
    const r = (await s.findPathsToHere('root'))!;
    expect(paths(r.tree)).toEqual(['load ← find ← show [entry]']);
    expect(r.tree.callers![0].callers![0].entryPoints![0]).toMatchObject({ kind: 'http', label: 'GET /users/:id' });
    // opened from the path: the entry point's tag is at the gate
    const ep = r.tree.callers![0].callers![0].entryPoints![0];
    const steps: CallPathStep[] = [
      { methodKey: ep.method.key, call: { range: r.tree.callers![0].callers![0].call!.range } },
      { methodKey: 'src/service.ts#<module>.find', call: { range: r.tree.callers![0].call!.range } },
      { methodKey: 'src/service.ts#<module>.load' },
    ];
    const { diagram, messageId } = (await s.openPath(steps, ep))!;
    expect(diagram!.entryPoints?.[0].label).toBe('GET /users/:id');
    expect(byId(diagram!, messageId).methodKey).toBe('src/service.ts#<module>.load');
  });
});
