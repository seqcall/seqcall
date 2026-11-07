import { gitHost } from '../adapters/git-host';
import { scanAll } from '../application/scan';

/** Composition: hands the adapter's member to the use case as the port. */
export async function runScan(): Promise<number> {
  const host = gitHost();
  return scanAll(['a', 'b'], host.listBranches);
}
