/** The port the use case owns: a function type, not an interface (FR-1.13). */
export type BranchLister = (repository: string) => Promise<readonly string[]>;

/** UC: scans repositories through the port it is given. */
export async function scanAll(repositories: readonly string[], listBranches: BranchLister): Promise<number> {
  let count = 0;
  for (const repository of repositories) count += (await listBranches(repository)).length;
  return count;
}
