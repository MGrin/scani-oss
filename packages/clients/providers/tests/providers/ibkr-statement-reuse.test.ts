/**
 * SC-1665. An hourly run reads IBKR's balance and then its ledger, and both
 * come from the same Flex statement, which IBKR builds once a day. Asking for
 * it twice in one run doubled the Flex calls for no new data; one run now
 * reuses the statement it just fetched.
 */

import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider } from '../../src/providers/ibkr';

const passthrough = {
  execute: async <T>(fn: () => Promise<T>) => fn(),
} as unknown as OutflowRateLimiter;

const ctx = (token = 't') => ({
  institutionCode: 'ibkr',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ flexQueryToken: token, flexQueryId: 'q' }),
});

const STATEMENT = `
  <FlexQueryResponse>
    <FlexStatement accountId="U1" fromDate="20250820" toDate="20261008" period="Last365CalendarDays">
      <CashReportCurrency currency="USD" endingCash="500.50" reportDate="20261008" />
    </FlexStatement>
  </FlexQueryResponse>`;

async function sendRequestsDuring(
  run: (provider: IbkrProvider, clock: { now: number }) => Promise<void>
) {
  const clock = { now: Date.parse('2026-10-09T10:00:00Z') };
  const provider = new IbkrProvider(
    passthrough,
    async () => {},
    () => clock.now
  );
  let sends = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes('SendRequest')) {
      sends += 1;
      return new Response(
        '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF</ReferenceCode></FlexStatementResponse>',
        { status: 200 }
      );
    }
    return new Response(STATEMENT, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await run(provider, clock);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sends;
}

describe('one Flex statement serves the balance and the ledger of one run', () => {
  test('the ledger read right after the balance reuses its statement', async () => {
    const sends = await sendRequestsDuring(async (provider) => {
      await provider.fetchBalances(ctx() as never);
      await provider.fetchTransactions({
        ...ctx(),
        since: new Date('2026-10-08T00:00:00Z'),
      } as never);
    });
    expect(sends).toBe(1);
  });

  test('the next hour asks again', async () => {
    const sends = await sendRequestsDuring(async (provider, clock) => {
      await provider.fetchBalances(ctx() as never);
      clock.now += 60 * 60 * 1000;
      await provider.fetchBalances(ctx() as never);
    });
    expect(sends).toBe(2);
  });

  test('control: another token is another statement', async () => {
    const sends = await sendRequestsDuring(async (provider) => {
      await provider.fetchBalances(ctx('t1') as never);
      await provider.fetchBalances(ctx('t2') as never);
    });
    expect(sends).toBe(2);
  });
});
