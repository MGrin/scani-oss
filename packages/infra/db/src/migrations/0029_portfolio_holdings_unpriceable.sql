-- The net-worth chart reported "80% of holdings priced" on an account
-- where 100% of the real holdings were priced. The missing 20% was
-- airdrop spam: unsolicited EVM tokens with no market, which no provider
-- can price and which the unpriceable cooldown had already given up on.
-- Nothing was broken; the denominator was counting dust (SC-146).
--
-- `holdings_total` deliberately keeps its original meaning — every
-- holding in scope — so the millions of already-written rows are not
-- retroactively reinterpreted by a code change. The new column records
-- how many of them are unpriceable *in fact*, and coverage is derived as
--
--     holdings_with_known_value / (holdings_total - holdings_unpriceable)
--
-- DEFAULT 0 makes every pre-existing row behave exactly as it does today
-- until the nightly rollup rewrites it, so the migration alone changes no
-- number on any screen.
ALTER TABLE portfolio_value_daily
  ADD COLUMN IF NOT EXISTS holdings_unpriceable integer NOT NULL DEFAULT 0;
