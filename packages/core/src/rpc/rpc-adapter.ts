import type { CallerInfo, EntryPoint, MethodRef, Position, ProcessMemory } from '@seqcall/protocol';
import type { CallSite, ClassInfo, ContainerBinding, EarlyExit, FileType, LanguageAdapter, ModuleFacts, ReturnFact, TypeUse } from '../adapter';
import { TestFileMatcher } from '../test-files';
import { RpcExitError, RpcProcess, RpcResponseError } from './json-rpc';
import { trimEndChar } from '../text';

export interface RpcAdapterOptions {
  projectRoot: string;
  /** Executable and arguments of the sidecar process (working directory: `cwd` ?? projectRoot). */
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Params of the `initialize` request (projectRoot is always included). */
  initializeParams?: Record<string, unknown>;
  /** Display name in error messages. Default "sidecar". */
  name?: string;
  /** Receives the sidecar's stderr lines and lifecycle messages. */
  log?: (line: string) => void;
  /** Timeout of `initialize` (loads the workspace). Default 10 min. */
  initializeTimeoutMs?: number;
  /** Timeout of every other request. Default 2 min. */
  requestTimeoutMs?: number;
  /** Grace period between `shutdown` and killing the process. Default 2 s. */
  shutdownGraceMs?: number;
  /** Checked before (re)starting; a thrown error rejects the request with its message. */
  precheck?: () => void;
}

/** Result of the `initialize` request. */
export interface InitializeResult {
  projects: string[];
  documents: number;
  loadMs: number;
}

const MAX_RESTARTS = 1;
/** JSON-RPC 2.0 "Method not found". */
const METHOD_NOT_FOUND = -32601;

/**
 * LanguageAdapter backed by an out-of-process analyser speaking newline-delimited JSON-RPC 2.0
 * (docs/CSHARP-SIDECAR.md). The process is started and initialized lazily on the first request
 * (one shared `initialize`), restarted once after a crash, and shut down by `dispose()`.
 * Test-file semantics are applied here, like in TsAdapter: implementations in test files are
 * dropped and test callers are listed last.
 */
export class RpcLanguageAdapter implements LanguageAdapter {
  readonly projectRoot: string;
  private readonly testFiles: TestFileMatcher;
  private readonly name: string;
  private proc: RpcProcess | undefined;
  private ready: Promise<RpcProcess> | undefined;
  /** Files whose content was given by the host instead of the disk (FR-24.6 base version), re-applied on start. */
  private readonly overlays = new Map<string, string>();
  private restarts = 0;
  private disposed = false;
  /** Result of the last successful `initialize`. */
  initializeResult: InitializeResult | undefined;
  /** FR-34.1 the process whose `initialize` finished (asked for its memory; a loading one is not). */
  private loaded: RpcProcess | undefined;

  constructor(private readonly opts: RpcAdapterOptions) {
    this.projectRoot = trimEndChar(opts.projectRoot.replace(/\\/g, '/'), '/');
    this.testFiles = new TestFileMatcher(this.projectRoot);
    this.name = opts.name ?? 'sidecar';
  }

  /** Starts and initializes the process (otherwise done by the first request). */
  async initialize(): Promise<InitializeResult | undefined> {
    await this.withRestart(() => this.connection());
    return this.initializeResult;
  }

  /** FR-16.10 starts the sidecar and loads the workspace now (loading a C# solution takes a while). */
  async warmUp(): Promise<void> {
    await this.initialize();
  }

  async findEnclosingCallable(file: string, position: Position): Promise<MethodRef | undefined> {
    return await this.call<MethodRef | undefined>('findEnclosingCallable', { file: normalize(file), position });
  }

  async getMethod(key: string): Promise<MethodRef | undefined> {
    return await this.call<MethodRef | undefined>('getMethod', { key });
  }

  async getOutgoingCalls(method: MethodRef): Promise<CallSite[]> {
    return (await this.call<CallSite[] | undefined>('getOutgoingCalls', { method })) ?? [];
  }

  async getImplementations(method: MethodRef): Promise<MethodRef[]> {
    const impls = (await this.call<MethodRef[] | undefined>('getImplementations', { method })) ?? [];
    return impls.filter((m) => !this.isTest(m.declaration?.file, m.key));
  }

  async getCallers(method: MethodRef): Promise<CallerInfo[]> {
    const callers = (await this.call<CallerInfo[] | undefined>('getCallers', { method })) ?? [];
    const prod = callers.filter((c) => !this.isTest(c.range.file));
    const test = callers.filter((c) => this.isTest(c.range.file)).map((c) => ({ ...c, inTest: true }));
    return [...prod, ...test];
  }

