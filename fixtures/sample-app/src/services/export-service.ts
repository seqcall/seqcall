import type { UserRepository } from '../ports/user-repository';
import { Logger } from '../util/logger';

export class ExportBatch {
  private readonly lines: string[] = [];

  add(line: string): void {
    this.lines.push(line);
  }

  close(): string {
    return this.lines.join('\n');
  }
}

/** FR-6.5: one participant per object, across helper calls and created objects. */
export class ExportService {
  constructor(private readonly repo: UserRepository) {}

  async exportUser(id: string): Promise<string> {
    const batch = new ExportBatch();
    await this.write(this.repo, id, batch);
    batch.add('end');
    await this.repo.findById(id);
    return batch.close();
  }

  label(id: string): string {
    return `export ${id}`;
  }

  private async write(source: UserRepository, id: string, into: ExportBatch): Promise<void> {
    const user = await source.findById(id);
    into.add(user?.name ?? id);
    logExport(this, id);
  }
}

function logExport(service: ExportService, id: string): void {
  Logger.info(service.label(id));
}
