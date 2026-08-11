ALTER TABLE holding_transactions ADD COLUMN IF NOT EXISTS counterparty text;
ALTER TABLE holding_transactions ADD COLUMN IF NOT EXISTS description text;

-- Detection groups by counterparty; this index carries that scan.
CREATE INDEX IF NOT EXISTS idx_holding_tx_counterparty
  ON holding_transactions (user_id, counterparty)
  WHERE counterparty IS NOT NULL;
