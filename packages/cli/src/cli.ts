import { openProject, parseTarget, runEntryPoints, runFlow, runImpls, runIssues, runOutcomes, runPaths, runReview, runUnreachable, SCHEMA, UsageError, type Envelope, type Project, type Target } from './commands';
import { entryPointsText, flowText, implsText, issuesText, outcomesText, pathsText, reviewText, unreachableText } from './format';

export const USAGE = `seqcall — call flows for AI agents and scripts (FR-27)

  seqcall flow   <file>:<line> | <methodKey>  [--depth <n>] [--tree]   what it does: its I/O (DB/HTTP/MQ, loops, later), issues;
                                                                         --tree: every call with layers, frames, file:line
  seqcall paths  <file>:<line> | <methodKey>  [--tests] [--code]       who reaches it, up to the entry points (routes, jobs, …);
                                                                         --tests: the tests by class, mocks, tests over HTTP
  seqcall review [--base <ref>] [--direct]                    what the branch changed, which entry points reach it, issues
  seqcall entrypoints [<words>…] [--tests]                    where flows start: routes, jobs, commands, handlers (filter: all words)
  seqcall outcomes [<words>…] [--detail]                      what each entry point's flow touches: DB / HTTP / files / queues …,
                                                                 by the classes doing it; --detail: their library calls, file:line
  seqcall issues                                             design issues of the whole project (N+1, layer violations …), by flow
  seqcall unreachable                                        methods no entry point reaches (dead-code candidates), by reason;
                                                                 framework-called and maybe-called listed apart
  seqcall impls  <file>:<line> | <methodKey>                  who implements an interface / abstract method; what DI gives for it
  seqcall mcp    [--root <dir>]                               the same three as tools of an MCP server (stdio); the project
                                                                 stays loaded between calls
  seqcall update [--dir <folder>]                             the latest release in place of the unpacked seqcall-agent
                                                                 folder, then Claude Code's copy

  <line> is 1-based, any line of the method. A methodKey is "src/x.ts#Class.method" (from --format json).
  Options: --root <dir> (default: the file's project, else the current folder), --format text|json (default text),
           --csharp-sidecar <Seqcall.CSharp.dll>.
  Exit: 0 ok, 2 usage, 3 analysis error. Text lines starting with "# INCOMPLETE" name limits that cut the result.`;

export interface CliIo {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
}

interface Args {
  command?: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUED = new Set(['--root', '--format', '--depth', '--base', '--csharp-sidecar']);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positional.push(a);
    else if (VALUED.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags.set(a, argv[++i]);
    } else flags.set(a, true);
  }
  return { command: positional.shift(), positional, flags };
}

/** One command, as the CLI arguments or an MCP tool call give it. */
export interface CommandRequest {
  command: string;
  /** `<file>:<line>` or a method key (flow, paths, impls). */
  target?: string;
  /** entrypoints, outcomes: words that must all match. */
  filter?: string;
  depth?: number;
  tree?: boolean;
  tests?: boolean;
  code?: boolean;
  base?: string;
  direct?: boolean;
  /** outcomes: each class's library calls with file:line. */
  detail?: boolean;
  format?: 'text' | 'json';
}

/**
 * Runs one command on a project `open` gives (a fresh one for the CLI, a loaded one for the MCP server, FR-27.7);
 * returns the result as text or JSON. Throws UsageError for a wrong request.
 */
