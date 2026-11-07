import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeCommand, type CommandRequest } from './cli';
import { locate, openProject, UsageError, type OpenOptions, type Project, type Target } from './commands';

/**
 * FR-27.7 the CLI's three commands as an MCP server (stdio, newline-delimited JSON-RPC 2.0): an agent calls
 * `flow` / `paths` / `review` as tools and gets the same text the CLI prints. The difference is the project
 * stays loaded between calls (a C# solution loads once, not on every call); files changed on disk since the
 * last call are read again before the next one.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

declare const SEQCALL_VERSION: string | undefined;
/** The package version (set by build.mjs; `dev` when run from source). */
export const VERSION = typeof SEQCALL_VERSION === 'string' ? SEQCALL_VERSION : 'dev';

const TARGET = {
  type: 'string',
  description: '`<file>:<line>` (1-based, any line of the method; the file relative to the project root or absolute) or a method key such as `src/x.ts#Class.method` (from format json).',
};
const FORMAT = { type: 'string', enum: ['text', 'json'], description: 'text (default, few tokens) or json (the versioned envelope).' };

export const MCP_TOOLS = [
  {
    name: 'flow',
    description:
      'What a method does at run time, followed through DI, interfaces and callbacks: its I/O list (DB / HTTP / MQ / files, with the line of each call, IN LOOP, runs later, the methods on the way) and its design issues (N+1, layer violations …). tree: every call with layers, frames (loop / alt / try), implementations and file:line. Lines starting with "# INCOMPLETE" name a limit that cut the result.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        depth: { type: 'integer', minimum: 1, description: 'Levels to open below the method (default: everything up to the expand limit).' },
        tree: { type: 'boolean', description: 'Include the call tree.' },
        format: FORMAT,
      },
      required: ['target'],
    },
  },
  {
    name: 'paths',
    description:
      'Who reaches a method: the callers up to the entry points (HTTP routes, jobs, commands, handlers), each with file:line, and a summary of the entry points by kind. Tests are counted; tests: list them by class, which of them mock a type on the way, and tests that call a reached route over HTTP.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        tests: { type: 'boolean', description: 'List the tests that reach it.' },
        code: { type: 'boolean', description: 'Show each call\'s code line.' },
        format: FORMAT,
      },
      required: ['target'],
    },
  },
  {
    name: 'review',
    description:
      'What the current branch changed: first its structure against the base (dependencies between layers / packages added or removed, layer violations added or removed, entry points added or removed, I/O kinds (DB, HTTP …) and I/O clients (Npgsql, Kafka …) a layer started or stopped using, cycles between layers / packages added or removed, classes that changed layer or role — empty when the shape is unchanged), then the changed methods with the entry points that reach them and their test count and design issues in the changed flows.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Branch / ref to compare with (default: develop, else main / master).' },
        direct: { type: 'boolean', description: 'Tip against tip instead of since the branch split off.' },
        format: FORMAT,
      },
    },
  },
  {
    name: 'entrypoints',
    description:
      'Where flows start in the project: HTTP routes (verb + path, route names), scheduled jobs, console commands, queue / event handlers, programs and module-level calls, with the handler method and file:line. Use it to find the code behind a route or a job; the method key of a row works as a target for flow / paths.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Words that must all match (route, method, route name, kind detail), e.g. "post orders".' },
        tests: { type: 'boolean', description: 'Include test methods.' },
        format: FORMAT,
      },
    },
  },
  {
    name: 'outcomes',
    description:
      'What each entry point\'s whole flow touches (tests excluded): its I/O — database, cache, HTTP to other APIs, files, queues, cloud, processes — each kind with the project classes doing it; with detail, their library calls and file:line. Use it for "which routes write to the DB / call other APIs". Slow on a large project the first time (it walks every flow; shared with issues).',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Words that must all match (route, method, route name, kind detail), e.g. "post orders".' },
        detail: { type: 'boolean', description: 'Each class\'s library calls with file:line.' },
        format: FORMAT,
      },
    },
  },
  {
    name: 'issues',
    description:
      'Design issues of the whole project, found in every entry point\'s flow (tests excluded): I/O in a loop (N+1), I/O in the domain layer, cycles, layer violations, god classes, too many dependencies — each with the flow that shows it (open it with flow). Slow on a large project the first time (it walks every flow).',
    inputSchema: { type: 'object', properties: { format: FORMAT } },
  },
  {
    name: 'unreachable',
    description:
      'Methods no entry point reaches (tests excluded): dead-code candidates with the reason (no callers, called only from unreached code, only tests call it), each with file:line; listed apart: methods the framework probably calls (magic / runtime methods, classes extending a library type, what those reach) and methods a call the analysis could not resolve may reach. Slow on a large project the first time.',
    inputSchema: { type: 'object', properties: { format: FORMAT } },
  },
  {
    name: 'impls',
    description:
      'Who implements an interface / abstract / overridable method (each implementation with file:line) and the DI container registrations of its type: which class the container gives (per application when they differ), keyed / conditional / fallback registrations, lifetimes.',
    inputSchema: { type: 'object', properties: { target: TARGET, format: FORMAT }, required: ['target'] },
  },
] as const;

const INSTRUCTIONS =
  'Seqcall analyses the project statically (TypeScript/JavaScript, C#, PHP). Use `paths` for "who calls / what breaks if I change this", `flow` for "what does this method run (DB, HTTP, queues, loops)", `review` for "what did this branch touch", `entrypoints` to find the code behind a route or job, `impls` for the implementations of an interface and what DI gives, `outcomes` for what each entry point touches (DB, other APIs, files, queues), `issues` for the design issues of the whole project, `unreachable` for dead-code candidates. The first call loads the project (seconds for a large C# solution); later calls reuse it.';

