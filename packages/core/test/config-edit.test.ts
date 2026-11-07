import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addFindingIgnore, addLayerHintIgnore, removeIgnore, setFileLayer, setLayerRule, layerScopes, relPathOfKey, ensureDependencyRule } from '../src/config-edit';

describe('FR-7.5 setting a class layer writes a rule to .seqcall.json', () => {
  it('creates the config when there is none', () => {
    const out = setFileLayer(undefined, 'src/App.Core/Utils/DateUtil.cs', 'Domain');
    expect(parse(out)).toEqual({ layers: [{ name: 'Domain', match: ['src/App.Core/Utils/DateUtil.cs'] }] });
  });

  it('puts the rule first (it wins over broader rules) and keeps comments and other settings', () => {
    const text = `{
  // team rules
  "layers": [
    { "name": "Presentation", "match": ["**/infrastructure/http/**"] }
  ],
  "associationNames": "all" // keep
}
`;
    const out = setFileLayer(text, 'src/x.ts', 'Domain');
    expect(out).toContain('// team rules');
    expect(out).toContain('// keep');
    const cfg = parse(out);
    expect(cfg.layers[0]).toEqual({ name: 'Domain', match: ['src/x.ts'] });
    expect(cfg.layers[1]).toEqual({ name: 'Presentation', match: ['**/infrastructure/http/**'] });
    expect(cfg.associationNames).toBe('all');
  });

  it('moving the same file again replaces its earlier single-file rule', () => {
    const once = setFileLayer('{ "layers": [] }', 'src/x.ts', 'Domain');
    const twice = setFileLayer(once, 'src/x.ts', 'Application');
    expect(parse(twice).layers).toEqual([{ name: 'Application', match: ['src/x.ts'] }]);
  });

  it('FR-7.5 a config holding only a comment (no object yet): the rule is added, the comment kept', () => {
    expect(setLayerRule('// layers come later', 'src/a.ts', 'Domain')).toBe(
      '{\n  "layers": [\n    {\n      "name": "Domain",\n      "match": [\n        "src/a.ts"\n      ]\n    }\n  ]\n} // layers come later\n',
    );
    expect(addFindingIgnore('// later', 'Shop.*')).toBe('{\n  "findings": {\n    "ignore": [\n      "Shop.*"\n    ]\n  }\n} // later\n');
    expect(addLayerHintIgnore('// later', 'src/x/**')).toBe('{\n  "layerHints": {\n    "ignore": [\n      "src/x/**"\n    ]\n  }\n} // later\n');
  });

  it('adds "layers" to an existing config without it', () => {
    expect(parse(setFileLayer('{ "testFiles": ["e2e/**"] }', 'a.ts', 'Domain'))).toEqual({ testFiles: ['e2e/**'], layers: [{ name: 'Domain', match: ['a.ts'] }] });
  });

  it('derives the file from a class key', () => {
    expect(relPathOfKey('src/App.Core/Utils/DateUtil.cs#DateUtil')).toBe('src/App.Core/Utils/DateUtil.cs');
    expect(relPathOfKey('lib:System.Net.Http#HttpClient')).toBeUndefined();
  });
});

describe('FR-19.10 "Ignore …" on a finding adds a pattern to findings.ignore', () => {
  it('creates the config, appends to an existing list once, and keeps comments and other settings', () => {
    expect(parse(addFindingIgnore(undefined, 'helpers.setting'))).toEqual({ findings: { ignore: ['helpers.setting'] } });
    const text = `{
  // team rules
  "layers": [],
  "findings": { "maxDependencies": 8, "ignore": ["*Cache*"] }
}
`;
    const out = addFindingIgnore(text, 'Metrics.increment');
    expect(out).toContain('// team rules');
    expect(parse(out)).toEqual({ layers: [], findings: { maxDependencies: 8, ignore: ['*Cache*', 'Metrics.increment'] } });
    expect(addFindingIgnore(out, 'Metrics.increment')).toBe(out);
    expect(parse(addFindingIgnore('{ "findings": { "disable": ["layer-ping-pong"] } }', 'Order'))).toEqual({ findings: { disable: ['layer-ping-pong'], ignore: ['Order'] } });
  });
});

