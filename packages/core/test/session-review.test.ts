import * as fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import type { LanguageAdapter } from '../src/adapter';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { makeShopReviewRepo } from './fixtures/shop-review-repo';

// FR-24 a review in a session, on a branch that changes classes (fields, base types, a renamed file) and drops calls
// (see fixtures/shop-review-repo.ts).
let root = '';
beforeAll(() => {
  root = makeShopReviewRepo();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const SHOW = 'src/presentation/shop.controller.ts#ShopController.show';
const CANCEL = 'src/presentation/shop.controller.ts#ShopController.cancel';
const session = () => new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
const byId = (d: SequenceDiagram | undefined, id: string) => d!.messages.find((m) => m.id === id)!;
const marks = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.diff?.status).map((m) => `${m.id} ${m.diff!.status}`);

describe('FR-24.11 what the branch did to each class', () => {
  it('FR-24.11 fields of another type, no longer a list, removed, added; base types gained, lost or both; a class of a renamed file against its old path; a new class in an old file', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    await s.expandEverything();
    const cd = (await s.getClassDiagram())!;
    const change = (name: string) => cd.classes.find((c) => c.name === name && c.diff !== 'removed')!.change;
    expect(change('Order')!.members.map((m) => `${m.kind} ${m.change}: ${m.text}`)).toEqual([
      'method added: extra(): number',
      'field changed: lines: Money (was lines: Money[])',
      'field changed: tag: Receipt (was tag: Money)',
      'field added: price: Money',
      'field changed: count: Money (was count)',
      'field changed: name (was name: Money)',
      'field removed: note: Money',
      'declaration changed: now Auditable (was Entity)',
      'method changed: constructor()',
      // a local function of total(): no member of the class, named as it is
      'method changed: round',
      'method changed: total(): number',
    ]);
    // due() moved above sum() (git shows sum() as the new lines): its signature is not new — no change of the class
    expect(change('Invoice')!.members.map((m) => m.text)).toEqual(['no longer Entity']);
    // run's type (an alias in another file) changed: another signature, no line of Receipt's own
    expect(change('Receipt')!.members.map((m) => [m.change, m.text, m.line, !!m.hunk])).toEqual([
      ['added', 'run(n: string): number', undefined, false],
      ['added', 'label(): string', 16, true],
      ['removed', 'run(n: number): number', undefined, false],
      ['changed', 'now Named', 11, true],
    ]);
    // Tax: in a changed file, itself unchanged
    expect(change('Tax')).toBeUndefined();
    expect(change('Credit')).toEqual({ kind: 'new', members: [] });
    // moved to auditor.ts: compared with audit.ts — its log() changed, the class is not new
    expect(change('Audit')!.members.map((m) => `${m.name} ${m.change}`)).toEqual(['log changed']);
    await s.dispose();
  });
});

