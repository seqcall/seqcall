import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguageAdapter } from '../adapter';
import { RpcLanguageAdapter } from './rpc-adapter';

export const CSHARP_SIDECAR_ENV = 'SEQCALL_CSHARP_SIDECAR';
export const CSHARP_SIDECAR_DLL = 'Seqcall.CSharp.dll';
/** Build output of packages/csharp, relative to the repository root (development). */
export const CSHARP_SIDECAR_DEV_PATH = 'packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0/Seqcall.CSharp.dll';

export interface CSharpAdapterOptions {
  /** Path of Seqcall.CSharp.dll (wins over the environment and the development build). */
  sidecarPath?: string;
  /** Solution (.sln/.slnx) to load; default: the sidecar's discovery under the root. */
  solution?: string;
  /** Receives the sidecar's stderr and lifecycle lines. */
  log?: (line: string) => void;
  /** `dotnet` executable. Default: env SEQCALL_DOTNET, else `dotnet` on the PATH. */
  dotnet?: string;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
}

/**
 * Where the C# sidecar lives: `explicit` → env SEQCALL_CSHARP_SIDECAR → the development build
 * `<repo>/packages/csharp/bin/Release/net10.0/Seqcall.CSharp.dll`, with `<repo>` found by walking
 * up from `from` (default: this module's directory). Returns the first candidate even when it
 * does not exist yet (outside a checkout: `<from>/Seqcall.CSharp.dll`; the adapter reports a missing file when it starts).
 */
export function resolveCSharpSidecar(explicit?: string, from: string = __dirname): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env[CSHARP_SIDECAR_ENV];
  if (env) return path.resolve(env);
  let dir = path.resolve(from);
  for (;;) {
    const packages = path.join(dir, 'packages');
    if (fs.existsSync(path.join(packages, 'csharp')) || fs.existsSync(path.join(packages, 'core'))) {
      return path.join(dir, CSHARP_SIDECAR_DEV_PATH);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(path.resolve(from), CSHARP_SIDECAR_DLL);
    dir = parent;
  }
}

/**
 * .NET JIT settings for the sidecar and the MSBuild BuildHost it starts (which inherits them). Loading a project is a
 * burst of code that runs for the first time (MSBuild, Roslyn, source generators): with dynamic PGO the hot methods
 * first run instrumented, and the call-counting delay (100 ms, restarted by every new method) keeps them unoptimized
 * through the whole burst. Without both, loading and the design-issue scan after it are clearly faster.
 * A value set by the user wins.
 */
export const CSHARP_SIDECAR_JIT_ENV: Readonly<Record<string, string>> = {
  DOTNET_TieredPGO: '0',
  DOTNET_TC_CallCountingDelayMs: '0',
};

/** The environment of the C# sidecar: `base` plus {@link CSHARP_SIDECAR_JIT_ENV} where `base` has no value. */
export function csharpSidecarEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [k, v] of Object.entries(CSHARP_SIDECAR_JIT_ENV)) env[k] ??= v;
  return env;
}

/**
 * C# LanguageAdapter: the Roslyn sidecar (docs/CSHARP-SIDECAR.md), started lazily as
 * `dotnet <dll> --root <projectRoot> [--solution <sln>]` with the working directory set to
 * the project root (so its global.json selects the SDK).
 */
export function createCSharpAdapter(projectRoot: string, opts: CSharpAdapterOptions = {}): RpcLanguageAdapter & LanguageAdapter {
  const root = projectRoot.replace(/\\/g, '/');
  const dll = resolveCSharpSidecar(opts.sidecarPath);
  const args = [dll, '--root', root, ...(opts.solution ? ['--solution', opts.solution.replace(/\\/g, '/')] : [])];
  return new RpcLanguageAdapter({
    projectRoot: root,
    command: opts.dotnet ?? process.env.SEQCALL_DOTNET ?? 'dotnet',
    args,
    cwd: projectRoot,
    env: csharpSidecarEnv(),
    name: 'C# sidecar',
    log: opts.log,
    initializeParams: opts.solution ? { solution: opts.solution.replace(/\\/g, '/') } : {},
    requestTimeoutMs: opts.requestTimeoutMs,
    initializeTimeoutMs: opts.initializeTimeoutMs,
    precheck: () => {
      if (!fs.existsSync(dll)) {
        throw new Error(
          `C# sidecar not found at ${dll}. Build it (dotnet build packages/csharp -c Release) or set ${CSHARP_SIDECAR_ENV} to the path of ${CSHARP_SIDECAR_DLL}.`,
        );
      }
    },
  });
}
