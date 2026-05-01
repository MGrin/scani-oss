// Run `operation(id)` for every id in parallel and summarise success /
// failure counts. Shared across the bulk-delete paths (accounts, holdings,
// vaults, groups). Doesn't rethrow — partial-failure is a normal outcome
// and the caller reports counts to the UI.
export async function executeBulkOperation<T>(
  ids: string[],
  operation: (id: string) => Promise<T>
): Promise<{
  success: boolean;
  deleted: number;
  failed: number;
  total: number;
  deletedIds: string[];
  failedIds: string[];
}> {
  const results = await Promise.allSettled(ids.map(operation));

  const deletedIds: string[] = [];
  const failedIds: string[] = [];

  results.forEach((result, index) => {
    const id = ids[index];
    if (id) {
      if (result.status === 'fulfilled') {
        deletedIds.push(id);
      } else {
        failedIds.push(id);
      }
    }
  });

  return {
    success: failedIds.length === 0,
    deleted: deletedIds.length,
    failed: failedIds.length,
    total: ids.length,
    deletedIds,
    failedIds,
  };
}
