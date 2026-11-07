import type { User } from '../domain/user';
import { Logger } from '../util/logger';

/** A formatter used as a function value. */
export class UserFormat {
  static plain(user: User): string {
    Logger.info(user.name);
    return user.name;
  }
}

/** Functions passed as arguments and invoked through a parameter (FR-1.13). */
export class FormatService {
  formatAll(users: User[]): string[] {
    const plain = this.render(users, UserFormat.plain);
    const loud = this.render(users, this.shout);
    const short = this.render(users, (u) => u.id);
    return [...plain, ...loud, ...short];
  }

  private render(users: User[], format: (user: User) => string): string[] {
    Logger.info('render');
    return this.each(users, format);
  }

  private each(users: User[], f: (user: User) => string): string[] {
    const out: string[] = [];
    for (const user of users) out.push(f(user));
    return out;
  }

  first(users: User[]): string {
    return this.applyTo(users[0], UserFormat.plain);
  }

  private applyTo(user: User, f: (user: User) => string): string {
    return f(user);
  }

  private shout(user: User): string {
    return UserFormat.plain(user).toUpperCase();
  }
}
