-- 20261004084212 — token prices price is a positive decimal
-- Foundation A3, task 6. `token_prices.price` is text, so until now a bad
-- price could be kept out only by every writer agreeing. The column now
-- refuses a text that is not plain decimal notation (at most 64 digits either
-- side of the point, an optional exponent of at most three), positive and
-- finite. `PriceWriter` drops exactly
-- what this refuses: it sends a text only when it matches
-- `CANONICAL_PRICE_TEXT` (engine/price-index.ts), which is the pattern below
-- character for character (asserted in PriceWriter.test.ts), and the engine
-- reads it as a positive number.
--
-- The pattern turns away what Postgres and decimal.js read differently:
-- padding (' 1.5' is a valid numeric), NaN, Infinity, a sign, hex, octal and
-- binary with or without an underscore, and digit separators. Positivity is
-- judged only after the pattern matched: AND does not promise to short-circuit,
-- and a cast of a text the pattern refused could raise instead of refusing.
-- Every part is bounded so the cast cannot overflow numeric: a longer text is
-- a clean 23514, never a 22003 that fails the whole statement.
--
-- Production, read-only, 2026-10-04T08:0xZ: 71,963 rows, all plain decimal
-- but 2 in the shape 9.9e-9 (defillama_historical, downsample-daily), and the
-- longest is 24 characters. All pass and none is rewritten. Precondition, read immediately before this
-- runs; it must be 0, or VALIDATE fails with 23514 and the deploy with it:
--   SELECT count(*) FROM token_prices
--    WHERE NOT (CASE WHEN price ~ '^[0-9]{1,64}(\.[0-9]{1,64})?([eE][-+]?[0-9]{1,3})?$'
--                    THEN price::numeric > 0 ELSE false END);
--
-- NOT VALID then VALIDATE, as the runner applies every pending migration in
-- one transaction: the ACCESS EXCLUSIVE lock ADD CONSTRAINT takes is held
-- through the validating scan either way. That scan reads one 56 MB table.

-- Lock waits are bounded. A deploy queued behind an open transaction fails
-- with 55P03 and is retried, instead of holding every later query on this
-- table behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE token_prices
  ADD CONSTRAINT token_prices_price_positive_decimal_chk CHECK (
    CASE WHEN price ~ '^[0-9]{1,64}(\.[0-9]{1,64})?([eE][-+]?[0-9]{1,3})?$'
      THEN price::numeric > 0
      ELSE false
    END
  ) NOT VALID;

ALTER TABLE token_prices VALIDATE CONSTRAINT token_prices_price_positive_decimal_chk;
