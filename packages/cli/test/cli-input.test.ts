import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';

/** Wrong arguments and failing analyses: the exit code and the one error line an agent reads (FR-27.5). */

async function cli(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { cwd, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const HINT = '\n(seqcall --help for usage)';

describe('seqcall CLI input (FR-27.5)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-input-')).replace(/\\/g, '/');
    fs.writeFileSync(`${dir}/tsconfig.json`, '{"compilerOptions":{"strict":true}}');
    fs.mkdirSync(`${dir}/src`);
    fs.writeFileSync(`${dir}/src/a.ts`, 'export class A {\n  run(): number {\n    return 1;\n  }\n}\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('FR-27.5 each wrong argument is a usage error (exit 2) that says what is wrong', async () => {
    const cases: [string[], string][] = [
      [['flow', 'src/a.ts:2', '--root'], '--root needs a value'],
      [['flow', 'src/a.ts:2', 'src/a.ts:3'], 'flow needs one method: <file>:<line> or a method key'],
      [['paths', 'src/a.ts:2', '--depth', '0'], '--depth is a number ≥ 1'],
      [['flow', 'src/a.ts:2', '--depth', 'two'], '--depth is a number ≥ 1'],
      [['review', 'src/a.ts:2'], 'review takes no method'],
      [['flow', 'src/a.ts:2', '--format', 'xml'], '--format is text or json'],
      [['flow', 'src/a.ts:2', '--verbose'], 'unknown option --verbose'],
      [['explain', 'src/a.ts:2'], 'unknown command "explain"'],
      [['flow', 'src/a.ts'], 'not a method: "src/a.ts" (use <file>:<line> or a method key such as src/x.ts#Class.method)'],
    ];
    for (const [args, message] of cases) expect(await cli(args, dir), args.join(' ')).toEqual({ code: 2, out: '', err: `seqcall: ${message}${HINT}` });
  });

  it('FR-27.5 help: --help and `help` exit 0, no command at all prints the usage and exits 2', async () => {
    for (const args of [['--help'], ['help'], ['flow', '--help']]) {
      const r = await cli(args, dir);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.out).toMatch(/^seqcall — call flows for AI agents/);
    }
    expect((await cli([], dir)).code).toBe(2);
  });

  it('FR-27.5 a method that is not there: the key, the file, the line (exit 2) for flow, paths and impls', async () => {
    for (const command of ['flow', 'paths', 'impls']) {
      expect(await cli([command, 'src/a.ts#A.nope'], dir), command).toEqual({ code: 2, out: '', err: `seqcall: no method with key src/a.ts#A.nope${HINT}` });
      expect(await cli([command, 'src/b.ts:2'], dir), command).toEqual({ code: 2, out: '', err: `seqcall: no such file: ${dir}/src/b.ts${HINT}` });
      expect(await cli([command, 'src/a.ts:99'], dir), command).toEqual({ code: 2, out: '', err: `seqcall: ${dir}/src/a.ts has no line 99${HINT}` });
    }
  });

  it('FR-27.5 an analysis that fails exits 3 without the usage hint; SEQCALL_DEBUG shows the C# sidecar log', async () => {
    const cs = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-cs-')).replace(/\\/g, '/');
    const env = { dotnet: process.env.SEQCALL_DOTNET, debug: process.env.SEQCALL_DEBUG };
    try {
      fs.writeFileSync(`${cs}/App.csproj`, '<Project Sdk="Microsoft.NET.Sdk"></Project>');
      fs.writeFileSync(`${cs}/A.cs`, 'class A {\n  void Run() {\n  }\n}\n');
      // a sidecar that cannot start: the dll exists, the dotnet command does not
      process.env.SEQCALL_DOTNET = `${cs}/no-dotnet`;
      delete process.env.SEQCALL_DEBUG;
      const quiet = await cli(['flow', 'A.cs:2', '--csharp-sidecar', `${cs}/A.cs`], cs);
      expect(quiet.code).toBe(3);
      expect(quiet.err.split('\n')).toHaveLength(1);
      expect(quiet.err).toMatch(/^seqcall: .*no-dotnet/);
      process.env.SEQCALL_DEBUG = '1';
      const debug = await cli(['flow', 'A.cs:2', '--csharp-sidecar', `${cs}/A.cs`], cs);
      expect(debug.code).toBe(3);
      const lines = debug.err.split('\n');
      expect(lines[0]).toBe(`[C#] [seqcall] starting C# sidecar: ${cs}/no-dotnet ${cs}/A.cs --root ${cs}`);
      expect(lines[lines.length - 1]).toBe(quiet.err);
    } finally {
      for (const [k, v] of [['SEQCALL_DOTNET', env.dotnet], ['SEQCALL_DEBUG', env.debug]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(cs, { recursive: true, force: true });
    }
  });
});