describe('FR-24.6 / FR-24.7 removed calls and their place in the diff', () => {
  it('FR-24.7 a removed call is placed at the call after it, else after the call before it; in a renamed file it shows its old lines', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    const d = (await s.expandEverything())!;
    expect(marks(d)).toEqual([
      'root/1:place/0:fee changed',
      'root/1:place/1:constructor changed',
      'root/1:place/2:log changed',
      'root/1:place/2:log/~0:stamp removed',
      'root/1:place/2:log/0:mark added',
      'root/1:place/4:total/0:constructor changed',
      'root/1:place/4:total/1:rate changed',
      'root/1:place/4:total/2:round changed',
      'root/1:place/5:constructor added',
      'root/1:place/6:label added',
      'root/1:place/7:constructor added',
      'root/1:place/8:x added',
      // the calls of the new method are new
      'root/1:place/8:x/0:constructor added',
      'root/1:place/8:x/1:apply added',
      'root/1:place/8:x/2:zap added',
      'root/1:place/~9:constructor removed',
      'root/1:place/~10:log removed',
    ]);
    // the last call of place() is gone: on the line after the call before it (print(), 0-based line 17 of today's shop.ts)
    expect(await s.diffTarget('root/1:place/~10:log')).toMatchObject({ file: `${root}/src/application/shop.ts`, line: 18 });
    // log() lives in auditor.ts now; its dropped stamp() call: there, from the old file's text
    const stamp = (await s.diffTarget('root/1:place/2:log/~0:stamp'))!;
    // (placed at the mark() call that follows it now, line 2)
    expect([stamp.file, stamp.line, stamp.baseText.includes('this.stamp();')]).toEqual([`${root}/src/application/auditor.ts`, 2, true]);
    expect(byId(d, 'root/1:place/2:log/~0:stamp').diff!.hunk).toEqual([{ kind: '-', text: '    this.stamp();', at: true }]);
    // a call both versions make, its argument changed: its own lines, not the changed fee() call above it
    expect(byId(d, 'root/1:place/2:log').diff!.hunk!.map((l) => `${l.kind}${l.text.trim()}`)).toEqual(["-new Audit().log('a');", "+new Audit().log('b');"]);
    // the new mark() call there: its own new line
    expect(byId(d, 'root/1:place/2:log/0:mark').diff!.hunk).toEqual([{ kind: '+', text: '    this.mark();', at: true }]);
    await s.dispose();
  });

  it('FR-24.6 a class of a renamed file is the same class: no new participant, no ghost of it, its calls the same calls; a root method there is compared too', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    const d = (await s.expandEverything())!;
    const audits = d.participants.filter((p) => p.className === 'Audit').map((p) => `${p.classKey} ${p.diff ?? '-'}`);
    expect(audits).toEqual(['src/application/auditor.ts#Audit -']);
    // the removed calls of the old file are drawn on today's Audit
    const audit = d.participants.find((p) => p.className === 'Audit')!.id;
    expect([byId(d, 'root/1:place/~10:log').to, byId(d, 'root/1:place/2:log/~0:stamp').to]).toEqual([audit, audit]);
    // the same log() as before (its argument changed), not one whose target changed
    expect(byId(d, 'root/1:place/2:log').diff).not.toHaveProperty('signature');
    const cd = (await s.getClassDiagram())!;
    expect(cd.classes.filter((c) => c.name === 'Audit').map((c) => `${c.key} ${c.diff ?? '-'}`)).toEqual(['src/application/auditor.ts#Audit -']);
    // rooted in the renamed file: its base version is found at the old path
    expect(marks(await s.openMethodByKey('src/application/auditor.ts#Audit.log'))).toEqual(['root/~0:stamp removed', 'root/0:mark added']);
    await s.dispose();
  });

  it('FR-24.7 a removed call without a call beside it any more (the others hidden): at its method\'s declaration', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(CANCEL);
    await s.expand('root/1:cancel');
    await s.hide({ kind: 'methodName', methodName: 'total' });
    const d = (await s.hide({ kind: 'methodName', methodName: 'constructor' }))!;
    expect(d.messages.filter((m) => m.parentId === 'root/1:cancel').map((m) => `${m.id} ${m.diff?.status}`)).toEqual(['root/1:cancel/~1:log removed']);
    // cancel() is declared on line 19 (0-based) of today's shop.ts
    expect(await s.diffTarget('root/1:cancel/~1:log')).toMatchObject({ file: `${root}/src/application/shop.ts`, line: 19 });
    await s.dispose();
  });
});

describe('FR-24.11 class changes in other review states', () => {
  it('FR-24.11 without the base version: the changed and added methods the review found; a library\'s class has none', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), initialState: { options: { showLibraryCalls: true } as never } });
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    const d = (await s.expandEverything())!;
    const order = d.participants.find((p) => p.className === 'Order')!;
    expect(order.change!.members.map((m) => `${m.name} ${m.change}`)).toEqual(['constructor changed', 'round changed', 'total changed', 'extra added']);
    // Invoice's moved method (git shows sum() as the moved one): an added method of the review, listed now (no base
    // version to compare signatures with)
    expect(d.participants.find((p) => p.className === 'Invoice')!.change!.members.map((m) => `${m.name} ${m.change}`)).toEqual(['sum added']);
    const lib = d.participants.filter((p) => p.classKey.startsWith('lib:'));
    expect(lib.length).toBeGreaterThan(0);
    expect(lib.some((p) => p.change)).toBe(false);
    await s.dispose();
  });
});

