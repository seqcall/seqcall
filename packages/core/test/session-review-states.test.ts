import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import type { LanguageAdapter } from '../src/adapter';
import { createClassifier, DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { makeGatewayRepo } from './fixtures/gateway-repo';

// FR-24 / FR-29 a review in the states around it: cancelled at each step, a base version that cannot be loaded, a host
// classifier without a project root, an adapter without file facts, a detached HEAD.
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
let root = '';
beforeAll(() => {
  root = makeGatewayRepo();
  roots.push(root);
});
const PAY = 'src/presentation/checkout.controller.ts#CheckoutController.pay';
const session = (extra: { classifier?: Classifier; adapter?: () => LanguageAdapter; base?: () => LanguageAdapter } = {}) =>
  new DiagramSession({ adapter: (extra.adapter ?? (() => createTsAdapter(root)))(), classifier: extra.classifier ?? createClassifier(root), createBaseAdapter: extra.base ?? (() => createTsAdapter(root)) });

describe('FR-24 / FR-29 a review cancelled, at each step', () => {
  it('FR-24.1 cancelled while the branch is read: no review', async () => {
    expect(await session().reviewChanges({ base: 'develop', cancelled: () => true })).toBeUndefined();
  });

  /** A review cancelled once `stop(phase, done, total)` says so. */
  const cancelledAt = async (stop: (phase: string, done: number, total: number) => boolean) => {
    let cancel = false;
    const s = session();
    const r = await s.reviewChanges({
      base: 'develop',
      cancelled: () => cancel,
      onProgress: (phase, done, total) => {
        if (stop(phase, done, total)) cancel = true;
      },
    });
    await s.dispose();
    return r!;
  };

  it('FR-29 cancelled once the base version is loading: the review without the structure (its walk stops at once)', async () => {
    const r = await cancelledAt((p) => p === 'Loading the base version');
    expect([r.methods.length > 0, r.structure]).toEqual([true, undefined]);
  }, 60_000);

  it('FR-29 cancelled while the base version\'s flows are walked, or right after', async () => {
    expect((await cancelledAt((p) => p === 'Comparing the structure: the base version')).structure).toBeUndefined();
    expect((await cancelledAt((p, done, total) => p === 'Comparing the structure: the base version' && done === total)).structure).toBeUndefined();
  }, 60_000);
});

describe('FR-24.6 the base version', () => {
  it('FR-24.6 it cannot be loaded: the review and its marks without the base version (no removed calls, no structure)', async () => {
    const s = session({ base: () => ({ ...createTsAdapter(root), updateFile: async () => Promise.reject(new Error('disk full')) }) as LanguageAdapter });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    expect(r.structure).toBeUndefined();
    await s.openMethodByKey(PAY);
    const d = (await s.expandEverything())!;
    expect(d.messages.some((m) => m.diff?.call)).toBe(true);
    expect(d.messages.some((m) => m.diff?.status === 'removed')).toBe(false);
    await s.dispose();
  });

  it('FR-24.6 a second review whose base version fails to load: the first one\'s is not kept', async () => {
    let loads = 0;
    const s = session({
      base: () => {
        const a: LanguageAdapter = Object.create(createTsAdapter(root));
        if (++loads === 2) a.updateFile = async () => Promise.reject(new Error('disk full'));
        return a;
      },
    });
    await s.reviewChanges({ base: 'develop' });
    await s.openMethodByKey(PAY);
    const audit = (d: SequenceDiagram | undefined) => d!.messages.find((m) => m.methodName === 'audit')!.diff!;
    // compared with the base version: the audit call is new
    expect(audit(await s.expandEverything()).status).toBe('added');
    await s.reviewChanges({ base: 'develop', force: true });
    expect(audit(await s.redraw())).toEqual(expect.objectContaining({ call: true }));
    expect(audit(await s.redraw()).status).toBeUndefined();
    await s.dispose();
  });

  it('FR-24.6 loaded while a diagram is open: that flow is compared at once (its root asked from the base version)', async () => {
    const asked: string[] = [];
    let phase = '';
    const s = session({
      base: () => {
        const a: LanguageAdapter = Object.create(createTsAdapter(root));
        const getMethod = a.getMethod.bind(a);
        a.getMethod = (k) => (asked.push(`${phase}: ${k}`), getMethod(k));
        return a;
      },
    });
    await s.openMethodByKey(PAY);
    await s.reviewChanges({ base: 'develop', onProgress: (p) => (phase = p) });
    // while it loads (before the structure is compared)
    expect(asked[0]).toBe(`Loading the base version: ${PAY}`);
    await s.dispose();
  });
});

describe('FR-24 hosts that tell less', () => {
  it('FR-24.4 a classifier without a project root: the adapter\'s root; the changed lines are marked as with it', async () => {
    const base = createClassifier(root);
    const rootless: Classifier = { classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => base.layerOrder(), reloadConfig: () => undefined };
    const s = session({ classifier: rootless });
    expect((await s.reviewChanges({ base: 'develop' }))!.methods.map((m) => m.method.name)).toContain('chargeOne');
    await s.openMethodByKey(PAY);
    const d = (await s.expandEverything())!;
    expect(d.messages.find((m) => m.methodName === 'charge')!.diff).toMatchObject({ call: true });
    await s.dispose();
  });

  it('FR-29.7 an adapter without file facts: the structure is compared without I/O', async () => {
    const factless = () => {
      const a: LanguageAdapter = Object.create(createTsAdapter(root));
      a.getModuleFacts = undefined;
      return a;
    };
    const s = session({ adapter: factless, base: factless });
    expect((await s.reviewChanges({ base: 'develop' }))!.structure!.rows.every((r) => r.kind !== 'io-added' && r.kind !== 'io-removed')).toBe(true);
    await s.dispose();
  });
});

describe('FR-24.7 detached HEAD', () => {
  it('FR-24.7 the diff titles name the working tree (no branch)', async () => {
    const detached = makeGatewayRepo();
    roots.push(detached);
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: detached, stdio: 'pipe' });
    const s = new DiagramSession({ adapter: createTsAdapter(detached), classifier: createClassifier(detached) });
    await s.reviewChanges({ base: 'develop' });
    await s.openMethodByKey(PAY);
    const d = (await s.expandEverything())!;
    const charge = d.messages.find((m) => m.methodName === 'charge')!;
    expect((await s.diffTarget(charge.id))!.title).toBe('checkout.ts (develop ↔ working tree)');
    expect((await s.classDiffTarget('src/application/checkout.ts#Checkout'))!.title).toBe('checkout.ts (develop ↔ working tree)');
    await s.dispose();
  });
});

