import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openProject, type Project } from '../src/commands';
import { McpServer, serveMcp, snapshot } from '../src/mcp';

/** The MCP server (FR-27.7) on a small TS project: arguments, options, reloads and what a client may send wrong. */

type Reply = { jsonrpc: string; id: number | string | null; result?: { content: { type: string; text: string }[]; isError?: boolean }; error?: { code: number; message: string } };

function server(opts: { cwd: string; root?: string; open?: (o: Parameters<typeof openProject>[0]) => Project }) {
  const opened: string[] = [];
  const s = new McpServer({
    cwd: opts.cwd,
    root: opts.root,
    open:
      opts.open ??
      ((o) => {
        const p = openProject(o);
        opened.push(p.root);
        return p;
      }),
  });
  let id = 0;
  const call = async (name: string, args?: Record<string, unknown>) => {
    const r = (await s.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } })) as Reply;
    return { text: r.result!.content[0].text, isError: r.result!.isError === true };
  };
  return { s, opened, call };
}

/** Runs serveMcp on the given input lines; returns the replies and log lines. */
async function serve(cwd: string, lines: string[], write: (line: string) => void = () => undefined) {
  const input = new PassThrough();
  const out: Reply[] = [];
  const log: string[] = [];
  const done = serveMcp({ cwd }, input, (l) => (write(l), out.push(JSON.parse(l) as Reply)), (l) => log.push(l));
  input.end(lines.join('\n'));
  await done;
  return { out, log };
}

