-- 20260822150658 — sc544 tokens decimals nullable with a named authority
--
-- `tokens.decimals` was `real NOT NULL DEFAULT 2`, and the default is what made
-- a guess indistinguishable from a fact. Measured read-only against production
-- 2026-08-22: 251 rows, of which 20 carried a number no source had ever
-- produced — 14 equities at 18 from one IBKR import on 2026-05-02, and 6
-- chainless crypto rows at 18 from `typeCode === 'crypto' ? 18 : 2`.
--
-- The other 231 are right, which is why this migration nulls by RULE rather
-- than by list. All 136 fiat rows carry exactly ISO 4217's minor units (0 for
-- JPY/KRW/VND…, 3 for BHD/KWD/…, 2 for the rest). All 83 crypto rows that
-- carry a chain identity were re-derived from the chain the same day —
-- `decimals()` on 72 EVM contracts, `getTokenSupply` on 11 Solana mints — and
-- came back 82 agrees, 0 disagrees, 1 unanswered (native ETH, which has no
-- contract and whose 18 is right).
--
-- `integer`, because it is a count of digits: `decimals()` returns a uint8, and
-- `real` could hold 2.5. Every existing value is whole, so the cast is exact.
ALTER TABLE tokens
  ALTER COLUMN decimals DROP DEFAULT,
  ALTER COLUMN decimals DROP NOT NULL,
  ALTER COLUMN decimals TYPE integer USING decimals::integer;

-- The CHECK was written against `double precision` and has to be replaced
-- rather than left: it still holds, but it reads as though the column were a
-- float. NULL passes a CHECK by definition, so the constraint continues to
-- govern only rows that claim an answer.
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_decimals_nonneg_chk;
ALTER TABLE tokens ADD CONSTRAINT tokens_decimals_nonneg_chk CHECK (decimals >= 0);

-- Which authority produced `decimals`. NULL beside a non-null `decimals` means
-- a legacy row nobody has re-derived — the 231 above, until the weekly
-- token-identity sweep reaches them.
ALTER TABLE tokens ADD COLUMN decimals_source text;

ALTER TABLE tokens ADD CONSTRAINT tokens_decimals_source_chk
  CHECK (decimals_source IS NULL OR decimals_source IN ('chain', 'iso4217', 'protocol', 'user'));

-- A source without a value is the one combination that cannot mean anything:
-- it claims an authority answered and records no answer. The reverse IS
-- meaningful and is deliberately allowed — see the legacy rows above.
ALTER TABLE tokens ADD CONSTRAINT tokens_decimals_source_needs_value_chk
  CHECK (decimals_source IS NULL OR decimals IS NOT NULL);

-- Equities: NULL, and this is the CORRECT value rather than the cautious one.
-- An equity has no on-chain integer, so `decimals` — which MEANS the exponent
-- in `raw / 10^decimals` — does not apply to the asset class at all. A `2`
-- there would encode a broker display convention into a field about on-chain
-- scaling, and IBKR reports fractional shares anyway, so it is false on its
-- own terms. This nulls all 18 equity rows, not only the 14 obviously-wrong
-- 18s: the 4 carrying 2 are no more applicable than the others.
--
-- Safe for the one reader a wrong `decimals` demonstrably burns — an audit
-- re-deriving a quantity from a raw on-chain integer (SC-332). Measured
-- 2026-08-22 with controls in the same batch: 0 of 18 equity rows carry a
-- chain identity (83 crypto rows do), and 0 equity ledger rows carry
-- `raw_payload.value` (691 crypto rows do). That audit's population is
-- `WHERE ht.source = 'etherscan'`; equity ledger rows are `ibkr-api`,
-- `reconciliation-opening` and `user-balance-edit`.
UPDATE tokens t
SET decimals = NULL
FROM token_types tt
WHERE tt.id = t.type_id AND tt.code = 'stock';

-- Chainless crypto: NULL, because no authority in the system answered. This
-- deliberately discards BTC's correct 8 and SOL's correct 9 along with the six
-- wrong 18s — they were correct because somebody knew them, and "somebody knew
-- it" is precisely the authority this ticket exists to stop accepting. Both
-- come straight back on the next sweep from `PROTOCOL_NATIVE_DECIMALS`, which
-- carries the command that establishes each constant.
UPDATE tokens t
SET decimals = NULL
FROM token_types tt
WHERE tt.id = t.type_id
  AND tt.code = 'crypto'
  AND NOT (t.provider_metadata ? 'etherscan' OR t.provider_metadata ? 'solana');