describe('FR-29 no flow touched by the branch', () => {
  it('FR-29.4 nothing to compare on the base version: every flow taken from this version', async () => {
    const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-untouched-')).replace(/\\/g, '/');
    roots.push(r2);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(r2, rel)), { recursive: true });
      fs.writeFileSync(path.join(r2, rel), text);
    };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: r2, stdio: 'pipe' });
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
    write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
    write('src/presentation/health.controller.ts', `import { Controller, Get } from '../decorators';\n@Controller('health')\nexport class HealthController {\n  @Get() check() { return 'ok'; }\n}\n`);
    write('src/tools/report.ts', `export function report() {\n  return 1;\n}\n`);
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature/report');
    write('src/tools/report.ts', `export function report() {\n  return 2;\n}\n`);
    git('commit', '-q', '-am', 'feature');
    const s = new DiagramSession({ adapter: createTsAdapter(r2), classifier: new DefaultClassifier(r2), createBaseAdapter: () => createTsAdapter(r2) });
    const st = (await s.reviewChanges({ base: 'develop' }))!.structure!;
    expect([st.rows, st.compared, st.copied]).toEqual([[], 0, 1]);
    await s.dispose();
  });
});

describe('FR-24.9 the flow\'s changes cannot be listed', () => {
  it('FR-24.9 a method below fails to load: collapsed calls still count the changed methods below them, ▶ opens the way to the first; nothing below: nothing to open', async () => {
    let broken = false;
    const failing = () => {
      const ts = createTsAdapter(root);
      const a: LanguageAdapter = Object.create(ts);
      // the wallet's charge(): read only for the list of the flow's changes (its path needs that implementation)
      a.getOutgoingCalls = (m) => (broken && m.key.includes('WalletGateway') ? Promise.reject(new Error('sidecar gone')) : ts.getOutgoingCalls(m));
      return a;
    };
    const s = session({ adapter: failing });
    await s.reviewChanges({ base: 'develop' });
    broken = true;
    const d = (await s.openMethodByKey(PAY))!;
    expect(d.reviewTotal).toBeUndefined();
    expect(d.messages.map((m) => `${m.id} ${m.diff?.inside ?? ''}`)).toEqual(['root ', 'root/0:constructor ', 'root/1:pay 5']);
    // the interface call, no implementation chosen: the changes in its implementations
    const e = (await s.expand('root/1:pay'))!;
    expect(e.messages.find((m) => m.id === 'root/1:pay/0:charge')!.diff?.inside).toBe(1);
    const r = (await s.revealChange('root/1:pay/0:charge'))!;
    expect(r.messageId).toMatch(/^root\/1:pay\/0:charge\//);
    expect(await s.revealChange('root/9:nope')).toBeUndefined();
    expect(await s.revealChange('root/0:constructor')).toBeUndefined();
    // audit() changed, but has nothing changed below it
    expect(await s.revealChange('root/1:pay/1:audit')).toBeUndefined();
    // a tour flow opened now: its first change is the first own mark (no list to count by)
    const tour = (await s.openChangeFlow([[{ methodKey: PAY }]]))!;
    expect([tour.diagram!.reviewTotal, tour.messageId]).toEqual([undefined, 'root/1:pay']);
    await s.dispose();
  });
});

describe('FR-24.15 a call whose method the branch removed', () => {
  it('FR-24.15 the same call, now reaching nothing (its function removed): changed, and what it reached before is named', async () => {
    const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-gone-method-')).replace(/\\/g, '/');
    roots.push(r3);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(r3, rel)), { recursive: true });
      fs.writeFileSync(path.join(r3, rel), text);
    };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: r3, stdio: 'pipe' });
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: false }, include: ['src'] }));
    write('src/stock.ts', `export function reserve() {\n  return 1;\n}\n`);
    write('src/shop.ts', `import { reserve } from './stock';\nexport class Shop {\n  order() {\n    return reserve();\n  }\n}\n`);
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature/stock');
    write('src/stock.ts', `export const stock = 0;\n`);
    git('commit', '-q', '-am', 'feature');
    const s = new DiagramSession({ adapter: createTsAdapter(r3), classifier: createClassifier(r3), createBaseAdapter: () => createTsAdapter(r3) });
    await s.reviewChanges({ base: 'develop' });
    const d = (await s.openMethodByKey('src/shop.ts#Shop.order'))!;
    // the call is the same (by name): it reached reserve() of stock.ts, now nothing
    expect(d.messages.filter((m) => m.methodName === 'reserve').map((m) => [m.id, m.methodKey, m.diff?.status, m.diff?.before])).toEqual([['root/0:reserve', undefined, 'changed', '<module>.reserve']]);
    await s.dispose();
  });
});

