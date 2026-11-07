import { SqlUserRepository } from './adapters/sql-user-repository';
import { InMemoryUserRepository } from './adapters/in-memory-user-repository';
import { EmailNotifier } from './notifications/notifier';
import { UserService } from './services/user-service';
import { UserController } from './controllers/user-controller';
import { AdminController } from './controllers/admin-controller';
import { billingService } from './services/billing-service';
import { archiveAll, type ArchivePorts } from './application/archive';
import { fileStore, usersFrom } from './adapters/archive-store';
import { Logger } from './util/logger';

/** Composition root. */
export function bootstrap(): { users: UserController; admin: AdminController } {
  const service = new UserService(new SqlUserRepository(), new InMemoryUserRepository(), new EmailNotifier());
  return { users: new UserController(service), admin: new AdminController(service, billingService) };
}

/** Functional composition root: ports objects built from adapter factories (FR-8). */
export async function runArchive(): Promise<number> {
  const files = fileStore('/tmp/archive');
  const ports: ArchivePorts = {
    users: usersFrom(['u1', 'u2']),
    store: files.store,
    audit: (line) => Logger.info(line),
  };
  return archiveAll(
    {
      // archived users keep their tag
      options: { dryRun: false, tag: 'archive' },
      labelFor: (id) => `user-${id}` /* stable label */,
    },
    ports,
  );
}
