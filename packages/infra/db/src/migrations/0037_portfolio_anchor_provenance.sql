-- SC-249. `BalanceAtTimeService` computes how a past-date balance was
-- anchored — `observation-after`, `holdings`, or `observation-before` — and
-- when that anchor was, "so callers can judge confidence" per its own
-- comment. `observation-before` is the weak one: it means nothing at or
-- after the requested date existed, so the balance was extrapolated FORWARD
-- from older data. How much weaker depends entirely on how far back, which
-- `anchorAt` already knows.
--
-- Neither ever reached a reader. Every chart endpoint is a pure cache read
-- of this table — live valuation was removed after it OOM-killed the backend
-- — so provenance that stops before this table stops before everyone. The
-- only surviving trace was a single bit: any backward anchor anywhere in
-- scope downgraded the whole day's `coverage_quality` to 'partial', which is
-- also what a merely stale PRICE does. Two different faults, one indicator,
-- no magnitude.
--
-- On production this is the difference between a holding anchored 54 seconds
-- back and one anchored 71 days back, presented identically (SC-245).
--
-- **Both columns are NULLABLE, and that is the point.** The obvious
-- declaration is `integer NOT NULL DEFAULT 0`, which is what
-- `0031_portfolio_quality_signals.sql` did for `holdings_stale_priced` — and
-- it means every row written before that migration now asserts it had zero
-- stale-priced holdings, when the truth is that nobody counted. A default
-- turns "not recorded" into a confident "none", which is the exact class of
-- defect this column exists to fix. NULL here means NOT RECORDED: the row
-- was computed before the rollup carried provenance. Rows written from now
-- on carry a real count, including a real 0.
--
-- No backfill. The honest value for an old row is unknown, and recomputing
-- them is a 60,837-row-per-user operation (measured under SC-242) to replace
-- a truthful NULL with a number.
ALTER TABLE "portfolio_value_daily"
  ADD COLUMN IF NOT EXISTS "holdings_stale_anchored" integer,
  ADD COLUMN IF NOT EXISTS "oldest_anchor_at" timestamptz;

COMMENT ON COLUMN "portfolio_value_daily"."holdings_stale_anchored" IS
  'Of holdings_with_known_value, how many had their balance extrapolated forward from an observation BEFORE the snapshot date. NULL = computed before this was recorded, not zero. SC-249.';

COMMENT ON COLUMN "portfolio_value_daily"."oldest_anchor_at" IS
  'The oldest anchor timestamp among the backward-anchored holdings — the far end of the weakest reconstruction in this row. NULL when none were backward-anchored OR when the row predates SC-249; holdings_stale_anchored distinguishes the two.';
