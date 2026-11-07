import type { EntryPoint, MethodRef, RouteMiddleware, SourceRange } from '@seqcall/protocol';
import { timeSlicer } from '../time-slice';
import { childrenOf, isNestedFunction, nameOf, rangeOf, textOf, type PNode } from './ast';
import type { PhpModel } from './model';
import { scopeOf, shortName, type ClassDecl, type NameScope, type PhpFile } from './project';
import type { PhpContext } from './types';
import { trimChar } from '../text';

/**
 * FR-18.7 entry points of a PHP / Laravel project:
 * - routes: `Route::get|post|put|patch|delete|options|any('uri', action)`, `Route::match([...], …)`,
 *   `Route::resource` / `apiResource`, nested `Route::group(['prefix' => …, 'namespace' => …], fn)` and fluent
 *   `Route::prefix(…)->namespace(…)->group(fn)`; actions `'Ctrl@method'` (group namespace applies, a leading
 *   `\` is absolute), `[Ctrl::class, 'method']`, `['uses' => 'Ctrl@m']`, invokable `Ctrl::class`. Route files
 *   get the prefix / namespace their provider mounts them with
 *   (`Route::prefix('api')->namespace($this->namespace)->group(base_path('routes/api.php'))`);
 * - Artisan commands (`extends …\Console\Command` → `handle`, labelled with the `$signature` name);
 * - queued jobs (`ShouldQueue` / `Dispatchable` → `handle`), event listeners (`app/Listeners` → `handle`);
 * - PHPUnit tests (`test…` methods, `@test`, `#[Test]`) in test files.
 * Closure actions have no method to open and are skipped.
 *
 * FR-18.14 a route's middleware: `->middleware(…)` before or after the verb, the action's `'middleware'` key,
 * enclosing groups (`'middleware' => …`, `Route::middleware(…)->group(…)`, the mount of a route file), minus
 * `withoutMiddleware` / `'excluded_middleware'`; values may be class strings (`X::class`), `Class:param,…` and
 * small same-class helpers returning one (`self::feature('403')`). Aliases (`auth`) stay names here.
 */
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any']);
const RESOURCE_ACTIONS: [string, string, string][] = [
  ['index', 'GET', ''],
  ['create', 'GET', '/create'],
  ['store', 'POST', ''],
  ['show', 'GET', '/{id}'],
  ['edit', 'GET', '/{id}/edit'],
  ['update', 'PUT', '/{id}'],
  ['destroy', 'DELETE', '/{id}'],
];
const API_ACTIONS = new Set(['index', 'store', 'show', 'update', 'destroy']);

interface RouteContext {
  prefix: string;
  namespace: string;
  /** Route-name prefix of the groups (`'as' => 'admin.'`, `->name('admin.')`). */
  as?: string;
  /** FR-18.14 middleware of the enclosing groups, outer first. */
  middleware?: MiddlewareSpec[];
  /** FR-18.14 names the enclosing groups exclude (`withoutMiddleware`). */
  excluded?: string[];
}

/** A middleware value where it is attached, before resolution. */
interface MiddlewareSpec {
  name: string;
  at: SourceRange;
  source: RouteMiddleware['source'];
  /** The value could not be evaluated: `name` is its source text (shown, never split). */
  raw?: boolean;
  /** With `raw`: the part the scan knows, before the `:` (`'if_setting:' . X::KEY` → `if_setting`): resolved. */
  base?: string;
}

const MIDDLEWARE_LINKS = new Set(['middleware', 'withoutmiddleware']);

/** Where a route registration is scanned: its group context, file / class / method, known variable values, its package. */
interface Env extends RouteContext {
  file: PhpFile;
  scope: NameScope;
  cls?: ClassDecl;
  fn?: PNode;
  /** Parameters bound to the values the call site passed (`$version` = '/v1.5'). */
  vars: Map<string, string>;
  /** First-party package of the file (`acme/billing`); undefined = the project. */
  pkg?: string;
  /** Reached from the project's own route registrations (B), not scanned on its own (A). */
  mounted?: boolean;
}

const lower = (s: string) => s.toLowerCase();

/** PHP's string case functions, for route values built with them. */
const CASE_FUNCTIONS: Record<string, (s: string) => string> = {
  lcfirst: (s) => s.charAt(0).toLowerCase() + s.slice(1),
  ucfirst: (s) => s.charAt(0).toUpperCase() + s.slice(1),
  strtolower: (s) => s.toLowerCase(),
  strtoupper: (s) => s.toUpperCase(),
};
const str = (n: PNode | undefined): string | undefined => (n?.kind === 'string' || n?.kind === 'nowdoc' ? String(n.value) : undefined);
const joinUri = (...parts: string[]) => `/${parts.map((p) => trimChar(p, '/')).filter(Boolean).join('/')}`;
const joinNs = (a: string, b: string) => (b.startsWith('\\') ? b.slice(1) : [a, b].filter(Boolean).join('\\'));

