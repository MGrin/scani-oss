import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider } from '../../src/providers/ibkr';
import {
  describeIncompleteCashRows,
  incompleteCashFieldsKey,
} from '../../src/providers/ibkr/statement-warnings';

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
 * Five cash rows, one per outcome, so a change that collapses two of them is
 * visible here (SC-873).
 *
 * Row 1 imports. Row 2 is a real IBKR type our map does not carry — the LOUD
 * drop SC-435 shipped a warning for. Rows 3 and 4 carry a `Deposits` type and
 * money and are missing `currency` and `amount` respectively — the SILENT
 * drop this file is about. Row 5 is IBKR's own BASE_SUMMARY total, the one
 * drop that is meant to stay quiet.
 */
const XML = `
  <FlexQueryResponse>
    <Trades />
    <CashTransactions>
      <CashTransaction accountId="U1" currency="USD" description="dividend" dateTime="20260120;120000" amount="50.00" type="Dividends" />
      <CashTransaction accountId="U1" currency="USD" description="coupon" dateTime="20260201;120000" amount="41.25" type="Bond Interest Received" />
      <CashTransaction accountId="U1" currency="" description="WIRE WITHOUT CURRENCY" dateTime="20260101;090000" amount="1000" type="Deposits" />
      <CashTransaction accountId="U1" currency="USD" description="WIRE WITHOUT AMOUNT" dateTime="20260102;090000" amount="" type="Deposits" />
      <CashTransaction accountId="U1" currency="BASE_SUMMARY" description="total" dateTime="20260101;090000" amount="9999" type="Deposits" />
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

describe('IBKR cash rows with a required field blank are dropped OUT LOUD (SC-873)', () => {
  test('a row missing `currency` or `amount` is not imported AND is warned about', async () => {
    const { events, warnings } = await fetchWithXml(XML);

    // Both halves are load-bearing and they pull in opposite directions.
    // Deleting the `incomplete` branch from `cashTxDropReason` would let both
    // rows through `classifyCashType` as `Deposits` and satisfy the warning
    // half only by fabricating two ledger entries — one with no currency and
    // one with no amount. So the drop is asserted first.
    const ids = events.map((e) => e.externalId).join('\n');
    expect(ids).not.toContain('WIRE WITHOUT');
    expect(events.filter((e) => e.kind === 'deposit')).toHaveLength(0);

    const incomplete = warnings.find((w) => w.includes('required field blank'));
    expect(incomplete).toBeDefined();
    expect(incomplete).toContain('2 cash transactions');
    expect(incomplete).toContain('1 with no currency');
    expect(incomplete).toContain('1 with no amount');
  });

  test('it is a SECOND warning, not folded into the unmapped-type count', async () => {
    const { warnings } = await fetchWithXml(XML);

    // Two causes, two actions. `Bond Interest Received` is a map we have to
    // extend; a blank column is the user's Flex Query or IBKR's data. One
    // number covering both tells neither reader what to do.
    const unmapped = warnings.find((w) => w.includes('does not recognise'));
    expect(unmapped).toBeDefined();
    expect(unmapped).toContain('"Bond Interest Received" (1)');
    expect(unmapped).toContain('1 cash transaction');
    expect(unmapped).not.toContain('required field blank');

    expect(warnings.filter((w) => w.includes('required field blank'))).toHaveLength(1);
  });

  test('IBKR BASE_SUMMARY is still dropped in silence, and is not counted as incomplete', async () => {
    const { events, warnings } = await fetchWithXml(XML);

    // The total line is IBKR's own and is meant to go quietly. A warning a
    // user meets on every single sync teaches the eye to skip the place the
    // real one appears (SC-435).
    expect(events.map((e) => e.externalId).join('\n')).not.toContain('9999');
    expect(warnings.join('\n')).not.toContain('BASE_SUMMARY');

    const incomplete = warnings.find((w) => w.includes('required field blank'));
    expect(incomplete).toContain('2 cash transactions');
    expect(incomplete).not.toContain('3 cash transactions');
  });

  test('a statement with nothing blank says nothing', async () => {
    const clean = `
      <FlexQueryResponse>
        <Trades />
        <CashTransactions>
          <CashTransaction accountId="U1" currency="USD" description="d" dateTime="20260120;120000" amount="50.00" type="Dividends" />
        </CashTransactions>
        <OpenPositions />
        <CashReport />
      </FlexQueryResponse>
    `;
    const { events, warnings } = await fetchWithXml(clean);

    expect(events).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('required field blank');
  });
});

describe('describeIncompleteCashRows', () => {
  test('returns null when nothing was incomplete, so the caller has nothing to say', () => {
    expect(describeIncompleteCashRows(new Map())).toBeNull();
  });

  test('singular for one row', () => {
    const message = describeIncompleteCashRows(new Map([['currency', 1]]));

    expect(message).toContain('1 cash transaction in this statement');
    expect(message).toContain('it was not imported');
  });

  test('it names both possible owners, because the field is what tells them apart', () => {
    const message = describeIncompleteCashRows(new Map([['amount', 3]]));

    // A column missing from every row is the user's Flex Query; a field blank
    // on one row of many is IBKR's data. The warning cannot tell which from
    // here, so it must not assert either.
    expect(message).toContain('Flex Queries');
    expect(message).toContain('please report it');
  });

  test('most frequent first, and ties break on the field name so runs are stable', () => {
    const message = describeIncompleteCashRows(
      new Map([
        ['currency', 2],
        ['amount', 2],
        ['type or currency or amount', 5],
      ])
    );

    expect(message).toContain('9 cash transactions');
    expect(message).toContain(
      '5 with no type or currency or amount, 2 with no amount, 2 with no currency'
    );
  });
});

describe('incompleteCashFieldsKey', () => {
  test('names only the blank fields, in a fixed order', () => {
    expect(incompleteCashFieldsKey({ type: 'Deposits', currency: '', amount: '10' })).toBe(
      'currency'
    );
    expect(incompleteCashFieldsKey({ type: '', currency: '', amount: '' })).toBe(
      'type or currency or amount'
    );
  });

  test('a zero amount is a value, not a blank', () => {
    // `"0"` is falsy nowhere in this code path, and a zero-amount row is a
    // real IBKR row — grouping it with the blanks would report a loss that
    // did not happen.
    expect(incompleteCashFieldsKey({ type: 'Deposits', currency: 'USD', amount: '0' })).toBe('');
  });
});