describe('FR-24.7 / FR-24.9 / FR-24.10 / FR-24.15 review steps without a review, or with nothing to show', () => {
  it('FR-24.7 no review: no diff of a call or class; no change to reveal or show; no tour flow without a path', async () => {
    const s = session();
    await s.openMethodByKey(SHOW);
    expect(await s.diffTarget('root/1:place')).toBeUndefined();
    expect(await s.classDiffTarget('src/domain/order.ts#Order')).toBeUndefined();
    expect(await s.revealChange('root/1:place')).toBeUndefined();
    expect(await s.showChange(1)).toBeUndefined();
    expect(await s.openChangeFlow([])).toBeUndefined();
    expect(await s.openChangeFlow([[{ methodKey: 'src/gone.ts#Gone.run' }]])).toBeUndefined();
    await s.dispose();
  });
});

describe('FR-24.7 / FR-24.11 the side-by-side diff of a class', () => {
  it('FR-24.11 at a member\'s first changed line, else at the class; a class of a renamed file shows its old text; a file the branch did not touch has none', async () => {
    const s = session();
    await s.reviewChanges();
    const t = async (key: string, member?: string) => {
      const x = await s.classDiffTarget(key, member);
      return x && { file: x.file.replace(`${root}/`, ''), line: x.line, title: x.title, base: x.baseText.split('\n')[0] };
    };
    expect(await t('src/domain/order.ts#Order', 'total')).toEqual({ file: 'src/domain/order.ts', line: 17, title: 'order.ts (develop ↔ feature/orders)', base: "import { Entity } from './base';" });
    // without a member: the first change with a line (the added extra())
    expect((await t('src/domain/order.ts#Order'))!.line).toBe(19);
    // a member without a line of its own (run: its type changed elsewhere): the class
    expect((await t('src/domain/invoice.ts#Receipt', 'run'))!.line).toBe(10);
    // a new class (no members listed): the class
    expect((await t('src/domain/invoice.ts#Credit'))!.line).toBe(19);
    // a class of a new file: no base text
    expect(await t('src/domain/coupon.ts#Coupon')).toEqual({ file: 'src/domain/coupon.ts', line: 0, title: 'coupon.ts (develop ↔ feature/orders)', base: '' });
    expect((await t('src/application/auditor.ts#Audit'))!.base).toBe('export class Audit {');
    expect(await t('src/domain/money.ts#Money')).toBeUndefined();
    await s.dispose();
  });
});

describe('FR-24.7 the side-by-side diff of a call', () => {
  it('FR-24.7 a new call in a renamed file: today\'s file against the old one; a method of a new file: against nothing; a method part of a call whose method did not change, or a library call: its own place', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    await s.setOption('showLibraryCalls', true);
    await s.expandEverything();
    const t = async (id: string, part?: { method?: boolean }) => {
      const x = await s.diffTarget(id, part);
      return x && { file: x.file.replace(`${root}/`, ''), line: x.line, base: x.baseText.includes('this.stamp();') ? 'old audit.ts' : x.baseText.split('\n')[0] };
    };
    expect(await t('root/1:place/2:log/0:mark')).toEqual({ file: 'src/application/auditor.ts', line: 2, base: 'old audit.ts' });
    // apply() is a method of the new coupon.ts
    expect(await t('root/1:place/8:x/1:apply', { method: true })).toEqual({ file: 'src/domain/coupon.ts', line: 1, base: '' });
    // show() itself did not change: at its declaration in the controller (no diff lines there)
    expect(await t('root', { method: true })).toEqual({ file: 'src/presentation/shop.controller.ts', line: 4, base: "import { Controller, Get } from '../decorators';" });
    // the method part of a changed call whose method did not change: the method's declaration (Tax.rate(), line 24)
    expect(await t('root/1:place/4:total/1:rate', { method: true })).toMatchObject({ file: 'src/domain/order.ts', line: 24 });
    // a library call has no declaration of its own: its call site
    expect((await t('root/1:place/2:log/1:trim', { method: true }))!.file).toBe('src/application/auditor.ts');
    expect(await t('root/9:nope')).toBeUndefined();
    await s.dispose();
  });
});

