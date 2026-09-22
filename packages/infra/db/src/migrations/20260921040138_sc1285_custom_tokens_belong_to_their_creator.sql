-- SC-1285 — a custom token belongs to the user who created it.
--
-- Custom tokens (`private-company` / `other`) had no owner, and the api treated
-- them as global: any user could list every other user's private-company names
-- and prices, re-price them, and read the email of whoever edited them. That was
-- exploited on 2026-09-19 (SC-1262). mgrin decided on 2026-09-21 that a custom
-- token is private to its owner.
--
-- ## What this does to existing rows
--
-- 1. Adds `tokens.created_by_user_id`, NULL for every row. Catalog tokens
--    (fiat, crypto, stock, …) keep NULL for good: nobody owns them.
-- 2. Sets it on CUSTOM tokens only, and only where it is NULL, from:
--    a. the user who wrote the token's creation row in
--       `token_price_edit_history` — the `Initial price` row. That row is
--       written in the same transaction as the token, and both `created_at`
--       columns default to `now()`, which is the TRANSACTION's start time, so
--       the creation row is exactly the one whose `created_at` equals the
--       token's. A later edit by somebody else cannot match it — which is the
--       point: on 2026-09-19 a second account edited a token it did not own.
--    b. otherwise, the token's only holder, when exactly one user holds it.
--       Tokens created by `TokenService.createPrivateToken` wrote no history
--       row, so this is the only evidence there is for them.
--    c. otherwise NULL. A custom token with no owner is visible to NOBODY and
--       editable by nobody; it is not deleted and no holding is touched.
-- 3. Scopes symbol uniqueness to the owner. The old unique index on
--    `(symbol, type_id, COALESCE(market_segment, ''))` stays exactly as it was
--    for every row with no owner — the catalog, and any unattributed custom
--    token — and a second index makes `(created_by_user_id, symbol, type_id)`
--    unique for owned ones. Two users may each have their own `ACME`; one user
--    may not have two.
--
-- Nothing else is written: no price, no holding, no history row changes.
-- Idempotent — `IF NOT EXISTS`, and the backfill touches only NULL owners.

ALTER TABLE "tokens"
  ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid
  REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

UPDATE "tokens" AS t
SET "created_by_user_id" = COALESCE(
  (
    SELECT h."edited_by_user_id"
    FROM "token_price_edit_history" AS h
    WHERE h."token_id" = t."id"
      AND h."created_at" = t."created_at"
    ORDER BY h."id"
    LIMIT 1
  ),
  (
    SELECT (array_agg(DISTINCT hd."user_id"))[1]
    FROM "holdings" AS hd
    WHERE hd."token_id" = t."id"
    HAVING count(DISTINCT hd."user_id") = 1
  )
)
WHERE t."created_by_user_id" IS NULL
  AND t."type_id" IN (
    SELECT "id" FROM "token_types" WHERE "code" IN ('private-company', 'other')
  );
--> statement-breakpoint

DROP INDEX IF EXISTS "tokens_symbol_type_segment_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tokens_symbol_type_segment_unique"
  ON "tokens" ("symbol", "type_id", COALESCE("market_segment", ''))
  WHERE "created_by_user_id" IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tokens_owner_symbol_type_unique"
  ON "tokens" ("created_by_user_id", "symbol", "type_id", COALESCE("market_segment", ''))
  WHERE "created_by_user_id" IS NOT NULL;
