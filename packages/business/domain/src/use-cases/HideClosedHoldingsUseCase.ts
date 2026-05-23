import { db } from '@scani/db/connection';
import { createComponentLogger } from '@scani/logging';
import { sql } from 'drizzle-orm';
import { Service } from 'typedi';

const logger = createComponentLogger('use-case:hide-closed-holdings');

// A holding is "closed" when balance has been zero AND no transactions
// have landed in the last `STALE_DAYS`. Threshold tuned to the user
// who flagged the cluttered holdings list — they want short. Anything
// shorter than a week risks flickering on the day a position is
// closed-then-reopened, which is plausible for active traders.
const STALE_DAYS = 7;

export interface HideClosedHoldingsSummary {
  scanned: number;
  hidden: number;
  durationMs: number;
}

@Service()
export class HideClosedHoldingsUseCase {
  // Hides holdings whose balance is zero and whose latest tx (if any)
  // is older than the staleness threshold. Sets `is_hidden=true` rather
  // than `is_active=false` so the existing reads (which already filter
  // is_hidden) start excluding them immediately. The user can flip
  // them back via the manual "show hidden" toggle in the UI.
  //
  // Idempotent: re-running a closed holding is a no-op (it's already
  // hidden). Re-opening a position via a new tx makes the next sweep
  // skip it (latest_tx_at advances; balance > 0).
  async execute(): Promise<HideClosedHoldingsSummary> {
    const start = Date.now();
    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

    // Single statement: find every visible (non-hidden) holding with
    // balance=0 whose newest tx (if any) is older than the cutoff, and
    // hide it. The CTE narrows candidates first; the cutoff applies in
    // the UPDATE so re-opened positions get a chance to skip the sweep.
    const rows = (await db.execute<{ id: string; symbol: string }>(sql`
      WITH candidates AS (
        SELECT h.id, t.symbol,
               (SELECT MAX(occurred_at) FROM holding_transactions WHERE holding_id = h.id) AS latest_tx
        FROM holdings h
        JOIN tokens t ON t.id = h.token_id
        WHERE h.is_hidden = false
          AND h.balance::numeric = 0
      )
      UPDATE holdings h
      SET is_hidden = true,
          last_updated = NOW()
      FROM candidates c
      WHERE c.id = h.id
        AND (c.latest_tx IS NULL OR c.latest_tx < ${cutoff.toISOString()}::timestamptz)
      RETURNING h.id, c.symbol
    `)) as unknown as Array<{ id: string; symbol: string }>;

    const hidden = rows.length;
    const durationMs = Date.now() - start;

    if (hidden > 0) {
      logger.info(
        { hidden, sample: rows.slice(0, 10).map((r) => r.symbol), staleDays: STALE_DAYS },
        'Hid closed holdings'
      );
    }

    return { scanned: hidden, hidden, durationMs };
  }
}

// Re-exported for tests + the data-quality endpoint that uses the same
// staleness threshold to count "would-be-hidden" candidates.
export const HIDE_CLOSED_HOLDINGS_STALE_DAYS = STALE_DAYS;
