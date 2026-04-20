-- Add CHECK constraints to enforce domain invariants that the app layer
-- already validates. A rogue raw SQL insert (from a script or psql session)
-- cannot corrupt the table any more.

-- Balance must be non-negative. Stored as text (Decimal.js precision), so we
-- cast at check time. A bad string that isn't numeric (e.g. '') would break
-- the cast, which is desirable — it rejects corrupt writes.
ALTER TABLE "holdings"
  ADD CONSTRAINT "holdings_balance_nonneg_chk"
  CHECK ((balance)::numeric >= 0);

-- Vault allocation percentage must be in (0, 100].
ALTER TABLE "vault_holdings"
  ADD CONSTRAINT "vault_holdings_percentage_range_chk"
  CHECK (percentage > 0 AND percentage <= 100);

-- Token decimals must be non-negative.
ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_decimals_nonneg_chk"
  CHECK (decimals >= 0);

-- APY rate can't be negative. Stored as text for decimal precision, same
-- pattern as holdings.balance.
ALTER TABLE "holding_apy_configs"
  ADD CONSTRAINT "holding_apy_configs_rate_nonneg_chk"
  CHECK ((annual_rate_pct)::numeric >= 0);
