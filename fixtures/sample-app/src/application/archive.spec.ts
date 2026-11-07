import { archiveAll, type ArchivePorts } from './archive';

/** Test wiring: fakes implement the ports, but test code never counts as an implementation (FR-8). */
export async function archivesWithFakes(): Promise<number> {
  const fakes: ArchivePorts = {
    users: async () => ['t1'],
    store: async () => undefined,
    audit: () => undefined,
  };
  return archiveAll({ options: { dryRun: true, tag: 'test' }, labelFor: (id) => id }, fakes);
}
