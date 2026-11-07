import { Database } from '../infrastructure/database';

/** Deliberate layering violation (fixture): a domain entity talking to infrastructure. */
export class AuditEntry {
  constructor(readonly message: string) {}

  async persist(): Promise<void> {
    await Database.getInstance().query('INSERT INTO audit VALUES (?)', [this.message]);
  }
}
