import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagramSession } from '@seqcall/core';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, REPO, shopProject, tempProject, trackScans, TSCONFIG, type Recorded } from './controller-helpers';

// Shared diagram states (FR-25.2) in both views, and the HeadlessController when its work overlaps: a newer diagram
// while an older operation still runs, failures of the background work.

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanups) await f();
  cleanups = [];
});

function shop() {
  const p = shopProject();
  cleanups.push(() => p.rm());
  return p;
}

function controller(workspace?: string): { c: HeadlessController; r: Recorded } {
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace });
  cleanups.push(() => c.dispose());
  return { c, r };
}

async function openShow(c: HeadlessController, p: ReturnType<typeof shopProject>) {
  const file = p.file('src/presentation/orders.controller.ts');
  await c.openAt(file, positionOf(file, 'return new OrderService().place()'));
}

/** Resolves the returned promise's `release` later: an operation held until the test lets it go on. */
function gate() {
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  return { until, release };
}

describe('HeadlessController: shared diagram states (FR-25.2)', () => {
  it('FR-25.2 the class view copies and downloads the flow\'s state; it gets the answer, the sequence view nothing', async () => {
    const p = shop();
    const { c, r } = controller(p.root);
    await openShow(c, p);
    await c.onClassMessage({ type: 'ready' });
    const seqBefore = r.seq.length;
    await c.onClassMessage({ type: 'copyState' });
    await c.onClassMessage({ type: 'copyState', save: true });
    const [copied, saved] = r.cls.filter((m) => m.type === 'diagramState');
    if (copied?.type !== 'diagramState' || !copied.text) throw new Error(JSON.stringify(r.cls));
    expect(JSON.parse(copied.text).root).toEqual({ key: 'src/presentation/orders.controller.ts#OrdersController.show', label: 'OrdersController.show' });
    expect(copied).not.toHaveProperty('save');
    expect(saved).toMatchObject({ type: 'diagramState', save: true, name: 'OrdersController.show.seqcall.json' });
    expect(r.seq.length).toBe(seqBefore);
  });

  it('FR-25.2 a state that cannot be made is reported in the view that asked; the diagram gone meanwhile: nothing to share', async () => {
    const p = shop();
    const { c, r } = controller(p.root);
    await openShow(c, p);
    vi.spyOn(DiagramSession.prototype, 'exportState').mockRejectedValueOnce(new Error('git failed')).mockRejectedValueOnce(new Error('git failed'));
    await c.onSequenceMessage({ type: 'copyState' });
    await c.onClassMessage({ type: 'copyState' });
    expect(r.seq.at(-1)).toEqual({ type: 'diagramState', error: 'git failed' });
    expect(r.cls.at(-1)).toEqual({ type: 'diagramState', error: 'git failed' });
    expect(r.logs('error')).toEqual(['copy state: git failed', 'copy state: git failed']);

    // the root method deleted while the copy waits for the refresh before it
    const file = p.file('src/presentation/orders.controller.ts');
    fs.writeFileSync(file, 'export class OrdersController {}\n');
    const refreshing = c.filesChanged([file]);
    await c.onSequenceMessage({ type: 'copyState' });
    await refreshing;
    expect(r.seq.filter((m) => m.type === 'diagramState').at(-1)).toEqual({ type: 'diagramState', error: 'No diagram to share.' });
  });

  it('FR-25.2 a state whose code is not in this workspace says which project to open it in (and where), in both views when the class view asked', async () => {
    const p = shop();
    const sender = controller(p.root);
    await openShow(sender.c, p);
    await sender.c.onSequenceMessage({ type: 'copyState' });
    const copied = sender.r.seq.at(-1);
    if (copied?.type !== 'diagramState' || !copied.text) throw new Error(JSON.stringify(copied));
    const state = JSON.parse(copied.text);
    const name = state.project.name;
    expect(state.project.dir).toBeUndefined(); // no git: no folder recorded

    const { c, r } = controller(); // no workspace, nothing loaded
    await c.onSequenceMessage({ type: 'openState', text: copied.text });
    const notHere = `src/presentation/orders.controller.ts is not in this workspace. Open the state in the project ${name}.`;
    expect(r.seq).toEqual([{ type: 'stateReport', error: notHere }]);
    await c.onClassMessage({ type: 'openState', text: JSON.stringify({ ...state, project: { ...state.project, dir: 'work/shop' } }) });
    const withDir = `src/presentation/orders.controller.ts is not in this workspace. Open the state in the project ${name} (work/shop).`;
    expect(r.seq.at(-1)).toEqual({ type: 'stateReport', error: withDir });
    expect(r.cls).toEqual([{ type: 'stateReport', error: withDir }]);
    expect(r.logs('error')).toEqual([`open state: ${notHere}`, `open state: ${withDir}`]);
  });
});

