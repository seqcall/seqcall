import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EntryPoint, FlowOutcome, HideFilter, Message, MethodRef } from '@seqcall/protocol';
import { createClassifier } from '../src/classifier-impl';
import { outcomeOfFlow, toOutcome } from '../src/outcomes';
import { DiagramSession } from '../src/session';
import type { CallSite } from '../src/adapter';
import type { BuildResult, BuiltNode } from '../src/session/build';
import { createTsAdapter } from '../src/ts/ts-adapter';

const ROOT = path.resolve(__dirname, '../../../fixtures/io-app').replace(/\\/g, '/');
const adapter = createTsAdapter(ROOT);
afterAll(() => adapter.dispose());

const session = (options: Record<string, boolean> = {}, filters: HideFilter[] = []) =>
  new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { ...options } as never, filters } });
/** A flow as the background session sees it: opened, expanded fully, I/O scanned. */
const scanned = async (key: string, options: Record<string, boolean> = {}, filters: HideFilter[] = []) => {
  const s = session(options, filters);
  await s.openMethodByKey(key);
  await s.expandEverything();
  await s.scanSideEffects();
  return s.flowOutcome()!;
};
/** Files relative to the fixture, `file:line` (1-based), for short expectations. */
const short = (o: FlowOutcome | undefined) =>
  o && {
    ...o,
    io: o.io.map((k) => ({ ...k, via: k.via.map((v) => ({ ...v, calls: v.calls.map((c) => `${c.call}${c.at ? ` ${c.at.file.slice(ROOT.length + 1)}:${c.at.start.line + 1}` : ''}`) })) })),
  };
const entry = async (label: string) => (await session().getEntryPoints()).find((e) => e.label === label)!;

const SHARE: ReturnType<typeof short> = {
  io: [
    { kind: 'http', via: [{ className: 'NoteService', classKey: 'src/services/note-service.ts#NoteService', calls: ['fetch src/services/note-service.ts:13'] }] },
    { kind: 'file', via: [{ className: 'FileNotes', classKey: 'src/adapters/file-notes.ts#FileNotes', calls: ['fs/promises.readFile src/adapters/file-notes.ts:9'] }] },
  ],
};

