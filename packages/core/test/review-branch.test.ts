import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CallPathNode, ClassDiagram, EntryPoint, Finding, MethodRef, Position, SequenceDiagram } from '@seqcall/protocol';
import type { LanguageAdapter } from '../src/adapter';
import type { BranchChanges, FileChange } from '../src/review/git-changes';
import { reviewBranch, type ReviewDeps } from '../src/review/review';

// FR-24 the review of a branch, from given changes and fake analysis results (the session supplies them): what
// counts as a changed method, who reaches it, which issues sit on changed lines, which files are risky.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-review-branch-')).replace(/\\/g, '/');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
const change = (file: string, added: number[], extra: Partial<FileChange> = {}): FileChange => ({ file, status: 'modified', added: new Set(added), removedAt: [], addedCount: added.length, removedCount: 0, ...extra });
const changes = (files: FileChange[], extra: Partial<BranchChanges> = {}): BranchChanges =>
  ({ base: 'develop', resolvedBase: 'develop', mergeBase: 'abcdef1234567', mode: 'split', commits: 1, behind: 0, outside: [], prefix: '', files, hunks: new Map(), fingerprint: 'f', ...extra }) as BranchChanges;
const method = (owner: string, name: string, declLine?: number): MethodRef =>
  ({ key: `${owner}.${name}`, name, owner: { key: owner, name: owner.replace(/^.*#/, ''), kind: 'class' }, isStatic: false, hasBody: true, ...(declLine !== undefined ? { declaration: { file: 'x', start: { line: declLine - 1, character: 0 }, end: { line: declLine - 1, character: 1 } } } : {}) }) as MethodRef;
const ep = (label: string, m: MethodRef, kind: EntryPoint['kind'] = 'http'): EntryPoint => ({ kind, label, method: m }) as EntryPoint;
const range = (file: string, line: number) => ({ file: `${root}/${file}`, start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } });

/** Deps whose adapter finds `methods[file][line]` around a changed line. */
function deps(methods: Record<string, Record<number, MethodRef>>, extra: Partial<ReviewDeps> = {}): ReviewDeps & { asked: number } {
  const d = {
    asked: 0,
    root,
    adapter: {
      findEnclosingCallable: async (file: string, pos: Position) => {
        d.asked++;
        return methods[file.slice(root.length + 1)]?.[pos.line + 1];
      },
    } as unknown as LanguageAdapter,
    entryPoints: async () => [],
    paths: async () => undefined,
    scan: async () => ({}),
    isTest: (f: string) => f.startsWith('tests/'),
    ...extra,
  };
  return d;
}

describe('FR-24.1 the changed methods', () => {
  it('FR-24.1 a file gone from disk is skipped; a method without a declaration is changed; a removal past the end of a file is looked up at its start', async () => {
    write('src/a.ts', 'class A {\n  run() {\n    go();\n  }\n}\n');
    const run = method('src/a.ts#A', 'run');
    const d = deps({ 'src/a.ts': { 3: run, 7: run } });
    const r = (await reviewBranch(d, undefined, changes([change('src/gone.ts', [1]), change('src/a.ts', [3], { removedAt: [7] })])))!;
    expect(r.result.methods).toEqual([{ method: run, status: 'changed', lines: [3], reachedFrom: [], tests: 0 }]);
    expect(d.asked).toBe(2);
  });

  it(`FR-24.1 at most 3000 changed lines are looked up; progress every 50`, async () => {
    write('src/big.ts', Array.from({ length: 3100 }, (_, i) => `x${i};`).join('\n'));
    const seen: number[] = [];
    const d = deps({}, { onProgress: (phase, done) => phase === 'Finding the changed methods' && seen.push(done) });
    const r = (await reviewBranch(d, undefined, changes([change('src/big.ts', Array.from({ length: 3100 }, (_, i) => i + 1))])))!;
    expect(d.asked).toBe(3000);
    expect(r.result.otherLines).toBe(3000);
    expect(seen.slice(0, 2)).toEqual([50, 100]);
    expect(seen.at(-1)).toBe(3000);
  });

  it('FR-24.1 cancelled while looking up lines, walking callers or scanning flows: no result', async () => {
    write('src/c.ts', 'a();\nb();\n');
    const run = method('src/c.ts#C', 'run');
    const marks = (n: number) => {
      let calls = 0;
      return () => ++calls > n;
    };
    const input = () => changes([change('src/c.ts', [1, 2])]);
    expect(await reviewBranch(deps({ 'src/c.ts': { 1: run, 2: run } }, { cancelled: marks(0) }), undefined, input())).toBeUndefined();
    // two lines looked up, then the walk is cancelled
    expect(await reviewBranch(deps({ 'src/c.ts': { 1: run, 2: run } }, { cancelled: marks(2) }), undefined, input())).toBeUndefined();
    // lines and walk done (3 checks), the scan of the unreached method cancelled
    expect(await reviewBranch(deps({ 'src/c.ts': { 1: run, 2: run } }, { cancelled: marks(3) }), undefined, input())).toBeUndefined();
  });
});

describe('FR-24.2 who reaches a changed method', () => {
  it('FR-24.2 an entry point on the method itself, entry points up the paths (each once), tests, a cut walk', async () => {
    write('src/s.ts', 'class S {\n  save() {\n    db();\n  }\n}\n');
    const save = method('src/s.ts#S', 'save', 2);
    const ctl = method('src/c.ts#C', 'post');
    const job = method('src/j.ts#J', 'run');
    const spec = method('tests/s.spec.ts#Spec', 'it');
    const node = (m: MethodRef, extra: Partial<CallPathNode> = {}): CallPathNode => ({ method: m, ...extra });
    const post = ep('POST /s', ctl);
    const tree = node(save, {
      callers: [
        node(ctl, { entryPoints: [post], call: { range: range('src/c.ts', 1), preview: 'x', passed: true } }),
        node(job, { callers: [node(ctl, { entryPoints: [post], call: { range: range('src/c.ts', 2), preview: 'y' } })] }),
        node(spec, { inTest: true }),
        node(job, { entryPoints: [ep('spec', job, 'test')] }),
      ],
    });
    const d = deps(
      { 'src/s.ts': { 3: save } },
      { entryPoints: async () => [ep('CLI save', save, 'cli'), ep('spec save', save, 'test')], paths: async () => ({ tree, methods: 4, truncated: true }) },
    );
    const r = (await reviewBranch(d, undefined, changes([change('src/s.ts', [3])])))!;
    const m = r.result.methods[0];
    expect(m.status).toBe('changed');
    expect(m.reachedFrom.map((x) => `${x.entryPoint.label} ${x.steps.map((s) => `${s.methodKey}${s.call?.passed ? ' (passed)' : ''}`).join(' > ')}`)).toEqual([
      'CLI save src/s.ts#S.save',
      'POST /s src/c.ts#C.post (passed) > src/s.ts#S.save',
    ]);
    expect(m.tests).toBe(2);
    expect(m.truncated).toBe(true);
    // the paths query failing: the method stays without callers
    const failing = deps({ 'src/s.ts': { 3: save } }, { paths: async () => Promise.reject(new Error('x')), entryPoints: async () => Promise.reject(new Error('y')) });
    expect((await reviewBranch(failing, undefined, changes([change('src/s.ts', [3])])))!.result.methods[0].reachedFrom).toEqual([]);
  });
});

describe('FR-24.2 more changed methods than the walk limit', () => {
  it('FR-24.2 the methods past the limit are marked not walked: no "no entry point", no scan as unreached, no paths asked', async () => {
    write('src/m.ts', 'a();\nb();\nc();\n');
    const [a, b, c] = ['a', 'b', 'c'].map((n) => method('src/m.ts#M', n));
    const asked: string[] = [];
    const scanned: string[] = [];
    const d = deps(
      { 'src/m.ts': { 1: a, 2: b, 3: c } },
      {
        maxMethods: 2,
        paths: async (m) => (asked.push(m.name), undefined),
        scan: async (s) => (scanned.push(s.methodKey ?? s.entryPoint!.label), {}),
      },
    );
    const r = (await reviewBranch(d, undefined, changes([change('src/m.ts', [1, 2, 3])])))!;
    expect(r.result.methods.map((m) => [m.method.name, m.notWalked ?? false])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
    expect(asked).toEqual(['a', 'b']);
    // a and b reach no entry point: scanned as unreached; c is unknown, not unreached
    expect(scanned).toEqual([a.key, b.key]);
  });
});

describe('FR-24.3 / FR-24.4 issues on changed lines, risky files', () => {
  it('FR-24.3 an issue is placed by a call, a call of a relation or type use on a changed line, else a changed class; the first place on lines wins', async () => {
    write('src/o.ts', 'class O {\n  run() {\n    a();\n    b();\n  }\n}\n');
    const run = method('src/o.ts#O', 'run');
    const f = (id: string, extra: Partial<Finding>): Finding => ({ id, kind: 'god-class', title: id, ...extra }) as Finding;
    const diagram = { messages: [{ id: 'm1', callSite: range('src/o.ts', 3) }, { id: 'm2' }], findings: [
      f('by-message', { messageIds: ['m2', 'm1'] }),
      f('by-class', { classKeys: ['src/other.ts#X', 'src/o.ts#O'] }),
      f('nowhere', { classKeys: ['src/other.ts#X'] }),
      f('violation-no-classes', { kind: 'layer-violation' }),
      // a violation is the depending class's: an unchanged class depending on the changed one is not this branch's
      f('violation-of-other', { kind: 'layer-violation', classKeys: ['src/other.ts#X', 'src/o.ts#O'] }),
    ] } as unknown as SequenceDiagram;
    const classDiagram = {
      classes: [],
      relations: [
        { id: 'r1', kind: 'dependency', from: 'a', to: 'b', calls: [{ messageId: 'x', label: 'x', callSite: range('src/o.ts', 9) }, { messageId: 'y', label: 'y', callSite: range('src/o.ts', 4) }] },
        { id: 'r2', kind: 'use', from: 'a', to: 'c', uses: [{ method: 'A.a', range: range('src/o.ts', 8) }, { method: 'A.a', range: range('src/o.ts', 4) }] },
      ],
      findings: [f('by-call', { relationIds: ['gone', 'r1'] }), f('by-use', { relationIds: ['r2'] }), f('by-message', { messageIds: ['m1'] })],
    } as unknown as ClassDiagram;
    const scans: Record<string, { diagram?: SequenceDiagram; classDiagram?: ClassDiagram }> = {
      // the first flow sees `twice` in a changed class only, the second on a changed line: the line wins
      // …and `by-message` on a changed line, `by-class` in the changed class: what GET /o finds again does not replace them
      'POST /o': {
        diagram: {
          messages: [{ id: 'p1', callSite: range('src/o.ts', 4) }, { id: 'p2', callSite: range('src/other.ts', 4) }],
          findings: [f('twice', { classKeys: ['src/o.ts#O'] }), f('by-message', { messageIds: ['p2', 'p1'] }), f('by-class', { classKeys: ['src/o.ts#O'] }), f('no-evidence', {})],
        } as unknown as SequenceDiagram,
      },
      'GET /o': { diagram: { messages: [{ id: 'm9', callSite: range('src/o.ts', 3) }], findings: [f('twice', { messageIds: ['m9'] }), f('by-class', { messageIds: ['m9'] })] } as unknown as SequenceDiagram, classDiagram },
    };
    const d = deps(
      { 'src/o.ts': { 3: run, 4: run } },
      {
        entryPoints: async () => [ep('POST /o', run), ep('GET /o', run)],
        scan: async (s) => (s.entryPoint?.label === 'GET /o' ? { ...scans['GET /o'], diagram: { ...diagram, messages: [...diagram.messages, ...scans['GET /o'].diagram!.messages], findings: [...diagram.findings!, ...scans['GET /o'].diagram!.findings!] } } : scans[s.entryPoint!.label]),
      },
    );
    const r = (await reviewBranch(d, undefined, changes([change('src/o.ts', [3, 4])])))!;
    expect(r.result.issues.map((i) => `${i.finding.id} ${i.where}${i.at ? ` ${i.at.file}:${i.at.line}` : ''} ${i.entryPoint?.label}`)).toEqual([
      // first found by POST /o (in a changed class), replaced by GET /o's place on a changed line
      'twice changed-lines src/o.ts:3 GET /o',
      'by-message changed-lines src/o.ts:4 POST /o',
      'by-call changed-lines src/o.ts:4 GET /o',
      'by-use changed-lines src/o.ts:4 GET /o',
      'by-class changed-class POST /o',
    ]);
    expect(r.result.scanned).toBe(2);
  });

  it('FR-24.1 the branch name, and which changed files are test code', async () => {
    write('src/h.ts', 'x();\n');
    const d = deps({});
    const r = (await reviewBranch(d, undefined, changes([change('src/h.ts', [1]), change('tests/h.spec.ts', [1], { status: 'added' })], { branch: 'feature/h' })))!;
    expect(r.result.branch).toBe('feature/h');
    expect(r.result.files.map((f) => `${f.file}${f.test ? ' (test)' : ''}`)).toEqual(['src/h.ts', 'tests/h.spec.ts (test)']);
  });

  it('FR-24.3 a changed method no entry point reaches is scanned on its own; a line added past the end of the file (edited since) is skipped', async () => {
    write('src/u.ts', 'class U {\n  run() {}\n}\n');
    const run = method('src/u.ts#U', 'run');
    const d = deps(
      { 'src/u.ts': { 2: run, 9: run } },
      { scan: async () => ({ diagram: { messages: [{ id: 'm', callSite: range('src/u.ts', 2) }], findings: [{ id: 'x', kind: 'god-class', title: 'x', messageIds: ['m'] }] } as unknown as SequenceDiagram }) },
    );
    const r = (await reviewBranch(d, undefined, changes([change('src/u.ts', [2, 9])])))!;
    expect(d.asked).toBe(1);
    expect(r.result.issues).toEqual([{ finding: { id: 'x', kind: 'god-class', title: 'x', messageIds: ['m'] }, where: 'changed-lines', at: { file: 'src/u.ts', line: 2 }, methodKey: run.key }]);
  });
});