describe('HeadlessController: overlapping work and background failures', () => {
  it('FR-15.2 an operation of the previous diagram that ends after a newer diagram opened draws nothing', async () => {
    const p = shop();
    const q = tempProject('invoice', { 'tsconfig.json': TSCONFIG, 'src/invoice.ts': 'export class Invoice {\n  total(): number {\n    return this.sum();\n  }\n  sum(): number {\n    return 1;\n  }\n}\n' });
    cleanups.push(() => q.rm());
    const { c, r } = controller();
    await openShow(c, p);
    await c.onClassMessage({ type: 'ready' });
    const held = gate();
    const expand = DiagramSession.prototype.expand;
    vi.spyOn(DiagramSession.prototype, 'expand').mockImplementationOnce(async function (this: DiagramSession, id: string) {
      await held.until;
      return expand.call(this, id);
    });
    const expanding = c.onSequenceMessage({ type: 'expand', messageId: 'root/1:place' });
    await c.openAt(q.file('src/invoice.ts'), positionOf(q.file('src/invoice.ts'), 'return this.sum()'));
    const counts = [r.seq.length, r.cls.length];
    held.release();
    await expanding;
    expect([r.seq.length, r.cls.length]).toEqual(counts);
    expect(lastRender(r.seq).root.name).toBe('total');
  });

  it('FR-12.4 a class diagram of the previous diagram that ends after a newer diagram opened is not shown', async () => {
    const p = shop();
    const q = tempProject('invoice', { 'tsconfig.json': TSCONFIG, 'src/invoice.ts': 'export class Invoice {\n  total(): number {\n    return 1;\n  }\n}\n' });
    cleanups.push(() => q.rm());
    const { c, r } = controller();
    await openShow(c, p);
    const held = gate();
    const derive = DiagramSession.prototype.getClassDiagram;
    vi.spyOn(DiagramSession.prototype, 'getClassDiagram').mockImplementationOnce(async function (this: DiagramSession) {
      await held.until;
      return derive.call(this);
    });
    const ready = c.onClassMessage({ type: 'ready' });
    await c.openAt(q.file('src/invoice.ts'), positionOf(q.file('src/invoice.ts'), 'return 1'));
    held.release();
    await ready;
    const renders = r.cls.filter((m) => m.type === 'render');
    expect(renders).toHaveLength(1);
    expect(renders[0].type === 'render' && renders[0].diagram.classes.map((x) => x.name)).toEqual(['Invoice']);
  });

  it('FR-17.5 the background I/O scan of the previous diagram that ends after a newer diagram opened draws nothing', async () => {
    const p = shop();
    const q = tempProject('invoice', { 'tsconfig.json': TSCONFIG, 'src/invoice.ts': 'export class Invoice {\n  total(): number {\n    return 1;\n  }\n}\n' });
    cleanups.push(() => q.rm());
    const { c, r } = controller();
    const held = gate();
    const scan = DiagramSession.prototype.scanSideEffects;
    let previous: Promise<unknown> | undefined;
    vi.spyOn(DiagramSession.prototype, 'scanSideEffects').mockImplementationOnce(function (this: DiagramSession) {
      const session = this;
      // the scan finds deeper badges (a re-render), but only after the user moved on
      previous = (async () => {
        await held.until;
        return (await scan.call(session)) ?? session.current();
      })();
      return previous as ReturnType<typeof scan>;
    });
    await openShow(c, p);
    await c.openAt(q.file('src/invoice.ts'), positionOf(q.file('src/invoice.ts'), 'return 1'));
    const n = r.seq.length;
    held.release();
    await previous;
    await new Promise((res) => setTimeout(res, 0));
    expect(r.seq.length).toBe(n);
    expect(lastRender(r.seq).root.name).toBe('total');
  });

  it('FR-15.2 / FR-17.5 a failed diagram operation is shown in the view; a failed background I/O scan only logged', async () => {
    const p = shop();
    const { c, r } = controller(p.root);
    const scans = trackScans();
    await openShow(c, p);
    await scans.settled();
    vi.spyOn(DiagramSession.prototype, 'expand').mockRejectedValueOnce(new Error('sidecar gone'));
    await c.onSequenceMessage({ type: 'expand', messageId: 'root/1:place' });
    expect(r.seq.at(-1)).toEqual({ type: 'error', message: 'sidecar gone' });
    expect(r.logs('error')).toEqual(['expand: sidecar gone']);
    vi.mocked(DiagramSession.prototype.scanSideEffects).mockRejectedValueOnce(new Error('scan broke'));
    await c.onSequenceMessage({ type: 'collapseAll' });
    await scans.settled();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.logs('error')).toEqual(['expand: sidecar gone', 'I/O scan: scan broke']);
    expect(r.seq.at(-1)?.type).toBe('render');
  });
});

