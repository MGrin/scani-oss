-- 0014_admin_audit_log_signature.sql
--
-- Adds tamper-evidence to admin_audit_log via an HMAC chain. Each new
-- row stores:
--   * `prev_signature` — the previous row's `signature` (chains the rows)
--   * `signature` — HMAC-SHA256 of the row's logical payload using
--     JOBS_HMAC_SECRET as the key
--
-- Both columns are nullable so existing rows remain valid; the chain
-- starts at the first row written after this migration applies.

ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS prev_signature TEXT;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS signature TEXT;
