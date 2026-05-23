-- IBKR segmented-stock token deduplication.
--
-- The IBKR balance import dropped `marketSegment` on the way from the
-- provider snapshot into the federated identity resolver
-- (HoldingSnapshotProjection / TokenService.findOrCreateTokenFromIntegration),
-- so it resolved every stock to a `(symbol, stock, segment=NULL)` token.
-- The IBKR transaction import kept the segment and resolved the same
-- stock to the `(symbol, stock, segment='US'|'TO'|…)` token. Holdings
-- key on token_id, so each stock ended up with two holdings on two
-- token rows — the balance import's real-amount holding on the NULL
-- token and the tx import's 0-amount anchor holding on the segmented
-- token. The code path is fixed; this migration cleans the rows.
--
-- 0006_generalized_stock_dedup handled the inverse split (canonical =
-- NULL, duplicate = segmented) but ran before this regression, so a
-- fresh migration is needed. Here the segmented row is the canonical
-- (it owns the real token_prices history); the NULL row is dropped.
-- Idempotent — a second run finds no pair.

DO $$
DECLARE
  stock_type_id uuid;
  rec RECORD;
  hp RECORD;
  survivor_hid uuid;
  loser_hid uuid;
BEGIN
  SELECT id INTO stock_type_id FROM token_types WHERE code = 'stock';
  IF stock_type_id IS NULL THEN
    RAISE NOTICE 'token_types not seeded; skipping ibkr segment token dedup';
    RETURN;
  END IF;

  -- Each iteration: one (canonical segmented, duplicate NULL) stock pair.
  LOOP
    SELECT
      canonical.id     AS canonical_id,
      duplicate.id     AS duplicate_id,
      canonical.symbol AS symbol
    INTO rec
    FROM tokens duplicate
    JOIN tokens canonical
      ON canonical.symbol = duplicate.symbol
     AND canonical.type_id = stock_type_id
     AND canonical.market_segment IS NOT NULL
     AND canonical.id != duplicate.id
    WHERE duplicate.type_id = stock_type_id
      AND duplicate.market_segment IS NULL
    ORDER BY duplicate.symbol, canonical.market_segment
    LIMIT 1;

    EXIT WHEN rec IS NULL;

    -- Holdings: for every (user, account) holding the same stock on both
    -- tokens, keep the row with the larger |balance| (the real position;
    -- the other is the 0-amount anchor), move dependent FKs onto it, and
    -- re-point it at the canonical token.
    FOR hp IN
      SELECT
        dup_h.id      AS dup_hid,
        can_h.id      AS can_hid,
        dup_h.balance AS dup_bal,
        can_h.balance AS can_bal
      FROM holdings dup_h
      JOIN holdings can_h
        ON can_h.user_id = dup_h.user_id
       AND can_h.account_id = dup_h.account_id
       AND can_h.token_id = rec.canonical_id
      WHERE dup_h.token_id = rec.duplicate_id
    LOOP
      IF abs(coalesce(NULLIF(hp.dup_bal, '')::numeric, 0))
         >= abs(coalesce(NULLIF(hp.can_bal, '')::numeric, 0)) THEN
        survivor_hid := hp.dup_hid;
        loser_hid    := hp.can_hid;
      ELSE
        survivor_hid := hp.can_hid;
        loser_hid    := hp.dup_hid;
      END IF;

      UPDATE holding_transactions SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      UPDATE holding_balance_observations SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      UPDATE holding_coverage SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      UPDATE holding_groups SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      UPDATE vault_holdings SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      UPDATE holding_apy_configs SET holding_id = survivor_hid WHERE holding_id = loser_hid;
      DELETE FROM holdings WHERE id = loser_hid;

      -- Survivor may have been the NULL-token holding — anchor it on the
      -- canonical token so the next token re-point/delete leaves it intact.
      UPDATE holdings SET token_id = rec.canonical_id WHERE id = survivor_hid;
    END LOOP;

    -- Duplicate-token holdings with no canonical counterpart: re-point.
    UPDATE holdings SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;

    -- Token-level FK refs. ON DELETE for the holding_transactions token
    -- columns is SET NULL (migration 0010), but re-point so the history
    -- keeps pointing at the surviving token.
    UPDATE holding_transactions SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;
    UPDATE holding_transactions SET counter_token_id = rec.canonical_id WHERE counter_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET fee_token_id = rec.canonical_id WHERE fee_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET price_native_token_id = rec.canonical_id WHERE price_native_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET counter_price_native_token_id = rec.canonical_id WHERE counter_price_native_token_id = rec.duplicate_id;

    -- Drop the duplicate's price rows; the canonical's series covers it.
    DELETE FROM token_prices WHERE token_id = rec.duplicate_id;
    DELETE FROM token_prices WHERE base_token_id = rec.duplicate_id;
    DELETE FROM token_price_edit_history WHERE token_id = rec.duplicate_id OR base_token_id = rec.duplicate_id;

    DELETE FROM tokens WHERE id = rec.duplicate_id;

    RAISE NOTICE 'merged IBKR NULL-segment stock duplicate into canonical: %', rec.symbol;
  END LOOP;
END;
$$;
