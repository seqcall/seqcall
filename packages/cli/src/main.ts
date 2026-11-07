/** Entry of the bundled CLI: `node seqcall.cjs <command> …` (FR-27). Results on stdout, diagnostics on stderr. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from './cli';
import { serveMcp, VERSION } from './mcp';
import { runUpdate } from './update';
import { runCommand } from '@seqcall/stdio-host';

// Anything printed by libraries must not mix with the result on stdout.
const write = (text: string) => process.stdout.write(`${text}\n`);
const err = (t: string) => process.stderr.write(`${t}\n`);
console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);

const argv = process.argv.slice(2);
// the packaged CLI carries the C# sidecar next to itself (build.mjs --package)
const bundled = path.join(__dirname, 'csharp', 'Seqcall.CSharp.dll');
if (!process.env.SEQCALL_CSHARP_SIDECAR && fs.existsSync(bundled)) process.env.SEQCALL_CSHARP_SIDECAR = bundled;
if (argv[0] === '--version') {
  write(VERSION);
} else if (argv[0] === 'update') {
  // FR-30.7 the latest release in place of the unpacked agent package
  const i = argv.indexOf('--dir');
  void runUpdate({ dir: i > 0 ? argv[i + 1] : undefined, bundleDir: __dirname, env: process.env, home: os.homedir(), version: VERSION, fetch, run: runCommand, log: write }).then((code) =>
    process.stdout.write('', () => process.exit(code)),
  );
} else if (argv[0] === 'mcp') {
  // FR-27.7 an MCP server on stdin / stdout until the client closes stdin
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i > 0 ? argv[i + 1] : undefined;
  };
  void serveMcp({ cwd: process.cwd(), root: value('--root'), csharpSidecar: value('--csharp-sidecar'), log: (l) => process.env.SEQCALL_DEBUG && err(l) }, process.stdin, write, err).then(() =>
    process.stdout.write('', () => process.exit(0)),
  );
} else {
  void runCli(argv, { cwd: process.cwd(), out: write, err }).then((code) => {
    process.exitCode = code;
    // the C# sidecar or TS watchers may hold the event loop: leave once stdout is flushed
    process.stdout.write('', () => process.exit(code));
  });
}
