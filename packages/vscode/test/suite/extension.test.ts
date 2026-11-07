import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EntryPoint, HostToSequenceView, SequenceDiagram, SourceRange } from '@seqcall/protocol';
import type { SeqcallTestApi } from '../../src/extension';
import type { EntryPointsNode } from '../../src/entry-points-tree';

const workspaceRoot = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const controllerFile = () => path.join(workspaceRoot(), 'src', 'controllers', 'user-controller.ts');
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => d.toLowerCase() + ':');

function findExtension(): vscode.Extension<SeqcallTestApi> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.displayName === 'Seqcall');
  assert.ok(ext, 'Seqcall extension is installed in the test host');
  return ext as vscode.Extension<SeqcallTestApi>;
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== null && (v as unknown) !== false) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function openControllerAtGetUser(): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(controllerFile());
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const text = doc.getText();
  const decl = /^[ \t]*(?:public\s+|async\s+)*getUser\s*\(/m.exec(text);
  assert.ok(decl, 'UserController.getUser declaration found in fixture');
  // First line after the opening brace of the method body.
  const brace = text.indexOf('{', decl.index + decl[0].length);
  const bodyLine = doc.positionAt(brace).line + 1;
  const pos = new vscode.Position(bodyLine, doc.lineAt(bodyLine).firstNonWhitespaceCharacterIndex);
  editor.selection = new vscode.Selection(pos, pos);
  return editor;
}

type Render = Extract<HostToSequenceView, { type: 'render' }>;

