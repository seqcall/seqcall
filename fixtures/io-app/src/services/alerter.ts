import type { AuditLog, Notifier } from '../ports/notifier';

export class Alerter {
  constructor(
    private readonly notifier: Notifier,
    private readonly audit: AuditLog,
  ) {}

  async alert(id: string): Promise<void> {
    await this.notifier.notify(id);
    this.audit.record(id);
  }

  async escalate(id: string): Promise<void> {
    await this.alert(id);
  }
}
