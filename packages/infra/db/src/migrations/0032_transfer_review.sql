-- SC-150. Moving your own coins between your own accounts is not a disposal,
-- but whether Scani knows that depends on a nightly heuristic pairing the two
-- legs (±1% quantity, ±30 minutes). When it cannot, `LinkTransferPairsUseCase`
-- counted the row as `ambiguous` and dropped it — the counter went to a log
-- line and nowhere else, so there was no queue, nothing to query, and nothing
-- a person could answer. The outflow was then realized at market value: an
-- invented taxable event and an invented gain, always upward.
--
-- This column is that queue's missing half — the answer. Three values, all
-- written by a human and never by the matcher:
--
--   'paired'       the user picked the matching inflow; both legs also get a
--                  shared `transfer_group_id`, so cost basis carries across
--   'left_control' it really did leave the portfolio (sold off-platform,
--                  gifted, spent) — realizing at market is now a decision
--   'untracked'    still the user's money, in an account Scani cannot see;
--                  not a disposal, so nothing is realized
--
-- NULL means nobody has been asked yet, which is every row that exists today.
-- It is deliberately NOT defaulted to a "pending" string: the queue is defined
-- by `transfer_group_id IS NULL AND transfer_review IS NULL` over outflow
-- kinds, and a default would put every inflow and every buy in a state that
-- reads as awaiting review.
ALTER TABLE "holding_transactions" ADD COLUMN IF NOT EXISTS "transfer_review" text;
ALTER TABLE "holding_transactions"
  ADD COLUMN IF NOT EXISTS "transfer_reviewed_at" timestamp with time zone;

-- The queue's own read. Partial because the pending set is tiny next to the
-- table: paired outflows, answered outflows and every inflow stay out of the
-- index entirely.
--
-- Drizzle's migrator wraps each migration in BEGIN/COMMIT and CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction (Postgres 25001), so this is
-- the plain form — same reasoning as 0012.
CREATE INDEX IF NOT EXISTS idx_holding_tx_transfer_review_pending
  ON holding_transactions (user_id, occurred_at DESC)
  WHERE transfer_group_id IS NULL
    AND transfer_review IS NULL
    AND kind IN ('withdraw', 'transfer_out');
