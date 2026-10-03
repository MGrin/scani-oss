-- 20260930071843 — settlement rows link to their trade
-- SC-1453. A broker that reports a trade as one row gets its cash side written
-- as a `settle_in`/`settle_out` row (and a `fee` row for a commission in another
-- currency) on the cash holding. Each of those points at its trade, so deleting
-- or re-importing the trade removes them with it. Additive: nullable, no row
-- read or changed. Partial index because only settlement rows carry it.
ALTER TABLE holding_transactions
  ADD COLUMN IF NOT EXISTS settles_transaction_id UUID
  REFERENCES holding_transactions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_holding_tx_settles
  ON holding_transactions (settles_transaction_id)
  WHERE settles_transaction_id IS NOT NULL;
