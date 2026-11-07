import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { createCSharpAdapter, CSHARP_SIDECAR_DEV_PATH, CSHARP_SIDECAR_ENV, CSHARP_SIDECAR_JIT_ENV, csharpSidecarEnv, resolveCSharpSidecar } from '../src/rpc/csharp';
import { RpcLanguageAdapter, type RpcAdapterOptions } from '../src/rpc/rpc-adapter';
import { DiagramSession } from '../src/session';

const FAKE = path.resolve(__dirname, 'fixtures/fake-sidecar.mjs');
const GET = 'src/App.Web/Controllers/OrdersController.cs#OrdersController.Get(int)';
const IFACE_FIND = 'src/App.Core/Interfaces/IOrderService.cs#IOrderService.FindAsync(int)';
const IMPL_FIND = 'src/App.Core/Services/OrderService.cs#OrderService.FindAsync(int)';

const adapters: RpcLanguageAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.dispose()));
});

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-rpc-'))).replace(/\\/g, '/');
}

function fake(mode = 'normal', extra: Partial<RpcAdapterOptions> = {}) {
  const root = tempRoot();
  const lines: string[] = [];
  const state = path.join(root, 'crash-state');
  const adapter = new RpcLanguageAdapter({
    projectRoot: root,
    command: process.execPath,
    args: [FAKE, '--root', root, '--mode', mode, '--state', state],
    name: 'fake sidecar',
    log: (l) => lines.push(l),
    ...extra,
  });
  adapters.push(adapter);
  const count = (line: string) => lines.filter((l) => l === line).length;
  return { adapter, root, lines, count };
}

