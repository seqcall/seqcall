import ts from 'typescript';
import { timeSlicer } from '../time-slice';
import type { EntryPoint, MethodRef } from '@seqcall/protocol';
import { type CallableNode, type TsModel, skipOuter } from './model';
import { reactRoots, reactRoutes, tanstackRoutes } from './react-entry-points';
import { trimChar } from '../text';

const HTTP_DECORATORS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', All: 'ALL' };
const ROUTER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/**
 * FR-16.1 entry points of a TypeScript / JavaScript project (syntax + symbols, no type analysis):
 * - NestJS-style `@Controller('users')` classes with `@Get(':id')` methods → `GET /users/:id`;
 * - router registrations `app.get('/users/:id', handler)` with a named handler (inline lambdas have no key);
 * - functions called at module level (`main()`, `void main()`, `main().catch(…)`) — what runs when the file runs;
 * - functions named `main`;
 * - React client routes (FR-16.6) and render roots (FR-16.7), see react-entry-points.ts;
 * - background jobs (FR-16.12): `setInterval`, node-cron / cron / node-schedule schedules, BullMQ workers,
 *   NestJS `@Cron` / `@Interval` and Bull `@Process` methods.
 * Test files are skipped (their callbacks are not keyed callables).
 */
export async function entryPoints(model: TsModel, isTestFile: (file: string) => boolean): Promise<EntryPoint[]> {
  // gives way between files: the scan must not block the host
  const slice = timeSlicer();
  const out: EntryPoint[] = [];
  const seen = new Set<string>();
  const add = (kind: EntryPoint['kind'], callable: CallableNode | undefined, label: (m: MethodRef) => string, extra: Partial<EntryPoint> = {}) => {
    const method = callable && model.methodRef(callable);
    if (!method || !method.hasBody) return;
    // a page component can sit at several routes / roots: one entry per route
    const id = `${kind}|${extra.verb ?? ''}|${method.key}${kind === 'route' || kind === 'ui' ? `|${label(method)}` : ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, label: label(method), ...extra, method });
  };
  const qualified = (m: MethodRef) => (m.owner.kind === 'module' ? m.name : `${m.owner.name}.${m.name}`);
  // FR-16.5 a file other project code imports runs its top-level calls on import: not where a program starts
  const imported = await importedFiles(model, isTestFile, slice);

  for (const sf of model.program.getSourceFiles()) {
    await slice();
    if (sf.isDeclarationFile || model.isLibraryFile(sf) || isTestFile(model.rel(sf.fileName))) continue;
    const visit = (n: ts.Node): void => {
      // @Controller('prefix') class { @Get(':id') m() }
      if (ts.isClassDeclaration(n)) {
        const controller = decorator(n, 'Controller');
        if (controller) {
          const prefix = routeArg(controller);
          for (const member of n.members) {
            if (!ts.isMethodDeclaration(member)) continue;
            for (const [name, verb] of Object.entries(HTTP_DECORATORS)) {
              const d = decorator(member, name);
              if (d) add('http', member, () => `${verb} ${joinRoute(prefix, routeArg(d))}`, { verb, detail: 'controller' });
            }
          }
        }
      }
      // app.get('/path', …handlers)
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ROUTER_METHODS.has(n.expression.name.text)) {
        const [path, ...handlers] = n.arguments;
        // a handler is a function; `ajax.post('/url', data)`, `axios.get('/url', { params })` are HTTP client calls
        if (path && ts.isStringLiteralLike(path) && path.text.startsWith('/') && handlers.length && isHandler(model, handlers[handlers.length - 1])) {
          const verb = n.expression.name.text.toUpperCase();
          add('http', handlerOrRegistrar(model, handlers[handlers.length - 1], n), () => `${verb} ${path.text}`, { verb, detail: 'router' });
        }
      }
      // fastify.route({ method: 'GET', url: '/users', handler })
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'route') {
        const opts = n.arguments[0] && skipOuter(n.arguments[0]);
        if (opts && ts.isObjectLiteralExpression(opts)) {
          const url = prop(opts, 'url') ?? prop(opts, 'path');
          const method = prop(opts, 'method');
          const verbs = method && ts.isArrayLiteralExpression(method) ? method.elements : method ? [method] : [];
          const handler = prop(opts, 'handler');
          if (url && ts.isStringLiteralLike(url) && handler) {
            for (const v of verbs) {
              if (!ts.isStringLiteralLike(v)) continue;
              const verb = v.text.toUpperCase();
              add('http', handlerOrRegistrar(model, handler, n), () => `${verb} ${url.text}`, { verb, detail: 'route()' });
            }
          }
        }
      }
      for (const r of [...reactRoutes(model, n), ...tanstackRoutes(model, n)]) add('route', r.component, () => r.path, { detail: r.detail });
      for (const r of reactRoots(model, n)) add('ui', r.component, () => r.label, { detail: `render root (${model.rel(sf.fileName)})` });
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'main' && n.body) add('cli', model.asCallable(n), qualified, { detail: 'main' });
      for (const j of jobs(model, n)) add('job', j.callable, qualified, { detail: j.detail });
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // module-level calls: `main();`, `void main();`, `await main();`, `main().catch(…)` — not in imported modules
    // (`src/config/logger.ts: loadDotenv()`) nor in tool config files (`knexfile.ts`, `vite.config.ts`)
    if (imported.has(sf.fileName) || TOOL_CONFIG.test(sf.fileName.split('/').pop()!)) continue;
    for (const st of sf.statements) {
      if (!ts.isExpressionStatement(st)) continue;
      const call = moduleLevelCall(st.expression);
      if (call) add('cli', resolveCallable(model, call.expression), (m) => `${model.rel(sf.fileName)}: ${qualified(m)}()`, { detail: 'module-level call', file: model.rel(sf.fileName) });
    }
  }
  const order: EntryPoint['kind'][] = ['http', 'route', 'ui', 'cli', 'job', 'handler', 'test'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
}

/** FR-16.12 job decorators on methods: NestJS schedule (`@Cron('0 * * * *')`, `@Interval(5000)`), Bull (`@Process()`). */
const JOB_DECORATORS: Record<string, string> = { Cron: 'cron', Interval: 'interval', Process: 'queue worker' };

/**
 * FR-16.12 background jobs: what a scheduler or a queue runs. The callback when it is named (`setInterval(this.tick,
 * …)`), else the function registering it (`start()` with `setInterval(() => this.run(), ms)`): its flow shows the
 * callback inline. Only library schedulers: a project function named `schedule` is not one.
 */
function jobs(model: TsModel, n: ts.Node): { callable: CallableNode | undefined; detail: string }[] {
  if (ts.isMethodDeclaration(n)) {
    for (const [name, what] of Object.entries(JOB_DECORATORS)) {
      const d = decorator(n, name);
      if (d) return [{ callable: model.asCallable(n), detail: d.arguments[0] && ts.isStringLiteralLike(d.arguments[0]) ? `${what} ${d.arguments[0].text}` : what }];
    }
    return [];
  }
  if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return [];
  const callee = skipOuter(n.expression);
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  const args = n.arguments ?? [];
  const job = (cb: ts.Expression | undefined, detail: string) => (cb && isHandler(model, cb) ? [{ callable: handlerOrRegistrar(model, cb, n), detail }] : []);
  const text = (e: ts.Expression | undefined) => (e && ts.isStringLiteralLike(e) ? ` ${e.text}` : '');
  const from = (pkg: RegExp) => libraryOf(model, callee, pkg);
  if (ts.isCallExpression(n)) {
    if (name === 'setInterval' && from(/^$|^(@types\/node|typescript)$/)) return job(args[0], 'setInterval');
    if (name === 'schedule' && from(/^node-cron$/)) return job(args[1], `cron${text(args[0])}`);
    if (name === 'scheduleJob' && from(/^node-schedule$/)) return job(args[args.length - 1], `schedule${text(args[0])}`);
    return [];
  }
  if (name === 'CronJob' && from(/^cron$/)) return job(args[1], `cron${text(args[0])}`);
  if (name === 'Worker' && from(/^bullmq$/)) return job(args[1], `queue worker${text(args[0])}`);
  return [];
}

/**
 * The package a callee is declared in ('' for the TypeScript / DOM lib), when it matches `pkg`; false for project code.
 * `setInterval` is global (lib.dom / @types/node), `schedule` must come from node-cron.
 */
function libraryOf(model: TsModel, callee: ts.Expression, pkg: RegExp): boolean {
  // (the symbol of `cron.schedule` is that of `schedule`)
  let symbol = model.checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = model.checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).some((d) => {
    const file = d.getSourceFile().fileName;
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
    if (m) return pkg.test(m[1]);
    // the TypeScript lib (lib.dom.d.ts, lib.es5.d.ts): no package
    return d.getSourceFile().isDeclarationFile && /\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(file) && pkg.test('');
  });
}

function decorator(node: ts.HasDecorators, name: string): ts.CallExpression | undefined {
  for (const d of ts.getDecorators(node) ?? []) {
    const e = d.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === name) return e;
  }
  return undefined;
}

/** First argument as a route: a string, or `{ path: '…' }`. */
function routeArg(call: ts.CallExpression): string {
  const a = call.arguments[0];
  if (!a) return '';
  if (ts.isStringLiteralLike(a)) return a.text;
  if (ts.isObjectLiteralExpression(a)) {
    for (const p of a.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'path' && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
    }
  }
  return '';
}

export function joinRoute(prefix: string, path: string): string {
  const parts = [prefix, path].map((p) => trimChar(p, '/')).filter(Boolean);
  return `/${parts.join('/')}`;
}

/** FR-16.5 configuration files read by tools (knex, vite, jest, eslint …), not programs. */
const TOOL_CONFIG = /^(knexfile|.+\.config|\..+rc)\.[cm]?[jt]sx?$/;

/** FR-16.5 project files imported (import / export from / require / import()) by another project file outside tests. */
async function importedFiles(model: TsModel, isTestFile: (file: string) => boolean, slice: () => Promise<void>): Promise<Set<string>> {
  const out = new Set<string>();
  const target = (spec: ts.Expression, from: ts.SourceFile) => {
    if (!ts.isStringLiteralLike(spec)) return;
    const decl = model.checker.getSymbolAtLocation(spec)?.valueDeclaration;
    if (decl && ts.isSourceFile(decl) && decl !== from && !model.isLibraryFile(decl)) out.add(decl.fileName);
  };
  for (const sf of model.program.getSourceFiles()) {
    await slice();
    if (sf.isDeclarationFile || model.isLibraryFile(sf) || isTestFile(model.rel(sf.fileName))) continue;
    const visit = (n: ts.Node): void => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) target(n.moduleSpecifier, sf);
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) target(n.moduleReference.expression, sf);
      else if (ts.isCallExpression(n) && n.arguments.length === 1 && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) target(n.arguments[0], sf);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The call a module-level expression statement runs. */
function moduleLevelCall(e: ts.Expression): ts.CallExpression | undefined {
  let x = skipOuter(e);
  if (ts.isVoidExpression(x) || ts.isAwaitExpression(x)) x = skipOuter(x.expression);
  if (!ts.isCallExpression(x)) return undefined;
  // main().catch(…) / main().then(…)
  if (ts.isPropertyAccessExpression(x.expression) && ['catch', 'then', 'finally'].includes(x.expression.name.text)) {
    const inner = skipOuter(x.expression.expression);
    return ts.isCallExpression(inner) ? inner : undefined;
  }
  return x;
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    // (a method `handler() {}` is no function reference: undefined)
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return skipOuter(p.initializer);
  }
  return undefined;
}

/**
 * The named handler; for an inline lambda the keyed callable that registers the route (the plugin /
 * setup function) — its diagram shows the handler's calls in a callback frame (FR-1.11).
 */
/**
 * FR-16.1 the last argument of `x.get('/path', …)` is a request handler: a function or method reference by its type
 * (call signatures); untyped (`any`) only when it is written as a function or resolves to one. A string, an object
 * or a body (`data`) is not — then `x.get` is an HTTP client call.
 */
function isHandler(model: TsModel, arg: ts.Expression): boolean {
  const e = skipOuter(arg);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  // answered without the type where possible: a type makes the checker resolve the whole call with its (library)
  // generic types — an HTTP client's `api.post('/orders', { body })` looks like a route registration, and resolving its
  // object literal is costly. A literal never has signatures; a function's name always does.
  if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || ts.isLiteralExpression(e) || ts.isTemplateExpression(e)) return false;
  if (namesFunction(model, e)) return true;
  const type = model.checker.getTypeAtLocation(e);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return !!resolveCallable(model, e);
  return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0;
}

/** `handler`, `controller.list`: the name of a method, function or inline-function variable / property (always callable). */
function namesFunction(model: TsModel, e: ts.Expression): boolean {
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
  let symbol = model.checker.getSymbolAtLocation(e);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = model.checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration;
  if (!decl) return false;
  if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isFunctionDeclaration(decl)) return true;
  if (ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl) || ts.isPropertyAssignment(decl)) {
    // typed otherwise (`const h: object = () => …`): its type decides
    if (!ts.isPropertyAssignment(decl) && decl.type && !ts.isFunctionTypeNode(decl.type)) return false;
    const init = decl.initializer && skipOuter(decl.initializer);
    return !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
  }
  return false;
}

function handlerOrRegistrar(model: TsModel, handler: ts.Expression, registration: ts.Node): CallableNode | undefined {
  const named = resolveCallable(model, handler);
  if (named) return named;
  return model.enclosingCallable(registration.getSourceFile(), registration.getStart());
}

/** A function reference (`handler`, `controller.list`, `this.handle`) → its declaration as a keyed callable. */
function resolveCallable(model: TsModel, expr: ts.Expression): CallableNode | undefined {
  let e = skipOuter(expr);
  // handler.bind(x)
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'bind') e = skipOuter(e.expression.expression);
  let symbol = model.checker.getSymbolAtLocation(e); // (of `controller.list`: that of `list`)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = model.checker.getAliasedSymbol(symbol);
  for (const decl of symbol?.declarations ?? []) {
    const callable = model.asCallable(decl);
    if (callable) return callable;
  }
  return undefined;
}
