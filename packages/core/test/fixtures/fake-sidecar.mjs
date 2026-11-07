// Fake C# sidecar for the RPC adapter tests: newline-delimited JSON-RPC 2.0 on stdio, same
// methods as docs/CSHARP-SIDECAR.md, canned results for a tiny two-class "project".
// Usage: node fake-sidecar.mjs --root <root> [--mode normal|crash-once|crash-always|hang|init-error|old-sidecar|nulls|failing|init-null] [--state <file>]
// nulls: every answer is null (initialize: an object of nulls); failing: the optional methods fail with an internal error
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const root = arg('root', process.cwd()).replace(/\\/g, '/');
const mode = arg('mode', 'normal');
const stateFile = arg('state');

const range = (rel, line) => ({ file: `${root}/${rel}`, start: { line, character: 4 }, end: { line, character: 20 } });
const ctrlRef = { key: 'src/App.Web/Controllers/OrdersController.cs#OrdersController', name: 'OrdersController', kind: 'class' };
const svcIface = { key: 'src/App.Core/Interfaces/IOrderService.cs#IOrderService', name: 'IOrderService', kind: 'interface' };
const svcRef = { key: 'src/App.Core/Services/OrderService.cs#OrderService', name: 'OrderService', kind: 'class' };
const fakeRef = { key: 'tests/App.Tests/FakeOrderService.cs#FakeOrderService', name: 'FakeOrderService', kind: 'class' };
const m = (owner, name, params, rel, line, hasBody = true) => ({
  key: `${owner.key}.${name}(${params})`,
  name,
  owner,
  isStatic: false,
  declaration: range(rel, line),
  hasBody,
});
const get = m(ctrlRef, 'Get', 'int', 'src/App.Web/Controllers/OrdersController.cs', 10);
const ifaceFind = m(svcIface, 'FindAsync', 'int', 'src/App.Core/Interfaces/IOrderService.cs', 3, false);
const implFind = m(svcRef, 'FindAsync', 'int', 'src/App.Core/Services/OrderService.cs', 8);
const fakeFind = m(fakeRef, 'FindAsync', 'int', 'tests/App.Tests/FakeOrderService.cs', 5);
// SaveAsync: implementations without a declaration (a test class, a library, an unknown one), a caller outside the root
const ifaceSave = m(svcIface, 'SaveAsync', 'Order', 'src/App.Core/Interfaces/IOrderService.cs', 4, false);
const undeclared = (key, owner) => ({ key, name: 'SaveAsync', owner, isStatic: false, declaration: null, hasBody: true });
const saveImpls = [
  undeclared('tests/App.Tests/FakeOrderService.cs#FakeOrderService.SaveAsync(Order)', fakeRef),
  undeclared('lib:Acme.Data#Acme.Data.Repo.SaveAsync(Order)', { key: 'lib:Acme.Data#Acme.Data.Repo', name: 'Repo', kind: 'class' }),
  undeclared('unknown', { key: 'unknown', name: 'unknown', kind: 'unknown' }),
];
const methods = new Map([get, ifaceFind, implFind, fakeFind, ifaceSave].map((x) => [x.key, x]));

const classInfo = {
  [ctrlRef.key]: {
    ref: ctrlRef,
    file: `${root}/src/App.Web/Controllers/OrdersController.cs`,
    decorators: ['ApiController', 'Route'],
    implements: [],
    fields: [{ name: '_orders', type: svcIface, isStatic: false, injected: true }],
    constructorParams: [{ name: 'orders', type: svcIface }],
    hasPrivateConstructor: false,
    hasStaticInstance: false,
    allMembersStatic: false,
    isExportedInstance: false,
    extends: null,
    methods: [{ name: 'Get', isStatic: false, signature: 'Get(int id): Task<Order>' }],
  },
  [svcIface.key]: {
    ref: svcIface,
    decorators: [],
    implements: [],
    fields: [],
    constructorParams: [],
    hasPrivateConstructor: false,
    hasStaticInstance: false,
    allMembersStatic: false,
    isExportedInstance: false,
    methods: [{ name: 'FindAsync', isStatic: false, signature: 'FindAsync(int id): Task<Order>' }],
  },
  // an older sidecar's class info: lists it has nothing for are null
  'src/App.Core/Legacy.cs#Legacy': {
    ref: { key: 'src/App.Core/Legacy.cs#Legacy', name: 'Legacy', kind: 'class' },
    decorators: null,
    implements: null,
    fields: null,
    constructorParams: null,
    methods: null,
  },
  [svcRef.key]: {
    ref: svcRef,
    decorators: [],
    implements: [svcIface],
    fields: [],
    constructorParams: [],
    hasPrivateConstructor: false,
    hasStaticInstance: false,
    allMembersStatic: false,
    isExportedInstance: false,
    methods: [{ name: 'FindAsync', isStatic: false, signature: 'FindAsync(int id): Task<Order>' }],
  },
};

