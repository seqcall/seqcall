import { describe, expect, it } from 'vitest';
import { askText, viewText } from '../src/flow-text';
import { FIXTURE_ROOT, K, newSession } from './helpers';

const SQL = 'src/adapters/sql-user-repository.ts#SqlUserRepository';
const LOGGER = 'src/util/logger.ts#Logger';

describe('FR-25.4 Share → Copy as text', () => {
  it('FR-25.4 lists the calls as shown: opened calls, the chosen implementation, without the hidden ones (named at the end)', async () => {
    const s = newSession();
    const plain = (await s.openMethodByKey(K.getUser))!;
    expect(viewText(FIXTURE_ROOT, plain)).not.toMatch(/\n(hidden|not expanded): /); // no rules: nothing named
    await s.expand(s.current()!.messages.find((m) => m.methodName === 'findUser')!.id);
    await s.selectImplementation(s.current()!.messages.find((m) => m.methodName === 'findById')!.id, SQL);
    const d = (await s.hide({ kind: 'class', classKey: LOGGER, className: 'Logger' }))!;
    const lines = viewText(FIXTURE_ROOT, d).split('\n');
    expect(lines[0]).toMatch(/^# Seqcall sequence diagram, as shown in the panel/);
    expect(lines[1]).toBe('UserController.getUser  [Presentation]  src/controllers/user-controller.ts:12');
    // the opened call's calls, indented below it, with the implementation chosen and file:line
    expect(lines).toContain('  UserService.findUser(id)  [Application]  async  src/controllers/user-controller.ts:15');
    expect(lines).toContain('    UserRepository.findById(id)  [Infrastructure]  async  impl: InMemoryUserRepository | SqlUserRepository → SqlUserRepository  (folded)  src/services/user-service.ts:15');
    expect(lines).toContain('  loop [each t of [\'a\', \'b\']] @ src/controllers/user-controller.ts:17');
    // hidden: not listed, but named
    expect(lines.some((l) => l.includes('Logger.'))).toBe(false);
    expect(lines.at(-1)).toBe('hidden: calls to Logger (1)');
  });

  it('FR-25.4 names each kind of hide rule and the Don\'t expand rules apart; with the I/O badges off no "none found"', async () => {
    const s = newSession();
    await s.openMethodByKey(K.getUser);
    await s.hide({ kind: 'methodName', methodName: 'validate' });
    await s.hide({ kind: 'classMethod', classKey: LOGGER, className: 'Logger', methodName: 'info' });
    await s.hide({ kind: 'classPattern', pattern: '*Dto' });
    await s.hide({ kind: 'stereotype', stereotype: 'logger' });
    await s.hide({ kind: 'class', classKey: 'src/services/user-service.ts#UserService', className: 'UserService', noExpand: true });
    const d = (await s.setOption('showSideEffects', false))!;
    const text = viewText(FIXTURE_ROOT, d);
    expect(text).toContain('I/O: not looked for (View ▾ I/O badges are off)');
    expect(text).not.toContain('I/O: none found');
    expect(text).toMatch(/\nhidden: calls named validate \(1\), Logger\.info \(1\), classes named \*Dto \(1\), «logger» classes(\n|$)/);
    expect(text).toMatch(/\nnot expanded: calls to UserService \(1\)$/);
  });

  it('FR-25.5 Ask AI about this call: a question about that call (a review question when the branch changed it), then the flow as copied', async () => {
    const s = newSession();
    const d = (await s.openMethodByKey(K.getUser))!;
    const findUser = d.messages.find((m) => m.methodName === 'findUser')!;
    const lines = askText(FIXTURE_ROOT, d, findUser.id)!.split('\n');
    expect(lines[0]).toBe('Explain the call `UserService.findUser(id)` at src/controllers/user-controller.ts:15 in the flow below. What does it do, what can go wrong there, and what in the rest of the flow depends on it?');
    expect(lines[1]).toMatch(/^Read the code at the file:line places/);
    expect(lines.slice(3).join('\n')).toBe(viewText(FIXTURE_ROOT, d));
    // the root: the method the flow starts at
    expect(askText(FIXTURE_ROOT, d, 'root')!.split('\n')[0]).toMatch(/^Explain the method `UserController\.getUser` at src\/controllers\/user-controller\.ts:12 \(the start of the flow\) in the flow below\./);
    // a call the branch changed (FR-24): review it
    const changed = { ...d, messages: d.messages.map((m) => (m.id === findUser.id ? { ...m, diff: { call: true } } : m)) };
    expect(askText(FIXTURE_ROOT, changed, findUser.id)!.split('\n')[0]).toBe(
      'Review the call `UserService.findUser(id)` at src/controllers/user-controller.ts:15: the branch changed it. Is the change correct, what in the rest of the flow can break because of it, and which tests would you add?',
    );
    // a changed method or a status counts as changed too; no file:line known: none named
    const bare = { ...d, root: { ...d.root, declaration: undefined }, messages: d.messages.map((m) => (m.id === findUser.id ? { ...m, callSite: undefined, diff: { method: 'changed' as const } } : m.id === 'root' ? { ...m, diff: { status: 'changed' as const } } : m)) };
    expect(askText(FIXTURE_ROOT, bare, findUser.id)!.split('\n')[0]).toMatch(/^Review the call `UserService\.findUser\(id\)`: the branch changed it\./);
    expect(askText(FIXTURE_ROOT, bare, 'root')!.split('\n')[0]).toMatch(/^Review the method `UserController\.getUser` \(the start of the flow\): the branch changed it\./);
    // a call no longer in the diagram (a refresh meanwhile)
    expect(askText(FIXTURE_ROOT, d, 'root/9:gone')).toBeUndefined();
  });
});
