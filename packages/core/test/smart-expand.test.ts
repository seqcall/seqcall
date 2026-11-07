import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DefaultClassifier } from '../src/classifier-impl';
import { FIXTURE_ROOT, file, newSession, positionOf } from './helpers';
import type { Message, Participant } from '@seqcall/protocol';
import { compileSmartConfig, expansionPriority, messageFacts, revealValue, scoreCall, type CallFacts } from '../src/smart-expand';

const service = { id: 'svc', className: 'UserService', layer: 'Application', stereotypes: ['service'], kind: 'class' as const };
const ctrl = { id: 'ctrl', className: 'UserController', layer: 'Presentation', stereotypes: ['controller'], kind: 'class' as const };
const repo = { id: 'repo', className: 'UserRepository', layer: 'Ports', stereotypes: ['interface', 'port'], kind: 'interface' as const };
const util = { id: 'fmt', className: 'format', stereotypes: ['module'], kind: 'module' as const };
const facts = (f: Partial<CallFacts>): CallFacts => ({ methodName: 'run', kind: 'call', argCount: 1, isLibrary: false, childCount: 0, expandable: false, ...f });

const CONTROLLER = 'src/controllers/user-controller.ts';

describe('FR-3.6 smart expand: scoring', () => {
  it('FR-3.6 layer crossings, roles, implementation choices and fan-out score up, with reasons', () => {
    const imp = scoreCall(facts({ methodName: 'findUser', from: ctrl, to: service, childCount: 3 }));
    expect(imp.reasons).toEqual(['↑ crosses Presentation → Application', '↑ «service»', '↑ 3 calls below']);
    expect(imp.score).toBe(6);
    expect(imp.low).toBe(false);
    expect(scoreCall(facts({ methodName: 'findById', from: service, to: repo, implementations: 2 })).reasons).toEqual([
      '↑ crosses Application → Ports',
      '↑ «port»',
      '↑ implementation choice (2)',
    ]);
  });

  it('FR-3.6 logging, mapping, getters, constructors and library calls score down (low = dimmed)', () => {
    expect(scoreCall(facts({ methodName: 'info', to: { ...util, className: 'Logger' } })).reasons).toEqual(['↓ logging']);
    expect(scoreCall(facts({ methodName: 'formatName', to: util })).reasons).toEqual(['↓ mapping / formatting']);
    expect(scoreCall(facts({ methodName: 'getName', argCount: 0, from: service, to: service, kind: 'self' })).reasons).toEqual(['↓ getter']);
    expect(scoreCall(facts({ methodName: 'stringify', isLibrary: true })).low).toBe(true);
    // a constructor is a step of the flow: no crossing bonus, no name rules ("Error" is not logging)
    expect(scoreCall(facts({ methodName: 'Error', kind: 'create', from: service, to: { ...util, id: 'err', className: 'Error', layer: 'Domain' } })).reasons).toEqual(['↓ constructor']);
    // unresolved calls carry the expression: the member name decides
    expect(scoreCall(facts({ methodName: '_logger.LogError' })).reasons).toEqual(['↓ logging']);
  });

  it('FR-3.6 upper-case C# names follow the same getter / mapping rules (GetName, MapToResponse, *MappingUtil)', () => {
    expect(scoreCall(facts({ methodName: 'GetName', argCount: 0, from: service, to: service, kind: 'self' })).reasons).toEqual(['↓ getter']);
    expect(scoreCall(facts({ methodName: 'MapToResponse', from: service, to: service, kind: 'self' })).reasons).toEqual(['↓ mapping / formatting']);
    expect(scoreCall(facts({ methodName: 'ToString', argCount: 0, to: util })).reasons).toEqual(['↓ mapping / formatting']);
    expect(scoreCall(facts({ methodName: 'Build', to: { ...util, className: 'ResponseMappingUtil' } })).reasons).toEqual(['↓ mapping / formatting']);
    // only the first letter: `Issue` / `Hash` / `Total` are not getters or mappers
    expect(scoreCall(facts({ methodName: 'Issue', argCount: 0, to: util })).reasons).toEqual([]);
    expect(scoreCall(facts({ methodName: 'Total', to: util })).reasons).toEqual([]);
  });

  it('FR-3.6 self calls do not cross layers; configured globs on Class.method override', () => {
    expect(scoreCall(facts({ methodName: 'validate', kind: 'self', from: ctrl, to: ctrl })).score).toBe(0);
    const config = compileSmartConfig({ important: ['UserController.validate'], unimportant: ['*Service.*'], budget: 40 });
    expect(config.budget).toBe(40);
    expect(scoreCall(facts({ methodName: 'validate', kind: 'self', from: ctrl, to: ctrl }), config).reasons).toEqual(['↑ configured as important']);
    expect(scoreCall(facts({ methodName: 'findUser', from: ctrl, to: service }), config).score).toBe(2); // 3 + 2 − 3
    expect(compileSmartConfig({ budget: 'x' as never }).budget).toBe(100); // FR-3.10 the default is a cap, not a target
  });

  it('FR-3.6 a call is worth expanding by what it reveals, not by itself', () => {
    const plumbing = scoreCall(facts({ methodName: 'readConfig', from: ctrl, to: { ...util, layer: 'Infrastructure' } })); // crosses: 3
    expect(expansionPriority(plumbing, revealValue([{ name: 'read', importance: { score: 0, reasons: [], low: false } }]))).toBeUndefined();
    const useCase = scoreCall(facts({ methodName: 'scanning', kind: 'self', from: ctrl, to: ctrl, childCount: 10 })); // fan-out: 2
    const reveal = revealValue([
      { name: 'scan', importance: { score: 5, reasons: [], low: false } },
      { name: 'render', importance: { score: 5, reasons: [], low: false } },
      { name: 'slice', importance: { score: 1, reasons: [], low: false } }, // weak signals do not count
    ]);
    expect(reveal).toEqual({ value: 8, top: ['scan', 'render'] }); // capped
    expect(expansionPriority(useCase, reveal)).toEqual({ score: 10, reasons: ['↑ 10 calls below', '↑ reveals scan, render'], low: false });
    // a logging call that reveals one notable call: −3 + 2 stays below the threshold
    const logging = scoreCall(facts({ methodName: 'logAudit' }));
    expect(expansionPriority(logging, revealValue([{ name: 'save', importance: { score: 2, reasons: [], low: false } }]))).toBeUndefined();
  });

  it('FR-3.6 the facts of a built message: the found message counts as a call; an unknown target is no end', () => {
    const msg = (m: Partial<Message>): Message => ({ id: 'root', parentId: null, depth: 0, kind: 'found', from: null, to: 'p1', methodName: 'run', args: ['a'], isLibrary: false, expandable: true, ...m }) as Message;
    const p = { id: 'p1', className: 'Shop', layer: 'Application', stereotypes: ['service'], kind: 'class' } as Participant;
    expect(messageFacts(msg({}), undefined, undefined, 2)).toEqual({ methodName: 'run', kind: 'call', argCount: 1, isLibrary: false, from: undefined, to: undefined, implementations: undefined, childCount: 2, expandable: true });
    // a call names the class it was made on (an inherited method): that name, not the participant's
    expect(messageFacts(msg({ kind: 'call', className: 'BaseShop' }), p, p, 0)).toMatchObject({ kind: 'call', to: { id: 'p1', className: 'BaseShop', stereotypes: ['service'] } });
    expect(messageFacts(msg({ kind: 'self' }), p, p, 0)).toMatchObject({ kind: 'self', to: { className: 'Shop' } });
  });
});

