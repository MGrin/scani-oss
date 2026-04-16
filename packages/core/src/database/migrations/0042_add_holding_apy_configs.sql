-- APY configuration for holdings in checking/savings/investment accounts.
-- One config per holding (enforced by UNIQUE on holding_id).
-- The cron job queries this table to find due payouts.

CREATE TABLE "holding_apy_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id") ON DELETE CASCADE,
  "annual_rate_pct" text NOT NULL,
  "payout_frequency" text NOT NULL,
  "payout_day_of_week" real,
  "payout_day_of_month" real,
  "payout_month" real,
  "last_payout_at" timestamp with time zone,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "holding_apy_configs_holding_id_unique" UNIQUE("holding_id")
);

CREATE INDEX "idx_holding_apy_configs_holding_id" ON "holding_apy_configs" ("holding_id");
CREATE INDEX "idx_holding_apy_configs_active" ON "holding_apy_configs" ("is_active") WHERE "is_active" = true;
