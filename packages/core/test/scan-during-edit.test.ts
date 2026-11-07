import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryPoint, MethodRef } from '@seqcall/protocol';
import type { FileType } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import type { DiagramSession } from '../src/session';
import { cls, fakeSession, meth } from './fake-world';

// A file saved while a project-wide scan runs: the scan read old and new code. Its answer is shown (marked
// `changed`) but not kept, and the flows it scanned after the save are not stored — the next request scans again.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const shop = cls('src/Shop.ts', 'Shop');
const cart = cls('src/Cart.ts', 'Cart');
const lost = cls('src/Lost.ts', 'Lost');
const list = meth(shop, 'list');
const add = meth(cart, 'add');
const orphan = meth(lost, 'orphan');
const eps: EntryPoint[] = [
  { kind: 'http', label: 'GET /shop', method: list },
  { kind: 'http', label: 'POST /cart', method: add },
];

/** A session whose adapter saves `file` (once, when armed) while the flow of `during` is scanned. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-edit-')).replace(/\\/g, '/');
  dirs.push(root);
  for (const f of ['src/Shop.ts', 'src/Cart.ts', 'src/Lost.ts']) {
    fs.mkdirSync(path.dirname(`${root}/${f}`), { recursive: true });
    fs.writeFileSync(`${root}/${f}`, '');
  }
  const types: Record<string, FileType[]> = { 'src/Shop.ts': [{ type: shop, methods: [list] }], 'src/Cart.ts': [{ type: cart, methods: [add] }], 'src/Lost.ts': [{ type: lost, methods: [orphan] }] };
  const scanned: string[] = [];
  const t = { s: undefined as unknown as DiagramSession, save: undefined as { during: MethodRef; file: string } | undefined, projectTypes: 0 };
  const edit = async (m: MethodRef) => {
    if (t.save?.during.key !== m.key) return;
    const file = t.save.file;
    t.save = undefined;
    await t.s.refresh([file]);
  };
  t.s = fakeSession(
    {
      methods: [list, add, orphan],
      entryPoints: eps,
      adapter: {
        projectRoot: root,
        getOutgoingCalls: async (m: MethodRef) => {
          scanned.push(m.name);
          await edit(m);
          return [];
        },
        getFileTypes: async (file: string) => types[file.slice(root.length + 1)],
        getProjectTypes: async () => {
          t.projectTypes++;
          await edit(list);
          return Object.values(types).flat();
        },
      },
    },
    { classifier: new DefaultClassifier(root, {}) },
  );
  return { t, scanned, root };
}

describe('a file saved during a project-wide scan', () => {
  it('design issues: the answer is marked and not kept; scans read before the save still answer; the next request scans again', async () => {
    const { t, scanned, root } = world();
    await t.s.findProjectIssues();
    expect(t.s.projectFindingsChanged).toBe(false);
    // Cart changed: its flow is scanned again, and while it is, Shop is saved (its scan, read at the start, is dropped)
    await t.s.refresh([`${root}/src/Cart.ts`]);
    scanned.length = 0;
    t.save = { during: add, file: `${root}/src/Shop.ts` };
    const found = await t.s.findProjectIssues();
    expect(found).toEqual([]);
    expect(scanned).toEqual(['add']);
    expect(t.s.projectFindingsChanged).toBe(true);
    // nothing of that walk was kept: Shop (saved) and Cart (scanned across the save) are scanned again
    scanned.length = 0;
    await t.s.findProjectIssues();
    expect(scanned).toEqual(['list', 'add']);
    expect(t.s.projectFindingsChanged).toBe(false);
    // kept now: the next request answers from the cache
    scanned.length = 0;
    await t.s.findProjectIssues();
    expect(scanned).toEqual([]);
    expect(t.s.projectFindingsChanged).toBe(false);
  });

  it('design issues: a method no entry point reaches scanned across a save is not kept', async () => {
    const { t, scanned, root } = world();
    // the unreachable-code list first (its walk reads the same bodies): the save lands in the design scan's own flow
    await t.s.findUnreachableCode();
    t.save = { during: orphan, file: `${root}/src/Cart.ts` };
    scanned.length = 0;
    await t.s.findProjectIssues();
    expect(scanned).toEqual(['list', 'add', 'orphan']);
    expect(t.s.projectFindingsChanged).toBe(true);
    scanned.length = 0;
    await t.s.findProjectIssues();
    // Cart (saved) and the method no entry point reaches (scanned across the save) again; Shop kept, the list kept
    expect(scanned).toEqual(['add', 'orphan']);
    expect(t.projectTypes).toBe(1);
  });

  it('unreachable code: the list is marked and not kept; the next request walks again', async () => {
    const { t, root } = world();
    t.save = { during: list, file: `${root}/src/Lost.ts` };
    const first = (await t.s.findUnreachableCode())!;
    expect(first.changed).toBe(true);
    const second = (await t.s.findUnreachableCode())!;
    expect(t.projectTypes).toBe(2);
    expect(second.changed).toBeUndefined();
    await t.s.findUnreachableCode();
    expect(t.projectTypes).toBe(2);
  });
});
