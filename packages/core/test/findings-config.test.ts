import { describe, expect, it } from 'vitest';
import { DefaultClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { DEFAULT_TSCONFIG, tsProject } from './ts-project';

// FR-19.10 / FR-19.11 the `findings` section of .seqcall.json as the session applies it: a hand-edited file,
// so its values may be of any type.
// one project for all cases (the program is the slow part); the settings come as the classifier's config
const project = tsProject(
  {
    'src/stock.ts': `export class Stock {\n  take(id: string) { return id; }\n}\n`,
    'src/mailer.ts': `export class Mailer {\n  send(id: string) { return id; }\n}\n`,
    'src/shop.ts': `import { Stock } from './stock';\nimport { Mailer } from './mailer';\nexport class Shop {\n  constructor(private stock: Stock, private mailer: Mailer) {}\n  order(id: string) {\n    this.stock.take(id);\n    this.mailer.send(id);\n  }\n}\n`,
  },
  DEFAULT_TSCONFIG,
  true,
);
async function findings(cfg: unknown) {
  const s = new DiagramSession({ adapter: project.adapter, classifier: new DefaultClassifier(project.root, { findings: cfg } as never) });
  const d = (await s.openMethod(await project.method('src/shop.ts#Shop.order')))!;
  return (d.findings ?? []).map((f) => f.title);
}

describe('FR-19.11 findings settings from the config file', () => {
  it('FR-19.11 maxDependencies: a class with more injected collaborators is reported; the default (6) leaves two alone', async () => {
    expect(await findings({ maxDependencies: 1 })).toEqual(['Too many dependencies: Shop (2 injected)']);
    expect(await findings({ maxDependencies: 2 })).toEqual([]);
    // not a number: the default
    expect(await findings({ maxDependencies: '1' })).toEqual([]);
  });

  it('FR-19.10 ignore: globs on class names silence a finding; empty entries, non-strings or a single string are no globs', async () => {
    expect(await findings({ maxDependencies: 1, ignore: ['Sh*'] })).toEqual([]);
    expect(await findings({ maxDependencies: 1, ignore: ['', 7, 'Sh*'] })).toEqual([]);
    expect(await findings({ maxDependencies: 1, ignore: ['', 7, ['Sh*']] })).toEqual(['Too many dependencies: Shop (2 injected)']);
    expect(await findings({ maxDependencies: 1, ignore: 'Shop' })).toEqual(['Too many dependencies: Shop (2 injected)']);
  });
});