describe('HeadlessController: the flow as text (FR-25.4)', () => {
  it('FR-25.4 Copy as text: the shown flow as an indented tree with file:line, for the view to copy; no diagram: says so', async () => {
    const empty = controller();
    await empty.c.onSequenceMessage({ type: 'copyText' });
    expect(empty.r.seq.at(-1)).toEqual({ type: 'diagramText', error: 'No diagram to copy.' });
    const p = shop();
    const { c, r } = controller(p.root);
    await openShow(c, p);
    await c.onSequenceMessage({ type: 'copyText' });
    const answer = r.seq.at(-1);
    if (answer?.type !== 'diagramText' || !answer.text) throw new Error(JSON.stringify(answer));
    const lines = answer.text.split('\n');
    expect(lines[0]).toMatch(/^# Seqcall sequence diagram/);
    // the background step done first: the root knows its route (FR-16.3)
    expect(lines[1]).toMatch(/^OrdersController\.show\b.*src\/presentation\/orders\.controller\.ts:\d+  ← GET \/orders\/:id$/);
    expect(lines.some((l) => /^ {2}«create» OrderService\(\)/.test(l))).toBe(true);
  });

  it('FR-25.4 Copy as text right after opening waits for the background I/O scan: the I/O below a folded call is in the text', async () => {
    const { c, r } = controller(`${REPO}/fixtures/io-app`);
    const file = `${REPO}/fixtures/io-app/src/controllers/note-controller.ts`;
    await c.openAt(file, positionOf(file, 'await this.archiver.run(id)')); // the scan started, not ended
    await c.onSequenceMessage({ type: 'copyText' });
    const answer = r.seq.at(-1);
    if (answer?.type !== 'diagramText' || !answer.text) throw new Error(JSON.stringify(answer));
    expect(answer.text).not.toContain('I/O: none found');
    expect(answer.text).toMatch(/\nI\/O \(1;.*\n.*FILE.*run/);
  });

  it('FR-25.5 Ask AI about this call: the question about the call, then the flow; a call gone meanwhile: says so', async () => {
    const p = shop();
    const { c, r } = controller(p.root);
    await openShow(c, p);
    const place = lastRender(r.seq).messages.find((m) => m.methodName === 'place')!;
    await c.onSequenceMessage({ type: 'copyText', messageId: place.id });
    const answer = r.seq.at(-1);
    if (answer?.type !== 'diagramText' || !answer.text) throw new Error(JSON.stringify(answer));
    expect(answer.text.split('\n')[0]).toMatch(/^Explain the call `OrderService\.place\(\)` at src\/presentation\/orders\.controller\.ts:\d+ in the flow below\./);
    expect(answer.text).toContain('\n# Seqcall sequence diagram, as shown in the panel');
    await c.onSequenceMessage({ type: 'copyText', messageId: 'root/9:gone' });
    expect(r.seq.at(-1)).toEqual({ type: 'diagramText', error: 'That call is no longer in the diagram.' });
  });

  it('FR-25.4 the class view\'s Copy as text: the classes, answered in the class view; no class diagram: says so there', async () => {
    const empty = controller();
    await empty.c.onClassMessage({ type: 'copyText' });
    expect(empty.r.cls.at(-1)).toEqual({ type: 'diagramText', error: 'No diagram to copy.' });
    const p = shop();
    const { c, r } = controller(p.root);
    await openShow(c, p);
    const seqBefore = r.seq.length;
    await c.onClassMessage({ type: 'copyText' });
    const answer = r.cls.at(-1);
    if (answer?.type !== 'diagramText' || !answer.text) throw new Error(JSON.stringify(answer));
    expect(answer.text.split('\n')[0]).toBe('# Seqcall class diagram of OrdersController.show: the classes in the shown calls');
    expect(answer.text).toMatch(/\n {2}OrdersController\b.*src\/presentation\/orders\.controller\.ts:\d+\n/);
    expect(r.seq.length).toBe(seqBefore); // the sequence view gets nothing
    vi.spyOn(DiagramSession.prototype, 'getClassDiagram').mockResolvedValue(undefined);
    await c.onClassMessage({ type: 'copyText' });
    expect(r.cls.at(-1)).toEqual({ type: 'diagramText', error: 'No diagram to copy.' });
  });
});
