import type { User } from '../domain/user';
import type { UserRepository } from '../ports/user-repository';
import { Logger } from '../util/logger';

/** Runs an action with retries: invokes the lambda it is given (FR-1.11). */
export class Retrier {
  async run<T>(action: () => Promise<T>): Promise<T> {
    Logger.info('attempt');
    return action();
  }
}

/** Lambdas passed to library functions (drawn inline) and to project functions (FR-1.11). */
export class SyncService {
  private readonly retrier = new Retrier();

  constructor(private readonly repo: UserRepository) {}

  async syncAll(users: User[]): Promise<void> {
    const names = users.filter((u) => u.managerId).map((u) => this.label(u));
    await Promise.all(users.map(async (u) => this.repo.save(u)));
    await this.retrier.run(() => this.repo.findById(names[0]));
    await this.withLog(async () => {
      users.forEach((u) => this.label(u));
    });
    this.repo.findById('x').then((found) => Logger.info(String(found)));
  }

  private async withLog(work: () => Promise<void>): Promise<void> {
    Logger.info('start');
    await work();
  }

  private label(user: User): string {
    return user.name;
  }
}
