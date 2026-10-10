import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { trpc } from '../../../../src/lib/trpc';
import { AllocationBlock } from '../../../../src/v3/components/home/AllocationBlock';
import { DebtBlock } from '../../../../src/v3/components/home/DebtBlock';
import { DEFAULT_ALLOCATION_DIMENSION } from '../../../../src/v3/lib/home';

const allocation = (over: { totalDebt?: string; liabilityDebt?: string } = {}) => ({
  dimension: DEFAULT_ALLOCATION_DIMENSION,
  items: [
    { id: 'crypto', code: 'crypto', name: 'Crypto', value: '6000', percentage: '60' },
    { id: 'stock', code: 'stock', name: 'Stocks', value: '4000', percentage: '40' },
  ],
  totalDebt: over.totalDebt ?? '0',
  liabilityDebt: over.liabilityDebt ?? '0',
  totalValue: '10000',
  baseCurrency: 'USD',
});

function renderSeeded(data: ReturnType<typeof allocation>, node: ReactNode): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    getQueryKey(
      trpc.dashboard.getAssetAllocation,
      { dimension: DEFAULT_ALLOCATION_DIMENSION },
      'query'
    ),
    data
  );
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  const html = renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <StaticRouter location="/">{node}</StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
  client.clear();
  return html;
}

describe('the Debt tile', () => {
  test('is absent while nothing is owed', () => {
    expect(renderSeeded(allocation(), <DebtBlock variant="tile" />)).toBe('');
  });

  test('leads with what is owed and names both kinds of debt', () => {
    const html = renderSeeded(
      allocation({ totalDebt: '-1500', liabilityDebt: '-1000' }),
      <DebtBlock variant="tile" />
    );
    expect(html).toInclude('Debt');
    expect(html).toInclude('Margin · Loans and cards');
    expect(html).toInclude('href="/home/debt"');
  });

  test('names only the kind of debt there is', () => {
    // The control for the arm above: a caption built from a fixed string would
    // pass it too, and only this one separates the two.
    const html = renderSeeded(
      allocation({ totalDebt: '-1000', liabilityDebt: '-1000' }),
      <DebtBlock variant="tile" />
    );
    expect(html).toInclude('Loans and cards');
    expect(html).not.toInclude('Margin');
  });
});

describe('the Allocation tile', () => {
  test('draws the bar and names the largest slice with its share', () => {
    const html = renderSeeded(allocation(), <AllocationBlock variant="tile" />);
    expect(html).toInclude('Crypto');
    expect(html).toInclude('60%');
    expect(html).toInclude('href="/home/allocation"');
    // The tile's track is not the gated bar the visual baselines select.
    expect(html).not.toInclude('data-ui="allocation-bar"');
  });
});

describe('the Debt tile before an answer', () => {
  test('renders nothing while the allocation has not answered', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const trpcClient = trpc.createClient({
      links: [httpBatchLink({ url: 'http://localhost/trpc' })],
    });
    const html = renderToStaticMarkup(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <StaticRouter location="/">
            <DebtBlock variant="tile" />
          </StaticRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
    client.clear();
    expect(html).toBe('');
  });
});