let updates = 0;
const handlers = {
  initialize: (p) => {
    if (mode === 'init-error') throw Object.assign(new Error('no solution found'), { code: -32001 });
    if (mode === 'init-null') return null;
    if (p.projectRoot !== root) throw new Error(`root mismatch: ${p.projectRoot} != ${root}`);
    return { projects: ['App.Web', 'App.Core'], documents: 4, loadMs: 12 };
  },
  findEnclosingCallable: (p) => (p.file.endsWith('OrdersController.cs') && p.position.line >= 10 ? get : null),
  getMethod: (p) => {
    if (p.key === 'boom') throw new Error('kaboom');
    return methods.get(p.key) ?? null;
  },
  getOutgoingCalls: (p) => {
    if (mode === 'crash-always' || (mode === 'crash-once' && stateFile && !fs.existsSync(stateFile))) {
      if (stateFile) fs.writeFileSync(stateFile, 'crashed');
      process.stderr.write('fatal: simulated crash\n');
      process.exit(3);
    }
    if (p.method.key !== get.key) return [];
    return [
      {
        ordinal: 0,
        kind: 'call',
        range: range('src/App.Web/Controllers/OrdersController.cs', 11),
        methodName: 'FindAsync',
        expressionText: '_orders.FindAsync(id)',
        args: ['id'],
        argOrigins: [{ kind: 'parameter', name: 'id' }],
        receiver: { kind: 'field', name: '_orders' },
        receiverType: svcIface,
        target: ifaceFind,
        isAsync: true,
        isLibrary: false,
        libraryName: null,
      },
    ];
  },
  getImplementations: (p) => (p.method.key === ifaceFind.key ? [fakeFind, implFind] : p.method.key === ifaceSave.key ? saveImpls : []),
  getCallers: (p) =>
    p.method.key === get.key
      ? [
          { id: 'tests/App.Tests/OrdersTests.cs:5:9', enclosing: fakeFind, range: range('tests/App.Tests/OrdersTests.cs', 4), preview: 'ctrl.Get(1)' },
          { id: 'src/App.Web/Program.cs:3:1', enclosing: implFind, range: range('src/App.Web/Program.cs', 2), preview: 'c.Get(2)' },
        ]
      : p.method.key === ifaceSave.key
        ? [
            // beside the root, in a folder whose name is as long as the root's: its path after the root's length is `tests/…`
            { id: 'outside', enclosing: implFind, range: { ...range('x', 1), file: `${root.slice(0, root.lastIndexOf('/'))}/${'s'.repeat(root.length - root.lastIndexOf('/') - 1)}/tests/Probe.cs` }, preview: 'repo.SaveAsync(o)' },
            { id: 'inside', enclosing: fakeFind, range: range('tests/App.Tests/SaveTests.cs', 1), preview: 'repo.SaveAsync(o)' },
          ]
        : [],
  getClassInfo: (p) => classInfo[p.classKey] ?? null,
  getParameterNames: () => ['id'],
  // FR-12.12; mode old-sidecar: the method does not exist (an older sidecar build)
  getTypeUses: (p) => {
    if (mode === 'old-sidecar') throw Object.assign(new Error('Method not found: getTypeUses'), { code: -32601 });
    return p.method.key === get.key ? [{ type: { ...svcRef, declaration: null }, range: range('src/App.Web/Controllers/OrdersController.cs', 11) }] : [];
  },
  updateFile: () => {
    updates++;
    return null;
  },
  stats: () => ({ updates, pid: process.pid }),
  // FR-34.1 only in mode memory (any other mode: an older sidecar without the method); mode hang-memory never answers
  getMemory: () => {
    if (mode !== 'memory') throw Object.assign(new Error('Method not found: getMemory'), { code: -32601 });
    return { pid: process.pid, workingSet: 300 * 1024 * 1024, managedHeap: 120 * 1024 * 1024 };
  },
  shutdown: () => {
    setImmediate(() => process.exit(0));
    return null;
  },
};

const OPTIONAL = ['getTypeUses', 'getFileTypes', 'getProjectTypes', 'getModuleFacts', 'getBindings', 'getHostsOf', 'getEntryPoints', 'getEarlyExits', 'getReturns', 'getValueUses'];

const jit = `TieredPGO=${process.env.DOTNET_TieredPGO ?? '-'} TC_CallCountingDelayMs=${process.env.DOTNET_TC_CallCountingDelayMs ?? '-'}`;
process.stderr.write(`fake sidecar started (mode ${mode}, ${jit}, cwd ${process.cwd().replace(/\\/g, '/')})\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  process.stderr.write(`recv ${req.method}\n`);
  if (mode === 'hang' && req.method === 'getCallers') return;
  if (mode === 'hang-memory' && req.method === 'getMemory') return;
  let response;
  try {
    if (mode === 'nulls' && req.method !== 'shutdown') {
      const result = req.method === 'initialize' ? { projects: null, documents: null, loadMs: null } : null;
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`);
      return;
    }
    if (mode === 'failing' && OPTIONAL.includes(req.method)) throw new Error(`${req.method} broke`);
    const h = handlers[req.method];
    if (!h) throw Object.assign(new Error(`unknown method ${req.method}`), { code: -32601 });
    response = { jsonrpc: '2.0', id: req.id, result: h(req.params ?? {}) };
  } catch (e) {
    response = { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32603, message: e.message } };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
process.stdin.on('end', () => process.exit(0));
