import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { type JobNotice, type NoticeInput, toJobNotice } from '../../src/core/types';
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
): Promise<{
  retractions: string[];
  notices: JobNotice[];
  warnings: string[];
  bounds: Array<Date | undefined>;
}> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url).includes('SendRequest')
      ? new Response(
          '<FlexStatementResponse><Status>Success</Status><ReferenceCode>1</ReferenceCode><Url>https://x/GetStatement</Url></FlexStatementResponse>'
        )
      : new Response(xml)) as typeof fetch;
  try {
    const retractions: string[] = [];
    // The same retraction as a structure, so a test can ask what key it
    // travels under as well as what it says (SC-434).
    const notices: JobNotice[] = [];
    const warnings: string[] = [];
    // Captured positionally beside the reason: what matters is that the two
    // arrive on the SAME call, so a bound cannot be stated by a run that did
    // not also retract (SC-900).
    const bounds: Array<Date | undefined> = [];
    await new IbkrProvider(passthroughLimiter(), noSleep).fetchTransactions({
      ...ctx,
      since,
      retractHistoryClaim: (r: NoticeInput, bound?: { historyStartsAt: Date }) => {
        const notice = toJobNotice(r);
        notices.push(notice);
        retractions.push(notice.text);
        bounds.push(bound?.historyStartsAt);
      },
      noteWarning: (w: NoticeInput) => warnings.push(toJobNotice(w).text),
    } as never);
    return { retractions, notices, warnings, bounds };
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

/**
 * The same retraction, carrying the key a Russian reader renders it under
 * (SC-434).
 *
 * The three branches are asserted separately because they are three keys, and
 * the one a run takes is decided by data the user chose in IBKR rather than by
 * anything here — a saved query with a period, one without, and one whose
 * window cannot be read at all. `text` is asserted alongside every key, since
 * it is what renders when a build does not carry the key and is therefore the
 * half that must never go missing.
 *
 * Note what is NOT in `params`: the navigation path and the explanation are
 * inside the translated sentence, not interpolated into it. Only the date and
 * IBKR's own `period` identifier cross the boundary, which is the rule that
 * decides whether a producer can be keyed at all.
 */
describe('the IBKR window retraction names a key', () => {
  test('a statement with a period', async () => {
    const { notices } = await run(statement(BOUNDED));
    expect(notices[0]?.key).toBe('v3.jobs.notices.ibkrStatementWindowPeriod');
    expect(notices[0]?.params).toEqual({ from: '2025-08-29', period: 'Last365CalendarDays' });
    expect(notices[0]?.text).toContain('2025-08-29');
  });

  test('a statement with no period takes the other key', async () => {
    const { notices } = await run(
      statement('accountId="U1" fromDate="2025-08-29" toDate="2026-08-28" period=""')
    );
    expect(notices[0]?.key).toBe('v3.jobs.notices.ibkrStatementWindow');
    expect(notices[0]?.params).toEqual({ from: '2025-08-29' });
    expect(notices[0]?.text).toContain('2025-08-29');
  });

  /**
   * The unreadable window is keyed too. It is the branch that says the least,
   * which is exactly why it must not be the one that falls back to English:
   * a reader meeting it has the least to go on already.
   */
  test('an unreadable window is keyed, with no params to interpolate', async () => {
    const { notices } = await run(statement('accountId="U1"'));
    expect(notices[0]?.key).toBe('v3.jobs.notices.ibkrStatementWindowUnknown');
    expect(notices[0]?.params).toBeUndefined();
    expect(notices[0]?.text).toContain('does not say which window it covers');
  });
});

/**
 * SC-900 — the window is also a NUMBER, not only a sentence.
 *
 * SC-882 shipped the reader's half: a statement that cannot cover the whole
 * ledger says so in words. Reconciliation needs the same fact as a date, so it
 * can tell a residue with a known, permanent cause apart from one nobody can
 * account for — and a service parsing a date back out of English prose is how
 * those two come to disagree.
 *
 * It rides on `retractHistoryClaim` rather than on a sink of its own. A bound
 * is only meaningful about a ledger already known to be short, so a provider
 * must not be able to state one while still claiming it read everything.
 */
describe('IBKR states how far back its statement reaches, beside the reason', () => {
  test('the window travels with the retraction as a date', async () => {
    const { retractions, bounds } = await run(statement(BOUNDED));
    expect(retractions).toHaveLength(1);
    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.toISOString().slice(0, 10)).toBe('2025-08-29');
  });

  /**
   * The window slides — it is a date range somebody picked in Account
   * Management, and re-picking it is the documented remedy for a ledger that
   * does not reach far enough. Two statements, one variable.
   */
  test('a different saved window produces a different bound', async () => {
    const { bounds } = await run(
      statement('accountId="U1" fromDate="20230104" toDate="20240930" period=""')
    );
    expect(bounds[0]?.toISOString().slice(0, 10)).toBe('2023-01-04');
  });

  /**
   * THE CONTROL. A statement whose window cannot be read still retracts —
   * silence about the range is not a range — but it must not manufacture a
   * boundary, because a date invented here becomes an explanation printed over
   * a gap nobody measured.
   */
  test('an unreadable window retracts with NO bound rather than a default', async () => {
    const { retractions, bounds } = await run(statement('accountId="U1"'));
    expect(retractions).toHaveLength(1);
    expect(bounds[0]).toBeUndefined();
  });

  test('an incremental run states neither, so the nightly path is untouched', async () => {
    const { retractions, bounds } = await run(statement(BOUNDED), new Date('2026-08-01T00:00:00Z'));
    expect(retractions).toEqual([]);
    expect(bounds).toEqual([]);
  });
});
