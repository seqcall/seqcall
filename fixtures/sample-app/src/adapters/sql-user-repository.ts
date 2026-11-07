import { User } from '../domain/user';
import { Database } from '../infrastructure/database';
import type { UserRepository } from '../ports/user-repository';

export class SqlUserRepository implements UserRepository {
  async findById(id: string): Promise<User | undefined> {
    const rows = await Database.getInstance().query('SELECT * FROM users WHERE id = ?', [id]);
    const row = rows[0];
    return row ? new User(row.id, row.name, row.email, row.managerId) : undefined;
  }

  async save(user: User): Promise<void> {
    await Database.getInstance().query('UPDATE users SET name = ? WHERE id = ?', [user.name, user.id]);
  }
}