describe('FR-24.10 a tour flow from paths that no longer fit the code', () => {
  it('FR-24.10 the entry point of another method is no tag; paths from elsewhere, steps without their call, calls not found and methods gone stop where they are; nothing changed: the found message', async () => {
    const s = session();
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const CHECKOUT = 'src/application/checkout.ts#Checkout.pay';
    const nowhere = { file: `${root}/src/presentation/checkout.controller.ts`, start: { line: 99, character: 0 }, end: { line: 99, character: 1 } };
    // `this.audit(n);` in Checkout.pay (found there, but not reached: the step before it is not)
    const auditCall = { file: `${root}/src/application/checkout.ts`, start: { line: 5, character: 4 }, end: { line: 5, character: 18 } };
    const paths = [
      // without the call to the next step
      [{ methodKey: PAY }, { methodKey: CHECKOUT }],
      // a call not at its place (the path goes on below it)
      [{ methodKey: PAY, call: { range: nowhere } }, { methodKey: CHECKOUT, call: { range: auditCall } }, { methodKey: 'src/application/checkout.ts#Checkout.audit' }],
      // the next method gone
      [{ methodKey: PAY, call: { range: nowhere } }, { methodKey: 'src/gone.ts#Gone.run' }],
      // from another method: not walked
      [{ methodKey: CHECKOUT }],
    ];
    const opened = (await s.openChangeFlow(paths, { ...entry, method: { ...entry.method, key: CHECKOUT } }))!;
    expect(opened.diagram!.root.key).toBe(PAY);
    // not opened from that entry point (the scanned list still names the root's own)
    expect((await s.exportState({ language: 'typescript' }))!.entry).toBeUndefined();
    expect(opened.diagram!.messages.filter((m) => m.expanded).map((m) => m.id)).toEqual(['root']);
    expect((await s.exportState({ language: 'typescript' }))!.expanded).toEqual([]);
    // the first change in diagram order: pay (changed) below the found message
    expect(opened.messageId).toBe('root/1:pay');
    // a flow without changes: the found message
    const plain = (await s.openChangeFlow([[{ methodKey: 'src/infrastructure/rounder.ts#Rounder.round' }]]))!;
    expect(plain.messageId).toBe('root');
    await s.dispose();
  });
});