describe('FR-24.11 class changes from an adapter that tells less', () => {
  // a language host whose class facts carry no declarations, and that knows nothing of Tax
  const terse = (): LanguageAdapter => {
    const ts = createTsAdapter(root);
    const a: LanguageAdapter = Object.create(ts);
    a.getClassInfo = async (key) => {
      if (key.endsWith('#Tax')) return undefined;
      const info = await ts.getClassInfo(key);
      return info && { ...info, ref: { ...info.ref, declaration: undefined }, fields: info.fields.map((f) => ({ ...f, declaration: undefined })) };
    };
    return a;
  };

  it('FR-24.11 fields and base types without a line (no diff lines with them); a class without facts has no change; a class without a declaration opens at the top', async () => {
    const s = new DiagramSession({ adapter: terse(), classifier: createClassifier(root), createBaseAdapter: terse });
    await s.reviewChanges();
    await s.openMethodByKey(SHOW);
    const d = (await s.expandEverything())!;
    const order = d.participants.find((p) => p.className === 'Order')!.change!;
    expect(order.members.filter((m) => m.kind !== 'method').map((m) => [m.name, m.change, m.line, !!m.hunk])).toEqual([
      ['lines', 'changed', undefined, false],
      ['tag', 'changed', undefined, false],
      ['price', 'added', undefined, false],
      ['count', 'changed', undefined, false],
      ['name', 'changed', undefined, false],
      ['note', 'removed', undefined, false],
      ['Order', 'changed', undefined, false],
    ]);
    expect(d.participants.find((p) => p.className === 'Tax')!.change).toBeUndefined();
    expect((await s.classDiffTarget('src/domain/invoice.ts#Credit'))!.line).toBe(0);
    await s.dispose();
  });
});

describe('FR-29 opening the flow behind a structure row (the row as a host sends it back)', () => {
  it('FR-29 a package row on a zoomed view: the objects again; a row without class pairs: the flow; a pair found by its classes when no call is at its place; none found: no call to highlight; an entry point gone: nothing', async () => {
    const s = session();
    await s.reviewChanges();
    const entryPoint = (await s.getEntryPoints()).find((e) => e.method.key === SHOW)!;
    const pair = { from: 'src/application/shop.ts#Shop', fromName: 'Shop', to: 'src/domain/order.ts#Order', toName: 'Order' };
    await s.setOption('layerZoom', true);
    const row = { kind: 'edge-added' as const, title: 'src/application → src/domain', level: 'package' as const, entryPoint };
    const noPairs = (await s.openReviewStructure(row))!;
    expect([noPairs.diagram!.options.layerZoom, noPairs.messageId]).toEqual([false, undefined]);
    // the pair's call is at no place of the flow (its line moved since): the first call from Shop to Order
    const moved = (await s.openReviewStructure({ ...row, pairs: [{ ...pair, call: { label: 'place → total', callSite: { file: `${root}/src/application/shop.ts`, start: { line: 99, character: 0 }, end: { line: 99, character: 1 } } } }] }))!;
    expect(moved.messageId).toBe('root/1:place/3:constructor');
    // without a call at all, the same
    expect((await s.openReviewStructure({ ...row, pairs: [pair] }))!.messageId).toBe('root/1:place/3:constructor');
    // classes the flow does not join
    const none = (await s.openReviewStructure({ ...row, pairs: [{ ...pair, to: 'src/domain/money.ts#Money', toName: 'Money' }] }))!;
    expect([none.diagram!.root.key, none.messageId]).toEqual([SHOW, undefined]);
    expect(await s.openReviewStructure({ ...row, entryPoint: { ...entryPoint, method: { ...entryPoint.method, key: 'src/gone.ts#Gone.run' } } })).toBeUndefined();
    await s.dispose();
  });
});

