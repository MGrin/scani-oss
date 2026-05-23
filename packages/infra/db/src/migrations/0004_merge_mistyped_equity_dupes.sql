-- Repair the duplicate-token mess introduced when IBKR transaction imports
-- ran through `TransactionRouter` before per-leg `tokenType` hints
-- existed. Each affected equity has TWO rows in `tokens`:
--
--   * The canonical (symbol, type=stock, market_segment=NULL) created by
--     the holdings-balance sync (which correctly sets `tokenType: 'stock'`).
--   * A duplicate (symbol, type=crypto, market_segment='US') created by
--     the IBKR Flex transactions import — the router defaulted to the
--     'crypto' tokenType because `TransactionEvent` carried no per-leg
--     hint. The duplicate's `market_segment='US'` came from
--     `mapListingExchangeToSegment('NASDAQ')`.
--
-- Net effect: holdings.balance lives on the stock row, transactions live
-- on the crypto row. Cost basis is split, the chart's "priced" coverage
-- ratio drops, and after commit 722f24be's "stop Yahoo pricing crypto"
-- guard, Yahoo gets dropped for the crypto row → those equities go
-- entirely unpriced. This migration merges each pair and updates the
-- canonical row's `market_segment` to 'US' so future IBKR imports match
-- it instead of re-creating the crypto sibling.
--
-- ARB is intentionally left alone — both interpretations exist (Arbitrum
-- the L2 token vs ARB the equity), and the user holds it as Arbitrum.
-- The polluted Yahoo `_historical` rows for ARB (priced as the equity)
-- are deleted at the end so they stop corrupting the crypto chart.

DO $$
DECLARE
  stock_type_id uuid;
  crypto_type_id uuid;
  affected_symbol text;
  canonical_token_id uuid;
  duplicate_token_id uuid;
  canonical_holding_id uuid;
  duplicate_holding_id uuid;
BEGIN
  SELECT id INTO stock_type_id FROM token_types WHERE code = 'stock';
  SELECT id INTO crypto_type_id FROM token_types WHERE code = 'crypto';

  IF stock_type_id IS NULL OR crypto_type_id IS NULL THEN
    RAISE NOTICE 'token_types not seeded; skipping equity dedup migration';
    RETURN;
  END IF;

  FOREACH affected_symbol IN ARRAY ARRAY['AAPL','MSFT','NVDA','AMZN','PLTR','VOO']
  LOOP
    SELECT id INTO canonical_token_id
    FROM tokens
    WHERE symbol = affected_symbol AND type_id = stock_type_id AND market_segment IS NULL
    LIMIT 1;

    SELECT id INTO duplicate_token_id
    FROM tokens
    WHERE symbol = affected_symbol AND type_id = crypto_type_id AND market_segment = 'US'
    LIMIT 1;

    IF canonical_token_id IS NULL OR duplicate_token_id IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE holding_transactions SET token_id = canonical_token_id WHERE token_id = duplicate_token_id;
    UPDATE holding_transactions SET counter_token_id = canonical_token_id WHERE counter_token_id = duplicate_token_id;
    UPDATE holding_transactions SET fee_token_id = canonical_token_id WHERE fee_token_id = duplicate_token_id;
    UPDATE holding_transactions SET price_native_token_id = canonical_token_id WHERE price_native_token_id = duplicate_token_id;
    UPDATE holding_transactions SET counter_price_native_token_id = canonical_token_id WHERE counter_price_native_token_id = duplicate_token_id;

    FOR canonical_holding_id, duplicate_holding_id IN
      SELECT
        canonical_h.id,
        duplicate_h.id
      FROM holdings duplicate_h
      JOIN holdings canonical_h
        ON canonical_h.user_id = duplicate_h.user_id
        AND canonical_h.account_id = duplicate_h.account_id
        AND canonical_h.token_id = canonical_token_id
      WHERE duplicate_h.token_id = duplicate_token_id
    LOOP
      UPDATE holding_transactions SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      UPDATE holding_balance_observations SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      UPDATE holding_coverage SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      UPDATE holding_groups SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      UPDATE vault_holdings SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      UPDATE holding_apy_configs SET holding_id = canonical_holding_id WHERE holding_id = duplicate_holding_id;
      DELETE FROM holdings WHERE id = duplicate_holding_id;
    END LOOP;

    -- Drop the duplicate's Yahoo price rows: they cover the same dates
    -- the canonical's stock-typed Yahoo rows already cover (1311 vs 1254
    -- in prod sample); the canonical wins on count + correctness.
    DELETE FROM token_prices WHERE token_id = duplicate_token_id;

    DELETE FROM tokens WHERE id = duplicate_token_id;

    UPDATE tokens SET market_segment = 'US' WHERE id = canonical_token_id;
  END LOOP;

  -- ARB-as-equity pollution: drop Yahoo historical rows on the crypto-typed
  -- ARB token. After commit 722f24be's filter, future Yahoo calls for ARB
  -- are skipped anyway; this clears the existing ~1,484 wrong rows so
  -- DeFiLlama becomes the authoritative source for the chart.
  DELETE FROM token_prices
  WHERE token_id IN (
    SELECT id FROM tokens
    WHERE symbol = 'ARB' AND type_id = crypto_type_id
  )
  AND source LIKE 'yahoo%';
END;
$$;
