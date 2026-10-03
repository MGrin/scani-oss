-- 20261002114109 — feed input windows unique per fetch
-- Foundation A2, task 5. A fetch records at most one window: a replayed fetch
-- (a retried job, a double-submitted upload) carries the same input, range and
-- fetch instant, and today it would add a second row for the same fetch.
--
-- NULLS NOT DISTINCT because `from_at` is NULL for an open start, and two
-- windows that are both unbounded at the start are the same window. A plain
-- unique index treats every NULL as different and would let the replay in.
-- Production holds no rows in the table, so there is nothing to repair first.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on this table behind it.
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX feed_input_windows_fetch_uq
  ON feed_input_windows (input_id, from_at, to_at, fetched_at) NULLS NOT DISTINCT;