interface Loaded {
  project: Project;
  /** Source files and their modification times at the last call. */
  files: Map<string, number>;
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'bin', 'obj', '.git', 'dist', 'out', 'storage', 'coverage', '.idea', '.vscode', '.vs']);
const SOURCE = {
  typescript: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
  csharp: /\.cs$/,
  php: /\.php$/,
} as const;
/** A change of these needs a new project (references, packages, compiler settings), not a re-read file. */
const PROJECT_FILES = /(\.(csproj|sln|slnx|props)|[\\/](package|composer|tsconfig[^\\/]*)\.json)$/;
const CONFIG = /[\\/]\.seqcall\.json$/;

/** The project's source and project files with their modification times. */
export function snapshot(root: string, language: keyof typeof SOURCE): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (SOURCE[language].test(e.name) || PROJECT_FILES.test(full) || CONFIG.test(full)) {
        try {
          out.set(full, fs.statSync(full).mtimeMs);
        } catch {
          // removed while walking
        }
      }
    }
  };
  walk(root.replace(/\\/g, '/').replace(/\/$/, ''));
  return out;
}

/** Files added, changed or removed between two snapshots. */
export function changedFiles(before: Map<string, number>, now: Map<string, number>): string[] {
  const changed = [...now].filter(([f, t]) => before.get(f) !== t).map(([f]) => f);
  return [...changed, ...[...before.keys()].filter((f) => !now.has(f))];
}

export interface McpOptions extends OpenOptions {
  cwd: string;
  /** Opens a project (tests count the loads); default openProject. */
  open?(opts: OpenOptions & { file?: string; cwd: string }): Project;
}

type JsonRpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/** One MCP session: requests in, responses out; projects stay loaded until close(). */
export class McpServer {
  private readonly loaded = new Map<string, Loaded>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: McpOptions) {}

  /** Handles one message; returns the response (undefined for a notification). */
  async handle(msg: JsonRpc): Promise<object | undefined> {
    const id = msg.id;
    if (id === undefined || id === null) return undefined; // notifications (initialized, cancelled): nothing to answer
    const ok = (result: object) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion as string | undefined;
        return ok({
          protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'seqcall', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: MCP_TOOLS });
      case 'tools/call': {
        const name = msg.params?.name as string;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        // one call at a time: the session is not re-entrant
        const run = this.queue.then(() => this.call(name, args));
        this.queue = run.catch(() => undefined);
        return ok(await run);
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<object> {
    if (!MCP_TOOLS.some((t) => t.name === name)) return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true };
    const req: CommandRequest = {
      command: name,
      target: typeof args.target === 'string' ? args.target : undefined,
      filter: typeof args.filter === 'string' ? args.filter : undefined,
      depth: typeof args.depth === 'number' ? args.depth : undefined,
      tree: args.tree === true,
      tests: args.tests === true,
      code: args.code === true,
      base: typeof args.base === 'string' ? args.base : undefined,
      direct: args.direct === true,
      detail: args.detail === true,
      format: args.format === 'json' ? 'json' : 'text',
    };
    const cwd = this.opts.root ? path.resolve(this.opts.cwd, this.opts.root) : this.opts.cwd;
    try {
      const text = await executeCommand(req, cwd, (target) => this.project(target));
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      const usage = e instanceof UsageError;
      return { content: [{ type: 'text', text: `${usage ? '' : 'analysis error: '}${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  /** The loaded project of the target, its changed files read again; loaded on first use. */
  private async project(target?: Target): Promise<Project> {
    const file = target && 'file' in target ? target.file : undefined;
    const loc = locate({ root: this.opts.root, file, cwd: this.opts.cwd });
    const now = snapshot(loc.root, loc.language);
    let entry = this.loaded.get(loc.root);
    if (entry) {
      const changed = changedFiles(entry.files, now);
      if (changed.some((f) => PROJECT_FILES.test(f))) {
        await dispose(entry.project);
        entry = undefined;
      } else if (changed.length) await entry.project.session.refresh(changed);
    }
    if (!entry) {
      const open = this.opts.open ?? openProject;
      // the server's own cwd: a relative --root is relative to it (`cwd` here is the root already)
      entry = { project: open({ ...this.opts, file, cwd: this.opts.cwd }), files: now };
      this.loaded.set(loc.root, entry);
    }
    entry.files = now;
    return entry.project;
  }

  async close(): Promise<void> {
    for (const e of this.loaded.values()) await dispose(e.project);
    this.loaded.clear();
  }
}

async function dispose(p: Project): Promise<void> {
  await p.session.dispose().catch(() => undefined);
  await p.adapter.dispose().catch(() => undefined);
}

/** Serves MCP on stdin / stdout until stdin closes. */
export function serveMcp(opts: McpOptions, input: NodeJS.ReadableStream, write: (line: string) => void, log: (line: string) => void): Promise<void> {
  const server = new McpServer(opts);
  let buffer = '';
  const pending = new Set<Promise<void>>();
  const onLine = (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    // `null`, a number, a batch: no message to read an id from (batches are not supported; MCP 2025-06-18 dropped them)
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: not a JSON-RPC message object' } }));
      return;
    }
    const p = server
      .handle(msg)
      .then((r) => r && write(JSON.stringify(r)))
      .catch((e) => {
        log(`seqcall mcp: ${e instanceof Error ? e.stack : String(e)}`);
        // only a request can get here: handle() answers a notification (no id) with nothing before anything can throw
        write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }));
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  return new Promise((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    input.on('end', () => {
      onLine(buffer);
      void Promise.allSettled([...pending]).then(() => server.close()).then(resolve);
    });
  });
}