describe('RpcLanguageAdapter (newline-delimited JSON-RPC sidecar)', () => {
  it('starts lazily in the project root and shares one initialize between concurrent requests', async () => {
    const { adapter, root, lines, count } = fake();
    expect(lines).toEqual([]); // nothing started yet
    const [a, b, c] = await Promise.all([adapter.getMethod(GET), adapter.getMethod(IMPL_FIND), adapter.getParameterNames((await adapter.getMethod(GET))!)]);
    expect(a?.name).toBe('Get');
    expect(b?.owner.name).toBe('OrderService');
    expect(c).toEqual(['id']);
    expect(count('recv initialize')).toBe(1);
    expect(lines.some((l) => l.includes(`cwd ${root}`))).toBe(true);
    expect(adapter.initializeResult).toEqual({ projects: ['App.Web', 'App.Core'], documents: 4, loadMs: 12 });
  });

  it('FR-16.10 warmUp starts the sidecar and loads the workspace; a request meanwhile shares the same initialize', async () => {
    const { adapter, count } = fake();
    const load = adapter.warmUp();
    const m = await adapter.getMethod(GET);
    await load;
    expect(m?.name).toBe('Get');
    expect(count('recv initialize')).toBe(1);
    expect(adapter.initializeResult?.documents).toBe(4);
  });

  it('maps null to undefined (absent results and optional fields)', async () => {
    const { adapter, root } = fake();
    expect(await adapter.getMethod('nope')).toBeUndefined();
    expect(await adapter.findEnclosingCallable(`${root}/src/Other.cs`, { line: 0, character: 0 })).toBeUndefined();
    expect(await adapter.getClassInfo('nope')).toBeUndefined();
    const [call] = await adapter.getOutgoingCalls((await adapter.getMethod(GET))!);
    expect(call).not.toHaveProperty('libraryName');
    expect(call.target?.key).toBe(IFACE_FIND);
    const info = (await adapter.getClassInfo('src/App.Web/Controllers/OrdersController.cs#OrdersController'))!;
    expect(info).not.toHaveProperty('extends');
    expect(info.decorators).toEqual(['ApiController', 'Route']);
  });

  it('drops implementations in test files and lists test callers last (TestFileMatcher)', async () => {
    const { adapter } = fake();
    const impls = await adapter.getImplementations((await adapter.getMethod(IFACE_FIND))!);
    expect(impls.map((i) => i.key)).toEqual([IMPL_FIND]);
    const callers = await adapter.getCallers((await adapter.getMethod(GET))!);
    expect(callers.map((c) => c.id)).toEqual(['src/App.Web/Program.cs:3:1', 'tests/App.Tests/OrdersTests.cs:5:9']);
    expect(callers.map((c) => c.inTest ?? false)).toEqual([false, true]); // FR-4.4
  });

  it('FR-12.12 getTypeUses maps nulls; an older sidecar without the method yields no uses', async () => {
    const { adapter } = fake();
    const get = (await adapter.getMethod(GET))!;
    const uses = await adapter.getTypeUses(get);
    expect(uses.map((u) => u.type.key)).toEqual(['src/App.Core/Services/OrderService.cs#OrderService']);
    expect('declaration' in uses[0].type).toBe(false);
    const old = fake('old-sidecar').adapter;
    expect(await old.getTypeUses((await old.getMethod(GET))!)).toEqual([]);
    await expect(old.getMethod('boom')).rejects.toThrow(/kaboom/); // other errors still reject
  });

  it('rejects a failing request with the sidecar message and keeps the process', async () => {
    const { adapter, count } = fake();
    await expect(adapter.getMethod('boom')).rejects.toThrow(/fake sidecar: "getMethod" failed: kaboom/);
    expect((await adapter.getMethod(GET))?.name).toBe('Get');
    expect(count('recv initialize')).toBe(1);
  });

  it('rejects a request that does not answer in time; later requests still work', async () => {
    const { adapter } = fake('hang', { requestTimeoutMs: 300 });
    const get = (await adapter.getMethod(GET))!;
    await expect(adapter.getCallers(get)).rejects.toThrow(/"getCallers" timed out/);
    expect((await adapter.getMethod(IMPL_FIND))?.name).toBe('FindAsync');
  });

  it('restarts once after a crash and retries the request', async () => {
    const { adapter, lines, count } = fake('crash-once');
    const calls = await adapter.getOutgoingCalls((await adapter.getMethod(GET))!);
    expect(calls).toHaveLength(1);
    expect(count('recv initialize')).toBe(2);
    expect(lines.some((l) => l.includes('restarting (1/1)'))).toBe(true);
  });

  it('gives up with a clear message when the sidecar keeps crashing', async () => {
    const { adapter, count } = fake('crash-always');
    const get = (await adapter.getMethod(GET))!;
    await expect(adapter.getOutgoingCalls(get)).rejects.toThrow(/fake sidecar exited \(code 3\)[\s\S]*simulated crash/);
    expect(count('recv initialize')).toBe(2);
  });

  it('reports a failing initialize', async () => {
    const { adapter } = fake('init-error');
    await expect(adapter.getMethod(GET)).rejects.toThrow(/"initialize" failed: no solution found/);
  });

  it('updateFile before the first request does not start the sidecar', async () => {
    const { adapter, root, lines, count } = fake();
    await adapter.updateFile(`${root}/src/A.cs`);
    expect(lines).toEqual([]);
    await adapter.getMethod(GET);
    await adapter.updateFile(`${root}/src/A.cs`, 'class A {}');
    // stderr is a separate pipe: its line can come after the answer
    await vi.waitFor(() => expect(count('recv updateFile')).toBe(1));
  });

  it('dispose sends shutdown, the process exits, later calls reject', async () => {
    const { adapter, count } = fake();
    await adapter.getMethod(GET);
    await adapter.dispose();
    await vi.waitFor(() => expect(count('recv shutdown')).toBe(1));
    await expect(adapter.getMethod(GET)).rejects.toThrow(/disposed/);
  });

  it('a DiagramSession works on top of the RPC adapter', async () => {
    const { adapter, root } = fake();
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    const d = (await session.openAt(`${root}/src/App.Web/Controllers/OrdersController.cs`, { line: 11, character: 8 }))!;
    expect(d.root.key).toBe(GET);
    const call = d.messages.find((m) => m.id === 'root/0:FindAsync')!;
    // the only production implementation is auto-selected; the fake in tests/ is ignored
    expect(call.polymorphic).toMatchObject({ interfaceKey: 'src/App.Core/Interfaces/IOrderService.cs#IOrderService', selectedKey: 'src/App.Core/Services/OrderService.cs#OrderService' });
    const ctrl = d.participants.find((p) => p.className === 'OrdersController')!;
    expect(ctrl).toMatchObject({ stereotypes: ['controller'], layer: 'Presentation' });
    const svc = d.participants.find((p) => p.className === 'OrderService')!;
    expect(svc).toMatchObject({ layer: 'Application' });
    const cd = (await session.getClassDiagram())!;
    expect(cd.classes.map((c) => c.name).sort()).toEqual(['IOrderService', 'OrderService', 'OrdersController']);
  });
});

