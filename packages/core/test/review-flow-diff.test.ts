import { describe, expect, it } from 'vitest';
import type { Message, Participant, ParticipantGroup } from '@seqcall/protocol';
import type { BuildResult } from '../src/session/build';
import { diffFlow, mergeRemoved } from '../src/review/flow-diff';

// FR-24.6 the flow compared with its base version, on hand-built flows (the builds the session makes).
const msg = (id: string, over: Partial<Message> = {}): Message =>
  ({
    id,
    parentId: id === 'root' ? null : id.slice(0, id.lastIndexOf('/')),
    depth: id.split('/').length - 1,
    kind: id === 'root' ? 'found' : 'call',
    from: id === 'root' ? null : 'p:a',
    to: 'p:b',
    methodName: id.slice(id.lastIndexOf(':') + 1),
    args: [],
    expandable: true,
    expanded: false,
    ...over,
  }) as Message;
const part = (id: string, classKey: string, groupId = 'g:app'): Participant => ({ id, classKey, groupId, label: id }) as Participant;
const build = (messages: Message[], participants: Participant[] = [], groups: ParticipantGroup[] = []): BuildResult =>
  ({ messages, participants, groups, nodes: new Map(), participantMeta: new Map(), hiddenFilters: [], fragments: [], exits: [] }) as unknown as BuildResult;
const group = (id: string) => ({ id, label: id }) as ParticipantGroup;

describe('FR-24.6 the flow against its base version', () => {
  it('FR-24.6 a root that does not exist at the base: nothing to compare; no rounds allowed: nothing either', async () => {
    const current = build([msg('root', { expanded: true })]);
    expect(await diffFlow({ current, choices: new Map(), buildBase: async () => undefined })).toBeUndefined();
    expect(await diffFlow({ current, choices: new Map(), buildBase: async () => current, maxRounds: 0 })).toBeUndefined();
  });

  it('FR-24.6 calls without a target are matched by class and name; an expanded call without calls in either version adds and removes nothing', async () => {
    const current = build([
      msg('root', { expanded: true }),
      msg('root/0:log'),
      msg('root/1:send', { classKey: 'a.ts#Mailer' }),
      msg('root/2:empty', { expanded: true }),
    ]);
    const base = build([msg('root', { expanded: true }), msg('root/0:log'), msg('root/1:send', { classKey: 'a.ts#Sms' }), msg('root/2:empty', { expanded: true })]);
    const d = (await diffFlow({ current, choices: new Map(), buildBase: async () => base }))!;
    // send() on another class: the same call retargeted (named by its class); log is matched by its name
    expect([...d.added]).toEqual([]);
    expect([...d.retargeted]).toEqual([['root/1:send', 'send']]);
    expect(d.removed).toEqual([]);
  });

  it('FR-24.6 what a retargeted call reached: the implementation method of its key, else Class.method', async () => {
    const current = build([msg('root', { expanded: true }), msg('root/0:pay', { methodKey: 'a.ts#Card.pay(int)' }), msg('root/1:ship', { methodKey: 'unknown' })]);
    const base = build([
      msg('root', { expanded: true }),
      msg('root/0:pay', { methodKey: 'a.ts#Wallet.pay(int)' }),
      msg('root/1:ship', { methodKey: 'lib-ship', className: 'Courier' }),
    ]);
    const d = (await diffFlow({ current, choices: new Map(), buildBase: async () => base }))!;
    expect([...d.retargeted]).toEqual([
      ['root/0:pay', 'Wallet.pay'],
      ['root/1:ship', 'Courier.ship'],
    ]);
  });

  it('FR-24.6 removed calls: a participant of a class still drawn is that one; others are ghosts with their groups once', async () => {
    const current = build(
      [msg('root', { expanded: true, to: 'p:root' }), msg('root/0:a', { from: 'p:root', to: 'p:svc' })],
      [part('p:root', 'a.ts#Root'), part('p:svc', 'a.ts#Svc'), part('p:svc2', 'a.ts#Svc')],
      [group('g:app')],
    );
    const base = build(
      [
        msg('root', { expanded: true, to: 'p:root' }),
        msg('root/0:a', { from: 'p:root', to: 'p:svc' }),
        msg('root/1:old', { from: 'p:root', to: 'p:svc-old' }),
        msg('root/2:gone', { from: 'p:root', to: 'p:db' }),
        msg('root/3:cache', { from: 'p:root', to: 'p:cache' }),
        msg('root/4:mail', { from: 'p:root', to: 'p:mail' }),
      ],
      [part('p:root', 'a.ts#Root'), part('p:svc', 'a.ts#Svc'), part('p:svc-old', 'a.ts#Svc'), part('p:db', 'a.ts#Db', 'g:infra'), part('p:cache', 'a.ts#Cache', 'g:infra'), part('p:mail', 'a.ts#Mail')],
      [group('g:app'), group('g:infra')],
    );
    const d = (await diffFlow({ current, choices: new Map(), buildBase: async () => base }))!;
    expect(d.removed.map((r) => `${r.message.id} → ${r.message.to} after ${r.anchor}`)).toEqual([
      // another object of a class drawn today: the first participant of that class
      'root/~1:old → p:svc after root/0:a',
      'root/~2:gone → p:db after root/0:a',
      'root/~3:cache → p:cache after root/0:a',
      'root/~4:mail → p:mail after root/0:a',
    ]);
    expect(d.removed[0].message.depth).toBe(1);
    expect(d.removedParticipants.map((p) => `${p.id} ${p.diff}`)).toEqual(['p:db removed', 'p:cache removed', 'p:mail removed']);
    // g:app is drawn today: no ghost of it
    expect(d.removedGroups).toEqual([group('g:infra')]);
  });

  it('FR-24.6 a ghost whose anchor is not among the messages (filtered out since) is left out', () => {
    const messages = [msg('root', { expanded: true }), msg('root/1:b')];
    const ghost = msg('root/~0:a', { diff: { status: 'removed' } });
    expect(mergeRemoved(messages, [{ message: ghost, parentId: 'root', anchor: 'root/0:hidden' }]).map((m) => m.id)).toEqual(['root', 'root/1:b']);
  });
});
