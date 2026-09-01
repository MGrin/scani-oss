import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { IbkrProvider } from '../../src/providers/ibkr';

function passthroughLimiter(): OutflowRateLimiter {
  return { execute: async <T>(fn: () => Promise<T>) => fn() } as unknown as OutflowRateLimiter;
}

const noSleep = async () => {};

const ctx = {
  institutionCode: 'ibkr',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ flexQueryToken: 't', flexQueryId: 'q' }),
};

/** The window attributes are the subject; the rows only make the run realistic. */
function statement(flexStatementAttrs: string): string {
  return `
  <FlexQueryResponse>
    <FlexStatements>
      <FlexStatement ${flexStatementAttrs}>
        <Trades />
        <CashTransactions>
          <CashTransaction accountId="U1" currency="USD" description="X" dateTime="20260214" reportDate="20260214" transactionID="900000001" levelOfDetail="DETAIL" amount="100" type="Deposits/Withdrawals" />
        </CashTransactions>
      </FlexStatement>
    </FlexStatements>
  </FlexQueryResponse>`;
}

async function run(
  xml: string,
  since?: Date
): Promise<{ retractions: string[]; warnings: string[] }> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('SendRequest')
      ? new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>'
        )
      : new Response(xml)) as typeof fetch;
  try {
    const retractions: string[] = [];
    const warnings: string[] = [];
    await new IbkrProvider(passthroughLimiter(), noSleep).fetchTransactions({
      ...ctx,
      since,
      retractHistoryClaim: (r: string) => retractions.push(r),
      noteWarning: (w: string) => warnings.push(w),
    } as never);
    return { retractions, warnings };
  } finally {
    globalThis.fetch = original;
  }
}

const BOUNDED = 'accountId="U1" fromDate="20250829" toDate="20260828" period="Last365CalendarDays"';

/**
 * A Flex statement covers whatever window the user's saved query names, and
 * Scani sends no date range — `requestReport` puts `t`, `q` and `v=3` on the
 * wire and nothing else. So a run that asked for the whole ledger receives
 * that query's window and nothing older, and `TransactionRouter` wrote
 * `has_complete_tx_history = true` over it because IBKR declares no
 * `transactionHistoryHorizonMs` (SC-882).
 *
 * The horizon could not be DECLARED, which is why this is a retraction and
 * not the one-line constant the other nine providers carry: the window is a
 * per-user setting picked in Account Management, so it is unknown until the
 * statement arrives and different for the next user. A static 365 days would
 * be a guess about somebody else's configuration, and `describeHorizon` would
 * then state that guess to a reader whose query names thirty days.
 */
describe('IBKR retracts the completeness claim its statement cannot support', () => {
  test('a full-history run retracts, naming the window the statement covers', async () => {
    const { retractions } = await run(statement(BOUNDED));
    expect(retractions).toHaveLength(1);
    const reason = retractions[0] ?? '';
    expect(reason).toContain('ibkr:');
    expect(reason).toContain('2025-08-29');
    expect(reason).toContain('Last365CalendarDays');
  });

  /**
   * THE LOAD-BEARING HALF, and the reason this fix is scoped rather than
   * unconditional (SC-877). `TransactionImportCoordinator` passes
   * `completenessIsClaimed: !since || historyRetractions.length > 0`, so a
   * retraction on an incremental run WRITES `has_complete_tx_history` through
   * where today the nightly leaves the stored value alone. The nightly is the
   * path that carries a 30-day `attachSince` cutoff for every account with a
   * ledger, which is the live IBKR account — so an unconditional retraction
   * would move a cost-basis flag on production data as a side effect of a
   * claim nobody made.
   *
   * A `since` run makes no completeness claim to take away: the router's own
   * `describeHorizon` is guarded the same way and for the same stated reason
   * — a window is the caller's choice rather than a shortfall.
   */
  test('an incremental run retracts nothing, so the nightly path is untouched', async () => {
    const { retractions } = await run(statement(BOUNDED), new Date('2026-08-01T00:00:00Z'));
    expect(retractions).toEqual([]);
  });

  /**
   * Absent evidence is not coverage. A statement whose window cannot be read
   * says nothing about how far back it reaches, and the optimistic reading of
   * that silence is the defect itself one layer down.
   */
  test('a statement with no readable window still retracts', async () => {
    const { retractions } = await run(statement('accountId="U1"'));
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('does not say');
  });

  /** IBKR's other date spelling, already handled for `toDate` (SC-384). */
  test('the hyphenated date spelling is read too', async () => {
    const { retractions } = await run(
      statement('accountId="U1" fromDate="2025-08-29" toDate="2026-08-28" period=""')
    );
    expect(retractions[0]).toContain('2025-08-29');
  });

  /**
   * The retraction is evidence about the ledger and moves
   * `has_complete_tx_history`; the section and row warnings are not and do
   * not. Keeping them in separate sinks is the SC-428 distinction, so a
   * change that routed this through `noteWarning` would be silently inert.
   */
  test('it goes to retractHistoryClaim, not to noteWarning', async () => {
    const { retractions, warnings } = await run(statement(BOUNDED));
    expect(retractions).toHaveLength(1);
    expect(warnings.some((w) => w.includes('2025-08-29'))).toBe(false);
  });
});