describe('FR-12.16 ensureDependencyRule', () => {
  it('adds the default rule when missing (also to a new config) and points at its line; an existing rule is kept', () => {
    const created = ensureDependencyRule(undefined);
    expect(created.changed).toBe(true);
    expect(JSON.parse(created.text).dependencyRule).toMatchObject({ Domain: 0, Application: 1, Infrastructure: 2 });
    expect(created.text.split('\n')[created.line]).toContain('"dependencyRule"');
    const withLayers = '{\n  // our layers\n  "layers": []\n}\n';
    const added = ensureDependencyRule(withLayers);
    expect(added.text).toContain('// our layers');
    expect(added.text.split('\n')[added.line]).toContain('"dependencyRule"');
    const own = '{\n  "layers": [],\n  "dependencyRule": { "Domain": 0, "Web": 3 }\n}\n';
    expect(ensureDependencyRule(own)).toEqual({ text: own, line: 2, changed: false });
  });

  it('FR-12.16 a config without a final line break gets one; a broken key the parser cannot place opens the file at the top', () => {
    expect(ensureDependencyRule('{"a": 1}')).toMatchObject({ line: 2, changed: true, text: expect.stringMatching(/^\{\n  "a": 1,\n  "dependencyRule": \{[^]*\}\n\}\n$/) });
    const broken = ensureDependencyRule('{"dependencyRule": }');
    expect(broken).toMatchObject({ line: 0, changed: true });
  });
});


describe('FR-7.12 Move to layer: what the rule covers', () => {
  const PHP = path.resolve(__dirname, '../../../fixtures/php-app');

  it('FR-7.12 scopes: the file, its folder and the folders above it (not the top level), every class named like it; counted on disk', () => {
    const scopes = layerScopes(PHP, 'src/Payments/StripeGateway.php#StripeGateway', 'StripeGateway');
    expect(scopes[0]).toEqual({ kind: 'file', glob: 'src/Payments/StripeGateway.php', files: 1 });
    expect(scopes.find((s) => s.kind === 'folder')).toEqual({ kind: 'folder', glob: 'src/Payments/**', files: 3 });
    expect(scopes.some((s) => s.glob === 'src/**')).toBe(false); // the top level is never offered
    // OrderService, BillingService, QuoteService, ReportService: every *Service.php
    expect(layerScopes(PHP, 'src/Services/OrderService.php#OrderService', 'OrderService').find((s) => s.kind === 'name')).toEqual({ kind: 'name', glob: '**/*Service.php', files: 4 });
    // a package file: folders below the package, names within the package
    const pkg = layerScopes(PHP, 'vendor/seqcall/billing/src/Http/WebhookController.php#WebhookController', 'WebhookController');
    expect(pkg.every((s) => s.glob.startsWith('vendor/seqcall/billing/'))).toBe(true);
  });

  it('FR-7.12 the rule for a glob goes first; the same glob again replaces it', () => {
    let out = setLayerRule(undefined, 'app/Managers/**', 'Application');
    out = setLayerRule(out, 'app/Models/**', 'Domain');
    out = setLayerRule(out, 'app/Managers/**', 'Infrastructure');
    expect(parse(out).layers).toEqual([
      { name: 'Infrastructure', match: ['app/Managers/**'] },
      { name: 'Domain', match: ['app/Models/**'] },
    ]);
  });
});

describe('FR-7.11 silencing a layer hint writes a file glob to layerHints.ignore', () => {
  it('creates the setting, appends without duplicates, keeps comments and other settings', () => {
    expect(parse(addLayerHintIgnore(undefined, 'src/pages/products/model/products.hooks.ts'))).toEqual({ layerHints: { ignore: ['src/pages/products/model/products.hooks.ts'] } });
    const text = `{
  // team rules
  "layers": [],
  "layerHints": { "ignore": ["src/legacy/**"] }
}
`;
    const out = addLayerHintIgnore(text, 'src/pages/x/model/a.ts');
    expect(out).toContain('// team rules');
    expect(parse(out)).toEqual({ layers: [], layerHints: { ignore: ['src/legacy/**', 'src/pages/x/model/a.ts'] } });
    expect(addLayerHintIgnore(out, 'src/legacy/**')).toBe(out);
  });
});

