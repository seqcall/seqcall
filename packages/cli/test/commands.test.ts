import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ContainerBinding, LanguageAdapter } from '@seqcall/core';
import type { CallPathNode, EntryPoint, MethodRef, SourceRange } from '@seqcall/protocol';
import { flowResult, openProject, pathsResult, runEntryPoints, runFlow, runImpls, runIssues, runOutcomes, runPaths, runReview, stableIssueId, toIssue, type Project } from '../src/commands';

/**
 * The command functions (FR-27) on what the core hands them: hand-built diagrams, path trees and review results
 * for the shapes a small project does not produce, and a small project where the input is real.
 */

const range = (file: string, line: number): SourceRange => ({ file, start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } });
const owner = (name: string, key = `src/${name}.ts#${name}`) => ({ key, name, kind: 'class' as const });
const method = (cls: string, name: string, extra: Partial<MethodRef> = {}): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: owner(cls), isStatic: false, hasBody: true, ...extra });

function tempDir(prefix: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)).replace(/\\/g, '/');
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${dir}/${rel}`), { recursive: true });
    fs.writeFileSync(`${dir}/${rel}`, src);
  }
  return dir;
}

describe('flowResult (FR-27.1): frames, labels, I/O', () => {
  const msg = (id: string, methodName: string, extra: object = {}) => ({ id, parentId: id.slice(0, id.lastIndexOf('/')) || undefined, depth: id.split('/').length - 1, methodName, className: 'S', to: 'p', args: [], kind: 'sync', ...extra });

  it('FR-27.1 frames: else / catch operands, guards, ranges; collapsed and unplaced frames left out; operands that start at a minimized frame or end at an early exit', () => {
    const d = {
      root: { key: 'src/s.ts#S.run', name: 'run', owner: { name: 'S' } },
      participants: [{ id: 'p', className: 'S', layer: 'Application' }],
      messages: [msg('root', 'run'), msg('root/0:a', 'a'), msg('root/1:b', 'b'), msg('root/2:c', 'c'), msg('root/3:d', 'd'), msg('root/4:e', 'e')],
      exits: [
        { id: 'root!exit0', ownerMessageId: 'root', kind: 'return', beforeId: 'root/1:b' },
        { id: 'root!exit1', ownerMessageId: 'root', kind: 'return', beforeId: 'root/4:e' },
        { id: 'root!exit9', ownerMessageId: 'root', kind: 'return' },
      ],
      fragments: [
        {
          id: 'f-alt',
          kind: 'alt',
          ownerMessageId: 'root',
          range: range('/p/src/s.ts', 4),
          operands: [
            { guard: 'x > 0', firstMessageId: 'root/0:a', lastMessageId: 'root/0:a', range: range('/p/src/s.ts', 5) },
            { guard: 'else', firstMessageId: 'root/1:b', lastMessageId: 'root/1:b' },
          ],
        },
        {
          id: 'f-try',
          kind: 'try',
          ownerMessageId: 'root',
          operands: [
            { firstMessageId: 'root/2:c', lastMessageId: 'root/2:c' },
            { guard: 'Error e', firstMessageId: 'root/3:d', lastMessageId: 'root/3:d' },
          ],
        },
        { id: 'f-collapsed', kind: 'loop', collapsed: true, beforeId: 'root/3:d', ownerMessageId: 'root', operands: [{ guard: 'each x of xs', firstMessageId: 'root/0:a', lastMessageId: 'root/4:e' }] },
        { id: 'f-nowhere', kind: 'opt', ownerMessageId: 'root', operands: [{ guard: 'ok', firstMessageId: 'root/9:gone', lastMessageId: 'root/9:gone' }] },
        // starts at the minimized frame (it sits before root/3:d), ends at the exit before root/4:e: root/3:d only
        { id: 'f-mini', kind: 'loop', ownerMessageId: 'root', operands: [{ guard: 'each y of ys', firstMessageId: 'f-collapsed', lastMessageId: 'root!exit1' }] },
        // ends at an exit with nothing after it, in a frame whose owner is not a message: to the end of the diagram
        // starts at an exit (before root/1:b), ends at the minimized frame (before root/3:d): root/1:b and root/2:c
        { id: 'f-between', kind: 'opt', ownerMessageId: 'root', operands: [{ guard: 'z', firstMessageId: 'root!exit0', lastMessageId: 'f-collapsed' }] },
        { id: 'f-tail', kind: 'opt', ownerMessageId: 'root/7:gone', operands: [{ guard: 'last', firstMessageId: 'root/4:e', lastMessageId: 'root!exit9' }] },
      ],
    } as never;
    const r = flowResult('/p', d);
    // no declaration: no place (the key is left out, not set to undefined)
    expect(r.method).toStrictEqual({ key: 'src/s.ts#S.run', label: 'S.run', layer: 'Application' });
    const frames = Object.fromEntries(r.calls!.map((c) => [c.call, c.frames ?? []]));
    expect(frames).toEqual({
      'S.a': ['alt [x > 0] @ src/s.ts:5'],
      'S.b': ['else @ src/s.ts:4', 'opt [z]'],
      'S.c': ['try', 'opt [z]'],
      'S.d': ['catch [Error e]', 'loop [each y of ys]'],
      'S.e': ['opt [last]'],
    });
  });

  it('FR-27.1 labels: constructors, calls without a class; library and recursive calls; a method that is its own owner (a function)', () => {
    const d = {
      root: { key: 'src/main.ts#main', name: 'main', owner: { name: 'main' }, declaration: range('/elsewhere/main.ts', 3) },
      participants: [{ id: 'p', className: 'Shop' }, { id: 'q' }],
      messages: [
        msg('root', 'main', { to: 'p' }),
        msg('root/0:Shop', 'constructor', { kind: 'create', className: undefined }),
        msg('root/1:Thing', 'constructor', { kind: 'create', className: undefined, to: 'q' }),
        msg('root/2:fmt', 'fmt', { className: undefined, to: 'q', isLibrary: true, callSite: range('/elsewhere/main.ts', 4) }),
        msg('root/3:main', 'main', { className: undefined, recursive: true, expandable: true }),
      ],
    } as never;
    const r = flowResult('/p', d);
    expect(r.method).toEqual({ key: 'src/main.ts#main', label: 'main', at: '/elsewhere/main.ts:3' });
    expect(r.calls!.map(({ call, library, recursive, folded, at }) => ({ call, library, recursive, folded, at }))).toEqual([
      { call: '«create» Shop', library: undefined, recursive: undefined, folded: undefined, at: undefined },
      { call: '«create» constructor', library: undefined, recursive: undefined, folded: undefined, at: undefined },
      { call: 'fmt', library: true, recursive: undefined, folded: undefined, at: '/elsewhere/main.ts:4' },
      { call: 'Shop.main', library: undefined, recursive: true, folded: true, at: undefined },
    ]);
    // no root message: no layer for the method
    expect(flowResult('/p', { ...(d as object), messages: [] } as never).method).toEqual({ key: 'src/main.ts#main', label: 'main', at: '/elsewhere/main.ts:3' });
  });

  it('FR-27.1 the I/O list: work handed off to run later; a loop with no `each` guard is no per-element loop; calls whose caller is not in the diagram', () => {
    const db = { sideEffects: { kinds: ['db'], evidence: ['Db.query'] } };
    const d = {
      root: { key: 'src/s.ts#S.run', name: 'run', owner: { name: 'S' } },
      participants: [{ id: 'p', className: 'S' }],
      messages: [
        msg('root', 'run'),
        msg('root/0:later', 'later', db),
        msg('root/1:poll', 'poll', db),
        { ...msg('root/2:orphan', 'orphan', db), parentId: undefined },
        { ...msg('root/3:lost', 'lost', db), parentId: 'root/8:gone' },
        { ...msg('root/5:p', 'p'), parentId: undefined },
        msg('root/5:p/0:x', 'x', db),
      ],
      fragments: [
        { id: 'f-cb', kind: 'callback', ownerMessageId: 'root', operands: [{ guard: 'later: block.Post', firstMessageId: 'root/0:later', lastMessageId: 'root/0:later' }] },
        { id: 'f-while', kind: 'loop', ownerMessageId: 'root', operands: [{ firstMessageId: 'root/1:poll', lastMessageId: 'root/1:poll' }] },
        { id: 'f-each', kind: 'loop', ownerMessageId: 'root', operands: [{ guard: 'each i of is', firstMessageId: 'root/5:p', lastMessageId: 'root/5:p' }] },
        // not a callback: a guard starting "later: " is no hand-off
        { id: 'f-opt', kind: 'opt', ownerMessageId: 'root', operands: [{ guard: 'later: cached', firstMessageId: 'root/3:lost', lastMessageId: 'root/3:lost' }] },
        { id: 'f-cb2', kind: 'callback', ownerMessageId: 'root', operands: [{ firstMessageId: 'root/2:orphan', lastMessageId: 'root/2:orphan' }] },
      ],
      findings: [
        { id: 'x1', kind: 'io-in-loop', title: 'I/O in a loop: S.poll (DB)', messageIds: ['root/1:poll'] },
        { id: 'x2', kind: 'io-in-loop', title: 'I/O in a loop: S.later (DB)', messageIds: ['root/0:later'] },
        { id: 'x3', kind: 'io-in-loop', title: 'I/O in a loop: somewhere' },
        { id: 'x4', kind: 'io-in-loop', title: 'I/O in a loop: S.lost (DB)', messageIds: ['root/3:lost'] },
        // another kind of issue in the loop: no loop named
        { id: 'x5', kind: 'god-class', title: 'Big S', messageIds: ['root/1:poll'] },
        // a call in no frame at all
        { id: 'x6', kind: 'io-in-loop', title: 'I/O in a loop: S.run (DB)', messageIds: ['root'] },
      ],
    } as never;
    const r = flowResult('/p', d);
    expect(r.io).toEqual([
      { kinds: ['db'], call: 'S.later', id: 'root/0:later', via: [], later: true },
      { kinds: ['db'], call: 'S.poll', id: 'root/1:poll', via: [] },
      { kinds: ['db'], call: 'S.orphan', id: 'root/2:orphan', via: [] },
      { kinds: ['db'], call: 'S.lost', id: 'root/3:lost', via: [] },
      // its caller has no caller in the diagram: the chain and the loop's reach stop there
      { kinds: ['db'], call: 'S.x', id: 'root/5:p/0:x', via: ['S.p'], inLoop: true },
    ]);
    // the N+1's loop: only for a call inside one
    expect(r.issues.map((i) => i.loop)).toEqual(['loop', undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('issues (FR-27.2)', () => {
  it('FR-27.2 an issue about no class and no silencing key has its title as id; places outside the project stay absolute', () => {
    const f = { id: 'r1', kind: 'god-class' as const, title: 'Big flow', detail: 'too many calls', evidence: ['a', 'b'], messageIds: ['m1', 'm2'] };
    expect(stableIssueId(f)).toBe('god-class:Big flow');
    const messages = [{ id: 'm1', callSite: range('/lib/x.ts', 2) }, { id: 'm2' }] as never;
    expect(toIssue('/p', f, messages)).toEqual({ id: 'god-class:Big flow', kind: 'god-class', certainty: 'definite', title: 'Big flow', detail: 'too many calls', evidence: ['a', 'b'], at: ['/lib/x.ts:2'] });
    expect(toIssue('/p', { ...f, evidence: [], classKeys: [] })).toEqual({ id: 'god-class:Big flow', kind: 'god-class', certainty: 'definite', title: 'Big flow', detail: 'too many calls' });
  });
});

describe('pathsResult (FR-27.3)', () => {
  it('FR-27.3 test callers counted, not in the tree; --tests lists test methods once per class, sorted, with the file when known', () => {
    const test = (cls: string, name: string, declared: boolean): CallPathNode => ({
      method: method(cls, name, declared ? { declaration: range(`/p/tests/${cls}.ts`, 3) } : {}),
      inTest: true,
      entryPoints: [{ kind: 'test', label: `${cls}.${name}`, method: method(cls, name) } as EntryPoint],
      end: 'test',
    });
    const tree: CallPathNode = {
      method: method('Repo', 'save'),
      callers: [
        { method: method('Svc', 'place'), call: { range: range('/p/src/Svc.ts', 9), preview: 'repo.save(o)', count: 1 }, end: 'top', callers: [test('ZTest', 'places', true), test('ZTest', 'places twice', true)] },
        test('ATest', 'saves', false),
        { method: method('Job', 'run'), call: { range: range('/p/src/Job.ts', 2), preview: 'each(this.repo.save)', passed: true, count: 3 }, end: 'limit' },
      ],
    };
    const r = pathsResult('/p', tree, 5, { tests: true });
    expect(r.target).toEqual({
      method: 'Repo.save',
      key: 'src/Repo.ts#Repo.save',
      tests: 1,
      callers: [
        { method: 'Svc.place', key: 'src/Svc.ts#Svc.place', call: { at: 'src/Svc.ts:9', code: 'repo.save(o)' }, end: 'top', tests: 2 },
        { method: 'Job.run', key: 'src/Job.ts#Job.run', call: { at: 'src/Job.ts:2', code: 'each(this.repo.save)', passed: true, count: 3 }, end: 'limit' },
      ],
    });
    expect(r.tests).toBe(3);
    expect(r.testList).toEqual([
      { class: 'ATest', methods: ['saves'] },
      { class: 'ZTest', file: 'tests/ZTest.ts', methods: ['places', 'places twice'] },
    ]);
    expect(pathsResult('/p', tree, 5).testList).toBeUndefined();
    // a test method as the target: its walk ends as a test, which the tree does not say (tests are only counted)
    expect(pathsResult('/p', { ...test('ATest', 'saves', true), inTest: false }, 1).target).toStrictEqual({ method: 'ATest.saves', key: 'src/ATest.ts#ATest.saves' });
  });
});

describe('the command functions on a small TypeScript project', () => {
  let dir: string;
  let p: Project;
  beforeAll(() => {
    dir = tempDir('seqcall-commands-', {
      'tsconfig.json': '{"compilerOptions":{"strict":true}}',
      'src/c.ts': 'export class C {\n  go(): number {\n    return this.one();\n  }\n  one(): number {\n    return 1;\n  }\n}\n',
      'src/b.ts': "import { C } from './c';\nexport class B {\n  constructor(private c: C) {}\n  step(): number {\n    return this.c.go();\n  }\n}\n",
      'src/a.ts': "import { B } from './b';\nexport class A {\n  run(b: B): number {\n    return b.step();\n  }\n}\n",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await p?.session.dispose();
    await p?.adapter.dispose();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const open = () => (p = openProject({ cwd: dir }));
  const at = (file: string, line: number) => ({ file: `${dir}/src/${file}`, line });
  const tree = async (opts: { depth?: number } = {}) => (await runFlow(open(), at('a.ts', 4), { ...opts, tree: true })).result.calls!.map((c) => `${c.call}${c.folded ? ' (folded)' : ''}`);

  it('FR-27.1 flow --depth n opens n levels below the method; without it, everything', async () => {
    expect(await tree({ depth: 2 })).toEqual(['B.step', 'C.go (folded)']);
    expect(await tree({ depth: 3 })).toEqual(['B.step', 'C.go', 'C.one']);
    expect(await tree()).toEqual(['B.step', 'C.go', 'C.one']);
  });

  it('FR-27.1 flow: the expand limit names its reason (calls or depth); a step that gives no new diagram keeps the last one', async () => {
    const project = open();
    const expand = project.session.expandEverything.bind(project.session);
    let notice: object = { reason: 'messages', limit: 500, folded: 3 };
    vi.spyOn(project.session, 'expandEverything').mockImplementation(async () => ({ ...(await expand())!, expandNotice: notice }) as never);
    vi.spyOn(project.session, 'scanSideEffects').mockResolvedValue(undefined);
    expect((await runFlow(project, at('a.ts', 4))).limits).toEqual(['expand limit (500 calls): 3 calls left folded']);
    notice = { reason: 'depth', limit: 12, folded: 1 };
    expect((await runFlow(project, at('a.ts', 4))).limits).toEqual(['expand limit (depth 12): 1 calls left folded']);
    vi.restoreAllMocks();
    for (const step of ['expandEverything', 'expandAll', 'scanSideEffects'] as const) vi.spyOn(project.session, step).mockResolvedValue(undefined);
    expect((await runFlow(project, at('a.ts', 4), { tree: true })).result.calls!.map((c) => c.call)).toEqual(['B.step']);
    expect((await runFlow(project, at('a.ts', 4), { tree: true, depth: 2 })).result.calls!.map((c) => c.call)).toEqual(['B.step']);
  });

  it('FR-27.3 paths: a project without tests; a walk cut by its limits; a target that is no project method', async () => {
    const project = open();
    const r = await runPaths(project, at('c.ts', 6));
    expect(r).toEqual({
      result: {
        target: {
          method: 'C.one',
          key: 'src/c.ts#C.one',
          callers: [
            {
              method: 'C.go',
              key: 'src/c.ts#C.go',
              call: { at: 'src/c.ts:3', code: 'return this.one();' },
              callers: [{ method: 'B.step', key: 'src/b.ts#B.step', call: { at: 'src/b.ts:5', code: 'return this.c.go();' }, callers: [{ method: 'A.run', key: 'src/a.ts#A.run', call: { at: 'src/a.ts:4', code: 'return b.step();' }, end: 'top' }] }],
            },
          ],
        },
        reachedFrom: {},
        tests: 0,
        methodsSearched: 4,
      },
      limits: [],
    });
    const walk = project.session.findPathsToHere.bind(project.session);
    vi.spyOn(project.session, 'findPathsToHere').mockImplementation(async (id) => ({ ...(await walk(id))!, truncated: true }));
    expect((await runPaths(project, at('c.ts', 6))).limits).toEqual(['walk limits (depth 12, 400 methods, 300 paths): some paths cut (end: "limit")']);
    vi.spyOn(project.session, 'findPathsToHere').mockResolvedValue(undefined);
    await expect(runPaths(project, at('c.ts', 6))).rejects.toThrow('the target is no project method');
  });

  it('FR-27.8 entrypoints with no options: tests left out, no filter', async () => {
    const project = open();
    const eps: EntryPoint[] = [
      { kind: 'cli', label: 'main', method: method('Main', 'main'), project: 'Tool', file: `${dir}/src/main.ts` } as EntryPoint,
      { kind: 'test', label: 'ATest.a', method: method('ATest', 'a') } as EntryPoint,
    ];
    vi.spyOn(project.session, 'getEntryPoints').mockResolvedValue(eps);
    expect(await runEntryPoints(project)).toEqual({ result: { entryPoints: [{ kind: 'cli', label: 'main', method: 'Main.main', key: 'src/Main.ts#Main.main', project: 'Tool', file: 'src/main.ts' }], total: 1 }, limits: [] });
    // the project and the file match filter words too
    expect((await runEntryPoints(project, { filter: 'tool main.ts' })).result.entryPoints).toHaveLength(1);
    expect((await runEntryPoints(project, { filter: 'tool jobs' })).result).toEqual({ entryPoints: [], total: 1, filter: 'tool jobs' });
    // blanks only: no filter
    expect((await runEntryPoints(project, { filter: '  ' })).result).toStrictEqual((await runEntryPoints(project)).result);
  });

  it('FR-32.5 outcomes: only the entry points the words match are scanned; classes, calls with file:line, notes; tests left out', async () => {
    const project = open();
    const http = { kind: 'http', label: 'POST /orders', method: method('Orders', 'create', { declaration: range(`${dir}/src/Orders.ts`, 4) }) } as EntryPoint;
    const job = { kind: 'job', label: 'Nightly.run', method: method('Nightly', 'run') } as EntryPoint;
    const test = { kind: 'test', label: 'OrdersTest.it', method: method('OrdersTest', 'it') } as EntryPoint;
    vi.spyOn(project.session, 'getEntryPoints').mockResolvedValue([http, job, test]);
    const scan = vi.spyOn(project.session, 'findOutcomes').mockImplementation(async (opts) =>
      [
        {
          entry: http,
          outcome: {
            io: [{ kind: 'db' as const, via: [{ className: 'Repo', classKey: 'src/Repo.ts#Repo', calls: [{ call: 'Db.insert', at: range(`${dir}/src/Repo.ts`, 9) }] }, { className: 'Audit', calls: [{ call: 'Db.log' }] }] }],
            atLeast: true as const,
            folded: 2,
            wide: [{ call: 'Handler.handle', implementations: 9 }],
            deep: ['Client.send'],
            unresolved: 3,
          },
        },
        { entry: job, failed: true as const },
      ].filter((x) => opts!.only!.has(`${x.entry.kind}|${x.entry.label}|${x.entry.method.key}`)),
    );
    expect(await runOutcomes(project)).toEqual({
      result: {
        entryPoints: [
          {
            kind: 'http',
            label: 'POST /orders',
            method: 'Orders.create',
            key: 'src/Orders.ts#Orders.create',
            at: 'src/Orders.ts:4',
            io: [{ kind: 'db', via: [{ class: 'Repo', calls: [{ call: 'Db.insert', at: 'src/Repo.ts:9' }] }, { class: 'Audit', calls: [{ call: 'Db.log' }] }] }],
            atLeast: true,
            folded: 2,
            wide: [{ call: 'Handler.handle', implementations: 9 }],
            deep: ['Client.send'],
            unresolved: 3,
          },
          { kind: 'job', label: 'Nightly.run', method: 'Nightly.run', key: 'src/Nightly.ts#Nightly.run', io: [], failed: true },
        ],
        total: 2,
      },
      limits: ['1 flow not followed to the end (calls left folded, an interface call with too many implementations, or I/O deeper than the walk goes): their I/O may be more'],
    });
    expect(scan.mock.calls[0][0]!.only).toEqual(new Set(['http|POST /orders|src/Orders.ts#Orders.create', 'job|Nightly.run|src/Nightly.ts#Nightly.run']));
    const nightly = await runOutcomes(project, { filter: 'nightly' });
    expect(scan.mock.calls[1][0]!.only).toEqual(new Set(['job|Nightly.run|src/Nightly.ts#Nightly.run']));
    expect(nightly).toEqual({ result: { entryPoints: [{ kind: 'job', label: 'Nightly.run', method: 'Nightly.run', key: 'src/Nightly.ts#Nightly.run', io: [], failed: true }], total: 2, filter: 'nightly' }, limits: [] });
    // two flows cut: the plural
    scan.mockResolvedValue([http, http].map((entry) => ({ entry, outcome: { io: [], atLeast: true as const } })));
    expect((await runOutcomes(project)).limits).toEqual(['2 flows not followed to the end (calls left folded, an interface call with too many implementations, or I/O deeper than the walk goes): their I/O may be more']);
  });

  it('FR-27.9 issues: other entry points and files of each issue; flows the expand limit cut; a cancelled scan', async () => {
    const project = open();
    const ep = { kind: 'http', label: 'GET /a', method: method('A', 'run') } as EntryPoint;
    vi.spyOn(project.session, 'getEntryPoints').mockResolvedValue([ep, { kind: 'test', label: 't', method: method('T', 't') } as EntryPoint]);
    vi.spyOn(project.session, 'findProjectIssues').mockResolvedValue([
      { finding: { id: 'f1', kind: 'dependency-cycle', title: 'Cycle: A → B → A', classKeys: ['src/B.ts#B', 'src/A.ts#A'] }, entryPoint: ep, others: 2, files: ['src/a.ts'] },
      { finding: { id: 'f2', kind: 'god-class', title: 'Big' }, entryPoint: ep, files: [] },
    ] as never);
    vi.spyOn(project.session, 'projectTruncatedCount', 'get').mockReturnValue(4);
    expect(await runIssues(project)).toEqual({
      result: {
        issues: [
          { id: 'dependency-cycle:A,B', kind: 'dependency-cycle', certainty: 'definite', title: 'Cycle: A → B → A', classes: ['B', 'A'], flow: 'GET /a', flowKey: 'src/A.ts#A.run', others: 2, files: ['src/a.ts'] },
          { id: 'god-class:Big', kind: 'god-class', certainty: 'definite', title: 'Big', flow: 'GET /a', flowKey: 'src/A.ts#A.run' },
        ],
        entryPoints: 1,
      },
      limits: ['expand limit: 4 entry-point flows not fully opened, issues further down may be missing'],
    });
    vi.spyOn(project.session, 'findProjectIssues').mockResolvedValue(undefined);
    await expect(runIssues(project)).rejects.toThrow('scan cancelled');
  });

  it('FR-27.10 impls: an adapter with no DI container, or one whose container read fails, lists no registrations', async () => {
    const project = open();
    const m = (await runImpls(project, at('c.ts', 6))).result;
    expect(m).toEqual({ method: { label: 'C.one', key: 'src/c.ts#C.one', at: 'src/c.ts:5', abstract: false }, implementations: [], registrations: [] });
    (project.adapter as { getBindings?(): Promise<ContainerBinding[]> }).getBindings = () => Promise.reject(new Error('sidecar died'));
    expect((await runImpls(project, { methodKey: 'src/c.ts#C.one' })).result.registrations).toEqual([]);
  });
});

describe('runPaths test evidence (FR-22.5) on a small PHP project', () => {
  let dir: string;
  let p: Project;
  beforeAll(() => {
    dir = tempDir('seqcall-tests-', {
      'composer.json': '{"name":"x/y"}',
      'routes/api.php': "<?php\nRoute::post('orders', [OrderController::class, 'store']);\n",
      'app/BaseRepo.php': '<?php\nabstract class BaseRepo {}\n',
      'app/Repo.php': '<?php\nclass Repo extends BaseRepo {\n  public function save(array $o): void {\n  }\n  public function count(): int {\n    return 0;\n  }\n}\n',
      'app/OrderService.php': '<?php\nclass OrderService { public function __construct(private Repo $repo) {} public function place(array $o): void { $this->repo->save($o); } }\n',
      'app/OrderController.php': '<?php\nclass OrderController { public function __construct(private OrderService $orders) {} public function store(): array { $this->orders->place([]); return []; } }\n',
      'tests/Unit/OrderServiceTest.php':
        '<?php\nclass OrderServiceTest extends TestCase {\n  public function test_places(): void { $repo = $this->createMock(BaseRepo::class); (new OrderService($repo))->place([]); }\n  public function test_places_again(): void { (new OrderService(new Repo()))->place([]); }\n  public function test_counts(): void { (new Repo())->count(); }\n}\n',
      'tests/Feature/smoke.php': "<?php\n$this->postJson('/api/orders', []);\n",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await p?.session.dispose();
    await p?.adapter.dispose();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = () => ({ file: `${dir}/app/Repo.php`, line: 3 });

  it('FR-22.5 a mocked base class counts as mocking the way down; an HTTP call outside any method has no method', async () => {
    p = openProject({ cwd: dir });
    const { result } = await runPaths(p, target(), { tests: true });
    expect(result.tests).toBe(2);
    expect(result.testsMocking).toBe(2);
    expect(result.testList).toEqual([{ class: 'OrderServiceTest', file: 'tests/Unit/OrderServiceTest.php', methods: ['test_places', 'test_places_again'], mocks: ['BaseRepo'] }]);
    expect(result.httpTests).toEqual([{ route: 'POST /api/orders', at: 'tests/Feature/smoke.php:2', by: 'url' }]);
    // reached by a test only: no route, so no HTTP tests; the test's file mocks Repo's base class (in another test)
    const count = (await runPaths(p, { file: `${dir}/app/Repo.php`, line: 6 })).result;
    expect(count).toStrictEqual({ target: { method: 'Repo.count', key: count.target.key, tests: 1 }, reachedFrom: {}, tests: 1, testsMocking: 1, methodsSearched: count.methodsSearched });
  });

  it('FR-22.5 when the class facts cannot be read, only the class names count; test methods with no place or outside the test files have no mocks', async () => {
    p = openProject({ cwd: dir });
    const walk = p.session.findPathsToHere.bind(p.session);
    const extra = (cls: string, declaration?: SourceRange): CallPathNode => ({ method: { ...method(cls, 'test_it'), ...(declaration ? { declaration } : {}) }, inTest: true, entryPoints: [{ kind: 'test', label: `${cls}.test_it`, method: method(cls, 'test_it') } as EntryPoint], end: 'test' });
    vi.spyOn(p.session, 'findPathsToHere').mockImplementation(async (id) => {
      const r = (await walk(id))!;
      // the class facts fail after the walk (the sidecar died)
      vi.spyOn(p.adapter, 'getClassInfo').mockRejectedValue(new Error('sidecar died'));
      return { ...r, tree: { ...r.tree, callers: [...(r.tree.callers ?? []), extra('GhostTest'), extra('HelperTest', range(`${dir}/app/HelperTest.php`, 2))] } };
    });
    const { result } = await runPaths(p, target(), { tests: true });
    expect(result.testsMocking).toBeUndefined();
    expect(result.testList).toEqual([
      { class: 'GhostTest', methods: ['test_it'] },
      { class: 'HelperTest', file: 'app/HelperTest.php', methods: ['test_it'] },
      { class: 'OrderServiceTest', file: 'tests/Unit/OrderServiceTest.php', methods: ['test_places', 'test_places_again'] },
    ]);
  });
});

describe('runReview (FR-27.4) on what the review gives', () => {
  const ep = { kind: 'http', label: 'GET /a', method: method('A', 'run') } as EntryPoint;
  const review = (extra: object = {}) => ({
    base: 'develop',
    resolvedBase: 'origin/develop',
    files: [
      { file: 'src/a.ts', status: 'modified', added: 1, removed: 2 },
      { file: 'test/a.test.ts', status: 'added', added: 5, removed: 0, test: true },
    ],
    methods: [
      { method: method('A', 'run', { declaration: range('/p/src/A.ts', 3) }), status: 'changed', lines: [3, 4, 5, 9], reachedFrom: [{ entryPoint: ep }, { entryPoint: ep }], tests: 1 },
      { method: method('A', 'gone'), status: 'added', lines: [7], reachedFrom: [], tests: 0, truncated: true },
    ],
    issues: [
      { finding: { id: 'i1', kind: 'io-in-loop', title: 'I/O in a loop: Db.q (DB)' }, at: { file: 'src/a.ts', line: 4 }, where: 'changed-lines', entryPoint: ep },
      { finding: { id: 'i2', kind: 'god-class', title: 'Big' }, where: 'changed-class', methodKey: 'src/A.ts#A.gone' },
      { finding: { id: 'i3', kind: 'god-class', title: 'Bigger' }, where: 'changed-class' },
    ],
    notScanned: 0,
    ...extra,
  });
  const project = (r: object | undefined, refs: () => Promise<object> = async () => ({ target: 'develop' })) => {
    const calls: object[] = [];
    const session = {
      gitRefs: refs,
      reviewChanges: async (opts: object) => (calls.push(opts), r),
    };
    return { p: { root: '/p', language: 'typescript', session } as unknown as Project, calls };
  };

  it('FR-27.4 files, methods (line ranges, entry points once), issues with their place and flow', async () => {
    const { p, calls } = project(review({ compare: { mode: 'direct', point: 'abc', commits: 2, behind: 3, outside: [] } }));
    const { result, limits } = await runReview(p, { direct: true });
    expect(calls).toEqual([{ base: 'develop', force: true, mode: 'direct' }]);
    expect(limits).toEqual(['1 changed methods: walk up the callers cut by its limits']);
    expect(result).toEqual({
      base: 'develop',
      compared: 'tip against tip of develop (abc, 2 commits, 3 behind)',
      files: [
        { path: 'src/a.ts', status: 'modified', added: 1, removed: 2 },
        { path: 'test/a.test.ts', status: 'added', added: 5, removed: 0, test: true },
      ],
      methods: [
        { method: 'A.run', key: 'src/A.ts#A.run', status: 'changed', lines: 'src/A.ts:3-5,9', reachedFrom: ['GET /a'], tests: 1 },
        { method: 'A.gone', key: 'src/A.ts#A.gone', status: 'added', lines: '7', reachedFrom: [], tests: 0, truncated: true },
      ],
      issues: [
        { id: 'io-in-loop:I/O in a loop: Db.q (DB)', kind: 'io-in-loop', certainty: 'definite', title: 'I/O in a loop: Db.q (DB)', at: ['src/a.ts:4'], where: 'changed-lines', flow: 'GET /a' },
        { id: 'god-class:Big', kind: 'god-class', certainty: 'definite', title: 'Big', where: 'changed-class', flow: 'A.gone' },
        { id: 'god-class:Bigger', kind: 'god-class', certainty: 'definite', title: 'Bigger', where: 'changed-class' },
      ],
    });
  });

  it('FR-24.2 methods past the walk limit: a limit line, marked not walked', async () => {
    const { p } = project(review({ methods: [{ method: method('A', 'more'), status: 'added', lines: [9], reachedFrom: [], tests: 0, notWalked: true }] }));
    const { result, limits } = await runReview(p);
    expect(limits).toEqual(['1 changed methods not walked up to the entry points (limit): who reaches them is unknown']);
    expect(result.methods).toEqual([{ method: 'A.more', key: 'src/A.ts#A.more', status: 'added', lines: '9', reachedFrom: [], tests: 0, notWalked: true }]);
  });

  it('FR-27.4 no base found (no git refs): the review picks its own; flows left unscanned; compared with a ref when there is no compare point', async () => {
    const { p, calls } = project(review({ notScanned: 6, branch: 'feature/x', compare: { mode: 'split', point: 'abc', commits: 1, behind: 0, outside: [] } }), async () => {
      throw new Error('not a git repository');
    });
    const { result, limits } = await runReview(p);
    expect(calls).toStrictEqual([{ force: true, mode: 'split' }]);
    expect(limits).toEqual(['6 entry-point flows not scanned for issues (limit)', '1 changed methods: walk up the callers cut by its limits']);
    expect(result).toMatchObject({ branch: 'feature/x', compared: 'since the branch split off develop (abc, 1 commits)' });
    // a base given: asked for as it is; no compare point: the resolved ref
    const plain = project(review());
    expect((await runReview(plain.p, { base: 'main' })).result.compared).toBe('origin/develop');
    expect(plain.calls).toEqual([{ base: 'main', force: true, mode: 'split' }]);
  });

  it('FR-29 structure rows: their pairs with the call place, the flow (not for entry-point rows), the structure limit; a cancelled review', async () => {
    const structure = {
      rows: [
        { kind: 'edge-added', title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer', pairs: [{ fromName: 'Order', toName: 'Db', call: { callSite: range('/p/src/order.ts', 4) } }, { fromName: 'Order', toName: 'Cache' }], entryPoint: ep },
        { kind: 'entry-added', title: 'GET /a', entryPoint: ep, pairs: [] },
      ],
      compared: 3,
      copied: 1,
      notCompared: 2,
    };
    const { result, limits } = await runReview(project(review({ structure })).p);
    expect(result.structure).toEqual({
      rows: [
        { kind: 'edge-added', title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer', pairs: ['Order → Db  src/order.ts:4', 'Order → Cache'], flow: 'GET /a' },
        { kind: 'entry-added', title: 'GET /a' },
      ],
      compared: 3,
      copied: 1,
      notCompared: 2,
    });
    expect(limits).toContain('2 affected entry points not compared with the base (structure limit)');
    expect((await runReview(project(review({ structure: { ...structure, notCompared: 0 } })).p)).limits).toEqual(['1 changed methods: walk up the callers cut by its limits']);
    await expect(runReview(project(undefined).p)).rejects.toThrow('review cancelled');
  });
});

describe('runImpls (FR-27.10) on what the adapter gives', () => {
  it('FR-27.10 implementations without a place; keyed registrations (key by default), for one consumer, for type arguments', async () => {
    const iface = { key: 'src/I.cs#INotifier', name: 'INotifier', kind: 'interface' as const };
    const m: MethodRef = { key: 'src/I.cs#INotifier.Send()', name: 'Send', owner: iface, isStatic: false, hasBody: false };
    const at = range('/p/src/Program.cs', 8);
    const bindings: ContainerBinding[] = [
      { abstract: iface.key, concrete: 'src/Mail.cs#MailNotifier', range: at, key: 'mail', abstractArgs: [] },
      { abstract: 'src/J.cs#IOther', concrete: 'src/O.cs#Other', range: at },
      { abstract: iface.key, concrete: 'src/Sms.cs#SmsNotifier', range: at, key: 'sms', keyKind: 'condition', consumer: 'src/Shop.cs#Shop', abstractArgs: ['src/Order.cs#Order'] },
    ];
    const adapter = { getMethod: async () => m, getImplementations: async () => [{ ...m, key: 'gen#Gen.Send()', owner: { key: 'gen#Gen', name: 'Gen', kind: 'class' } }], getBindings: async () => bindings } as unknown as LanguageAdapter;
    const { result } = await runImpls({ root: '/p', language: 'csharp', adapter } as unknown as Project, { methodKey: m.key });
    expect(result).toStrictEqual({
      method: { label: 'INotifier.Send', key: m.key, abstract: true },
      implementations: [{ method: 'Gen.Send', key: 'gen#Gen.Send()' }],
      registrations: [
        { concrete: 'MailNotifier', at: 'src/Program.cs:8', key: 'mail', keyKind: 'key' },
        { concrete: 'SmsNotifier', at: 'src/Program.cs:8', key: 'sms', keyKind: 'condition', consumer: 'Shop', typeArgs: ['Order'] },
      ],
    });
  });
});
