import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli';
import { openProject, type Project } from '../src/commands';
import { changedFiles, McpServer, serveMcp, snapshot } from '../src/mcp';

const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
const PHP = `${REPO}/fixtures/php-app`;

/** A server whose project loads are counted. */
function server(root: string) {
  const opened: string[] = [];
  const s = new McpServer({
    cwd: root,
    open: (o) => {
      const p: Project = openProject(o);
      opened.push(p.root);
      return p;
    },
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await s.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as {
      result: { content: { type: string; text: string }[]; isError?: boolean };
    };
    return { text: r.result.content[0].text, isError: r.result.isError === true };
  };
  return { s, opened, call };
}

/** The text without its timing header (`# seqcall flow · php · <root> · 12 ms`). */
const body = (text: string) => text.split('\n').slice(1).join('\n');

async function cliText(args: string[], cwd: string) {
  const out: string[] = [];
  const code = await runCli(args, { cwd, out: (t) => out.push(t), err: () => undefined });
  expect(code).toBe(0);
  return out.join('\n');
}

describe('seqcall MCP server (FR-27.7)', () => {
  it('FR-27.7 initialize answers the client\'s protocol version; tools/list has flow, paths and review with their parameters', async () => {
    const { s } = server(PHP);
    const init = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })) as {
      result: { protocolVersion: string; capabilities: object; serverInfo: { name: string }; instructions: string };
    };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.serverInfo.name).toBe('seqcall');
    expect(init.result.instructions).toContain('paths');
    const unknownVersion = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as { result: { protocolVersion: string } };
    expect(unknownVersion.result.protocolVersion).toBe('2025-06-18');
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const list = (await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(['flow', 'paths', 'review', 'entrypoints', 'outcomes', 'issues', 'unreachable', 'impls']);
    const [flow, paths, review, entrypoints, outcomes, , unreachable, impls] = list.result.tools;
    expect(Object.keys(flow.inputSchema.properties)).toEqual(['target', 'depth', 'tree', 'format']);
    expect(flow.inputSchema.required).toEqual(['target']);
    expect(Object.keys(paths.inputSchema.properties)).toEqual(['target', 'tests', 'code', 'format']);
    expect(review.inputSchema.required).toBeUndefined();
    expect(Object.keys(entrypoints.inputSchema.properties)).toEqual(['filter', 'tests', 'format']);
    expect(Object.keys(outcomes.inputSchema.properties)).toEqual(['filter', 'detail', 'format']);
    expect(init.result.instructions).toContain('`outcomes`');
    expect(impls.inputSchema.required).toEqual(['target']);
    expect(Object.keys(unreachable.inputSchema.properties)).toEqual(['format']);
    expect(await s.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(await s.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'method not found: resources/list' } });
    await s.close();
  });

  it('FR-27.7 a tool call gives the same text as the CLI; the project is loaded once for all calls', async () => {
    const { s, opened, call } = server(PHP);
    try {
      const flow = await call('flow', { target: 'src/Console/Commands/ExpireOrders.php:15' });
      expect(flow.isError).toBe(false);
      expect(body(flow.text)).toBe(body(await cliText(['flow', 'src/Console/Commands/ExpireOrders.php:15'], PHP)));
      const tree = await call('flow', { target: 'src/Console/Commands/ExpireOrders.php:15', tree: true, format: 'json' });
      expect(JSON.parse(tree.text).result.calls).toHaveLength(1);
      const paths = await call('paths', { target: 'src/Domain/Pricing.php:9', tests: true });
      expect(body(paths.text)).toBe(body(await cliText(['paths', '--tests', 'src/Domain/Pricing.php:9'], PHP)));
      const ep = await call('entrypoints', { filter: 'orders:expire' });
      expect(body(ep.text)).toBe(body(await cliText(['entrypoints', 'orders:expire'], PHP)));
      const out = await call('outcomes', { filter: 'orders', detail: true });
      expect(body(out.text)).toBe(body(await cliText(['outcomes', 'orders', '--detail'], PHP)));
      const impls = await call('impls', { target: 'src/Payments/PaymentGateway.php:7' });
      expect(impls.text).toContain('implementations (1):\n  StripeGateway.charge  src/Payments/StripeGateway.php:9');
      expect(opened).toEqual([PHP]);
    } finally {
      await s.close();
    }
  });

  it('FR-27.7 a file changed between two calls is read again (no reload of the project)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-mcp-')).replace(/\\/g, '/');
    fs.cpSync(`${REPO}/fixtures/sample-app`, tmp, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const { s, opened, call } = server(tmp);
    try {
      const before = await call('flow', { target: 'src/controllers/user-controller.ts:12', tree: true });
      expect(before.text).not.toContain('Logger.warn');
      const file = `${tmp}/src/controllers/user-controller.ts`;
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    Logger.info(`getUser ${id}`);\n', "    Logger.info(`getUser ${id}`);\n    Logger.warn('changed');\n"));
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); // a new mtime even on a coarse clock
      const after = await call('flow', { target: 'src/controllers/user-controller.ts:12', tree: true });
      expect(after.text).toContain("Logger.warn('changed')");
      expect(opened).toHaveLength(1);
    } finally {
      await s.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-27.7 errors are tool results (isError) the agent can read: no method there, missing target, unknown tool', async () => {
    const { s, call } = server(PHP);
    try {
      const missing = await call('flow', {});
      expect(missing).toEqual({ isError: true, text: 'flow needs one method: <file>:<line> or a method key' });
      const noFile = await call('paths', { target: 'src/Nope.php:3' });
      expect(noFile.isError).toBe(true);
      expect(noFile.text).toBe(`no such file: ${PHP}/src/Nope.php`);
      expect(await call('explain', {})).toEqual({ isError: true, text: 'unknown tool "explain"' });
    } finally {
      await s.close();
    }
  });

  it('FR-27.7 serveMcp: newline-delimited JSON-RPC on a stream; a bad line is a parse error; ends when the input ends', async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serveMcp({ cwd: PHP }, input, (l) => lines.push(l), () => undefined);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n{oops\n`);
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await done;
    const out = lines.map((l) => JSON.parse(l) as { id: number | null; result?: { tools?: unknown[] }; error?: { code: number } });
    // answers may come in any order (JSON-RPC matches them by id)
    expect(out.map((o) => o.id).sort()).toEqual([1, 2, null]);
    expect(out.find((o) => o.id === null)?.error?.code).toBe(-32700);
    expect(out.find((o) => o.id === 2)?.result?.tools).toHaveLength(8);
  });

  it('FR-27.7 snapshot: the language\'s source files and project files, not node_modules / vendor / bin / obj', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-snap-')).replace(/\\/g, '/');
    try {
      for (const f of ['src/A.cs', 'src/App.csproj', 'bin/X.cs', 'obj/Y.cs', 'node_modules/z/i.cs', 'src/readme.md', '.seqcall.json'])
        fs.mkdirSync(path.dirname(`${tmp}/${f}`), { recursive: true }), fs.writeFileSync(`${tmp}/${f}`, '');
      const before = snapshot(tmp, 'csharp');
      expect([...before.keys()].map((f) => f.slice(tmp.length + 1)).sort()).toEqual(['.seqcall.json', 'src/A.cs', 'src/App.csproj']);
      fs.writeFileSync(`${tmp}/src/B.cs`, '');
      fs.rmSync(`${tmp}/src/A.cs`);
      expect(changedFiles(before, snapshot(tmp, 'csharp')).map((f) => f.slice(tmp.length + 1))).toEqual(['src/B.cs', 'src/A.cs']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
