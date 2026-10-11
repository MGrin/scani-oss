import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider, ibkrPaidBy } from '../../src/providers/ibkr';

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

async function eventsFrom(cashRows: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('SendRequest')
      ? new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>'
        )
      : new Response(statement(cashRows))) as typeof fetch;
  try {
    return await new IbkrProvider(passthroughLimiter(), async () => {}).fetchTransactions({
      ...ctx,
      noteWarning: () => {},
    } as never);
  } finally {
    globalThis.fetch = original;
  }
}

function cashRow(type: string, amount: string, description: string, extra = ''): string {
  return `<CashTransaction accountId="U1" currency="USD" description="${description}" ${extra} dateTime="20260120;120000" transactionID="${type.length}${amount.replace(/\D/g, '')}" levelOfDetail="DETAIL" amount="${amount}" type="${type}" />`;
}

// Invented securities: the `ZZ` country code is not assigned, so no ISIN here is real.
const ACME = { symbol: 'ACME', isin: 'ZZ0000000017' };

describe('IBKR dividends say what they are and who paid them (SC-1644)', () => {
  test('a dividend names the security from the row attributes', async () => {
    const [event] = await eventsFrom(
      cashRow(
        'Dividends',
        '24.00',
        'ACME(ZZ0000000017) CASH DIVIDEND USD 0.24 PER SHARE (Ordinary Dividend)',
        'symbol="ACME" isin="ZZ0000000017"'
      )
    );
    expect(event?.kind).toBe('reward');
    expect(event?.sourceMetadata).toEqual({ income: 'dividend', paidBy: ACME });
  });

  test('a dividend with no attributes names the security from its description', async () => {
    const [event] = await eventsFrom(
      cashRow(
        'Dividends',
        '24.00',
        'ACME(ZZ0000000017) CASH DIVIDEND USD 0.24 PER SHARE (Ordinary Dividend)'
      )
    );
    expect(event?.sourceMetadata).toEqual({ income: 'dividend', paidBy: ACME });
  });

  test('a payment in lieu of a dividend is a dividend too', async () => {
    const [event] = await eventsFrom(
      cashRow(
        'Payment In Lieu Of Dividends',
        '12.34',
        'ACME(ZZ0000000017) PAYMENT IN LIEU OF DIVIDEND (Ordinary Dividend)'
      )
    );
    expect(event?.kind).toBe('reward');
    expect(event?.sourceMetadata).toEqual({ income: 'dividend', paidBy: ACME, inLieu: true });
  });

  test('a withholding names the security and is not income', async () => {
    const [event] = await eventsFrom(
      cashRow(
        'Withholding Tax',
        '-3.60',
        'ACME(ZZ0000000017) CASH DIVIDEND USD 0.24 PER SHARE - US TAX'
      )
    );
    expect(event?.kind).toBe('fee');
    expect(event?.sourceMetadata).toEqual({ paidBy: ACME });
  });

  test('a withholding on a payment in lieu says so, so it links to that payment', async () => {
    const [event] = await eventsFrom(
      cashRow('Withholding Tax', '-1.85', 'ACME(ZZ0000000017) PAYMENT IN LIEU OF DIVIDEND - US TAX')
    );
    expect(event?.sourceMetadata).toEqual({ paidBy: ACME, inLieu: true });
  });

  test('an unreadable description still marks a dividend, with no payer', async () => {
    const [event] = await eventsFrom(cashRow('Dividends', '24.00', 'dividend'));
    expect(event?.sourceMetadata).toEqual({ income: 'dividend' });
  });

  test('an unreadable withholding, and every other cash row, carries no metadata', async () => {
    const events = await eventsFrom(
      cashRow('Withholding Tax', '-3.60', 'tax') +
        cashRow('Deposits', '1000', 'CASH RECEIPTS / ELECTRONIC FUND TRANSFERS') +
        cashRow('Broker Interest Received', '1.50', 'USD CREDIT INT FOR JAN-2026') +
        cashRow('Other Fees', '-10', 'ACME(ZZ0000000017) ADR FEE')
    );
    expect(events.map((e) => e.sourceMetadata)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('ibkrPaidBy', () => {
  test('reads a symbol with a space or a dot', () => {
    expect(ibkrPaidBy('ABC B(ZZ0000000025) CASH DIVIDEND USD 1.00 PER SHARE')).toEqual({
      symbol: 'ABC B',
      isin: 'ZZ0000000025',
    });
    expect(ibkrPaidBy('ABC.B(ZZ0000000025) CASH DIVIDEND USD 1.00 PER SHARE - CA TAX')).toEqual({
      symbol: 'ABC.B',
      isin: 'ZZ0000000025',
    });
  });

  test('reads nothing from text that names no security', () => {
    expect(ibkrPaidBy('USD CREDIT INT FOR JAN-2026')).toBeNull();
    expect(ibkrPaidBy('')).toBeNull();
  });
});
