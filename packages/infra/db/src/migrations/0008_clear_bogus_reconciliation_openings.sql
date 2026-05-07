-- Wipe the synthesized opening_balance rows that the post-merge
-- holdings inherited from their (deleted) duplicates. The reconciler
-- algorithm prior to today included its own past output in the new
-- sum, which oscillated the opening's sign whenever a holding was
-- migrated; on prod this manifested as cost_basis=0 for every IBKR
-- equity (and most chain-spread crypto), making the PnL chart show a
-- $102K gain that's entirely unrealized-against-zero-cost.
--
-- After this migration, every real holding's tx chain stands on its
-- own. The portfolio-history-backfill job (manual or nightly) calls
-- the reconciler again with the new exclude-prior-output algorithm and
-- only synthesizes openings where they're genuinely needed.

DELETE FROM holding_transactions WHERE source = 'reconciliation-opening';

UPDATE holding_coverage
   SET opening_balance_quantity = NULL,
       reconciliation_notes = NULL,
       updated_at = NOW()
 WHERE opening_balance_quantity IS NOT NULL;
