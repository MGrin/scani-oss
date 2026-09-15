import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { BaseCurrencyProvider } from '../../../src/contexts/BaseCurrencyContext';
import { trpc } from '../../../src/lib/trpc';
import { RunwayLine } from '../../../src/v3/components/home/RunwayLine';

/**
 * SC-982. Home's runway rests on the same observed burn as the forecast page,
 * and the page says when that burn was valued from stale quotes. Home now says
 * it too, in the page's own sentence.
 *
 * Rendered for real with the forecast seeded into the query cache: SSR runs no
 * fetch, so an unseeded query renders nothing and an absence assertion would
 * pass against an empty screen. The runway figure is the control for that.
 */

function forecast(staleValued: number) {
  return {
    today: '2026-03-04',
    horizonEnd: '2027-03-04',
    horizonMonths: 12,
    movements: [],
    liquid: {
      amount: '10000',
      baseCurrency: 'EUR',
      countedHoldings: 4,
      illiquid: { count: 0, amount: '0' },
      unpriceable: { count: 0 },
    },
    observedBurnAnswer: { kind: 'none' },
    observedBurn: {
      windowMonths: 6,
      fromMonth: '2025-09',
      toMonth: '2026-02',
      perMonth: [],
      total: '7500',
      perMonthMean: '1250',
      perMonthMedian: '1100',
      perMonthMin: '400',
      perMonthMax: '3000',
      countedTransactions: 14,
      excluded: { unclassified: 0, untracked: 0, internal: 0, unvalued: 0 },
      provenance: { user: '7500', automated: '0', unattributed: '0' },
      staleValued,
    },
  };
}

function render(staleValued: number): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(
    getQueryKey(trpc.payments.forecast, undefined, 'query'),
    forecast(staleValued)
  );
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <BaseCurrencyProvider>
          <StaticRouter location="/">
            <RunwayLine />
          </StaticRouter>
        </BaseCurrencyProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

describe('SC-982 — the home runway carries the stale-quote note', () => {
  test('names the counted outflows valued from a stale quote', () => {
    const html = render(2);
    // €10,000 ÷ €1,250 a month: the observed answer rendered at all.
    expect(html).toInclude('8 months');
    expect(html).toInclude('2 counted outflows were valued from stale quotes.');
  });

  test('uses the singular the forecast page uses', () => {
    expect(render(1)).toInclude('1 counted outflow was valued from a stale quote.');
  });

  test('says nothing when every counted outflow had a current quote', () => {
    const html = render(0);
    expect(html).toInclude('8 months');
    expect(html).not.toInclude('stale quote');
  });
});