  /** FR-31.1. An older sidecar without the method: no value uses. */
  async getValueUses(method: MethodRef): Promise<number> {
    try {
      return (await this.call<number | undefined>('getValueUses', { method })) ?? 0;
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return 0;
      throw e;
    }
  }

  async getClassInfo(classKey: string): Promise<ClassInfo | undefined> {
    const info = await this.call<ClassInfo | undefined>('getClassInfo', { classKey });
    if (!info) return undefined;
    return {
      ...info,
      decorators: info.decorators ?? [],
      implements: info.implements ?? [],
      fields: info.fields ?? [],
      constructorParams: info.constructorParams ?? [],
      methods: info.methods ?? [],
      hasPrivateConstructor: !!info.hasPrivateConstructor,
      hasStaticInstance: !!info.hasStaticInstance,
      allMembersStatic: !!info.allMembersStatic,
      isExportedInstance: !!info.isExportedInstance,
    };
  }

  async getParameterNames(method: MethodRef): Promise<string[]> {
    return (await this.call<string[] | undefined>('getParameterNames', { method })) ?? [];
  }

  /** FR-12.12. An older sidecar without the method yields no uses (method not found). */
  async getTypeUses(method: MethodRef): Promise<TypeUse[]> {
    try {
      return (await this.call<TypeUse[] | undefined>('getTypeUses', { method })) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  /** FR-31.1. An older sidecar without the method: undefined. */
  async getFileTypes(file: string): Promise<FileType[] | undefined> {
    try {
      return (await this.call<FileType[]>('getFileTypes', { file })) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return undefined;
      throw e;
    }
  }

  /** FR-31.1. An older sidecar without the method: undefined (nothing is listed). */
  async getProjectTypes(): Promise<FileType[] | undefined> {
    try {
      return (await this.call<FileType[]>('getProjectTypes', {})) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return undefined;
      throw e;
    }
  }

  /** FR-7.7. An older sidecar without the method cannot tell (undefined). */
  async getModuleFacts(classKey: string): Promise<ModuleFacts | undefined> {
    try {
      return await this.call<ModuleFacts | undefined>('getModuleFacts', { classKey });
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return undefined;
      throw e;
    }
  }

  /** FR-16.1. An older sidecar without the method yields no entry points. */
  /** FR-8.6. An older sidecar without the method: no bindings (every implementation offered). */
  async getBindings(): Promise<ContainerBinding[]> {
    try {
      return (await this.call<ContainerBinding[] | undefined>('getBindings', {})) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  /** FR-8.6. An older sidecar: undefined (bindings apply everywhere). */
  async getHostsOf(file: string): Promise<string[] | undefined> {
    try {
      return await this.call<string[] | undefined>('getHostsOf', { file });
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return undefined;
      throw e;
    }
  }

  async getEntryPoints(): Promise<EntryPoint[]> {
    try {
      return (await this.call<EntryPoint[] | undefined>('getEntryPoints', {})) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  /** FR-1.15. An older sidecar without the method yields no exits. */
  async getEarlyExits(method: MethodRef): Promise<EarlyExit[]> {
    try {
      return (await this.call<EarlyExit[] | undefined>('getEarlyExits', { method })) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  /** FR-5.8. An older sidecar without the method: unknown (only returned calls are followed). */
  async getReturns(method: MethodRef): Promise<ReturnFact[]> {
    try {
      return (await this.call<ReturnFact[] | undefined>('getReturns', { method })) ?? [];
    } catch (e) {
      if (e instanceof RpcResponseError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  async updateFile(file: string, content?: string): Promise<void> {
    // content given (not on disk) is kept and applied again after a (re)start
    if (content !== undefined) this.overlays.set(normalize(file), content);
    else this.overlays.delete(normalize(file));
    // Not started yet: the workspace will be loaded from disk anyway (and the overlays applied).
    if (!this.ready) return;
    // without content (back to the disk) the request has no `content` (JSON leaves an undefined value out)
    await this.call('updateFile', { file: normalize(file), content });
  }

  /**
   * FR-34.1 the process's own report of its memory — only while it runs and has loaded (asking never starts it nor
   * waits for a load); an older sidecar without the method, or no answer within 5 s: undefined.
   */
  async getMemory(): Promise<ProcessMemory | undefined> {
    const proc = this.proc;
    if (!proc?.isAlive || this.loaded !== proc) return undefined;
    try {
      return denull(await proc.request<unknown>('getMemory', {}, 5000)) as ProcessMemory | undefined;
    } catch {
      return undefined;
    }
  }

  /** FR-34.2 stops the process to give its memory back (the overlays are kept); the next request starts it again. */
  async release(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    await this.stop(proc);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.proc;
    this.proc = undefined;
    this.ready = undefined;
    await this.stop(proc);
  }

  /** Asks the process to shut down, then kills it after the grace period. */
  private async stop(proc: RpcProcess | undefined): Promise<void> {
    if (!proc || !proc.isAlive) return;
    const grace = this.opts.shutdownGraceMs ?? 2000;
    const timer = setTimeout(() => proc.kill(), grace);
    try {
      await proc.request('shutdown', {}, grace).catch(() => undefined);
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, grace))]);
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  // ───────────── plumbing ─────────────

  private async call<T>(method: string, params: unknown): Promise<T> {
    const result = await this.withRestart(async () => {
      const proc = await this.connection();
      return proc.request<unknown>(method, params, this.opts.requestTimeoutMs ?? 120_000);
    });
    return denull(result) as T;
  }

  /** Runs `op`; when the process died underneath it, restarts (at most MAX_RESTARTS times) and retries once. */
  private async withRestart<T>(op: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await op();
    } catch (e) {
      if (!(e instanceof RpcExitError) || this.disposed || this.restarts >= MAX_RESTARTS) throw e;
      this.restarts++;
      this.opts.log?.(`[seqcall] ${this.name} died (${firstLine(e.message)}); restarting (${this.restarts}/${MAX_RESTARTS})`);
      result = await op();
    }
    this.restarts = 0; // recovered: a later crash may restart again
    return result;
  }

  /** The running, initialized process (started on first use; restarted after it exited). */
  private connection(): Promise<RpcProcess> {
    if (this.disposed) return Promise.reject(new Error(`${this.name}: the adapter has been disposed`));
    if (this.ready && this.proc?.isAlive) return this.ready;
    const ready = this.start();
    this.ready = ready;
    ready.catch(() => {
      /* v8 ignore next -- another start replaced it only when a request starts one in the tick the first process dies during initialize */
      if (this.ready === ready) this.ready = undefined;
    });
    return ready;
  }

  private async start(): Promise<RpcProcess> {
    this.opts.precheck?.();
    const log = this.opts.log;
    log?.(`[seqcall] starting ${this.name}: ${this.opts.command} ${this.opts.args.join(' ')}`);
    const proc = new RpcProcess({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd ?? this.projectRoot,
      env: this.opts.env,
      name: this.name,
      log,
    });
    this.proc = proc;
    try {
      const result = await proc.request<InitializeResult>(
        'initialize',
        { ...(this.opts.initializeParams ?? {}), projectRoot: this.projectRoot },
        this.opts.initializeTimeoutMs ?? 600_000,
      );
      this.initializeResult = denull(result) as InitializeResult | undefined;
      if (this.initializeResult) {
        const r = this.initializeResult;
        log?.(`[seqcall] ${this.name} ready: ${r.projects?.length ?? 0} project(s), ${r.documents ?? 0} documents, loaded in ${r.loadMs ?? '?'} ms`);
      }
      for (const [file, content] of this.overlays) await proc.request('updateFile', { file, content }, this.opts.requestTimeoutMs ?? 120_000);
      this.loaded = proc;
      return proc;
    } catch (e) {
      proc.kill();
      /* v8 ignore next -- the same race: a newer start set its own process before this one's failure arrived */
      if (this.proc === proc) this.proc = undefined;
      throw e;
    }
  }

  private isTest(file: string | undefined, key?: string): boolean {
    let rel: string | undefined;
    if (file) {
      const f = normalize(file);
      // a file outside the project folder is no test code of it (a relative `../x` path matches no test glob either)
      rel = f.startsWith(`${this.projectRoot}/`) ? f.slice(this.projectRoot.length + 1) : undefined;
    } else if (key && key.includes('#') && !key.startsWith('lib:')) {
      rel = key.slice(0, key.indexOf('#'));
    }
    return !!rel && this.testFiles.isTest(rel);
  }
}

const normalize = (file: string): string => file.replace(/\\/g, '/');

const firstLine = (s: string): string => s.split('\n')[0];

/** Protocol: `null` means "none" — mapped to absent/undefined (array holes stay as undefined). */
export function denull(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(denull);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = denull(v);
    }
    return out;
  }
  return value;
}