suite('Seqcall extension host', () => {
  let api: SeqcallTestApi;
  let diagram: SequenceDiagram;

  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('activates when a TypeScript file is opened', async () => {
    const ext = findExtension();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(controllerFile()));
    await waitFor('activation', () => ext.isActive);
    api = ext.exports;
    assert.ok(api && typeof api.simulateViewMessage === 'function', 'activate() returns the test API');
  });

  test('FR-16.10 the project loads in the background after startup; the sidebar scans nothing until asked', async () => {
    await waitFor('the background load', () => api.logs().find((l) => l.message.startsWith('preloaded ') && norm(l.message).includes(norm(workspaceRoot()))), 60_000);
    assert.strictEqual(api.entryPointsRequested(), false, 'no entry-point scan by itself');
    const welcome = findExtension().packageJSON.contributes.viewsWelcome as { view: string; contents: string }[];
    assert.ok(welcome.some((w) => w.view === 'seqcall.entryPoints' && w.contents.includes('command:seqcall.loadEntryPoints')));
  });

  test('FR-1.1: Show Sequence Diagram inside UserController.getUser renders a found message to getUser', async () => {
    await openControllerAtGetUser();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    assert.ok(api.getSequencePanel(), 'sequence panel is open');
    const render = await waitFor(
      'render message',
      () =>
        api
          .sequenceMessages()
          .find((m): m is Extract<HostToSequenceView, { type: 'render' }> => m.type === 'render') ??
        (api.sequenceMessages().find((m) => m.type === 'error' || m.type === 'empty') as never),
      60_000,
    );
    assert.strictEqual(render.type, 'render', `expected render, got ${JSON.stringify(render)}`);
    diagram = render.diagram;
    const found = diagram.messages[0];
    assert.strictEqual(found.kind, 'found');
    assert.strictEqual(found.methodName, 'getUser');
    assert.strictEqual(diagram.root.name, 'getUser');
  });

  test('FR-2.1: navigate opens the file and selects the range; the focus stays on the diagram', async () => {
    assert.ok(diagram, 'diagram from previous test');
    const target = diagram.messages.find((m) => m.kind !== 'found' && m.callSite)?.callSite ?? diagram.messages[0].callSite;
    assert.ok(target, 'a message with a call site');
    const range: SourceRange = target;
    // Move the cursor elsewhere so the assertion proves navigate set the selection.
    if (vscode.window.activeTextEditor) {
      vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    }

    // the diagram has the keyboard (as after a click in it)
    const panel = api.getSequencePanel()!;
    panel.reveal(undefined, false);
    await waitFor('the diagram focused', () => (panel.active ? true : undefined));
    await api.simulateViewMessage({ type: 'navigate', range });

    const editor = await waitFor('editor for navigated file', () => {
      const e = vscode.window.visibleTextEditors.find((x) => norm(x.document.uri.fsPath) === norm(range.file));
      return e && e.selection.start.line === range.start.line ? e : undefined;
    });
    // the diagram keeps the keyboard: the arrow keys walk the diagram, not the code
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(panel.active, 'the diagram panel is still the active one');
    assert.deepStrictEqual(
      [editor.selection.start.line, editor.selection.start.character, editor.selection.end.line, editor.selection.end.character],
      [range.start.line, range.start.character, range.end.line, range.end.character],
    );
  });

  test('FR-24.7 a reviewed call side by side: the base content (left, read-only) against the file now (right), at the call', async () => {
    const file = path.join(workspaceRoot(), 'src/services/user-service.ts');
    await api.showBaseDiff({ file, line: 3, baseText: 'export class UserService {}\n', title: 'user-service.ts (develop ↔ feature/x)' });
    const tab = await waitFor('diff tab', () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.label === 'user-service.ts (develop ↔ feature/x)'));
    const input = tab.input as vscode.TabInputTextDiff;
    assert.strictEqual(input.original.scheme, 'seqcall-base');
    assert.strictEqual(norm(input.modified.fsPath), norm(file));
    const base = await vscode.workspace.openTextDocument(input.original);
    assert.strictEqual(base.getText(), 'export class UserService {}\n');
    await vscode.window.tabGroups.close(tab);
  });

  const renders = () => api.sequenceMessages().filter((m): m is Render => m.type === 'render');
  /** Waits for a render posted after `count` earlier renders. */
  const nextRender = (count: number) => waitFor('next render', () => renders()[count]);
  /** The render count once earlier actions' late renders (I/O scan, cursor, file watchers) are in: the baseline for the next action. */
  const settledRenders = async () => {
    await api.settled();
    return renders().length;
  };

  test('FR-12.4: the class diagram updates live when the sequence diagram is expanded', async () => {
    await api.simulateViewMessage({ type: 'openClassDiagram' });
    const classRenders = () => api.classMessages().filter((m) => m.type === 'render');
    const first = await waitFor('class render', () => classRenders()[0]);
    assert.strictEqual(first.type, 'render');
    const methodsOf = (m: (typeof first)) =>
      m.type === 'render' ? m.diagram.classes.flatMap((c) => c.methods.map((x) => `${c.name}.${x.name}`)) : [];
    assert.ok(methodsOf(first).includes('UserController.getUser'));
    // FR-3.12 validate()'s call to the logger is on its error path: drawn with ↯ Fold errors off
    await api.simulateViewMessage({ type: 'setOption', option: 'foldErrors', value: false });

    await api.settled();
    const before = classRenders().length;
    const validate = diagram.messages.find((m) => m.methodName === 'validate');
    assert.ok(validate?.expandable, 'validate is expandable');
    await api.simulateViewMessage({ type: 'expand', messageId: validate.id });
    const updated = await waitFor('updated class render', () => classRenders()[before]);
    assert.ok(methodsOf(updated).includes('Logger.error'), `Logger.error visible after expand: ${methodsOf(updated)}`);
    await api.simulateViewMessage({ type: 'setOption', option: 'foldErrors', value: true });
  });

  test('FR-12.1: the class and sequence webviews really render inside VS Code (no view errors)', async () => {
    const rendered = (view: string) =>
      api.logs().find((l) => l.level === 'info' && l.message.startsWith(`${view} rendered`) && !/rendered 0 /.test(l.message));
    const cls = await waitFor('class webview render report', () => rendered('class view'), 30_000);
    assert.match(cls.message, /class view rendered [1-9]\d* classes, \d+ relations \(elk\)/);
    await waitFor('sequence webview render report', () => rendered('sequence view'), 30_000);
    const errors = api.logs().filter((l) => l.level === 'error');
    assert.deepStrictEqual(errors, [], 'no errors reported by the webviews');
  });

  test('FR-11.1/11.3: hiding through the view removes messages and lists the filter', async () => {
    const count = await settledRenders();
    await api.simulateViewMessage({ type: 'hide', filter: { kind: 'methodName', methodName: 'info' } });
    const r = await nextRender(count);
    assert.ok(!r.diagram.messages.some((m) => m.methodName === 'info'), 'info hidden');
    const info = r.diagram.hiddenFilters.find((f) => f.filter.kind === 'methodName' && f.filter.methodName === 'info');
    assert.ok(info && info.hiddenCount >= 1, 'filter listed with count');
    await api.simulateViewMessage({ type: 'unhide', filterId: info.filter.id });
    const back = await nextRender(count + 1);
    assert.ok(back.diagram.messages.some((m) => m.methodName === 'info'), 'info visible again');
  });

  test('FR-28.9: Fold all layers from the class view folds the layers opened in the sequence view; the zoom stays on', async () => {
    let count = await settledRenders();
    await api.simulateViewMessage({ type: 'setOption', option: 'layerZoom', value: true });
    let r = await nextRender(count);
    const layer = r.diagram.participants.find((p) => p.objects?.length)!.id;
    await api.simulateViewMessage({ type: 'setLayerOpen', layer, open: true });
    r = await nextRender(count + 1);
    assert.deepStrictEqual(r.diagram.options.openLayers, [layer]);
    count = await settledRenders();
    await api.simulateClassViewMessage({ type: 'foldLayers' });
    r = await nextRender(count);
    assert.deepStrictEqual([r.diagram.options.layerZoom, r.diagram.options.openLayers, r.diagram.options.openObjects], [true, [], []]);
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'setOption', option: 'layerZoom', value: false }); // back to the objects for the next tests
    await nextRender(count);
  });

  test('FR-13.1: saving the file refreshes the diagram and keeps expansion state', async () => {
    const file = controllerFile();
    const original = fs.readFileSync(file, 'utf8');
    const current = renders().at(-1)!.diagram;
    const validate = current.messages.find((m) => m.methodName === 'validate')!;
    assert.ok(validate.expanded, 'validate still expanded from FR-12.4 test');
    const line = validate.callSite!.start.line;
    try {
      const editor = await openControllerAtGetUser();
      const count = await settledRenders();
      await editor.edit((b) => b.insert(new vscode.Position(line, 0), '    // inserted by test\n'));
      await editor.document.save();
      const r = await waitFor('refreshed render', () =>
        renders().slice(count).find((x) => x.diagram.messages.find((m) => m.methodName === 'validate')?.callSite?.start.line === line + 1),
      );
      const v = r.diagram.messages.find((m) => m.methodName === 'validate')!;
      assert.ok(v.expanded, 'expansion preserved across refresh');
    } finally {
      fs.writeFileSync(file, original);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('FR-12.3/12.4: choosing an implementation updates the open class diagram with a realization', async () => {
    const classRenders = () => api.classMessages().filter((m) => m.type === 'render');
    let r = renders().at(-1)!;
    const findUser = r.diagram.messages.find((m) => m.methodName === 'findUser')!;
    if (!findUser.expanded) {
      const count = await settledRenders();
      await api.simulateViewMessage({ type: 'expand', messageId: findUser.id });
      r = await nextRender(count);
    }
    const poly = r.diagram.messages.find((m) => m.methodName === 'findById' && m.polymorphic)!;
    const sql = poly.polymorphic!.implementations.find((i) => i.name === 'SqlUserRepository')!;
    await api.settled();
    const before = classRenders().length;
    await api.simulateViewMessage({ type: 'selectImplementation', messageId: poly.id, classKey: sql.key });
    const cls = await waitFor('class render after impl choice', () => classRenders()[before]);
    assert.strictEqual(cls.type, 'render');
    if (cls.type !== 'render') return;
    const rel = cls.diagram.relations.map((x) => `${x.kind}:${x.from.split('#')[1]}->${x.to.split('#')[1]}`);
    assert.ok(rel.includes('realization:SqlUserRepository->UserRepository'), rel.join(', '));
    assert.ok(cls.diagram.classes.some((c) => c.name === 'UserRepository'), 'interface stays in the class diagram');
  });

  test('FR-25.2 Copy Diagram State puts it on the clipboard; Open Diagram State brings the same diagram back with a report', async () => {
    const sent = renders().at(-1)!.diagram;
    const ids = (d: SequenceDiagram) => d.messages.map((m) => `${m.id}${m.polymorphic?.selectedKey ? `=${m.polymorphic.selectedKey}` : ''}`);
    assert.ok(ids(sent).some((id) => id.includes('=')), 'an implementation is chosen (FR-12.3 test)');
    const before = api.sequenceMessages().length;
    await vscode.commands.executeCommand('seqcall.copyDiagramState');
    const text = await vscode.env.clipboard.readText();
    assert.ok(text.includes('"format": "seqcall-state"') && text.includes(sent.root.key), text.slice(0, 200));
    assert.ok(api.sequenceMessages().slice(before).some((m) => m.type === 'diagramState' && m.done), 'the view is told it was copied');

    // something else on screen, then the state again
    const count = await settledRenders();
    await api.simulateViewMessage({ type: 'collapseAll' });
    assert.notDeepStrictEqual(ids((await nextRender(count)).diagram), ids(sent));
    const mark = api.sequenceMessages().length;
    await vscode.commands.executeCommand('seqcall.openDiagramState');
    const report = await waitFor('the state report', () => api.sequenceMessages().slice(mark).find((m) => m.type === 'stateReport'));
    assert.ok(report.type === 'stateReport' && report.report, JSON.stringify(report));
    assert.deepStrictEqual(report.report.missing, []);
    assert.deepStrictEqual(ids(renders().at(-1)!.diagram), ids(sent));
  });

  test('FR-25.3 the sender\'s layer config on request: renders carry it, .seqcall.json is not written meanwhile', async () => {
    const text = await vscode.env.clipboard.readText(); // copied by the FR-25.2 test
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    json.config = JSON.stringify({ layers: [{ name: 'Borrowed', match: ['src/services/**'] }] });
    const configFile = path.join(workspaceRoot(), '.seqcall.json');
    const original = fs.readFileSync(configFile, 'utf8');
    try {
      let mark = api.sequenceMessages().length;
      await api.simulateViewMessage({ type: 'openState', text: JSON.stringify(json) });
      const report = await waitFor('the state report', () => api.sequenceMessages().slice(mark).find((m) => m.type === 'stateReport'));
      assert.ok(report.type === 'stateReport' && report.report?.configDiffers, JSON.stringify(report));
      let count = await settledRenders();
      await api.simulateViewMessage({ type: 'useSharedConfig', on: true });
      const r = await nextRender(count);
      assert.ok(r.diagram.borrowedConfig, 'the render says the shared config is in use');
      assert.strictEqual(r.diagram.participants.find((p) => p.className === 'UserService')?.layer, 'Borrowed');
      await api.simulateViewMessage({ type: 'setLayer', classKey: 'src/services/user-service.ts#UserService', className: 'UserService', layer: 'Domain' });
      assert.strictEqual(fs.readFileSync(configFile, 'utf8'), original, 'the project config is not written');
      count = await settledRenders();
      mark = count;
      await api.simulateViewMessage({ type: 'useSharedConfig', on: false });
      const back = await nextRender(count);
      assert.ok(!back.diagram.borrowedConfig);
      assert.strictEqual(back.diagram.participants.find((p) => p.className === 'UserService')?.layer, 'Application');
    } finally {
      if (fs.readFileSync(configFile, 'utf8') !== original) fs.writeFileSync(configFile, original);
    }
  });

  test('FR-12.5: clicking a class in the class diagram opens its declaration', async () => {
    const cls = api.classMessages().filter((m) => m.type === 'render').at(-1)!;
    assert.strictEqual(cls.type, 'render');
    if (cls.type !== 'render') return;
    const service = cls.diagram.classes.find((c) => c.name === 'UserService')!;
    const range = service.declaration!;
    if (vscode.window.activeTextEditor) vscode.window.activeTextEditor.selection = new vscode.Selection(0, 0, 0, 0);
    await api.simulateClassViewMessage({ type: 'navigate', range });
    const editor = await waitFor('editor for class declaration', () => {
      const e = vscode.window.visibleTextEditors.find((x) => norm(x.document.uri.fsPath) === norm(range.file));
      return e && e.selection.start.line === range.start.line ? e : undefined;
    });
    assert.strictEqual(editor.selection.start.line, range.start.line);
  });

  test('FR-11 hiding a class from the class diagram hides it in both diagrams (shared filters)', async () => {
    const classRenders = () => api.classMessages().filter((m): m is Extract<typeof m, { type: 'render' }> => m.type === 'render');
    const logger = classRenders().at(-1)!.diagram.classes.find((c) => c.name === 'Logger')!;
    assert.ok(logger, 'Logger visible in the class diagram');
    const seqCount = await settledRenders();
    await api.settled();
    const clsCount = classRenders().length;
    await api.simulateClassViewMessage({ type: 'hide', filter: { kind: 'class', classKey: logger.key, className: 'Logger' } });
    const seq = await nextRender(seqCount);
    const cls = await waitFor('class render after hide', () => classRenders()[clsCount]);
    assert.ok(!seq.diagram.messages.some((m) => m.classKey === logger.key), 'no calls to Logger in the sequence diagram');
    assert.ok(!cls.diagram.classes.some((c) => c.key === logger.key), 'Logger gone from the class diagram');
    const filter = cls.hiddenFilters?.find((f) => f.filter.kind === 'class' && f.filter.classKey === logger.key);
    assert.ok(filter, 'class view receives the shared filter list');
    assert.ok(seq.diagram.hiddenFilters.some((f) => f.filter.id === filter.filter.id), 'same filter in the sequence view');

    await api.simulateClassViewMessage({ type: 'unhide', filterId: filter.filter.id });
    const back = await waitFor('class render after unhide', () => classRenders()[clsCount + 1]);
    assert.ok(back.diagram.classes.some((c) => c.key === logger.key), 'Logger back after unhide');
  });

  test('C#: a .cs file under a .sln is analysed by the C# sidecar (fake sidecar via SEQCALL_DOTNET / SEQCALL_CSHARP_SIDECAR)', async function () {
    const node = process.env.SEQCALL_TEST_NODE;
    if (!node) this.skip();
    const repo = path.resolve(__dirname, '../../../../..');
    process.env.SEQCALL_DOTNET = node;
    process.env.SEQCALL_CSHARP_SIDECAR = path.join(repo, 'packages', 'core', 'test', 'fixtures', 'fake-sidecar.mjs');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-cs-ext-')));
    fs.writeFileSync(path.join(root, 'App.sln'), '');
    const file = path.join(root, 'src', 'App.Web', 'Controllers', 'OrdersController.cs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Array.from({ length: 16 }, (_, i) => `// line ${i}`).join('\n'));

    const doc = await vscode.workspace.openTextDocument(file);
    assert.strictEqual(doc.languageId, 'csharp');
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    editor.selection = new vscode.Selection(11, 4, 11, 4);
    const count = await settledRenders();
    const errors = () => api.sequenceMessages().filter((m) => m.type === 'error').length;
    const errorsBefore = errors();
    // named by URI: with focus left in a webview, VS Code can keep reporting an editor an earlier test opened
    // (FR-12.5) as the active one although the .cs tab is active
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram', doc.uri);
    const result = await waitFor(
      'C# render',
      // a late background re-render of the previous (TypeScript) diagram may come first (FR-16.3 / FR-17.5)
      () => renders().slice(count).find((r) => r.diagram.root.key.includes('.cs#')) ?? (errors() > errorsBefore ? (api.sequenceMessages().at(-1) as never) : undefined),
      60_000,
    );
    assert.strictEqual(result.type, 'render', `expected render, got ${JSON.stringify(result)}`);
    assert.strictEqual(result.diagram.root.key, 'src/App.Web/Controllers/OrdersController.cs#OrdersController.Get(int)');
    const ctrl = result.diagram.participants.find((p) => p.className === 'OrdersController');
    assert.deepStrictEqual([ctrl?.layer, ctrl?.stereotypes], ['Presentation', ['controller']]);
    assert.ok(
      api.logs().some((l) => l.message.includes(`[C#] [seqcall] starting C# sidecar`) && l.message.includes(`--root ${norm(root)}`)),
      'sidecar started with the solution directory as root',
    );
  });

  test('FR-12.9 a clicked class-diagram relation highlights its calls in the sequence diagram', async () => {
    const ids = renders().at(-1)!.diagram.messages.filter((m) => m.kind === 'call').slice(0, 2).map((m) => m.id);
    await api.simulateClassViewMessage({ type: 'highlightMessages', messageIds: ids });
    const last = api.sequenceMessages().at(-1)!;
    assert.deepStrictEqual(last, { type: 'highlight', messageId: ids[0], messageIds: ids });
    // a class method row's Show callers: the sequence panel opens it
    await api.simulateClassViewMessage({ type: 'openInSequence', panel: 'callers', messageId: ids[0] });
    assert.deepStrictEqual(api.sequenceMessages().at(-1), { type: 'openPanel', panel: 'callers', messageId: ids[0] });
  });

  test('FR-12.17 an object clicked in the sequence diagram focuses its class in the open class diagram', async () => {
    await api.simulateViewMessage({ type: 'openClassDiagram' });
    await waitFor('class render', () => api.classMessages().find((m) => m.type === 'render'));
    const key = renders().at(-1)!.diagram.participants.find((p) => p.classKey.includes('#') && !p.classKey.startsWith('lib:'))!.classKey;
    await api.simulateViewMessage({ type: 'focusClass', classKey: key });
    assert.deepStrictEqual(api.classMessages().at(-1), { type: 'focusClass', classKey: key });
  });

  test('FR-12.14 a relation whose calls are collapsed: the sequence diagram expands until they appear and highlights them', async () => {
    const before = await settledRenders();
    await openControllerAtGetUser();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    const d = (await waitFor('getUser render', () => renders().slice(before).find((x) => x.diagram.root.name === 'getUser'))).diagram;
    const svc = d.participants.find((p) => p.className === 'UserService')!;
    assert.ok(!d.messages.some((m) => m.methodName === 'findById'), 'the repository calls start collapsed');
    const count = api.sequenceMessages().length;
    await api.simulateClassViewMessage({ type: 'revealRelation', from: svc.classKey, to: 'src/ports/user-repository.ts#UserRepository', field: 'replica' });
    const hl = (await waitFor('highlight of the revealed calls', () =>
      api.sequenceMessages().slice(count).find((m) => m.type === 'highlight'),
    )) as { messageIds: string[] };
    const shown = renders().at(-1)!.diagram;
    assert.deepStrictEqual(hl.messageIds.map((id) => shown.messages.find((m) => m.id === id)?.methodName), ['findById']);
  });

  test('FR-22 paths to here: the walk reaches the controller, choosing a path opens it with the target highlighted', async () => {
    const before = await settledRenders();
    await openControllerAtGetUser();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    const d = (await waitFor('getUser render', () => renders().slice(before).find((x) => x.diagram.root.name === 'getUser'))).diagram;
    const findUser = d.messages.find((m) => m.methodName === 'findUser')!;
    const count = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'requestPaths', messageId: findUser.id });
    const done = (await waitFor('paths result', () =>
      api.sequenceMessages().slice(count).find((m) => m.type === 'paths' && m.state === 'done'),
    )) as Extract<HostToSequenceView, { type: 'paths' }>;
    const rename = done.tree!.callers!.find((n) => n.method.name === 'rename')!;
    const renameUser = rename.callers!.find((n) => n.method.name === 'renameUser')!;
    const n = api.sequenceMessages().length;
    await api.simulateViewMessage({
      type: 'openPath',
      steps: [
        { methodKey: renameUser.method.key, call: { range: renameUser.call!.range } },
        { methodKey: rename.method.key, call: { range: rename.call!.range } },
        { methodKey: done.tree!.method.key },
      ],
    });
    const hl = (await waitFor('highlight of the target', () => api.sequenceMessages().slice(n).find((m) => m.type === 'highlight'))) as { messageId: string };
    const shown = renders().at(-1)!.diagram;
    assert.strictEqual(shown.root.name, 'renameUser');
    assert.strictEqual(shown.messages.find((m) => m.id === hl.messageId)?.methodName, 'findUser');
  });

  test('FR-33 the editor hover: an interface call names its implementations; the links open the diagram and its paths; nothing on an argument or when turned off', async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(workspaceRoot(), 'src', 'services', 'user-service.ts'));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const text = doc.getText();
    const at = (needle: string, offset: number) => doc.positionAt(text.indexOf(needle) + offset);
    const seqcall = async (pos: vscode.Position) => {
      const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos)) ?? [];
      return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).find((v) => v.includes('**Seqcall**'));
    };
    const onSave = await seqcall(at('primary.save', 9));
    assert.ok(onSave, 'a Seqcall hover on the port call');
    assert.match(onSave, /runs one of InMemoryUserRepository, SqlUserRepository/);
    assert.match(onSave, /\[Sequence diagram\]\(command:seqcall\.openFromHover\?/);
    assert.doesNotMatch(onSave, /Paths to here/, 'a call has no paths-to-here link');
    assert.strictEqual(await seqcall(at('primary.save(user', 13)), undefined, 'nothing on an argument');

    // on a method's name: the count as a heading, each entry point a list item in code font
    const report = await vscode.workspace.openTextDocument(path.join(workspaceRoot(), 'src', 'console', 'report.ts'));
    const name = report.positionAt(report.getText().indexOf('function report') + 'function '.length + 2);
    const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', report.uri, name)) ?? [];
    const onName = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).find((v) => v.includes('**Seqcall**'));
    assert.ok(onName, 'a Seqcall hover on the method name');
    assert.match(onName, /⌂ reached from 1 entry point {2}\n\n- \[`[^`\n]+`\]\(command:seqcall\.openReach\?/);
    assert.match(onName, /\[Paths to here\]\(command:/);

    // FR-33.7 an entry point's link opens its flow down to the method; "+n more" (no index) lists them all to pick from
    const reportFile = report.uri.fsPath.replace(/\\/g, '/');
    const at0 = { line: name.line, character: name.character };
    let n = renders().length;
    await vscode.commands.executeCommand('seqcall.openReach', reportFile, at0, 'report', 0);
    await waitFor('the entry point\'s flow', () => renders().slice(n).find((x) => x.diagram.root.name === 'report'));
    const picks: string[][] = [];
    const pick = api.dialogs.pick;
    try {
      for (const choose of [1, 0]) {
        api.dialogs.pick = (async (items: vscode.QuickPickItem[]) => {
          picks.push(items.map((i) => i.label));
          return items[choose];
        }) as typeof api.dialogs.pick;
        n = api.sequenceMessages().length;
        await vscode.commands.executeCommand('seqcall.openReach', reportFile, at0, 'report');
        if (choose === 1) await waitFor('the picked flow', () => api.sequenceMessages().slice(n).find((m) => m.type === 'highlight'));
        else await waitFor('Paths to here asked', () => api.sequenceMessages().slice(n).find((m) => m.type === 'openPanel' && m.panel === 'paths'));
      }
    } finally {
      api.dialogs.pick = pick;
    }
    assert.strictEqual(picks[0][0], '$(list-tree) Show all in Paths to here');
    assert.strictEqual(picks[0].length, 2, 'the paths row and the one entry point');

    // the link: the diagram of the method the call is in; Paths to here opens its panel on the root
    const before = await settledRenders();
    const file = doc.uri.fsPath.replace(/\\/g, '/');
    const pos = at('async rename', 7);
    await vscode.commands.executeCommand('seqcall.openFromHover', file, { line: pos.line, character: pos.character }, 'paths');
    await waitFor('rename render', () => renders().slice(before).find((x) => x.diagram.root.name === 'rename'));
    await waitFor('paths panel asked', () => api.sequenceMessages().find((m) => m.type === 'openPanel' && m.panel === 'paths' && m.messageId === 'root'));

    const config = vscode.workspace.getConfiguration('seqcall');
    await config.update('hover', false, vscode.ConfigurationTarget.Global);
    try {
      assert.strictEqual(await seqcall(at('primary.save', 9)), undefined, 'the setting turns it off');
    } finally {
      await config.update('hover', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('FR-23 find: Ctrl+F (the Find in Diagram command) opens the bar; collapsed calls are searched and a hit revealed', async () => {
    const before = await settledRenders();
    await openControllerAtGetUser();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    await waitFor('getUser render', () => renders().slice(before).find((x) => x.diagram.root.name === 'getUser'));
    let n = api.sequenceMessages().length;
    await vscode.commands.executeCommand('seqcall.find');
    assert.ok(api.sequenceMessages().slice(n).some((m) => m.type === 'openFind'), 'the sequence panel was asked to open its find bar');
    n = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'searchCollapsed', query: 'query' });
    const res = (await waitFor('search results', () => api.sequenceMessages().slice(n).find((m) => m.type === 'searchResults' && m.state === 'done'))) as Extract<HostToSequenceView, { type: 'searchResults' }>;
    assert.ok(res.hits?.length, 'Database.query is found below findUser');
    n = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'revealSearchHit', hit: res.hits![0] });
    const hl = (await waitFor('highlight', () => api.sequenceMessages().slice(n).find((m) => m.type === 'highlight'))) as { messageId: string };
    assert.strictEqual(renders().at(-1)!.diagram.messages.find((m) => m.id === hl.messageId)?.methodName, 'query');
  });

  test('FR-7.5 moving a class to a layer writes a rule to .seqcall.json and re-renders', async () => {
    const config = path.join(workspaceRoot(), '.seqcall.json');
    const original = fs.readFileSync(config, 'utf8');
    try {
      // (an earlier test opened a C# diagram) — show the TypeScript getUser diagram first
      const before = await settledRenders();
      await openControllerAtGetUser();
      await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
      const d = (await waitFor('getUser render', () => renders().slice(before).find((x) => x.diagram.root.name === 'getUser'))).diagram;
      const p = d.participants.find((x) => x.className === 'UserService')!;
      assert.notStrictEqual(p.layer, 'Domain');
      const count = await settledRenders();
      await api.simulateViewMessage({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain' });
      const r = await waitFor('render with the new layer', () =>
        renders().slice(count).find((x) => x.diagram.participants.find((q) => q.className === 'UserService')?.layer === 'Domain'),
      );
      assert.ok(r);
      const written = fs.readFileSync(config, 'utf8');
      assert.match(written, /"name": "Domain",\s*"match": \[\s*"src\/services\/user-service\.ts"\s*\]/);
      assert.ok(written.includes(original.split('\n').find((l) => l.includes('//')) ?? ''), 'existing comments kept');
    } finally {
      fs.writeFileSync(config, original);
      await new Promise((res) => setTimeout(res, 300));
    }
  });
  test('FR-1.10 combined fragments are drawn and the seqcall.showFragments setting turns them off live', async () => {
    const file = path.join(workspaceRoot(), 'src', 'services', 'import-service.ts');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = doc.getText().split('\n').findIndex((l) => l.includes('async importAll(')) + 1;
    editor.selection = new vscode.Selection(new vscode.Position(line, 4), new vscode.Position(line, 4));
    const before = await settledRenders();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    await waitFor('importAll render', () => renders().slice(before).find((x) => x.diagram.root.name === 'importAll'));
    // FR-3.12 with ↯ Fold errors on the try's catch folds and the frame goes: the frames as the code has them with ↯ off
    const unfolded = await settledRenders();
    await api.simulateViewMessage({ type: 'setOption', option: 'foldErrors', value: false });
    const d = (await waitFor('importAll render, errors drawn', () => renders().slice(unfolded).find((x) => x.diagram.options.foldErrors === false))).diagram;
    assert.deepStrictEqual(d.fragments?.map((f) => f.kind), ['loop', 'alt', 'opt', 'try']);
    const config = vscode.workspace.getConfiguration('seqcall');
    try {
      const count = await settledRenders();
      await config.update('showFragments', false, vscode.ConfigurationTarget.Global);
      const off = await waitFor('render without fragments', () => renders().slice(count).find((x) => x.diagram.options.showFragments === false));
      assert.strictEqual(off.diagram.fragments, undefined);
    } finally {
      await config.update('showFragments', undefined, vscode.ConfigurationTarget.Global);
    }
    const on = await waitFor('render with fragments again', () => renders().at(-1)?.diagram.fragments?.length ? renders().at(-1) : undefined);
    assert.strictEqual(on!.diagram.fragments!.length, 4);
    await api.simulateViewMessage({ type: 'setOption', option: 'foldErrors', value: true });
  });

  test('FR-1.12 minimizing and restoring a fragment from the view', async () => {
    const d = renders().at(-1)!.diagram;
    assert.strictEqual(d.root.name, 'importAll');
    const loop = d.fragments!.find((f) => f.kind === 'loop')!;
    let count = await settledRenders();
    await api.simulateViewMessage({ type: 'collapseFragment', fragmentId: loop.id });
    const folded = (await waitFor('render with the loop minimized', () => renders().slice(count).find((x) => x.diagram.fragments?.some((f) => f.id === loop.id && f.collapsed)))).diagram;
    assert.ok(folded.messages.length < d.messages.length);
    count = await settledRenders();
    await api.simulateViewMessage({ type: 'expandFragment', fragmentId: loop.id });
    const restored = (await waitFor('render with the loop restored', () => renders().slice(count).find((x) => x.diagram.fragments?.some((f) => f.id === loop.id && !f.collapsed)))).diagram;
    assert.strictEqual(restored.messages.length, d.messages.length);
  });

  test('FR-12.12 the class view Uses toggle round-trips: session option on → use relations, off → none', async () => {
    const file = path.join(workspaceRoot(), 'src', 'services', 'shipping-service.ts');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = doc.getText().split('\n').findIndex((l) => l.includes('ShippingPolicy.canShip('));
    editor.selection = new vscode.Selection(new vscode.Position(line, 6), new vscode.Position(line, 6));
    const before = await settledRenders();
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    await waitFor('ship render', () => renders().slice(before).find((x) => x.diagram.root.name === 'ship'));
    await vscode.commands.executeCommand('seqcall.showClassDiagram');
    type ClassRender = Extract<ReturnType<SeqcallTestApi['classMessages']>[number], { type: 'render' }>;
    const classRenders = () => api.classMessages().filter((m): m is ClassRender => m.type === 'render');
    await api.settled();
    let count = classRenders().length;
    await api.simulateClassViewMessage({ type: 'setTypeUses', value: true });
    const on = await waitFor('class render with uses', () => classRenders().slice(count).find((x) => x.diagram.typeUses === true));
    assert.ok(on.diagram.relations.some((r) => r.kind === 'use' && r.to.endsWith('#User')), 'ShippingService ⇢ User use relation');
    assert.ok(on.diagram.classes.some((c) => c.usedOnly), 'used-only class');
    assert.ok(api.logs().every((l) => l.level !== 'error' || !l.message.startsWith('class diagram')), 'no class diagram errors');
    await api.settled();
    count = classRenders().length;
    await api.simulateClassViewMessage({ type: 'setTypeUses', value: false });
    const off = await waitFor('class render without uses', () => classRenders().slice(count).find((x) => !x.diagram.typeUses));
    assert.ok(!off.diagram.relations.some((r) => r.kind === 'use'));
    assert.ok(!off.diagram.classes.some((c) => c.usedOnly));
  });

  test('FR-26 Show Codebase Map opens the class view on the map; the map of the workspace arrives for the folder asked', async () => {
    await vscode.commands.executeCommand('seqcall.showCodebaseMap');
    assert.ok(api.getClassPanel(), 'class panel is open');
    await waitFor('showAppMap posted', () => api.classMessages().find((m) => m.type === 'showAppMap'));
    const before = api.classMessages().length;
    await api.simulateClassViewMessage({ type: 'requestAppMap', path: '' });
    const done = await waitFor('codebase map', () => api.classMessages().slice(before).find((m) => m.type === 'appMap' && m.state !== 'running'));
    assert.strictEqual(done.type === 'appMap' && done.state, 'done');
    const level = done.type === 'appMap' ? done.level! : undefined;
    assert.ok(level && level.entryPoints > 0 && level.diagram.classes.length > 0, 'entry points scanned, classes drawn');
  });

  test('FR-16.4 the Seqcall sidebar lists the entry points by kind; a click opens that flow', async () => {
    const views = findExtension().packageJSON.contributes.views.seqcall as { id: string }[];
    assert.deepStrictEqual(views.map((v) => v.id), ['seqcall.entryPoints', 'seqcall.designIssues', 'seqcall.review']);
    const roots = await api.entryPointsTree();
    // sample-app: programs and module-level calls (no HTTP routes); groups in the panel's order, each non-empty
    const groups = roots.filter((n) => n.type === 'group');
    assert.ok(groups.length > 0 && groups.every((g) => g.type === 'group' && g.items.length > 0), 'non-empty groups: ' + JSON.stringify(roots).slice(0, 300));
    const first = groups[0];
    const ep = first.type === 'group' ? first.items[0] : undefined;
    assert.ok(ep, 'an entry point');
    await vscode.commands.executeCommand('seqcall.openEntryPoint', ep);
    await waitFor('the entry point flow', () => api.sequenceMessages().find((m): m is Render => m.type === 'render' && m.diagram.root.key === ep.method.key));
  });

  test('FR-16.4 the sidebar header names the project; checkboxes only while selecting for a map; a module function by its name', async () => {
    const roots = await api.entryPointsTree();
    assert.match(api.entryPointsHeader() ?? '', /^sample-app · \d+ entry points?$/);
    const group = roots.find((n) => n.type === 'group')!;
    assert.strictEqual(api.entryPointsItem(group).checkboxState, undefined, 'no checkboxes by default');
    await vscode.commands.executeCommand('seqcall.selectEntryPointsForMap');
    assert.notStrictEqual(api.entryPointsItem(group).checkboxState, undefined, 'checkboxes while selecting');
    await vscode.commands.executeCommand('seqcall.doneSelectingEntryPoints');
    assert.strictEqual(api.entryPointsItem(group).checkboxState, undefined);
    // a module-level function: its name, not `<file>.<name>`
    const all: EntryPointsNode[] = [];
    for (const g of roots) for (const c of await api.entryPointsChildren(g)) all.push(...(c.type === 'file' ? await api.entryPointsChildren(c) : [c]));
    const fn = all.find((n) => n.type === 'entry' && n.entryPoint.method.owner.kind === 'module' && n.entryPoint.label !== n.entryPoint.method.name);
    assert.ok(fn && fn.type === 'entry', 'a module function entry in sample-app');
    assert.strictEqual(api.entryPointsItem(fn).description, fn.entryPoint.method.name);
    // one project in this workspace: no Switch Project button needed
    assert.deepStrictEqual(api.workspaceProjects().map((p) => `${p.language} ${p.root.split('/').pop()}`), ['typescript sample-app']);
  });

  test('FR-19.12 the Design Issues view: empty until asked, then the scan\'s result (sample-app: none from its entry point, FR-19.23 some in code it does not reach); a row opens the flow with the evidence', async () => {
    assert.deepStrictEqual(api.designIssues().roots, [], 'nothing before a scan (the welcome shows)');
    await vscode.commands.executeCommand('seqcall.scanDesignIssues');
    const v = await waitFor('the scan result', () => (/ · \d+ issues? in \d+ entry points?/.test(api.designIssues().message ?? '') ? api.designIssues() : undefined), 60_000);
    assert.match(v.message ?? '', /^sample-app · \d+ issues in \d+ entry points? and \d+ methods no flow opened$/);
    // FR-32.4 the scan's outcomes, for the lists: one per entry point the scan covered
    const scanDone = api.sequenceMessages().filter((m) => m.type === 'projectFindings' && m.state === 'done').at(-1);
    assert.ok(scanDone && scanDone.type === 'projectFindings' && scanDone.outcomes && Object.keys(scanDone.outcomes).length === scanDone.total, JSON.stringify(scanDone).slice(0, 300));
    const violations = v.roots.find((n) => n.label === 'Layer violations')!;
    assert.ok(violations.children!.some((r) => r.label === 'Layer violation: AuditEntry → Database' && r.description === 'AuditEntry.persist (no entry point reaches it: no callers)'), JSON.stringify(violations.children!.map((r) => [r.label, r.description])));
    // a finding (fed: the fixture has none) is grouped by kind; its row opens the flow with the evidence
    const ep = (await api.entryPointsTree()).flatMap((n) => (n.type === 'group' ? n.items : []))[0];
    assert.ok(ep, 'an entry point of sample-app');
    const finding = { id: 'f1', kind: 'io-in-loop' as const, title: 'I/O in a loop: X.y (DB)', messageIds: ['root'] };
    api.showDesignIssues({ type: 'projectFindings', state: 'done', findings: [{ finding, entryPoint: ep }], total: 1, project: 'sample-app' });
    const fed = api.designIssues();
    assert.strictEqual(fed.message, 'sample-app · 1 issue in 1 entry point');
    assert.deepStrictEqual(fed.roots.map((g) => `${g.label} ${g.description}`), ['I/O in loops (N+1) 1']);
    assert.strictEqual(fed.roots[0].icon, 'sync'); // its kind's icon, not ⚠ for every group
    const row = fed.roots[0].children![0];
    const before = api.sequenceMessages().length;
    await vscode.commands.executeCommand('seqcall.sidebarOpen', row.action);
    await waitFor('the flow', () => api.sequenceMessages().slice(before).find((m) => m.type === 'render' && m.diagram.root.key === ep.method.key));
    await waitFor('the evidence highlighted', () => api.sequenceMessages().slice(before).find((m) => m.type === 'highlight' && m.finding?.id === 'f1'));
  });

  test('FR-31 Show Unreachable Code: the scan\'s progress and result in the panel; asked again from the view, cached; cancelled from the view', async () => {
    const before = api.sequenceMessages().length;
    await vscode.commands.executeCommand('seqcall.showUnreachable');
    const done = await waitFor('the scan result', () => api.sequenceMessages().slice(before).find((m) => m.type === 'unreachable' && m.state === 'done'), 60_000);
    assert.ok(done.type === 'unreachable' && done.result && done.project === 'sample-app');
    assert.ok(done.result.total > 0 && done.result.entryPoints > 0);
    assert.ok(!('missedMethods' in done.result), 'the probe\'s list stays in the host');
    const shown = api.sequenceMessages().slice(before).find((m) => m.type === 'unreachable' && m.state === 'running');
    assert.ok(shown && shown.type === 'unreachable' && shown.show === true, 'the command shows the panel');
    const again = api.sequenceMessages().length;
    await api.simulateViewMessage({ type: 'requestUnreachable' });
    assert.deepStrictEqual(api.sequenceMessages().slice(again).filter((m) => m.type === 'unreachable').map((m) => m.type === 'unreachable' && m.state), ['running', 'done']);
    // a rescan cancelled from the view at its first progress report
    const third = api.sequenceMessages().length;
    const rescan = api.simulateViewMessage({ type: 'requestUnreachable', rescan: true });
    await api.simulateViewMessage({ type: 'cancelUnreachable' });
    await rescan;
    const states = api.sequenceMessages().slice(third).filter((m) => m.type === 'unreachable').map((m) => m.type === 'unreachable' && m.state);
    assert.deepStrictEqual(states, ['running', 'cancelled']);
  });

  test('FR-24.14 the Review view shows a review asked anywhere; End Review empties it', async () => {
    assert.deepStrictEqual(api.review().roots, []);
    await api.simulateViewMessage({ type: 'requestReview', base: 'HEAD' }); // the panel's review shows in the sidebar too
    const v = await waitFor('the review in the sidebar', () => (/ vs HEAD · /.test(api.review().message ?? '') ? api.review() : undefined), 60_000);
    assert.match(v.message ?? '', /\d+ changed methods? · \d+ issues?/);
    assert.ok(v.roots.length > 0, 'its groups (or "No changes in this project")');
    // a changed method (fed: no changes here) under the entry point reaching it; its row opens the flow down to it
    const ep = (await api.entryPointsTree()).flatMap((n) => (n.type === 'group' ? n.items : []))[0];
    const method = { method: ep.method, status: 'changed' as const, lines: [3], reachedFrom: [{ entryPoint: ep, steps: [{ methodKey: ep.method.key }] }], tests: 0 };
    // FR-29 the structural delta first, as in the panel: a row opens the zoomed flow, a removed entry point opens nothing
    const structure = {
      rows: [
        { kind: 'edge-added' as const, title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer' as const, from: 'layer:Domain', to: 'layer:Infrastructure', pairs: [{ from: 'a#Order', fromName: 'Order', to: 'b#Db', toName: 'Db' }], entryPoint: ep },
        { kind: 'entry-removed' as const, title: 'GET /legacy', detail: 'Legacy.list', entryPoint: ep },
        // FR-29.7 / 28.9
        { kind: 'io-added' as const, title: 'Infrastructure: File', detail: 'ReportFile', level: 'layer' as const, from: 'layer:Infrastructure', io: 'file' as const, entryPoint: ep },
        { kind: 'layer-changed' as const, title: 'TaxTable: Domain → Infrastructure', detail: 'moved from src/domain/tax-table.ts', level: 'layer' as const, from: 'layer:Domain', to: 'layer:Infrastructure', entryPoint: ep },
        // FR-29.10 / 28.11
        { kind: 'client-added' as const, title: 'Infrastructure: Confluent.Kafka (Queue)', detail: 'EventBus', level: 'layer' as const, io: 'queue' as const, client: 'Confluent.Kafka', entryPoint: ep },
        { kind: 'role-changed' as const, title: 'OrderRepo: «repository» → «repository» «singleton»', level: 'layer' as const, entryPoint: ep },
      ],
      compared: 1,
      copied: 0,
      notCompared: 0,
    };
    api.showReview({ type: 'review', state: 'done', result: { base: 'develop', resolvedBase: 'develop', branch: 'feature/x', files: [{ file: 'a.ts', path: '/a.ts', status: 'modified', added: 1, removed: 0 }], methods: [method], issues: [], scanned: 1, notScanned: 0, otherLines: 0, structure } });
    const fed = api.review();
    assert.strictEqual(fed.message, 'feature/x vs develop · 1 changed method · 0 issues · 6 structural changes');
    assert.deepStrictEqual(fed.roots.map((g) => `${g.label} ${g.description}`), ['Structure 6', 'Entry points affected 1']);
    const [edge, gone, io, moved, client, role] = fed.roots[0].children!;
    assert.ok(client.description?.startsWith('new I/O client in the layer · EventBus · ← '), client.description);
    assert.ok(role.description?.startsWith('class changed role · ← '), role.description);
    assert.strictEqual(role.icon, 'diff-renamed');
    assert.ok(io.description?.startsWith('new I/O kind in the layer · ReportFile · ← '), io.description);
    assert.ok(moved.description?.startsWith('class changed layer · moved from src/domain/tax-table.ts · ← '), moved.description);
    assert.strictEqual(moved.icon, 'diff-renamed');
    assert.ok(edge.description?.startsWith('new dependency between layers · Order → Db · ← '), edge.description);
    assert.deepStrictEqual(edge.action, { kind: 'intent', msg: { type: 'openReviewStructure', row: structure.rows[0] } });
    assert.strictEqual(gone.action, undefined);
    const row = fed.roots[1].children![0].children![0];
    await api.simulateViewMessage({ type: 'openClassDiagram' });
    await waitFor('class render', () => api.classMessages().find((m) => m.type === 'render'));
    const before = api.sequenceMessages().length;
    const classBefore = api.classMessages().length;
    await vscode.commands.executeCommand('seqcall.sidebarOpen', row.action);
    await waitFor('the flow down to the method', () => api.sequenceMessages().slice(before).find((m) => m.type === 'render' && m.diagram.root.key === ep.method.key));
    // its code in the editor and its class focused in the class diagram, as a click on the call does
    const file = ep.method.key.slice(0, ep.method.key.indexOf('#'));
    await waitFor('the method in an editor beside the diagram', () => (vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.replace(/\\/g, '/').endsWith(file)) ? true : undefined));
    assert.deepStrictEqual(
      api.classMessages().slice(classBefore).find((m) => m.type === 'focusClass'),
      { type: 'focusClass', classKey: ep.method.owner.key },
    );
    // a method deeper in the flow (a call of the entry point): its declaration, its class — not the entry point's
    const flow = [...api.sequenceMessages()].reverse().find((m) => m.type === 'render' && m.diagram.root.key === ep.method.key);
    assert.ok(flow && flow.type === 'render');
    const call = flow.diagram.messages.find((m) => m.kind === 'call' && m.callSite && m.targetDeclaration && m.methodKey?.includes('#') && m.classKey && m.classKey !== ep.method.owner.key)!;
    assert.ok(call, 'a call of the entry point into another class');
    const deeper = { method: { ...ep.method, key: call.methodKey!, name: call.methodName, owner: { key: call.classKey!, name: call.className ?? '', kind: 'class' as const } }, status: 'changed' as const, lines: [3], reachedFrom: [{ entryPoint: ep, steps: [{ methodKey: ep.method.key, call: { range: call.callSite! } }, { methodKey: call.methodKey! }] }], tests: 0 };
    api.showReview({ type: 'review', state: 'done', result: { base: 'develop', resolvedBase: 'develop', branch: 'feature/x', files: [{ file: 'a.ts', path: '/a.ts', status: 'modified', added: 1, removed: 0 }], methods: [method, deeper], issues: [], scanned: 1, notScanned: 0, otherLines: 0, structure } });
    type Row = { action?: unknown; children?: Row[] };
    const rows = (api.review().roots as Row[]).flatMap(function all(r: Row): Row[] {
      return [r, ...(r.children ?? []).flatMap(all)];
    });
    const deepRow = rows.find((r) => (r.action as { msg?: { type?: string; steps?: unknown[] } } | undefined)?.msg?.steps?.length === 2)!;
    assert.ok(deepRow, 'the row of the deeper method');
    const classBefore2 = api.classMessages().length;
    await vscode.commands.executeCommand('seqcall.sidebarOpen', deepRow.action);
    const target = call.targetDeclaration!.file.replace(/\\/g, '/');
    await waitFor('the deeper method in an editor', () => (vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.replace(/\\/g, '/') === target && e.selection.start.line === call.targetDeclaration!.start.line) ? true : undefined));
    assert.deepStrictEqual(
      api.classMessages().slice(classBefore2).find((m) => m.type === 'focusClass'),
      { type: 'focusClass', classKey: call.classKey },
    );
    await vscode.commands.executeCommand('seqcall.endReview');
    await waitFor('the review ended', () => (api.review().roots.length === 0 && !api.review().message ? true : undefined));
  });

  test('FR-16.9 Go to Entry Point: all words anywhere (route, Class.method, project), tests last, capped; the command is in the view', async () => {
    const { entryPointSearch, SEARCH_MAX } = await import('../../src/entry-point-search');
    const ep = (kind: string, label: string, cls: string, project?: string) => ({ kind, label, method: { key: `a.cs#${cls}.M`, name: 'M', owner: { key: 'a.cs#' + cls, name: cls, kind: 'class' } }, ...(project ? { project } : {}) }) as unknown as EntryPoint;
    const list = [ep('test', 'ShopTests.Delete', 'ShopTests', 'UnitTests'), ep('http', 'DELETE /api/shop/delete-product', 'Shop2Controller', 'ShopApi'), ep('http', 'GET /api/orders', 'OrdersController', 'ShopApi')];
    const r = entryPointSearch(list, 'shop delete');
    assert.deepStrictEqual(r.items.map((i) => `${i.label} | ${i.description}`), ['$(globe) DELETE /api/shop/delete-product | ShopApi · Shop2Controller.M', '$(beaker) ShopTests.Delete | UnitTests · ShopTests.M']);
    assert.strictEqual(entryPointSearch(list, 'shopapi').total, 2);
    // a route as the panel writes it (constraints dropped); found by its words as before
    assert.strictEqual(entryPointSearch([ep('http', 'GET /v{version:apiVersion}/Shops/{id:long}', 'ShopsController')], 'shops').items[0].label, '$(globe) GET /v{version}/Shops/{id}');
    const many = Array.from({ length: SEARCH_MAX + 5 }, (_, i) => ep('http', `GET /x/${i}`, 'X'));
    assert.deepStrictEqual([entryPointSearch(many, 'x').items.length, entryPointSearch(many, 'x').total], [SEARCH_MAX, SEARCH_MAX + 5]);
    // FR-32.4 `has:` the known outcome; its I/O beside the method
    const outcomes = { [`http|GET /api/orders|a.cs#OrdersController.M`]: { kinds: ['db' as const], atLeast: true as const } };
    assert.deepStrictEqual(entryPointSearch(list, 'has:db', outcomes).items.map((i) => `${i.label} | ${i.description}`), ['$(globe) GET /api/orders | ShopApi · OrdersController.M · DB+']);
    assert.strictEqual(entryPointSearch(list, 'has:io').total, 0, 'unknown outcomes match no has:');
    assert.ok((await vscode.commands.getCommands(true)).includes('seqcall.goToEntryPoint'));
    const title = findExtension().packageJSON.contributes.menus['view/title'] as { command: string; when: string }[];
    assert.ok(title.some((m) => m.command === 'seqcall.goToEntryPoint' && m.when === 'view == seqcall.entryPoints'));
  });

  test('FR-26.8 entry points ticked in the sidebar: Map of Selected opens the class view on a map of only them', async () => {
    const roots = await api.entryPointsTree();
    const first = roots.find((n) => n.type === 'group');
    const ep = first && first.type === 'group' ? first.items[0] : undefined;
    assert.ok(ep, 'an entry point');
    const key = `${ep.kind}|${ep.label}|${ep.method.key}`;
    api.entryPointsSelect([key]);
    assert.deepStrictEqual(api.entryPointsSelection(), [key]);
    await vscode.commands.executeCommand('seqcall.mapOfSelectedEntryPoints');
    const show = await waitFor('showAppMap with the selection', () => api.classMessages().find((m) => m.type === 'showAppMap' && m.entryPoints?.length));
    assert.deepStrictEqual(show.type === 'showAppMap' && show.entryPoints, [key]);
    const before = api.classMessages().length;
    await api.simulateClassViewMessage({ type: 'requestAppMap', path: '', entryPoints: [key] });
    const done = await waitFor('the map of one entry point', () => api.classMessages().slice(before).find((m) => m.type === 'appMap' && m.state !== 'running'));
    assert.strictEqual(done.type === 'appMap' && done.level?.entryPoints, 1);
    await vscode.commands.executeCommand('seqcall.clearEntryPointSelection'); // later tests start without a selection
    assert.deepStrictEqual(api.entryPointsSelection(), []);
  });

  test('FR-16.4 Show Sequence Diagram without a source file opens the entry points (no dead end)', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    const list = await waitFor('entry points', () => api.sequenceMessages().find((m) => m.type === 'entryPoints' && m.show));
    assert.ok(list.type === 'entryPoints' && list.entryPoints.length > 0, 'the list is shown with entries');
    // FR-16.11 one project in this workspace: the panel's project name is no switch
    assert.ok(list.type === 'entryPoints' && list.canSwitchProject === false);
    // FR-16.4 the panel gets the sidebar's tree: the same groups in the same order
    const roots = await api.entryPointsTree();
    assert.deepStrictEqual(list.type === 'entryPoints' && list.tree?.map((n) => n.type === 'group' && n.kind), roots.map((n) => n.type === 'group' && n.kind));
  });

  test('FR-18.1: Show Sequence Diagram works in a PHP file (project root = nearest composer.json)', async () => {
    const file = path.join(workspaceRoot(), '..', 'php-app', 'src', 'Services', 'OrderService.php');
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    assert.strictEqual(doc.languageId, 'php');
    const line = doc.getText().split('\n').findIndex((l) => l.includes('$user = $this->repository->findUser'));
    const pos = new vscode.Position(line, doc.lineAt(line).firstNonWhitespaceCharacterIndex);
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand('seqcall.showSequenceDiagram');
    const render = await waitFor(
      'PHP render',
      () => api.sequenceMessages().find((m): m is Render => m.type === 'render' && m.diagram.root.name === 'placeOrder'),
      60_000,
    );
    assert.strictEqual(render.diagram.root.key, 'src/Services/OrderService.php#OrderService.placeOrder');
    // FR-16.14 a project not loaded yet: the panel showed a spinner while it was analysed
    const sent = api.sequenceMessages();
    const busy = sent.findIndex((m) => m.type === 'busy' && m.text === 'Analysing php-app…');
    assert.ok(busy >= 0 && busy < sent.indexOf(render), `busy before the render: ${JSON.stringify(sent.map((m) => m.type))}`);
    const findUser = render.diagram.messages.find((m) => m.methodName === 'findUser');
    assert.deepStrictEqual(findUser?.polymorphic?.implementations.map((i) => i.name), ['EloquentOrderRepository', 'InMemoryOrderRepository']);
  });

  test('FR-16.4 the sidebar follows the open diagram to another project (the PHP one now), unless a project was chosen', async () => {
    await api.entryPointsTree(); // the view reloads when shown
    assert.match(api.entryPointsHeader() ?? '', /^php-app · \d+ entry points?$/);
    // pinned: another diagram does not move it
    api.setEntryPointsProject({ root: norm(workspaceRoot()), language: 'typescript' });
    await api.entryPointsTree();
    assert.match(api.entryPointsHeader() ?? '', /^sample-app · \d+ entry points?$/);
    api.setEntryPointsProject(undefined);
  });

  test('FR-30 Check for Updates: the command and setting exist; no automatic check in the test host', async () => {
    const pkg = findExtension().packageJSON;
    assert.ok((await vscode.commands.getCommands(true)).includes('seqcall.checkForUpdates'));
    assert.strictEqual(vscode.workspace.getConfiguration('seqcall').get('autoUpdate'), 'install');
    assert.deepStrictEqual(pkg.contributes.configuration.properties['seqcall.autoUpdate'].enum, ['install', 'notify', 'off']);
    assert.ok(!api.logs().some((l) => l.message.startsWith('update:')), 'no check outside an installed extension');
  });

  test('FR-30.2 Check for Updates asks GitHub for the latest release of the repository in package.json and installs a newer .vsix', async () => {
    const pkg = findExtension().packageJSON as { version: string };
    const urls: string[] = [];
    const installed: string[] = [];
    const release = (tag: string) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/releases/latest')) return Response.json({ tag_name: tag, html_url: '', assets: [{ name: `seqcall-${tag.slice(1)}.vsix`, url: 'https://api.github.com/asset/1' }] });
        return new Response(new Uint8Array([7]));
      }) as typeof fetch;
    const newer = await api.checkForUpdates({ fetch: release('v99.0.0'), install: async (_b, r) => void installed.push(r.assetName) });
    assert.strictEqual(newer?.kind, 'installed');
    assert.deepStrictEqual(urls, ['https://api.github.com/repos/seqcall/seqcall/releases/latest', 'https://api.github.com/asset/1']);
    assert.deepStrictEqual(installed, ['seqcall-99.0.0.vsix']);
    const same = await api.checkForUpdates({ fetch: release(`v${pkg.version}`), install: async () => assert.fail('nothing to install') });
    assert.deepStrictEqual(same, { kind: 'upToDate', latest: pkg.version });
    assert.ok(api.logs().some((l) => l.message === `update: Seqcall is up to date (${pkg.version}).`));
  });
});
