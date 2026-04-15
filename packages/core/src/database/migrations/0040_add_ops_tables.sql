-- Operational tables added for production readiness:
--   * sync_failures — persistent record of cron sync failures so operators can
--     query stuck wallets/exchanges without tailing logs.
--   * client_errors — server-side log of errors captured by the frontend
--     ErrorBoundary. Minimal columns, no PII.
--
-- Both tables are idempotent: the cron runner upserts into sync_failures and
-- the frontend client_errors endpoint appends with a server-generated id.

CREATE TABLE IF NOT EXISTS "sync_failures" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "kind" text NOT NULL,
    "target_id" text NOT NULL,
    "failure_count" integer DEFAULT 0 NOT NULL,
    "last_error" text,
    "last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
    "first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
    "metadata" jsonb,
    CONSTRAINT "sync_failures_kind_target_uq" UNIQUE ("kind", "target_id")
);

CREATE INDEX IF NOT EXISTS "sync_failures_kind_idx" ON "sync_failures" ("kind");
CREATE INDEX IF NOT EXISTS "sync_failures_failure_count_idx" ON "sync_failures" ("failure_count");

CREATE TABLE IF NOT EXISTS "client_errors" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid,
    "route" text,
    "message" text NOT NULL,
    "stack" text,
    "component_stack" text,
    "user_agent" text,
    "app_version" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "client_errors_created_at_idx" ON "client_errors" ("created_at");
CREATE INDEX IF NOT EXISTS "client_errors_user_id_idx" ON "client_errors" ("user_id");
