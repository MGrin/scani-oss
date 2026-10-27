// After a write the API answers with the last returns at once, marked stale,
// and computes the current ones, about 3 s on production (SC-1745). Home asks
// again until it has them, and stops when a compute keeps failing.
export const STALE_REFETCH_MS = 2_000;
export const STALE_REFETCH_MAX = 5;

/** A `refetchInterval`: react-query passes the data, then the query. */
export function whileStale(
  data: { stale?: boolean } | undefined,
  query: { state: { dataUpdateCount: number } }
): number | false {
  return data?.stale === true && query.state.dataUpdateCount <= STALE_REFETCH_MAX
    ? STALE_REFETCH_MS
    : false;
}