describe('FR-32 entry point outcomes', () => {
  it('FR-32.1 the I/O of the whole flow by kind, each kind with the classes whose bodies do it, their library calls and where', async () => {
    // console output (`process.stdout.write` in NoteService.shout) is no I/O
    expect(short(await scanned('src/routes.ts#<module>.shareNote'))).toEqual(SHARE);
    expect(short(await scanned('src/routes.ts#<module>.showNote'))).toEqual({
      io: [{ kind: 'file', via: [{ className: 'FileNotes', classKey: 'src/adapters/file-notes.ts#FileNotes', calls: ['fs/promises.readFile src/adapters/file-notes.ts:9'] }] }],
    });
  });

  it('FR-32.1 drawn library calls are counted once, with the body that makes them', async () => {
    expect(short(await scanned('src/routes.ts#<module>.shareNote', { showLibraryCalls: true }))).toEqual(SHARE);
  });

  it('FR-32.1 an interface call with no implementation chosen: the I/O all its implementations do (FR-17.6), each charged to its implementation\'s class', async () => {
    // Notifier: Slack and Mail post (HTTP), the pager stub only throws; AuditLog: only one of two writes a file — left out
    expect(short(await scanned('src/services/alerter.ts#Alerter.alert'))).toEqual({
      io: [
        {
          kind: 'http',
          via: [
            { className: 'MailNotifier', classKey: 'src/adapters/notifiers.ts#MailNotifier', calls: ['fetch src/adapters/notifiers.ts:12'] },
            { className: 'SlackNotifier', classKey: 'src/adapters/notifiers.ts#SlackNotifier', calls: ['fetch src/adapters/notifiers.ts:6'] },
          ],
        },
      ],
    });
  });

  it('FR-32.1 a call left folded with calls of its own ("don\'t expand" rule) makes the outcome "at least"; the I/O below it still counts', async () => {
    const noExpand: HideFilter = { id: 'f1', kind: 'classMethod', classKey: 'src/services/note-service.ts#NoteService', className: 'NoteService', methodName: 'load', noExpand: true };
    expect(short(await scanned('src/routes.ts#<module>.showNote', {}, [noExpand]))).toEqual({
      io: [{ kind: 'file', via: [{ className: 'FileNotes', classKey: 'src/adapters/file-notes.ts#FileNotes', calls: ['fs/promises.readFile src/adapters/file-notes.ts:9'] }] }],
      atLeast: true,
      why: '1 call left folded',
      folded: 1,
    });
  });

  it('FR-32.1 hiding a call does not change the outcome: its I/O counts through its body', async () => {
    const hide: HideFilter = { id: 'f1', kind: 'class', classKey: 'src/adapters/file-notes.ts#FileNotes', className: 'FileNotes' };
    const kinds = (o: FlowOutcome) => o.io.map((k) => `${k.kind}: ${k.via.map((v) => v.className).join(', ')}`);
    expect(kinds(await scanned('src/routes.ts#<module>.shareNote', {}, [hide]))).toEqual(kinds(await scanned('src/routes.ts#<module>.shareNote')));
  });

  it('FR-32.1 interface calls with more implementations than the I/O walk follows make it "at least", named once with their implementations; recursive calls are counted once; unresolved calls are counted', () => {
    const m = (id: string, parentId: string | null, extra: Partial<Message> = {}) => ({ id, parentId, to: 'p', isLibrary: false, expanded: false, expandable: false, recursive: false, methodKey: 'k', ...extra }) as Message;
    const ref = (key: string): MethodRef => ({ key, name: key, owner: { key: `${key}#C`, name: 'C', kind: 'class' }, isStatic: false, hasBody: true });
    const nodes = new Map<string, Partial<BuiltNode>>([
      ['root', { effective: ref('root'), implementations: [] }],
      ['root/0:x', { declared: { ...ref('send'), owner: { key: 'n#Notifier', name: 'Notifier', kind: 'interface' } }, implementations: [1, 2, 3, 4, 5].map((i) => ref(`impl${i}`)) }],
      ['root/3:x', { declared: { ...ref('send'), owner: { key: 'n#Notifier', name: 'Notifier', kind: 'interface' } }, implementations: [1, 2, 3, 4, 5].map((i) => ref(`impl${i}`)) }],
      ['root/1:root', { effective: ref('root') }],
      ['root/2:y', {}],
    ]);
    const participants = [{ id: 'p', classKey: 'root#C', className: 'C' }];
    const build = { participants, messages: [m('root', null, { expanded: true }), m('root/0:x', 'root'), m('root/1:root', 'root', { recursive: true, expandable: true }), m('root/2:y', 'root', { methodKey: undefined }), m('root/3:x', 'root')], nodes } as unknown as BuildResult;
    const asked: string[] = [];
    const peek = (x: MethodRef) => (asked.push(x.key), []);
    expect(outcomeOfFlow(build, () => [], peek, () => undefined)).toEqual({ io: [], atLeast: true, why: 'Notifier.send has 5 implementations', wide: [{ call: 'Notifier.send', implementations: 5 }], unresolved: 1 });
    // the recursive call's body is not read again
    expect(asked).toEqual(['root']);
  });

  it('FR-32.1 the I/O walk stopping before the end (its depth limit) makes it "at least", naming where', () => {
    const ref = (key: string): MethodRef => ({ key, name: key, owner: { key: 'c#C', name: 'C', kind: 'class' }, isStatic: false, hasBody: true });
    const chain = ['root', 'l1', 'l2', 'l3', 'l4', 'l5'].map(ref);
    const peek = (x: MethodRef) => {
      const i = chain.findIndex((c) => c.key === x.key);
      return i + 1 < chain.length ? [{ kind: 'call', expressionText: 'x()', receiver: { kind: 'self' }, isLibrary: false, methodName: chain[i + 1].name, target: chain[i + 1] } as CallSite] : [];
    };
    const build = {
      participants: [{ id: 'p', classKey: 'c#C', className: 'C' }],
      messages: [{ id: 'root', parentId: null, to: 'p', isLibrary: false, expanded: false, expandable: true, recursive: false, methodKey: 'root' }],
      nodes: new Map([['root', { effective: chain[0] }]]),
    } as unknown as BuildResult;
    expect(outcomeOfFlow(build, () => [], peek, () => undefined)).toEqual({ io: [], atLeast: true, why: '1 call left folded, the I/O walk stopped at C.l4', folded: 1, deep: ['C.l4'] });
  });

  it('FR-32.1 a body is charged to the object running it: a client running its base class\'s method (FR-5.11)', () => {
    const at = { file: '/p/base.ts', start: { line: 4, character: 0 }, end: { line: 4, character: 9 } };
    const read = { ordinal: 0, kind: 'call', range: at, methodName: 'readFile', expressionText: 'readFile(p)', args: [], receiver: { kind: 'module', name: 'fs' }, isAsync: true, isLibrary: true, target: { key: 'lib:node:fs/promises#<module>.readFile', name: 'readFile', owner: { key: 'lib:node:fs/promises#<module>', name: 'fs/promises', kind: 'external' }, isStatic: false, hasBody: false } };
    const base: MethodRef = { key: 'base.ts#BaseClient.load', name: 'load', owner: { key: 'base.ts#BaseClient', name: 'BaseClient', kind: 'class' }, isStatic: false, hasBody: true };
    const message = (id: string, parentId: string | null, to: string, expanded: boolean) => ({ id, parentId, to, isLibrary: false, expanded, expandable: false, recursive: false, methodKey: base.key }) as Message;
    const build = {
      participants: [{ id: 'a', classKey: 'shop.ts#ShopClient', className: 'ShopClient' }, { id: 'b', classKey: 'mail.ts#MailClient', className: 'MailClient' }],
      // expanded (its body read for the drawing) and folded (a leaf): both by the object
      messages: [message('root', null, 'a', true), message('root/0:load', 'root', 'b', false)],
      nodes: new Map([['root', { effective: base }], ['root/0:load', { effective: base }]]),
    } as unknown as BuildResult;
    expect(outcomeOfFlow(build, () => [], () => [read] as never, () => undefined)).toEqual({
      io: [{ kind: 'file', via: [{ className: 'ShopClient', classKey: 'shop.ts#ShopClient', calls: [{ call: '<module>.readFile', at }] }, { className: 'MailClient', classKey: 'mail.ts#MailClient', calls: [{ call: '<module>.readFile', at }] }] }],
    });
  });

  it('FR-32.1 below a folded call too: a base class\'s method called on `this` / `base` is charged to the object running it, a call on another object to that object\'s class', () => {
    const at = (line: number) => ({ file: '/p/base.ts', start: { line, character: 0 }, end: { line, character: 9 } });
    const read = (line: number) => ({ ordinal: 0, kind: 'call', range: at(line), methodName: 'readFile', expressionText: 'readFile(p)', args: [], receiver: { kind: 'module', name: 'fs' }, isAsync: true, isLibrary: true, target: { key: 'lib:node:fs/promises#<module>.readFile', name: 'readFile', owner: { key: 'lib:node:fs/promises#<module>', name: 'fs/promises', kind: 'external' }, isStatic: false, hasBody: false } }) as CallSite;
    const method = (cls: string, name: string): MethodRef => ({ key: `${cls}.ts#${cls}.${name}`, name, owner: { key: `${cls}.ts#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true });
    const [get, send, post] = [method('ShopClient', 'get'), method('BaseClient', 'send'), method('MailClient', 'post')];
    const call = (target: MethodRef, receiver: CallSite['receiver']) => ({ kind: 'call', expressionText: 'x()', receiver, isLibrary: false, methodName: target.name, target }) as CallSite;
    const bodies = new Map<string, CallSite[]>([
      [get.key, [call(send, { kind: 'self' }), call(post, { kind: 'field', name: 'mail' })]],
      [send.key, [read(4)]],
      [post.key, [call(send, { kind: 'super' }), read(9)]],
    ]);
    const build = {
      participants: [{ id: 'a', classKey: 'ShopClient.ts#ShopClient', className: 'ShopClient' }],
      messages: [{ id: 'root', parentId: null, to: 'a', isLibrary: false, expanded: false, expandable: true, recursive: false, methodKey: get.key }],
      nodes: new Map([['root', { effective: get }]]),
    } as unknown as BuildResult;
    expect(outcomeOfFlow(build, () => [], (m) => bodies.get(m.key), () => undefined)).toEqual({
      io: [
        {
          kind: 'file',
          via: [
            { className: 'ShopClient', classKey: 'ShopClient.ts#ShopClient', calls: [{ call: '<module>.readFile', at: at(4) }] },
            { className: 'MailClient', classKey: 'MailClient.ts#MailClient', calls: [{ call: '<module>.readFile', at: at(9) }, { call: '<module>.readFile', at: at(4) }] },
          ],
        },
      ],
      atLeast: true,
      why: '1 call left folded',
      folded: 1,
    });
  });

  it('FR-32.1 one class found by name (below a folded call) and by key is one; a call is listed once per place', () => {
    const at = (line: number) => ({ file: '/p/a.ts', start: { line, character: 0 }, end: { line, character: 9 } });
    expect(
      toOutcome(
        [
          { kind: 'db', call: 'Db.query', className: 'Repo' },
          { kind: 'db', call: 'Db.query', className: 'Repo' },
          { kind: 'db', call: 'Db.query', className: 'Repo', classKey: 'a.ts#Repo', at: at(3) },
          { kind: 'db', call: 'Db.query', className: 'Repo', classKey: 'a.ts#Repo', at: at(3) },
          { kind: 'db', call: 'Db.query', className: 'Repo', classKey: 'a.ts#Repo', at: at(7) },
          { kind: 'queue', call: 'Bus.send', className: 'Outbox' },
        ],
        { folded: 0, wide: [] },
        0,
      ),
    ).toEqual({
      io: [
        { kind: 'db', via: [{ className: 'Repo', classKey: 'a.ts#Repo', calls: [{ call: 'Db.query' }, { call: 'Db.query', at: at(3) }, { call: 'Db.query', at: at(7) }] }] },
        { kind: 'queue', via: [{ className: 'Outbox', calls: [{ call: 'Bus.send' }] }] },
      ],
    });
    // no diagram open: nothing to tell
    expect(session().flowOutcome()).toBeUndefined();
  });

  it('FR-32.2 an entry point\'s diagram carries the outcome after the background scan — the one the project scan gives', async () => {
    const e = await entry('POST /notes/:id/share');
    const s = session();
    const opened = await s.openMethodByKey(e.method.key, e);
    expect(opened!.outcome).toBeUndefined(); // not before the background scan: the diagram never waits
    const after = await s.scanSideEffects();
    expect(short(after!.outcome)).toEqual(SHARE);
    // one source: the gate and the project-wide scan (list badges, CLI) agree
    const all = await session().findOutcomes();
    expect(all!.find((x) => x.entry.label === e.label)!.outcome).toEqual(after!.outcome);
    // the same flow scanned again: nothing new, no re-render
    expect(await s.scanSideEffects()).toBeUndefined();
  });

  it('FR-32.3 expanding and collapsing do not change it; re-rooting on a method that is no entry point drops it, Back restores it', async () => {
    const e = await entry('POST /notes/:id/share');
    const s = session();
    await s.openMethodByKey(e.method.key, e);
    const first = (await s.scanSideEffects())!.outcome;
    expect((await s.expandEverything())!.outcome).toEqual(first);
    const share = s.current()!.messages.find((x) => x.methodName === 'share')!;
    expect((await s.focus(share.id))!.outcome).toBeUndefined();
    await s.scanSideEffects();
    expect(s.current()!.outcome).toBeUndefined();
    expect((await s.back())!.outcome).toEqual(first);
  });

  it('FR-32.2 none with I/O off, and none for a method that is no entry point', async () => {
    const e = await entry('POST /notes/:id/share');
    const off = session({ showSideEffects: false });
    await off.openMethodByKey(e.method.key, e);
    await off.scanSideEffects();
    expect(off.current()!.outcome).toBeUndefined();
    const plain = session();
    await plain.openMethodByKey('src/controllers/note-controller.ts#NoteController.share');
    await plain.scanSideEffects();
    expect(plain.current()!.outcome).toBeUndefined();
  });

  it('FR-32.3 a code change computes it again', async () => {
    const e = await entry('GET /notes/:id');
    const s = session();
    await s.openMethodByKey(e.method.key, e);
    const before = (await s.scanSideEffects())!.outcome;
    await s.refresh([`${ROOT}/src/adapters/file-notes.ts`]);
    expect(s.current()!.outcome).toBeUndefined();
    expect((await s.scanSideEffects())!.outcome).toEqual(before);
  });

  it('FR-32.4 the outcomes the lists show: the entry points opened (after the background scan), then the project scan; a code change forgets those that saw the old code', async () => {
    const [get, share] = await Promise.all([entry('GET /notes/:id'), entry('POST /notes/:id/share')]);
    const key = (e: EntryPoint) => `${e.kind}|${e.label}|${e.method.key}`;
    const s = session();
    expect(s.entryOutcomes()).toEqual({});
    await s.openMethodByKey(share.method.key, share);
    expect(s.entryOutcomes()).toEqual({}); // nothing scanned for it
    await s.scanSideEffects();
    expect(s.entryOutcomes()).toEqual({ [key(share)]: { kinds: ['http', 'file'] } });
    await s.findOutcomes();
    expect(s.entryOutcomes()).toEqual({ [key(get)]: { kinds: ['file'] }, [key(share)]: { kinds: ['http', 'file'] } });
    await s.refresh([`${ROOT}/src/adapters/file-notes.ts`]);
    expect(s.entryOutcomes()).toEqual({}); // both flows read the changed file: the scans that saw it are dropped too
    // "at least" carried; I/O off: none from the flows opened
    const t = session();
    (t as unknown as { openedOutcomes: Map<string, FlowOutcome> }).openedOutcomes.set('k', { io: [{ kind: 'db', via: [] }], atLeast: true });
    expect(t.entryOutcomes()).toEqual({ k: { kinds: ['db'], atLeast: true } });
    const off = session({ showSideEffects: false });
    await off.openMethodByKey(share.method.key, share);
    await off.scanSideEffects();
    expect(off.entryOutcomes()).toEqual({});
  });

  it('FR-32.5 the outcomes of the project\'s entry points (or a selection), a flow that cannot be opened marked failed', async () => {
    const s = session();
    const eps = await s.getEntryPoints();
    const all = (await s.findOutcomes())!;
    expect(all.map((x) => [x.entry.label, x.outcome!.io.map((k) => k.kind)])).toEqual([
      ['GET /notes/:id', ['file']],
      ['POST /notes/:id/share', ['http', 'file']],
    ]);
    const only = (await s.findOutcomes({ only: new Set([`${eps[0].kind}|${eps[0].label}|${eps[0].method.key}`]) }))!;
    expect(only.map((x) => x.entry.label)).toEqual(['GET /notes/:id']);
    // cancelled before a flow was scanned
    expect(await session().findOutcomes({ cancelled: () => true })).toBeUndefined();
    // an entry point whose method is gone: no outcome, failed
    const gone: EntryPoint = { ...eps[0], label: 'GET /gone', method: { ...eps[0].method, key: 'src/gone.ts#<module>.gone' } };
    const t = session();
    Object.assign(t, { getEntryPoints: async () => [gone] });
    expect(await t.findOutcomes()).toEqual([{ entry: gone, failed: true }]);
    expect(t.entryOutcomes()).toEqual({}); // FR-32.4 a failed flow: no pill
  });
});
