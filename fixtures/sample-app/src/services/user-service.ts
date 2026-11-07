import { Injectable } from '../framework/decorators';
import type { User } from '../domain/user';
import type { UserRepository } from '../ports/user-repository';
import { Notifier } from '../notifications/notifier';

@Injectable()
export class UserService {
  constructor(
    private readonly primary: UserRepository,
    private readonly replica: UserRepository,
    private readonly notifier: Notifier,
  ) {}

  async findUser(id: string): Promise<User> {
    const cached = await this.replica.findById(id);
    if (cached) {
      return cached;
    }
    const user = await this.primary.findById(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }
    return user;
  }

  async rename(id: string, name: string): Promise<User> {
    const user = await this.findUser(id);
    user.rename(name);
    await this.primary.save(user);
    await this.notifier.notify(user, `renamed to ${name}`);
    return user;
  }

  /** Recursive: walks up the management chain (FR-3.4). */
  async managementChain(id: string): Promise<User[]> {
    const user = await this.findUser(id);
    if (!user.managerId) {
      return [user];
    }
    const chain = await this.managementChain(user.managerId);
    return [user, ...chain];
  }
}
