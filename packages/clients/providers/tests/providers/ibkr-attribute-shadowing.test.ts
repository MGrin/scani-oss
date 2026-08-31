import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider } from '../../src/providers/ibkr';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const noSleep = async () => {};

const ctx = {
  institutionCode: 'ibkr',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ flexQueryToken: 't', flexQueryId: 'q' }),
};

/**
 * The attribute ORDER here is the whole point, so do not tidy it (SC-855).
 *
 * The rows in `ibkr.test.ts` were hand-written with `type=` first, which is
 * the one ordering the bug cannot reach. A real Flex statement emits IBKR's
 * own column order, where `securityIDType` sits eleven attributes ahead of
 * `type` — and an unanchored, case-insensitive `/type="([^"]*)"/i` finds
 * `Type="ISIN"` inside it first. Every cash row in production read
 * `type = "ISIN"`, was refused by `classifyCashType`, and was dropped: 177 of
 * them on each of three consecutive runs.
 */
const REAL_ORDER_XML = `
  <FlexQueryResponse>
    <Trades>
      <Trade accountId="U1234567" currency="USD" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="265598" securityID="US0378331005" securityIDType="ISIN" cusip="037833100" isin="US0378331005" listingExchange="NASDAQ" underlyingConid="" underlyingSymbol="" tradeID="T-1" dateTime="20260115;103045" buySell="BUY" quantity="10" tradePrice="150" tradeMoney="1500" ibCommission="-1.50" ibCommissionCurrency="USD" />
    </Trades>
    <CashTransactions>
      <CashTransaction accountId="U1234567" currency="USD" fxRateToBase="1" assetCategory="STK" symbol="AAPL" description="AAPL(US0378331005) CASH DIVIDEND USD 0.25 PER SHARE" conid="265598" securityID="US0378331005" securityIDType="ISIN" cusip="037833100" isin="US0378331005" listingExchange="NASDAQ" underlyingConid="" underlyingSymbol="" dateTime="20260120;120000" settleDate="20260122" amount="50.00" type="Dividends" tradeID="" code="" transactionID="9001" reportDate="20260120" />
      <CashTransaction accountId="U1234567" currency="USD" fxRateToBase="1" assetCategory="" symbol="" description="CASH RECEIPTS / ELECTRONIC FUND TRANSFERS" conid="" securityID="" securityIDType="" cusip="" isin="" listingExchange="" underlyingConid="" underlyingSymbol="" dateTime="20260101;090000" settleDate="20260101" amount="1000" type="Deposits" tradeID="" code="" transactionID="9002" reportDate="20260101" />
      <CashTransaction accountId="U1234567" currency="USD" fxRateToBase="1" assetCategory="BOND" symbol="T 4 1/8 30" description="US TREASURY BOND COUPON" conid="512345" securityID="US91282CJL60" securityIDType="ISIN" cusip="91282CJL6" isin="US91282CJL60" listingExchange="" underlyingConid="" underlyingSymbol="" dateTime="20260201;120000" settleDate="20260201" amount="41.25" type="Bond Interest Received" tradeID="" code="" transactionID="9003" reportDate="20260201" />
    </CashTransactions>
    <OpenPositions />
    <CashReport />
  </FlexQueryResponse>
`;

async function fetchWithXml(xml: string): Promise<{
  events: Awaited<ReturnType<IbkrProvider['fetchTransactions']>>;
  warnings: string[];
}> {
  const p = new IbkrProvider(passthroughLimiter(), noSleep);
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
    return { events, warnings };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('IBKR attribute extraction is not shadowed by a longer attribute name (SC-855)', () => {
  test('a cash row in IBKR column order is classified by its own `type`, not by `securityIDType`', async () => {
    const { events, warnings } = await fetchWithXml(REAL_ORDER_XML);

    const dividend = events.find((e) => e.kind === 'reward');
    expect(dividend).toBeDefined();
    expect(dividend?.primary.tokenIdentity.symbol).toBe('USD');
    expect(dividend?.primary.quantity).toBe('50');
    expect(dividend?.externalId).toContain('Dividends');
    expect(dividend?.externalId).not.toContain('ISIN');

    const deposit = events.find((e) => e.kind === 'deposit');
    expect(deposit).toBeDefined();
    expect(deposit?.primary.quantity).toBe('1000');

    // The warning must never name `"ISIN"` again: that string is the value of
    // `securityIDType` and is not an IBKR cash-transaction type at all.
    expect(warnings.join('\n')).not.toContain('"ISIN"');
  });

  test('a genuinely unmapped cash type is still dropped and still reported', async () => {
    const { events, warnings } = await fetchWithXml(REAL_ORDER_XML);

    // `Bond Interest Received` is a real IBKR type that `classifyCashType`
    // does not map. Reading `type` correctly must not turn the filter off:
    // this row still has nowhere to go, and staying silent about it is the
    // failure SC-435 shipped the warning for.
    expect(events.map((e) => e.externalId).join('\n')).not.toContain('Bond Interest Received');
    expect(events.filter((e) => e.kind === 'interest')).toHaveLength(0);

    const unmapped = warnings.find((w) => w.includes('does not recognise'));
    expect(unmapped).toBeDefined();
    expect(unmapped).toContain('"Bond Interest Received" (1)');
    expect(unmapped).toContain('1 cash transaction');
  });

  test('a security row in the same statement is still parsed as a security', async () => {
    const { events } = await fetchWithXml(REAL_ORDER_XML);

    const buy = events.find((e) => e.externalId === 'T-1');
    expect(buy?.kind).toBe('buy');
    expect(buy?.primary.tokenType).toBe('stock');
    expect(buy?.primary.tokenIdentity.symbol).toBe('AAPL');
    expect(buy?.primary.quantity).toBe('10');
    // `conid` must not read `underlyingConid`, and `currency` must not read
    // `ibCommissionCurrency` — the same shadowing, two attributes over.
    expect(buy?.primary.tokenIdentity.providerMetadata).toMatchObject({
      ibkr: { conid: '265598', isin: 'US0378331005' },
    });
    expect(buy?.counter?.tokenIdentity.symbol).toBe('USD');
    expect(buy?.counter?.quantity).toBe('-1500');
    expect(buy?.fee?.quantity).toBe('-1.5');
  });
});
