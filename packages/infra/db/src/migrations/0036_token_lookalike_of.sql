-- SC-197. Tokens whose SYMBOL is built from lookalike characters — `UЅDС`
-- with a Cyrillic Ѕ and С renders as `USDC` and is a different string.
***REMOVED***
***REMOVED***
--
-- The column holds the ASCII symbol the token PRESENTS AS, so a reader
-- (or a UI) can say what it is impersonating rather than only that it is
-- odd. NULL means the symbol is plain ASCII and reads as itself.
--
-- Not folded into `is_scam_probability`: that column's 0.3 bucket
-- contains USDT, so it cannot carry a decision.
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "lookalike_of" text;

-- Partial index: the interesting set is the small non-null one, and every
-- consumer asks "which tokens are impersonating something".
CREATE INDEX IF NOT EXISTS "idx_tokens_lookalike_of"
  ON "tokens" ("lookalike_of") WHERE "lookalike_of" IS NOT NULL;
