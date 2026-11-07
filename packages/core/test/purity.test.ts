import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { suggestLayer } from '../src/layer-hints';
import { C, file, newSession, positionOf, sharedAdapter } from './helpers';

const SHIPPING = 'src/services/shipping-service.ts';
const keyOf = (rel: string, name: string) => `${rel}#${name}`;

describe('FR-7.7 purity layer hint', () => {
  it('FR-7.7 module facts: ports taken, libraries used, project dependencies (whole file)', async () => {
    const a = sharedAdapter();
    const user = (await a.getModuleFacts!(C.UserService))!;
    expect(user.ports).toEqual(['UserRepository', 'Notifier']);
    expect(user.dependsOn.map((d) => d.name)).toEqual(expect.arrayContaining(['UserRepository', 'Notifier', 'User']));
    const shipping = (await a.getModuleFacts!(keyOf(SHIPPING, 'ShippingService')))!;
    expect(shipping.ports).toEqual([]);
    expect(shipping.dependsOn.map((d) => d.name).sort()).toEqual(['ShippingPolicy', 'User']);
  });

  it('FR-7.7 libraries are reported; an I/O library or an impure dependency makes a module impure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-pure-')).replace(/\\/g, '/');
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false }, include: ['src'] }));
    write('src/application/rules.ts', `export function score(n: number) { return n * 2; }`);
    write('src/application/files.ts', `import { readFile } from 'node:fs/promises';\nexport async function load(p: string) { return readFile(p, 'utf8'); }`);
    write('src/application/uses-files.ts', `import { load } from './files';\nexport async function total(p: string) { return (await load(p)).length; }`);
    write('src/application/main.ts', `import { score } from './rules';\nimport { total } from './uses-files';\nexport async function run(p: string) { return score(await total(p)); }`);
    try {
      const adapter = createTsAdapter(root);
      expect((await adapter.getModuleFacts!('src/application/files.ts#<module>'))!.libraries).toEqual(['node:fs/promises']);
      const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
      const d = (await s.openAt(`${root}/src/application/main.ts`, { line: 2, character: 40 }))!;
      const hint = (name: string) => d.participants.find((p) => p.className === name)?.layerHint;
      expect(hint('rules')).toMatchObject({ suggested: 'Domain' });
      expect(hint('uses-files')).toBeUndefined(); // depends on files, which does I/O
      await adapter.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FR-7.7 an Application class whose whole file is pure gets ⚑ Domain; one that takes ports does not', async () => {
    const s = newSession();
    const d = (await s.openAt(file(SHIPPING), positionOf(SHIPPING, 'ship(')))!;
    const shipping = d.participants.find((p) => p.className === 'ShippingService')!;
    expect(shipping.layer).toBe('Application');
    expect(shipping.layerHint).toEqual({
      suggested: 'Domain',
      reasons: ['pure (whole file): takes no ports, no I/O', 'depends only on Domain or pure code: User, ShippingPolicy'],
    });
    const u = (await s.openAt(file('src/services/user-service.ts'), positionOf('src/services/user-service.ts', 'const cached')))!;
    expect(u.participants.find((p) => p.classKey === C.UserService)!.layerHint).toBeUndefined();
  });

  it('FR-7.7 pure technical code (utilities, helpers, extensions) is hinted only when Domain uses it', () => {
    const ref = { key: 'src/Core/Util/Format.cs#Format', name: 'Format', kind: 'class' as const };
    const input = { ref, layer: 'Application', calls: [], analysedMethods: 1, classify: () => ({ stereotypes: [], namespace: '' }), typeByName: new Map(), purity: { pure: true, reasons: ['pure (whole file): takes no ports, no I/O', 'no project dependencies'] } };
    expect(suggestLayer(input)).toBeUndefined();
    expect(suggestLayer({ ...input, ref: { ...ref, key: 'src/Core/Pricing/PriceHelpers.cs#PriceHelpers', name: 'PriceHelpers' } })).toBeUndefined();
    expect(suggestLayer({ ...input, usedByDomain: ['Order'] })?.reasons[0]).toBe('used by Domain: Order');
  });

  it('FR-7.7 known impurity overrides the partial evidence of the analysed calls (no false Domain hint)', () => {
    const base = {
      ref: { key: 'src/application/scan.ts#<module>', name: 'scan', kind: 'module' as const },
      layer: 'Application',
      calls: [],
      analysedMethods: 1,
      classify: () => ({ stereotypes: [], namespace: 'src/application' }),
      typeByName: new Map(),
      info: { ref: { key: 'src/application/scan.ts#<module>', name: 'scan', kind: 'module' as const }, methods: [{ name: 'reportable', signature: 'reportable(repos: ScanBranch[]): PendingNotice[]' }], fields: [], constructorParams: [] } as never,
    };
    expect(suggestLayer(base)?.suggested).toBe('Domain'); // the old partial view: one pure-looking function
    expect(suggestLayer({ ...base, purity: { pure: false, reasons: ['takes ports: ScanPorts'] } })).toBeUndefined();
  });
});
