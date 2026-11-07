import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagramSession } from '@seqcall/core';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, SAMPLE_APP } from './controller-helpers';

// Info at Caret (FR-33.6 / 33.7) and memory (FR-34.4) through the HeadlessController, for Rider and Vim, on
// fixtures/sample-app (read only).

const SERVICE = `${SAMPLE_APP}/src/services/user-service.ts`;
const REPORT = `${SAMPLE_APP}/src/console/report.ts`;

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of disposers) await d();
  disposers = [];
});

function controller() {
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
  disposers.push(() => c.dispose());
  return { c, r };
}

const plus = (p: { line: number; character: number }, n: number) => ({ line: p.line, character: p.character + n });

describe('HeadlessController: Info at Caret (FR-33.6)', () => {
  it('FR-33.6 on a call: what runs; on an argument nothing; the project loads when asked', async () => {
    const { c } = controller();
    const at = positionOf(SERVICE, 'primary.save');
    expect(await c.describeAt(SERVICE, plus(at, 9), 'save')).toEqual({ lines: ['→ runs one of InMemoryUserRepository, SqlUserRepository'], item: '  · ', plain: ['→ runs one of InMemoryUserRepository, SqlUserRepository'], routes: [], onName: false });
    expect(await c.describeAt(SERVICE, plus(at, 13), 'user')).toBeNull();
  });

  it('FR-33.6 on a method\'s name: the heading, its entry points as items, all of them for the pick list', async () => {
    const { c } = controller();
    const info = (await c.describeAt(REPORT, plus(positionOf(REPORT, 'function report'), 11), 'report'))!;
    expect(info.onName).toBe(true);
    expect(info.lines[0]).toBe('⌂ reached from 1 entry point');
    expect(info.lines[1].startsWith(info.item)).toBe(true);
    expect(info.routes).toHaveLength(1);
    expect(info.plain[1]).toBe(`   1. ${info.routes[0]}`);
    // without the word: the position alone decides
    expect((await c.describeAt(REPORT, plus(positionOf(REPORT, 'function report'), 11)))?.onName).toBe(true);
  });

  it('FR-33.6 a failing analysis: logged, nothing shown', async () => {
    const { c, r } = controller();
    vi.spyOn(DiagramSession.prototype, 'describeAt').mockRejectedValue(new Error('index broken'));
    expect(await c.describeAt(SERVICE, positionOf(SERVICE, 'primary.save'), 'save')).toBeNull();
    expect(r.logs('error')).toEqual(['info: index broken']);
  });

  it('FR-33.7 an entry point opens its flow down to the method (highlighted); paths opens Paths to here; an unknown one says so', async () => {
    const { c, r } = controller();
    const at = plus(positionOf(REPORT, 'function report'), 11);
    await c.openReach(REPORT, at, 'report', 0);
    expect(lastRender(r.seq).root.name).toBe('report');
    expect(r.seq.at(-1)?.type).toBe('highlight');
    await c.openReach(REPORT, at, 'report', 'paths');
    expect(r.seq.at(-1)).toEqual({ type: 'openPanel', panel: 'paths', messageId: 'root' });
    await c.openReach(REPORT, at, undefined, 3);
    expect(r.logs('error')).toEqual(['no entry point 3 reaches the method at the caret']);
    // Paths to here where no method is: no panel
    const n = r.seq.length;
    await c.openReach(SAMPLE_APP + '/package.json', { line: 0, character: 0 }, undefined, 'paths');
    expect(r.seq.slice(n).some((m) => m.type === 'openPanel')).toBe(false);
  });
});

describe('HeadlessController: memory (FR-34.4)', () => {
  it('FR-34.4 this process exactly, a line per loaded project (TS in this process), a summary; Free Memory drops the caches', async () => {
    const { c, r } = controller();
    expect((await c.memory()).lines).toEqual([expect.stringMatching(/^Seqcall \(this process, pid \d+\): \d+ MB$/)]);
    await c.describeAt(SERVICE, positionOf(SERVICE, 'primary.save'), 'save');
    const m = await c.memory();
    expect(m.lines[1]).toBe("sample-app (TypeScript): analysed in Seqcall's own process (above)");
    expect(m.summary).toMatch(/^Seqcall uses \d+ MB\.$/);
    const free = vi.spyOn(DiagramSession.prototype, 'freeMemory');
    expect(await c.freeMemory()).toBe('Seqcall dropped its caches.');
    expect(free).toHaveBeenCalledTimes(1);
    expect(r.logs('info')).toContain('Seqcall dropped its caches.');
  });

  it('FR-34.4 a C# sidecar running: its memory in the summary, and what Free Memory stopped', async () => {
    const { c } = controller();
    await c.describeAt(SERVICE, positionOf(SERVICE, 'primary.save'), 'save');
    vi.spyOn(DiagramSession.prototype, 'processMemory').mockResolvedValue({ analysis: { pid: 9, workingSet: 800 * 1024 * 1024 } });
    expect((await c.memory()).summary).toMatch(/^Seqcall uses \d+ MB, the C# analysis 800 MB\.$/);
    vi.spyOn(DiagramSession.prototype, 'freeMemory').mockResolvedValue();
    expect(await c.freeMemory()).toBe('Seqcall dropped its caches and stopped the C# analysis (800 MB); it loads again with the next diagram.');
  });
});
