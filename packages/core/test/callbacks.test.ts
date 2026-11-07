import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { method, newSession, sharedAdapter } from './helpers';

const REL = 'src/services/sync-service.ts';
const SYNC_ALL = `${REL}#SyncService.syncAll`;

/** "name [frame guards]" per message below `parent`, frames from the diagram's fragments. */
function outline(d: SequenceDiagram, parent: string): string[] {
  return d.messages
    .filter((m) => m.parentId === parent)
    .map((m) => {
      const frames = (d.fragments ?? [])
        .filter((f) => f.ownerMessageId === parent && !f.collapsed)
        .filter((f) => {
          const ids = d.messages.filter((x) => x.parentId === parent).map((x) => x.id);
          const at = ids.indexOf(m.id);
          return at >= ids.indexOf(f.operands[0].firstMessageId) && at <= ids.indexOf(f.operands[f.operands.length - 1].lastMessageId);
        })
        .map((f) => `${f.kind}[${f.operands[0].guard ?? ''}]`);
      const to = d.participants.find((p) => p.id === m.to)!.className;
      return `${m.viaParameter ? 'ƒ ' : ''}${m.methodName}→${to}${frames.length ? ` ${frames.join(' ')}` : ''}${m.expandable ? ' [+]' : ''}`;
    });
}

describe('TsAdapter: calls inside lambdas (FR-1.11)', () => {
  it('FR-1.11 a lambda passed to a library function: its calls follow the receiving call in a loop / callback scope', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method(SYNC_ALL));
    const order = calls.map((c) => c.methodName);
    // filter → map → (label in the map callback) → map → (save in its callback) → all → …
    expect(order.slice(0, 6)).toEqual(['filter', 'map', 'label', 'map', 'save', 'all']);
    const label = calls[2];
    expect(label.fragments?.map((f) => [f.kind, f.guard])).toEqual([['loop', 'each u of users.filter(…)']]);
    expect(calls[4].fragments?.map((f) => [f.kind, f.guard])).toEqual([['loop', 'each u of users']]);
    const info = calls.filter((c) => c.methodName === 'info').pop()!;
    expect(info.fragments?.map((f) => [f.kind, f.guard])).toEqual([['callback', 'this.repo.findById(…).then']]);
    expect(info.fragments?.[0].range?.start.line).toBe(info.range.start.line);
  });

  it('FR-1.11 a lambda passed to a project function is not inlined: it carries its body for the invocation', async () => {
    const calls = await sharedAdapter().getOutgoingCalls(await method(SYNC_ALL));
    const run = calls.find((c) => c.methodName === 'run')!;
    const fn = run.argFunctions?.[0];
    expect(fn).toMatchObject({ kind: 'lambda', params: [] });
    expect(fn?.kind === 'lambda' && fn.calls?.map((c) => [c.ordinal, c.methodName])).toEqual([[0, 'findById']]);
    // its body is not part of syncAll's own calls
    expect(calls.filter((c) => c.methodName === 'findById')).toHaveLength(1); // only the .then receiver
    // nested: the withLog lambda contains an inline forEach loop
    const withLog = calls.find((c) => c.methodName === 'withLog')!.argFunctions?.[0];
    expect(withLog?.kind === 'lambda' && withLog.calls?.map((c) => `${c.methodName}${c.fragments ? `@${c.fragments[0].guard}` : ''}`)).toEqual([
      'forEach',
      'label@each u of users',
    ]);
  });
});

describe('DiagramSession: lambdas and callbacks (FR-1.11)', () => {
  it('FR-1.11 library callbacks are drawn inline, framed; calls inside are normal, expandable messages', async () => {
    const d = await newSession().openMethod(await method(SYNC_ALL));
    expect(outline(d, 'root')).toEqual([
      'label→SyncService loop[each u of users.filter(…)]',
      'save→UserRepository loop[each u of users]',
      'run→Retrier [+]',
      'withLog→SyncService [+]',
      'findById→UserRepository',
      'info→Logger callback[this.repo.findById(…).then] [+]',
    ]);
  });

  it('FR-1.11 a lambda invoked by a project function is drawn back to the object that wrote it, its body below', async () => {
    const s = newSession();
    const d0 = await s.openMethod(await method(SYNC_ALL));
    const run = d0.messages.find((m) => m.methodName === 'run')!;
    const d1 = (await s.expand(run.id))!;
    expect(outline(d1, run.id)).toEqual(['info→Logger [+]', 'ƒ action→SyncService [+]']);
    const action = d1.messages.find((m) => m.parentId === run.id && m.viaParameter === 'action')!;
    expect(action).toMatchObject({ kind: 'call', viaLambda: true, from: run.to, to: d0.messages[0].to });
    expect(action.targetDeclaration?.start.line).toBe(run.callSite!.start.line); // the lambda
    const d2 = (await s.expand(action.id))!;
    // the body runs in SyncService: this.repo is the root object's repo (same lifeline as elsewhere)
    expect(outline(d2, action.id)).toEqual(['findById→UserRepository']);
    const inner = d2.messages.find((m) => m.parentId === action.id)!;
    const outerFind = d2.messages.find((m) => m.parentId === 'root' && m.methodName === 'findById')!;
    expect(inner.from).toBe(d0.messages[0].to);
    expect(inner.to).toBe(outerFind.to);
  });

  it('FR-3.3 Expand all also opens an invoked lambda (it has no target method, its body is drawn below it)', async () => {
    const s = newSession();
    await s.openMethod(await method(SYNC_ALL));
    let d = (await s.expandAll())!; // run, withLog, … open
    d = (await s.expandAll())!; // the lambdas they invoke open too
    const action = d.messages.find((m) => m.viaParameter === 'action')!;
    expect(action.expanded).toBe(true);
    expect(outline(d, action.id)).toEqual(['findById→UserRepository']);
  });

  it('FR-3.6 Smart expand opens a lambda invoked by an open method (that method\'s own logic)', async () => {
    const s = newSession();
    const d0 = await s.openMethod(await method(SYNC_ALL));
    const run = d0.messages.find((m) => m.methodName === 'run')!.id;
    await s.expand(run);
    // FR-3.12 a whole-diagram Smart starts from closed: from the open method, it keeps that method open
    const d = (await s.smartExpand(run))!;
    expect(d.messages.find((m) => m.viaParameter === 'action')?.expanded).toBe(true);
  });

  it('FR-1.11 lambdas nest: a forEach callback inside a lambda invoked by a self-call', async () => {
    const s = newSession();
    const d0 = await s.openMethod(await method(SYNC_ALL));
    const withLog = d0.messages.find((m) => m.methodName === 'withLog')!;
    await s.expand(withLog.id);
    const work = s.current()!.messages.find((m) => m.viaParameter === 'work')!;
    expect(work).toMatchObject({ kind: 'self', expandable: true });
    const d = (await s.expand(work.id))!;
    expect(outline(d, work.id)).toEqual(['label→SyncService loop[each u of users]']);
  });
});