describe('seqcall MCP server input (FR-27.7)', () => {
  let dir: string;
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' });
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-mcp-input-')).replace(/\\/g, '/');
    fs.writeFileSync(`${dir}/tsconfig.json`, '{"compilerOptions":{"strict":true}}');
    fs.mkdirSync(`${dir}/src`);
    fs.writeFileSync(`${dir}/src/b.ts`, 'export class B {\n  step(): number {\n    return 2;\n  }\n}\n');
    fs.writeFileSync(`${dir}/src/a.ts`, "import { B } from './b';\nexport class A {\n  run(b: B): number {\n    return b.step();\n  }\n}\n");
    git('init', '-q', '-b', 'master');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', 'other');
    git('checkout', '-qb', 'feature');
    fs.writeFileSync(`${dir}/src/b.ts`, 'export class B {\n  step(): number {\n    return 3;\n  }\n}\n');
    git('commit', '-qam', 'three');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('FR-27.7 tool arguments: depth (≥ 1), base, no arguments at all', async () => {
    const { s, call } = server({ cwd: dir });
    try {
      expect(await call('flow', { target: 'src/a.ts:4', depth: 0 })).toEqual({ isError: true, text: '--depth is a number ≥ 1' });
      const one = await call('flow', { target: 'src/a.ts:4', depth: 1, tree: true });
      expect(one.text.split('\n').slice(1)).toEqual(['A.run  src/a.ts:3', '  B.step()  src/a.ts:4', 'I/O: none found in the shown calls', 'issues: none in this flow']);
      // the base asked for, not the default (master)
      expect((await call('review', { base: 'other' })).text.split('\n')[1]).toMatch(/^feature compared since the branch split off other \(\w+, 1 commits\)$/);
      expect((await call('review')).text.split('\n')[1]).toMatch(/^feature compared since the branch split off master /);
      // a tool that needs a method, called without arguments
      expect(await call('impls')).toEqual({ isError: true, text: 'impls needs one method: <file>:<line> or a method key' });
    } finally {
      await s.close();
    }
  });

  it('FR-27.7 --root relative to the current folder: the project there is loaded, targets are relative to it', async () => {
    const { s, opened, call } = server({ cwd: path.dirname(dir), root: path.basename(dir) });
    try {
      const flow = await call('flow', { target: 'src/a.ts:4' });
      expect(flow.isError).toBe(false);
      expect(flow.text.split('\n')[1]).toBe('A.run  src/a.ts:3');
      expect(opened).toEqual([dir]);
    } finally {
      await s.close();
    }
  });

  it('FR-27.7 a changed project file (tsconfig.json) loads the project again; a source file alone does not', async () => {
    const { s, opened, call } = server({ cwd: dir });
    try {
      await call('flow', { target: 'src/a.ts:4' });
      const later = new Date(Date.now() + 5000); // a new mtime even on a coarse clock
      fs.utimesSync(`${dir}/src/b.ts`, later, later);
      await call('flow', { target: 'src/a.ts:4' });
      expect(opened).toEqual([dir]);
      fs.utimesSync(`${dir}/tsconfig.json`, later, new Date(Date.now() + 10000));
      expect((await call('flow', { target: 'src/a.ts:4' })).text.split('\n')[1]).toBe('A.run  src/a.ts:3');
      expect(opened).toEqual([dir, dir]);
    } finally {
      await s.close();
    }
  });

  it('FR-27.7 an analysis error is a tool result marked as such, whatever was thrown', async () => {
    const thrower = (thrown: unknown) =>
      server({
        cwd: dir,
        open: () => {
          throw thrown;
        },
      });
    for (const [thrown, text] of [
      [new Error('sidecar died'), 'analysis error: sidecar died'],
      ['sidecar gone', 'analysis error: sidecar gone'],
    ] as const) {
      const { s, call } = thrower(thrown);
      expect(await call('entrypoints')).toEqual({ isError: true, text });
      await s.close();
    }
  });

  it('FR-27.7 serveMcp: a tool call on the real project; blank lines and notifications get no answer; a message that is no object is an invalid request', async () => {
    const msg = (o: object) => JSON.stringify({ jsonrpc: '2.0', ...o });
    const { out } = await serve(dir, [
      '',
      '   ',
      msg({ method: 'notifications/initialized' }),
      'null',
      '[1, 2]',
      '7',
      msg({ id: 1, method: 'tools/call', params: { name: 'flow', arguments: { target: 'src/a.ts:4' } } }),
    ]);
    expect(out.filter((o) => o.id === null)).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: not a JSON-RPC message object' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: not a JSON-RPC message object' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: not a JSON-RPC message object' } },
    ]);
    const flow = out.find((o) => o.id === 1)!;
    expect(flow.result!.content[0].text.split('\n')[1]).toBe('A.run  src/a.ts:3');
    expect(out).toHaveLength(4);
  });

  it('FR-27.7 serveMcp: a reply that cannot be written is logged and answered with an internal error', async () => {
    const failed = new Set<number>();
    const { out, log } = await serve(dir, ['{"jsonrpc":"2.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":2,"method":"ping"}'], (line) => {
      const r = JSON.parse(line) as Reply;
      if (r.result && typeof r.id === 'number' && !failed.has(r.id)) {
        failed.add(r.id);
        throw r.id === 1 ? new Error('pipe closed') : 'EPIPE';
      }
    });
    expect(out.sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Error: pipe closed' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'EPIPE' } },
    ]);
    expect(log.sort()).toEqual(['seqcall mcp: EPIPE', expect.stringMatching(/^seqcall mcp: Error: pipe closed\n {4}at /)]);
  });

  it('FR-27.7 snapshot: a folder that cannot be read (gone) gives no files', () => {
    expect(snapshot(`${dir}/missing`, 'typescript').size).toBe(0);
  });
});

describe('seqcall MCP server version (FR-27.11)', () => {
  const initialize = async (server: McpServer) =>
    (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })) as {
      result: { serverInfo: { name: string; version: string } };
    };

  it('FR-27.11 the server tells the client the version the package was built with; `dev` when run from source', async () => {
    const fromSource = new McpServer({ cwd: os.tmpdir() });
    expect((await initialize(fromSource)).result.serverInfo).toEqual({ name: 'seqcall', version: 'dev' });
    // the package's bundle defines SEQCALL_VERSION (build.mjs); here as a global before the module is loaded again
    const g = globalThis as { SEQCALL_VERSION?: string };
    vi.resetModules();
    g.SEQCALL_VERSION = '1.4.2';
    try {
      const built = await import('../src/mcp');
      expect((await initialize(new built.McpServer({ cwd: os.tmpdir() }))).result.serverInfo).toEqual({ name: 'seqcall', version: '1.4.2' });
    } finally {
      delete g.SEQCALL_VERSION;
      vi.resetModules();
    }
  });
});