describe('FR-19.22 Stop ignoring removes a pattern from findings.ignore / layerHints.ignore', () => {
  it('removes just that pattern, keeps comments and other settings; a pattern not there leaves the text as it is', () => {
    const text = `{
  // team rules
  "findings": { "ignore": ["Metrics.increment", "Logger"], "disable": ["god-class"] },
  "layerHints": { "ignore": ["src/legacy/**"] }
}
`;
    const out = removeIgnore(text, 'findings', 'Metrics.increment')!;
    expect(out).toContain('// team rules');
    expect(parse(out)).toEqual({ findings: { ignore: ['Logger'], disable: ['god-class'] }, layerHints: { ignore: ['src/legacy/**'] } });
    expect(parse(removeIgnore(out, 'layerHints', 'src/legacy/**')!)).toEqual({ findings: { ignore: ['Logger'], disable: ['god-class'] }, layerHints: { ignore: [] } });
    expect(removeIgnore(text, 'findings', 'src/legacy/**')).toBe(text);
    expect(removeIgnore('{ "layers": [] }', 'layerHints', 'x')).toBe('{ "layers": [] }');
    expect(removeIgnore(undefined, 'findings', 'x')).toBeUndefined();
    // a file without a final line break gets one
    const last = removeIgnore('{ "findings": { "ignore": ["A"] } }', 'findings', 'A')!;
    expect(parse(last)).toEqual({ findings: { ignore: [] } });
    expect(last.endsWith('}\n')).toBe(true);
  });
});

describe('FR-7.12 Move to layer: scopes of files at the edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-scopes-')).replace(/\\/g, '/');
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const touch = (rel: string) => {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, '<?php');
  };

  it('FR-7.12 a library or unknown class has no scopes; a file at the top level only itself', () => {
    expect(layerScopes(root, 'lib:System#Object', 'Object')).toEqual([]);
    expect(layerScopes(root, 'unknown', 'X')).toEqual([]);
    touch('Kernel.php');
    touch('Console.php');
    expect(layerScopes(root, 'Kernel.php#Kernel', 'Kernel')).toEqual([{ kind: 'file', glob: 'Kernel.php', files: 1 }]);
  });

  it('FR-7.12 a file one level down: its folder is offered (it is not the project top); a folder not on disk counts nothing', () => {
    touch('app/OrderHelper.php');
    touch('app/PriceHelper.php');
    expect(layerScopes(root, 'app/OrderHelper.php#OrderHelper', 'OrderHelper')).toEqual([
      { kind: 'file', glob: 'app/OrderHelper.php', files: 1 },
      { kind: 'folder', glob: 'app/**', files: 2 },
      { kind: 'name', glob: '**/*Helper.php', files: 2 },
    ]);
    // a class whose file is gone (an index older than the disk)
    expect(layerScopes(root, 'gone/Deep/Ship.php#Ship', 'Ship')).toEqual([{ kind: 'file', glob: 'gone/Deep/Ship.php', files: 1 }]);
  });

  it('FR-7.12 no name scope for a two-letter role word or a file not named after the class', () => {
    touch('src/A/OrderIo.php');
    touch('src/B/UserIo.php');
    touch('src/A/helpers.php');
    touch('src/B/more-helpers.php');
    expect(layerScopes(root, 'src/A/OrderIo.php#OrderIo', 'OrderIo').map((s) => s.kind)).toEqual(['file', 'folder']);
    expect(layerScopes(root, 'src/A/helpers.php#OrderHelper', 'OrderHelper').map((s) => s.kind)).toEqual(['file', 'folder']);
  });
});


describe('FR-7.5 / FR-19.10 / FR-7.11 / FR-12.16 a config that holds no JSON object', () => {
  const edits: [string, (text: string) => unknown][] = [
    ['setLayerRule', (t) => setLayerRule(t, 'src/Order.ts', 'Domain')],
    ['addFindingIgnore', (t) => addFindingIgnore(t, 'Order.*')],
    ['addLayerHintIgnore', (t) => addLayerHintIgnore(t, 'src/legacy/**')],
    ['ensureDependencyRule', (t) => ensureDependencyRule(t)],
  ];
  it.each([
    ['null', 'null'],
    ['an array', '[{ "name": "Domain" }]'],
    ['number', '42'],
    ['string', '"layers"'],
  ])('a config that is %s is not overwritten: every edit says what is wrong', (what, text) => {
    for (const [, edit] of edits) expect(() => edit(text)).toThrow(`.seqcall.json does not hold a JSON object (${what}); fix it by hand first`);
  });

  it('a config with only a comment is no error: the setting is added below it', () => {
    for (const [name, edit] of edits) expect(String(JSON.stringify(edit('// layers come later\n'))), name).toContain('layers come later');
  });
});
