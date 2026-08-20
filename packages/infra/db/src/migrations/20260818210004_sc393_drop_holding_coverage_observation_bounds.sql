-- SC-393. Two columns that were never once written, on a table whose
-- neighbouring pair of the same shape caused three bugs.
--
-- `holding_coverage.first_observation_at` / `last_observation_at` were a
-- denormalized cache of `min(observed_at)` / `max(observed_at)` over
***REMOVED***
***REMOVED***
***REMOVED***
-- has ever populated them — the one live writer,
-- `TransactionImportCoordinator.persistAndReport`, passed null for both on
-- every call — and nothing has ever read them.
--
-- Dropped rather than filled, because filling them would rebuild a defect
-- this table has already produced. `first_tx_at` / `last_tx_at` are the
-- identical shape over `holding_transactions`, and were *reported* by
-- whichever path had just written the ledger. Six of seven writers reported
-- nothing; the seventh reported the whole run's oldest and newest event to
-- every holding it touched, so a holding first seen last week inherited the
***REMOVED***
-- needed a production repair (SC-319). The fix there was to stop reporting
-- and derive from the table, because a summary of a table has one correct
-- source and it is the table. These two columns are the same summary of a
***REMOVED***
***REMOVED***
-- number worth storing twice.
--
-- Safe to drop, on three measurements rather than on inspection:
--
--   1. No data is lost. Not "nearly none" — `count(first_observation_at)`
***REMOVED***
--   2. Nothing in the catalogue depends on them. No view, materialized view,
--      constraint or index references either column; `holding_coverage` has
--      one index, its primary key on `holding_id`.
--   3. Nothing in the code reads them. The three cost-basis consumers of
--      `findManyByHoldingIds` pass the row through `historyCompletenessOf`,
--      whose parameter type is `{ hasCompleteTxHistory: boolean }`;
--      `HoldingQueryService` reads `opening_balance_quantity` and
--      `reconciliation_notes`. No coverage row is ever spread into a DTO, so
--      neither column reaches the wire implicitly either.
--
-- Reversal is a forward migration adding two nullable timestamps back, and
-- it would restore exactly what is here now: nothing. If a reader for
-- observation bounds is ever wanted, it should derive them from
-- `holding_balance_observations` the way `syncTxBoundsFromLedger` derives the
-- tx bounds from the ledger, not read a column an importer claims to keep.
ALTER TABLE "holding_coverage" DROP COLUMN IF EXISTS "first_observation_at";
ALTER TABLE "holding_coverage" DROP COLUMN IF EXISTS "last_observation_at";
