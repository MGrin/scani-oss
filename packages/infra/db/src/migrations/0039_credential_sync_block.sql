-- SC-279. The hourly balance sync had nowhere to record that a provider is
-- actively refusing us, and no way to stop asking.
--
-- IBKR Flex code 1025 is "Too many failed attempts" — a lockout triggered by
-- repeated failure, which our hourly retry then sustains: every attempt is
-- another failed attempt against the counter that has to age out. Between
-- 12:00Z and 16:00Z on 2026-08-15 that ran four times, and the credential row
-- said `import_status=enqueued`, `import_last_error=(none)`,
-- `import_retry_count=0` throughout — a healthy integration to every reader.
--
-- Three columns rather than reusing the `import_*` set, and that separation is
-- load-bearing: `reconcile-pending-credentials` gives up on a credential once
-- `import_retry_count >= MAX_RECONCILE_ATTEMPTS`, so letting an hourly balance
-- failure bump that counter would abandon a later, unrelated import before it
-- had been tried once. The import lifecycle and the sync lifecycle are
-- different facts about the same row.
ALTER TABLE "user_integration_credentials"
  ADD COLUMN IF NOT EXISTS "sync_blocked_until" timestamptz,
  ADD COLUMN IF NOT EXISTS "sync_last_error" text,
  ADD COLUMN IF NOT EXISTS "sync_failure_count" integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN "user_integration_credentials"."sync_blocked_until" IS
  'Set when a provider refuses us with a window attached (SC-279). While in the future the scheduled sync does not touch this credential AT ALL — for a lockout, an attempt is itself the harm.';
COMMENT ON COLUMN "user_integration_credentials"."sync_last_error" IS
  'What the provider said when it last refused a scheduled sync. Distinct from import_last_error, which belongs to the initial import lifecycle.';
COMMENT ON COLUMN "user_integration_credentials"."sync_failure_count" IS
  'Consecutive scheduled-sync failures; reset to 0 on the first success.';

-- Partial index: the sync reads "is this credential currently blocked", and
-- the overwhelming majority of rows are not.
CREATE INDEX IF NOT EXISTS "idx_uic_sync_blocked_until"
  ON "user_integration_credentials" ("sync_blocked_until")
  WHERE "sync_blocked_until" IS NOT NULL;
