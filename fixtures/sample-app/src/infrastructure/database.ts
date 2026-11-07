import { Logger } from '../util/logger';

/** Classic singleton: private constructor + static getInstance(). */
export class Database {
  private static instance: Database | undefined;

  private constructor(private readonly url: string) {}

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database('sqlite::memory:');
    }
    return Database.instance;
  }

  async query(sql: string, params: unknown[]): Promise<Record<string, string>[]> {
    Logger.info(`${this.url}: ${sql} ${params.length}`);
    return [];
  }
}
