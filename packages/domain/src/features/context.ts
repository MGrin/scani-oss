/**
 * Shared primitives used by every `*Implementations` object in this
 * folder. Kept separate so adding a new feature group doesn't force a
 * churn on `features/index.ts` — pull `FeatureExecutionContext` +
 * `executeBulkOperation` from here and co-locate the implementation in
 * its own file.
 */

/**
 * Request-scoped context passed to every feature implementation. Carries
 * the authenticated user, the tRPC-side request cache (so batched
 * procedures in one HTTP round-trip don't re-fetch the same portfolio),
 * and an optional ambient transaction for use cases that want their DB
 * writes bundled with router logic.
 */
export interface FeatureExecutionContext {
  userId: string;
  dbUser?: {
    id: string;
    baseCurrencyId?: string | null;
    // biome-ignore lint/suspicious/noExplicitAny: User row carries dynamic columns from the schema.
    [key: string]: any;
  };
  requestCache?: Map<string, unknown>;
}

/**
 * Run `operation(id)` for every id in parallel and summarise success /
 * failure counts. Shared across the bulk delete / bulk update paths
 * (accounts, holdings, groups). Doesn't rethrow — partial-failure is a
 * normal outcome and the caller reports counts to the UI.
 */
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