describe('FR-3.6 smart expand: session', () => {
  it('FR-3.6 expands the important path, leaves the noise collapsed and dimmed, and explains why', async () => {
    const s = newSession();
    await s.openAt(file(CONTROLLER), positionOf(CONTROLLER, 'this.validate(id);'));
    const d = (await s.smartExpand())!;
    const byName = (n: string) => d.messages.find((m) => m.methodName === n && m.depth === 1)!;
    expect(byName('findUser').expanded).toBe(true);
    expect(byName('findUser').importance?.reasons).toContain('↑ crosses Presentation → Application');
    expect(byName('findUser').importance?.reasons.at(-1)).toBe('↑ reveals findById');
    expect(byName('validate').expanded).toBe(false);
    expect(byName('formatName').expanded).toBe(false);
    expect(byName('formatName').importance?.low).toBe(true);
    expect(byName('info').importance?.low).toBe(true);
    expect(d.messages.find((m) => m.methodName === 'findById')!.importance?.score).toBeGreaterThanOrEqual(5);
    expect(d.messages.length).toBeLessThanOrEqual(25);

    // Collapse all ends the smart view
    const c = (await s.collapseAll())!;
    expect(c.messages.some((m) => m.importance)).toBe(false);
  });

  it('FR-3.6 respects the budget and expands "from here" only below that message', async () => {
    const config = JSON.parse(fs.readFileSync(`${FIXTURE_ROOT}/.seqcall.json`, 'utf8'));
    const tight = newSession({ classifier: new DefaultClassifier(FIXTURE_ROOT, { ...config, smartExpand: { budget: 8 } }) });
    const before = (await tight.openAt(file(CONTROLLER), positionOf(CONTROLLER, 'this.validate(id);')))!;
    const d = (await tight.smartExpand())!;
    expect(d.messages.length).toBe(before.messages.length); // findUser adds 2 visible calls: 7 + 2 does not fit into 8
    expect(d.messages.some((m) => m.importance)).toBe(true);

    const s = newSession();
    const opened = (await s.openAt(file(CONTROLLER), positionOf(CONTROLLER, 'this.userService.rename')))!;
    const rename = opened.messages.find((m) => m.methodName === 'rename')!;
    const sub = (await s.smartExpand(rename.id))!;
    expect(sub.messages.find((m) => m.id === rename.id)!.expanded).toBe(true);
    const bill = sub.messages.find((m) => m.methodName === 'bill' && m.depth === 1)!;
    expect(bill.expanded).toBe(false); // outside the subtree
    expect(sub.messages.filter((m) => m.expanded && m.id !== 'root').every((m) => m.id === rename.id || m.id.startsWith(`${rename.id}/`))).toBe(true);
  });
});
