import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { HostToClassView, HostToSequenceView, Position, EntryPointListNode } from '@seqcall/protocol';
import { composerOwnerRoot } from '@seqcall/core';
import { HeadlessController, type HostSink } from '../src/controller';
import { locateProject } from '../src/locate';
import { serialQueue, startServer, STDIO_HOST_VERSION } from '../src/server';

const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const APP = `${REPO}/fixtures/sample-app`;
const CONTROLLER = `${APP}/src/controllers/user-controller.ts`;

function positionOf(file: string, needle: string): Position {
  const text = fs.readFileSync(file, 'utf8');
  const before = text.slice(0, text.indexOf(needle)).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

function recordingSink() {
  const seq: HostToSequenceView[] = [];
  const cls: HostToClassView[] = [];
  const other: { kind: string; arg?: unknown }[] = [];
  const sink: HostSink = {
    postSequence: (m) => seq.push(m),
    postClass: (m) => cls.push(m),
    navigate: (range) => other.push({ kind: 'navigate', arg: range }),
    showClassDiagram: () => other.push({ kind: 'showClassDiagram' }),
    log: (level, message) => other.push({ kind: `log:${level}`, arg: message }),
    progress: (title) => other.push({ kind: 'progress', arg: title }),
  };
  return { sink, seq, cls, other };
}

const lastRender = (msgs: HostToSequenceView[]) => {
  const r = msgs.filter((m) => m.type === 'render').pop();
  if (!r || r.type !== 'render') throw new Error(`no render in ${JSON.stringify(msgs.map((m) => m.type))}`);
  return r.diagram;
};

describe('stdio host (core as a sidecar for the Rider plugin)', () => {
  it('FR-15.1 / FR-18.1 locates TS, C# and PHP project roots without an editor API', () => {
    expect(locateProject(CONTROLLER, REPO)).toEqual({ root: APP, language: 'typescript' });
    const cs = fs.readdirSync(`${REPO}/fixtures/sample-cs`, { recursive: true }).map(String).find((f) => f.endsWith('.cs') && !/\b(bin|obj)\b/.test(f))!;
    expect(locateProject(`${REPO}/fixtures/sample-cs/${cs}`, REPO)).toEqual({ root: `${REPO}/fixtures/sample-cs`, language: 'csharp' });
    // FR-18: PHP files belong to the nearest composer.json
    expect(locateProject(`${REPO}/fixtures/php-app/src/Services/OrderService.php`, REPO)).toEqual({ root: `${REPO}/fixtures/php-app`, language: 'php' });
  });

  it('FR-18.9 a file of a Composer dependency belongs to the project that installed it, not to the package', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'seqcall-vendor-')).replace(/\\/g, '/');
    try {
      fs.writeFileSync(`${dir}/composer.json`, '{}');
      fs.mkdirSync(`${dir}/vendor/acme/data-api/src/Models`, { recursive: true });
      fs.writeFileSync(`${dir}/vendor/acme/data-api/composer.json`, '{}'); // the package's own: not the root
      const file = `${dir}/vendor/acme/data-api/src/Models/Market.php`;
      fs.writeFileSync(file, '<?php class Market {}');
      expect(locateProject(file, dir)).toEqual({ root: dir, language: 'php' });
      // no Composer project owning the vendor folder: the nearest composer.json, as before
      expect(composerOwnerRoot('/w/vendor/acme/pkg/src/X.php', () => false)).toBeUndefined();
      expect(composerOwnerRoot('/w/app/X.php', () => true)).toBeUndefined();
      expect(composerOwnerRoot('C:\\w\\vendor\\acme\\X.php', (d) => d === 'C:/w')).toBe('C:/w');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-17.5 after a render the controller posts a second one when the background I/O scan found deeper badges', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    const file = `${REPO}/fixtures/io-app/src/controllers/note-controller.ts`;
    try {
      await c.openAt(file, positionOf(file, 'await this.archiver.run(id);'));
      const run = (d: ReturnType<typeof lastRender>) => d.messages.find((m) => m.methodName === 'run');
      expect(run(lastRender(seq.slice(0, seq.findIndex((m) => m.type === 'render') + 1)))?.sideEffects).toBeUndefined(); // the first render: not analysed yet
      for (let i = 0; i < 100 && !run(lastRender(seq))?.sideEffects; i++) await new Promise((r) => setTimeout(r, 50));
      expect(run(lastRender(seq))?.sideEffects).toMatchObject({ kinds: ['file'], below: true });
    } finally {
      await c.dispose();
    }
  });

  it('FR-15.2 the headless controller renders the sequence diagram, expands and keeps the class view live', async () => {
    const { sink, seq, cls, other } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    try {
      await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      const d = lastRender(seq);
      expect(d.root.name).toBe('getUser');
      expect(other.filter((o) => o.kind === 'progress').map((o) => o.arg)).toEqual(['Analysing sample-app…', null]);

      // Class view opens later: its ready gets the current class diagram.
      await c.onClassMessage({ type: 'ready' });
      const first = cls.pop();
      expect(first?.type).toBe('render');

      // (FR-3.12 a call whose calls are all on an error path shows only the branch's marker with ↯ on: the first with others)
      const expandable = d.messages.find((m) => m.expandable && !m.expanded && m.methodName !== 'validate')!;
      await c.onSequenceMessage({ type: 'expand', messageId: expandable.id });
      expect(lastRender(seq).messages.length).toBeGreaterThan(d.messages.length);
      expect(cls.at(-1)?.type).toBe('render'); // FR-12.4 live update

      // Host-side actions are forwarded, not handled.
      await c.onSequenceMessage({ type: 'navigate', range: d.root.declaration! });
      await c.onSequenceMessage({ type: 'openClassDiagram' });
      expect(other.map((o) => o.kind)).toEqual(expect.arrayContaining(['navigate', 'showClassDiagram']));

      // A reloaded view gets the current diagram again.
      const before = seq.length;
      await c.onSequenceMessage({ type: 'ready' });
      expect(seq.length).toBe(before + 1);
      expect(seq.at(-1)?.type).toBe('render');
    } finally {
      await c.dispose();
    }
  });

  it('FR-15.2 / FR-3.6 smart expand intents reach the session (Rider host)', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    try {
      await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      await c.onSequenceMessage({ type: 'smartExpand' });
      const d = lastRender(seq);
      expect(d.messages.find((m) => m.methodName === 'findUser')!.expanded).toBe(true);
      expect(d.messages.some((m) => m.importance?.low)).toBe(true);
    } finally {
      await c.dispose();
    }
  });

  it('FR-25.2 the sidecar reports the version of its package (set-version keeps them equal)', () => {
    expect(STDIO_HOST_VERSION).toBe(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
  });

  it('FR-25.2 a diagram state copied in one sidecar opens the same diagram in another (positions, report), bad text says why', async () => {
    const a = recordingSink();
    const b = recordingSink();
    const sender = new HeadlessController(a.sink, { workspace: REPO, toolVersion: '0.1.0', hostName: 'jetbrains' });
    const receiver = new HeadlessController(b.sink, { workspace: REPO, toolVersion: '0.1.0' });
    try {
      await sender.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      await sender.onSequenceMessage({ type: 'expand', messageId: 'root/2:findUser' });
      const sent = lastRender(a.seq);
      await sender.onSequenceMessage({ type: 'savePositions', rootKey: sent.root.key, positions: { x: 40 } });
      await sender.onSequenceMessage({ type: 'copyState' });
      const copied = a.seq.at(-1)!;
      if (copied.type !== 'diagramState' || !copied.text) throw new Error(JSON.stringify(copied));
      expect(JSON.parse(copied.text).tool).toEqual({ version: '0.1.0', host: 'jetbrains' }); // pure JSON
      await sender.onSequenceMessage({ type: 'copyState', save: true });
      expect(a.seq.at(-1)).toMatchObject({ type: 'diagramState', save: true, name: 'UserController.getUser.seqcall.json' });

      await receiver.onSequenceMessage({ type: 'openState', text: copied.text });
      const ids = (d: typeof sent) => d.messages.map((m) => m.id);
      expect(ids(lastRender(b.seq))).toEqual(ids(sent));
      const render = b.seq.filter((m) => m.type === 'render').pop()!;
      expect(render.type === 'render' && render.positions).toEqual({ x: 40 });
      const report = b.seq.at(-1)!;
      expect(report.type === 'stateReport' && report.report).toMatchObject({ missing: [] });
      // same commit, config, version, counts (uncommitted edits of the fixture would be listed: not part of this check)
      expect(report.type === 'stateReport' && report.report?.differences.filter((t) => !/uncommitted/.test(t))).toEqual([]);

      await receiver.onSequenceMessage({ type: 'openState', text: 'just words' });
      expect(b.seq.at(-1)).toMatchObject({ type: 'stateReport', error: expect.stringMatching(/No shared diagram/) });
    } finally {
      await sender.dispose();
      await receiver.dispose();
    }
  });

  it('FR-25.3 the sender\'s layer config is used on request (renders say so, the class view too); the project\'s file is not written meanwhile', async () => {
    const a = recordingSink();
    const b = recordingSink();
    const sender = new HeadlessController(a.sink, { workspace: REPO });
    const receiver = new HeadlessController(b.sink, { workspace: REPO });
    const configFile = `${APP}/.seqcall.json`;
    const original = fs.readFileSync(configFile, 'utf8');
    try {
      await sender.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      await sender.onSequenceMessage({ type: 'copyState' });
      const copied = a.seq.at(-1)!;
      if (copied.type !== 'diagramState' || !copied.text) throw new Error(JSON.stringify(copied));
      const json = JSON.parse(copied.text.slice(copied.text.indexOf('{'), copied.text.lastIndexOf('}') + 1));
      json.config = JSON.stringify({ layers: [{ name: 'Borrowed', match: ['src/services/**'] }] });

      await receiver.onClassMessage({ type: 'ready' });
      await receiver.onClassMessage({ type: 'openState', text: JSON.stringify(json) }); // from the class view
      const report = b.seq.at(-1)!;
      expect(report.type === 'stateReport' && report.report?.configDiffers).toBe(true);
      const layer = () => lastRender(b.seq).participants.find((p) => p.className === 'UserService')!.layer;
      expect(layer()).toBe('Application');

      await receiver.onSequenceMessage({ type: 'useSharedConfig', on: true });
      expect(layer()).toBe('Borrowed');
      expect(lastRender(b.seq).borrowedConfig?.source).toMatch(/^UserController\.getUser · sample-app/);
      const cls = b.cls.filter((m) => m.type === 'render').pop()!;
      expect(cls.type === 'render' && cls.borrowedConfig).toBeTruthy();

      await receiver.onSequenceMessage({ type: 'setLayer', classKey: 'src/services/user-service.ts#UserService', className: 'UserService', layer: 'Domain' });
      expect(fs.readFileSync(configFile, 'utf8')).toBe(original);
      expect(b.other.some((o) => o.kind === 'log:error' && /layer config is in use/.test(String(o.arg)))).toBe(true);

      await receiver.onClassMessage({ type: 'useSharedConfig', on: false });
      expect(layer()).toBe('Application');
      expect(lastRender(b.seq).borrowedConfig).toBeUndefined();
    } finally {
      if (fs.readFileSync(configFile, 'utf8') !== original) fs.writeFileSync(configFile, original);
      await sender.dispose();
      await receiver.dispose();
    }
  });

  it('FR-15.2 / FR-16.2 entry points come from the workspace project and open as diagrams', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: APP });
    try {
      await c.onSequenceMessage({ type: 'requestEntryPoints' });
      const msg = seq.at(-1);
      expect(msg?.type).toBe('entryPoints');
      const eps = msg?.type === 'entryPoints' ? msg.entryPoints : [];
      expect(msg?.type === 'entryPoints' && msg.project).toBe('sample-app');
      // FR-16.4 the tree the VS Code sidebar shows, for the panel's ⌂ list: every entry point once
      const tree = msg?.type === 'entryPoints' ? msg.tree! : [];
      expect(tree.map((n) => n.type === 'group' && n.kind)).toContain('cli');
      const below = (n: EntryPointListNode): number[] => (n.type === 'entry' ? [n.index] : n.children.flatMap(below));
      expect(tree.flatMap(below).sort((a, b) => a - b)).toEqual(eps.map((_, i) => i));
      const report = eps.find((e) => e.kind === 'cli')!;
      await c.onSequenceMessage({ type: 'openMethod', methodKey: report.method.key });
      expect(lastRender(seq).root.key).toBe(report.method.key);
    } finally {
      await c.dispose();
    }
  });

  it('FR-26 the codebase map: the sequence view opens the class view on it (also before the class view is open), the class view asks for a folder', async () => {
    const { sink, cls, other } = recordingSink();
    const c = new HeadlessController(sink, { workspace: APP });
    try {
      await c.onSequenceMessage({ type: 'openAppMap' });
      expect(other.at(-1)).toEqual({ kind: 'showClassDiagram' });
      expect(cls).toEqual([]); // not open yet: told when it is ready
      await c.onClassMessage({ type: 'ready' });
      expect(cls[0]).toEqual({ type: 'showAppMap' });
      await c.onClassMessage({ type: 'requestAppMap', path: '' });
      const done = cls.at(-1);
      expect(done?.type === 'appMap' && done.state).toBe('done');
      const level = done?.type === 'appMap' ? done.level! : undefined;
      expect(level!.entryPoints).toBeGreaterThan(0);
      expect(level!.diagram.classes.length).toBeGreaterThan(0);
      expect(cls.some((m) => m.type === 'appMap' && m.state === 'running')).toBe(true);
      // open already: told directly
      await c.onSequenceMessage({ type: 'openAppMap' });
      expect(cls.at(-1)).toEqual({ type: 'showAppMap' });
    } finally {
      await c.dispose();
    }
  });

  it('FR-26.8 a map of selected entry points through the sidecar (Rider, Vim): the selection reaches the class view and the session', async () => {
    const { sink, seq, cls } = recordingSink();
    const c = new HeadlessController(sink, { workspace: APP });
    try {
      await c.onSequenceMessage({ type: 'requestEntryPoints' });
      const list = seq.find((m) => m.type === 'entryPoints');
      const ep = list?.type === 'entryPoints' ? list.entryPoints.find((e) => e.kind !== 'test') : undefined;
      expect(ep).toBeDefined();
      const keys = [`${ep!.kind}|${ep!.label}|${ep!.method.key}`];
      // asked before the class view is open: the selection waits for it
      await c.onSequenceMessage({ type: 'openAppMap', entryPoints: keys });
      expect(cls).toEqual([]);
      await c.onClassMessage({ type: 'ready' });
      expect(cls[0]).toEqual({ type: 'showAppMap', entryPoints: keys });
      await c.onClassMessage({ type: 'requestAppMap', path: '', entryPoints: keys });
      const done = cls.at(-1);
      expect(done?.type === 'appMap' && done.state).toBe('done');
      expect(done?.type === 'appMap' && done.level!.entryPoints).toBe(1);
      // all again
      await c.onSequenceMessage({ type: 'openAppMap' });
      expect(cls.at(-1)).toEqual({ type: 'showAppMap' });
    } finally {
      await c.dispose();
    }
  });

  it('FR-22 paths to here: progress, the reverse tree, and a path opened top-down with its target highlighted', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    const repo = `${APP}/src/adapters/sql-user-repository.ts`;
    try {
      await c.openAt(repo, positionOf(repo, 'const rows'));
      await c.onSequenceMessage({ type: 'requestPaths', messageId: 'root' });
      const states = seq.filter((m) => m.type === 'paths').map((m) => (m.type === 'paths' ? m.state : ''));
      expect(states[0]).toBe('running');
      const done = seq.at(-1);
      if (done?.type !== 'paths' || !done.tree) throw new Error(`no paths result: ${JSON.stringify(done)}`);
      const findUser = done.tree.callers!.find((n) => n.method.name === 'findUser')!;
      const getUser = findUser.callers!.find((n) => n.method.name === 'getUser')!;
      await c.onSequenceMessage({
        type: 'openPath',
        steps: [
          { methodKey: getUser.method.key, call: { range: getUser.call!.range } },
          { methodKey: findUser.method.key, call: { range: findUser.call!.range } },
          { methodKey: done.tree.method.key },
        ],
      });
      const d = lastRender(seq);
      expect(d.root.name).toBe('getUser');
      const hl = seq.at(-1);
      expect(hl?.type).toBe('highlight');
      const target = d.messages.find((m) => hl?.type === 'highlight' && m.id === hl.messageId);
      expect(target?.methodKey).toBe(done.tree.method.key);
    } finally {
      await c.dispose();
    }
  });

  it('FR-23 find: the collapsed calls are searched, a hit is revealed and highlighted; the class view hands a query to the flow', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    try {
      await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      await c.onSequenceMessage({ type: 'searchCollapsed', query: 'query' });
      const res = seq.at(-1);
      if (res?.type !== 'searchResults' || !res.hits?.length) throw new Error(`no hits: ${JSON.stringify(res)}`);
      expect(res).toMatchObject({ query: 'query', state: 'done' });
      await c.onSequenceMessage({ type: 'revealSearchHit', hit: res.hits[0] });
      const hl = seq.at(-1);
      if (hl?.type !== 'highlight') throw new Error('no highlight');
      expect(lastRender(seq).messages.find((m) => m.id === hl.messageId)?.methodName).toBe('query');
      await c.onClassMessage({ type: 'findInFlow', query: 'save' });
      expect(seq.at(-1)).toEqual({ type: 'openFind', query: 'save' });
    } finally {
      await c.dispose();
    }
  });

  it('FR-15.2 the caret inside a visible call site highlights its message (FR-2.4)', async () => {
    const { sink, seq } = recordingSink();
    const c = new HeadlessController(sink, { workspace: REPO });
    try {
      await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
      const call = lastRender(seq).messages.find((m) => m.kind !== 'found' && m.callSite)!;
      await c.caretMoved(call.callSite!.file, call.callSite!.start);
      expect(seq.at(-1)).toEqual({ type: 'highlight', messageId: call.id });
    } finally {
      await c.dispose();
    }
  });

  it('FR-15.3 newline-delimited JSON-RPC: requests are answered, view models arrive as post notifications', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let buf = '';
    output.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const handle = startServer(input, output);
    const send = (obj: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
    send({ id: 1, method: 'initialize', params: { workspace: REPO } });
    send({ method: 'openAt', params: { file: CONTROLLER, position: positionOf(CONTROLLER, 'this.validate(id);') } });
    send({ method: 'view', params: { view: 'sequence', message: { type: 'openClassDiagram' } } });
    send({ id: 2, method: 'nope' });
    send({ id: 3, method: 'shutdown' });
    await handle.closed;

    expect(lines[0]).toMatchObject({ id: 1, result: { name: 'seqcall-stdio-host' } });
    // FR-16.14 the spinner while the project is first analysed, then the diagram
    expect(lines.find((l) => l.method === 'post').params.message).toEqual({ type: 'busy', text: 'Analysing sample-app…' });
    const post = lines.find((l) => l.method === 'post' && l.params.message.type !== 'busy');
    expect(post.params.view).toBe('sequence');
    expect(post.params.message.type).toBe('render');
    // Strict arrival order: the render precedes the class-diagram request.
    expect(lines.findIndex((l) => l.method === 'showClassDiagram')).toBeGreaterThan(lines.indexOf(post));
    expect(lines.find((l) => l.id === 2).error.code).toBe(-32601);
    expect(lines.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: null });
  });

  it('FR-15.3 a request that throws is reported and the requests after it still run, in order', async () => {
    const errors: unknown[] = [];
    const ran: number[] = [];
    const { enqueue, idle } = serialQueue((e) => errors.push(e));
    void enqueue(async () => void ran.push(1));
    void enqueue(async () => {
      throw new Error('boom');
    });
    void enqueue(async () => void ran.push(3));
    await idle();
    expect(ran).toEqual([1, 3]);
    expect(errors).toEqual([new Error('boom')]);
  });

  const bundle = path.resolve(__dirname, '../dist/stdio-host.cjs');
  it.runIf(fs.existsSync(bundle))('FR-15.3 the bundled sidecar runs as a process (stdout is JSON-RPC only)', async () => {
    const child = spawn(process.execPath, [bundle, '--workspace', REPO], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: string[] = [];
    child.stdout.setEncoding('utf8').on('data', (c) => out.push(c));
    const send = (obj: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
    send({ id: 1, method: 'initialize', params: {} });
    send({ method: 'openAt', params: { file: CONTROLLER, position: positionOf(CONTROLLER, 'this.validate(id);') } });
    send({ id: 2, method: 'shutdown' });
    const code = await new Promise((r) => child.on('exit', r));
    expect(code).toBe(0);
    const lines = out.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.find((l) => l.method === 'post' && l.params.message.type === 'render')?.params.message.diagram.root.name).toBe('getUser');
  });
});
