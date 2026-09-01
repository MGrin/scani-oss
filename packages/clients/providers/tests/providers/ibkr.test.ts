import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ProviderError } from '../../src/core/errors';
import { IbkrProvider } from '../../src/providers/ibkr';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

// `runFlexQuery` sleeps FETCH_DELAY_MS (12s) between SendRequest and the
// first GetStatement. None of these tests are about that wait — they parse
// XML — and paying it four times cost the suite ~36s of wall clock.
const noSleep = async () => {};

const ctx = {
  institutionCode: 'ibkr',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ flexQueryToken: 't', flexQueryId: 'q' }),
};

describe('IbkrProvider', () => {
  test('canFetchBalances / canDiscoverAccounts gate on ibkr', () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    expect(p.canFetchBalances('ibkr')).toBe(true);
    expect(p.canDiscoverAccounts('ibkr')).toBe(true);
    expect(p.canFetchBalances('kraken')).toBe(false);
  });

  test('fetchAccounts returns the synthetic single-portfolio entry', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const accounts = await p.fetchAccounts(ctx as never);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.externalId).toBe('ibkr-flex-portfolio');
    expect(accounts[0]?.label).toBe('IBKR Portfolio');
  });

  test('fetchBalances parses positions + cash from the Flex Query XML', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const xml = `
      <FlexQueryResponse>
        <OpenPosition symbol="AAPL" description="Apple Inc." position="10" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        <OpenPosition symbol="XEQT" description="iShares Core Equity ETF Portfolio" position="100" currency="CAD" assetCategory="STK" listingExchange="TSE" />
        <OpenPosition symbol="GOOG" description="Alphabet" position="0" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        <OpenPosition symbol="TSLA" description="Tesla short" position="-5" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        <CashReportCurrency currency="USD" endingCash="500.50" />
        <CashReportCurrency currency="EUR" endingCash="0" />
        <CashReportCurrency currency="GBP" endingCash="-1200.75" />
        <CashReportCurrency currency="BASE_SUMMARY" endingCash="9999" />
      </FlexQueryResponse>
    `;
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls += 1;
      if (url.includes('SendRequest')) {
        return new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF123</ReferenceCode></FlexStatementResponse>',
          { status: 200 }
        );
      }
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      expect(calls).toBeGreaterThanOrEqual(2);
      const aapl = out.find((h) => h.tokenIdentity.symbol === 'AAPL');
      const usd = out.find((h) => h.tokenIdentity.symbol === 'USD');
      expect(aapl?.balance).toBe('10');
      expect(usd?.balance).toBe('500.5');
      // externalId must equal the bare symbol/currency. The
      // IntegrationImportService keys snapshotsByExternalId on this
      // value and back-matches via extractExternalTokenId() (which
      // reads providerMetadata.ibkr.symbol or .currency). Any prefix
      // ("TTWO-NASDAQ", "cash-USD") breaks the lookup and silently
      // drops every holding — see the bug fixed alongside this test.
      expect(aapl?.externalId).toBe('AAPL');
      expect(usd?.externalId).toBe('USD');
      // Toronto-listed XEQT must be stamped with `.TO` in
      // providerMetadata.finnhub.symbol AND carry an `exchangeInfo`
      // hint so PricingProviderRouter recognizes a non-US exchange and
      // routes to Google Sheets (GOOGLEFINANCE) instead of Finnhub
      // (which returns finnhub_no_data for bare TSE symbols).
      const xeqt = out.find((h) => h.tokenIdentity.symbol === 'XEQT');
      expect(xeqt?.balance).toBe('100');
      const xeqtMeta = xeqt?.tokenIdentity.providerMetadata as
        | {
            finnhub?: { symbol?: string };
            exchangeInfo?: { exchange?: string; currency?: string };
          }
        | undefined;
      expect(xeqtMeta?.finnhub?.symbol).toBe('XEQT.TO');
      expect(xeqtMeta?.exchangeInfo?.exchange).toBe('TSX');
      expect(xeqtMeta?.exchangeInfo?.currency).toBe('CAD');
      // US listings stay bare (no suffix, no exchangeInfo) so Finnhub
      // free-tier prices them directly.
      const aaplMeta = aapl?.tokenIdentity.providerMetadata as
        | {
            finnhub?: { symbol?: string };
            exchangeInfo?: { exchange?: string; currency?: string };
          }
        | undefined;
      expect(aaplMeta?.finnhub?.symbol).toBe('AAPL');
      expect(aaplMeta?.exchangeInfo).toBeUndefined();
      // Zero-quantity GOOG is skipped, BASE_SUMMARY skipped, EUR=0 skipped.
      // Short positions (TSLA, -5) and margin-debt cash (GBP, -1200.75) are
      // liabilities, not long holdings — the schema models balance >= 0, so
      // they must be dropped at the parse layer rather than trip the
      // holdings_balance_nonneg_chk constraint downstream.
      expect(out.find((h) => h.tokenIdentity.symbol === 'GOOG')).toBeUndefined();
      expect(out.find((h) => h.tokenIdentity.symbol === 'EUR')).toBeUndefined();
      expect(out.find((h) => h.tokenIdentity.symbol === 'TSLA')).toBeUndefined();
      expect(out.find((h) => h.tokenIdentity.symbol === 'GBP')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'kraken');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Wrong institution');
  });

  test('validateCredentials rejects missing creds', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const r = await p.validateCredentials({}, 'ibkr');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('flexQueryToken');
  });

  test('validateCredentials returns true on a successful SendRequest', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF123</ReferenceCode></FlexStatementResponse>',
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials surfaces ErrorCode 1010 (auth-failed)', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1010</ErrorCode><ErrorMessage>Token invalid</ErrorMessage></FlexStatementResponse>',
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('1010');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The whole of SC-445, on the provider that named it: IBKR generates a
   * statement asynchronously, so "not ready yet" and "this token is invalid"
   * are different facts. 1010 is IBKR answering about the token; 1018, 1025
   * and a poll that runs out of budget are IBKR answering about itself, and
   * none of them may reach a user as a rejected credential.
   */
  test('validateCredentials rethrows a 1018 throughput limit rather than failing the token', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1018</ErrorCode><ErrorMessage>Too many requests</ErrorMessage></FlexStatementResponse>',
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const thrown = await p
        .validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr')
        .then(() => null)
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).kind).toBe('rate-limited');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rethrows a report that is still generating', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1001</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage></FlexStatementResponse>',
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const thrown = await p
        .validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr')
        .then(() => null)
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).kind).toBe('retryable');
      expect((thrown as Error).message).toContain('still transient');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rethrows an unreachable Flex service', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream down', { status: 503 })) as unknown as typeof fetch;
    try {
      const thrown = await p
        .validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr')
        .then(() => null)
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(ProviderError);
      expect((thrown as ProviderError).kind).toBe('retryable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('canFetchTransactions gates on ibkr', () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    expect(p.canFetchTransactions('ibkr')).toBe(true);
    expect(p.canFetchTransactions('kraken')).toBe(false);
  });

  test('fetchTransactions parses Trades + CashTransactions from XML', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const xml = `
      <FlexQueryResponse>
        <Trades>
          <Trade tradeID="T-1" dateTime="20260115;103045" symbol="AAPL" description="Apple Inc." conid="265598" listingExchange="NASDAQ" assetCategory="STK" isin="US0378331005" currency="USD" buySell="BUY" quantity="10" tradePrice="150" tradeMoney="1500" ibCommission="-1.50" ibCommissionCurrency="USD" />
          <Trade tradeID="T-2" dateTime="20260116;140000" symbol="MSFT" description="Microsoft" conid="272093" listingExchange="NASDAQ" assetCategory="STK" isin="US5949181045" currency="USD" buySell="SELL" quantity="5" tradePrice="400" tradeMoney="2000" ibCommission="-2.00" ibCommissionCurrency="USD" />
          <Trade tradeID="T-3" dateTime="20260117;090000" symbol="SPX-OPT" description="Option" conid="999" listingExchange="CBOE" assetCategory="OPT" currency="USD" buySell="BUY" quantity="1" tradePrice="5" tradeMoney="500" ibCommission="-0.65" ibCommissionCurrency="USD" />
        </Trades>
        <CashTransactions>
          <CashTransaction type="Dividends" amount="50.00" currency="USD" dateTime="20260120;120000" description="AAPL DIVIDEND" accountId="U123" tradeID="" />
          <CashTransaction type="Withholding Tax" amount="-7.50" currency="USD" dateTime="20260120;120000" description="WHT" accountId="U123" tradeID="" />
          <CashTransaction type="Deposits" amount="1000" currency="USD" dateTime="20260101;090000" description="Wire" accountId="U123" tradeID="" />
          <CashTransaction type="Deposits" amount="9999" currency="BASE_SUMMARY" dateTime="20260101;090000" description="summary" accountId="U123" tradeID="" />
        </CashTransactions>
      </FlexQueryResponse>
    `;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('SendRequest')) {
        return new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF</ReferenceCode></FlexStatementResponse>',
          { status: 200 }
        );
      }
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        noteWarning: (reason: string) => warnings.push(reason),
      } as never);

      // Options skipped, BASE_SUMMARY deposit skipped → 2 trades + 3 cash
      expect(events).toHaveLength(5);

      // A statement carrying all four sections has nothing to report (SC-435).
      expect(warnings).toEqual([]);

      const aaplBuy = events.find((e) => e.externalId === 'T-1');
      expect(aaplBuy?.kind).toBe('buy');
      expect(aaplBuy?.primary.tokenIdentity.symbol).toBe('AAPL');
      expect(aaplBuy?.primary.tokenIdentity.marketSegment).toBe('US');
      expect(aaplBuy?.primary.quantity).toBe('10');
      expect(aaplBuy?.counter?.tokenIdentity.symbol).toBe('USD');
      expect(aaplBuy?.counter?.quantity).toBe('-1500');
      expect(aaplBuy?.fee?.tokenIdentity.symbol).toBe('USD');
      expect(aaplBuy?.fee?.quantity).toBe('-1.5');
      expect(aaplBuy?.priceNative?.value).toBe('150');
      expect(aaplBuy?.priceNative?.quoteIdentity.symbol).toBe('USD');

      const msftSell = events.find((e) => e.externalId === 'T-2');
      expect(msftSell?.kind).toBe('sell');
      expect(msftSell?.primary.quantity).toBe('-5');
      expect(msftSell?.counter?.quantity).toBe('2000');
      expect(msftSell?.fee?.quantity).toBe('-2');

      const opt = events.find((e) => e.externalId === 'T-3');
      expect(opt).toBeUndefined();

      const dividend = events.find((e) => e.kind === 'reward');
      expect(dividend?.externalId).toBe('Dividends-20260120;120000-USD-50.00');
      expect(dividend?.primary.tokenIdentity.symbol).toBe('USD');
      expect(dividend?.primary.quantity).toBe('50');

      const wht = events.find((e) => e.kind === 'fee');
      expect(wht?.externalId).toBe('Withholding Tax-20260120;120000-USD--7.50');
      expect(wht?.primary.quantity).toBe('-7.5');

      const deposit = events.find((e) => e.kind === 'deposit');
      expect(deposit?.externalId).toBe('Deposits-20260101;090000-USD-1000');
      expect(deposit?.primary.tokenIdentity.symbol).toBe('USD');
      expect(deposit?.primary.quantity).toBe('1000');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * The wiring, once. What the warning SAYS and when it fires is covered by
   * `ibkr-sections.test.ts`, which needs no network dance and runs in
   * milliseconds; this proves only that a real `fetchTransactions` call puts
   * it on `ctx.noteWarning` (SC-435).
   */
  test('a statement with no Cash Transactions section warns through noteWarning', async () => {
    const p = new IbkrProvider(passthroughLimiter(), noSleep);
    const xml = `
      <FlexQueryResponse>
        <Trades>
          <Trade tradeID="T-1" dateTime="20260115;103045" symbol="AAPL" description="Apple Inc." conid="265598" listingExchange="NASDAQ" assetCategory="STK" isin="US0378331005" currency="USD" buySell="BUY" quantity="10" tradePrice="150" tradeMoney="1500" ibCommission="-1.50" ibCommissionCurrency="USD" />
        </Trades>
      </FlexQueryResponse>
    `;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('SendRequest')) {
        return new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF</ReferenceCode></FlexStatementResponse>',
          { status: 200 }
        );
      }
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    try {
      const events = await p.fetchTransactions({
        ...ctx,
        noteWarning: (reason: string) => warnings.push(reason),
      } as never);

      // The rows the statement DID carry still arrive — a missing section is
      // something to say, not a reason to drop what was sent.
      expect(events).toHaveLength(1);
      expect(events[0]?.externalId).toBe('T-1');

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"Cash Transactions" section');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Live integration test against an IBKR paper-trading account.
  //
  // Sandbox setup:
  //   1. Sign in to IBKR Account Management with a paper-trading user.
  //   2. Reporting → Flex Queries → create an Activity Flex Query that
  //      includes Open Positions, Cash Report, Trades, and Cash Transactions.
  //   3. Generate a Flex Web Service token (Reporting → Flex Web Service).
  //   4. Export:
  //        SCANI_TESTNET_IBKR_FLEX_TOKEN=...
  //        SCANI_TESTNET_IBKR_FLEX_QUERY_ID=...
  //   5. Run: SCANI_LIVE=1 bun test packages/clients/providers/tests/providers/ibkr.test.ts
  //
  // Paper accounts share the prod URL; no base-URL switch is needed.
  // Disabled in CI by the SCANI_LIVE gate.
  test.skipIf(process.env.SCANI_LIVE !== '1')(
    'live paper-trading returns an array shape',
    async () => {
      const flexQueryToken = process.env.SCANI_TESTNET_IBKR_FLEX_TOKEN;
      const flexQueryId = process.env.SCANI_TESTNET_IBKR_FLEX_QUERY_ID;
      if (!flexQueryToken || !flexQueryId) {
        throw new Error(
          'SCANI_LIVE=1 requires SCANI_TESTNET_IBKR_FLEX_TOKEN and SCANI_TESTNET_IBKR_FLEX_QUERY_ID'
        );
      }
      // Real IBKR, real budget: the wait between SendRequest and GetStatement
      // is the thing being exercised here, so this one keeps its sleep.
      const provider = new IbkrProvider(passthroughLimiter());
      const events = await provider.fetchTransactions({
        institutionCode: 'ibkr',
        baseCurrency: { id: 'usd', symbol: 'USD' } as never,
        credentialsRef: { userId: 'live', institutionId: 'live' },
        resolveCredentials: async () => ({ flexQueryToken, flexQueryId }),
      });
      expect(Array.isArray(events)).toBe(true);
    },
    120_000
  );
});

