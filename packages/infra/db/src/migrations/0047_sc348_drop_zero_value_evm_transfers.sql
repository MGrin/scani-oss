-- SC-348 + SC-343. Two cleanups shipped beside the two writers that produced
-- them, because a delete without its writer is undone by the next hourly sync.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART 1 (SC-348) — 114 `etherscan` rows that record a movement of zero.
-- ─────────────────────────────────────────────────────────────────────────
--
-- They are address poisoning. A spam transaction emits hundreds of zero-value
-- `Transfer` logs on the REAL USDC and USDT contracts with `from` spoofed
-- across many victims at once, so each victim's history shows an outgoing
-- USDC transfer of 0 sitting beside a lookalike address they will later copy
-- out of it. That effect — the row being READ — is the entire payload of the
-- attack, and it is what this removes.
--
-- `spam-filter.ts` matches token name and symbol and structurally cannot see
-- them: the name and symbol are genuinely USDC's, because the contract
-- genuinely is USDC. The writer fixed alongside this migration therefore
-- matches on SHAPE — `normalizeTokenTx` drops any leg whose value is zero,
-- which is the filter `normalizeNativeTx` and `normalizeInternalTx` have
-- always applied.
--
-- MEASURED read-only against production 2026-08-17, by re-reading `tokentx`
-- for all three wallets on four chains (1071 legs) and diffing against the
-- ledger:
--
--   * 117 legs on chain carry value 0; 114 reached the ledger (three name a
--     token with no holding on the account and were already skipped).
--   * All 117 sit on SIX REAL contracts — USDC-eth 52, USDT-eth 36,
--     USDC-base 18, USDC-poly 9, USDT0-poly 1, somm 1. Not one is a spam
--     contract, which is why no identity-based filter could have caught them.
--   * 113 of the 114 are poisoning: `transfer_out`, `from` spoofed to the
--     user's own address, an event they had no part in.
--   * THE ONE THAT IS NOT is a user-initiated `unstake(uint256)` on the SOMM
--     staking contract whose payout really was zero — read back from
--     `eth_getTransactionReceipt`, where the SOMM `Transfer` log's data is
--     `0x00…00`. It is a real event. It moved nothing, and a ledger of
--     holdings records movements, so it goes too. Named here rather than
--     rounded away: this delete takes exactly one legitimate row.
--   * No zero row is in a `transfer_group`, and none has a nonzero sibling
--     that could be affected by its removal.
--
-- ►► `transfer_review`: THIS DELETES TEN ANSWERS, and that is a decision, not
--    a side effect. Ten of the 114 carry `transfer_review = 'left_control'`
--    with `transfer_reviewed_at IS NULL`. That NULL is this codebase's own
--    distinction — `TransferReviewService` reports such a row as
--    `answerSource: 'unattributed'` and `CostBasisService` agrees — so these
--    are system-derived, not answers a person gave. They also realize
--    nothing: `left_control` books a disposal OF THE ROW'S QUANTITY, and the
--    quantity is 0. Deleting them moves no cost basis and no realized PnL.
--    Nine sit on Polygon USDC, one on Base USDC. Nothing else in this
--    migration or its PR writes to `transfer_review`.
--
-- The rows are also already invisible in the review queue — #933 filters
-- zero-quantity rows out of the pending predicate (SC-346) — so no question
-- stops being asked by removing them.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART 2 (SC-343) — 111 `tokens` rows the import minted and never used.
-- ─────────────────────────────────────────────────────────────────────────
--
-- NOT THE SAME SPAM, and the measurement says so plainly: all 111 contracts
-- appear in the same 1071-leg sweep and NOT ONE of them has a single
-- zero-value leg. They arrived as ordinary nonzero fake-token airdrops. The
-- two tickets are one attack surface and two distinct writers.
--
-- `TransactionRouter` resolved the token identity BEFORE the holding, so a
-- wallet-derived event for a token the user dropped at wallet review wrote a
-- `tokens` row and then discarded every event that referenced it. The row
-- stayed forever. 47 of the 111 are a plain `USDC` / `USD Coin` /
-- `Tether USD` on a spam contract with a scam score of 0 — under the 0.35
-- threshold, so token search returns them next to the real thing.
--
-- The writer fixed alongside this: under find-only sources the router now
-- looks the identity up without creating it. A holding cannot exist without a
-- token row, so an identity the database does not already hold could never
-- have produced one.
--
-- The predicate re-derives the safe set at run time rather than trusting the
-- measurement: every table that references `tokens` is excluded explicitly,
-- so a row that acquired a holding, a transaction, a price or a currency role
-- between the measurement and the deploy is left alone. On production
-- 2026-08-17 it selects exactly 111, with zero price rows and zero references
-- of any kind.
--
-- RESIDUAL, deliberately out of scope: 321 OLDER orphan tokens exist by the
-- same predicate, three of them referenced elsewhere and 60 carrying price
-- history. They span finnhub, kraken and solana as well as etherscan and are
-- a different question with different evidence. Filed separately rather than
-- swept in here.

BEGIN;

DELETE FROM holding_transactions
 WHERE source = 'etherscan'
   AND quantity::numeric = 0;

DELETE FROM tokens t
 WHERE t.created_at >= TIMESTAMPTZ '2026-08-17 07:00:00+00'
   AND t.created_at <  TIMESTAMPTZ '2026-08-17 11:00:00+00'
   AND t.provider_metadata ? 'etherscan'
   AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.token_id = t.id)
   AND NOT EXISTS (
     SELECT 1 FROM holding_transactions x
      WHERE t.id IN (x.token_id, x.counter_token_id, x.fee_token_id,
                     x.price_native_token_id, x.counter_price_native_token_id))
   AND NOT EXISTS (SELECT 1 FROM token_prices p WHERE t.id IN (p.token_id, p.base_token_id))
   AND NOT EXISTS (
     SELECT 1 FROM token_price_edit_history e WHERE t.id IN (e.token_id, e.base_token_id))
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.base_currency_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.currency_token_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM portfolio_value_daily d WHERE d.base_currency_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM vaults v WHERE v.currency_id = t.id);

-- Postconditions. Vacuously true on a database that held none of this.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM holding_transactions WHERE quantity::numeric = 0 AND source = 'etherscan';
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-348: % zero-quantity etherscan rows survived the delete', n;
  END IF;

  -- Nothing that moved may have been taken with them. Every surviving
  -- `transfer_review` answer sits on a row with a nonzero quantity, which is
  -- the only kind that realizes anything.
  SELECT count(*) INTO n
    FROM holding_transactions
   WHERE source = 'etherscan' AND transfer_review IS NOT NULL AND quantity::numeric = 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-348: % zero-quantity answered rows survived', n;
  END IF;

  SELECT count(*) INTO n
    FROM tokens t
   WHERE t.created_at >= TIMESTAMPTZ '2026-08-17 07:00:00+00'
     AND t.created_at <  TIMESTAMPTZ '2026-08-17 11:00:00+00'
     AND t.provider_metadata ? 'etherscan'
     AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.token_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM holding_transactions x WHERE x.token_id = t.id);
  IF n <> 0 THEN
    RAISE EXCEPTION 'SC-343: % orphan token rows from the re-import survived', n;
  END IF;
END $$;

COMMIT;
