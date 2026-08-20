/**
 * SC-384 — the statement's own as-of date, instead of our clock.
 *
 * The bug this locks down had no stack trace and no failing number. mgrin
 * bought four ETFs at 13:30Z; the balance sync ran at 15:10Z and wrote the
 * PRE-trade quantities under a 15:10Z timestamp. Every position he had not
 * traded matched IBKR to the decimal, so nothing was broken — the Flex Web
 * Service is a reporting interface that generates a statement after the close
 * and serves it unchanged all day, and the statement told us so in every row's
 * `reportDate`. We discarded it and stamped `new Date()`.
 *
 * The attribute shapes below are IBKR's real ones, taken from the published
 * samples that `csingley/ibflex` (the reference Python parser) asserts
 * against — including the two date spellings, which is not a hypothetical:
 * the format is a per-query setting the user picks, and we do not set it for
 * them.
 *
 * Three tests rather than six, each asserting everything one statement can
 * establish. `runFlexQuery` sleeps `FETCH_DELAY_MS` (12s) between SendRequest
 * and GetStatement on every call, so a test here costs twelve seconds of
 * suite time whatever it asserts — the grouping is that cost, not taste.
 */

import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider } from '../../src/providers/ibkr';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const ctx = {
  institutionCode: 'ibkr',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ flexQueryToken: 't', flexQueryId: 'q' }),
};

async function balancesFrom(xml: string) {
  const provider = new IbkrProvider(passthroughLimiter(), async () => {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) =>
    url.includes('SendRequest')
      ? new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF</ReferenceCode></FlexStatementResponse>',
          { status: 200 }
        )
      : new Response(xml, { status: 200 })) as unknown as typeof fetch;
  try {
    return await provider.fetchBalances(ctx as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('IBKR statement as-of (SC-384)', () => {
  test('the statement dates the balances — row first, statement second, never whenGenerated', async () => {
    // `whenGenerated` is a day LATER than `toDate` on purpose: it is the
    // attribute that would reproduce the original lie, because for an
    // intraday fetch it reads "today" while the data in it does not.
    const out = await balancesFrom(`
      <FlexQueryResponse>
        <FlexStatement accountId="U1234567" fromDate="20250820" toDate="20260817" period="Last365CalendarDays" whenGenerated="20260818;170231">
          <OpenPosition symbol="VOO" description="Vanguard S&amp;P 500" position="10.8109" currency="USD" assetCategory="STK" listingExchange="ARCA" reportDate="20260816" />
          <OpenPosition symbol="AAPL" description="Apple" position="10" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
          <CashReportCurrency currency="USD" endingCash="500.50" reportDate="20260816" />
        </FlexStatement>
      </FlexQueryResponse>
    `);

    const at = (symbol: string) =>
      out.find((h) => h.tokenIdentity.symbol === symbol)?.capturedAt.toISOString();

    // End of the report DAY, not its midnight: an activity statement's
    // positions are that day's closing positions, so midnight would file a
    // whole session's trading after the observation instead of before it.
    expect(at('VOO')).toBe('2026-08-16T23:59:59.000Z');
    expect(at('USD')).toBe('2026-08-16T23:59:59.000Z');
    // No `reportDate` of its own — the statement's `toDate`, and not the
    // 08-18 generation stamp sitting right beside it.
    expect(at('AAPL')).toBe('2026-08-17T23:59:59.000Z');

    // The date never appears bare. On its own it says "your data is old" and
    // leaves the reader to guess whether it is also wrong — which is exactly
    // the guess that cost the trust here.
    expect(out).toHaveLength(3);
    for (const snapshot of out) {
      expect(snapshot.asOfNote).toContain('after the close');
    }
  });

  test("the hyphenated date format parses too — it is the user's query setting, not ours", async () => {
    const out = await balancesFrom(`
      <FlexQueryResponse>
        <FlexStatement accountId="U1" fromDate="2025-08-20" toDate="2026-08-17" period="" whenGenerated="2026-08-18;170231">
          <OpenPosition symbol="AAPL" description="Apple" position="10" currency="USD" assetCategory="STK" listingExchange="NASDAQ" reportDate="2026-08-16" />
          <OpenPosition symbol="MSFT" description="Microsoft" position="6" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        </FlexStatement>
      </FlexQueryResponse>
    `);

    const at = (symbol: string) =>
      out.find((h) => h.tokenIdentity.symbol === symbol)?.capturedAt.toISOString();
    expect(at('AAPL')).toBe('2026-08-16T23:59:59.000Z');
    expect(at('MSFT')).toBe('2026-08-17T23:59:59.000Z');
  });

  test('no dates at all still returns balances — a wrong date beats no position', async () => {
    const before = Date.now();
    const out = await balancesFrom(`
      <FlexQueryResponse>
        <OpenPosition symbol="AAPL" description="Apple" position="10" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
      </FlexQueryResponse>
    `);

    expect(out).toHaveLength(1);
    expect(out[0]?.balance).toBe('10');
    // The pre-SC-384 behaviour, kept only as a last resort so a sync never
    // fails over a missing attribute. It is still a lie, which is why the
    // account-level fact below refuses to render a clock-stamped as-of.
    expect(out[0]?.capturedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
