-- 20261017073626 — holdings cache due at
-- SC-1633. The cache is the balance now, so evidence dated after now is not in
-- it yet, and nothing rewrote it when that instant passed. The writer now
-- records the earliest such instant here, and the housekeeping step rewrites
-- each holding once it has passed. Null is the normal case: nothing ahead.
--
-- Not CONCURRENTLY: the runner executes each migration inside one transaction,
-- which forbids it. A nullable column with no default is a catalog change, and
-- the index covers no row when it is built: holdings is 137 rows, 424 kB on
-- production (2026-10-17). lock_timeout makes a busy table fail the migration
-- rather than queue writes behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE holdings ADD COLUMN IF NOT EXISTS cache_due_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_holdings_cache_due_at
  ON holdings (cache_due_at)
  WHERE cache_due_at IS NOT NULL;
