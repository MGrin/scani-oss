-- SC-1116 — a custom token's decimals says who answered it.

-- `decimals_source` exists so a later reader knows whom to believe when a
-- chain and an import disagree, and `user` is documented as the answer for
-- "a custom token its owner created. There is no chain and no standard for
-- one, so its owner is the only authority there can be."
--
-- Three code paths create a custom token and two of them already attribute:
-- `TokenService.createPrivateToken` and `TokenService.findOrCreateToken` both
-- spread `attributeDecimals(data.decimals, 'user')`. The third —
-- `TokenPriceHistoryService.createCustomToken`, which is the one behind the
-- custom-token sheet — wrote the number and left the source NULL. That is
-- fixed in the same change; this backfills the rows it already produced.
--
-- ## Why the rows cannot be left alone
--
-- NULL here is not "unknown provenance" in any useful sense. It is
-- indistinguishable from a row that predates the column, so anything later
-- reasoning "NULL means nobody ever asked" is wrong about exactly the case
-- where somebody did — the one asset class whose answer is knowable.
--
-- ## Scope, and why it cannot reach a row it should not
--
-- Restricted to `private-company` / `other` types, which is the definition of
-- a custom token in this schema (`TokenService.isCustomTokenType`). Those types
-- have no chain, no ISO 4217 minor unit and no protocol constant, so `user` is
-- the ONLY source that could ever have applied to them — there is no row here
-- whose real authority was something else and is being overwritten with a
-- wrong one.
--
-- `decimals IS NOT NULL` is the other half and is load-bearing: a row with no
-- decimals has nothing to attribute, and writing a source beside an absent
-- value is the exact shape `attributeDecimals` refuses in code. Both halves,
-- or this claims an authority for an answer nobody gave.
--
-- `decimals_source IS NULL` keeps it idempotent and stops it rewriting a
-- source some future path set deliberately.
UPDATE tokens
SET decimals_source = 'user'
WHERE decimals IS NOT NULL
  AND decimals_source IS NULL
  AND type_id IN (
    SELECT id FROM token_types WHERE code IN ('private-company', 'other')
  );
