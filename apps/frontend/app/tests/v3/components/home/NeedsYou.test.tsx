import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { trpc } from '../../../../src/lib/trpc';
import { NeedsYou } from '../../../../src/v3/components/home/NeedsYou';
import { INCOME_HORIZON_DAYS } from '../../../../src/v3/lib/money';
import { todayDateString } from '../../../../src/v3/lib/paymentTotals';

/** SC-1669: "Nothing needs you" is a claim about two answers. */

function render(seed: { review?: unknown; payments?: unknown }): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (seed.review !== undefined) {
    client.setQueryData(getQueryKey(trpc.review.listPending, undefined, 'query'), seed.review);
  }
  if (seed.payments !== undefined) {
    client.setQueryData(
      getQueryKey(trpc.payments.upcoming, { days: INCOME_HORIZON_DAYS }, 'query'),
      seed.payments
    );
  }
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  const html = renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <StaticRouter location="/">
          <NeedsYou />
        </StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
  client.clear();
  return html;
}

const bill = (id: string, dueDate: string) => ({ id, dueDate, payment: { direction: 'outflow' } });

describe('NeedsYou', () => {
  test('says nothing needs you only once both sources answered empty', () => {
    expect(render({ review: [], payments: [] })).toInclude('Nothing needs you');
  });

  test('with one source still loading it holds a placeholder rather than claiming clear', () => {
    expect(render({ review: [] })).not.toInclude('Nothing needs you');
  });

  test('a single overdue bill opens that bill', () => {
    const html = render({ review: [], payments: [bill('occ-1', '2000-01-01')] });
    expect(html).toInclude('1 bill overdue');
    expect(html).toInclude('href="/payments/occ-1"');
  });

  test('a bill a month out is not listed', () => {
    const later = new Date(Date.parse(`${todayDateString()}T00:00:00Z`) + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(render({ review: [], payments: [bill('occ-2', later)] })).toInclude('Nothing needs you');
  });
});

describe('NeedsYou with one source failed', () => {
  function renderFailing(
    seed: { review?: unknown; payments?: unknown },
    failing: 'review' | 'payments'
  ) {
    const client = new QueryClient({
      // A failed query retries on mount, so its first frame would be loading.
      defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
    });
    const reviewKey = getQueryKey(trpc.review.listPending, undefined, 'query');
    const paymentsKey = getQueryKey(trpc.payments.upcoming, { days: INCOME_HORIZON_DAYS }, 'query');
    if (seed.review !== undefined) client.setQueryData(reviewKey, seed.review);
    if (seed.payments !== undefined) client.setQueryData(paymentsKey, seed.payments);
    const failedKey = failing === 'review' ? reviewKey : paymentsKey;
    client
      .getQueryCache()
      .build(client, { queryKey: failedKey })
      .setState({
        status: 'error',
        error: new Error('boom'),
        fetchStatus: 'idle',
      });
    const trpcClient = trpc.createClient({
      links: [httpBatchLink({ url: 'http://localhost/trpc' })],
    });
    const html = renderToStaticMarkup(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <StaticRouter location="/">
            <NeedsYou />
          </StaticRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
    client.clear();
    return html;
  }

  test('a failed bills read is said beside the review row, never left out', () => {
    const html = renderFailing({ review: [{ kind: 'transfer', represents: 1 }] }, 'payments');
    expect(html).toInclude('Couldn&#x27;t check everything that needs you');
    expect(html).toInclude('role="alert"');
  });

  test('a failed bills read with an empty review queue is a message, not a placeholder', () => {
    const html = renderFailing({ review: [] }, 'payments');
    expect(html).toInclude('Couldn&#x27;t check everything that needs you');
    expect(html).not.toInclude('Nothing needs you');
  });
});
