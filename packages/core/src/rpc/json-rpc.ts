import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A JSON-RPC error response (`{ code, message }`) from the peer. */
export class RpcResponseError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcResponseError';
  }
}

/** The peer process exited (or could not be started) before answering. */
export class RpcExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcExitError';
  }
}

export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcTimeoutError';
  }
}

export interface RpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Display name used in error messages, e.g. "C# sidecar". */
  name: string;
  /** Receives every stderr line of the process. */
  log?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL = 20;

/**
 * One child process speaking newline-delimited JSON-RPC 2.0 on stdio: one request object per
 * line on stdin, one response object per line on stdout; stderr is diagnostics only.
 */
export class RpcProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly stderrTail: string[] = [];
  private nextId = 1;
  private exitError: RpcExitError | undefined;
  /** Resolves when the process has exited (or failed to start). */
  readonly exited: Promise<void>;

  constructor(private readonly opts: RpcProcessOptions) {
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let markExited!: () => void;
    this.exited = new Promise((r) => (markExited = r));

    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
      opts.log?.(line);
    });
    this.child.stdin!.on('error', () => {
      /* EPIPE after the process died: reported through 'exit' */
    });
    this.child.on('error', (e) => {
      this.fail(new RpcExitError(`${opts.name} could not be started (${opts.command}): ${e.message}`));
      markExited();
    });
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrTail.length ? `\n${this.stderrTail.slice(-5).join('\n')}` : '';
      this.fail(new RpcExitError(`${opts.name} exited (${signal ?? `code ${code}`})${tail}`));
      markExited();
    });
  }

  get isAlive(): boolean {
    return !this.exitError;
  }

  /** Sends a request; rejects on an error response, process exit or after `timeoutMs` (0 = never). */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcTimeoutError(`${this.opts.name}: "${method}" timed out after ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        this.settle(id)?.reject(new RpcExitError(`${this.opts.name}: cannot send "${method}": ${(e as Error).message}`));
      }
    });
  }

  kill(): void {
    if (this.exitError) return;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      this.opts.log?.(`[stdout, not JSON-RPC] ${text}`);
      return;
    }
    if (typeof msg.id !== 'number') return; // notifications are not part of the protocol
    const entry = this.settle(msg.id);
    if (!entry) return; // timed out earlier
    if (msg.error) {
      entry.reject(
        new RpcResponseError(entry.method, msg.error.code ?? -32603, `${this.opts.name}: "${entry.method}" failed: ${msg.error.message ?? 'unknown error'}`),
      );
    } else entry.resolve(msg.result ?? null);
  }

  private settle(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  private fail(error: RpcExitError): void {
    /* v8 ignore next -- a second 'error' / 'exit' event of the child (Node emits 'error' for a failed kill or send on a live process, then 'exit'); a spawn failure emits 'error' only */
    if (this.exitError) return;
    this.exitError = error;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error);
  }
}
