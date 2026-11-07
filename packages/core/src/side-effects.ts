import type { ClassRef, MethodRef, SideEffectKind, SideEffects, SourceRange } from '@seqcall/protocol';
import type { CallSite } from './adapter';
import { cutFrom, trimEndChar } from './text';

/**
 * FR-17 side effects: which calls do I/O (database, cache, HTTP, files, queues, cloud SDKs, processes),
 * judged by the library they call into. Everything here works on already analysed call sites —
 * no adapter requests — so the badges cost nothing beyond the analysis the diagram does anyway.
 */
export const SIDE_EFFECT_ORDER: SideEffectKind[] = ['db', 'cache', 'http', 'file', 'queue', 'cloud', 'process'];

export const SIDE_EFFECT_LABEL: Record<SideEffectKind, string> = { db: 'DB', cache: 'CACHE', http: 'HTTP', file: 'FILE', queue: 'MQ', cloud: 'CLOUD', process: 'PROC' };

/** I/O libraries / types by key or library name (C# assemblies / namespaces, npm packages, Node built-ins). */
const PATTERNS: [SideEffectKind, RegExp][] = [
  ['db', /EntityFrameworkCore|\bDbContext\b|\bDapper\b|Npgsql|MySql|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient|MongoDB|Cassandra|Elastic/],
  // a cache / key-value store: a different question than the data itself ("is this cached?", a lock); in-memory caches are no I/O
  ['cache', /StackExchange\.Redis|Microsoft\.Extensions\.Caching\.(Distributed|StackExchangeRedis|SqlServer)|\bIDistributedCache\b|Enyim\.Caching/],
  ['cache', /^lib:(redis|ioredis|@redis\/client|@upstash\/redis|memcached|memjs)\b/],
  ['db', /^lib:(pg|mysql2?|mssql|sqlite3|better-sqlite3|mongodb|mongoose|typeorm|sequelize|knex|@prisma|prisma)\b/],
  ['http', /System\.Net\.Http\b|\bHttpClient\b|RestSharp|Refit|Flurl/],
  ['http', /^lib:(node:)?(http|https|net|dgram)\b/],
  ['http', /^lib:(axios|node-fetch|undici|got|superagent|nodemailer)\b/],
  // the global `fetch` as module facts list it (FR-17.2, no import)
  ['http', /^lib:fetch$/],
  // typed OpenAPI clients: only the request methods, not the setup (`createClient(…)`, `client.use(middleware)`)
  ['http', /^lib:openapi-fetch#\w+\.(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE|request)$/],
  ['http', /^lib:openapi-react-query#\w+\.(queryOptions|useQuery|useSuspenseQuery|useInfiniteQuery|useSuspenseInfiniteQuery|useMutation)$/],
  ['file', /System\.IO\.(File|Directory|FileStream|StreamWriter|StreamReader)\b/],
  ['file', /^lib:(node:)?(fs|fs\/promises)\b/],
  ['queue', /Confluent\.Kafka|RabbitMQ|MassTransit|Azure\.Messaging|NServiceBus/],
  // AMQPNetLite (assembly Amqp.Net): what sends / receives / connects, not building a Message
  ['queue', /\bAmqp\.Net#Amqp\.(SenderLink|ReceiverLink|Connection|ConnectionFactory|Session)\./],
  ['queue', /^lib:(kafkajs|amqplib)\b/],
  ['cloud', /\bAmazon\.|AWSSDK|\bAzure\.(Storage|Data|Cosmos)|Google\.Cloud/],
  ['cloud', /^lib:(@aws-sdk|aws-sdk|@azure|@google-cloud)\b/],
  ['process', /^lib:(node:)?child_process\b/],
  // PHP (FR-18): Laravel facades and clients, Doctrine, PDO, Guzzle, queues, cloud SDKs, built-in functions
  ['db', /^lib:Illuminate\\Support\\Facades\\(DB|Schema)\b|^lib:Illuminate\\Database\\|^lib:Doctrine\\(DBAL|ORM)|^lib:(PDO|PDOStatement|mysqli|MongoDB\\)/],
  // Laravel's injected contracts count like their facades (`Illuminate\Contracts\Redis\Factory` = the `Redis` facade)
  ['cache', /^lib:Illuminate\\Support\\Facades\\(Redis|Cache)\b|^lib:Illuminate\\(Redis|Cache)\\|^lib:Illuminate\\Contracts\\(Redis|Cache)\\|^lib:(Predis\\|Redis#|RedisCluster#|Memcached#)/],
  ['db', /^lib:php#<global>\.(mysqli_\w+|pg_\w+)$/],
  ['http', /^lib:Illuminate\\Support\\Facades\\Http#Http\.(get|post|put|patch|delete|head|send|pool)$|^lib:Illuminate\\Http\\Client\\(PendingRequest|Factory)#\w+\.(get|post|put|patch|delete|head|send|pool)$|^lib:GuzzleHttp\\(Client|ClientInterface)#\w+\.(request|requestAsync|send|sendAsync|get|post|put|patch|delete|head)$/],
  ['http', /^lib:php#<global>\.(curl_exec|curl_multi_exec|fsockopen|stream_socket_client)$/],
  ['file', /^lib:Illuminate\\Support\\Facades\\(Storage|File)\b|^lib:Illuminate\\(Filesystem|Contracts\\Filesystem)\\|^lib:League\\Flysystem\\/],
  ['file', /^lib:php#<global>\.(file_get_contents|file_put_contents|fopen|fwrite|fread|fputcsv|fgetcsv|file|unlink|mkdir|rmdir|rename|copy|scandir|glob|readfile|tempnam|touch)$/],
  // the contracts, not their marker interfaces (`implements ShouldQueue` sends nothing)
  ['queue', /^lib:Illuminate\\Support\\Facades\\(Queue|Bus)\b|^lib:Illuminate\\(Queue|Bus)\\|^lib:Illuminate\\Contracts\\(Queue|Bus)\\(?!Should)|^lib:PhpAmqpLib\\|^lib:Enqueue\\|^lib:php#<global>\.dispatch(_sync)?$/],
  ['cloud', /^lib:Aws\\|^lib:Google\\Cloud\\|^lib:MicrosoftAzure\\/],
  ['process', /^lib:php#<global>\.(exec|shell_exec|system|passthru|proc_open|popen)$|^lib:Symfony\\Component\\Process\\|^lib:Illuminate\\Support\\Facades\\Process\b/],
];

/**
 * An exception / error type of an I/O library (`Illuminate\Database\QueryException`, `DbUpdateException`,
 * `AxiosError`): catching it, testing `instanceof` it or creating it touches no database / network / file.
 */
function isErrorType(name: string): boolean {
  // split always gives at least one part
  const cls = cutFrom(name, '#').split(/[\\./:]/).pop()!;
  return /^[A-Z]\w*(Exception|Error)$/.test(cls);
}

/**
 * Eloquent's `Collection` (what to-many relations and `get()` return) is in memory: `map`, `filter`, `pluck` touch no
 * database — only its lazy eager loading does (`load`, `loadMissing`, `loadCount`, `fresh`…).
 */
const ELOQUENT_COLLECTION = /^(lib:)?Illuminate\\Database\\Eloquent\\Collection\b/;
const ELOQUENT_COLLECTION_IO = /#\w+\.(load\w*|fresh)$/;

/**
 * An Eloquent model's own methods that work on what is loaded (compare, attributes, serialise, relation definitions):
 * `$a->is($b)` compares keys, `$this->hasMany(…)` only builds the relation — no query. Its other methods (`save`,
 * `delete`, `refresh`, static `where` / `find` through the query builder) are DB I/O.
 */
const ELOQUENT_MODEL = /^(lib:)?Illuminate\\Database\\Eloquent\\(Model|SoftDeletes|Concerns\\\w+|Factories\\HasFactory)#\w+\.(\w+)$/;
const ELOQUENT_IN_MEMORY = new Set(
  (
    'is isNot getKey getKeyName getKeyType getQualifiedKeyName getTable getConnectionName getAttribute getAttributes getAttributeValue ' +
    'getOriginal getRawOriginal setAttribute fill forceFill only attributesToArray relationsToArray toArray toJson jsonSerialize ' +
    'isDirty isClean wasChanged getDirty getChanges syncOriginal relationLoaded getRelation getRelations setRelation setRelations ' +
    'unsetRelation withoutRelations makeHidden makeVisible setHidden setVisible getHidden getVisible append setAppends getCasts ' +
    'hasCast getFillable isFillable getForeignKey getRouteKey getRouteKeyName getMorphClass qualifyColumn replicate trashed ' +
    'newInstance newCollection offsetExists offsetGet getIncrementing usesTimestamps getCreatedAtColumn getUpdatedAtColumn ' +
    'hasOne hasMany belongsTo belongsToMany morphTo morphOne morphMany morphToMany morphedByMany hasOneThrough hasManyThrough'
  ).split(' '),
);

/** Kind of I/O a library / type key or a library name ("node:fs", "Microsoft.EntityFrameworkCore") stands for. */
export function ioKindOf(name: string | undefined): SideEffectKind | undefined {
  if (!name) return undefined;
  // the same class / library names are asked again and again
  if (ioKindMemo.has(name)) return ioKindMemo.get(name);
  let kind: SideEffectKind | undefined;
  const model = ELOQUENT_MODEL.exec(name);
  if (ELOQUENT_COLLECTION.test(name)) kind = ELOQUENT_COLLECTION_IO.test(name) ? 'db' : undefined;
  else if (model && ELOQUENT_IN_MEMORY.has(model[3])) kind = undefined;
  else if (!isErrorType(name)) for (const [k, re] of PATTERNS) if (re.test(name) || re.test(`lib:${name}`)) {
    kind = k;
    break;
  }
  if (ioKindMemo.size > 50_000) ioKindMemo.clear();
  ioKindMemo.set(name, kind);
  return kind;
}

/** `ioKindOf` per name (the patterns are fixed, so the answer never changes). */
const ioKindMemo = new Map<string, SideEffectKind | undefined>();

/** A library (npm package, Node module, .NET namespace) that means I/O. */
export function isIoLibrary(name: string): boolean {
  return ioKindOf(name) !== undefined;
}

/** Global `fetch` (lib.dom / @types/node / undici-types). */
const isGlobalFetch = (c: CallSite) => c.methodName === 'fetch' && (c.libraryName === 'lib' || c.libraryName === 'undici-types' || c.libraryName === 'node');

/** Console output: `process.stdout.write` is typed as a `node:net` Socket, but it is not network I/O. */
const CONSOLE_STREAM = /\b(stdout|stderr|stdin)\b|\bConsole\.(Write|WriteLine|ReadLine|Read)\b/;

/**
 * .NET data access (ADO.NET providers, EF Core): most members only build commands, parameters or
 * queries (`AddWithValue`, `CreateCommand`, `Where`, `Add`); only these reach the database.
 */
const DOTNET_DB = /Npgsql|MySql|Microsoft\.Data\.SqlClient|System\.Data\.SqlClient|EntityFrameworkCore|\bDbContext\b/;
const DOTNET_DB_ACTION = /^(Execute\w*|Open\w*|Read\w*|NextResult\w*|Commit\w*|Rollback\w*|BeginTransaction\w*|SaveChanges\w*|ToList\w*|ToArray\w*|ToDictionary\w*|ToHashSet\w*|First\w*|Single\w*|Last\w*|Count\w*|LongCount\w*|Any\w*|All\w*|Sum\w*|Min\w*|Max\w*|Average\w*|Find\w*|Load\w*|AsAsyncEnumerable|ForEach\w*|Query\w*|Bulk\w*)$/;

/**
 * .NET HTTP clients (HttpClient, RestSharp, Flurl): building a request, its headers or body (`new RestRequest(…)`,
 * `AddHeader`, `new StringContent(…)`) sends nothing; only these do.
 */
const DOTNET_HTTP = /System\.Net\.Http\b|RestSharp|Flurl/;
const DOTNET_HTTP_ACTION = /^((Send|Get|Post|Put|Patch|Delete|Head|Options|Download|Upload)(\w*Async)?|Execute\w*)$/;

/** I/O kind of one library call: by its target, its receiver's type, or its library. */
/** A library check (`isCancel(e)`, `axios.isAxiosError(e)`): it inspects a value, it does no I/O. */
export function isCheckCall(c: CallSite): boolean {
  return /^is[A-Z]\w*$/.test(c.methodName);
}

export function ioKindOfCall(c: CallSite): SideEffectKind | undefined {
  if (isCheckCall(c)) return undefined;
  if (!c.isLibrary || CONSOLE_STREAM.test(c.expressionText)) return undefined;
  if (isGlobalFetch(c)) return 'http';
  const kind = ioKindOf(c.target?.key) ?? ioKindOf(c.receiverType?.key) ?? (c.libraryName && c.libraryName !== 'lib' ? ioKindOf(c.libraryName) : undefined);
  // a missing part reads "undefined", which no data-access name matches
  const names = `${c.target?.key} ${c.receiverType?.key} ${c.libraryName}`;
  if (kind === 'db' && DOTNET_DB.test(names) && !DOTNET_DB_ACTION.test(c.methodName)) return undefined;
  if (kind === 'http' && DOTNET_HTTP.test(names) && !DOTNET_HTTP_ACTION.test(c.methodName)) return undefined;
  return kind;
}

/** "HttpClient.GetAsync" for a library call (the key's last type + member), else the call text. */
export function ioCallName(c: CallSite): string {
  if (isGlobalFetch(c)) return 'fetch';
  const key = c.target?.key;
  if (key) {
    const member = cutFrom(key.slice(key.indexOf('#') + 1), '(');
    const parts = member.split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
  }
  if (c.receiverType?.name) return `${c.receiverType.name}.${c.methodName}`;
  return c.expressionText.length > 40 ? `${c.expressionText.slice(0, 39)}…` : c.expressionText;
}

/** One I/O call found in a body: its kind, a short name, and the method it is in when below. */
export interface IoFinding {
  kind: SideEffectKind;
  call: string;
  /** "StripeGateway.charge" when found below the method the badge belongs to. */
  in?: string;
  /**
   * FR-32.1 the object that runs that method (the walk below): its class, or the caller's object for a method it
   * inherits (`ShopClient` running `BaseHttpClient.send`, FR-5.11).
   */
  by?: ClassRef;
  /** Where the call is. */
  at?: SourceRange;
}

/** The calls of a body, including those inside lambdas passed as arguments (they run as part of it). */
export function withLambdaCalls(calls: CallSite[]): CallSite[] {
  const out: CallSite[] = [];
  const visit = (list: CallSite[]) => {
    for (const c of list) {
      out.push(c);
      for (const f of c.argFunctions ?? []) if (f?.kind === 'lambda' && f.calls) visit(f.calls);
    }
  };
  visit(calls);
  return out;
}

/** I/O calls of one body (and its lambdas); `at`: with their places. */
export function directIo(calls: CallSite[], at = false): IoFinding[] {
  const out: IoFinding[] = [];
  for (const c of withLambdaCalls(calls)) {
    const kind = ioKindOfCall(c);
    if (kind) out.push({ kind, call: ioCallName(c), ...(at ? { at: c.range } : {}) });
  }
  return out;
}

/** Bounds of the walk below a collapsed call (levels of bodies below its own) and of one scan. */
export const MAX_IO_DEPTH = 4;
export const MAX_IO_METHODS = 200;
/** Implementations of one interface / abstract member the walk follows (more: what runs is too open to judge). */
export const MAX_IO_IMPLEMENTATIONS = 4;

/**
 * Methods a call runs that the I/O walk follows: a project method with a body, or the implementations of an
 * interface / abstract member (at most MAX_IO_IMPLEMENTATIONS; which one runs is a choice — FR-8, so only the
 * I/O all of them do counts, see ioOfCall). `impls` reads (peek) or requests (scan) implementations.
 */
export function followTargets(c: CallSite, impls: (m: MethodRef) => MethodRef[] | undefined): MethodRef[] {
  const t = c.target;
  if (c.isLibrary || !t) return [];
  if (t.hasBody) return [t];
  const list = impls(t)?.filter((m) => m.hasBody) ?? [];
  return list.length <= MAX_IO_IMPLEMENTATIONS ? list : [];
}

type Peek = (m: MethodRef) => CallSite[] | undefined;
type PeekImpls = (m: MethodRef) => MethodRef[] | undefined;

/** What a walk found below a method, and whether it stopped before the end (a depth or size limit, a body not analysed). */
interface Walked {
  found: IoFinding[];
  cut: boolean;
}
const NOTHING: Walked = { found: [], cut: false };
const merge = (all: Walked[]): Walked => ({ found: all.flatMap((w) => w.found), cut: all.some((w) => w.cut) });

/**
 * The I/O walk over bodies that are already analysed (`peek` never requests anything): project calls are
 * followed through their cached bodies, depth-first, up to MAX_IO_DEPTH levels. A call with several
 * implementations keeps only the I/O kinds every implementation does — whichever runs, that I/O happens
 * (`IShippingApi.CreateCouponAsync`: the parcel client and a second provider's client both do HTTP); an
 * implementation the walk could not follow to its end is not known to lack a kind, so it removes none.
 * FR-32.1 `cuts` collects the methods where the walk stopped (`Class.method`); each finding names the object running
 * its method (`by`): a method with a body called on `this` / `base` runs on the caller's object (an inherited
 * method, FR-5.11), any other on an object of its own class.
 */
function ioWalker(peek: Peek, peekImpls: PeekImpls, rootKey?: string, cuts?: Set<string>) {
  const memo = new Map<string, Walked>();
  const active = new Set<string>(rootKey ? [rootKey] : []);
  let visited = 0;
  const stop = (t: MethodRef): Walked => (cuts?.add(`${t.owner.name}.${t.name}`), { found: [], cut: true });
  const ofMethod = (t: MethodRef, depth: number, by: ClassRef): Walked => {
    if (active.has(t.key)) return NOTHING;
    // the same body run by another object: its findings name that object
    const key = `${t.key}|${by.key}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const body = peek(t);
    if (visited >= MAX_IO_METHODS || !body) return stop(t);
    visited++;
    active.add(t.key);
    const own = directIo(body, true).map((f) => ({ ...f, in: `${t.owner.name}.${t.name}`, by }));
    const rest = depth < MAX_IO_DEPTH ? below(t, depth + 1, by) : withLambdaCalls(body).some((c) => followTargets(c, peekImpls).length) ? stop(t) : NOTHING;
    active.delete(t.key);
    const out = { found: [...own, ...rest.found], cut: rest.cut };
    memo.set(key, out);
    return out;
  };
  const shared = (impls: MethodRef[], depth: number): Walked => {
    // a stub that only throws "not implemented" runs nothing: the others decide
    const real = impls.filter((t) => !isStub(peek(t)));
    const each = real.map((t) => ofMethod(t, depth, t.owner));
    return { found: each.flatMap((e) => e.found).filter((f) => each.every((e) => e.cut || e.found.some((g) => g.kind === f.kind))), cut: each.some((e) => e.cut) };
  };
  /** `by`: the object running the body the call is in (none: the call stands alone, its method's class runs it). */
  const ofCall = (c: CallSite, depth: number, by?: ClassRef): Walked => {
    const targets = followTargets(c, peekImpls);
    // an interface / abstract member called on `this`: the implementation's class runs it
    const self = by && c.target?.hasBody && (c.receiver.kind === 'self' || c.receiver.kind === 'super');
    return targets.length <= 1 || c.target?.hasBody ? merge(targets.map((t) => ofMethod(t, depth, self ? by : t.owner))) : shared(targets, depth);
  };
  const below = (m: MethodRef, depth: number, by: ClassRef): Walked => merge(withLambdaCalls(peek(m) ?? []).map((c) => ofCall(c, depth, by)));
  return { ofCall, below, shared };
}

/**
 * A body that only throws "not implemented" (`throw new NotImplementedException(…)`, `NotSupportedException`):
 * an implementation not written yet. Unknown (not analysed) bodies are no stubs.
 */
export function isStub(body: CallSite[] | undefined): boolean {
  return !!body?.length && body.every((c) => c.kind === 'create' && /^(NotImplemented|NotSupported)(Exception|Error)$/.test(c.receiverType?.name ?? c.target?.owner.name ?? ''));
}

/**
 * I/O in the bodies below `method` (not its own body, which is level 0). `cuts`: where the walk stopped (FR-32.1).
 */
export function ioBelow(method: MethodRef, peek: Peek, peekImpls: PeekImpls, cuts?: Set<string>, by: ClassRef = method.owner): IoFinding[] {
  return ioWalker(peek, peekImpls, method.key, cuts).below(method, 1, by).found;
}

/** I/O of what a call runs: its method's body (level 0, as the scan fetches it) and below, or what all its implementations share. */
export function ioOfCall(c: CallSite, peek: Peek, peekImpls: PeekImpls, cuts?: Set<string>, by?: ClassRef): IoFinding[] {
  return ioWalker(peek, peekImpls, undefined, cuts).ofCall(c, 0, by).found;
}

/** I/O of interface implementations a call may run (none chosen; their bodies are level 0): the kinds all of them do. */
export function ioOfImplementations(impls: MethodRef[], peek: Peek, peekImpls: PeekImpls, cuts?: Set<string>): IoFinding[] {
  if (!impls.length || impls.length > MAX_IO_IMPLEMENTATIONS) return [];
  return ioWalker(peek, peekImpls, undefined, cuts).shared(impls.filter((t) => t.hasBody), 0).found;
}

/**
 * Badge data from findings: kinds in a fixed order and a few evidence lines, one per kind and
 * method (`DB: NpgsqlDataSource.CreateCommand, NpgsqlCommand.ExecuteReaderAsync (in BaseDataAccess.ExecuteReaderAsync)`).
 */
export function toSideEffects(own: IoFinding[], below: IoFinding[] = []): SideEffects | undefined {
  const all = [...own, ...below];
  if (!all.length) return undefined;
  const kinds = SIDE_EFFECT_ORDER.filter((k) => all.some((f) => f.kind === k));
  const groups = new Map<string, { f: IoFinding; calls: string[] }>();
  for (const f of all) {
    const key = `${f.kind}|${f.in ?? ''}`;
    const g = groups.get(key) ?? groups.set(key, { f, calls: [] }).get(key)!;
    if (!g.calls.includes(f.call)) g.calls.push(f.call);
  }
  const lines = [...groups.values()].map(({ f, calls }) =>
    `${SIDE_EFFECT_LABEL[f.kind]}: ${calls.slice(0, 2).join(', ')}${calls.length > 2 ? ', …' : ''}${f.in ? ` (in ${f.in})` : ''}`,
  );
  const evidence = lines.length > 4 ? [...lines.slice(0, 4), `… +${lines.length - 4} more`] : lines;
  return { kinds, evidence, ...(own.length ? {} : { below: true }) };
}

/**
 * FR-29.10 the I/O clients a file's libraries stand for: the kind and the technology the pattern recognised
 * (`Npgsql`, `Confluent.Kafka`, `@aws-sdk`, `axios`, a Laravel facade) — once per client.
 */
export function libraryClients(libraries: string[]): { kind: SideEffectKind; client: string }[] {
  const out = new Map<string, { kind: SideEffectKind; client: string }>();
  for (const l of libraries) {
    const kind = ioKindOf(l);
    if (!kind) continue;
    let match: string | undefined;
    for (const [k, re] of PATTERNS) {
      if (k !== kind) continue;
      match = re.exec(l)?.[0] ?? re.exec(`lib:${l}`)?.[0];
      if (match) break;
    }
    // ioKindOf gave `kind` because a pattern of that kind matched `l` or `lib:${l}` (an Eloquent Collection's lazy loading
    // too: the Illuminate\Database pattern), so one matches here; every pattern's match keeps a name before its `#`
    const client = trimEndChar(cutFrom(match!.replace(/^lib:/, ''), '#'), '.\\').trim();
    out.set(`${kind}|${client}`, { kind, client });
  }
  return [...out.values()];
}

/** Participant badge from the libraries its whole file / type uses (FR-7.7 module facts). */
export function libraryIo(libraries: string[]): SideEffects | undefined {
  const found = libraries.flatMap((l) => {
    const kind = ioKindOf(l);
    return kind ? [{ kind, call: `uses ${l}` }] : [];
  });
  return toSideEffects(found);
}