/** `Route::x(…)` / `$router->x(…)` (a call): the method name when the receiver is the router. */
function routerCall(n: PNode): string | undefined {
  const what = n.what;
  if (what?.kind === 'staticlookup' && lower(shortName(nameOf(what.what))) === 'route') return lower(nameOf(what.offset));
  if ((what?.kind === 'propertylookup' || what?.kind === 'staticlookup') && what.what?.kind === 'variable' && /^(router|route)$/i.test(String(what.what.name))) return lower(nameOf(what.offset));
  // `$this->router->get(…)` (an injected Registrar / Router)
  if (what?.kind === 'propertylookup' && what.what?.kind === 'propertylookup' && what.what.what?.name === 'this' && /^(router|route)$/i.test(nameOf(what.what.offset))) return lower(nameOf(what.offset));
  // fluent chain: Route::prefix('x')->namespace('Y')->group(…) / ->get(…)
  if (what?.kind === 'propertylookup' && chainRoot(what.what)) return lower(nameOf(what.offset));
  return undefined;
}

/** Is the expression a chain that starts at the router (`Route::prefix('a')->middleware(…)`)? */
function chainRoot(e: PNode | undefined): boolean {
  for (let n = e; n?.kind === 'call'; n = n.what?.what) {
    if (n.what?.kind === 'staticlookup') return lower(shortName(nameOf(n.what.what))) === 'route';
  }
  return false;
}

/**
 * Group options from `['prefix' => 'a', 'namespace' => 'B', 'middleware' => …]` and from a fluent chain before
 * `->group`; `middlewareOf` turns middleware arguments into specs (FR-18.14).
 */
function groupOptions(
  call: PNode,
  ctx: RouteContext,
  resolveValue: (n: PNode) => string | undefined,
  middlewareOf: (args: PNode[], source: RouteMiddleware['source']) => MiddlewareSpec[],
): RouteContext {
  let { prefix, namespace } = ctx;
  let as = ctx.as ?? '';
  const middleware = [...(ctx.middleware ?? [])];
  const excluded = [...(ctx.excluded ?? [])];
  const apply = (key: string | undefined, value: string | undefined) => {
    if (value === undefined) return;
    if (key === 'prefix') prefix = joinUri(prefix, value);
    if (key === 'namespace') namespace = joinNs(namespace, value);
    if (key === 'as' || key === 'name') as += value;
  };
  const applyMiddleware = (key: string, args: PNode[]) => {
    if (key === 'middleware') middleware.push(...middlewareOf(args, 'group'));
    if (key === 'withoutmiddleware' || key === 'excluded_middleware') excluded.push(...middlewareOf(args, 'group').map((m) => m.name));
  };
  const arr = call.arguments?.[0];
  if (arr?.kind === 'array') {
    for (const item of arr.items) {
      if (item.kind !== 'entry') continue;
      const key = str(item.key);
      apply(key, resolveValue(item.value));
      applyMiddleware(lower(key ?? ''), [item.value]);
    }
  }
  // chain links before ->group(): Route::prefix('api')->namespace(...)->middleware(...)
  const links: PNode[] = [];
  for (let n: PNode | undefined = call.what?.what; n?.kind === 'call'; n = n.what?.kind === 'staticlookup' ? undefined : n.what?.what) links.unshift(n);
  for (const link of links) {
    const key = lower(nameOf(link.what?.offset));
    apply(key, link.arguments?.[0] && resolveValue(link.arguments[0]));
    applyMiddleware(key, link.arguments);
  }
  return { prefix, namespace, ...(as ? { as } : {}), ...(middleware.length ? { middleware } : {}), ...(excluded.length ? { excluded } : {}) };
}

/** Array items (`[A::class, 'auth']`) and variadic arguments (`->middleware('a', 'b')`) as single values (the parser's
 * arrays hold no holes: `link` drops them). */
function flatValues(args: PNode[]): PNode[] {
  return args.flatMap((a) => (a.kind === 'array' ? flatValues(a.items.map((i: PNode) => (i.kind === 'entry' ? i.value : i))) : [a]));
}

/** A route whose action could not be found (diagnostics: `php-sweep`, tests). */
export interface MissingRoute {
  route: string;
  file: string;
  controller?: string;
  method?: string;
}

