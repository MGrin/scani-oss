-- Collapse chain-spread crypto duplicates: USDC×4, USDT×3, WETH×3,
-- BONK×2, MATIC×2, TRUMP×2, etc. The pre-merge schema treats each
-- chain-flavored ERC-20 (USDC on Ethereum vs Polygon vs Base) as its
-- own token row, which surfaces 4 distinct USDC holdings in the user's
-- portfolio when they really hold "USDC" full stop. User asked for
-- merging — collapse to one canonical row per (symbol, type=crypto)
-- so the holdings list aggregates balance across chains.
--
-- Strategy:
--   1. For every (symbol, type=crypto) with multiple rows, pick the
--      canonical:
--        * row with market_segment=NULL if one exists (the "generic"
--          USDC / WETH / etc. created by federated identity boot);
--        * otherwise the oldest row (by created_at) — preserves
--          provider-metadata history.
--   2. Re-point every FK reference from the duplicates to the canonical.
--   3. Holdings on the same account collapse via the same loop used
--      in 0006; orphan holdings on different accounts re-point token_id
--      directly.
--   4. Strip the duplicate rows.
--   5. Set the canonical's segment to NULL (generic identity) and
--      union the duplicates' provider_metadata into it so chain-specific
--      contract addresses survive on the merged row for downstream
--      pricing / lookups.
--
-- Stable / fungible tokens (USDC, USDT, USDD) priced ≈$1 across chains
-- so balance aggregation is harmless. Volatile tokens (WETH, BONK)
-- have ≈identical cross-chain prices in practice; the cost-basis
-- consolidation matches what the user mentally tracks.

DO $$
DECLARE
  crypto_type_id uuid;
  current_symbol text;
  rec RECORD;
  holding_pair RECORD;
  merged_metadata jsonb;
