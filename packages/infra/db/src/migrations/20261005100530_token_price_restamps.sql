-- 20261005100530 — token price restamps
-- Foundation A3, task 14 (Ops O1). The backup and the record of the one
-- operation that brings existing `token_prices` rows onto the daily
-- convention (D-8: a daily row for day D is stamped D 23:59:59.999Z), and
-- stored FX history onto the central banks (T10-2).
-- `scripts/restamp-daily-prices.ts` writes one row here for every row it
-- changes, in the same transaction as the change:
--
--   restamp  a daily row moved to its day's last millisecond
--   relabel  a daily row that is a price at an instant, now `intraday`
--   delete   the loser of a conflict between two rows on one key
--   refetch  a stored FX close replaced by the central bank's
--   insert   a row the operation created (a refetched or fetched close)
--
-- `old_row` is the row as it was, `to_jsonb` of the whole row, so the
-- operation can be undone from this table alone; an `insert` has none, and
-- undoing it deletes `price_id`. `price_id` carries no foreign key: the row it
-- names may have been deleted by the operation, or by its undo. `run_at` is
-- the apply transaction's clock, so every row of one run shares it and it
-- names the run. `category` is what the run reports and what the history
-- diff attributes a changed reading to.
--
-- Purely additive. Nothing reads it but the script.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS token_price_restamps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL,
  price_id UUID NOT NULL,
  action TEXT NOT NULL
    CONSTRAINT token_price_restamps_action_chk
      CHECK (action IN ('restamp', 'relabel', 'delete', 'refetch', 'insert')),
  category TEXT NOT NULL,
  old_row JSONB,
  CONSTRAINT token_price_restamps_old_row_chk CHECK ((action = 'insert') = (old_row IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_token_price_restamps_run_at ON token_price_restamps (run_at);
CREATE INDEX IF NOT EXISTS idx_token_price_restamps_price_id ON token_price_restamps (price_id);
