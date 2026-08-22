-- 20260822064054 — sc501 balance observation gap review
--
-- The owner's answer to "we think money moved here — tell us", recorded on
-- the CLOSING observation of the pair it is about (SC-501).
--
-- A gap is two consecutive balance observations whose difference the ledger
-- does not explain. The pair is determined by the later observation — its
-- predecessor is whatever sits before it on the same holding — so the later
-- row is the whole key. That is why this is three columns here rather than a
-- table: there is nothing to create before the owner answers, and no second
-- copy of the question to drift from the observations that define it.
--
-- The shape mirrors `holding_transactions.transfer_review` /
-- `transfer_reviewed_at` / `transfer_review_source` on purpose: same asymmetry
-- (only a human writes it, so NOT NULL means a person decided), same
-- nullability, same absence of a CHECK.
--
-- NULL on every existing row and that is the correct backfill. NULL means
***REMOVED***
ALTER TABLE holding_balance_observations
  ADD COLUMN gap_review TEXT,
  ADD COLUMN gap_reviewed_at TIMESTAMPTZ,
  ADD COLUMN gap_review_source TEXT;

-- No CHECK constraint, and no NOT NULL once written.
--
-- The vocabulary is enforced by the zod enum on the wire, the same decision
-- migration 20260821120510 made for `holdings.manual_edit_cause` and for the
-- same reason: a fourth answer should not need a migration.
--
-- The nullability is load-bearing for a different reason. An answer must stay
-- REOPENABLE. "I don't know" is a supported answer and it is the one most
-- likely to be given wrongly — by somebody guessing to clear a row — and a
-- state that can only be entered once is how a wrong answer becomes
-- permanent. Nothing in this schema forecloses writing NULL back, so a future
-- undo, a rule change, or a repair script that reopens a class of answers the
-- way `scripts/reopen-transfer-answers.ts` already does for transfers, needs
-- no migration and no new state.
--
-- The queue's own read: one user's observations in holding/time order, which
-- is exactly the window the drift computation partitions and orders by.
-- Including `balance` makes it index-only, so the walk neither sorts nor
-- touches the heap.
--
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
***REMOVED***
-- claim about a speed.
CREATE INDEX IF NOT EXISTS idx_holding_obs_user_holding_observed
  ON holding_balance_observations (user_id, holding_id, observed_at)
  INCLUDE (balance);