/**
 * SC-279. IBKR Flex code 1025 is "Too many failed attempts" — a lockout
 * triggered by repeated failure. Our hourly schedule retried it hourly, so
 * every run was another failed attempt against the counter that has to age
 * out; the schedule was what sustained the lockout. It fired every hour from
 * 12:00Z on 2026-08-15 with 57 Sentry events behind it.
 *
 * Before this, every non-transient code threw a plain `Error`, which
 * orchestrators treat as `retryable`. The header comment claimed 1010/1012
 * were auth-failed and 1018 rate-limited; none of it was implemented.
 */
describe('IbkrProvider — Flex error classification', () => {
  function withSendRequestError(code: string, message: string) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`,
        { status: 200 }
      )) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  async function classify(code: string, message: string) {
    const restore = withSendRequestError(code, message);
    try {
      await new IbkrProvider(passthroughLimiter(), noSleep).fetchBalances(ctx as never);
      return null;
    } catch (error) {
      return error as ProviderError;
    } finally {
      restore();
    }
  }

  test('1025 carries a window the caller must sit out, not a retry hint', async () => {
    const error = await classify(
      '1025',
      'Too many failed attempts. Please review your configuration.'
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error?.kind).toBe('rate-limited');
    // 24 hours. The number is argued at IBKR_LOCKOUT_MS: IBKR does not
    // document the cooldown, and the costs are asymmetric — waiting too long
    // is one more day of staleness we already have and now flag, waiting too
    // little is a lockout that never ages out.
    expect(error?.retryAfterMs).toBe(24 * 60 * 60 * 1000);
    expect(error?.message).toContain('code 1025');
  });

  test('1018 is the ordinary throughput limit and clears in a minute', async () => {
    const error = await classify('1018', 'Too many requests');

    expect(error?.kind).toBe('rate-limited');
    expect(error?.retryAfterMs).toBe(60_000);
  });

  test.each([
    ['1010'],
    ['1012'],
  ])('%s is auth-failed and carries NO window — time does not fix a bad token', async (code) => {
    const error = await classify(code, 'Invalid token');

    expect(error?.kind).toBe('auth-failed');
    // A window here would only postpone telling the user, who is the only
    // one who can fix it.
    expect(error?.retryAfterMs).toBeUndefined();
  });

  test('an unmapped code is unrecoverable rather than silently retryable', async () => {
    const error = await classify('1099', 'Something else entirely');

    expect(error?.kind).toBe('unrecoverable');
    expect(error?.retryAfterMs).toBeUndefined();
  });
});

/**
 * SC-443. Exhausting the poll budget is OUR clock running out, not IBKR
 * refusing us: the report was accepted and simply had not been built yet.
 * It used to fall through to `classifyFlexError`, which has never been asked
 * to rank 1001/1019, so it landed on the `unrecoverable` default — and
 * `unrecoverable` is `willRetry: false`, rendered to the user as "this failed
 * for a reason another attempt will not fix. Check the details below, correct
 * them, and start it again". There is nothing there to correct.
 *
 * The counter-argument on record (the `isUnrecoverableExchangeError` test in
 * apps/backend/worker) was that surviving ~5 minutes of polling means the Flex
 * template is structurally too heavy, so retrying only deepens IBKR's backlog.
 * That is a hypothesis about a cause the code cannot observe, and production
 * has never produced a single instance of it to weigh: measured 2026-08-19,
 * no `user_jobs` row in three months carries any of these codes and no live
 * IBKR credential carries a non-zero `sync_failure_count`. So the backlog cost is
 * speculative and the false instruction is certain, and the retry budget on
 * each descriptor already bounds the downside at 3-4 attempts.
 */
describe('IbkrProvider — poll exhaustion', () => {
  function alwaysFlexError(code: string, message: string) {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        `<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>${message}</ErrorMessage></FlexStatementResponse>`,
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    return {
      calls: () => calls,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  test.each([
    ['1001'],
    ['1019'],
  ])('SendRequest still answering %s after the whole budget is retryable, not unrecoverable', async (code) => {
    const stub = alwaysFlexError(code, 'Statement could not be generated at this time.');
    try {
      const error = await new IbkrProvider(passthroughLimiter(), noSleep)
        .fetchBalances(ctx as never)
        .then(() => null)
        .catch((err: unknown) => err as ProviderError);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error?.kind).toBe('retryable');
      // No window: the queue decides when to try again, and `retryAfterMs`
      // would tell the caller not to contact IBKR at all.
      expect(error?.retryAfterMs).toBeUndefined();
      expect(error?.message).toBe(
        `IBKR SendRequest still transient after 6 retries (last: code ${code}: Statement could not be generated at this time.)`
      );
      // The budget was actually spent, rather than the first answer being
      // mistaken for exhaustion.
      expect(stub.calls()).toBe(6);
    } finally {
      stub.restore();
    }
  });

  test.each([
    ['1001'],
    ['1019'],
  ])('GetStatement still answering %s after the whole budget is retryable, not unrecoverable', async (code) => {
    const originalFetch = globalThis.fetch;
    let getStatementCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('SendRequest')) {
        return new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF1</ReferenceCode><Url>https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url></FlexStatementResponse>',
          { status: 200 }
        );
      }
      getStatementCalls++;
      return new Response(
        `<FlexStatementResponse><Status>Fail</Status><ErrorCode>${code}</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage></FlexStatementResponse>`,
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    try {
      const error = await new IbkrProvider(passthroughLimiter(), noSleep)
        .fetchBalances(ctx as never)
        .then(() => null)
        .catch((err: unknown) => err as ProviderError);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error?.kind).toBe('retryable');
      expect(error?.retryAfterMs).toBeUndefined();
      expect(error?.message).toBe(
        `IBKR report still generating after 24 retries (last: code ${code}: Statement generation in progress)`
      );
      expect(getStatementCalls).toBe(24);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a code the classifier HAS ranked still wins over the poll budget', async () => {
    // 1025 is the lockout. It is not in the transient set, so it must still
    // short-circuit on the first answer rather than be polled 6 times — the
    // poll is what sustains that lockout (SC-279).
    const stub = alwaysFlexError('1025', 'Too many failed attempts.');
    try {
      const error = await new IbkrProvider(passthroughLimiter(), noSleep)
        .fetchBalances(ctx as never)
        .then(() => null)
        .catch((err: unknown) => err as ProviderError);

      expect(error?.kind).toBe('rate-limited');
      expect(error?.retryAfterMs).toBe(24 * 60 * 60 * 1000);
      expect(stub.calls()).toBe(1);
    } finally {
      stub.restore();
    }
  });
});