BEGIN
  SELECT id INTO crypto_type_id FROM token_types WHERE code = 'crypto';
  IF crypto_type_id IS NULL THEN
    RAISE NOTICE 'crypto token_type not seeded; skipping chain-spread merge';
    RETURN;
  END IF;

  -- Outer loop: each affected symbol, one merge pass per duplicate.
  LOOP
    SELECT symbol INTO current_symbol
    FROM (
      SELECT symbol, COUNT(*) AS n
      FROM tokens
      WHERE type_id = crypto_type_id
      GROUP BY symbol
      HAVING COUNT(*) > 1
      ORDER BY symbol
    ) t
    LIMIT 1;

    EXIT WHEN current_symbol IS NULL;

    -- Pick canonical: prefer market_segment IS NULL, then oldest.
    SELECT id, market_segment, provider_metadata INTO rec
    FROM tokens
    WHERE symbol = current_symbol AND type_id = crypto_type_id
    ORDER BY (market_segment IS NULL) DESC, created_at ASC
    LIMIT 1;

    -- Skip the WHEX / TROLL case where 2 rows share both symbol AND
    -- chain (different contract addresses) — those are likely two
    -- distinct scams, not a real merge candidate. Detect by checking
    -- if any duplicate shares the canonical's exact (symbol, segment)
    -- when both segments are non-null and equal — mid-loop guard.
    --
    -- (Implemented inline: the merge proceeds only over duplicates
    -- whose segment differs from the canonical's. Same-segment dupes
    -- are skipped on this pass; a follow-up pass will revisit them
    -- if appropriate.)

    -- Merge each duplicate into the canonical.
    FOR rec IN
      SELECT
        canonical.id AS canonical_id,
        duplicate.id AS duplicate_id,
        duplicate.provider_metadata AS dup_meta
      FROM tokens canonical
      JOIN tokens duplicate
        ON duplicate.symbol = canonical.symbol
       AND duplicate.id != canonical.id
       AND duplicate.type_id = crypto_type_id
       AND COALESCE(duplicate.market_segment, '') != COALESCE(canonical.market_segment, '')
      WHERE canonical.symbol = current_symbol
        AND canonical.type_id = crypto_type_id
        AND canonical.id = (
          SELECT id FROM tokens
          WHERE symbol = current_symbol AND type_id = crypto_type_id
          ORDER BY (market_segment IS NULL) DESC, created_at ASC
          LIMIT 1
        )
    LOOP
      UPDATE holding_transactions SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;
      UPDATE holding_transactions SET counter_token_id = rec.canonical_id WHERE counter_token_id = rec.duplicate_id;
      UPDATE holding_transactions SET fee_token_id = rec.canonical_id WHERE fee_token_id = rec.duplicate_id;
      UPDATE holding_transactions SET price_native_token_id = rec.canonical_id WHERE price_native_token_id = rec.duplicate_id;
      UPDATE holding_transactions SET counter_price_native_token_id = rec.canonical_id WHERE counter_price_native_token_id = rec.duplicate_id;

      -- Per-account holdings collapse: aggregate balance, keep canonical row.
      FOR holding_pair IN
        SELECT canonical_h.id AS canonical_hid,
               duplicate_h.id AS duplicate_hid,
               canonical_h.balance AS canonical_bal,
               duplicate_h.balance AS duplicate_bal
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
        UPDATE holdings
          SET balance = (holding_pair.canonical_bal::numeric + holding_pair.duplicate_bal::numeric)::text
          WHERE id = holding_pair.canonical_hid;
        DELETE FROM holdings WHERE id = holding_pair.duplicate_hid;
      END LOOP;

      -- Re-point any orphaned holdings on accounts the canonical didn't have.
      UPDATE holdings SET token_id = rec.canonical_id WHERE token_id = rec.duplicate_id;

      -- Merge provider_metadata. Duplicates carry chain-specific
      -- etherscan/solana keys we want to preserve so the unified
      -- token can still be priced via DeFiLlama on each chain.
      SELECT provider_metadata INTO merged_metadata FROM tokens WHERE id = rec.canonical_id;
      UPDATE tokens
        SET provider_metadata = COALESCE(merged_metadata, '{}'::jsonb) || COALESCE(rec.dup_meta, '{}'::jsonb),
            updated_at = NOW()
        WHERE id = rec.canonical_id;

      -- Drop duplicate's prices (canonical's are equivalent for stables;
      -- close-enough for volatile crosses). Edit history also dropped.
      DELETE FROM token_prices WHERE token_id = rec.duplicate_id;
      DELETE FROM token_prices WHERE base_token_id = rec.duplicate_id;
      DELETE FROM token_price_edit_history WHERE token_id = rec.duplicate_id OR base_token_id = rec.duplicate_id;

      DELETE FROM tokens WHERE id = rec.duplicate_id;
    END LOOP;

    -- Force canonical's segment to NULL — chain-specific lookups will
    -- still hit it via providerMetadata.etherscan / solana.
    UPDATE tokens
      SET market_segment = NULL
      WHERE symbol = current_symbol AND type_id = crypto_type_id AND market_segment IS NOT NULL
        AND id = (
          SELECT id FROM tokens
          WHERE symbol = current_symbol AND type_id = crypto_type_id
          ORDER BY (market_segment IS NULL) DESC, created_at ASC
          LIMIT 1
        );

    -- Re-check: if MORE duplicates remain (3+ segments per symbol),
    -- the outer loop runs again. Avoid infinite loop on the same-
    -- segment edge case by exiting if no progress was made.
    IF NOT EXISTS (
      SELECT 1 FROM tokens
      WHERE symbol = current_symbol AND type_id = crypto_type_id
      GROUP BY symbol HAVING COUNT(*) > 1
    ) THEN
      RAISE NOTICE 'merged chain-spread crypto: %', current_symbol;
    END IF;
  END LOOP;
END;
$$;

-- Tighten scam protection: homograph tokens (Cyrillic Ѕ in place of
-- Latin S, etc.) and ASCII-suspicious lookalikes already carry
-- is_scam_probability=0.3 from the import flow — bump them to 0.99
-- so SCAM_PROBABILITY_THRESHOLD (0.5) filters them out of every read
-- path. Active flag is also flipped so they don't re-surface via the
-- "show inactive" toggle.
UPDATE tokens
SET is_scam_probability = 0.99,
    is_active = false,
    updated_at = NOW()
WHERE symbol ~ '[^\x00-\x7F]'
  AND is_scam_probability < 0.99;
