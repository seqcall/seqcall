import type { UserSource } from '../application/archive';
import { Logger } from '../util/logger';

/** Factory returning a function: its product implements `ArchivePorts.users` (FR-8). */
export function usersFrom(ids: readonly string[]): UserSource {
  return async () => {
    Logger.info(`listing ${ids.length} users`);
    return ids;
  };
}

export interface FileStore {
  readonly store: (id: string, label: string) => Promise<void>;
  readonly flush: () => void;
}

export interface StoreOptions {
  readonly log?: (line: string) => void;
}

/** Adapter object built by a factory from local functions (shorthand properties). */
export function fileStore(dir: string, { log = (line: string) => Logger.info(line) }: StoreOptions = {}): FileStore {
  const store = async (id: string, label: string): Promise<void> => {
    Logger.info(`${dir}/${id}: ${label}`);
    flush();
    log(id);
  };
  function flush(): void {
    Logger.info(`flushed ${dir}`);
  }
  return { store, flush };
}