describe('RpcLanguageAdapter: what an older or broken sidecar answers', () => {
  const SAVE = 'src/App.Core/Interfaces/IOrderService.cs#IOrderService.SaveAsync(Order)';

  it('every answer null: no calls, implementations, callers, names, uses — nothing; a sparse initialize is logged with what it has', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    // no display name: "sidecar"
    const adapter = new RpcLanguageAdapter({ projectRoot: root, command: process.execPath, args: [FAKE, '--root', root, '--mode', 'nulls'], log: (l) => lines.push(l) });
    adapters.push(adapter);
    const m = { key: GET, name: 'Get', owner: { key: 'k', name: 'K', kind: 'class' }, isStatic: false, hasBody: true } as never;
    expect(await adapter.getMethod(GET)).toBeUndefined();
    expect(await Promise.all([adapter.getOutgoingCalls(m), adapter.getImplementations(m), adapter.getCallers(m), adapter.getParameterNames(m), adapter.getTypeUses(m)])).toEqual([[], [], [], [], []]);
    expect(await Promise.all([adapter.getFileTypes('f'), adapter.getModuleFacts('k'), adapter.getBindings(), adapter.getHostsOf('f'), adapter.getEntryPoints(), adapter.getEarlyExits(m), adapter.getReturns(m), adapter.getProjectTypes(), adapter.getValueUses(m)])).toEqual([[], undefined, [], undefined, [], [], [], [], 0]);
    expect(lines).toContain('[seqcall] sidecar ready: 0 project(s), 0 documents, loaded in ? ms');
    expect(adapter.initializeResult).toEqual({});
    await adapter.dispose();
    await expect(adapter.getMethod(GET)).rejects.toThrow('sidecar: the adapter has been disposed');
  });

  it('an older sidecar without the optional methods: none of what they give; failing ones reject', async () => {
    const old = fake().adapter;
    const get = (await old.getMethod(GET))!;
    expect(await Promise.all([old.getFileTypes('f'), old.getModuleFacts('k'), old.getBindings(), old.getHostsOf('f'), old.getEntryPoints(), old.getEarlyExits(get), old.getReturns(get), old.getProjectTypes(), old.getValueUses(get)])).toEqual([undefined, undefined, [], undefined, [], [], [], undefined, 0]);
    const failing = fake('failing').adapter;
    const calls: [string, () => Promise<unknown>][] = [
      ['getTypeUses', () => failing.getTypeUses(get)],
      ['getFileTypes', () => failing.getFileTypes('f')],
      ['getModuleFacts', () => failing.getModuleFacts('k')],
      ['getBindings', () => failing.getBindings()],
      ['getHostsOf', () => failing.getHostsOf('f')],
      ['getEntryPoints', () => failing.getEntryPoints()],
      ['getEarlyExits', () => failing.getEarlyExits(get)],
      ['getReturns', () => failing.getReturns(get)],
      ['getProjectTypes', () => failing.getProjectTypes()],
      ['getValueUses', () => failing.getValueUses(get)],
    ];
    for (const [name, call] of calls) await expect(call()).rejects.toThrow(`fake sidecar: "${name}" failed: ${name} broke`);
  });

  it('class info with null lists (an older sidecar) gets empty lists; an initialize without result is no load summary', async () => {
    const { adapter, lines } = fake('init-null');
    expect(await adapter.getClassInfo('src/App.Core/Legacy.cs#Legacy')).toEqual({
      ref: { key: 'src/App.Core/Legacy.cs#Legacy', name: 'Legacy', kind: 'class' },
      decorators: [],
      implements: [],
      fields: [],
      constructorParams: [],
      methods: [],
      hasPrivateConstructor: false,
      hasStaticInstance: false,
      allMembersStatic: false,
      isExportedInstance: false,
    });
    expect(adapter.initializeResult).toBeUndefined();
    expect(lines.some((l) => l.includes('ready:'))).toBe(false);
  });

  it('test code by the key when an implementation has no declaration; a caller outside the project folder is production code', async () => {
    const { adapter } = fake();
    const save = (await adapter.getMethod(SAVE))!;
    expect((await adapter.getImplementations(save)).map((i) => i.key)).toEqual(['lib:Acme.Data#Acme.Data.Repo.SaveAsync(Order)', 'unknown']);
    expect((await adapter.getCallers(save)).map((c) => `${c.id}${c.inTest ? ' (test)' : ''}`)).toEqual(['outside', 'inside (test)']);
    // test files configured as every top-level file: a library or unknown key is still no file of the project
    const { adapter: wide, root } = fake();
    fs.writeFileSync(path.join(root, '.seqcall.json'), JSON.stringify({ testFiles: ['*', 'tests/**'] }));
    expect((await wide.getImplementations((await wide.getMethod(SAVE))!)).map((i) => i.key)).toEqual(['lib:Acme.Data#Acme.Data.Repo.SaveAsync(Order)', 'unknown']);
  });

  it('FR-24.6 content given for a file is applied again after a restart; given back to the disk it is not', async () => {
    const { adapter, root, count } = fake('crash-once');
    await adapter.updateFile(`${root}/src/A.cs`, 'class A {}');
    await adapter.updateFile(`${root}/src/B.cs`, 'class B {}');
    await adapter.updateFile(`${root}/src/B.cs`); // back to the disk before the start
    const get = (await adapter.getMethod(GET))!;
    await vi.waitFor(() => expect(count('recv updateFile')).toBe(1)); // A only, after initialize
    // the crash restarts the sidecar: A is sent again
    await adapter.getOutgoingCalls(get);
    await vi.waitFor(() => expect(count('recv updateFile')).toBe(2));
    // running: A back to the disk is sent at once
    await adapter.updateFile(`${root}/src/A.cs`);
    await vi.waitFor(() => expect(count('recv updateFile')).toBe(3));
  });

  it('FR-34.1 the sidecar\'s memory only while it runs: asking never starts it; an older sidecar or no answer: not known', async () => {
    const { adapter, count } = fake('memory');
    expect(await adapter.getMemory()).toBeUndefined();
    expect(count('recv initialize')).toBe(0);
    await adapter.getMethod(GET);
    expect(await adapter.getMemory()).toEqual({ pid: expect.any(Number), workingSet: 300 * 1024 * 1024, managedHeap: 120 * 1024 * 1024 });
    // an older sidecar without the method
    const old = fake().adapter;
    await old.getMethod(GET);
    expect(await old.getMemory()).toBeUndefined();
  });

  it('FR-34.1 a sidecar that does not answer within 5 s: not known', async () => {
    const { adapter } = fake('hang-memory');
    await adapter.getMethod(GET);
    expect(await adapter.getMemory()).toBeUndefined();
  }, 15_000);

  it('FR-34.2 release stops the sidecar (its memory is not known any more); the next request starts it with the files given again', async () => {
    const { adapter, root, count } = fake('memory');
    await adapter.updateFile(`${root}/src/A.cs`, 'class A {}');
    await adapter.getMethod(GET);
    await adapter.release();
    await vi.waitFor(() => expect(count('recv shutdown')).toBe(1));
    expect(await adapter.getMemory()).toBeUndefined();
    expect((await adapter.getMethod(GET))?.name).toBe('Get');
    expect(count('recv initialize')).toBe(2);
    await vi.waitFor(() => expect(count('recv updateFile')).toBe(2));
    // nothing running: nothing to stop
    await adapter.release();
    await adapter.release();
    expect(count('recv shutdown')).toBe(2);
  });
});

