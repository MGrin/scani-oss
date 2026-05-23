-- Generalized stock-token deduplication.
--
-- Migration 0004 hardcoded six symbols (AAPL/MSFT/NVDA/AMZN/PLTR/VOO),
-- which left FXI/ORCL/TSLA/XEQT and any future cases untouched. Prod
-- evidence (2026-05-07) confirmed all four still had the (stock, NULL)
-- canonical + (crypto, segment) duplicate split — the IBKR balance
-- sync wrote to the canonical, the IBKR tx import created the
-- duplicate. The user saw "multiple XEQT holdings with 0 values" on
-- the IBKR portfolio because of this.
--
-- This migration finds every (symbol, type=stock, segment=NULL) row
-- that has a sibling row at the same symbol with a non-null segment
-- (regardless of type), merges the duplicate into the canonical,
-- re-points all FK references, and updates the canonical's segment
-- to whatever the duplicate carried. Idempotent — second run finds
-- no work.

DO $$
DECLARE
  stock_type_id uuid;
  rec RECORD;
  holding_pair RECORD;
BEGIN
  SELECT id INTO stock_type_id FROM token_types WHERE code = 'stock';
  IF stock_type_id IS NULL THEN
    RAISE NOTICE 'token_types not seeded; skipping generalized stock dedup';
    RETURN;
  END IF;

  -- Iterate every (canonical, duplicate) pair where:
  --   * canonical = (symbol, type=stock, segment=NULL)
  --   * duplicate = (symbol, ANY type, segment IS NOT NULL)
  -- A symbol can have multiple duplicates (different segments); the
  -- loop processes one at a time and re-evaluates after each merge.
  LOOP
    SELECT
      canonical.id        AS canonical_id,
      canonical.symbol    AS symbol,
      duplicate.id        AS duplicate_id,
      duplicate.market_segment AS dup_segment
    INTO rec
    FROM tokens canonical
    JOIN tokens duplicate
      ON duplicate.symbol = canonical.symbol
     AND duplicate.id != canonical.id
     AND duplicate.market_segment IS NOT NULL
    WHERE canonical.type_id = stock_type_id
      AND canonical.market_segment IS NULL
    ORDER BY canonical.symbol, duplicate.market_segment
    LIMIT 1;

    EXIT WHEN rec IS NULL;

    -- Merge holding_transactions FK refs first; ON DELETE for these is
    -- RESTRICT or NO ACTION so we have to migrate before deleting.
    UPDATE holding_transactions SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;
    UPDATE holding_transactions SET counter_token_id = rec.canonical_id WHERE counter_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET fee_token_id = rec.canonical_id WHERE fee_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET price_native_token_id = rec.canonical_id WHERE price_native_token_id = rec.duplicate_id;
    UPDATE holding_transactions SET counter_price_native_token_id = rec.canonical_id WHERE counter_price_native_token_id = rec.duplicate_id;

    -- Holdings: per (user, account) one canonical holding wins. Move
    -- every dependent FK from the duplicate's holdings to the canonical.
    -- Most duplicates have bal=0 + opening_balance=-N (synthesized when
    -- the import couldn't reach back to before the user's trades), so
    -- the canonical's real balance is what survives.
    FOR holding_pair IN
      SELECT canonical_h.id AS canonical_hid, duplicate_h.id AS duplicate_hid
      FROM holdings duplicate_h
      JOIN holdings canonical_h
        ON canonical_h.user_id = duplicate_h.user_id
       AND canonical_h.account_id = duplicate_h.account_id
       AND canonical_h.token_id = rec.canonical_id
      WHERE duplicate_h.token_id = rec.duplicate_id
    LOOP
      UPDATE holding_transactions SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      UPDATE holding_balance_observations SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      UPDATE holding_coverage SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      UPDATE holding_groups SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      UPDATE vault_holdings SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      UPDATE holding_apy_configs SET holding_id = holding_pair.canonical_hid WHERE holding_id = holding_pair.duplicate_hid;
      DELETE FROM holdings WHERE id = holding_pair.duplicate_hid;
    END LOOP;

    -- Edge case: the duplicate has a holding the canonical doesn't —
    -- happens when the canonical was never linked to that account.
    -- Re-point the orphan duplicate-holdings to the canonical token
    -- so balance carries through.
    UPDATE holdings SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;

    -- Drop the duplicate's price rows. The canonical row's prices
    -- (now or after the next backfill) cover the same series.
    DELETE FROM token_prices WHERE token_id = rec.duplicate_id;
    DELETE FROM token_prices WHERE base_token_id = rec.duplicate_id;
    DELETE FROM token_price_edit_history WHERE token_id = rec.duplicate_id OR base_token_id = rec.duplicate_id;

    DELETE FROM tokens WHERE id = rec.duplicate_id;

    -- Promote the canonical's segment to whatever the duplicate had,
    -- so the next IBKR import's tuple lookup hits this row instead
    -- of creating a fresh (stock, segment) sibling. NULL → 'US' / 'TO' / 'L'.
    UPDATE tokens SET market_segment = rec.dup_segment WHERE id = rec.canonical_id;

    RAISE NOTICE 'merged stock duplicate: % (segment=%)', rec.symbol, rec.dup_segment;
  END LOOP;
END;
$$;
