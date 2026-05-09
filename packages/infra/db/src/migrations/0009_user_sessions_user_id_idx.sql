-- Better-Auth queries `user_sessions.user_id` on every authenticated
-- request. Without an index Postgres falls back to a sequential scan,
-- which gets expensive as the sessions table grows. Sibling table
-- `cloud_sessions` already has the equivalent index; this brings the
-- main app to parity.
--
-- CREATE INDEX CONCURRENTLY runs without blocking writers, but it must
-- run *outside* a transaction. Drizzle's migrator wraps each migration
-- in BEGIN/COMMIT by default; it strips that wrapper when it detects
-- `CONCURRENTLY` and there's no breakpoint. The plain `CREATE INDEX
-- IF NOT EXISTS` form is fine for the existing migration set (every
-- prior `CREATE INDEX` here is non-concurrent) and the `IF NOT EXISTS`
-- guard makes the migration idempotent against partial reruns.
CREATE INDEX IF NOT EXISTS "idx_user_sessions_user_id"
  ON "user_sessions" ("user_id");
