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

function statement(trades: string): string {
  return `
  <FlexQueryResponse>
    <FlexStatements>
      <FlexStatement fromDate="20250829" toDate="20260828" period="Last365CalendarDays">
        <Trades>${trades}</Trades>
        <CashTransactions />
      </FlexStatement>
    </FlexStatements>
  </FlexQueryResponse>`;
}

async function fetchFrom(xml: string): Promise<{
  events: Awaited<ReturnType<IbkrProvider['fetchTransactions']>>;
  warnings: string[];
}> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('SendRequest')
      ? new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>'
        )
      : new Response(xml)) as typeof fetch;
  try {
    const warnings: string[] = [];
    const events = await new IbkrProvider(passthroughLimiter(), noSleep).fetchTransactions({
      ...ctx,
      noteWarning: (w: string) => warnings.push(w),
    } as never);
    return { events, warnings };
  } finally {
    globalThis.fetch = original;
  }
}

const qty = (e: { primary: { quantity: unknown } } | undefined) => String(e?.primary.quantity);
const sym = (id: unknown) => (id as { symbol?: string } | undefined)?.symbol;

/**
 * IBKR reports a currency conversion as a `<Trade assetCategory="CASH">` whose
 * symbol is BASE.QUOTE: `quantity` is in the base currency and `tradeMoney` in
 * the quote (`currency`). Only STK/ETF used to be kept, so a conversion reached
 * no ledger and a cash holding showed money leaving with no record (SC-1452).
 * Identifiers, dates and amounts are invented; the shapes are Flex's.
 */
describe('IBKR currency conversions (SC-1452)', () => {
  test('USD.CAD buy lands on both cash holdings, fee once, as a trade (not a flow)', async () => {
    const { events } = await fetchFrom(
      statement(
        `<Trade tradeID="F-1" dateTime="20260719;101500" symbol="USD.CAD" description="USD.CAD" conid="15016062" assetCategory="CASH" currency="CAD" buySell="BUY" quantity="1000" tradePrice="1.37" tradeMoney="1370" ibCommission="-2" ibCommissionCurrency="USD" />`
      )
    );
    expect(events).toHaveLength(2);
    const usd = events.find((e) => sym(e.primary.tokenIdentity) === 'USD');
    const cad = events.find((e) => sym(e.primary.tokenIdentity) === 'CAD');
    expect(usd?.kind).toBe('buy');
    expect(qty(usd)).toBe('1000');
    expect(String(usd?.counter?.quantity)).toBe('-1370');
    expect(sym(usd?.counter?.tokenIdentity)).toBe('CAD');
    expect(cad?.kind).toBe('sell');
    expect(qty(cad)).toBe('-1370');
    expect(String(cad?.counter?.quantity)).toBe('1000');
    expect(sym(cad?.counter?.tokenIdentity)).toBe('USD');
    expect(events.filter((e) => e.fee)).toHaveLength(1);
    expect(String(usd?.fee?.quantity)).toBe('-2');
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  test('EUR.USD sell: USD is the QUOTE, so it receives the tradeMoney', async () => {
    const { events } = await fetchFrom(
      statement(
        `<Trade tradeID="F-2" dateTime="20260801;090000" symbol="EUR.USD" description="EUR.USD" conid="12087792" assetCategory="CASH" currency="USD" buySell="SELL" quantity="-500" tradePrice="1.08" tradeMoney="-540" ibCommission="-2" ibCommissionCurrency="USD" />`
      )
    );
    const eur = events.find((e) => sym(e.primary.tokenIdentity) === 'EUR');
    const usd = events.find((e) => sym(e.primary.tokenIdentity) === 'USD');
    expect(eur?.kind).toBe('sell');
    expect(qty(eur)).toBe('-500');
    expect(usd?.kind).toBe('buy');
    expect(qty(usd)).toBe('540');
    expect(events.filter((e) => e.fee)).toHaveLength(1);
  });

  test('control: an option trade is still dropped', async () => {
    const { events } = await fetchFrom(
      statement(
        `<Trade tradeID="O-1" dateTime="20260117;090000" symbol="SPX-OPT" description="Option" conid="999" listingExchange="CBOE" assetCategory="OPT" currency="USD" buySell="BUY" quantity="1" tradePrice="5" tradeMoney="500" ibCommission="-0.65" ibCommissionCurrency="USD" />`
      )
    );
    expect(events).toHaveLength(0);
  });
});
