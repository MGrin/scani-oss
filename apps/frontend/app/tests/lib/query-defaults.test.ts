import { describe, expect, test } from 'bun:test';
import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { QUERY_DEFAULTS } from '../../src/lib/query-defaults';

/**
 * A tab left open overnight kept yesterday's figures until a navigation:
 * nothing refetched when it came back into focus (SC-1599, from the SC-1598
 * liveness audit). The app's defaults decide that, so the test builds a
 * client from them and focuses the window.
 */

async function harness(overrides: { staleTime?: number; refetchOnWindowFocus?: boolean }) {
  const client = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false, ...overrides } },
  });
  // `QueryClientProvider` does this in the app; it is what listens for focus.
  client.mount();
  const server = { requests: 0 };
  const observer = new QueryObserver(client, {
    queryKey: ['dashboard.getOverview'],
    queryFn: async () => {
      server.requests += 1;
      return { total: server.requests };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  await client.refetchQueries({ queryKey: ['dashboard.getOverview'] });
  const before = server.requests;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  unsubscribe();
  client.unmount();
  focusManager.setFocused(undefined);
  return server.requests - before;
}

describe('the app query defaults on window focus (SC-1599)', () => {
  test('a stale query on screen refetches when the window regains focus', async () => {
    expect(await harness({ staleTime: 0 })).toBe(1);
  });

  test('control: a query still inside the 30s fresh window is not refetched', async () => {
    expect(await harness({})).toBe(0);
  });

  test('control: the harness reads a zero when focus refetch is off', async () => {
    expect(await harness({ staleTime: 0, refetchOnWindowFocus: false })).toBe(0);
  });
});
