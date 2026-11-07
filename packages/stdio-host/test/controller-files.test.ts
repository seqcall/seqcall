import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagramSession } from '@seqcall/core';
import { findMessageAt, HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, SAMPLE_APP, sampleAppCopy, tempProject, trackScans, TSCONFIG } from './controller-helpers';

// The editor's side of the HeadlessController (FR-13.1 files changed on disk, FR-2.4 the caret, FR-1.1 opening at
// the caret) with real files: copies of fixtures/sample-app and small temp projects.

const NO_METHOD_REASON = 'Place the caret inside a method, constructor, getter/setter or function body and run "Show Sequence Diagram".';
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanups) await f();
  cleanups = [];
});

/** A copy of sample-app with getUser open (findUser expanded). */
async function openedCopy() {
  const scans = trackScans();
  const p = sampleAppCopy();
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace: p.root });
  cleanups.push(async () => {
    await c.dispose();
    p.rm();
  });
  const file = p.file('src/controllers/user-controller.ts');
  await c.openAt(file, positionOf(file, 'this.validate(id);'));
  await c.onSequenceMessage({ type: 'expand', messageId: 'root/2:findUser' });
  await scans.settled();
  return { c, r, p, scans };
}

/** A second, tiny TS project (one class). */
function smallProject() {
  const q = tempProject('small', {
    'tsconfig.json': TSCONFIG,
    'src/invoice.ts': 'export class Invoice {\n  total(): number {\n    return this.sum();\n  }\n  sum(): number {\n    return 1;\n  }\n}\n',
  });
  cleanups.push(() => q.rm());
  return q;
}

describe('HeadlessController: files changed on disk (FR-13.1)', () => {
  it('FR-13.1 a saved source file of the diagram re-renders it; files of no loaded project change nothing', async () => {
    const { c, r, p, scans } = await openedCopy();
    const findByIds = () => lastRender(r.seq).messages.filter((m) => m.parentId === 'root/2:findUser' && m.methodName === 'findById').length;
    expect(findByIds()).toBe(2);
    const service = p.file('src/services/user-service.ts');
    fs.writeFileSync(service, fs.readFileSync(service, 'utf8').replace('const cached = ', 'await this.primary.findById(id);\n    const cached = '));
    const before = r.seq.length;
    await c.filesChanged([p.file('README.md'), `${p.root}-elsewhere/src/a.ts`, service]);
    expect(r.seq.slice(before).map((m) => m.type)).toEqual(['render']);
    expect(findByIds()).toBe(3);
    await scans.settled();
    const after = r.seq.length;
    // another project's layer config, files that are no source (a text file, a dependency, declarations), a file of
    // another language: nothing to refresh
    await c.filesChanged([`${p.root}-elsewhere/.seqcall.json`, p.file('notes.md'), p.file('node_modules/lib/index.ts'), p.file('src/types.d.ts'), p.file('src/Order.cs')]);
    expect(r.seq.length).toBe(after);
    expect(r.logs('error')).toEqual([]);
  });

  it('FR-7.2 / FR-13.1 an edited layer config (also above the project folder) is read again and the layers re-drawn', async () => {
    const { c, r, p } = await openedCopy();
    const config = p.file('.seqcall.json');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('"Application"', '"Services"'));
    await c.filesChanged([config]);
    expect(lastRender(r.seq).participants.find((x) => x.className === 'UserService')?.layer).toBe('Services');
  });

  it('FR-13.1 the root method deleted: the views say the diagram is empty', async () => {
    const { c, r, p, scans } = await openedCopy();
    await c.onClassMessage({ type: 'ready' });
    await scans.settled();
    const file = p.file('src/controllers/user-controller.ts');
    fs.writeFileSync(file, 'export class UserController {}\n');
    const started = scans.started();
    await c.filesChanged([file]);
    expect(r.seq.at(-1)).toEqual({ type: 'empty', reason: NO_METHOD_REASON });
    expect(r.cls.at(-1)).toEqual({ type: 'empty', reason: 'The sequence diagram is empty.' });
    expect(scans.started()).toBe(started); // FR-17.5 no diagram: no background I/O scan
  });

  it('FR-13.1 a project in the background is refreshed without drawing; a failed refresh is reported (the diagram\'s also in the view)', async () => {
    const { c, r, p, scans } = await openedCopy();
    const q = smallProject();
    // the small project opened first, then the copy again: the copy is the diagram
    await c.openAt(q.file('src/invoice.ts'), positionOf(q.file('src/invoice.ts'), 'return this.sum()'));
    expect(lastRender(r.seq).root.name).toBe('total');
    const file = p.file('src/controllers/user-controller.ts');
    await c.openAt(file, positionOf(file, 'this.validate(id);'));
    await scans.settled();
    // FR-2.4 a call highlighted at the caret stays highlighted: the caret on it again posts nothing
    await c.caretMoved(file, positionOf(file, 'this.validate(id);'));
    const before = r.seq.length;
    fs.writeFileSync(q.file('src/invoice.ts'), fs.readFileSync(q.file('src/invoice.ts'), 'utf8').replace('return 1;', 'return 2;'));
    await c.filesChanged([q.file('src/invoice.ts')]);
    await c.caretMoved(file, positionOf(file, 'this.validate(id);'));
    expect(r.seq.length).toBe(before);

    vi.spyOn(DiagramSession.prototype, 'refresh').mockRejectedValue('disk gone'); // not an Error: its text
    await c.filesChanged([q.file('src/invoice.ts'), file]);
    expect(r.logs('error')).toEqual(['refresh: disk gone', 'refresh: disk gone']);
    expect(r.seq.slice(before)).toEqual([{ type: 'error', message: 'disk gone' }]);
  });
});

