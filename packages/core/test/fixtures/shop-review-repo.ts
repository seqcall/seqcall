import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * FR-24 a git repository (TS) for reviews of class changes and removed calls: on the branch Order changes its fields
 * (one of another type, one no longer a list, one removed, one added) and base types and gains a method; Invoice no longer
 * extends Entity, Receipt implements Named now, a new class Credit joins their file (it uses Coupon, of a new file); Audit moves to auditor.ts (its log() marks
 * instead of stamping); Shop passes fee() an argument and audits another text (two changed lines in a row), drops its last audit call and cancel's (cancel() calls the changed total() twice), and creates a Credit. Returns the root; the branch is checked out, `develop` is the base.
 */
export function makeShopReviewRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-shop-review-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/domain/base.ts', `export class Entity {}\nexport interface Auditable {}\nexport interface Named {}\nexport type Runner = (n: number) => number;\n`);
  write('src/domain/money.ts', `export class Money {\n  amount = 0;\n}\n`);
  const tax = `export class Tax {\n  rate() {\n    return 0.2;\n  }\n}\n`;
  write('src/domain/order.ts', `import { Entity } from './base';\nimport { Money } from './money';\nexport class Order extends Entity {\n  lines: Money[];\n  note: Money;\n  tag: Money;\n  count: number;\n  name: Money;\n  stock: Money;\n  constructor() {\n    super();\n    this.count = 0;\n  }\n  total() {\n    const round = (x: number) => {\n      return x;\n    };\n    return round(new Tax().rate() + 1);\n  }\n}\n${tax}`);
  write('src/domain/invoice.ts', `import { Entity, Runner } from './base';\nexport class Invoice extends Entity {\n  sum() {\n    return 1;\n  }\n  due() {\n    return 2;\n  }\n}\nexport class Receipt {\n  run: Runner;\n  print() {\n    return 1;\n  }\n}\n`);
  const audit = (first: string) =>
    `export class Audit {\n  log(what: string) {\n    ${first}\n    const line = what.trim();\n    const at = Date.now();\n    const who = 'shop';\n    const where = 'here';\n    const why = 'audit';\n    return \`\${who} \${at} \${line} \${where} \${why}\`;\n  }\n  stamp() {\n    return 1;\n  }\n  mark() {\n    return 2;\n  }\n}\n`;
  write('src/application/audit.ts', audit('this.stamp();'));
  write(
    'src/application/shop.ts',
    `import { Order } from '../domain/order';\nimport { Invoice, Receipt } from '../domain/invoice';\nimport { Audit } from './audit';\nexport function fee() {\n  return 1;\n}\nexport class Shop {\n  place() {\n    fee();\n    new Audit().log('a');\n    const o = new Order();\n    o.total();\n    new Invoice().sum();\n    new Receipt().print();\n    new Audit()\n      .log('z');\n  }\n  cancel() {\n    new Audit().log('c');\n    return new Order().total() + new Order().total();\n  }\n}\n`,
  );
  write('src/presentation/shop.controller.ts', `import { Controller, Get } from '../decorators';\nimport { Shop } from '../application/shop';\n@Controller('shop')\nexport class ShopController {\n  @Get() show() { return new Shop().place(); }\n  @Get('c') cancel() { return new Shop().cancel(); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/orders');
  // lines: no longer a list; tag: another type; note: gone; price: new
  // count: a type now, name: none now; the constructor changed; Tax (same file) unchanged
  write('src/domain/order.ts', `import { Auditable } from './base';\nimport { Money } from './money';\nimport { Receipt } from './invoice';\nexport class Order implements Auditable {\n  lines: Money;\n  tag: Receipt;\n  price: Money;\n  count: Money;\n  name: string;\n  stock: Money;\n  constructor() {\n    this.count = null;\n  }\n  total() {\n    const round = (x: number) => {\n      return Math.round(x);\n    };\n    return round(new Tax().rate() + 2);\n  }\n  extra() {\n    return 3;\n  }\n}\n${tax}`);
  // Invoice: due() moved above sum() (its lines are new, its signature is not); Receipt: Named's new label()
  write('src/domain/invoice.ts', `import { Named, Runner } from './base';\nimport { Coupon } from './coupon';\nexport class Invoice {\n  due() {\n    return 2;\n  }\n  sum() {\n    return 1;\n  }\n}\nexport class Receipt implements Named {\n  run: Runner;\n  print() {\n    return 1;\n  }\n  label() {\n    return 'r';\n  }\n}\nexport class Credit {\n  x() {\n    new Coupon().apply();\n    (this as any)\n      .zap();\n    return 0;\n  }\n}\n`);
  // a new file
  write('src/domain/coupon.ts', `export class Coupon {\n  apply() {\n    return 1;\n  }\n}\n`);
  // Runner takes a string now: Receipt's run property has another signature, its own lines unchanged
  write('src/domain/base.ts', `export class Entity {}\nexport interface Auditable {}\nexport interface Named {\n  label(): string;\n}\nexport type Runner = (n: string) => number;\n`);
  fs.rmSync(path.join(root, 'src/application/audit.ts'));
  write('src/application/auditor.ts', audit('this.mark();'));
  write(
    'src/application/shop.ts',
    `import { Order } from '../domain/order';\nimport { Invoice, Receipt, Credit } from '../domain/invoice';\nimport { Named } from '../domain/base';\nimport { Audit } from './auditor';\nexport function fee() {\n  return 2;\n}\nexport class Shop {\n  place() {\n    fee(2);\n    new Audit().log('b');\n    const o = new Order();\n    o.total();\n    const n: Named = new Receipt();\n    n.label();\n    new Credit().x();\n    new Invoice().sum();\n    new Receipt().print();\n  }\n  cancel() {\n    return new Order().total() + new Order().total();\n  }\n}\n`,
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'feature');
  return root;
}
