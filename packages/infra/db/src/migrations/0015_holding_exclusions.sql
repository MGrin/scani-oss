-- Tokens a user explicitly rejected for a wallet chain.
--
-- The hourly `wallet-balances` cron auto-discovers newly-received tokens
-- in imported wallets. Without a record of past rejections it would
-- re-create every token the user unchecked in the import-review step.
-- A row here keys the rejection by the same `(institution_id, external_id)`
-- pair the balance provider emits for a snapshot (`chain:contractAddress`
-- for EVM ERC-20s, `native` for the chain native asset, mint address for
-- SPL tokens), so the cron can skip it.

CREATE TABLE IF NOT EXISTS holding_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'user_unchecked',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT holding_exclusions_unique UNIQUE (user_id, institution_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_holding_exclusions_user_institution
  ON holding_exclusions (user_id, institution_id);