export async function executeCommand(req: CommandRequest, cwd: string, open: (target?: Target) => Project | Promise<Project>): Promise<string> {
  const t0 = Date.now();
  const needTarget = (): Target => {
    if (!req.target) throw new UsageError(`${req.command} needs one method: <file>:<line> or a method key`);
    return parseTarget(req.target, cwd);
  };
  const wrap = <R>(command: string, p: Project, r: { result: R; limits: string[] }): Envelope<R> => ({
    schema: SCHEMA,
    command,
    project: { root: p.root, language: p.language },
    complete: r.limits.length === 0,
    limits: r.limits,
    elapsedMs: Date.now() - t0,
    result: r.result,
  });
  let envelope: Envelope<unknown>;
  let text: (e: Envelope<never>) => string;
  switch (req.command) {
    case 'flow': {
      const target = needTarget();
      if (req.depth !== undefined && !(req.depth >= 1)) throw new UsageError('--depth is a number ≥ 1');
      const project = await open(target);
      envelope = wrap('flow', project, await runFlow(project, target, { depth: req.depth, tree: req.tree }));
      text = ((e: Envelope<never>) => flowText(e, { tree: req.tree })) as never;
      break;
    }
    case 'paths': {
      const target = needTarget();
      const project = await open(target);
      envelope = wrap('paths', project, await runPaths(project, target, { tests: req.tests }));
      text = ((e: Envelope<never>) => pathsText(e, { code: req.code })) as never;
      break;
    }
    case 'impls': {
      const target = needTarget();
      const project = await open(target);
      envelope = wrap('impls', project, await runImpls(project, target));
      text = implsText as never;
      break;
    }
    case 'entrypoints': {
      const project = await open();
      envelope = wrap('entrypoints', project, await runEntryPoints(project, { filter: req.filter, tests: req.tests }));
      text = entryPointsText as never;
      break;
    }
    case 'outcomes': {
      const project = await open();
      envelope = wrap('outcomes', project, await runOutcomes(project, { filter: req.filter }));
      text = ((e: Envelope<never>) => outcomesText(e, { detail: req.detail })) as never;
      break;
    }
    case 'issues': {
      if (req.target) throw new UsageError('issues takes no method');
      const project = await open();
      envelope = wrap('issues', project, await runIssues(project));
      text = issuesText as never;
      break;
    }
    case 'unreachable': {
      if (req.target) throw new UsageError('unreachable takes no method');
      const project = await open();
      envelope = wrap('unreachable', project, await runUnreachable(project));
      text = unreachableText as never;
      break;
    }
    case 'review': {
      if (req.target) throw new UsageError('review takes no method');
      const project = await open();
      envelope = wrap('review', project, await runReview(project, { base: req.base, direct: req.direct }));
      text = reviewText as never;
      break;
    }
    default:
      throw new UsageError(`unknown command "${req.command}"`);
  }
  return req.format === 'json' ? JSON.stringify(envelope, null, 2) : text(envelope as never);
}

/** Runs one command; returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let project: Project | undefined;
  try {
    const args = parseArgs(argv);
    if (!args.command || args.flags.has('--help') || args.command === 'help') {
      io.out(USAGE);
      return args.command || args.flags.has('--help') ? 0 : 2;
    }
    const known = ['--root', '--format', '--depth', '--base', '--csharp-sidecar', '--tests', '--direct', '--tree', '--code', '--detail', '--help'];
    const unknown = [...args.flags.keys()].find((f) => !known.includes(f));
    if (unknown) throw new UsageError(`unknown option ${unknown}`);
    const format = (args.flags.get('--format') as string | undefined) ?? 'text';
    if (format !== 'text' && format !== 'json') throw new UsageError('--format is text or json');
    const str = (f: string) => args.flags.get(f) as string | undefined;
    const words = args.command === 'entrypoints' || args.command === 'outcomes';
    if (args.positional.length > 1 && args.command !== 'review' && !words) throw new UsageError(`${args.command} needs one method: <file>:<line> or a method key`);
    const depth = str('--depth');
    if (depth !== undefined && !(Number(depth) >= 1)) throw new UsageError('--depth is a number ≥ 1');
    const req: CommandRequest = {
      command: args.command,
      target: words ? undefined : args.positional[0],
      filter: words ? args.positional.join(' ') : undefined,
      depth: depth === undefined ? undefined : Number(depth),
      tree: args.flags.has('--tree'),
      tests: args.flags.has('--tests'),
      code: args.flags.has('--code'),
      base: str('--base'),
      direct: args.flags.has('--direct'),
      detail: args.flags.has('--detail'),
      format,
    };
    io.out(
      await executeCommand(req, io.cwd, (target) => {
        project = openProject({ cwd: io.cwd, root: str('--root'), csharpSidecar: str('--csharp-sidecar'), file: target && 'file' in target ? target.file : undefined, log: (l) => process.env.SEQCALL_DEBUG && io.err(l) });
        return project;
      }),
    );
    return 0;
  } catch (e) {
    const usage = e instanceof UsageError;
    // the core and the sidecar client throw Error objects; anything else is printed as it is
    /* v8 ignore next -- no input makes the analysis throw a non-Error value */
    const message = e instanceof Error ? e.message : String(e);
    io.err(`seqcall: ${message}${usage ? '\n(seqcall --help for usage)' : ''}`);
    return usage ? 2 : 3;
  } finally {
    await project?.session.dispose().catch(() => undefined);
    await project?.adapter.dispose().catch(() => undefined);
  }
}
