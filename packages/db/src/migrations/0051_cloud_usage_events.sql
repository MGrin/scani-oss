-- Append-only per-request usage log for Tier 2/3 (cloud-frontend / metering).
-- Replaces external OpenMeter: the data-provider writes rows here and the
-- `/usage` tRPC procedures aggregate in SQL. No third-party meter SaaS.
--
-- `subject` is the billable entity (OpenMeter "subject" equivalent): for Tier
-- 2 this is the `cloud_users.id` string.

CREATE TABLE "cloud_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject" text NOT NULL,
  "api_key_id" text,
  "tenant_id" text,
  "request_id" text,
  "route" text NOT NULL,
  "provider" text NOT NULL,
  "outcome" text NOT NULL,
  "status_code" integer,
  "duration_ms" integer NOT NULL,
  "tokens_in" integer,
  "tokens_out" integer,
  "bytes_in" integer,
  "bytes_out" integer,
  "upstream_cost_usd" double precision,
  "error_code" text,
  "metadata" jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "cloud_usage_events_subject_occurred_at_idx" ON "cloud_usage_events" ("subject", "occurred_at" DESC);
