import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MethodRef, SequenceDiagram } from '@seqcall/protocol';
import type { CallSite } from '../src/adapter';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { directIo, ioBelow, ioCallName, ioKindOf, ioKindOfCall, ioOfCall, ioOfImplementations, isIoLibrary, isStub, libraryClients, libraryIo, MAX_IO_METHODS, toSideEffects } from '../src/side-effects';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { viewText } from '../src/flow-text';

const ROOT = path.resolve(__dirname, '../../../fixtures/io-app').replace(/\\/g, '/');
const adapter = createTsAdapter(ROOT);
afterAll(() => adapter.dispose());

const session = (options: Record<string, boolean> = {}) =>
  new DiagramSession({ adapter, classifier: createClassifier(ROOT), initialState: { options: { showArguments: true, maxArgumentLength: 30, showLibraryCalls: false, followCursor: false, ...options } } });
const CONTROLLER = 'src/controllers/note-controller.ts#NoteController';
const open = (s: DiagramSession, method: string) => s.openMethodByKey(`${CONTROLLER}.${method}`) as Promise<SequenceDiagram>;
const msg = (d: SequenceDiagram, name: string) => d.messages.find((m) => m.methodName === name)!;

/** A library call site as an adapter reports it. */
const lib = (key: string, expressionText = 'x.f()', extra: Partial<CallSite> = {}): CallSite => ({
  ordinal: 0,
  kind: 'call',
  range: { file: '/f', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  methodName: key.replace(/\(.*$/, '').slice(key.replace(/\(.*$/, '').lastIndexOf('.') + 1), // strip the parameters first
  expressionText,
  args: [],
  receiver: { kind: 'expression', text: 'x' },
  target: { key, name: 'f', owner: { key: key.slice(0, key.indexOf('#')), name: 'x', kind: 'external' }, isStatic: false, hasBody: false },
  isAsync: false,
  isLibrary: true,
  ...extra,
});

describe('FR-17 side-effect badges', () => {
  it('FR-17.1 library calls are classified by target, receiver type or library (C# and TS keys)', () => {
    expect(ioKindOfCall(lib('lib:Microsoft.EntityFrameworkCore#Microsoft.EntityFrameworkCore.DbContext.SaveChangesAsync(System.Threading.CancellationToken)'))).toBe('db');
    expect(ioKindOfCall(lib('lib:Npgsql#Npgsql.NpgsqlCommand.ExecuteReaderAsync(System.Threading.CancellationToken)'))).toBe('db');
    expect(ioKindOfCall(lib('lib:System.Net.Http#System.Net.Http.HttpClient.GetAsync(System.String)'))).toBe('http');
    expect(ioKindOfCall(lib('lib:System.Runtime#System.IO.File.ReadAllText(System.String)'))).toBe('file');
    expect(ioKindOfCall(lib('lib:Confluent.Kafka#Confluent.Kafka.IProducer`2.ProduceAsync(…)'))).toBe('queue');
    // FR-17 AMQPNetLite: sending on a link is MQ; building the message is not
    expect(ioKindOfCall(lib('lib:Amqp.Net#Amqp.SenderLink.SendAsync(Amqp.Message)'))).toBe('queue');
    expect(ioKindOfCall(lib('lib:Amqp.Net#Amqp.Message.Message(System.Object)'))).toBeUndefined();
    expect(ioKindOfCall(lib('lib:node:fs/promises#<module>.readFile'))).toBe('file');
    expect(ioKindOfCall(lib('lib:axios#AxiosInstance.get'))).toBe('http');
    expect(ioKindOfCall(lib('lib:node:child_process#<module>.execFileSync'))).toBe('process');
    expect(ioKindOfCall(lib('lib:lib#<global>.fetch', 'fetch(url)', { libraryName: 'lib', methodName: 'fetch' }))).toBe('http');
    // not I/O: a status code enum, console streams (typed as node:net sockets), project calls
    expect(ioKindOfCall(lib('lib:System.Net.Primitives#System.Net.HttpStatusCode.ToString()'))).toBeUndefined();
    expect(ioKindOfCall(lib('lib:node:net#Socket.write', 'process.stdout.write(text)'))).toBeUndefined();
    expect(ioKindOfCall({ ...lib('lib:node:fs#<module>.readFile'), isLibrary: false })).toBeUndefined();
    expect(isIoLibrary('System.Net.HttpStatusCode')).toBe(false);
    expect(isIoLibrary('System.Net.Http')).toBe(true);
  });

  it('FR-17.1 .NET HTTP clients: sending is HTTP, building the request (its headers, body, the client) is not', () => {
    for (const k of [
      'lib:System.Net.Http#System.Net.Http.HttpClient.SendAsync(System.Net.Http.HttpRequestMessage)',
      'lib:System.Net.Http#System.Net.Http.HttpClient.Send(System.Net.Http.HttpRequestMessage)',
      'lib:System.Net.Http.Json#System.Net.Http.Json.HttpClientJsonExtensions.PostAsJsonAsync(System.Net.Http.HttpClient, System.String, T)',
      'lib:RestSharp#RestSharp.RestClient.ExecuteAsync(RestSharp.RestRequest, System.Threading.CancellationToken)',
      'lib:RestSharp#RestSharp.RestClientExtensions.GetJsonAsync(RestSharp.IRestClient, System.String)',
      'lib:Flurl.Http#Flurl.Http.GeneratedExtensions.GetJsonAsync(System.String)',
    ]) {
      expect(ioKindOfCall(lib(k)), k).toBe('http');
    }
    for (const k of [
      'lib:RestSharp#RestSharp.RestRequest..ctor(System.String, RestSharp.Method)',
      'lib:RestSharp#RestSharp.RestRequestExtensions.AddHeaders(RestSharp.RestRequest, System.Collections.Generic.ICollection)',
      'lib:RestSharp#RestSharp.RestRequestExtensions.AddStringBody(RestSharp.RestRequest, System.String, System.String)',
      'lib:System.Net.Http#System.Net.Http.StringContent..ctor(System.String)',
      'lib:System.Net.Http#System.Net.Http.Headers.HttpHeaders.GetValues(System.String)',
      'lib:System.Net.Http#System.Net.Http.HttpResponseMessage.EnsureSuccessStatusCode()',
      'lib:Flurl.Http#Flurl.Http.GeneratedExtensions.WithHeader(System.String, System.String, System.Object)',
    ]) {
      expect(ioKindOfCall(lib(k)), k).toBeUndefined();
    }
    // other ecosystems keep their names (axios' `get`)
    expect(ioKindOfCall(lib('lib:axios#AxiosInstance.get'))).toBe('http');
  });

  it('FR-17.1 typed OpenAPI clients: the request methods are HTTP, their setup is not (a React front end)', () => {
    const at = (key: string) => ({ ...lib(key), libraryName: key.slice(4, key.indexOf('#')), receiverType: { key: key.slice(0, key.indexOf('#')), name: key.slice(4, key.indexOf('#')), kind: 'external' as const } });
    for (const k of ['lib:openapi-react-query#OpenapiQueryClient.queryOptions', 'lib:openapi-react-query#OpenapiQueryClient.useMutation', 'lib:openapi-react-query#OpenapiQueryClient.useSuspenseQuery', 'lib:openapi-fetch#Client.GET', 'lib:openapi-fetch#Client.POST']) {
      expect(ioKindOfCall(at(k)), k).toBe('http');
    }
    for (const k of ['lib:openapi-react-query#<module>.createClient', 'lib:openapi-fetch#<module>.createFetchClient', 'lib:openapi-fetch#Client.use', 'lib:openapi-fetch#Client.eject']) {
      expect(ioKindOfCall(at(k)), k).toBeUndefined();
    }
  });

  it('FR-17.8 a cache / key-value store is CACHE, not DB; in-memory caches are no I/O', () => {
    expect(ioKindOfCall(lib('lib:StackExchange.Redis#StackExchange.Redis.IDatabase.StringGetAsync(StackExchange.Redis.RedisKey)'))).toBe('cache');
    expect(ioKindOfCall(lib('lib:Microsoft.Extensions.Caching.Abstractions#Microsoft.Extensions.Caching.Distributed.IDistributedCache.GetAsync(System.String)'))).toBe('cache');
    expect(ioKindOfCall(lib('lib:Microsoft.Extensions.Caching.Abstractions#Microsoft.Extensions.Caching.Memory.IMemoryCache.TryGetValue(System.Object)'))).toBeUndefined();
    expect(ioKindOfCall(lib('lib:ioredis#Redis.get'))).toBe('cache');
    expect(ioKindOfCall(lib('lib:redis#RedisClientType.set'))).toBe('cache');
    expect(ioKindOfCall(lib('lib:mongodb#Collection.find'))).toBe('db');
    // PHP: facades, the helper's manager, injected contracts, Predis, the extension's class
    for (const k of ['lib:Illuminate\\Support\\Facades\\Redis#Redis.get', 'lib:Illuminate\\Support\\Facades\\Cache#Cache.remember', 'lib:Illuminate\\Cache\\CacheManager#CacheManager.get', 'lib:Illuminate\\Contracts\\Redis\\Factory#Factory.connection', 'lib:Illuminate\\Contracts\\Cache\\Lock#Lock.get', 'lib:Predis\\Client#Client.get', 'lib:Redis#Redis.get']) {
      expect(ioKindOfCall(lib(k)), k).toBe('cache');
    }
    expect(ioKindOfCall(lib('lib:Illuminate\\Support\\Facades\\DB#DB.table'))).toBe('db');
    expect(libraryClients(['Illuminate\\Contracts\\Redis\\Factory', 'StackExchange.Redis', 'ioredis'])).toEqual([
      { kind: 'cache', client: 'Illuminate\\Contracts\\Redis' },
      { kind: 'cache', client: 'StackExchange.Redis' },
      { kind: 'cache', client: 'ioredis' },
    ]);
  });

  it('FR-18.5 Laravel\'s injected contracts count like their facades: queue / bus MQ, filesystem FILE', () => {
    expect(ioKindOfCall(lib('lib:Illuminate\\Contracts\\Queue\\Queue#Queue.push'))).toBe('queue');
    expect(ioKindOfCall(lib('lib:Illuminate\\Contracts\\Bus\\Dispatcher#Dispatcher.dispatch'))).toBe('queue');
    expect(ioKindOfCall(lib('lib:Illuminate\\Contracts\\Filesystem\\Filesystem#Filesystem.put'))).toBe('file');
    // marker interfaces and other contracts are no I/O
    expect(isIoLibrary('Illuminate\\Contracts\\Queue\\ShouldQueue')).toBe(false);
    expect(libraryIo(['Illuminate\\Contracts\\Queue\\ShouldBeUnique'])).toBeUndefined();
    expect(ioKindOfCall(lib('lib:Illuminate\\Contracts\\Config\\Repository#Repository.get'))).toBeUndefined();
  });

  it('FR-17.2 exception / error types of I/O libraries are no I/O (catching or checking them touches no database)', () => {
    // Laravel apps: an exception handler's `instanceof QueryException` showed a DB badge
    expect(libraryIo(['Illuminate\\Database\\QueryException', 'Illuminate\\Support\\Facades\\Log'])).toBeUndefined();
    expect(isIoLibrary('Microsoft.EntityFrameworkCore.DbUpdateException')).toBe(false);
    expect(isIoLibrary('lib:Illuminate\\Database\\QueryException#QueryException.constructor')).toBe(false);
    expect(isIoLibrary('lib:GuzzleHttp\\Exception\\RequestException')).toBe(false);
    // the libraries themselves still are
    expect(libraryIo(['Illuminate\\Database\\Eloquent\\Model'])?.kinds).toEqual(['db']);
    expect(isIoLibrary('Microsoft.EntityFrameworkCore')).toBe(true);
    expect(isIoLibrary('lib:Illuminate\\Support\\Facades\\DB#DB.table')).toBe(true);
  });

  it('FR-29.10 the I/O clients of a file: the technology the pattern recognised, once each; no client for non-I/O libraries', () => {
    expect(libraryClients(['Microsoft.EntityFrameworkCore', 'Microsoft.EntityFrameworkCore.Storage', 'Npgsql', 'System.Linq', 'Confluent.Kafka'])).toEqual([
      { kind: 'db', client: 'EntityFrameworkCore' },
      { kind: 'db', client: 'Npgsql' },
      { kind: 'queue', client: 'Confluent.Kafka' },
    ]);
    expect(libraryClients(['axios', 'node:fs/promises', '@aws-sdk/client-s3', 'lodash'])).toEqual([
      { kind: 'http', client: 'axios' },
      { kind: 'file', client: 'node:fs' },
      { kind: 'cloud', client: '@aws-sdk' },
    ]);
    expect(libraryClients(['Illuminate\\Support\\Facades\\DB'])).toEqual([{ kind: 'db', client: 'Illuminate\\Support\\Facades\\DB' }]);
  });

  it('FR-17.2 an Eloquent Collection is in memory: only its lazy eager loading is DB I/O', () => {
    // a Laravel repository: `$game->details->map(…)` on eager-loaded models made a false "I/O in a loop"
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Collection#Collection.map')).toBe(false);
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Collection')).toBe(false);
    expect(libraryIo(['Illuminate\\Database\\Eloquent\\Collection'])).toBeUndefined();
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Collection#Collection.load')).toBe(true);
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Collection#Collection.loadMissing')).toBe(true);
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Collection#Collection.fresh')).toBe(true);
    // the rest of Eloquent still is
    expect(isIoLibrary('lib:Illuminate\\Database\\Eloquent\\Builder#Builder.get')).toBe(true);
  });

  it('FR-17.2 an Eloquent model works on what is loaded: comparing, attributes, serialising, relation definitions are no I/O', () => {
    // `$a->is($b)` compares keys, table and connection: a false "I/O in Domain" on a domain service comparing two rows
    for (const key of ['Model#Model.is', 'Model#Model.isNot', 'Model#Model.getKey', 'Model#Model.toArray', 'Concerns\\HasAttributes#HasAttributes.getAttribute', 'Concerns\\HasRelationships#HasRelationships.hasMany', 'Factories\\HasFactory#HasFactory.is', 'SoftDeletes#SoftDeletes.trashed']) {
      expect([key, isIoLibrary(`lib:Illuminate\\Database\\Eloquent\\${key}`)]).toEqual([key, false]);
    }
    // what reaches the database still is, and so are the other Eloquent classes
    for (const key of ['Model#Model.save', 'Model#Model.delete', 'Model#Model.refresh', 'Model#Model.where', 'Model', 'Builder#Builder.is', 'Relations\\HasMany#HasMany.getKey']) {
      expect([key, isIoLibrary(`lib:Illuminate\\Database\\Eloquent\\${key}`)]).toEqual([key, true]);
    }
  });

  it('FR-17.1 a call is marked with the I/O of its own body (hidden library calls), with the evidence', async () => {
    const s = session();
    let d = await open(s, 'show');
    // load's body only calls the adapter; the adapter's body is not analysed yet: nothing known
    expect(msg(d, 'load').sideEffects).toBeUndefined();
    d = (await s.expand(msg(d, 'load').id))!;
    expect(msg(d, 'read').sideEffects).toEqual({ kinds: ['file'], evidence: ['FILE: fs/promises.readFile'] });
    expect(msg(d, 'shout').sideEffects).toBeUndefined(); // process.stdout.write is console output
    const share = await open(s, 'share');
    // its own fetch, plus the file read below load (analysed when load was expanded above)
    expect(msg(share, 'publish').sideEffects?.kinds).toEqual(['http', 'file']);
    expect(msg(share, 'publish').sideEffects?.below).toBeUndefined();
    expect(msg(share, 'publish').sideEffects?.evidence).toEqual(['HTTP: fetch', 'FILE: fs/promises.readFile (in FileNotes.read)']);
  });

  it('FR-17.1 a collapsed call also shows the I/O of already analysed calls below it (dashed: below)', async () => {
    const s = session();
    let d = await open(s, 'show');
    d = (await s.expand(msg(d, 'load').id))!;
    d = (await s.collapse(msg(d, 'load').id))!;
    expect(msg(d, 'load').sideEffects).toEqual({ kinds: ['file'], evidence: ['FILE: fs/promises.readFile (in FileNotes.read)'], below: true });
    // expanded: the call below carries the badge, not the expanded call
    d = (await s.expand(msg(d, 'load').id))!;
    expect(msg(d, 'load').sideEffects).toBeUndefined();
    expect(msg(d, 'read').sideEffects?.kinds).toEqual(['file']);
  });

  it('FR-17.1 with library calls shown, the library call carries the badge and the expanded caller does not', async () => {
    const s = session({ showLibraryCalls: true });
    let d = await open(s, 'show');
    d = (await s.expand(msg(d, 'load').id))!;
    d = (await s.expand(msg(d, 'read').id))!;
    expect(msg(d, 'read').sideEffects).toBeUndefined();
    expect(msg(d, 'readFile')).toMatchObject({ isLibrary: true, sideEffects: { kinds: ['file'] } });
  });

  it('FR-17.2 a participant shows the I/O libraries of its whole file', async () => {
    const s = session();
    let d = await open(s, 'show');
    d = (await s.expand(msg(d, 'load').id))!;
    const p = (name: string) => d.participants.find((x) => x.className === name)!;
    expect(p('FileNotes').sideEffects).toEqual({ kinds: ['file'], evidence: ['FILE: uses node:fs/promises'] });
    // the global fetch, no import: listed as the library `fetch` (FR-17.2, since the delegating adapters of FR-7.10)
    expect(p('NoteService').sideEffects).toEqual({ kinds: ['http'], evidence: ['HTTP: uses fetch'] });
    expect(p('NoteController').sideEffects).toBeUndefined();
  });

  it('FR-7.10 a port implementation whose held client calls the global fetch is an adapter (end to end)', async () => {
    const s = session();
    const d = (await s.openMethodByKey('src/adapters/http-quotes.ts#HttpQuotes.latest'))!;
    const box = d.participants.find((x) => x.className === 'HttpQuotes')!;
    expect(box.stereotypes).toContain('adapter');
    expect(box.stereotypeReasons).toContainEqual({ stereotype: 'adapter', text: 'implements `QuoteSource` and does HTTP through `QuoteClient`' });
    expect(d.participants.find((x) => x.className === 'QuoteClient')?.stereotypes ?? []).not.toContain('adapter');
  });

  it('FR-17.2 class boxes carry the same I/O badges as their participants; off with showSideEffects=false', async () => {
    const s = session();
    let d = await open(s, 'show');
    d = (await s.expand(msg(d, 'load').id))!;
    const cls = async (name: string) => (await s.getClassDiagram())!.classes.find((c) => c.name === name)!;
    expect((await cls('FileNotes')).sideEffects).toEqual({ kinds: ['file'], evidence: ['FILE: uses node:fs/promises'] });
    expect((await cls('NoteController')).sideEffects).toBeUndefined();
    await s.setOption('showSideEffects', false);
    expect((await cls('FileNotes')).sideEffects).toBeUndefined();
  });

  it('FR-17.4 the option showSideEffects=false removes every badge', async () => {
    const s = session();
    let d = await open(s, 'show');
    d = (await s.expand(msg(d, 'load').id))!;
    d = (await s.setOption('showSideEffects', false))!;
    expect(d.messages.some((m) => m.sideEffects)).toBe(false);
    expect(d.participants.some((p) => p.sideEffects)).toBe(false);
  });

  it('FR-17.3 Smart expand counts I/O as a reason to look at a call', async () => {
    const s = session();
    await open(s, 'share');
    const d = (await s.smartExpand())!;
    expect(msg(d, 'publish').importance?.reasons).toContain('↑ does I/O: HTTP');
  });

  it('FR-17.3 Smart expand opens the path to I/O further down, through a port (a hexagonal TS backend: handler → repository port → API client)', async () => {
    // archive → run → keep → NoteStore.write (port) → FileNotes.write → writeFile: the I/O is three bodies below `run`
    const s = session();
    await open(s, 'archive');
    await s.scanSideEffects();
    const d = (await s.smartExpand())!;
    expect(msg(d, 'run').expanded).toBe(true);
    expect(msg(d, 'keep').expanded).toBe(true);
    expect(msg(d, 'write').sideEffects?.kinds).toEqual(['file']);
    expect(msg(d, 'keep').importance?.reasons).toContain('↑ reveals write');
  });

  it('FR-17.5 the background scan analyses below collapsed calls, through a port with one implementation', async () => {
    const s = session();
    const d = await open(s, 'archive');
    expect(msg(d, 'run').sideEffects).toBeUndefined(); // run → keep → NoteStore.write: not analysed yet
    const scanned = (await s.scanSideEffects())!;
    expect(msg(scanned, 'run').sideEffects).toEqual({ kinds: ['file'], evidence: ['FILE: fs/promises.writeFile (in FileNotes.write)'], below: true });
    expect(s.current()).toBe(scanned);
    // everything below is analysed now: a second scan changes nothing
    expect(await s.scanSideEffects()).toBeUndefined();
  });

  it('FR-17.6 a port with several implementations shows the I/O all of them do (whichever runs, it happens); stubs that only throw are left out', async () => {
    const s = session();
    const alerter = 'src/services/alerter.ts#Alerter';
    await s.openMethodByKey(`${alerter}.alert`);
    let d = (await s.scanSideEffects()) ?? s.current()!;
    // no implementation chosen: Slack and Mail both fetch → HTTP (Pager only throws "not implemented": left out);
    // only FileAuditLog writes a file → nothing
    expect(msg(d, 'notify').sideEffects?.kinds).toEqual(['http']);
    expect([...msg(d, 'notify').sideEffects!.evidence].sort()).toEqual(['HTTP: fetch (in MailNotifier.notify)', 'HTTP: fetch (in SlackNotifier.notify)']);
    expect(msg(d, 'record').sideEffects).toBeUndefined();
    // a collapsed caller: the same rule below it
    const t = session();
    await t.openMethodByKey(`${alerter}.escalate`);
    d = (await t.scanSideEffects()) ?? t.current()!;
    expect(msg(d, 'alert').sideEffects).toMatchObject({ kinds: ['http'], below: true });
  });

  it('FR-17.5 a stub only throws "not implemented"; unknown bodies are no stubs', () => {
    const create = (name: string): CallSite => ({ ...lib(`lib:x#${name}..ctor`, `new ${name}()`), kind: 'create', methodName: 'constructor', receiverType: { key: `lib:x#${name}`, name, kind: 'external' } });
    expect(isStub([create('NotImplementedException')])).toBe(true);
    expect(isStub([create('NotSupportedException')])).toBe(true);
    expect(isStub([create('NotImplementedException'), lib('lib:System.Net.Http#HttpClient.GetAsync(string)')])).toBe(false);
    expect(isStub([create('InvalidOperationException')])).toBe(false);
    expect(isStub([])).toBe(false);
    expect(isStub(undefined)).toBe(false);
  });

  it('FR-25.4 Copy as text waits for the I/O scan running now: no "none found" for the I/O below a folded call', async () => {
    const s = session();
    await s.ioScanned(); // no scan yet: resolves at once
    const d = await open(s, 'archive');
    expect(viewText(ROOT, d)).toContain('I/O: none found in the shown calls'); // before the scan looked below run
    void s.scanSideEffects();
    await s.ioScanned();
    const text = viewText(ROOT, s.current()!);
    expect(text).not.toContain('I/O: none found');
    expect(text).toMatch(/\nI\/O \(1;.*\n.*FILE.*run/);
  });

  it('FR-17.5 a scan is dropped when the diagram changed meanwhile (the newer render wins)', async () => {
    const s = session();
    const d = await open(s, 'archive');
    const scan = s.scanSideEffects();
    const expanded = (await s.expand(msg(d, 'run').id))!;
    expect(await scan).toBeUndefined();
    expect(s.current()).toBe(expanded);
  });

  it('FR-17.5 scanSideEffects=false (or I/O off) skips the scan', async () => {
    const s = session({ scanSideEffects: false });
    await open(s, 'archive');
    expect(await s.scanSideEffects()).toBeUndefined();
    expect(msg(s.current()!, 'run').sideEffects).toBeUndefined();
    const off = session({ showSideEffects: false });
    await open(off, 'archive');
    expect(await off.scanSideEffects()).toBeUndefined();
  });

  it('FR-17.5 evidence is one line per kind and method, at most two calls each', () => {
    const effects = toSideEffects([], [
      { kind: 'db', call: 'NpgsqlDataSource.CreateCommand', in: 'Base.Read' },
      { kind: 'db', call: 'NpgsqlCommand.ExecuteReaderAsync', in: 'Base.Read' },
      { kind: 'db', call: 'NpgsqlParameterCollection.AddWithValue', in: 'Base.Read' },
      { kind: 'http', call: 'RestClient.ExecuteAsync', in: 'MapsApi.Create' },
    ]);
    expect(effects).toEqual({
      kinds: ['db', 'http'],
      evidence: ['DB: NpgsqlDataSource.CreateCommand, NpgsqlCommand.ExecuteReaderAsync, … (in Base.Read)', 'HTTP: RestClient.ExecuteAsync (in MapsApi.Create)'],
      below: true,
    });
  });
});

describe('I/O badges and hidden calls (FR-17, FR-11)', () => {
  it('FR-17 an expanded call keeps the I/O of the calls hidden under it; unhidden, the child carries it again', async () => {
    const s = session();
    await s.openMethodByKey(`${CONTROLLER}.archive`);
    const run = s.current()!.messages.find((m) => m.methodName === 'run')!;
    await s.expand(run.id);
    await s.scanSideEffects();
    const badge = (name: string) => s.current()!.messages.find((m) => m.methodName === name)?.sideEffects;
    expect(badge('keep')?.kinds).toEqual(['file']);
    expect(badge('run')).toBeUndefined(); // its child shows it
    await s.hide({ kind: 'methodName', methodName: 'keep' });
    await s.scanSideEffects();
    expect(badge('keep')).toBeUndefined(); // hidden
    expect(badge('run')).toMatchObject({ kinds: ['file'], below: true });
    await s.unhideAll();
    expect(badge('run')).toBeUndefined();
    expect(badge('keep')?.kinds).toEqual(['file']);
  });
});

// ── the I/O walk over analysed bodies, on a fake program: method name → its calls ──
const pm = (name: string, hasBody = true): MethodRef => ({ key: `src/x.ts#X.${name}`, name, owner: { key: 'src/x.ts#X', name: 'X', kind: 'class' }, isStatic: false, hasBody }) as MethodRef;
const callTo = (m: MethodRef): CallSite => ({ ...lib('lib:none#N.n'), isLibrary: false, methodName: m.name, target: m });
const HTTP = lib('lib:System.Net.Http#HttpClient.GetAsync(string)');
const DB = lib('lib:Npgsql#NpgsqlCommand.ExecuteReaderAsync()');

describe('FR-17.5 the I/O walk below a call', () => {
  it('FR-17.5 a method not analysed yet shows nothing below it; more than four implementations are too open to judge', () => {
    const peek = (m: MethodRef) => (m.name === 'known' ? [HTTP] : undefined);
    expect(ioBelow(pm('unknown'), peek, () => undefined)).toEqual([]);
    const iface = pm('find', false);
    const five = Array.from({ length: 5 }, () => pm('known'));
    expect(ioOfCall(callTo(iface), peek, () => five)).toEqual([]);
    expect(ioOfCall(callTo(iface), peek, () => five.slice(0, 4))).toEqual(Array.from({ length: 4 }, () => ({ kind: 'http', call: 'HttpClient.GetAsync', in: 'X.known', by: pm('known').owner, at: HTTP.range })));
    expect(ioOfImplementations(five, peek, () => undefined)).toEqual([]);
    expect(ioOfImplementations([], peek, () => undefined)).toEqual([]);
  });

  it('FR-17.5 recursion is walked once; I/O more than four levels below is not looked for', () => {
    const [a, b] = [pm('a'), pm('b')];
    // a → b → a (recursion): b's HTTP once
    const rec = new Map([['a', [callTo(b)]], ['b', [callTo(a), HTTP]]]);
    expect(ioBelow(pm('root'), (m) => (m.name === 'root' ? [callTo(a)] : rec.get(m.name)), () => undefined)).toEqual([{ kind: 'http', call: 'HttpClient.GetAsync', in: 'X.b', by: b.owner, at: HTTP.range }]);
    // root → l1 → l2 → l3 → l4 → l5 (DB in each of l4, l5): l5 is a fifth level
    const levels = ['l1', 'l2', 'l3', 'l4', 'l5'].map((n) => pm(n));
    const body = (m: MethodRef): CallSite[] | undefined => {
      if (m.name === 'root') return [callTo(levels[0])];
      const i = levels.findIndex((l) => l.name === m.name);
      return [...(i + 1 < levels.length ? [callTo(levels[i + 1])] : []), ...(i >= 3 ? [DB] : [])];
    };
    expect(ioBelow(pm('root'), body, () => undefined).map((f) => f.in)).toEqual(['X.l4']);
    // FR-32.1 where it stopped: l4 has a call it did not follow; a chain that ends at the limit stopped nowhere
    const cuts = new Set<string>();
    ioBelow(pm('root'), body, () => undefined, cuts);
    expect([...cuts]).toEqual(['X.l4']);
    const short = new Set<string>();
    ioBelow(pm('root'), (m) => (m.name === 'l4' ? [DB] : body(m)), () => undefined, short);
    expect([...short]).toEqual([]);
  });

  it('FR-17.6 an implementation\'s own body is level 0 (as the scan fetches it): I/O four levels below it counts; one the walk could not follow to its end removes no kind, and says where it stopped (FR-32.1)', () => {
    const [shop, place, byOrder, get, mail, post, exec, deeper] = ['shop', 'place', 'byOrder', 'get', 'mail', 'post', 'exec', 'deeper'].map((n) => pm(n));
    const bodies = new Map<string, CallSite[]>([
      ['shop', [callTo(place)]],
      ['place', [callTo(byOrder)]],
      ['byOrder', [callTo(get)]],
      ['get', [callTo(exec)]],
      ['exec', [HTTP]],
      ['mail', [callTo(post)]],
      ['post', [callTo(exec)]],
      ['deeper', [callTo(shop)]],
    ]);
    const peek = (m: MethodRef) => bodies.get(m.name);
    const kinds = (f: { kind: string }[]) => [...new Set(f.map((x) => x.kind))];
    // shop → place → byOrder → get → exec: exec is the fourth level below shop
    const cuts = new Set<string>();
    expect(kinds(ioOfImplementations([shop, mail], peek, () => undefined, cuts))).toEqual(['http']);
    expect([...cuts]).toEqual([]);
    expect(kinds(ioOfCall(callTo(shop), peek, () => undefined))).toEqual(['http']);
    // one level more: the walk stops at get; mail's HTTP stays (unknown is not "no HTTP")
    expect(kinds(ioOfImplementations([deeper, mail], peek, () => undefined, cuts))).toEqual(['http']);
    expect([...cuts]).toEqual(['X.get']);
    // an implementation not analysed: the same
    const unknown = new Set<string>();
    expect(kinds(ioOfImplementations([pm('other'), mail], peek, () => undefined, unknown))).toEqual(['http']);
    expect([...unknown]).toEqual(['X.other']);
    // one followed to its end without HTTP still removes it
    bodies.set('plain', []);
    expect(ioOfImplementations([pm('plain'), mail], peek, () => undefined)).toEqual([]);
  });

  it('FR-32.1 each finding names the object running its method: a method with a body called on `this` / `base` runs on the caller\'s, any other on its own class\'s', () => {
    const own = (cls: string, name: string, hasBody = true): MethodRef => ({ ...pm(name, hasBody), key: `src/x.ts#${cls}.${name}`, owner: { key: `src/x.ts#${cls}`, name: cls, kind: 'class' } });
    const [get, send, post, store, save] = [own('Shop', 'get'), own('Base', 'send'), own('Mail', 'post'), own('Store', 'save', false), own('Disk', 'save')];
    const on = (m: MethodRef, receiver: CallSite['receiver']): CallSite => ({ ...callTo(m), receiver });
    const bodies = new Map<string, CallSite[]>([
      [get.key, [on(send, { kind: 'self' }), on(post, { kind: 'field', name: 'mail' })]],
      [send.key, [HTTP]],
      // an interface member called on `this`: its implementation's class runs it
      [post.key, [on(send, { kind: 'super' }), on(store, { kind: 'self' })]],
      [save.key, [DB]],
    ]);
    const by = (f: { kind: string; in?: string; by?: { name: string } }[]) => f.map((x) => `${x.kind} ${x.in} by ${x.by?.name}`);
    expect(by(ioBelow(get, (m) => bodies.get(m.key), (m) => (m.key === store.key ? [save] : undefined)))).toEqual(['http Base.send by Shop', 'http Base.send by Mail', 'db Disk.save by Disk']);
    // the caller's object given: its self calls run on it
    expect(by(ioBelow(get, (m) => bodies.get(m.key), () => undefined, undefined, { key: 'src/y.ts#Cart', name: 'Cart', kind: 'class' }))).toEqual(['http Base.send by Cart', 'http Base.send by Mail']);
    // a call standing alone (no caller's object): its method's class
    expect(by(ioOfCall(on(send, { kind: 'self' }), (m) => bodies.get(m.key), () => undefined))).toEqual(['http Base.send by Base']);
  });

  it(`FR-17.5 one walk looks at ${MAX_IO_METHODS} methods at most`, () => {
    // a chain m0 → m1 → … of single-call bodies, each with a DB call; four levels deep at most, from many roots
    const chain = Array.from({ length: MAX_IO_METHODS + 10 }, (_, i) => pm(`m${i}`));
    const body = new Map(chain.map((m, i) => [m.name, [DB]]));
    const root = pm('root');
    body.set('root', chain.map(callTo));
    const cuts = new Set<string>();
    const found = ioBelow(root, (m) => body.get(m.name), () => undefined, cuts);
    expect(found).toHaveLength(MAX_IO_METHODS);
    expect(cuts.size).toBe(10); // FR-32.1 the methods past the limit: not looked at
  });

  it('FR-17.5 a stub is known by its receiver type, else by its target\'s class', () => {
    const viaTarget: CallSite = { ...lib('lib:x#NotImplementedError..ctor', 'new NotImplementedError()'), kind: 'create', target: { key: 'lib:x#NotImplementedError..ctor', name: 'constructor', owner: { key: 'lib:x#NotImplementedError', name: 'NotImplementedError', kind: 'external' }, isStatic: false, hasBody: false } };
    expect(isStub([viaTarget])).toBe(true);
    expect(isStub([{ ...viaTarget, target: undefined }])).toBe(false);
  });
});

describe('FR-17.1 naming and judging I/O calls', () => {
  it('FR-17.1 the name of an I/O call: Type.member of its key, else its receiver type, else its text (cut at 40)', () => {
    expect(ioCallName(lib('lib:fs#readFile', 'fs.readFile(p)', { methodName: 'readFile', receiverType: { key: 'lib:fs#fs', name: 'fs', kind: 'external' } }))).toBe('fs.readFile');
    expect(ioCallName(lib('lib:fs#readFile', 'readFile(p)'))).toBe('readFile(p)');
    expect(ioCallName(lib('lib:fs#readFile', `readFile(${'a'.repeat(60)})`))).toBe(`readFile(${'a'.repeat(30)}…`);
  });

  it('FR-17.1 a library check (isCancel, isAxiosError) does no I/O; calls in a lambda passed along are the body\'s', () => {
    expect(ioKindOfCall(lib('lib:axios#AxiosStatic.isAxiosError', 'axios.isAxiosError(e)'))).toBeUndefined();
    const range = HTTP.range;
    const withLambdas: CallSite = {
      ...lib('lib:none#Array.forEach', 'items.forEach(…)'),
      argFunctions: [undefined, { kind: 'lambda', range }, { kind: 'lambda', range, calls: [HTTP] }, { kind: 'method', target: pm('m'), receiver: { kind: 'self' }, isLibrary: false }],
    };
    expect(directIo([withLambdas])).toEqual([{ kind: 'http', call: 'HttpClient.GetAsync' }]);
  });

  it('FR-17.1 a .NET data call known only by its library builds a command unless it is an action', () => {
    const byLibrary = (methodName: string): CallSite => ({ ...lib('x#y'), target: undefined, methodName, libraryName: 'Npgsql' });
    expect(ioKindOfCall(byLibrary('AddWithValue'))).toBeUndefined();
    expect(ioKindOfCall(byLibrary('ExecuteNonQuery'))).toBe('db');
  });

  it('FR-17.1 the answers stay right past the size of the name memo', () => {
    for (let i = 0; i <= 50_001; i++) ioKindOf(`lib:pkg${i}#X.y`);
    expect([ioKindOf('lib:axios#Axios.get'), ioKindOf('lib:pkg1#X.y')]).toEqual(['http', undefined]);
  });

  it('FR-17.5 evidence: a call named twice in one method is listed once; more than four lines are summed up', () => {
    const effects = toSideEffects([
      { kind: 'db', call: 'Db.query', in: 'A.a' },
      { kind: 'db', call: 'Db.query', in: 'A.a' },
      { kind: 'db', call: 'Db.query', in: 'B.b' },
      { kind: 'db', call: 'Db.query', in: 'C.c' },
      { kind: 'db', call: 'Db.query', in: 'D.d' },
      { kind: 'http', call: 'Http.get', in: 'E.e' },
      { kind: 'file', call: 'fs.read', in: 'F.f' },
    ]);
    expect(effects).toEqual({
      kinds: ['db', 'http', 'file'],
      evidence: ['DB: Db.query (in A.a)', 'DB: Db.query (in B.b)', 'DB: Db.query (in C.c)', 'DB: Db.query (in D.d)', '… +2 more'],
    });
  });
});
