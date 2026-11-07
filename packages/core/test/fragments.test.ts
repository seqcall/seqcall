import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/session';
import type { Fragment, SequenceDiagram } from '@seqcall/protocol';
import { file, method, newSession, positionOf, sharedAdapter } from './helpers';
// FR-3.12 these tests check the frames and catches as the code has them: ↯ Fold errors off
const UNFOLDED = { initialState: { options: { ...DEFAULT_OPTIONS, foldErrors: false } } };

const REL = 'src/services/import-service.ts';
const RUN = `${REL}#ImportService.run`;
const IMPORT_ALL = `${REL}#ImportService.importAll`;
const SYNC = `${REL}#ImportService.sync`;

/** "kind[guard1 | guard2]: first..last" per operand, method names only. */
function describeFragments(d: SequenceDiagram): string[] {
  const name = (id: string) => id.slice(id.lastIndexOf(':') + 1);
  return (d.fragments ?? []).map(
    (f: Fragment) =>
      `${f.kind} ${f.operands.map((o) => `[${o.guard ?? ''}] ${name(o.firstMessageId)}..${name(o.lastMessageId)}`).join(' ')}`,
  );
}

describe('TsAdapter: enclosing control flow of call sites (FR-1.10)', () => {
  it('FR-1.10 reports enclosing constructs outermost first, with guard and condition range', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method(IMPORT_ALL));
    const notify = calls.find((c) => c.methodName === 'notify')!;
    expect(notify.fragments?.map((f) => [f.kind, f.operand, f.guard])).toEqual([
      ['loop', 0, 'each user of users'],
      ['alt', 2, 'else'],
    ]);
    const error = calls.find((c) => c.methodName === 'error')!;
    expect(error.fragments?.[1].range?.start).toEqual(positionOf(REL, 'user.name.length === 0'));
    expect(error.fragments?.[1].range?.file).toBe(file(REL));
    // finally always runs: no scope; library calls in the loop header are outside the loop
    const done = calls.filter((c) => c.methodName === 'info').pop()!;
    expect(done.fragments).toBeUndefined();
  });

  it('FR-1.11 calls in a callback passed to a library iteration are in a loop scope, after the outer scopes', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method(SYNC));
    const describes = calls.filter((c) => c.methodName === 'describe');
    expect(describes.map((c) => c.fragments?.map((f) => `${f.kind}[${f.guard}]`))).toEqual([
      ['loop[attempts < 3]', 'alt[found]'],
      ['loop[each u of [user]]'],
    ]);
  });

  it('FR-19.1 a call that leaves the loop is marked: in a return / throw, or one follows it in its block before continue', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createTsAdapter } = await import('../src/ts/ts-adapter');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-ts-leaves-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${tmp}/tsconfig.json`, '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["*.ts"]}');
      fs.writeFileSync(
        `${tmp}/s.ts`,
        `class Repo { find(x: number) { return x; } save(x: number) { return x; } log(x: number) {} warn(x: number) {} }
