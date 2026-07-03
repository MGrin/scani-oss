-- Operator-entered actual monthly bills for the admin Spend page.
-- Previously an Upstash Redis hash (`admin:spend:overrides`); moved to
-- Postgres when the Upstash database was retired (2026-07 cost
-- reduction). One row per (period, provider); durable, never expires.
CREATE TABLE IF NOT EXISTS "admin_spend_overrides" (
	"period" text NOT NULL,
	"provider" text NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"note" text,
	"actor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_spend_overrides_period_provider_pk" PRIMARY KEY("period","provider")
);
