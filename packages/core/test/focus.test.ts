import { describe, expect, it } from 'vitest';
import { C, K, file, newSession, positionOf } from './helpers';

const CONTROLLER = 'src/controllers/user-controller.ts';

describe('FR-4.6 focus on a call', () => {
  it('FR-4.6 the call\'s method becomes the root; exploration below it is kept; Back returns', async () => {
    const s = newSession();
    await s.openAt(file(CONTROLLER), positionOf(CONTROLLER, 'this.validate(id);'));
    const P = 'root/2:findUser';
    await s.expand(P);
    await s.selectImplementation(`${P}/1:findById`, C.SqlUserRepository);
    const before = (await s.expand(`${P}/1:findById`))!;
    expect(before.messages.some((m) => m.id.startsWith(`${P}/1:findById/`))).toBe(true);

    const d = (await s.focus(P))!;
    expect(d.root.key).toBe(K.findUser);
    expect(d.messages[0]).toMatchObject({ id: 'root', kind: 'found', methodName: 'findUser' });
    const find = d.messages.find((m) => m.id === 'root/1:findById')!;
    expect(find.polymorphic?.selectedKey).toBe(C.SqlUserRepository); // choice kept
    expect(find.expanded).toBe(true); // expansion kept
    expect(d.participants.some((p) => p.classKey === C.UserController)).toBe(false); // the left side is gone
    expect(d.canGoBack).toBe(true);

    const back = (await s.back())!;
    expect(back.root.name).toBe('getUser');
    expect(back.messages.find((m) => m.id === `${P}/1:findById`)!.expanded).toBe(true);
  });

  it('FR-4.6 the found message, calls without a body and unknown ids change nothing', async () => {
    const s = newSession();
    const d = (await s.openAt(file(CONTROLLER), positionOf(CONTROLLER, 'this.validate(id);')))!;
    expect((await s.focus('root'))!.root.key).toBe(d.root.key);
    await s.expand('root/2:findUser');
    const iface = (await s.focus('root/2:findUser/0:findById'))!; // interface call, no implementation chosen
    expect(iface.root.key).toBe(d.root.key);
    expect(iface.canGoBack).toBe(false);
    expect((await s.focus('root/99:nope'))!.root.key).toBe(d.root.key);
  });
});
