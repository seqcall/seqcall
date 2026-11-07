import type { User } from '../domain/user';

/** Port: implemented by the adapters. */
export interface UserRepository {
  findById(id: string): Promise<User | undefined>;
  save(user: User): Promise<void>;
}