// the checkout's call is unchanged; only the card gateway's charge() changed
function cardRepo(noops = 0): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-card-')).replace(/\\/g, '/');
  roots.push(r);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    fs.writeFileSync(path.join(r, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: r, stdio: 'pipe' });
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderId: string): number;\n}\n`);
  const card = (v: number) => `import { PaymentGateway } from '../domain/payment-gateway';\nexport class CardGateway implements PaymentGateway {\n  charge(orderId: string) {\n    return ${v};\n  }\n}\n`;
  write('src/infrastructure/card-gateway.ts', card(1));
  write('src/infrastructure/wallet-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class WalletGateway implements PaymentGateway {\n  charge(orderId: string) {\n    return 2;\n  }\n}\n`);
  // (`noops`: pay() first runs bulk(), which makes that many calls)
  const bulk = Array.from({ length: noops }, () => '    this.noop();\n').join('');
  const first = noops ? '    this.bulk();\n' : '';
  write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n${first}    return this.gateway.charge(orderId);\n  }\n  bulk() {\n${bulk}  }\n  noop() {\n    return 0;\n  }\n}\n`);
  write('src/presentation/checkout.controller.ts', `import { Controller, Get } from '../decorators';\nimport { Checkout } from '../application/checkout';\n@Controller('checkout')\nexport class CheckoutController {\n  @Get(':id') pay() { return new Checkout().pay('1'); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/card');
  write('src/infrastructure/card-gateway.ts', card(3));
  git('commit', '-q', '-am', 'feature');
  return r;
}

describe('FR-24.15 ▶ to a change in an implementation below a collapsed call', () => {

  it('FR-24.15 ▶ on the collapsed call: the implementation chosen below it, the way opened, the change reached; showing it by number too', async () => {
    const r = cardRepo();
    const s = new DiagramSession({ adapter: createTsAdapter(r), classifier: createClassifier(r), createBaseAdapter: () => createTsAdapter(r) });
    await s.reviewChanges({ base: 'develop' });
    const d = (await s.openMethodByKey(PAY))!;
    expect([d.reviewTotal, d.messages.find((m) => m.id === 'root/1:pay')!.diff]).toEqual([1, { count: 1, inside: 1, held: [1] }]);
    const revealed = (await s.revealChange('root/1:pay'))!;
    const charge = revealed.diagram!.messages.find((m) => m.id === 'root/1:pay/0:charge')!;
    expect([revealed.messageId, charge.polymorphic?.selectedKey, charge.diff?.count]).toEqual(['root/1:pay/0:charge', 'src/infrastructure/card-gateway.ts#CardGateway', 1]);
    // from a fresh view: by its number
    const t = new DiagramSession({ adapter: createTsAdapter(r), classifier: createClassifier(r), createBaseAdapter: () => createTsAdapter(r) });
    await t.reviewChanges({ base: 'develop' });
    await t.openMethodByKey(PAY);
    const shown = (await t.showChange(1))!;
    expect([shown.messageId, shown.diagram!.messages.find((m) => m.id === 'root/1:pay/0:charge')!.polymorphic?.selectedKey]).toEqual(['root/1:pay/0:charge', 'src/infrastructure/card-gateway.ts#CardGateway']);
    expect(await t.showChange(2)).toBeUndefined();
    await s.dispose();
    await t.dispose();
  });

  it('FR-24.15 ▶ when the view is past its render limit (a big call opened by hand before the change): the way is opened, the view lands on the call that holds it', async () => {
    const r = cardRepo(2000);
    const s = new DiagramSession({ adapter: createTsAdapter(r), classifier: createClassifier(r), createBaseAdapter: () => createTsAdapter(r) });
    await s.reviewChanges({ base: 'develop' });
    await s.openMethodByKey(PAY);
    await s.expand('root/1:pay');
    const d = (await s.expand('root/1:pay/0:bulk'))!;
    // 2000 messages: charge() after bulk()'s calls is not drawn; pay holds its change
    expect([d.messages.length, d.messages.some((m) => m.methodName === 'charge'), d.messages.find((m) => m.id === 'root/1:pay')!.diff?.held]).toEqual([2000, false, [1]]);
    const revealed = (await s.revealChange('root/1:pay'))!;
    expect([revealed.messageId, revealed.diagram!.messages.some((m) => m.methodName === 'charge')]).toEqual(['root/1:pay', false]);
    // by its number: the call that holds it
    expect((await s.showChange(1))!.messageId).toBe('root/1:pay');
    await s.dispose();
  }, 120_000);
});

describe('FR-24.6 the base flow cannot be built', () => {
  it('FR-24.6 a method of the base version fails to load: no comparison (no new or removed calls), the changed lines still marked', async () => {
    let broken = false;
    const base = () => {
      const ts = createTsAdapter(root);
      const a: LanguageAdapter = Object.create(ts);
      a.getOutgoingCalls = (m) => (broken && m.key === 'src/application/checkout.ts#Checkout.pay' ? Promise.reject(new Error('sidecar gone')) : ts.getOutgoingCalls(m));
      return a;
    };
    const s = session({ base });
    await s.reviewChanges({ base: 'develop' });
    broken = true;
    await s.openMethodByKey(PAY);
    const d = (await s.expand('root/1:pay'))!;
    const audit = d.messages.find((m) => m.methodName === 'audit')!;
    expect(audit.diff).toMatchObject({ call: true });
    expect(audit.diff!.status).toBeUndefined();
    expect(d.messages.some((m) => m.diff?.status === 'removed')).toBe(false);
    expect((await s.getClassDiagram())!.classes.some((c) => c.diff === 'removed')).toBe(false);
    await s.dispose();
  });

});

describe('FR-24.9 ▶ without the flow\'s list, below an interface call', () => {
  it('FR-24.9 a changed method both implementations reach: counted once, opened through the first implementation', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-fees-')).replace(/\\/g, '/');
    roots.push(r);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
      fs.writeFileSync(path.join(r, rel), text);
    };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: r, stdio: 'pipe' });
    const gateway = (name: string) => `import { PaymentGateway } from '../domain/payment-gateway';\nimport { Fees } from './fees';\nexport class ${name} implements PaymentGateway {\n  charge(orderId: string) {\n    return new Fees().apply(1);\n  }\n}\n`;
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
    write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
    write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderId: string): number;\n}\n`);
    write('src/infrastructure/card-gateway.ts', gateway('CardGateway'));
    write('src/infrastructure/wallet-gateway.ts', gateway('WalletGateway'));
    write('src/infrastructure/fees.ts', `export class Fees {\n  apply(x: number) {\n    return x;\n  }\n}\n`);
    write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n    return this.gateway.charge(orderId);\n  }\n}\n`);
    // a second route through the wallet only: the fee change is reached below both implementations
    write('src/presentation/checkout.controller.ts', `import { Controller, Get } from '../decorators';\nimport { Checkout } from '../application/checkout';\nimport { WalletGateway } from '../infrastructure/wallet-gateway';\n@Controller('checkout')\nexport class CheckoutController {\n  @Get(':id') pay() { return new Checkout().pay('1'); }\n  @Get('wallet/:id') wallet() { return new WalletGateway().charge('1'); }\n}\n`);
    git('init', '-q', '-b', 'develop');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature/fees');
    write('src/infrastructure/fees.ts', `export class Fees {\n  apply(x: number) {\n    return x * 2;\n  }\n}\n`);
    git('commit', '-q', '-am', 'feature');
    let failOnce = false;
    const ts = createTsAdapter(r);
    const a: LanguageAdapter = Object.create(ts);
    // a host whose references are exact (TypeScript's reach the card's charge() from the wallet route too, through the
    // interface's member)
    a.getCallers = async (m) => (await ts.getCallers(m)).filter((c) => !(m.key.endsWith('#CardGateway.charge') && c.enclosing.name === 'wallet'));
    // the list of the flow's changes cannot be made (the fee method cannot be loaded the first time it is asked)
    a.getMethod = (k) => {
      if (failOnce && k.endsWith('#Fees.apply')) {
        failOnce = false;
        return Promise.reject(new Error('sidecar busy'));
      }
      return ts.getMethod(k);
    };
    const s = new DiagramSession({ adapter: a, classifier: createClassifier(r), createBaseAdapter: () => createTsAdapter(r) });
    const review = (await s.reviewChanges({ base: 'develop' }))!;
    expect(review.methods.find((m) => m.method.name === 'apply')!.reachedFrom.map((x) => x.steps.map((st) => st.methodKey.replace(/^.*#/, '')).join(' > ')).sort()).toEqual([
      'CheckoutController.pay > Checkout.pay > CardGateway.charge > Fees.apply',
      'CheckoutController.wallet > WalletGateway.charge > Fees.apply',
    ]);
    failOnce = true;
    await s.openMethodByKey(PAY);
    const d = (await s.expand('root/1:pay'))!;
    expect([d.reviewTotal, d.messages.find((m) => m.id === 'root/1:pay/0:charge')!.diff]).toEqual([undefined, { inside: 1 }]);
    const revealed = (await s.revealChange('root/1:pay/0:charge'))!;
    expect(revealed.diagram!.messages.find((m) => m.id === 'root/1:pay/0:charge')!.polymorphic?.selectedKey).toBe('src/infrastructure/card-gateway.ts#CardGateway');
    await s.dispose();
  });
});
