import { describe, expect, test } from 'bun:test';
import { QueryClient, type QueryKey, QueryObserver } from '@tanstack/react-query';
import { QUERY_DEFAULTS } from '../../src/lib/query-defaults';

/**
 * SC-1772, the behaviour behind the decision `query-defaults.test.ts` asserts:
 * a query that failed once asks again by itself and recovers. A DOM spec only
 * because React Query v4 sets no interval timer when `window` is undefined, so
 * in the plain test process this would pass and fail for the same reason.
 * The harness shortens the wait and leaves the decision to the defaults.
 */
const failure = (httpStatus: number | null): Error =>
  httpStatus === null
    ? new Error('Unexpected token \'<\', "<html>Bad"... is not valid JSON')
    : Object.assign(new Error(`HTTP ${httpStatus}`), { data: { httpStatus } });

async function afterOneFailure(error: Error) {
  const client = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false } },
  });
  client.mount();
  let requests = 0;
  // The defaults are typed for any query, so the observer takes their types.
  const observer = new QueryObserver<unknown, unknown, unknown, unknown, QueryKey>(client, {
    queryKey: ['dashboard.getOverview'],
    queryFn: async () => {
      requests += 1;
      if (requests === 1) throw error;
      return { total: requests };
    },
    refetchInterval: (data, query) => {
      const interval = QUERY_DEFAULTS.refetchInterval;
      const wait = typeof interval === 'function' ? interval(data, query) : interval;
      return wait ? 10 : false;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  const { status } = observer.getCurrentResult();
  unsubscribe();
  client.unmount();
  return { status, requests };
}

describe('a query after a transient failure, with the app defaults (SC-1772)', () => {
  test('a query that got a 502 asks again by itself and recovers', async () => {
    expect(await afterOneFailure(failure(502))).toEqual({ status: 'success', requests: 2 });
  });

  test("a query that got a proxy's HTML page instead of an answer recovers", async () => {
    expect(await afterOneFailure(failure(null))).toEqual({ status: 'success', requests: 2 });
  });

  test('control: a 400 is an answer, so the query stays on its error', async () => {
    expect(await afterOneFailure(failure(400))).toEqual({ status: 'error', requests: 1 });
  });
});
