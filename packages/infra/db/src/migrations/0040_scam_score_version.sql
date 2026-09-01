-- SC-286. `is_scam_probability` is computed once, at token creation, and never
-- recomputed — both call sites explicitly refuse pre-existing tokens. So every
-- improvement to the heuristic applies to tokens created afterwards and to
-- nothing else, and the stored number silently becomes a claim no current code
-- would make.
--
-- Measured before the manual repair: a small fraction of existing tokens held
-- a score the shipped function would not produce, and several of those crossed
-- the UI threshold. One was a token whose name ends in "Network", scored 0.80
-- because "Network" starts with "net" — a legitimate holding being subtracted
-- from the portfolio total.
--
-- This column records WHICH version of the function produced the stored value,
-- so a row can be asked whether it is current. Without it the only way to know
-- is to recompute every row and compare, which is the thing we want to avoid
-- doing on a timer.
--
-- NULLABLE, and NULL means "scored before versioning existed" — not version 0.
-- Those rows are stale by definition and the backfill picks them up first.
-- Defaulting to 1 would assert that every existing row was produced by the
-- current function, which is exactly the false claim this ticket is about.
ALTER TABLE "tokens" ADD COLUMN IF NOT EXISTS "scam_score_version" integer;

COMMENT ON COLUMN "tokens"."scam_score_version" IS
  'Version of calculateScamProbability that produced is_scam_probability. NULL = scored before versioning. SC-286.';

-- The backfill asks one question — "which rows are not at the current version"
-- — and at the token counts this table holds that is a sequential scan
-- either way. The index
-- is for the table this becomes, not the table it is.
CREATE INDEX IF NOT EXISTS "idx_tokens_scam_score_version" ON "tokens" ("scam_score_version");

-- The column above is not enough on its own, for two reasons found the hard
-- way — one before review and one during it.
--
-- 1. `tokens.markAsScam` / `tokens.unmarkAsScam`
--    (apps/backend/api/src/presentation/routers/tokens.ts) write a HUMAN
--    verdict into `is_scam_probability` — 1.0 and 0. A recompute that could
--    not tell those from a heuristic score would silently revert a decision a
--    person made on purpose.
--
-- 2. `TokenIdentityService` scores CRYPTO ONLY (see its step 4). Fiat and
--    stock together are a large minority of the table, and every one of those
--    rows holds a 0 the scoring function never produced, because it never ran
--    on them. Defaulting those
--    to `heuristic` would assert that the function stands behind a number it
--    never saw — and the first review of #849 measured what that assertion is
--    worth. Scored as if it were crypto, `AMAZON.COM INC` returns 0.50: a
--    literal dot followed by a three-character TLD. The UI threshold is 0.35,
--    so Amazon would have been badged a scam and dropped out of the portfolio
--    total.
--
-- Hence three values, and `unscored` is the default:
--   unscored  — no verdict exists. Never recomputed, never stamped.
--   heuristic — produced by `calculateScamProbability`, and recomputable.
--   user      — an explicit human verdict. Never recomputed.
--
-- `unscored` as the DEFAULT rather than `heuristic` is the load-bearing
-- choice: a new non-crypto token inserted tomorrow is correct without anyone
-- remembering this rule, and the failure mode of forgetting is a row that
-- never gets recomputed rather than a stock that gets scam-scored.
ALTER TABLE "tokens"
  ADD COLUMN IF NOT EXISTS "scam_score_source" text NOT NULL DEFAULT 'unscored';

COMMENT ON COLUMN "tokens"."scam_score_source" IS
  'unscored = no verdict, the function never ran (all non-crypto); heuristic = produced by calculateScamProbability, recomputable; user = explicit verdict via markAsScam/unmarkAsScam, never recomputed. SC-286.';

-- Existing CRYPTO rows did come from the function, so they are `heuristic` and
-- the backfill will pick them up. Everything else keeps the `unscored`
-- default and never enters the population at all.
UPDATE "tokens" SET "scam_score_source" = 'heuristic'
WHERE "type_id" IN (SELECT "id" FROM "token_types" WHERE "code" = 'crypto');

-- Pre-existing user verdicts carry no record of themselves, and they are not
-- reconstructable from the value: `markAsScam` writes exactly 1.0, but so can
-- the function, and `unmarkAsScam` writes 0, which is what almost every
-- legitimate token scores.
--
-- 1.0 is claimed for `user` because that direction fails safe: the cost is a
-- heuristic 1.0 row that never gets recomputed, versus a user's "this is a
-- scam" being silently undone. (Verified during review: no token sat at
-- exactly 1.0, so this claimed nothing at the time it shipped.)
--
-- Rows at 0 cannot be claimed — that would freeze every legitimate token
-- forever. So one residual survives and is not measurable: a CRYPTO token a
-- user explicitly unmarked before this migration can be re-flagged by the
-- first run. The unmark events are not recoverable — log retention is far
-- shorter than the age of these events, and there is no audit table. It
-- is stated in the PR as a known unmeasurable residual rather than papered
-- over here.
UPDATE "tokens" SET "scam_score_source" = 'user' WHERE "is_scam_probability" = 1.0;
