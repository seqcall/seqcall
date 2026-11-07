import { describe, expect, it } from 'vitest';
import type { ProcessMemory } from '@seqcall/protocol';
import { call, cls, fakeAdapter, fakeSession, meth, type World } from './fake-world';
import { memoryLines, memorySummary, processBytes } from '../src/memory';

const Service = cls('src/service.ts', 'Service');
const run = meth(Service, 'run');
const helper = meth(Service, 'helper');
const mb = (n: number): ProcessMemory => ({ pid: 7, workingSet: n * 1024 * 1024 });

/** A world whose adapter counts its body requests and releases, and reports `memory`. */
function counting(memory?: ProcessMemory) {
  const counts = { outgoing: 0, released: 0 };
  const world: World = {
    methods: [run, helper],
    calls: { [run.key]: [call(0, helper)] },
    adapter: {
      getOutgoingCalls: async (m: { key: string }) => {
        counts.outgoing++;
        return m.key === run.key ? [call(0, helper)] : [];
      },
      ...(memory ? { getMemory: async () => memory, release: async () => void counts.released++ } : {}),
    },
  };
  return { world, counts };
}

describe('FR-34 memory', () => {
  it('FR-34.1 the analysis process\'s memory, and the base version\'s during a review; in-process adapters: none', async () => {
    const { world } = counting(mb(800));
    const s = fakeSession(world);
    expect(await s.processMemory()).toEqual({ analysis: mb(800) });
    // a review's base version runs in a process of its own
    (s as unknown as { base: unknown }).base = { adapter: fakeAdapter({ methods: [], adapter: { getMemory: async () => mb(300) } }) };
    expect(await s.processMemory()).toEqual({ analysis: mb(800), base: mb(300) });
    expect(await fakeSession(counting().world).processMemory()).toEqual({});
  });

  it('FR-34.2 free memory drops the caches (the next diagram reads the bodies again) and releases the processes; the diagram stays', async () => {
    const { world, counts } = counting(mb(800));
    const s = fakeSession(world);
    const before = (await s.openMethodByKey(run.key))!;
    const read = counts.outgoing;
    let baseReleased = 0;
    (s as unknown as { base: unknown }).base = { adapter: fakeAdapter({ methods: [], adapter: { release: async () => void baseReleased++ } }) };
    await s.freeMemory();
    expect(counts.released).toBe(1);
    expect(baseReleased).toBe(1);
    expect(s.current()).toBe(before);
    await s.openMethodByKey(run.key);
    expect(counts.outgoing).toBeGreaterThan(read);
    // an adapter without a process of its own: only the caches
    await fakeSession(counting().world).freeMemory();
  });
});

describe('FR-34.3 the report\'s text', () => {
  const inHost = 'runs in the extension host';
  it('FR-34.3 a line per project: the C# process with its heap and pid, the base version, not running; TS / PHP in the host', () => {
    expect(
      memoryLines(
        [
          { name: 'shop', language: 'csharp', analysis: { pid: 12, workingSet: 812 * 1024 * 1024, managedHeap: 410 * 1024 * 1024 }, base: mb(300) },
          { name: 'batch', language: 'csharp', analysis: mb(100) },
          { name: 'idle', language: 'csharp' },
          { name: 'web', language: 'typescript' },
          { name: 'api', language: 'php' },
        ],
        inHost,
      ),
    ).toEqual([
      'shop (C#): C# analysis 812 MB (managed heap 410 MB), pid 12; base version for the review 300 MB, pid 7',
      'batch (C#): C# analysis 100 MB, pid 7',
      'idle (C#): C# analysis not running',
      'web (TypeScript): runs in the extension host',
      'api (PHP): runs in the extension host',
    ]);
    expect(memoryLines([], inHost)).toEqual(['No project loaded.']);
  });

  it('FR-34.3 the summary: what the processes hold, or that none runs', () => {
    expect(memorySummary([{ name: 'a', language: 'csharp', analysis: mb(500), base: mb(100) }, { name: 'b', language: 'typescript' }])).toBe('The C# analysis holds 600 MB (1 project).');
    expect(memorySummary([{ name: 'a', language: 'csharp', analysis: mb(500) }, { name: 'c', language: 'csharp', base: mb(20) }])).toBe('The C# analysis holds 520 MB (2 projects).');
    expect(memorySummary([{ name: 'b', language: 'php' }])).toMatch(/^No analysis process is running/);
    expect(processBytes([{ name: 'b', language: 'php' }])).toBe(0);
  });
});