describe('C# sidecar location and launch', () => {
  it('resolves explicit path → env → development build', () => {
    const saved = process.env[CSHARP_SIDECAR_ENV];
    try {
      delete process.env[CSHARP_SIDECAR_ENV];
      expect(resolveCSharpSidecar().replace(/\\/g, '/')).toBe(path.resolve(__dirname, '../../..', CSHARP_SIDECAR_DEV_PATH).replace(/\\/g, '/'));
      process.env[CSHARP_SIDECAR_ENV] = '/opt/seqcall/Seqcall.CSharp.dll';
      expect(resolveCSharpSidecar()).toBe(path.resolve('/opt/seqcall/Seqcall.CSharp.dll'));
      expect(resolveCSharpSidecar('/x/y.dll')).toBe(path.resolve('/x/y.dll'));
      // outside a checkout (an installed extension: no packages/ folder above): the dll beside the module
      delete process.env[CSHARP_SIDECAR_ENV];
      const installed = tempRoot();
      expect(resolveCSharpSidecar(undefined, `${installed}/dist`)).toBe(path.join(`${installed}/dist`, 'Seqcall.CSharp.dll'));
    } finally {
      if (saved === undefined) delete process.env[CSHARP_SIDECAR_ENV];
      else process.env[CSHARP_SIDECAR_ENV] = saved;
    }
  });

  it('reports a missing sidecar with build instructions', async () => {
    const adapter = createCSharpAdapter(tempRoot(), { sidecarPath: '/nonexistent/Seqcall.CSharp.dll' });
    adapters.push(adapter);
    await expect(adapter.getMethod('x')).rejects.toThrow(/C# sidecar not found at .*Seqcall\.CSharp\.dll/);
  });

  it('launches `<dotnet> <dll> --root <root> [--solution]` in the project root', async () => {
    // a stand-in "dotnet" that runs the fake sidecar with the arguments it is given
    const root = tempRoot();
    const lines: string[] = [];
    const adapter = createCSharpAdapter(root, {
      sidecarPath: FAKE,
      dotnet: process.execPath,
      solution: `${root}/App.sln`,
      log: (l) => lines.push(l),
    });
    adapters.push(adapter);
    expect((await adapter.getMethod(GET))?.name).toBe('Get');
    expect(lines.find((l) => l.startsWith('[seqcall] starting C# sidecar'))).toBe(
      `[seqcall] starting C# sidecar: ${process.execPath} ${FAKE} --root ${root} --solution ${root}/App.sln`,
    );
    expect(lines.some((l) => l.includes(`cwd ${root}`))).toBe(true);
  });

  it('starts the sidecar (and so its MSBuild BuildHost) without dynamic PGO and call-counting delay: faster project load', async () => {
    const lines: string[] = [];
    const adapter = createCSharpAdapter(tempRoot(), { sidecarPath: FAKE, dotnet: process.execPath, log: (l) => lines.push(l) });
    adapters.push(adapter);
    await adapter.getMethod(GET);
    expect(lines.some((l) => l.includes('TieredPGO=0 TC_CallCountingDelayMs=0'))).toBe(true);
  });

  it('keeps JIT settings the user set', () => {
    const env = csharpSidecarEnv({ PATH: '/bin', DOTNET_TieredPGO: '1' });
    expect(env).toEqual({ PATH: '/bin', DOTNET_TieredPGO: '1', DOTNET_TC_CallCountingDelayMs: '0' });
    expect(csharpSidecarEnv({})).toEqual(CSHARP_SIDECAR_JIT_ENV);
  });
});
