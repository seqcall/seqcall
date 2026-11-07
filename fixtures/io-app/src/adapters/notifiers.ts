import { appendFile } from 'node:fs/promises';
import type { AuditLog, Notifier } from '../ports/notifier';

export class SlackNotifier implements Notifier {
  async notify(id: string): Promise<void> {
    await fetch(`https://slack.example/${id}`);
  }
}

export class MailNotifier implements Notifier {
  async notify(id: string): Promise<void> {
    await fetch(`https://mail.example/${id}`, { method: 'POST' });
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly lines: string[] = [];
  record(text: string): void {
    this.lines.push(text);
  }
}

export class FileAuditLog implements AuditLog {
  record(text: string): void {
    void appendFile('audit.log', text);
  }
}

export class NotImplementedError extends Error {}

/** Not written yet: only throws, so it does not hide what the other notifiers share. */
export class PagerNotifier implements Notifier {
  async notify(_id: string): Promise<void> {
    throw new NotImplementedError('pager');
  }
}