export class S {
  constructor(private repo: Repo) {}
  run(xs: number[]) {
    for (const x of xs) {
      this.repo.find(x);
      if (x > 1) return this.repo.save(x);
      if (x > 2) { this.repo.log(x); throw new Error('e'); }
      if (x > 3) { this.repo.warn(x); continue; }
    }
    for (const x of xs) return this.repo.find(x);
    xs.forEach((x) => { return this.repo.log(x); });
  }
}
`,
      );
      const a = createTsAdapter(tmp);
      const calls = await a.getOutgoingCalls((await a.getMethod('s.ts#S.run'))!);
      const leaves = calls.filter((c) => c.methodName !== 'constructor').map((c) => `${c.methodName}:${c.fragments?.find((f) => f.kind === 'loop')?.leavesLoop ?? false}`);
      // a return inside a callback leaves the callback, not the loop over the elements
      expect(leaves).toEqual(['find:false', 'save:true', 'log:true', 'warn:false', 'find:true', 'forEach:false', 'log:false']);
      await a.dispose();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('DiagramSession: combined fragments (FR-1.10)', () => {
  it('FR-1.10 loop, alt chain (if / else if / else), opt and try/catch', async () => {
    const d = await newSession(UNFOLDED).openMethod(await method(IMPORT_ALL));
    expect(describeFragments(d)).toEqual([
      'loop [each user of users] error..notify',
      'alt [user.name.length === 0] error..error [user.managerId] save..save [else] save..notify',
      'opt [announce] info..info',
      'try [] findById..findById [catch] error..error',
    ]);
    const alt = d.fragments![1];
    expect(alt.parentId).toBe(d.fragments![0].id);
    expect(alt.ownerMessageId).toBe('root');
    expect(alt.range?.start).toEqual(positionOf(REL, 'user.name.length === 0'));
  });

  it('FR-1.17 a catch without visible calls says what happens to the error; one that rethrows draws no frame', async () => {
    const s = newSession(UNFOLDED);
    const lookup = await s.openMethod(await method(`${REL}#ImportService.lookup`));
    expect(describeFragments(lookup)).toEqual(['try [] findById..findById']);
    expect(lookup.fragments![0].catches).toEqual([expect.objectContaining({ guard: 'catch', outcome: '↩ undefined', swallowed: false })]);

    const saveEach = await newSession(UNFOLDED).openMethod(await method(`${REL}#ImportService.saveEach`));
    expect(describeFragments(saveEach)).toEqual(['loop [each user of users] save..save', 'try [] save..save']);
    expect(saveEach.fragments![1].catches).toEqual([expect.objectContaining({ guard: 'catch', outcome: 'logged, skipped', swallowed: true })]);

    const strict = await newSession(UNFOLDED).openMethod(await method(`${REL}#ImportService.strict`));
    expect(strict.fragments ?? []).toEqual([]);
  });

  it('FR-1.17 a visible catch operand carries its outcome', async () => {
    const d = await newSession(UNFOLDED).openMethod(await method(IMPORT_ALL));
    const tryFrame = d.fragments!.find((f) => f.kind === 'try')!;
    expect(tryFrame.operands[1]).toMatchObject({ guard: 'catch', outcome: 'logged, swallowed', swallowed: true });
    expect(tryFrame.catches).toBeUndefined();
  });

  it('FR-1.10 switch with fall-through, while loop with a nested conditional expression, nested ifs merged', async () => {
    const d = await newSession(UNFOLDED).openMethod(await method(SYNC));
    expect(describeFragments(d)).toEqual([
      "alt [mode = 'full' | 'deep'] save..save [else] info..info",
      'loop [attempts < 3] findById..info',
      'alt [found] describe..describe [else] fallback..fallback',
      'opt [user.managerId && user.email.length > 0] notify..notify',
      'loop [each u of [user]] describe..describe',
    ]);
  });

  it('FR-1.10 only fragments with visible messages: hidden operands are dropped, alt degrades to opt', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(IMPORT_ALL));
    const d = (await s.hide({ kind: 'class', classKey: 'src/util/logger.ts#Logger', className: 'Logger' }))!;
    // Logger hidden: alt loses its first branch, opt [announce] and the catch operand disappear;
    // FR-1.17 the catch, now without visible calls, is a row saying what it does with the error
    expect(describeFragments(d)).toEqual([
      'loop [each user of users] save..notify',
      'alt [user.managerId] save..save [else] save..notify',
      'try [] findById..findById',
    ]);
    expect(d.fragments![2].catches).toEqual([{ guard: 'catch', outcome: 'logged, swallowed', swallowed: true, range: expect.objectContaining({ file: file(REL) }) }]);

    const s2 = newSession(UNFOLDED);
    await s2.openMethod(await method(SYNC));
    const d2 = (await s2.hide({ kind: 'methodName', methodName: 'describe' }))!;
    expect(describeFragments(d2)).toContain('opt [!found] fallback..fallback');
  });

  it('FR-1.10 fragments of an expanded call belong to that message; message ids are unchanged', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(RUN));
    const d = (await s.expand('root/0:importAll'))!;
    expect(d.fragments!.every((f) => f.ownerMessageId === 'root/0:importAll' && f.id.startsWith('root/0:importAll#'))).toBe(true);
    expect(d.fragments![0].operands[0].firstMessageId).toBe('root/0:importAll/0:error');

    const off = (await s.setOption('showFragments', false))!;
    expect(off.fragments).toBeUndefined();
    expect(off.messages.map((m) => m.id)).toEqual(d.messages.map((m) => m.id));
    expect(s.getPersistentState().options.showFragments).toBe(false);
  });

  it('FR-1.10 library calls shown: their scopes join the fragments', async () => {
    const s = newSession({ initialState: { options: { foldErrors: false, showArguments: true, maxArgumentLength: 30, showLibraryCalls: true, followCursor: false } } });
    const d = await s.openMethod(await method(SYNC));
    // [user].forEach(...) is unconditional; the fragment set is unchanged
    expect(d.messages.some((m) => m.methodName === 'forEach')).toBe(true);
    expect(describeFragments(d)).toHaveLength(5);
    expect(d.options.showFragments).toBe(true);
  });
});

