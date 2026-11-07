import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { formatMessageLabel, fullCallText } from '../../webview/src/sequence/labels';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-accessors-')).replace(/\\/g, '/');
fs.mkdirSync(`${root}/src`);
fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2023', strict: false }, include: ['src'] }));
fs.writeFileSync(`${root}/src/venue.ts`, `export class Venue {
  private list: number[] = [];
  private _rating = 0;
  get events(): number[] { return this.list.filter((e) => this.valid(e)); }
  valid(e: number) { return e > 0; }
  get rating(): number { return this._rating; }
  set rating(v: number) { this._rating = v; }
  sorted() { return this.events.toSorted((a, b) => a - b); }
  copy() { return [...this.events]; }
}
export function view(b: Venue) {
  if (!b.events.some((e) => e > 1)) return;
  b.rating = 5;
  return b.rating;
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-4.1 callers of getters and setters', () => {
  const adapter = createTsAdapter(root);
  const callers = async (key: string) => (await adapter.getCallers((await adapter.getMethod(key))!)).map((c) => `${c.enclosing.name}: ${c.preview}`);

  it('FR-4.1 a getter is called where its property is read (also spread, chained)', async () => {
    expect(await callers('src/venue.ts#Venue.events')).toEqual([
      'sorted: sorted() { return this.events.toSorted((a, b) => a - b); }',
      'copy: copy() { return [...this.events]; }',
      'view: if (!b.events.some((e) => e > 1)) return;',
    ]);
  });

  it('FR-4.1 a setter where the property is assigned, its getter where it is read', async () => {
    expect(await callers('src/venue.ts#Venue.rating=')).toEqual(['view: b.rating = 5;']);
    expect(await callers('src/venue.ts#Venue.rating')).toEqual(['view: return b.rating;']);
  });

  it('FR-1.18 a diagram shows the getter a read runs and the setter an assignment runs («get» / «set»), expandable', async () => {
    const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await s.openMethodByKey('src/venue.ts#<module>.view');
    const d = (await s.expandAll())!;
    const steps = d.messages.filter((m) => m.accessor).map((m) => `${m.accessor} ${m.methodName}`);
    expect(steps).toEqual(['get events', 'set rating', 'get rating']);
    const events = d.messages.find((m) => m.accessor === 'get' && m.methodName === 'events')!;
    expect(events.methodKey).toBe('src/venue.ts#Venue.events');
    expect(d.messages.filter((m) => m.parentId === events.id).map((m) => m.methodName)).toEqual(['valid']); // the getter's body, below it
    const label = formatMessageLabel(events, { showArguments: true, maxArgumentLength: 30 });
    expect([label.prefix, label.name, label.args]).toEqual(['«get»', 'events', '']);
    expect(fullCallText(d.messages.find((m) => m.accessor === 'set')!)).toBe('«set» Venue.rating');
    // a plain field read (`this.list`) and a method call are no accessor steps
    const own = (await s.openMethodByKey('src/venue.ts#Venue.sorted'))!;
    expect(own.messages.filter((m) => m.accessor).map((m) => m.methodName)).toEqual(['events']);
  });
});
