import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { HoldingWithDetails } from '@scani/shared';
import { PeekBody } from '@scani/ui/v3/components/PeekSheet';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { type RouterOutputs, trpc } from '../../../src/lib/trpc';
import {
  type HoldingPeekContext,
  holdingPeekSpec,
} from '../../../src/v3/components/holdings/holdingPeek';

/**
 * A recorded movement is visible on the holding it moved (SC-1527).
 *
 * Measured as a new user: Record movement → Transfer between two of their own
 * accounts wrote the paired `transfer_out` / `transfer_in` rows, and the
 * holding's peek showed neither — the movement existed in the database and
 * nowhere on the screen. The peek body is rendered from a seeded cache, because
 * SSR runs no effects and a pending query would render the list away and let
 * the assertion pass against nothing.
 */

const t = i18n.t.bind(i18n);

const CONTEXT: HoldingPeekContext = {
  t,
  currency: 'EUR',
  onEdit: () => undefined,
  onRecordMovement: () => undefined,
  onUpdateValue: () => undefined,
  onMoveMoney: () => undefined,
  onToggleActive: () => undefined,
  onMarkScam: () => undefined,
  onRefreshPrice: () => undefined,
  onRefreshBalance: () => undefined,
  refreshingPriceId: null,
  refreshingBalanceId: null,
  onEditPrice: () => undefined,
  onConfigureApy: () => undefined,
  onDelete: () => undefined,
};

const HOLDING_ID = '33333333-3333-4333-8333-333333333333';

const EUR: HoldingWithDetails = {
  id: HOLDING_ID,
  token: {
    id: 't-eur',
    symbol: 'EUR',
    name: 'Euro',
    type: 'Fiat',
    typeCode: 'fiat',
    isScamProbability: 0,
  },
  amount: '750',
  value: 750,
  costBasis: null,
  price: { value: '1', timestamp: '2026-10-02T09:00:00.000Z', source: 'base-currency' },
  account: {
    id: 'a1',
    name: 'Current',
    type: 'Bank',
    typeCode: 'bank',
    class: 'asset',
    institutionId: 'i1',
  },
  institution: { id: 'i1', name: 'Revolut', type: 'Bank', typeCode: 'bank' },
  groups: [],
  lastUpdated: '2026-10-02T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
  isActive: true,
  isHidden: false,
  source: 'manual',
  refreshable: false,
  deleteHides: false,
};

type ListedRow = RouterOutputs['transactions']['list']['transactions'][number];

function row(over: Record<string, unknown>): ListedRow {
  return {
    id: crypto.randomUUID(),
    holdingId: HOLDING_ID,
    tokenId: 't-eur',
    kind: 'deposit',
    quantity: '1000',
    occurredAt: '2026-10-01T10:00:00.000Z',
    description: null,
    counterparty: null,
    transferGroupId: null,
    source: 'manual-edit',
    ...over,
  } as unknown as ListedRow;
}

function renderPeek(rows: ListedRow[] | null): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (rows) {
    queryClient.setQueryData(
      getQueryKey(trpc.transactions.list, { holdingId: HOLDING_ID, limit: 10 }, 'query'),
      { transactions: rows }
    );
  }
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <StaticRouter location="/holdings">
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <PeekBody spec={holdingPeekSpec(EUR, CONTEXT)} />
        </QueryClientProvider>
      </trpc.Provider>
    </StaticRouter>
  );
}

describe("the holding peek lists the holding's own movements", () => {
  test('a just-recorded transfer and the deposit before it are both on the peek', () => {
    const transferGroupId = crypto.randomUUID();
    const html = renderPeek([
      row({
        kind: 'transfer_out',
        quantity: '-250',
        occurredAt: '2026-10-02T10:00:00.000Z',
        transferGroupId,
      }),
      row({ kind: 'deposit', quantity: '1000' }),
    ]);
    expect(html).toContain('Recent activity');
    expect(html).toContain('Transfer out');
    expect(html).toContain('Money in');
    expect(html).toContain('250');
    expect(html).toContain('1,000');
  });

  test('a row carries its own description, as an imported statement line does', () => {
    const html = renderPeek([
      row({ kind: 'withdraw', quantity: '-40', description: 'Groceries at the market' }),
    ]);
    expect(html).toContain('Money out');
    expect(html).toContain('Groceries at the market');
  });

  test('a kind the product does not name yet still reads as a direction, never as the raw id', () => {
    const html = renderPeek([row({ kind: 'some_future_kind', quantity: '-5' })]);
    expect(html).toContain('Money out');
    expect(html).not.toContain('some_future_kind');
  });

  test('a holding with no movements on record has no empty activity block', () => {
    expect(renderPeek([])).not.toContain('Recent activity');
    expect(renderPeek(null)).not.toContain('Recent activity');
  });
});
