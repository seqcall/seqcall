import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = path.resolve(__dirname, '..').replace(/\\/g, '/');
const REPO = path.resolve(HERE, '../..').replace(/\\/g, '/');
const PKG = `${HERE}/dist/seqcall-agent`;
const { version } = JSON.parse(fs.readFileSync(`${HERE}/package.json`, 'utf8')) as { version: string };
const json = (rel: string) => JSON.parse(fs.readFileSync(`${PKG}/${rel}`, 'utf8'));

/** Sends MCP messages to the packaged server, started like Claude Code starts it from .mcp.json; the responses. */
function mcp(cwd: string, messages: object[]): Promise<{ id: number; result: { content?: { text: string }[]; serverInfo?: { version: string } } }[]> {
  const server = json('plugin/.mcp.json').mcpServers.seqcall as { command: string; args: string[] };
  const args = server.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', `${PKG}/plugin`));
  const p = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  for (const m of messages) p.stdin.write(`${JSON.stringify(m)}\n`);
  p.stdin.end();
  return new Promise((resolve) => p.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l)))));
}

describe('agent package (FR-27.11)', () => {
  it('FR-27.11 build --package: a Claude Code marketplace with the plugin (MCP server + skill), the CLI with --version, a zip', async () => {
    execFileSync(process.execPath, [`${HERE}/build.mjs`, '--package'], { stdio: 'ignore' });
    expect(fs.existsSync(`${HERE}/dist/seqcall-agent-${version}.zip`)).toBe(true);
    expect(json('.claude-plugin/marketplace.json')).toMatchObject({ name: 'seqcall', plugins: [{ name: 'seqcall', source: './plugin', version }] });
    expect(json('plugin/.claude-plugin/plugin.json')).toMatchObject({ name: 'seqcall', version });
    expect(json('plugin/.mcp.json')).toEqual({ mcpServers: { seqcall: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/seqcall.cjs', 'mcp'] } } });
    expect(json('plugin/package.json')).toMatchObject({ name: 'seqcall', version, bin: { seqcall: 'seqcall.cjs' } });
    const skill = fs.readFileSync(`${PKG}/plugin/skills/seqcall/SKILL.md`, 'utf8');
    expect(skill).toMatch(/^---\nname: seqcall\ndescription: .+\n---\n/);
    for (const tool of ['flow', 'paths', 'entrypoints', 'outcomes', 'impls', 'issues', 'review']) expect(skill).toContain(`\`${tool}`);
    expect(fs.readFileSync(`${PKG}/README.md`, 'utf8')).toContain('claude plugin install seqcall --marketplace');
    expect(fs.existsSync(`${PKG}/plugin/lib.es5.d.ts`)).toBe(true);
    expect(execFileSync(process.execPath, [`${PKG}/plugin/seqcall.cjs`, '--version'], { encoding: 'utf8' }).trim()).toBe(version);
    // the MCP server works from the project directory (Claude Code starts it there), with no other argument
    const [init, call] = await mcp(`${REPO}/fixtures/php-app`, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'entrypoints', arguments: { filter: 'orders:expire' } } },
    ]);
    expect(init.result.serverInfo?.version).toBe(version);
    expect(call.result.content?.[0].text).toContain('orders:expire  ExpireOrders.handle  src/Console/Commands/ExpireOrders.php:13');
  }, 120_000);
});
