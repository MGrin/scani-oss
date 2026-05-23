-- Add scope_kind + scope_id to portfolio_value_daily so the same
-- table holds user-wide rollups plus per-institution / per-account /
-- per-holding scoped series for the detail-page charts.
--
-- scope_id is non-null and defaults to user_id for existing
-- (user-wide) rows — Postgres composite PKs treat NULL as
-- not-equal-to-NULL, so a non-null sentinel keeps the unique
-- constraint usable.
ALTER TABLE "portfolio_value_daily"
  ADD COLUMN "scope_kind" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily"
  ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
UPDATE "portfolio_value_daily" SET "scope_id" = "user_id" WHERE "scope_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily"
  ALTER COLUMN "scope_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily"
  DROP CONSTRAINT "portfolio_value_daily_user_id_snapshot_date_base_currency_id_pk";
--> statement-breakpoint
ALTER TABLE "portfolio_value_daily"
  ADD CONSTRAINT "portfolio_value_daily_user_id_scope_kind_scope_id_snapshot_date_base_currency_id_pk"
  PRIMARY KEY ("user_id", "scope_kind", "scope_id", "snapshot_date", "base_currency_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pvd_scope_user_date"
  ON "portfolio_value_daily" ("user_id", "scope_kind", "scope_id", "snapshot_date" DESC);
