-- Add import_status tracking to user_integration_credentials so orphan rows
-- (credentials committed before their import job was enqueued, then lost to
-- a backend crash in the ~100ms gap) can be identified and reconciled.
--
-- Flow:
--   1. Backend stores a row with import_status='pending_enqueue' inside a DB TX.
--   2. After commit, backend calls enqueueImport(...) and stores the jobId on
--      the row with import_status='enqueued'.
--   3. If enqueue throws, backend writes import_status='failed' with last_error.
--   4. A reconciler job in the worker scans for rows stuck in 'pending_enqueue'
--      older than 5 min and either re-enqueues or marks 'failed' after 3 tries.
--
-- All existing rows are backfilled to 'enqueued' — they pre-date this tracking,
-- so we assume their imports have already been handled (or are terminally lost,
-- in which case the reconciler won't touch them because they're not 'pending').

DO $$ BEGIN
  CREATE TYPE credentials_import_status AS ENUM (
    'pending_enqueue',
    'enqueued',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE user_integration_credentials
  ADD COLUMN IF NOT EXISTS import_status credentials_import_status
    NOT NULL DEFAULT 'enqueued',
  ADD COLUMN IF NOT EXISTS import_job_id text,
  ADD COLUMN IF NOT EXISTS import_enqueued_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS import_last_error text,
  ADD COLUMN IF NOT EXISTS import_retry_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_integration_credentials_import_status
  ON user_integration_credentials (import_status, updated_at)
  WHERE import_status <> 'enqueued';