export async function phpEntryPoints(model: PhpModel, isTest: (rel: string) => boolean, onMissing?: (m: MissingRoute) => void): Promise<EntryPoint[]> {
  // gives way between files: the scan must not block the host for seconds on a large project
  const slice = timeSlicer();
  const out: EntryPoint[] = [];
  const seen = new Set<string>();
  const add = (kind: EntryPoint['kind'], method: MethodRef | undefined, label: string, extra: Partial<EntryPoint> = {}) => {
    if (!method?.hasBody) return;
    const id = `${kind}|${label}|${method.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, label, ...extra, method });
  };
  const methodOf = (fqn: string, name: string): MethodRef | undefined => {
    const found = model.types.findMethod(fqn, name);
    return found?.node && found.owner.kind !== 'interface' ? model.methodRef(found.owner, found.node) : undefined;
  };
  const files = model.project.projectFiles();

  // --- route files mounted by providers: base_path('routes/api.php') with prefix / namespace
  const mounts = new Map<string, RouteContext>();
  for (const file of files) {
    await slice();
    for (const cls of file.classes) {
      const valueOf = (n: PNode): string | undefined => {
        const s = str(n);
        if (s !== undefined) return s;
        // $this->namespace → the property's default value
        if (n.kind === 'propertylookup' && n.what?.name === 'this') return str(cls.properties.get(nameOf(n.offset))?.node.value);
        return undefined;
      };
      const middlewareOf = (args: PNode[], source: RouteMiddleware['source']): MiddlewareSpec[] =>
        flatValues(args).flatMap((v) => {
          const name = v.kind === 'staticlookup' && nameOf(v.offset) === 'class' ? model.project.resolveClassName(nameOf(v.what), cls.scope) : valueOf(v);
          return name ? [{ name, at: rangeOf(file.abs, v), source }] : [];
        });
      visitAll(cls.node, (n) => {
        if (n.kind !== 'call' || lower(nameOf(n.what?.offset)) !== 'group' || !chainRoot(n.what?.what)) return;
        const target = routeFileArg(n.arguments?.[0]);
        if (target) mounts.set(target, groupOptions(n, { prefix: '', namespace: '' }, valueOf, middlewareOf));
      });
    }
  }

  // --- routes: the project's route files and classes; calls into first-party packages are followed with the
  // prefix / namespace and argument values of the call site (FR-18.11 B: a package registrar mounted in a group)
  const mountedPackages = new Set<string>();
  const covered = new Set<PNode>();
  const followed = new Set<string>();
  const phpCtx = (env: Env): PhpContext => ({ file: env.file, scope: env.scope, cls: env.cls, callable: env.fn ?? env.file.ast });

  /**
   * A string the scan can know statically: literals, `.` concatenation, known variables / parameter defaults, class
   * constants, property defaults. `cls` (middleware values, FR-18.14): also `X::class` as the class name and a call
   * to a method whose body is one `return <expr>` (`self::feature('403')`), its parameters bound.
   */
  const valueOf = (n: PNode | undefined, env: Env, depth = 0, cls = false): string | undefined => {
    if (!n || depth > 6) return undefined;
    const s = str(n);
    if (s !== undefined) return s;
    if (n.kind === 'bin' && n.type === '.') {
      // a middleware value is a long concatenation (`X::class . ':' . KEY . ',' . $code`): the depth limit is for
      // indirections (constants, parameters, calls), not for the operands of one expression
      const d = cls ? depth : depth + 1;
      const l = valueOf(n.left, env, d, cls);
      const r = valueOf(n.right, env, d, cls);
      return l !== undefined && r !== undefined ? l + r : undefined;
    }
    if (n.kind === 'variable' && typeof n.name === 'string') {
      const known = env.vars.get(n.name);
      if (known !== undefined) return known;
      const param = (env.fn?.arguments ?? []).find((a: PNode) => nameOf(a) === n.name);
      return param?.value ? valueOf(param.value, env, depth + 1, cls) : undefined;
    }
    // `lcfirst(Paths::SHOW)`: PHP's case functions on a known value
    const caseFn = n.kind === 'call' && n.what?.kind === 'name' && n.arguments?.length === 1 ? CASE_FUNCTIONS[lower(nameOf(n.what)).replace(/^\\/, '')] : undefined;
    if (caseFn) {
      const v = valueOf(n.arguments[0], env, depth + 1);
      return v === undefined ? undefined : caseFn(v);
    }
    if (cls && n.kind === 'staticlookup' && nameOf(n.offset) === 'class') return model.types.classRefName(n.what, phpCtx(env));
    if (cls && n.kind === 'call') return returnedValue(n, env, depth);
    if (n.kind === 'staticlookup' && n.offset?.kind === 'identifier' && nameOf(n.offset) !== 'class') {
      const owner = model.types.classRefName(n.what, phpCtx(env));
      return owner ? constantValue(owner, nameOf(n.offset), depth) : undefined;
    }
    // $this->namespace → the property's default value
    if (n.kind === 'propertylookup' && n.what?.name === 'this' && env.cls) return str(env.cls.properties.get(nameOf(n.offset))?.node.value);
    return undefined;
  };
  /** FR-18.14 the value a small helper returns: its body is one `return <expr>`, evaluated with the call's arguments. */
  const returnedValue = (n: PNode, env: Env, depth: number): string | undefined => {
    let found: ReturnType<typeof model.types.calledMethod>;
    try {
      found = model.types.calledMethod(n, phpCtx(env));
      /* v8 ignore start -- no known input throws here (fuzzed); an unknown one leaves this value as written */
    } catch {
      return undefined;
    }
    /* v8 ignore stop */
    if (!found || found === 'helper' || !found.node?.body) return undefined;
    const body: PNode[] = found.node.body.children;
    if (body.length !== 1 || body[0].kind !== 'return' || !body[0].expr) return undefined;
    const calleeEnv: Env = { prefix: '', namespace: '', file: found.owner.file, scope: found.owner.scope, cls: found.owner, fn: found.node, vars: bindParams(found.node, n, env, true) };
    return valueOf(body[0].expr, calleeEnv, depth + 1, true);
  };
  /** The callee's parameters bound to the call's argument values (`registerShopRoutes(Constants::V1_5)` → $version). */
  const bindParams = (callee: PNode, call: PNode, env: Env, cls = false): Map<string, string> => {
    const vars = new Map<string, string>();
    const args: PNode[] = call.arguments;
    callee.arguments.forEach((param: PNode, i: number) => {
      const named = args.find((a) => a.kind === 'namedargument' && nameOf(a) === nameOf(param));
      const arg = named?.value ?? (args[i]?.kind === 'namedargument' ? undefined : args[i]);
      const v = arg ? valueOf(arg, env, 0, cls) : undefined;
      if (v !== undefined) vars.set(nameOf(param), v);
    });
    return vars;
  };
  /** FR-18.14 middleware arguments as specs; a value the scan cannot know keeps its source text (shown, not resolved). */
  const middlewareOf = (args: PNode[], env: Env, source: RouteMiddleware['source']): MiddlewareSpec[] =>
    flatValues(args).map((v) => {
      const name = valueOf(v, env, 0, true);
      if (name !== undefined) return { name, at: rangeOf(env.file.abs, v), source };
      // `Lock::class . ':' . Kind::CASE`, `'lock:' . $key`: the first operand names the middleware
      let first: PNode = v;
      while (first.kind === 'bin' && first.type === '.') first = first.left;
      const base = first === v ? undefined : valueOf(first, env, 0, true)?.split(':')[0];
      return { name: textOf(env.file.src, v), at: rangeOf(env.file.abs, v), source, raw: true, ...(base ? { base } : {}) };
    });
  /**
   * FR-18.14 the HTTP kernel's middleware names (`app/Http/Kernel.php`, a class extending Laravel's HTTP kernel):
   * aliases (`$middlewareAliases`, `$routeMiddleware`: lower-case name → the class), groups (`$middlewareGroups`:
   * lower-case name → its entries, as written) and the global stack (`$middleware`). Read once.
   */
  let kernel: { aliases: Map<string, string>; groups: Map<string, string[]>; global: MiddlewareSpec[] } | undefined;
  const kernelMiddleware = () => {
    if (kernel) return kernel;
    kernel = { aliases: new Map(), groups: new Map(), global: [] };
    for (const cls of files.flatMap((f) => f.classes)) {
      if (!cls.extends.some((e) => lower(e.replace(/^\\/, '')) === 'illuminate\\foundation\\http\\kernel')) continue;
      const env: Env = { prefix: '', namespace: '', file: cls.file, scope: cls.scope, cls, vars: new Map() };
      const entries = (prop: string): PNode[] => {
        const v = cls.properties.get(prop)?.node.value;
        return v?.kind === 'array' ? v.items.filter((i: PNode) => i?.kind === 'entry') : [];
      };
      for (const prop of ['routeMiddleware', 'middlewareAliases']) {
        for (const e of entries(prop)) {
          const alias = str(e.key);
          const target = valueOf(e.value, env, 0, true);
          if (alias && target) kernel.aliases.set(lower(alias), target);
        }
      }
      // the global stack runs before every route's own (`$middleware`: a list)
      kernel.global.push(...middlewareOf(entries('middleware').map((e) => e.value), env, 'global'));
      for (const e of entries('middlewareGroups')) {
        const group = str(e.key);
        if (!group || e.value?.kind !== 'array') continue;
        const members = e.value.items.filter((i: PNode) => i?.kind === 'entry').map((i: PNode) => valueOf(i.value, env, 0, true));
        kernel.groups.set(lower(group), members.filter((m: string | undefined): m is string => !!m));
      }
    }
    return kernel;
  };
  /**
   * A middleware name with a group expanded to its entries and an alias to its class (params kept): `name` as written
   * (a group's entry), `target` what runs, `via` the alias / group written on the route.
   */
  const expandMiddleware = (written: string, depth = 0, via?: string): { name: string; target: string; via?: string }[] => {
    const name = written.replace(/^\\/, '');
    const colon = name.indexOf(':');
    const base = colon >= 0 ? name.slice(0, colon) : name;
    const { aliases, groups } = kernelMiddleware();
    const group = groups.get(lower(name));
    // a group lists aliases, classes and other groups (a cycle stops at the depth)
    if (group && depth < 4) return group.flatMap((m) => expandMiddleware(m, depth + 1, via ?? name));
    const cls = aliases.get(lower(base));
    return [{ name, target: cls ? `${cls.replace(/^\\/, '')}${colon >= 0 ? name.slice(colon) : ''}` : name, ...(via || cls ? { via: via ?? base } : {}) }];
  };
  const handles = new Map<string, MethodRef | undefined>();
  /**
   * FR-18.14 the route's middleware in execution order: groups (outer first), then the route's own; the kernel's groups
   * and aliases expanded; exclusions (by the name written or the class) applied, duplicates dropped.
   */
  const resolveMiddleware = (specs: MiddlewareSpec[], excluded: string[]): RouteMiddleware[] => {
    const strip = (x: string) => x.replace(/^\\/, '');
    const without = new Set(excluded.flatMap((x) => expandMiddleware(x)).flatMap((x) => [x.name, x.target, x.target.split(':')[0]]));
    const seenNames = new Set<string>();
    const out: RouteMiddleware[] = [];
    const expanded = (x: MiddlewareSpec) => {
      if (!x.raw) return expandMiddleware(x.name).map((e) => ({ ...x, ...e }));
      // a value only partly known: its known name resolved (an alias to its class), the params unknown
      const known = x.base ? expandMiddleware(x.base)[0] : undefined;
      return [{ ...x, name: strip(x.name), target: known && !known.target.includes(':') ? known.target : strip(x.name), ...(known?.via ? { via: known.via } : {}) }];
    };
    for (const spec of specs.flatMap(expanded)) {
      const { name, target } = spec;
      const colon = spec.raw ? -1 : target.indexOf(':');
      const base = colon >= 0 ? target.slice(0, colon) : target;
      if (!name || without.has(name) || without.has(target) || without.has(base) || seenNames.has(spec.raw ? name : target)) continue;
      seenNames.add(spec.raw ? name : target);
      // nothing of it known: shown as written
      if (spec.raw && target === name) {
        out.push({ name, at: spec.at, source: spec.source });
        continue;
      }
      if (!handles.has(base)) {
        const ref = methodOf(base, 'handle');
        handles.set(base, ref && !ref.key.startsWith('lib:') ? ref : undefined);
      }
      const method = handles.get(base);
      out.push({
        name,
        ...(method || base.includes('\\') ? { className: base } : {}),
        ...(colon >= 0 ? { params: target.slice(colon + 1).split(',') } : {}),
        ...(method ? { method } : {}),
        at: spec.at,
        source: spec.source,
        ...(spec.via ? { via: spec.via } : {}),
      });
    }
    return out;
  };
  /** `->middleware(…)` / `->withoutMiddleware(…)` links called after a registration (filled top-down by `visit`), in call order. */
  const linksOf = new Map<PNode, PNode[]>();
  /** The route's own middleware (links before and after the verb, the action's `'middleware'` key) merged with the groups'. */
  const routeMiddleware = (n: PNode, a: PNode | undefined, env: Env): RouteMiddleware[] => {
    const below: PNode[] = [];
    for (let l: PNode | undefined = n.what?.what; l?.kind === 'call'; l = l.what?.kind === 'staticlookup' ? undefined : l.what?.what) {
      // every link of a route's chain is a router call: the chain starts at `Route::` (else `n` is no route)
      if (MIDDLEWARE_LINKS.has(routerCall(l)!)) below.unshift(l);
    }
    const specs = [...(env.middleware ?? [])];
    const excluded = [...(env.excluded ?? [])];
    const take = (link: PNode) => {
      const list = middlewareOf(link.arguments, env, 'route');
      if (routerCall(link) === 'middleware') specs.push(...list);
      else excluded.push(...list.map((m) => m.name));
    };
    below.forEach(take);
    const key = a?.kind === 'array' ? a.items.find((i: PNode) => i.kind === 'entry' && str(i.key) === 'middleware') : undefined;
    if (key) specs.push(...middlewareOf([key.value], env, 'route'));
    (linksOf.get(n) ?? []).forEach(take);
    return resolveMiddleware(specs, excluded);
  };
  const constantValue = (fqn: string, name: string, depth: number): string | undefined => {
    for (const c of model.project.ancestors(fqn)) {
      for (const member of childrenOf(c.node)) {
        if (member.kind !== 'classconstant') continue;
        const k = member.constants.find((x: PNode) => nameOf(x) === name);
        if (k) return valueOf(k.value, { prefix: '', namespace: '', file: c.file, scope: c.scope, cls: c, vars: new Map() }, depth + 1);
      }
    }
    return undefined;
  };
  const classOf = (n: PNode | undefined, env: Env): string | undefined => {
    if (!n) return undefined;
    if (n.kind === 'staticlookup' && nameOf(n.offset) === 'class') return model.project.resolveClassName(nameOf(n.what), env.scope);
    // `[$this->coupons_controller, 'show']`: a class-string default (`?string $c = CouponsController::class`), else the property's type
    if (n.kind === 'propertylookup' && n.what?.name === 'this' && env.cls) {
      const prop = model.project.ancestors(env.cls.fqn).map((c) => ({ c, p: c.properties.get(nameOf(n.offset)) })).find((x) => x.p);
      const def = prop?.p?.node.value;
      if (def?.kind === 'staticlookup' && nameOf(def.offset) === 'class') return model.project.resolveClassName(nameOf(def.what), prop!.c.scope);
      return model.types.propertyType(env.cls.fqn, nameOf(n.offset));
    }
    const s = str(n);
    return s !== undefined ? joinNs(env.namespace, s) : undefined;
  };
  /** action → [controller FQN, method] */
  const action = (a: PNode | undefined, env: Env): [string, string] | undefined => {
    if (!a) return undefined;
    // (`'OrderController@' . Paths::SHOW`, `OrderController::class . '@show'`: a string built from known parts; a class
    // named by `::class` is fully qualified already, no group namespace goes before it)
    let first = a;
    while (first.kind === 'bin') first = first.left;
    const qualified = first !== a && first.kind === 'staticlookup' && nameOf(first.offset) === 'class';
    const s = str(a) ?? (a.kind === 'bin' ? valueOf(a, env, 0, true) : undefined);
    if (s !== undefined) {
      const [ctrl, m] = s.split('@');
      return [joinNs(env.namespace, qualified ? `\\${ctrl}` : ctrl), m ?? '__invoke'];
    }
    if (a.kind === 'staticlookup' && nameOf(a.offset) === 'class') return [classOf(a, env)!, '__invoke'];
    if (a.kind === 'array') {
      const items: PNode[] = a.items;
      const uses = items.find((i) => i.kind === 'entry' && str(i.key) === 'uses');
      if (uses) return action(uses.value, env);
      const [first, second] = items.map((i) => (i.kind === 'entry' && !i.key ? i.value : i));
      const ctrl = classOf(first, env);
      const m = valueOf(second, env); // (`[OrderController::class, Paths::STORE]`: a constant names the method)
      if (ctrl && m) return [ctrl, m];
    }
    return undefined;
  };
  /** `Route::post(…)->name('x')->middleware(…)`: the name the chain gives the route, with the groups' prefix. */
  const routeName = (n: PNode, env: Env): string | undefined => {
    for (let p = n.parent; p && (p.kind === 'propertylookup' || p.kind === 'call'); p = p.parent) {
      if (p.kind === 'call' && p.what?.kind === 'propertylookup' && /^(name|as)$/i.test(nameOf(p.what.offset))) {
        const v = valueOf(p.arguments[0], env);
        return v === undefined ? undefined : `${env.as ?? ''}${v}`;
      }
    }
    return undefined;
  };
  /**
   * FR-18.14 controller middleware: `$this->middleware(…)` in the constructor of the action's controller or a base
   * class of it, with `->only(…)` / `->except(…)` (action names) applied. Per controller and action, once.
   */
  const controllerSpecs = new Map<string, MiddlewareSpec[]>();
  const controllerMiddleware = (fqn: string, actionName: string): MiddlewareSpec[] => {
    const key = `${lower(fqn)}@${lower(actionName)}`;
    const known = controllerSpecs.get(key);
    if (known) return known;
    const specs: MiddlewareSpec[] = [];
    for (const cls of model.project.ancestors(fqn).slice().reverse()) {
      const ctor = cls.methods.get('__construct');
      if (!ctor?.body) continue;
      const env: Env = { prefix: '', namespace: '', file: cls.file, scope: cls.scope, cls, fn: ctor, vars: new Map() };
      visitAll(ctor.body, (n) => {
        if (n.kind !== 'call' || n.what?.kind !== 'propertylookup' || n.what.what?.name !== 'this' || lower(nameOf(n.what.offset)) !== 'middleware') return;
        // `->only('index')` / `->except(['logout'])` on the result
        const filter = n.parent?.kind === 'propertylookup' && n.parent.parent?.kind === 'call' ? n.parent.parent : undefined;
        const which = filter ? lower(nameOf(filter.what.offset)) : '';
        const names = filter ? flatValues(filter.arguments).map((v) => lower(valueOf(v, env) ?? '')) : [];
        if (which === 'only' && !names.includes(lower(actionName))) return;
        if (which === 'except' && names.includes(lower(actionName))) return;
        specs.push(...middlewareOf(n.arguments, env, 'controller'));
      });
    }
    controllerSpecs.set(key, specs);
    return specs;
  };
  const route = (verbs: string[], uri: string, a: PNode | undefined, env: Env, name?: string, own: RouteMiddleware[] = []) => {
    const target = action(a, env);
    const path = joinUri(env.prefix, uri);
    const method = target && methodOf(target[0], target[1]);
    // routes without an action exist only for route('name') URLs; closures have no method to open
    if (!method && onMissing && a && a.kind !== 'closure' && a.kind !== 'arrowfunc') onMissing({ route: `${verbs.join('|')} ${path}`, file: env.file.rel, controller: target?.[0], method: target?.[1] });
    if (!target) return;
    // the global stack first, then the route's and its groups', then the controller's (Laravel's order); a name once
    const global = resolveMiddleware(kernelMiddleware().global, []);
    const controller = resolveMiddleware(controllerMiddleware(target[0], target[1]), []);
    const middleware = [...global, ...own];
    for (const m of controller) if (!middleware.some((x) => x.name === m.name && x.className === m.className)) middleware.push(m);
    if (env.pkg && env.mounted) mountedPackages.add(env.pkg);
    const detail = env.pkg ? `route · ${env.pkg.slice(env.pkg.indexOf('/') + 1)}` : 'route';
    for (const verb of verbs) add('http', method, `${verb} ${path}`, { verb, detail, ...(name ? { routeName: name } : {}), ...(middleware.length ? { middleware } : {}) });
  };
  /** A call that is no route registration: into a first-party package method, scanned with this call's context. */
  const follow = (n: PNode, env: Env, depth: number) => {
    if (depth > 5) return;
    let found: ReturnType<typeof model.types.calledMethod>;
    try {
      found = model.types.calledMethod(n, phpCtx(env));
      /* v8 ignore start -- no known input throws here (fuzzed); an unknown one skips this call, not the whole scan */
    } catch {
      return;
    }
    /* v8 ignore stop */
    if (!found || found === 'helper' || !found.node?.body || !found.owner.file.vendor) return;
    const callee = found.node;
    // the callee's parameters take the call's argument values (`registerShopRoutes(Constants::V1_5)` → $version)
    const calleeEnv: Env = {
      prefix: env.prefix,
      namespace: env.namespace,
      ...(env.as ? { as: env.as } : {}),
      ...(env.middleware ? { middleware: env.middleware } : {}),
      ...(env.excluded ? { excluded: env.excluded } : {}),
      file: found.owner.file,
      scope: found.owner.scope,
      cls: found.owner,
      fn: callee,
      vars: bindParams(callee, n, env),
      pkg: model.project.packageOf(found.owner.file),
      mounted: env.mounted,
    };
    const key = `${found.owner.fqn}::${nameOf(callee)}|${env.prefix}|${env.namespace}|${[...calleeEnv.vars].join(',')}`;
    if (followed.has(key)) return;
    followed.add(key);
    covered.add(callee);
    for (const c of childrenOf(callee.body)) visit(c, calleeEnv, depth + 1);
  };
  const visit = (n: PNode, env: Env, depth: number): void => {
    if (n.kind === 'class') {
      const cls = env.file.classes.find((c) => c.node === n);
      if (cls) env = { ...env, cls, scope: cls.scope };
    } else if (n.kind === 'method') env = { ...env, fn: n, vars: new Map() };
    const fn = n.kind === 'call' ? routerCall(n) : undefined;
    if (fn === 'group') {
      const inner = { ...env, ...groupOptions(n, env, (x) => valueOf(x, env), (args, source) => middlewareOf(args, env, source)) };
      const body = n.arguments.find((x: PNode) => x.kind === 'closure' || x.kind === 'arrowfunc');
      // an arrow function's body is the expression itself (`->group(fn () => Route::get(…))`)
      if (body?.kind === 'arrowfunc') visit(body.body, inner, depth);
      else if (body) for (const c of childrenOf(body.body)) visit(c, inner, depth);
      return;
    }
    if (fn && MIDDLEWARE_LINKS.has(fn) && n.what?.kind === 'propertylookup') {
      // FR-18.14 a link after the registration (`Route::post(…)->name(…)->middleware(…)`): kept for the route below it
      for (let r: PNode | undefined = n.what.what; r?.kind === 'call'; r = r.what?.kind === 'staticlookup' ? undefined : r.what?.what) {
        const f = routerCall(r);
        if (f === 'group') break;
        if (f && (VERBS.has(f) || f === 'match' || f === 'resource' || f === 'apiresource')) {
          linksOf.set(r, [n, ...(linksOf.get(r) ?? [])]);
          break;
        }
      }
    }
    if (fn && VERBS.has(fn)) {
      const uri = valueOf(n.arguments?.[0], env);
      if (uri !== undefined) route(fn === 'any' ? ['ANY'] : [fn.toUpperCase()], uri, n.arguments?.[1], env, routeName(n, env), routeMiddleware(n, n.arguments?.[1], env));
    } else if (fn === 'match') {
      const verbs = (n.arguments?.[0]?.items ?? []).map((i: PNode) => str(i.value)?.toUpperCase()).filter(Boolean);
      const uri = valueOf(n.arguments?.[1], env);
      if (uri !== undefined && verbs.length) route(verbs, uri, n.arguments?.[2], env, routeName(n, env), routeMiddleware(n, n.arguments?.[2], env));
    } else if (fn === 'resource' || fn === 'apiresource') {
      const name = valueOf(n.arguments?.[0], env);
      const ctrl = classOf(n.arguments?.[1], env);
      if (name && ctrl) {
        const middleware = routeMiddleware(n, undefined, env);
        for (const [m, verb, suffix] of RESOURCE_ACTIONS) {
          if (fn === 'apiresource' && !API_ACTIONS.has(m)) continue;
          add('http', methodOf(ctrl, m), `${verb} ${joinUri(env.prefix, name)}${suffix}`, { verb, detail: 'resource route', ...(middleware.length ? { middleware } : {}) });
        }
      }
    } else if (!fn && n.kind === 'call') follow(n, env, depth);
    // closures are entered only as group bodies (above); classes and methods are walked, so route
    // registrations inside a provider's methods count too
    for (const c of childrenOf(n)) if (c.kind !== 'closure' && c.kind !== 'arrowfunc') visit(c, env, depth);
  };
  for (const file of files) {
    await slice();
    if (isTest(file.rel)) continue;
    if (!/Route::|\$router->|->router->/i.test(file.src)) continue;
    const mount = mounts.get(file.rel) ?? (file.rel === 'routes/api.php' ? { prefix: '/api', namespace: '' } : { prefix: '', namespace: '' });
    const env: Env = { ...mount, file, scope: file.classes[0]?.scope ?? scopeOfFile(file), vars: new Map(), mounted: true };
    for (const c of file.ast.children) visit(c, env, 0);
  }

  // --- FR-18.11 A: first-party packages that register routes themselves (their own service provider), with the
  // prefix they give; a package the project mounts in its route files contributes only what the project mounts
  await model.project.loadFirstPartyPackagesSliced(slice);
  for (const file of model.project.allFiles()) {
    await slice();
    if (!file.vendor || !/Route::|\$router->|->router->/i.test(file.src)) continue;
    const pkg = model.project.packageOf(file);
    if (!pkg || mountedPackages.has(pkg)) continue;
    for (const cls of file.classes) {
      for (const m of cls.methods.values()) {
        if (covered.has(m) || !m.body || !/Route::|\$router->|->router->/i.test(file.src.slice(m.loc!.start.offset, m.loc!.end.offset))) continue;
        const env: Env = { prefix: '', namespace: '', file, scope: cls.scope, cls, fn: m, vars: new Map(), pkg, mounted: false };
        for (const c of childrenOf(m.body)) visit(c, env, 0);
      }
    }
  }

  // --- commands, jobs, listeners, tests
  for (const cls of model.project.allClasses()) {
    await slice();
    if (cls.kind !== 'class' || cls.isAbstract || cls.file.vendor) continue;
    const test = isTest(cls.file.rel);
    const supers = supertypeNames(model, cls).map(lower);
    if (test) {
      if (!supers.some((s) => /testcase$/.test(s))) continue;
      for (const m of cls.methods.values()) {
        const name = nameOf(m);
        const attr = m.attrGroups.some((g: PNode) => g.attrs.some((a: PNode) => /(^|\\)Test$/.test(nameOf(a))));
        const doc = (m.leadingComments ?? []).some((c: PNode) => /@test\b/.test(String(c.value)));
        if (/^test/i.test(name) || attr || doc) add('test', model.methodRef(cls, m), `${cls.name}.${name}`, { detail: 'PHPUnit' });
      }
      continue;
    }
    if (supers.some((s) => /\\console\\command$|^symfony\\component\\console\\command\\command$/.test(s))) {
      const handle = methodOf(cls.fqn, 'handle') ?? methodOf(cls.fqn, 'execute');
      const signature = str(cls.properties.get('signature')?.node.value) ?? str(cls.properties.get('name')?.node.value);
      if (handle) add('cli', handle, signature ? signature.trim().split(/\s+/)[0] : `${cls.name}.${handle.name}`, { detail: 'Artisan command' });
    } else if (supers.some((s) => /\\shouldqueue$|\\dispatchable$/.test(s)) && cls.methods.has('handle')) {
      add('job', methodOf(cls.fqn, 'handle'), `${cls.name}.handle`, { detail: 'queued job' });
    } else if (/(^|\/)Listeners\//.test(cls.file.rel) && cls.methods.has('handle')) {
      add('handler', methodOf(cls.fqn, 'handle'), `${cls.name}.handle`, { detail: 'event listener' });
    }
  }
  return out;
}

/** Every supertype name of a class (project or library): extends, implements, traits, transitively. */
function supertypeNames(model: PhpModel, cls: ClassDecl): string[] {
  const out = new Set<string>();
  for (const c of model.project.ancestors(cls.fqn)) for (const n of [...c.extends, ...c.implements, ...c.traits]) out.add(n);
  return [...out];
}

/** `base_path('routes/api.php')`, `__DIR__ . '/../routes/web.php'` → 'routes/api.php'. */
function routeFileArg(a: PNode | undefined): string | undefined {
  let found: string | undefined;
  visitAll(a, (n) => {
    const s = str(n);
    const m = s && /(?:^|\/)(routes\/[\w./-]+\.php)$/.exec(s);
    if (m) found = m[1];
  });
  return found;
}

function visitAll(n: PNode | undefined, f: (n: PNode) => void): void {
  if (!n) return;
  f(n);
  for (const c of childrenOf(n)) if (!isNestedFunction(c) || c.kind === 'closure' || c.kind === 'arrowfunc') visitAll(c, f);
}

/** Name scope of a file without classes (a routes file): its `use` statements, in `namespace { }` blocks too. */
function scopeOfFile(file: PhpFile): NameScope {
  const nodes: PNode[] = file.ast.children;
  return scopeOf('', nodes.flatMap((n) => (n.kind === 'namespace' ? [n, ...n.children] : [n])));
}
