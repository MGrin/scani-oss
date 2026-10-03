-- 20261002220617 — holding transactions unique per input
-- Foundation A2, task 13. A feed input states each external id once, whichever
-- holding the entry sits in. `holding_tx_dedup` keys on (holding, source,
-- external_id), so an event a re-import resolved to a second holding landed
-- twice; ingest now arbitrates on this key and moves the row instead.
--
-- Person and system rows carry no input, and a NULL input_id is distinct from
-- every other, so they stay exempt. `holding_tx_dedup` stays for them until A5.
--
-- Precondition: no (input_id, external_id) is held twice, or ADD CONSTRAINT
-- fails with 23505 and the deploy with it. Read on the table immediately
-- before this runs; it must be 0:
--   SELECT count(*) FROM (SELECT 1 FROM holding_transactions
--     WHERE input_id IS NOT NULL AND external_id IS NOT NULL
--     GROUP BY input_id, external_id HAVING count(*) > 1) d;
-- Ops O1's `inputDedupCollisions` = 0 does not replace it: that is read when O1
-- runs, and any writer stamping input_id after that can add a pair.
-- A feed row O1 could not fill keeps a NULL input_id; ingest stamps it before
-- its next write (ruling R55), so nothing here re-fills rows.
--
-- The unique index leads on input_id, so it is the one a deleted input's
-- ON DELETE SET NULL walks, and the partial index on input_id goes (A1
-- carry-forward 7).
--
-- No observation index (ruling R53 asked for one): the reads it named,
-- `findLatestAtOrAfter` and `findLatestAtOrBefore`, filter one holding and
-- order by observed_at, which `idx_holding_obs_holding_observed` and
-- `holding_obs_dedup` already lead on.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on this table behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE holding_transactions
  ADD CONSTRAINT holding_tx_input_external_uq UNIQUE (input_id, external_id);

DROP INDEX IF EXISTS idx_holding_tx_input_id;
