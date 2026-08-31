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

function statement(cashRows: string): string {
  return `
  <FlexQueryResponse>
    <FlexStatements>
      <FlexStatement fromDate="20250829" toDate="20260828" period="Last365CalendarDays">
        <Trades />
        <CashTransactions>${cashRows}</CashTransactions>
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

/**
 * The SHAPES here are the ones a real Flex statement carries — a date-only
 * `dateTime`, both levels of detail for the same movement, a row with no
 * `transactionID`. The identifiers, dates and amounts are invented.
 */
describe('IBKR cash rows that a real statement actually carries', () => {
  /**
   * Most cash rows in a real statement carry a date-only `dateTime`, and
   * `parseFlexDateTime` demanded `HHMMSS` — so it returned `new Date(NaN)`,
   * drizzle threw `RangeError: Invalid Date` building the insert, and
   * `bulkUpsert` wrote NOTHING: not the cash rows and not the trades in the
   * same batch. The path was unreachable until SC-855 stopped every cash row
   * reading `type="ISIN"`, which is why a fifteen-month-old parser crashed the
   * night after a fix landed (SC-880).
   */
  test('a date-only dateTime produces a usable instant, not Invalid Date', async () => {
    const { events } = await fetchFrom(
      statement(
        `<CashTransaction accountId="U1" currency="USD" description="CASH RECEIPTS / ELECTRONIC FUND TRANSFER" dateTime="20260214" reportDate="20260214" settleDate="20260214" transactionID="900000001" levelOfDetail="DETAIL" amount="1234.56" type="Deposits/Withdrawals" />`
      )
    );
    expect(events).toHaveLength(1);
    const occurredAt = events[0]?.occurredAt as Date;
    expect(Number.isNaN(occurredAt.getTime())).toBe(false);
    expect(occurredAt.toISOString()).toBe('2026-02-14T23:59:59.000Z');
  });

  /**
   * A statement reports the same money twice when its template asks for both
   * levels. Summed per currency the two are IDENTICAL, and `transactionID` is
   * present on every DETAIL row and empty on every SUMMARY row. Importing both
   * doubles every cash movement, and the content-hash dedup key hides it only
   * for the pairs that happen to match exactly: SUMMARY aggregates several
   * DETAIL rows, so most pairs differ and both would land.
   */
  test('SUMMARY rows are dropped when the statement also carries DETAIL', async () => {
    const { events } = await fetchFrom(
      statement(`
        <CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260305" transactionID="900000002" levelOfDetail="DETAIL" amount="1234.56" type="Deposits/Withdrawals" />
        <CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260305" levelOfDetail="SUMMARY" amount="1234.56" type="Deposits/Withdrawals" />
        <CashTransaction accountId="U1" currency="USD" description="div a" dateTime="20260306;202500" transactionID="tx-a" levelOfDetail="DETAIL" amount="30" type="Dividends" />
        <CashTransaction accountId="U1" currency="USD" description="div b" dateTime="20260306;202500" transactionID="tx-b" levelOfDetail="DETAIL" amount="20" type="Dividends" />
        <CashTransaction accountId="U1" currency="USD" description="div roll-up" dateTime="20260306" levelOfDetail="SUMMARY" amount="50" type="Dividends" />`)
    );
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.externalId).sort()).toEqual(['900000002', 'tx-a', 'tx-b']);
  });

  /**
   * A statement whose Flex template asks for SUMMARY only must still import.
   * The rule is "prefer DETAIL when there is any", not "require DETAIL".
   */
  test('a SUMMARY-only statement still imports', async () => {
    const { events } = await fetchFrom(
      statement(
        `<CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260305" levelOfDetail="SUMMARY" amount="1234.56" type="Deposits/Withdrawals" />`
      )
    );
    expect(events).toHaveLength(1);
  });

  /**
   * `type-dateTime-currency-amount` is not an identifier: it collides wherever
   * a statement repeats a movement, and it moves if IBKR restates an amount —
   * which writes a second row rather than updating the first. `transactionID`
   * is IBKR's own, and unique across the DETAIL rows.
   */
  test('externalId is IBKR transactionID when the row carries one', async () => {
    const { events } = await fetchFrom(
      statement(
        `<CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260305" transactionID="900000002" levelOfDetail="DETAIL" amount="1234.56" type="Deposits/Withdrawals" />`
      )
    );
    expect(events[0]?.externalId).toBe('900000002');
  });

  test('externalId falls back to the content key when IBKR sends no transactionID', async () => {
    const { events } = await fetchFrom(
      statement(
        `<CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260305" levelOfDetail="SUMMARY" amount="1234.56" type="Deposits/Withdrawals" />`
      )
    );
    expect(events[0]?.externalId).toBe('Deposits/Withdrawals-20260305-USD-1234.56');
  });

  /**
   * The one type left unmapped once the anchor fix let real types through.
   * A payment in lieu is what a dividend becomes when the share is on loan —
   * same money, same direction.
   */
  test('Payment In Lieu Of Dividends imports as a reward, not a warning', async () => {
    const { events, warnings } = await fetchFrom(
      statement(
        `<CashTransaction accountId="U1" currency="USD" description="pil" dateTime="20260307;202500" transactionID="9" levelOfDetail="DETAIL" amount="12.34" type="Payment In Lieu Of Dividends" />`
      )
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('reward');
    expect(warnings.filter((w) => w.includes('does not recognise'))).toHaveLength(0);
  });
});
