-- Track per-token pricing attempts so the nightly historical-price-backfill
-- can skip tokens that no provider ever covers (obscure SPL meme tokens,
-- low-liquidity custom tokens, etc.). Without this, every nightly run
-- re-attempts ~10K (token,day) lookups for tokens that will never resolve,
-- burning provider rate limit and worker time.
--
-- `unpriceable_until` set to NOW() + cooldown when a backfill range comes
-- back entirely empty for a token; cleared on the next successful price
-- write. `last_pricing_attempt_at` is purely diagnostic.
ALTER TABLE "tokens" ADD COLUMN "unpriceable_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "last_pricing_attempt_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "idx_tokens_unpriceable_until" ON "tokens" ("unpriceable_until");
