import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, SequenceDiagram } from '@seqcall/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClassifier, createCSharpAdapter, DiagramSession, resolveCSharpSidecar } from '../src/index';

/**
 * FR-24.15 the review tour on C# (through the Roslyn sidecar): a copy of fixtures/sample-cs in a temporary git
 * repository whose change gives the repository port's lookup a new parameter — a signature change, which only C#
 * keys show (TS keys have no parameter types) — with both implementations changed (one gets a new helper), and a new
 * call after the port calls. Skipped when dotnet or the sidecar build is unavailable.
 */
const SAMPLE = path.resolve(__dirname, '../../../fixtures/sample-cs');
const available = (() => {
  try {
    execFileSync('dotnet', ['--version'], { cwd: SAMPLE, stdio: 'ignore' });
    return fs.existsSync(resolveCSharpSidecar());
  } catch {
    return false;
  }
})();

let root = '';
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
const edit = (rel: string, from: string | RegExp, to: string) => {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(from, to);
  if (next === text) throw new Error(`no change in ${rel}`);
  fs.writeFileSync(file, next);
};

const weight = (m: Message) => (m.diff?.count ?? 0) + (m.diff?.folded ?? 0);
const sum = (d: SequenceDiagram | undefined) => (d?.messages ?? []).reduce((n, m) => n + weight(m), 0);

