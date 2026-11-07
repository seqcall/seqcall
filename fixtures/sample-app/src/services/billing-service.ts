import type { User } from '../domain/user';
import { Logger } from '../util/logger';

/** Interface with exactly one implementation (FR-8.5). */
export interface PaymentGateway {
  charge(customerId: string, amount: number): Promise<string>;
}

export class StripeGateway implements PaymentGateway {
  async charge(customerId: string, amount: number): Promise<string> {
    Logger.info(`charging ${customerId}`);
    return `ch_${customerId}_${amount}`;
  }
}

export class BillingService {
  constructor(private readonly gateway: PaymentGateway = new StripeGateway()) {}

  async bill(user: User, amount: number): Promise<string> {
    const receipt = await this.gateway.charge(user.id, amount);
    Logger.info(receipt);
    return receipt;
  }
}

/** Exported module-level instance: «singleton». */
export const billingService = new BillingService();
