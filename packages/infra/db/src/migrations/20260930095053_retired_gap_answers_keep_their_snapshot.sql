-- 20260930095053 — retired gap answers keep their snapshot
-- SC-1453. When a person retires a balance-gap answer that imported trade
-- settlements now explain, its ledger rows leave through the ordinary undo
-- path and a full copy of them lands here first, so Undo can put them back
-- with their original ids. Append-only: nothing prunes it, restoring stamps
-- `restored_at` and keeps the row, and only deleting the account removes it.
-- Not the observation's receipt, because a later answer-and-undo on the same
-- interval rewrites that, and repairs delete observation rows. Additive.
CREATE TABLE IF NOT EXISTS retired_gap_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holding_id UUID REFERENCES holdings(id) ON DELETE SET NULL,
  observation_id UUID REFERENCES holding_balance_observations(id) ON DELETE SET NULL,
  gap_from TIMESTAMPTZ NOT NULL,
  gap_to TIMESTAMPTZ NOT NULL,
  answer JSONB NOT NULL,
  rows JSONB NOT NULL,
  removed_holdings JSONB NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_retired_gap_answers_user
  ON retired_gap_answers (user_id);
