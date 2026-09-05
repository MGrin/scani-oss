-- SC-951 — the balance that arrived AFTER this holding's ledger already
-- explained it, so a reader can be told about it at all.

-- `OpeningBalanceReconciliationService` has four actions and, until now, only
-- one of them left anything a reader could see. `missing-inflows` writes a
-- negative `opening_balance_quantity`, which two surfaces read. The other two
-- positive branches — `arrived-later` and `opening` — compute a residue from
-- one expression pair, `openingQuantity = min(observed, computedOpening)` and
-- `residual = computedOpening - openingQuantity`, and then have nowhere to put
-- it: `arrived-later` writes the literal '0' and no transaction at all, and
-- `opening` buries the figure in a transaction's `source_metadata` JSON that
-- nothing queries. The amount therefore existed nowhere as a NUMBER — only
-- inside an English sentence in `reconciliation_notes`, which one reader reads
-- and only on the branch this column is not about.
--
-- ## Why a column rather than a derivation
--
-- Recomputing it in the query service would be a second implementation of the
-- reconciler's arithmetic, which `projectHolding` exists to prevent: the walk
-- back to the opening, the cap at the computed bound and the epsilon that
-- decides what counts as nothing are three decisions, and a copy of them would
-- disagree with the original the first time any one of them moved.
--
-- ## What the column means, and what it does NOT mean
--
-- Balance that exists today, has no transaction to account for it, and
-- demonstrably did not exist at the opening because an observation says
-- otherwise. Positive, epsilon-filtered by the writer, as a Decimal string.
--
-- NULL means the reconciler found no such residue — or has not run. It does
-- NOT mean the ledger is complete, and no reader may render it as one.
--
-- It is deliberately NULL on `missing-inflows` too, where the residual is
-- negative and IS the shortfall `opening_balance_quantity` already carries.
-- Writing it there would put the same money in two columns and invite a reader
-- to add them.
--
-- ## It is a fact, not a flag (mgrin, 2026-09-03)
--
-- Nothing counts this, filters on it, or calls it worth looking into. The
-- product cannot tell a benign interest accrual on a cash account from a
-- genuinely missed deposit — `residueCause` is hardcoded 'unexplained' on both
-- branches that reach here — so a "worth looking into" bucket would be
-- permanently wrong for the case that actually fires. The accepted cost is
-- that a missed deposit reads as unremarkable. That was taken knowingly.
ALTER TABLE holding_coverage
  ADD COLUMN unexplained_residual text;

COMMENT ON COLUMN holding_coverage.unexplained_residual IS
  'Positive Decimal string: balance with no transaction to account for it, which arrived after the ledger already explained this holding at its first observation. NULL = no such residue, or reconciliation has not run; it is not a claim that the ledger is complete (SC-951).';
