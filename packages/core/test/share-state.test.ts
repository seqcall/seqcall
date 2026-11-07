import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { formatState, gitState, parseState, stateFileName } from '../src/session/share';
import { riskyPattern } from '../src/classifier-impl';
import { CONFIG_FILE_NAME } from '../src/index';
import { C, FIXTURE_ROOT, K, method, newSession } from './helpers';

/** What a diagram shows, compactly: message ids with their chosen implementation, participant labels. */
const shape = (d: SequenceDiagram | undefined) => ({
  messages: d?.messages.map((m) => `${m.id}${m.polymorphic?.selectedKey ? `=${m.polymorphic.selectedKey}` : ''}${m.expanded ? '+' : ''}`),
  participants: d?.participants.map((p) => p.label),
});

const HOST = { language: 'typescript', tool: { version: '0.1.0', host: 'test' } };

describe('FR-25.2 diagram state to share', () => {
  it('FR-25.2 a state round-trips: a fresh session opens the same diagram (expanded calls, chosen implementations, filters, options)', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.expand('root/2:findUser');
    await s.selectImplementation('root/2:findUser/1:findById', C.SqlUserRepository);
    await s.expand('root/2:findUser/1:findById');
    await s.hide({ kind: 'class', classKey: C.Logger, className: 'Logger' });
    const sent = (await s.setOption('showArguments', false))!;
    expect(shape(sent).messages).toContain(`root/2:findUser/1:findById=${C.SqlUserRepository}+`);
    const snap = (await s.exportState({ ...HOST, positions: { p1: 120 } }))!;

    expect(snap).toMatchObject({ format: 'seqcall-state', schemaVersion: 1, root: { key: K.getUser, label: 'UserController.getUser' }, project: { name: 'sample-app', language: 'typescript' }, positions: { p1: 120 } });
    expect(snap.options).not.toHaveProperty('followCursor');
    expect(snap.interfaceChoices).toEqual({ [C.UserRepository]: C.SqlUserRepository });
    // nothing absolute travels
    expect(JSON.stringify(snap)).not.toContain(FIXTURE_ROOT);

    const r = newSession();
    const { diagram, report } = await r.restoreState(parseState(formatState(snap)), { language: 'typescript', toolVersion: '0.1.0' });
    expect(shape(diagram)).toEqual(shape(sent));
    expect(diagram!.options.showArguments).toBe(false);
    expect(diagram!.hiddenFilters.map((f) => f.filter.kind)).toEqual(['class']);
    expect(report.missing).toEqual([]);
    // same commit, config, version, counts (uncommitted edits of the fixture would be listed: not part of this check)
    expect(report.differences.filter((t) => !/uncommitted/.test(t))).toEqual([]);
    expect(report.now).toEqual(report.seen);
    expect(report.source).toMatch(/^UserController\.getUser · sample-app · [0-9a-f]{7} · \d{4}-\d\d-\d\d$/);
  });

  it('FR-25.2 the receiver\'s own remembered implementation does not change the opened diagram', async () => {
    const s = newSession();
    await s.openMethod(await method(K.findUser));
    const sent = (await s.selectImplementation('root/1:findById', C.SqlUserRepository))!;
    const snap = (await s.exportState(HOST))!;

    const r = newSession();
    await r.openMethod(await method(K.findUser));
    await r.selectImplementation('root/1:findById', C.InMemoryUserRepository); // FR-8.4 remembered for the interface
    const { diagram } = await r.restoreState(snap, { language: 'typescript' });
    expect(shape(diagram)).toEqual(shape(sent));
    expect(diagram!.messages.find((m) => m.id === 'root/0:findById')?.polymorphic?.selectedKey).toBe(C.SqlUserRepository);
  });

  it('FR-25.2 what is not found and what differs is reported (other code, other commit, other config)', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const snap = (await s.exportState(HOST))!;
    snap.expanded.push('root/9:gone');
    snap.choices['root/8:alsoGone'] = C.SqlUserRepository;
    snap.git = { commit: '0123456789abcdef', branch: 'feature/x', changed: ['src/services/user-service.ts'] };
    snap.config = '{}';
    snap.tool = { version: '9.9.9' };
    snap.seen = { messages: 99, participants: 1 };
    snap.review = { base: 'develop', mode: 'split' };

    const { diagram, report } = await newSession().restoreState(snap, { language: 'typescript', toolVersion: '0.1.0' });
    expect(diagram!.root.key).toBe(K.getUser);
    expect(report.missing).toEqual(['expanded call root/9:gone', 'implementation chosen at root/8:alsoGone']);
    const text = report.differences.join('\n');
    expect(text).toContain('Other commit: the sender was on 0123456 (feature/x)');
    expect(text).toContain('uncommitted changes in 1 file: src/services/user-service.ts');
    expect(text).toContain('The layer configuration (.seqcall.json) differs');
    expect(text).toContain('the sender had 9.9.9, you have 0.1.0');
    expect(text).toContain('review against develop');
    expect(text).toMatch(/The sender saw 99 messages and 1 objects, you see \d+ and \d+\./);
  });

  it('FR-25.2 replaced filters / options come back with restoreSettings; Back returns to the diagram before', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    await s.hide({ kind: 'methodName', methodName: 'log' });
    const snap = (await s.exportState(HOST))!;

    const r = newSession();
    await r.openMethod(await method(K.audit));
    await r.setOption('showArguments', false);
    const { report } = await r.restoreState(snap, { language: 'typescript' });
    expect(report.settingsReplaced).toBe(true);
    expect(r.getPersistentState().filters.map((f) => f.kind)).toEqual(['methodName']);
    const d = (await r.restoreSettings())!;
    expect(d.root.key).toBe(K.getUser);
    expect(r.getPersistentState()).toMatchObject({ filters: [], options: { showArguments: false } });
    expect((await r.back())!.root.key).toBe(K.audit);
  });

  it('FR-25.2 a root method that is not in the project says so', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const snap = (await s.exportState(HOST))!;
    snap.root = { key: 'src/nowhere.ts#Nobody.nothing', label: 'Nobody.nothing' };
    await expect(newSession().restoreState(snap, { language: 'typescript' })).rejects.toThrow(/Nobody\.nothing is not in this project/);
  });

  it('FR-25.2 the text is pure JSON (a hint for people reading it second); the file name follows the root', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const snap = (await s.exportState(HOST))!;
    const text = formatState(snap);
    const json = JSON.parse(text);
    expect(Object.keys(json).slice(0, 3)).toEqual(['format', 'open', 'schemaVersion']);
    expect(json.open).toMatch(/Share → Open a shared diagram/);
    expect(parseState(text).root.key).toBe(K.getUser);
    expect(stateFileName(snap)).toBe('UserController.getUser.seqcall.json');
    expect(stateFileName({ ...snap, root: { key: 'x', label: '<module>.main' } })).toBe('module-.main.seqcall.json');
  });

  it('FR-25.2 parsing: the JSON alone or inside pasted text; not a state, broken JSON, a newer format are refused', () => {
    const base = { format: 'seqcall-state', schemaVersion: 1, createdAt: '', project: { name: 'x', language: 'typescript' }, root: { key: 'a#B.c', label: 'B.c' } };
    expect(parseState(`see this:\n\`\`\`json\n${JSON.stringify(base)}\n\`\`\`\nthanks`)).toMatchObject({ root: { key: 'a#B.c' }, expanded: [], choices: {}, filters: [] });
    expect(() => parseState('hello')).toThrow(/No shared diagram/);
    expect(() => parseState('{ "format": "other" }')).toThrow(/not a shared Seqcall diagram/);
    expect(() => parseState('{ "format": ')).toThrow(/No shared diagram/);
    expect(() => parseState('{ "format": "seqcall-state", }')).toThrow(/not valid JSON/);
    expect(() => parseState(JSON.stringify({ ...base, schemaVersion: 2 }))).toThrow(/newer Seqcall/);
  });

  it('FR-25.2 the git state is limited to the project folder and project-relative', async () => {
    const g = (await gitState(FIXTURE_ROOT))!;
    expect(g.dir).toBe('fixtures/sample-app');
    expect(g.commit).toMatch(/^[0-9a-f]{40}$/);
    for (const f of g.changed) expect(f.startsWith('fixtures/')).toBe(false);
  });

  it('FR-25.3 the sender\'s layer config can be used instead of the file (in memory), kept across a config reload, then the file again', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const snap = (await s.exportState(HOST))!;
    snap.config = JSON.stringify({ layers: [{ name: 'Borrowed', match: ['src/services/**'] }] });

    const r = newSession();
    const { diagram, report } = await r.restoreState(snap, { language: 'typescript' });
    const layerOf = (d: SequenceDiagram | undefined) => d!.participants.find((p) => p.className === 'UserService')!.layer;
    expect(layerOf(diagram)).toBe('Application'); // the project's file until chosen
    expect(report.configDiffers).toBe(true);
    expect(diagram!.borrowedConfig).toBeUndefined();

    let d = await r.useSharedConfig(true);
    expect(layerOf(d)).toBe('Borrowed');
    expect(d!.borrowedConfig).toEqual({ source: report.source });
    expect(r.configBorrowed()).toBe(true);
    d = await r.refresh([`${FIXTURE_ROOT}/${CONFIG_FILE_NAME}`]); // the file changed meanwhile: still the sender's
    expect(layerOf(d)).toBe('Borrowed');

    d = await r.useSharedConfig(false);
    expect(layerOf(d)).toBe('Application');
    expect(d!.borrowedConfig).toBeUndefined();
    expect(r.configBorrowed()).toBe(false);
  });

  it('FR-25.3 a shared config with a pattern that could hang the analysis is refused; nothing changes', async () => {
    const s = newSession();
    await s.openMethod(await method(K.getUser));
    const snap = (await s.exportState(HOST))!;
    snap.config = JSON.stringify({ layers: [], stereotypes: [{ stereotype: 'x', match: { name: '^(a+)+$' } }] });
    const r = newSession();
    await r.restoreState(snap, { language: 'typescript' });
    await expect(r.useSharedConfig(true)).rejects.toThrow(/stereotype rule "x" has a pattern that repeats a repeated group/);
    expect(r.configBorrowed()).toBe(false);
    expect((await r.redraw())!.participants.find((p) => p.className === 'UserService')!.layer).toBe('Application');
  });

  it('FR-25.3 risky patterns: nested quantifiers and very long ones', () => {
    for (const p of ['(a+)+', '(\\w*)*', '^(x|y+){2,}$', '(.*a){3}+', 'x'.repeat(201)]) expect(riskyPattern(p), p).toBeDefined();
    for (const p of ['.*Gateway$', '^Notifier$', '(Repo|Repository)$', '\\(a+\\)+', '^I[A-Z]\\w+$']) expect(riskyPattern(p), p).toBeUndefined();
  });
});