describe('DiagramSession: minimized fragments (FR-1.12)', () => {
  const ids = (d: SequenceDiagram) => d.messages.map((m) => m.methodName);
  const byKind = (d: SequenceDiagram, kind: string) => d.fragments!.find((f) => f.kind === kind)!;

  it('FR-1.12 fragment ids are stable: owner, kind, nesting and the ordinal of the first call', async () => {
    const d = await newSession(UNFOLDED).openMethod(await method(IMPORT_ALL));
    expect(d.fragments!.map((f) => f.id)).toEqual(['root#loop0@0', 'root#alt1@0', expect.stringMatching(/^root#opt0@\d+$/), expect.stringMatching(/^root#try0@\d+$/)]);
  });

  it('FR-1.12 minimizing a loop folds its calls into one stub; restoring brings them back', async () => {
    const s = newSession(UNFOLDED);
    const before = await s.openMethod(await method(IMPORT_ALL));
    const loop = byKind(before, 'loop');
    const d = (await s.collapseFragment(loop.id))!;
    expect(ids(d)).toEqual(['importAll', 'info', 'findById', 'error', 'info']);
    const stub = d.fragments!.find((f) => f.id === loop.id)!;
    expect(stub).toMatchObject({ kind: 'loop', collapsed: true, hiddenCount: 4, beforeId: d.messages[1].id });
    expect(stub.operands).toEqual([expect.objectContaining({ guard: 'each user of users', firstMessageId: loop.id, lastMessageId: loop.id })]);
    // nested alt is folded with it; the other fragments are untouched
    expect(d.fragments!.map((f) => f.kind)).toEqual(['loop', 'opt', 'try']);
    // participants only reached inside the loop leave both diagrams
    expect(d.participants.some((p) => p.className === 'Notifier')).toBe(false);
    expect((await s.getClassDiagram())!.classes.some((c) => c.name === 'Notifier')).toBe(false);

    const restored = (await s.expandFragment(loop.id))!;
    expect(ids(restored)).toEqual(ids(before));
    expect(restored.fragments!.some((f) => f.collapsed)).toBe(false);
  });

  it('FR-1.12 a minimized inner fragment stays inside its outer frame; a last one has no beforeId', async () => {
    const s = newSession(UNFOLDED);
    const before = await s.openMethod(await method(IMPORT_ALL));
    const alt = byKind(before, 'alt');
    const d = (await s.collapseFragment(alt.id))!;
    const loop = byKind(d, 'loop');
    expect(loop.collapsed).toBeUndefined();
    expect(loop.operands[0]).toMatchObject({ firstMessageId: alt.id, lastMessageId: alt.id });
    expect(byKind(d, 'alt')).toMatchObject({ collapsed: true, hiddenCount: 4, parentId: loop.id });

    const s2 = newSession(UNFOLDED);
    const sync = await s2.openMethod(await method(SYNC));
    const opt = sync.fragments!.find((f) => f.kind === 'opt')!; // opt [user.managerId && …] around notify
    const d2 = (await s2.collapseFragment(opt.id))!;
    const stub = d2.fragments!.find((f) => f.id === opt.id)!;
    expect(stub).toMatchObject({ collapsed: true, hiddenCount: 1 });
    expect(d2.messages.find((m) => m.id === stub.beforeId)?.methodName).toBe('describe'); // the forEach callback's call follows
    expect(stub.operands[0].guard).toBe('user.managerId'); // outer guard of the merged pair
    // the forEach callback loop is the last child of the body: no beforeId
    const last = sync.fragments![sync.fragments!.length - 1];
    expect(last.operands[0].guard).toBe('each u of [user]');
    const d3 = (await s2.collapseFragment(last.id))!;
    expect(d3.fragments!.find((f) => f.id === last.id)).toMatchObject({ collapsed: true, hiddenCount: 1 });
    expect(d3.fragments!.find((f) => f.id === last.id)!.beforeId).toBeUndefined();
  });

  it('FR-1.12 survives refresh and is ignored while fragments are switched off', async () => {
    const s = newSession(UNFOLDED);
    const before = await s.openMethod(await method(IMPORT_ALL));
    const loop = byKind(before, 'loop');
    await s.collapseFragment(loop.id);
    const refreshed = (await s.refresh([file(REL)]))!;
    expect(refreshed.fragments!.find((f) => f.id === loop.id)?.collapsed).toBe(true);
    const off = (await s.setOption('showFragments', false))!;
    expect(ids(off)).toEqual(ids(before));
    const on = (await s.setOption('showFragments', true))!;
    expect(on.fragments!.find((f) => f.id === loop.id)?.collapsed).toBe(true);
    // unknown ids are ignored
    expect(ids((await s.collapseFragment('root#nope0@9'))!)).toEqual(ids(on));
  });

  it('FR-1.12 a minimized fragment of an expanded call stays minimized when the call is collapsed and expanded again', async () => {
    const s = newSession(UNFOLDED);
    await s.openMethod(await method(RUN));
    const d = (await s.expand('root/0:importAll'))!;
    const loop = byKind(d, 'loop');
    expect(loop.id).toBe('root/0:importAll#loop0@0');
    const folded = (await s.collapseFragment(loop.id))!;
    expect(folded.messages.filter((m) => m.parentId === 'root/0:importAll').map((m) => m.methodName)).toEqual(['info', 'findById', 'error', 'info']);
    // collapsing and re-expanding the owner keeps the fragment minimized
    await s.collapse('root/0:importAll');
    const again = (await s.expand('root/0:importAll'))!;
    expect(again.fragments!.find((f) => f.id === loop.id)?.collapsed).toBe(true);
  });
});
