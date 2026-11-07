import { UserService } from '../services/user-service';
import { BillingService } from '../services/billing-service';

export class AdminController {
  constructor(
    private readonly users: UserService,
    private readonly billing: BillingService,
  ) {}

  async audit(id: string): Promise<string> {
    const user = await this.users.findUser(id);
    return this.billing.bill(user, 0);
  }
}
