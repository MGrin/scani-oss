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

describe('IbkrProvider', () => {
  test('canFetchBalances / canDiscoverAccounts gate on ibkr', () => {
    const p = new IbkrProvider(passthroughLimiter());
    expect(p.canFetchBalances('ibkr')).toBe(true);
    expect(p.canDiscoverAccounts('ibkr')).toBe(true);
    expect(p.canFetchBalances('kraken')).toBe(false);
  });

  test('fetchAccounts returns the synthetic single-portfolio entry', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const accounts = await p.fetchAccounts(ctx as never);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.externalId).toBe('ibkr-flex-portfolio');
    expect(accounts[0]?.label).toBe('IBKR Portfolio');
  });

  test('fetchBalances parses positions + cash from the Flex Query XML', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const xml = `
      <FlexQueryResponse>
        <OpenPosition symbol="AAPL" description="Apple Inc." position="10" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        <OpenPosition symbol="GOOG" description="Alphabet" position="0" currency="USD" assetCategory="STK" listingExchange="NASDAQ" />
        <CashReportCurrency currency="USD" endingCash="500.50" />
        <CashReportCurrency currency="EUR" endingCash="0" />
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
    }) as typeof fetch;
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
      // Zero-quantity GOOG is skipped, BASE_SUMMARY skipped, EUR=0 skipped
      expect(out.find((h) => h.tokenIdentity.symbol === 'GOOG')).toBeUndefined();
      expect(out.find((h) => h.tokenIdentity.symbol === 'EUR')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials rejects wrong institution', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'kraken');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('Wrong institution');
  });

  test('validateCredentials rejects missing creds', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const r = await p.validateCredentials({}, 'ibkr');
    expect(r.valid).toBe(false);
    expect(r.message).toContain('flexQueryToken');
  });

  test('validateCredentials returns true on a successful SendRequest', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Success</Status><ReferenceCode>REF123</ReferenceCode></FlexStatementResponse>',
        { status: 200 }
      )) as typeof fetch;
    try {
      const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr');
      expect(r.valid).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validateCredentials surfaces ErrorCode 1010 (auth-failed)', async () => {
    const p = new IbkrProvider(passthroughLimiter());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        '<FlexStatementResponse><Status>Fail</Status><ErrorCode>1010</ErrorCode><ErrorMessage>Token invalid</ErrorMessage></FlexStatementResponse>',
        { status: 200 }
      )) as typeof fetch;
    try {
      const r = await p.validateCredentials({ flexQueryToken: 't', flexQueryId: 'q' }, 'ibkr');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('1010');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('canFetchTransactions gates on ibkr', () => {
    const p = new IbkrProvider(passthroughLimiter());
    expect(p.canFetchTransactions('ibkr')).toBe(true);
    expect(p.canFetchTransactions('kraken')).toBe(false);
  });

  test('fetchTransactions parses Trades + CashTransactions from XML', async () => {
    const p = new IbkrProvider(passthroughLimiter());
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
    }) as typeof fetch;
    try {
      const events = await p.fetchTransactions(ctx as never);

      // Options skipped, BASE_SUMMARY deposit skipped → 2 trades + 3 cash
      expect(events).toHaveLength(5);

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
