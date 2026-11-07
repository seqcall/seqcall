/**
 * Functional use case (no classes): dependencies arrive as a `ports` object whose members are
 * function-typed readonly properties, wired in the composition root (src/main.ts).
 */

/** Function type alias: a property typed by it is still a method (FR-1.2). */
export type UserSource = () => Promise<readonly string[]>;

/** Pure data. */
export interface ArchiveOptions {
  readonly dryRun: boolean;
  readonly tag: string;
}

export interface ArchiveRequest {
  readonly options: ArchiveOptions;
  readonly labelFor: (id: string) => string;
}

/** Ports: function-typed readonly properties (FR-8 for functional code). */
export interface ArchivePorts {
  readonly users: UserSource;
  readonly store: (id: string, label: string) => Promise<void>;
  readonly audit: (line: string) => void;
}

/** Behaviour, but no implementation anywhere in the project: never a «seam» (FR-7.1). */
export interface Clock {
  readonly now: () => string;
}

export async function archiveAll(request: ArchiveRequest, ports: ArchivePorts, clock?: Clock): Promise<number> {
  const started = clock?.now();
  const ids = await ports.users();
  for (const id of ids) {
    await archiveOne(id, request, ports);
  }
  ports.audit(summary(ids.length, request.options, started));
  return ids.length;
}

/** Parameters named differently from the caller's arguments (FR-6.5 binding). */
async function archiveOne(id: string, req: ArchiveRequest, deps: ArchivePorts): Promise<void> {
  const label = req.labelFor(id);
  await deps.store(id, label);
}

function summary(count: number, options: ArchiveOptions, started?: string): string {
  return `${options.tag}: ${count} (${started ?? 'now'})`;
}

/** The same port reached first through a destructured local, then as a parameter (FR-6.5, FR-7.1). */
export function auditTwice(where: { readonly ports: ArchivePorts }, ports: ArchivePorts): void {
  auditVia(where);
  ports.audit('direct');
}

function auditVia(where: { readonly ports: ArchivePorts }): void {
  const { ports } = where;
  ports.audit('via');
}
