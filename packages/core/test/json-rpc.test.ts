import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcExitError, RpcProcess, RpcResponseError, RpcTimeoutError } from '../src/rpc/json-rpc';

// The client side of the sidecar protocol (newline-delimited JSON-RPC 2.0 on stdio, docs/CSHARP-SIDECAR.md; no FR row
// of its own): peers written per test as small Node scripts that answer in the ways a sidecar can.
const procs: RpcProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

/** A peer running `script` (it gets `send(obj)` and `onRequest(fn(req))`). */
function peer(script: string, log?: (line: string) => void): RpcProcess {
  const prelude = `
    const send = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\\n');
    const handlers = [];
    const onRequest = (fn) => handlers.push(fn);
    require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => handlers.forEach((h) => h(JSON.parse(l))));
  `;
  const p = new RpcProcess({ command: process.execPath, args: ['-e', prelude + script], cwd: process.cwd(), name: 'Test sidecar', log });
  procs.push(p);
  return p;
}

describe('JSON-RPC peer process (sidecar protocol)', () => {
  it('skips blank lines, logs lines that are not JSON-RPC, ignores notifications; an answer without result is null', async () => {
    const logged: string[] = [];
    const p = peer(
      `onRequest((r) => { send(''); send('warming up'); send({ jsonrpc: '2.0', method: 'progress' }); send({ jsonrpc: '2.0', id: String(r.id), result: 'wrong id type' }); send({ jsonrpc: '2.0', id: r.id }); });`,
      (l) => logged.push(l),
    );
    expect(await p.request('stats', {}, 5000)).toBeNull();
    expect(logged).toContain('[stdout, not JSON-RPC] warming up');
    expect(logged.filter((l) => l.startsWith('[stdout'))).toHaveLength(1);
  });

  it('an error answer without code or message: internal error, "unknown error"', async () => {
    const p = peer(`onRequest((r) => send({ jsonrpc: '2.0', id: r.id, error: {} }));`);
    const e = await p.request('getMethod', { key: 'k' }, 5000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcResponseError);
    expect(e).toMatchObject({ method: 'getMethod', code: -32603, message: 'Test sidecar: "getMethod" failed: unknown error' });
  });

  it('an answer after the timeout is dropped; without a timeout a request waits', async () => {
    const p = peer(`onRequest((r) => setTimeout(() => send({ jsonrpc: '2.0', id: r.id, result: r.method }), r.method === 'slow' ? 300 : 0));`);
    await expect(p.request('slow', {}, 50)).rejects.toThrow(new RpcTimeoutError('Test sidecar: "slow" timed out after 0 s'));
    // the late answer to `slow` arrives meanwhile and is dropped; this one has no timer
    await new Promise((r) => setTimeout(r, 400));
    expect(await p.request('fast', {}, 0)).toBe('fast');
  });

  it('an answered request leaves no timer behind (a CLI run would otherwise wait for it before exiting)', async () => {
    const p = peer(`onRequest((r) => send({ jsonrpc: '2.0', id: r.id, result: 1 }));`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await p.request('stats', {}, 60_000)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('params that cannot be written are rejected without sending; the process stays', async () => {
    const p = peer(`onRequest((r) => send({ jsonrpc: '2.0', id: r.id, result: 'ok' }));`);
    await expect(p.request('updateFile', { size: 1n }, 5000)).rejects.toThrow(/^Test sidecar: cannot send "updateFile": .*BigInt/);
    expect(p.isAlive).toBe(true);
    expect(await p.request('stats', {}, 5000)).toBe('ok');
  });

  it('the exit fails what is pending with the last stderr lines; later requests fail at once; kill after exit does nothing', async () => {
    const p = peer(`for (let i = 1; i <= 25; i++) process.stderr.write('line ' + i + '\\n'); onRequest(() => setTimeout(() => process.exit(3), 50));`);
    const e = await p.request('getOutgoingCalls', {}, 5000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcExitError);
    expect((e as Error).message).toBe('Test sidecar exited (code 3)\nline 21\nline 22\nline 23\nline 24\nline 25');
    await p.exited;
    expect(p.isAlive).toBe(false);
    await expect(p.request('stats', {}, 5000)).rejects.toBe(e);
    p.kill();
    // without stderr output: the exit code only
    const quiet = peer(`onRequest(() => process.exit(4));`);
    await expect(quiet.request('stats', {}, 5000)).rejects.toThrow(/^Test sidecar exited \(code 4\)$/);
  });

  it('a command that cannot be started rejects with the reason', async () => {
    const p = new RpcProcess({ command: '/nonexistent/dotnet', args: [], cwd: process.cwd(), name: 'C# sidecar' });
    await p.exited;
    await expect(p.request('initialize', {}, 5000)).rejects.toThrow(/^C# sidecar could not be started \(\/nonexistent\/dotnet\): .*ENOENT/);
  });
});
