-- Per-scheduled-job heartbeat table.
--
-- Round-3 production-readiness pass: scheduled jobs (pricing, wallet
-- balances, exchange balances, apy-payouts, …) currently rely on BullMQ
-- to fire them on schedule. If a worker crashes mid-deploy, or the
-- advisory lock collides repeatedly, a job can silently stop running for
-- hours with no signal to the team. This table records each successful
-- run plus the most recent failure, and the heartbeat-probe scheduled
-- job (registered separately in @scani/jobs) compares `last_success_at`
-- against the expected interval and pages via Sentry when the gap
-- exceeds tolerance.
--
-- Single row per job_name keyed on PRIMARY KEY; updates are upserts.

CREATE TABLE IF NOT EXISTS job_heartbeats (
  job_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_duration_ms INTEGER,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
