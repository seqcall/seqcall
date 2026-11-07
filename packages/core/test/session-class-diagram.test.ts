import { describe, expect, it } from 'vitest';
import type { LanguageAdapter } from '../src/adapter';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { tsProject } from './ts-project';
import { fakeSession, meth, cls } from './fake-world';

// FR-12 the class diagram a session derives, in states the sample projects do not reach.
describe('FR-12 the class diagram of a session', () => {
  it('FR-12 before a diagram is open there is no class diagram', async () => {
    expect(await fakeSession({ methods: [meth(cls('src/Shop.cs', 'Shop'), 'Run')] }).getClassDiagram()).toBeUndefined();
  });

  it('FR-11.8 a hidden category stays out of the class diagram when only a type use names it', async () => {
    const p = tsProject({
      'src/order.ts': `export class OrderDto { id = ''; }\nexport class Invoice { n = 0; }\n`,
      'src/repo.ts': `import { OrderDto, Invoice } from './order';\nexport class Repo {\n  load(o: OrderDto): Invoice { return new Invoice(); }\n}\n`,
      'src/shop.ts': `import { Repo } from './repo';\nexport class Shop {\n  private repo = new Repo();\n  order() {\n    this.repo.load(null);\n  }\n}\n`,
    });
    const s = new DiagramSession({ adapter: p.adapter, classifier: createClassifier(p.root) });
    await s.openMethod(await p.method('src/shop.ts#Shop.order'));
    await s.setOption('showTypeUses', true);
    const names = async () => (await s.getClassDiagram())!.classes.map((c) => c.name).sort();
    expect(await names()).toEqual(['Invoice', 'OrderDto', 'Repo', 'Shop']);
    await s.hide({ kind: 'classPattern', pattern: '*Dto' });
    expect(await names()).toEqual(['Invoice', 'Repo', 'Shop']);
    // a «don't expand» rule hides nothing
    await s.unhideAll();
    await s.hide({ kind: 'classPattern', pattern: '*Dto', noExpand: true });
    expect(await names()).toEqual(['Invoice', 'OrderDto', 'Repo', 'Shop']);
  });

  it('FR-12.12 type uses: a method called twice is listed once, with its first call; library and unresolved calls add none', async () => {
    const p = tsProject({
      'src/order.ts': `export class Order { id = ''; }\nexport class Invoice { n = 0; }\n`,
      'src/repo.ts': `import { Order, Invoice } from './order';\nexport class Repo {\n  load(o: Order): Invoice { return new Invoice(); }\n}\n`,
      'src/shop.ts': `import { Repo } from './repo';\nexport class Shop {\n  private repo = new Repo();\n  order(id: string) {\n    this.repo.load(null);\n    this.repo.load(null);\n    console.log(id);\n    (id as any).foo();\n  }\n}\n`,
    });
    // the type uses asked for: never a library's method
    const asked: string[] = [];
    const adapter: LanguageAdapter = Object.create(p.adapter);
    adapter.getTypeUses = (m) => {
      asked.push(m.key);
      return p.adapter.getTypeUses!(m);
    };
    const s = new DiagramSession({ adapter, classifier: createClassifier(p.root) });
    await s.openMethod(await p.method('src/shop.ts#Shop.order'));
    await s.setOption('showLibraryCalls', true);
    const d = (await s.setOption('showTypeUses', true))!;
    expect(d.messages.map((m) => `${m.id} ${m.isLibrary ? 'library' : (m.methodKey ?? 'unresolved')}`)).toEqual(['root src/shop.ts#Shop.order', 'root/0:load src/repo.ts#Repo.load', 'root/1:load src/repo.ts#Repo.load', 'root/2:log library', 'root/3:foo unresolved']);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.filter((r) => r.kind === 'use').map((r) => `${r.from} → ${r.to}: ${r.uses!.map((u) => `${u.method} at ${u.messageId}`).join(', ')}`)).toEqual([
      'src/repo.ts#Repo → src/order.ts#Order: Repo.load at root/0:load',
      'src/repo.ts#Repo → src/order.ts#Invoice: Repo.load at root/0:load',
    ]);
    expect(asked.sort()).toEqual(['src/repo.ts#Repo.load', 'src/shop.ts#Shop.order']);
  });

  it('FR-12.12 a layer violation by a call is an issue; one only a type use makes is drawn and counted apart', async () => {
    const p = tsProject({
      '.seqcall.json': JSON.stringify({ layers: [{ name: 'Domain', match: ['src/domain/**'] }, { name: 'Infrastructure', match: ['src/infra/**'] }] }),
      'src/infra/db.ts': `export class Row { id = ''; }\nexport class Db {\n  static query(sql: string) { return sql; }\n}\n`,
      'src/domain/order.ts': `import { Db, Row } from '../infra/db';\nexport class Order {\n  save(r: Row) {\n    Db.query('x');\n  }\n}\n`,
    });
    const s = p.session();
    await s.openMethod(await p.method('src/domain/order.ts#Order.save'));
    await s.setOption('showTypeUses', true);
    const cd = (await s.getClassDiagram())!;
    expect(cd.relations.filter((r) => r.violation).map((r) => `${r.kind} ${r.to}`)).toEqual(['dependency src/infra/db.ts#Db', 'use src/infra/db.ts#Row']);
    expect(cd.findings!.map((f) => [f.kind, f.classKeys])).toEqual([['layer-violation', ['src/domain/order.ts#Order', 'src/infra/db.ts#Db']]]);
    expect(cd.typeUseViolations).toBe(1);
  });

  it('FR-12.12 other design issues beside the violation do not change the count of type-use violations', async () => {
    const p = tsProject({
      '.seqcall.json': JSON.stringify({ layers: [{ name: 'Domain', match: ['src/domain/**'] }, { name: 'Infrastructure', match: ['src/infra/**'] }], findings: { godClass: { methods: 1, lines: 1, fields: 1 } } }),
      'src/infra/db.ts': `export class Row { id = ''; }\nexport class Db {\n  static query(sql: string) { return sql; }\n}\n`,
      'src/domain/order.ts': `import { Db, Row } from '../infra/db';\nexport class Order {\n  private n = 0;\n  save(r: Row) {\n    Db.query('x');\n  }\n}\n`,
    });
    const s = p.session();
    await s.openMethod(await p.method('src/domain/order.ts#Order.save'));
    await s.setOption('showTypeUses', true);
    const cd = (await s.getClassDiagram())!;
    expect(cd.findings!.map((f) => f.kind).sort()).toEqual(['god-class', 'layer-violation']);
    expect(cd.typeUseViolations).toBe(1);
  });
});
