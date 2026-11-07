import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * FR-24.15 a git repository (TS) whose branch changes a checkout paying through an interface with two
 * implementations, both changed (the shape of a provider client whose signature changed: one implementation got a
 * new helper, the other only its parameters), then audits the payment after the interface call. Shared by the core
 * and webview review tests. Returns the root; the branch is checked out, `develop` is the base.
 */
export function makeGatewayRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-flow-changes-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderId: string): number;\n}\n`);
  write('src/infrastructure/card-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nimport { Rounder } from './rounder';\nexport class CardGateway implements PaymentGateway {\n  charge(orderId: string) {\n    return this.fee(1);\n  }\n  fee(x: number) {\n    return new Rounder().round(x);\n  }\n}\n`);
  write('src/infrastructure/rounder.ts', `export class Rounder {\n  round(x: number) {\n    return x;\n  }\n}\n`);
  write('src/infrastructure/wallet-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class WalletGateway implements PaymentGateway {\n  charge(orderId: string) {\n    return 2;\n  }\n}\n`);
  write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n    return this.gateway.charge(orderId);\n  }\n}\n`);
  write('src/presentation/checkout.controller.ts', `import { Controller, Get } from '../decorators';\nimport { Checkout } from '../application/checkout';\n@Controller('checkout')\nexport class CheckoutController {\n  @Get(':id') pay() { return new Checkout().pay('1'); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/batch');
  // charge() takes a list now; the card gateway charges each through a new helper, the wallet one counts them
  write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderIds: string[]): number;\n}\n`);
  // …and a blank line added between the helper and fee() (fee itself unchanged)
  write('src/infrastructure/card-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nimport { Rounder } from './rounder';\nexport class CardGateway implements PaymentGateway {\n  charge(orderIds: string[]) {\n    return this.chargeOne(orderIds[0]);\n  }\n  chargeOne(orderId: string) {\n    return this.fee(1);\n  }\n\n  fee(x: number) {\n    return new Rounder().round(x);\n  }\n}\n`);
  write('src/infrastructure/wallet-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class WalletGateway implements PaymentGateway {\n  charge(orderIds: string[]) {\n    return orderIds.length;\n  }\n}\n`);
  // …and the checkout audits the payment after it: a new call after the interface call
  write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n    const n = this.gateway.charge([orderId]);\n    this.audit(n);\n    return n;\n  }\n  audit(n: number) {\n    return n;\n  }\n}\n`);
  git('commit', '-q', '-am', 'feature');
  return root;
}

/**
 * a branch that changes an interface method (a new optional parameter) and not its one implementation,
 * and adds an audit call to the checkout. Returns the root; the branch is checked out, `develop` is the base.
 */
export function makeInterfaceOnlyRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-interface-only-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderId: string): number;\n}\n`);
  write('src/infrastructure/card-gateway.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class CardGateway implements PaymentGateway {\n  charge(orderId: string) {\n    return 1;\n  }\n}\n`);
  write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n    return this.gateway.charge(orderId);\n  }\n  audit(n: number) {\n    return n;\n  }\n}\n`);
  write('src/presentation/checkout.controller.ts', `import { Controller, Get } from '../decorators';\nimport { Checkout } from '../application/checkout';\n@Controller('checkout')\nexport class CheckoutController {\n  @Get(':id') pay() { return new Checkout().pay('1'); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/note');
  write('src/domain/payment-gateway.ts', `export interface PaymentGateway {\n  charge(orderId: string, note?: string): number;\n}\n`);
  write('src/application/checkout.ts', `import { PaymentGateway } from '../domain/payment-gateway';\nexport class Checkout {\n  private gateway: PaymentGateway;\n  pay(orderId: string) {\n    const n = this.gateway.charge(orderId);\n    this.audit(n);\n    return n;\n  }\n  audit(n: number) {\n    return n;\n  }\n}\n`);
  git('commit', '-q', '-am', 'feature');
  return root;
}