describe('FR-24.7 removed calls from an adapter without method declarations', () => {
  it('FR-24.7 a removed call alone under a method that has no declaration: at its line in the base version', async () => {
    const bare = (): LanguageAdapter => {
      const ts = createTsAdapter(root);
      const a: LanguageAdapter = Object.create(ts);
      a.getOutgoingCalls = async (m) => (await ts.getOutgoingCalls(m)).map((c) => (c.target ? { ...c, target: { ...c.target, declaration: undefined } } : c));
      a.getMethod = async (k) => {
        const m = await ts.getMethod(k);
        return m && { ...m, declaration: undefined };
      };
      return a;
    };
    const s = new DiagramSession({ adapter: bare(), classifier: createClassifier(root), createBaseAdapter: bare });
    await s.reviewChanges();
    await s.openMethodByKey(CANCEL);
    await s.expand('root/1:cancel');
    await s.hide({ kind: 'methodName', methodName: 'total' });
    await s.hide({ kind: 'methodName', methodName: 'constructor' });
    // `new Audit().log('c');` was line 18 (0-based) of shop.ts
    expect(await s.diffTarget('root/1:cancel/~1:log')).toMatchObject({ file: `${root}/src/application/shop.ts`, line: 18 });
    await s.dispose();
  });
});

describe('FR-24.15 a change drawn twice', () => {
  it('FR-24.15 a changed method called twice counts once: the second call and its calls hold nothing', async () => {
    const s = session();
    await s.reviewChanges();
    await s.openMethodByKey(CANCEL);
    const d = (await s.expandEverything())!;
    const count = (id: string) => d.messages.find((m) => m.id === id)!.diff?.count;
    expect(['root/1:cancel/1:total', 'root/1:cancel/1:total/2:round', 'root/1:cancel/3:total', 'root/1:cancel/3:total/2:round'].map(count)).toEqual([1, 2, 0, 0]);
    expect(d.messages.reduce((n, m) => n + (m.diff?.count ?? 0), 0)).toBe(d.reviewTotal);
    await s.dispose();
  });
});

describe('FR-24.7 the diff when files or git are gone meanwhile', () => {
  it('FR-24.7 git cannot show the base version any more: removed calls show empty old lines; a new call whose file is gone: the diff lines around it', async () => {
    const copy = makeShopReviewRepo();
    try {
      const s = new DiagramSession({ adapter: createTsAdapter(copy), classifier: createClassifier(copy), createBaseAdapter: () => createTsAdapter(copy) });
      await s.reviewChanges();
      fs.renameSync(`${copy}/.git`, `${copy}/.git-away`);
      await s.openMethodByKey(SHOW);
      const d = (await s.expandEverything())!;
      // (a call over two lines: two)
      expect(d.messages.find((m) => m.id === 'root/1:place/~10:log')!.diff!.hunk).toEqual([{ kind: '-', text: '', at: true }, { kind: '-', text: '' }]);
      fs.renameSync(`${copy}/.git-away`, `${copy}/.git`);
      fs.rmSync(`${copy}/src/application/auditor.ts`);
      // mark() is new in auditor.ts: its lines cannot be read now, the diff's lines around it stand in
      expect(await s.diffTarget('root/1:place/2:log/0:mark')).toMatchObject({ file: `${copy}/src/application/auditor.ts`, line: 2 });
      // invoice.ts cut short since: the new zap() call (over two lines) reads as blank
      fs.writeFileSync(`${copy}/src/domain/invoice.ts`, 'export {};\n');
      const again = (await s.redraw())!;
      expect(again.messages.find((m) => m.id === 'root/1:place/8:x/2:zap')!.diff!.hunk).toEqual([{ kind: '+', text: '', at: true }, { kind: '+', text: '' }]);
      await s.dispose();
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('FR-29 a review cancelled between two flows of the base version', () => {
  it('FR-29 the review without the structure', async () => {
    let cancel = false;
    const s = session();
    const r = (await s.reviewChanges({
      cancelled: () => cancel,
      onProgress: (phase, done, total) => {
        // the first of the two flows (show, cancel) scanned on the base version
        if (phase === 'Comparing the structure: the base version' && done === 1 && total === 2) cancel = true;
      },
    }))!;
    expect([r.methods.length > 0, r.structure]).toEqual([true, undefined]);
    await s.dispose();
  });
});