describe.skipIf(!available)('FR-24.15 the review tour on C# (Roslyn sidecar)', () => {
  let session: DiagramSession;
  const adapters: { dispose(): Promise<void> }[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-review-cs-')).replace(/\\/g, '/');
    fs.cpSync(SAMPLE, root, { recursive: true, filter: (src) => !/[\\/](bin|obj|\.idea)$/.test(src) });
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // the port's lookup takes a "fresh" flag now
    edit('src/Sample.Core/Interfaces/IUserRepository.cs', 'Task<User?> FindByIdAsync(string id, CancellationToken ct = default);', 'Task<User?> FindByIdAsync(string id, bool fresh, CancellationToken ct = default);');
    // the in-memory one: only its parameters and body
    edit(
      'src/Sample.Infrastructure/Repositories/InMemoryUserRepository.cs',
      /public Task<User\?> FindByIdAsync\(string id, CancellationToken ct = default\) =>\s*Task\.FromResult\(_users\.GetValueOrDefault\(id\)\);/,
      'public Task<User?> FindByIdAsync(string id, bool fresh, CancellationToken ct = default) =>\n        Task.FromResult(fresh ? null : _users.GetValueOrDefault(id));',
    );
    // the SQL one: its query moved into a new helper
    edit(
      'src/Sample.Infrastructure/Repositories/SqlUserRepository.cs',
      /public async Task<User\?> FindByIdAsync\(string id, CancellationToken ct = default\)\s*\{[\s\S]*?return _rows\.FirstOrDefault\(r => r\.Id == id\);\s*\}/,
      'public async Task<User?> FindByIdAsync(string id, bool fresh, CancellationToken ct = default)\n    {\n        return await QueryAsync(id, ct);\n    }\n\n    private async Task<User?> QueryAsync(string id, CancellationToken ct)\n    {\n        Logger.Info($"SELECT * FROM users WHERE id = {id} ({_connectionString})");\n        await Task.Delay(1, ct);\n        return _rows.FirstOrDefault(r => r.Id == id);\n    }',
    );
    // the service passes the flag, and tracks the lookup after the port calls (a new call after them)
    edit('src/Sample.Core/Services/UserService.cs', 'var cached = await _replica.FindByIdAsync(id);', 'var cached = await _replica.FindByIdAsync(id, false);');
    edit('src/Sample.Core/Services/UserService.cs', 'var user = await _primary.FindByIdAsync(id);', 'var user = await _primary.FindByIdAsync(id, true);\n        Track(id);');
    edit('src/Sample.Core/Services/UserService.cs', 'public async Task<UserDto> GetUserDtoAsync(string id)', 'private static string Track(string id) => Format.Title(id);\n\n    public async Task<UserDto> GetUserDtoAsync(string id)');
    // Sample.Batch uses a NuGet package (Autofac): restored from the local cache
    execFileSync('dotnet', ['restore', 'Sample.sln', '-nologo'], { cwd: root, stdio: 'ignore' });
    const make = () => {
      const a = createCSharpAdapter(root);
      adapters.push(a);
      return a;
    };
    session = new DiagramSession({ adapter: make(), classifier: createClassifier(root), createBaseAdapter: make });
  }, 180_000);
  afterAll(async () => {
    await session?.dispose();
    for (const a of adapters) await a.dispose().catch(() => undefined);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('FR-24.15 one total whatever implementation, zoom or direction; the signature change named; the other implementation right after the call', async () => {
    const r = (await session.reviewChanges({ base: 'develop' }))!;
    const names = r.methods.map((m) => `${m.method.owner.name}.${m.method.name}`);
    expect(names).toEqual(expect.arrayContaining(['UserService.FindUserAsync', 'SqlUserRepository.FindByIdAsync', 'SqlUserRepository.QueryAsync', 'InMemoryUserRepository.FindByIdAsync']));
    const get = r.methods.find((m) => m.method.name === 'QueryAsync')!.reachedFrom.find((x) => x.entryPoint.method.key.includes('UsersController.Get('))!.entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === get.method.key).map((x) => x.steps));
    const opened = (await session.openChangeFlow(paths, get))!.diagram!;
    const total = opened.reviewTotal!;
    expect(total).toBeGreaterThanOrEqual(8);
    expect(sum(opened)).toBe(total);

    // forward, back, forward: each change drawn at its number, the same calls each time
    const at: { n: number; id: string; impl: string }[] = [];
    const walk = async (ns: number[]) => {
      const seen: string[] = [];
      for (const n of ns) {
        const shown = (await session.showChange(n))!;
        const m = shown.diagram!.messages.find((x) => x.id === shown.messageId)!;
        expect(m.diff?.positions?.map((p) => p.n), `change ${n}`).toContain(n);
        expect(shown.diagram!.reviewTotal).toBe(total);
        seen.push(`${n} ${m.id} ${m.polymorphic?.selectedKey ?? ''}`);
      }
      return seen;
    };
    const up = Array.from({ length: total }, (_, i) => i + 1);
    const forward = await walk(up);
    for (const x of forward) {
      const [n, id, impl] = x.split(' ');
      at.push({ n: Number(n), id, impl });
    }
    const backward = await walk([...up].reverse());
    expect(backward).toEqual([...forward].reverse());
    expect(await walk(up)).toEqual(forward);

    // the port calls: their signature changed (no "was" naming itself), both implementations visited
    const d = (await session.showChange(1))!.diagram!;
    const ports = at.filter((x) => /:FindByIdAsync$/.test(x.id));
    expect(new Set(ports.map((x) => x.impl).filter(Boolean)).size).toBe(2);
    const portCall = (await session.showChange(ports[0].n))!.diagram!.messages.find((m) => m.id === ports[0].id)!;
    expect(portCall.diff).toMatchObject({ status: 'changed', signature: true });
    expect(portCall.diff?.before).toBeUndefined();
    // the changes of a port call (its own, below it, in either implementation) are one run of numbers: the other
    // implementation's come right after, before the next change of the service (Track)
    for (const id of new Set(ports.map((x) => x.id))) {
      const ns = at.filter((x) => x.id === id || x.id.startsWith(`${id}/`)).map((x) => x.n);
      expect(Math.max(...ns) - Math.min(...ns) + 1, `numbers under ${id}: ${ns}`).toBe(ns.length);
    }
    const track = at.find((x) => /:Track$/.test(x.id))!;
    expect(track.n).toBeGreaterThan(Math.max(...at.filter((x) => x.id.includes(':FindByIdAsync')).map((x) => x.n)));
    expect(d.reviewTotal).toBe(total);

    // the same total with the other implementation picked, back to the interface, zoomed to layers
    const call = d.messages.find((m) => m.methodName === 'FindByIdAsync' && m.polymorphic) ?? (await session.showChange(ports[0].n))!.diagram!.messages.find((m) => m.id === ports[0].id)!;
    const other = call.polymorphic!.implementations.find((i) => i.key !== call.polymorphic!.selectedKey)!;
    for (const view of [await session.selectImplementation(call.id, other.key), await session.revertImplementation(call.id), await session.setOption('layerZoom', true), await session.expandEverything()]) {
      expect(view!.reviewTotal).toBe(total);
      expect(sum(view)).toBe(total);
    }
    await session.setOption('layerZoom', false);
  }, 240_000);
});
