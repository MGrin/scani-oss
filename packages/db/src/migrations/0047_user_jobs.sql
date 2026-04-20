-- Durable mirror of user-initiated BullMQ jobs.
--
-- BullMQ retains at most `removeOnComplete`/`removeOnFail` entries per family,
-- so long-running instances lose job history the user can still want to look
-- at (e.g. "what did that wallet import six months ago pull in?"). This table
-- is written row-first by the backend's enqueue wrapper and updated on every
-- lifecycle transition by the worker, so the UI has a durable source for:
--   - the top-nav "active jobs" badge (partial index on in-flight states)
--   - the /jobs list page
--   - the /jobs/:jobId detail page, including the per-type review body
-- and survives both `flyctl deploy --strategy immediate` and any Redis wipe.

DO $$ BEGIN
  CREATE TYPE user_job_state AS ENUM (
    'queued',
    'active',
    'progress',
    'completed',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_jobs (
  job_id           text PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_name         text NOT NULL,
  state            user_job_state NOT NULL DEFAULT 'queued',
  progress         real NOT NULL DEFAULT 0,
  result           jsonb,
  error            text,
  attempts_made    integer NOT NULL DEFAULT 0,
  attempts_allowed integer NOT NULL DEFAULT 1,
  payload_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  started_at       timestamp with time zone,
  finished_at      timestamp with time zone,
  updated_at       timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_jobs_user_created
  ON user_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_jobs_user_state_created
  ON user_jobs (user_id, state, created_at DESC);

-- Partial index powers the nav badge — `SELECT count(*) ... WHERE user_id=$1
-- AND state IN ('queued','active','progress')` stays O(log n) even as
-- completed rows accumulate.
CREATE INDEX IF NOT EXISTS idx_user_jobs_active
  ON user_jobs (user_id)
  WHERE state IN ('queued', 'active', 'progress');