describe('HeadlessController: the caret (FR-1.1, FR-2.4)', () => {
  const CONTROLLER = `${SAMPLE_APP}/src/controllers/user-controller.ts`;

  it('FR-2.4 the innermost call around the caret is highlighted once; leaving every call clears it', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
    cleanups.push(() => c.dispose());
    await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
    const before = r.seq.length;
    // formatName(user) inside new UserDto(…): the inner call
    await c.caretMoved(CONTROLLER, positionOf(CONTROLLER, 'formatName(user))'));
    await c.caretMoved(CONTROLLER, positionOf(CONTROLLER, 'formatName(user))')); // same call: not posted again
    await c.caretMoved(CONTROLLER, positionOf(CONTROLLER, 'new UserDto'));
    await c.caretMoved(CONTROLLER, positionOf(CONTROLLER, 'return JSON.stringify'));
    expect(r.seq.slice(before)).toEqual([
      { type: 'highlight', messageId: 'root/3:formatName' },
      { type: 'highlight', messageId: 'root/4:constructor' },
      { type: 'highlight', messageId: null },
    ]);
  });

  it('FR-2.4 call sites of other files, the root (found) message and ranges ending before the caret do not match', () => {
    const at = (line: number, character: number) => ({ line, character });
    const msg = (id: string, file: string, start: [number, number], end: [number, number], kind: 'call' | 'found' = 'call') =>
      ({ id, kind, callSite: { file, start: at(...start), end: at(...end) } }) as never;
    const messages = [
      msg('root', '/w/a.ts', [1, 0], [20, 0], 'found'),
      msg('other', '/w/b.ts', [5, 0], [5, 30]),
      msg('outer', '/w/a.ts', [5, 2], [7, 4]),
      msg('inner', '/w/a.ts', [6, 4], [6, 10]),
      msg('after', '/w/a.ts', [6, 4], [6, 12]), // larger than inner, listed after it
      msg('nested', '/w/a.ts', [9, 0], [9, 8]),
      msg('same', '/w/a.ts', [9, 0], [9, 8]), // the same range listed later (deeper in the flow): this one
      { id: 'no-site', kind: 'call' } as never,
    ];
    expect(findMessageAt(messages, '/w/a.ts', at(6, 6))).toBe('inner');
    expect(findMessageAt(messages, '/w/a.ts', at(6, 11))).toBe('after');
    expect(findMessageAt(messages, '/w/a.ts', at(7, 4))).toBe('outer'); // the end is inside
    expect(findMessageAt(messages, '/w/a.ts', at(7, 5))).toBeNull();
    expect(findMessageAt(messages, '/w/a.ts', at(5, 1))).toBeNull(); // before the start on its line
    expect(findMessageAt(messages, '/w/b.ts', at(5, 3))).toBe('other');
    expect(findMessageAt(messages, '/w/a.ts', at(9, 3))).toBe('same');
  });

  it('FR-1.1 no method at the caret: both views say so, the diagram before stays the project\'s; FR-16.14 a spinner while the project is first analysed', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
    cleanups.push(() => c.dispose());
    await c.openAt(CONTROLLER, { line: 0, character: 0 }); // the import line, class view closed
    expect(r.seq).toEqual([
      { type: 'busy', text: 'Analysing sample-app…' },
      { type: 'empty', reason: 'No method found at the caret. ' + NO_METHOD_REASON },
    ]);
    await c.onClassMessage({ type: 'ready' });
    await c.openAt(CONTROLLER, { line: 0, character: 0 });
    expect(r.seq.at(-1)).toEqual({ type: 'empty', reason: 'No method found at the caret. ' + NO_METHOD_REASON });
    expect(r.cls).toEqual([
      { type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' },
      { type: 'empty', reason: 'The sequence diagram is empty.' },
    ]);
    // the project was analysed once: progress (and the spinner) only the first time
    expect(r.seq.filter((m) => m.type === 'busy')).toHaveLength(1);
    expect(r.other.filter((o) => o.kind === 'progress').map((o) => o.arg)).toEqual(['Analysing sample-app…', null]);
  });
});
