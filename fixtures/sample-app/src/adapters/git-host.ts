import type { BranchLister } from '../application/scan';
import { Logger } from '../util/logger';

/** An adapter's own interface, bundling application ports (like a functional-style TS app's `Host`). */
export interface GitHost {
  readonly listBranches: BranchLister;
}

export function gitHost(): GitHost {
  const listBranches: BranchLister = async (repository) => {
    Logger.info(repository);
    return [];
  };
  return { listBranches };
}
