import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostToSequenceView, SequenceDiagram } from '@seqcall/protocol';
import type { SeqcallTestApi } from '../../src/extension';

// Runs after extension.test.ts (the runner loads the files in name order): the host's dialogs answered by the
// test and view messages that suite does not send. Every test opens the diagram it needs.

const workspaceRoot = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const controllerFile = () => path.join(workspaceRoot(), 'src', 'controllers', 'user-controller.ts');
const configFile = () => path.join(workspaceRoot(), '.seqcall.json');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ':');

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== null && (v as unknown) !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type Render = Extract<HostToSequenceView, { type: 'render' }>;
type Said = { kind: 'info' | 'warning' | 'error'; message: string; items: string[] };

suite('Seqcall host: dialogs, view messages', () => {
  let api: SeqcallTestApi;
  let original: SeqcallTestApi['dialogs'];
  /** What the host said, oldest first; `reply` picks a button. */
  const said: Said[] = [];
  let reply: (s: Said) => string | undefined | Promise<string | undefined> = () => undefined;

  const renders = () => api.sequenceMessages().filter((m): m is Render => m.type === 'render');
  const settledRenders = async () => {
    await api.settled();
    return renders().length;
  };
  const nextRender = (count: number) => waitFor('next render', () => renders()[count]);
  const saidLike = (re: RegExp) => said.find((s) => re.test(s.message));
  /** The editor showing the project's config once its text matches `re` (an editor opened earlier shows the new text a moment later). */
  const configEditor = (re: RegExp) =>
    waitFor(`the config in an editor matching ${re}`, () => vscode.window.visibleTextEditors.find((e) => norm(e.document.uri.fsPath) === norm(configFile()) && re.test(e.document.getText())));

  /** The getUser diagram, as Show Sequence Diagram in its body opens it. */
  async function openGetUser(): Promise<SequenceDiagram> {
    const doc = await vscode.workspace.openTextDocument(controllerFile());
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(12, 4, 12, 4);
    const before = await settledRenders();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram', doc.uri);
    const r = await waitFor('getUser render', () => renders().slice(before).find((x) => x.diagram.root.name === 'getUser'), 60_000);
    await api.settled();
    return r.diagram;
  }

  /** Runs `body` and puts the project's .seqcall.json back afterwards (and the diagram's layers with it). */
  async function keepingConfig(body: (original: string) => Promise<void>): Promise<void> {
    const text = fs.readFileSync(configFile(), 'utf8');
    try {
      await body(text);
    } finally {
      fs.chmodSync(configFile(), 0o644);
      if (fs.readFileSync(configFile(), 'utf8') !== text) {
        fs.writeFileSync(configFile(), text);
        await waitFor('the config reloaded', () => renders().at(-1)?.diagram.participants.find((p) => p.className === 'UserService')?.layer === 'Application');
      }
      // written behind VS Code's back: its copy of an open config catches up a moment later
      await waitFor('the open config up to date', () => vscode.workspace.textDocuments.every((d) => norm(d.uri.fsPath) !== norm(configFile()) || d.getText() === text));
      await api.settled();
    }
  }

  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.displayName === 'Seqcall') as vscode.Extension<SeqcallTestApi>;
    api = ext.isActive ? ext.exports : await ext.activate();
    original = { ...api.dialogs };
    const record = (kind: Said['kind']) => (message: string, ...items: string[]) => {
      const s = { kind, message, items };
      said.push(s);
      return Promise.resolve(reply(s));
    };
    api.dialogs.info = record('info');
    api.dialogs.warning = record('warning');
    api.dialogs.error = record('error');
  });

  setup(() => {
    said.length = 0;
    reply = () => undefined;
  });

  suiteTeardown(() => {
    Object.assign(api.dialogs, original);
  });

  // ───────────────────────────── FR-7.5 / 7.11 / 12.16 / 19.10 config writes ─────────────────────────────

  test('FR-7.5 Move to layer: Undo puts .seqcall.json back and the class in its old layer', async () => {
    const d = await openGetUser();
    const p = d.participants.find((x) => x.className === 'UserService')!;
    await keepingConfig(async (text) => {
      reply = (s) => (s.message.startsWith('UserService → Domain layer') ? 'Undo' : undefined);
      await api.simulateViewMessage({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain' });
      assert.deepStrictEqual(saidLike(/→ Domain layer/)?.items, ['Open', 'Undo']);
      await waitFor('the config undone', () => fs.readFileSync(configFile(), 'utf8') === text);
      await waitFor('UserService back in Application', () => renders().at(-1)!.diagram.participants.find((x) => x.className === 'UserService')?.layer === 'Application');
    });
  });

  test('FR-7.12 Move to layer with a folder scope names the folder; Open shows the config', async () => {
    const d = await openGetUser();
    const p = d.participants.find((x) => x.className === 'UserService')!;
    await keepingConfig(async () => {
      reply = (s) => (s.message.startsWith('src/services/** → Domain layer') ? 'Open' : undefined);
      await api.simulateViewMessage({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain', match: 'src/services/**' });
      await configEditor(/"name": "Domain",\s*"match": \[\s*"src\/services\/\*\*"\s*\]/);
      assert.deepStrictEqual(saidLike(/^src\/services\/\*\* → Domain layer/)?.items, ['Open', 'Undo']);
    });
  });

  test('FR-7.11 / FR-19.10 Ignore a layer hint / a finding: a project without a config gets one, Undo deletes it again', async () => {
    await openGetUser();
    const aside = `${configFile()}.aside`;
    fs.renameSync(configFile(), aside);
    try {
      await waitFor('the layers from the folder names', () => renders().at(-1)?.diagram.participants.some((p) => p.className === 'UserService'));
      for (const [type, re] of [['ignoreLayerHint', /^Layer hint silenced for src\/util\/\*\*/], ['ignoreFinding', /^Ignoring src\/util\/\*\* in design findings/]] as const) {
        said.length = 0;
        reply = (s) => (re.test(s.message) ? 'Undo' : undefined);
        await api.simulateViewMessage({ type, pattern: 'src/util/**' });
        assert.ok(saidLike(re), JSON.stringify(said));
        await waitFor('the new config deleted by Undo', () => !fs.existsSync(configFile()));
      }
    } finally {
      fs.renameSync(aside, configFile());
      await waitFor('the config reloaded', () => renders().at(-1)?.diagram.participants.find((p) => p.className === 'UserService')?.layer === 'Application');
      await api.settled();
    }
  });

  test('FR-19.10 Ignore a finding, Open: the pattern is in findings.ignore', async () => {
    await openGetUser();
    await keepingConfig(async () => {
      reply = () => 'Open';
      await api.simulateViewMessage({ type: 'openClassDiagram' });
      await api.simulateClassViewMessage({ type: 'ignoreFinding', pattern: 'src/legacy/**' });
      await configEditor(/"findings": \{\s*"ignore": \[\s*"src\/legacy\/\*\*"\s*\]/);
      assert.deepStrictEqual(saidLike(/^Ignoring src\/legacy\/\*\* in design findings/)?.items, ['Open', 'Undo']);
    });
  });

  test('FR-19.22 the diagram lists what is ignored; Stop ignoring from either view takes it out of the config', async () => {
    await openGetUser();
    await keepingConfig(async () => {
      reply = () => undefined;
      await api.simulateViewMessage({ type: 'ignoreFinding', pattern: 'src/legacy/**' });
      await api.simulateViewMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' });
      await waitFor('both listed', () => JSON.stringify(renders().at(-1)?.diagram.ignored) === JSON.stringify({ findings: ['src/legacy/**'], layerHints: ['src/util/**'] }));
      await api.simulateViewMessage({ type: 'unignoreFinding', pattern: 'src/legacy/**' });
      await api.simulateViewMessage({ type: 'openClassDiagram' });
      await api.simulateClassViewMessage({ type: 'unignoreLayerHint', pattern: 'src/util/**' });
      await waitFor('none listed', () => renders().at(-1)?.diagram.ignored === undefined);
      const json = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
      assert.deepStrictEqual([json.findings.ignore, json.layerHints.ignore], [[], []]);
    });
  });

  test('FR-12.16 Adjust the rule: the default dependency rule is added and shown at its line; Undo takes it out', async () => {
    await openGetUser();
    await keepingConfig(async (text) => {
      let undo!: (pick: string) => void;
      reply = (s) => (s.message.startsWith('The default dependency rule was added') ? new Promise((r) => (undo = r)) : undefined);
      await api.simulateViewMessage({ type: 'openDependencyRule' });
      const editor = await configEditor(/"dependencyRule"/);
      assert.match(editor.document.lineAt(editor.selection.start.line).text, /^\s*"dependencyRule": \{/);
      undo('Undo');
      await waitFor('the rule undone', () => fs.readFileSync(configFile(), 'utf8') === text);
      // the rule there already: only shown, nothing written or said
      fs.writeFileSync(configFile(), text.replace(/^\{/, '{\n  "dependencyRule": { "rings": [["Domain"], ["Application"], ["Presentation", "Infrastructure"]] },'));
      await api.settled();
      said.length = 0;
      const written = fs.readFileSync(configFile(), 'utf8');
      await api.simulateViewMessage({ type: 'openClassDiagram' });
      await api.simulateClassViewMessage({ type: 'openDependencyRule' });
      assert.strictEqual(fs.readFileSync(configFile(), 'utf8'), written);
      assert.strictEqual(said.length, 0, JSON.stringify(said));
      assert.strictEqual(vscode.window.activeTextEditor?.selection.start.line, 1);
    });
  });

  test('FR-7.5 a config that cannot be written: each change says so as an error and leaves the file alone', async () => {
    const d = await openGetUser();
    const p = d.participants.find((x) => x.className === 'UserService')!;
    await keepingConfig(async (text) => {
      fs.chmodSync(configFile(), 0o444);
      const sends = [
        () => api.simulateViewMessage({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain' }),
        () => api.simulateViewMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' }),
        () => api.simulateViewMessage({ type: 'ignoreFinding', pattern: 'src/util/**' }),
        () => api.simulateViewMessage({ type: 'openDependencyRule' }),
        () => api.simulateViewMessage({ type: 'unignoreFinding', pattern: 'src/util/**' }),
      ];
      for (const send of sends) await send();
      assert.strictEqual(said.length, 5, JSON.stringify(said));
      assert.ok(said.every((s) => s.kind === 'error' && s.message.startsWith('Seqcall: cannot write .seqcall.json: ')), JSON.stringify(said));
      assert.strictEqual(fs.readFileSync(configFile(), 'utf8'), text);
    });
  });

  // ───────────────────────────── FR-25 save as image / state ─────────────────────────────

  test('FR-25 Save as image: the chosen file gets the PNG bytes or the SVG text; Cancel writes nothing; a failed write says so', async () => {
    await openGetUser();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-img-'));
    let target: vscode.Uri | undefined;
    let asked: vscode.SaveDialogOptions | undefined;
    api.dialogs.save = async (o) => ((asked = o), target);
    try {
      target = vscode.Uri.file(path.join(dir, 'flow.png'));
      await api.simulateViewMessage({ type: 'saveImage', name: 'flow.png', format: 'png', data: Buffer.from([1, 2, 3]).toString('base64') });
      assert.deepStrictEqual([...fs.readFileSync(target.fsPath)], [1, 2, 3]);
      assert.deepStrictEqual(asked?.filters, { 'PNG image': ['png'] });
      assert.strictEqual(norm(asked!.defaultUri!.fsPath), norm(path.join(workspaceRoot(), 'flow.png')));
      assert.deepStrictEqual(saidLike(/^Diagram saved as flow\.png$/)?.items, ['Open', 'Reveal']);
      target = vscode.Uri.file(path.join(dir, 'classes.svg'));
      await api.simulateViewMessage({ type: 'openClassDiagram' });
      await api.simulateClassViewMessage({ type: 'saveImage', name: 'classes.svg', format: 'svg', data: '<svg/>' });
      assert.strictEqual(fs.readFileSync(target.fsPath, 'utf8'), '<svg/>');
      assert.deepStrictEqual(asked?.filters, { 'SVG image': ['svg'] });
      said.length = 0;
      target = undefined;
      await api.simulateViewMessage({ type: 'saveImage', name: 'x.svg', format: 'svg', data: '<svg/>' });
      assert.strictEqual(said.length, 0, JSON.stringify(said));
      target = vscode.Uri.file(dir); // a folder: the write fails
      await api.simulateViewMessage({ type: 'saveImage', name: 'x.svg', format: 'svg', data: '<svg/>' });
      assert.ok(said.some((s) => s.kind === 'error' && s.message.startsWith('Seqcall: cannot save the image: ')), JSON.stringify(said));
    } finally {
      api.dialogs.save = original.save;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FR-25.2 Save the diagram: a .seqcall.json with the state and the saved positions; Cancel saves nothing', async () => {
    const d = await openGetUser();
    await api.simulateViewMessage({ type: 'savePositions', rootKey: d.root.key, positions: { [d.participants[0].id]: 42 } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-state-'));
    let target: vscode.Uri | undefined = vscode.Uri.file(path.join(dir, 'flow.seqcall.json'));
    api.dialogs.save = async () => target;
    try {
      const mark = api.sequenceMessages().length;
      await api.simulateViewMessage({ type: 'copyState', save: true });
      const state = JSON.parse(fs.readFileSync(target.fsPath, 'utf8'));
      assert.strictEqual(state.format, 'seqcall-state');
      assert.strictEqual(state.root.key, d.root.key);
      assert.deepStrictEqual(state.positions, { [d.participants[0].id]: 42 });
      assert.ok(api.sequenceMessages().slice(mark).some((m) => m.type === 'diagramState' && m.done && m.save));
      assert.deepStrictEqual(saidLike(/^Diagram saved as flow\.seqcall\.json/)?.items, ['Reveal']);
      target = undefined;
      const n = api.sequenceMessages().length;
      await api.simulateViewMessage({ type: 'copyState', save: true });
      assert.ok(!api.sequenceMessages().slice(n).some((m) => m.type === 'diagramState'), 'nothing reported after Cancel');
    } finally {
      api.dialogs.save = original.save;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('FR-25.4 Share → Copy as text: the shown flow as an indented tree on the clipboard; the view is told it is done', async () => {
    await openGetUser();
    const mark = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'copyText' });
    const lines = (await vscode.env.clipboard.readText()).split('\n');
    assert.match(lines[0], /^# Seqcall sequence diagram/);
    assert.match(lines[1], /^UserController\.getUser {2}\[Presentation\] {2}src\/controllers\/user-controller\.ts:12$/);
    assert.ok(lines.some((l) => /^ {2}UserService\.findUser\(id\) .*src\/controllers\/user-controller\.ts:15$/.test(l)), lines.join('\n'));
    assert.ok(api.sequenceMessages().slice(mark).some((m) => m.type === 'diagramText' && m.done));
  });

  test('FR-25.5 Ask AI about this call: the question and the flow on the clipboard; a call gone meanwhile: the view is told', async () => {
    const d = await openGetUser();
    const findUser = d.messages.find((m) => m.methodName === 'findUser')!;
    const mark = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'copyText', messageId: findUser.id });
    const lines = (await vscode.env.clipboard.readText()).split('\n');
    assert.match(lines[0], /^Explain the call `UserService\.findUser\(id\)` at src\/controllers\/user-controller\.ts:15 in the flow below\./);
    assert.match(lines[3], /^# Seqcall sequence diagram/);
    assert.ok(api.sequenceMessages().slice(mark).some((m) => m.type === 'diagramText' && m.done));
    await api.simulateViewMessage({ type: 'copyText', messageId: 'root/9:gone' });
    assert.deepStrictEqual(api.sequenceMessages().at(-1), { type: 'diagramText', error: 'That call is no longer in the diagram.' });
  });

  test('FR-25.4 Copy as text from the class view: the classes of the flow on the clipboard; the class view is told', async () => {
    await openGetUser();
    await api.simulateViewMessage({ type: 'openClassDiagram' });
    const mark = api.classMessages().length;
    await api.simulateClassViewMessage({ type: 'copyText' });
    const text = await vscode.env.clipboard.readText();
    assert.strictEqual(text.split('\n')[0], '# Seqcall class diagram of UserController.getUser: the classes in the shown calls');
    assert.match(text, /\n {2}UserController {2}«controller» {2}src\/controllers\/user-controller\.ts:\d+\n/);
    assert.ok(api.classMessages().slice(mark).some((m) => m.type === 'diagramText' && m.done));
  });

  // ───────────────────────────── view messages ─────────────────────────────

  test('FR-4.6 / FR-4.3 / FR-4.2 Focus, Back, Forward and re-rooting at a caller go through the host', async () => {
    const d = await openGetUser();
    const findUser = d.messages.find((m) => m.methodName === 'findUser')!;
    let count = await settledRenders();
    await api.simulateViewMessage({ type: 'focus', messageId: findUser.id });
    assert.strictEqual((await nextRender(count)).diagram.root.name, 'findUser');
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'back' });
    assert.strictEqual((await nextRender(count)).diagram.root.name, 'getUser');
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'forward' });
    assert.strictEqual((await nextRender(count)).diagram.root.name, 'findUser');
    // FR-4.1 / 4.2 the callers of the root, then the diagram from one of them
    const mark = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'requestCallers', messageId: 'root' });
    const callers = await waitFor('callers', () => api.sequenceMessages().slice(mark).find((m) => m.type === 'callers'));
    assert.ok(callers.type === 'callers');
    const getUser = callers.callers.find((c) => c.enclosing.name === 'getUser')!;
    assert.ok(getUser, JSON.stringify(callers.callers.map((c) => c.enclosing.name)));
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'reroot', messageId: 'root', callerId: getUser.id });
    const r = (await nextRender(count)).diagram;
    assert.strictEqual(r.root.name, 'getUser');
    assert.ok(r.messages.some((m) => m.methodName === 'findUser'));
  });

  test('FR-3 collapse, one more level, Overview and Collapse all re-render from the host', async () => {
    const d = await openGetUser();
    const findUser = d.messages.find((m) => m.methodName === 'findUser')!;
    let count = await settledRenders();
    await api.simulateViewMessage({ type: 'expand', messageId: findUser.id });
    const open = (await nextRender(count)).diagram;
    assert.ok(open.messages.some((m) => m.id.startsWith(`${findUser.id}/`)));
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'collapse', messageId: findUser.id });
    assert.ok(!(await nextRender(count)).diagram.messages.some((m) => m.id.startsWith(`${findUser.id}/`)));
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'expandAll', oneLevel: true });
    const level = (await nextRender(count)).diagram;
    assert.ok(level.messages.length > d.messages.length, 'one more level drawn');
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'collapseAll' });
    assert.deepStrictEqual((await nextRender(count)).diagram.messages.filter((m) => m.kind !== 'found' && m.expanded), []);
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'smartExpand' });
    assert.ok((await nextRender(count)).diagram.messages.some((m) => m.expanded), 'Overview opened calls');
  });

  test('FR-11 Show all hidden brings every hidden call back', async () => {
    await openGetUser();
    let count = await settledRenders();
    await api.simulateViewMessage({ type: 'hide', filter: { kind: 'methodName', methodName: 'info' } });
    assert.ok(!(await nextRender(count)).diagram.messages.some((m) => m.methodName === 'info'));
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'unhideAll' });
    const r = (await nextRender(count)).diagram;
    assert.ok(r.messages.some((m) => m.methodName === 'info'));
    assert.deepStrictEqual(r.hiddenFilters, []);
  });

  test('FR-7.12 the layer scopes of a class, asked by both views; FR-24.7 a diff without a review says there is none', async () => {
    const d = await openGetUser();
    const p = d.participants.find((x) => x.className === 'UserService')!;
    const mark = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'requestLayerScopes', classKey: p.classKey, className: p.className });
    const scopes = api.sequenceMessages().slice(mark).find((m) => m.type === 'layerScopes');
    assert.ok(scopes?.type === 'layerScopes' && scopes.scopes.some((s) => s.glob === 'src/services/**'), JSON.stringify(scopes));
    await api.simulateViewMessage({ type: 'openClassDiagram' });
    const cmark = api.classMessages().length;
    await api.simulateClassViewMessage({ type: 'requestLayerScopes', classKey: p.classKey, className: p.className });
    assert.deepStrictEqual(api.classMessages().slice(cmark).find((m) => m.type === 'layerScopes'), scopes);
    await api.simulateViewMessage({ type: 'openDiff', messageId: d.messages.find((m) => m.methodName === 'findUser')!.id });
    assert.deepStrictEqual(said.map((s) => s.message), ['Seqcall: no diff for this call (the review has ended?)']);
  });

  test('FR-1.7 follow cursor: a cursor in another method opens its diagram; off, it does not', async () => {
    await openGetUser();
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(controllerFile()), vscode.ViewColumn.One);
    await vscode.commands.executeCommand('seqcall.toggleFollowCursor');
    try {
      const count = await settledRenders();
      editor.selection = new vscode.Selection(22, 6, 22, 6); // in renameUser
      await waitFor('the renameUser diagram', () => renders().slice(count).find((r) => r.diagram.root.name === 'renameUser'));
    } finally {
      await vscode.commands.executeCommand('seqcall.toggleFollowCursor');
    }
    const count = await settledRenders();
    editor.selection = new vscode.Selection(13, 6, 13, 6); // back in getUser: no new root
    await api.settled();
    assert.ok(!renders().slice(count).some((r) => r.diagram.root.name === 'getUser'));
  });

  // ───────────────────────────── FR-13.2 restore (last: it replaces the sequence panel) ─────────────────────────────

  test('FR-13.2 a sequence panel restored after a restart shows the last diagram again', async () => {
    const last = (await openGetUser()).root.key;
    const panel = vscode.window.createWebviewPanel('seqcall.sequence', 'Sequence', vscode.ViewColumn.Two, { enableScripts: true });
    await api.restoreSequencePanel(panel);
    assert.strictEqual(api.getSequencePanel(), panel);
    const r = await waitFor('the restored render', () => api.sequenceMessages().find((m): m is Render => m.type === 'render'));
    assert.strictEqual(r.diagram.root.key, last);
  });

  test('FR-34.3 Show Memory lists each loaded project (TS: in the extension host); Free Memory from its notification drops the caches', async () => {
    await openGetUser();
    reply = (s) => (s.items.includes('Free Memory') ? 'Free Memory' : undefined);
    await vscode.commands.executeCommand('seqcall.showMemory');
    const shown = saidLike(/^Seqcall: /);
    assert.ok(shown, JSON.stringify(said));
    assert.match(shown.message, /No analysis process is running/);
    assert.deepStrictEqual(shown.items, ['Free Memory', 'Show Details']);
    assert.ok(api.logs().some((l) => /^ {2}sample-app \(TypeScript\): runs in the extension host/.test(l.message)), 'a line per project in the output');
    await waitFor('freed', () => saidLike(/^Seqcall dropped its caches\.$/));
    // the diagram still works afterwards: the next step reads the code again
    const before = await settledRenders();
    await openGetUser();
    assert.ok(renders().length > before);
  });
});
