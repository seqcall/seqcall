import type { User } from '../domain/user';
import type { UserRepository } from '../ports/user-repository';
import { Notifier } from '../notifications/notifier';
import { Logger } from '../util/logger';

/** Conditional and repeated calls: combined fragments (FR-1.10). */
export class ImportService {
  constructor(
    private readonly repo: UserRepository,
    private readonly notifier: Notifier,
  ) {}

  async run(users: User[]): Promise<void> {
    await this.importAll(users, true);
  }

  async importAll(users: User[], announce: boolean): Promise<number> {
    let imported = 0;
    for (const user of users) {
      if (user.name.length === 0) {
        Logger.error(`invalid ${user.id}`);
      } else if (user.managerId) {
        await this.repo.save(user);
        imported++;
      } else {
        await this.repo.save(user);
        await this.notifier.notify(user, 'imported');
      }
    }
    if (announce) {
      Logger.info(`imported ${imported}`);
    }
    try {
      await this.repo.findById('last');
    } catch {
      Logger.error('lookup failed');
    } finally {
      Logger.info('done');
    }
    return imported;
  }

  async sync(user: User, mode: string): Promise<void> {
    switch (mode) {
      case 'full':
      case 'deep':
        await this.repo.save(user);
        break;
      default:
        Logger.info('skipped');
    }
    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      const found = await this.repo.findById(user.id);
      const label = found ? this.describe(found) : this.fallback();
      Logger.info(label);
    }
    if (user.managerId) {
      if (user.email.length > 0) {
        await this.notifier.notify(user, 'synced');
      }
    }
    [user].forEach((u) => this.describe(u));
  }

  /** FR-1.17 the error becomes a value. */
  async lookup(id: string): Promise<User | undefined> {
    try {
      return await this.repo.findById(id);
    } catch {
      return undefined;
    }
  }

  /** FR-1.17 a failing item is skipped. */
  async saveEach(users: User[]): Promise<void> {
    for (const user of users) {
      try {
        await this.repo.save(user);
      } catch (e) {
        console.warn(e);
        continue;
      }
    }
  }

  /** FR-1.17 rethrown: nothing is hidden, no frame. */
  async strict(id: string): Promise<User | undefined> {
    try {
      return await this.repo.findById(id);
    } catch (e) {
      console.warn(e);
      throw e;
    }
  }

  private describe(user: User): string {
    return user.name;
  }

  private fallback(): string {
    return '?';
  }
}
