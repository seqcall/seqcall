import type { User } from '../domain/user';
import { Logger } from '../util/logger';

export abstract class Notifier {
  abstract notify(user: User, message: string): Promise<void>;

  protected format(user: User, message: string): string {
    return `${user.email}: ${message}`;
  }
}

export class EmailNotifier extends Notifier {
  async notify(user: User, message: string): Promise<void> {
    Logger.info(this.format(user, message));
  }
}

export class SmsNotifier extends Notifier {
  async notify(user: User, message: string): Promise<void> {
    Logger.info(`SMS ${this.format(user, message)}`);
  }
}
