-- 20261001142145 — foundation engine shadow reports
-- Foundation A1, task 13. Where the nightly shadows put what they found: one
-- row per run with its summary, and one row per difference between the engine
-- and today's paths. A match is counted in the summary and never stored. The
-- newest 30 runs of each kind and scope are kept: the repository prunes the
-- older ones in the run's own transaction, and their differences go with them
-- by cascade. `scope` keeps an operator's one-user runs from pruning the
-- nightly history of every user, and has no default: a writer that forgets it
-- must not count as a full run. Purely additive; both tables go at A5 with the
-- paths they compare (D-10).
--
-- A price difference belongs to no user, so `user_id` is nullable; a user's
-- differences go with the user. The holding and tokens a difference names are
-- references, so losing one clears it and leaves the difference standing. A
-- difference that names a holding names its user too, so a user's balances
-- cannot outlive the user by being written without one.
--
-- Every reference is indexed because something walks the table by it: the
-- deletion manifest and the cascade from `users`, and the SET NULL that runs
-- once per deleted holding or token. Partial, because every kind leaves some
-- of them NULL: a price difference carries no user and no holding.

-- Lock waits are bounded. The runner applies every pending migration in one
-- transaction, so this holds until it commits: a deploy queued behind an open
-- transaction fails with 55P03 and is retried, instead of holding every later
-- query on these tables behind it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS engine_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL
    CONSTRAINT engine_shadow_runs_kind_chk CHECK (kind IN ('balance', 'price')),
  as_of TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL
    CONSTRAINT engine_shadow_runs_status_chk CHECK (status IN ('complete', 'failed')),
  scope TEXT NOT NULL
    CONSTRAINT engine_shadow_runs_scope_chk CHECK (scope IN ('all', 'user')),
  summary JSONB NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_engine_shadow_runs_kind_started
  ON engine_shadow_runs (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS engine_shadow_differences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES engine_shadow_runs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  holding_id UUID REFERENCES holdings(id) ON DELETE SET NULL,
  token_id UUID REFERENCES tokens(id) ON DELETE SET NULL,
  base_token_id UUID REFERENCES tokens(id) ON DELETE SET NULL,
  at TIMESTAMPTZ NOT NULL,
  comparator TEXT NOT NULL,
  category TEXT NOT NULL,
  engine_value TEXT,
  legacy_value TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT engine_shadow_differences_holding_has_user_chk
    CHECK (holding_id IS NULL OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_engine_shadow_diffs_run_category
  ON engine_shadow_differences (run_id, category);

CREATE INDEX IF NOT EXISTS idx_engine_shadow_diffs_user_id
  ON engine_shadow_differences (user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engine_shadow_diffs_holding_id
  ON engine_shadow_differences (holding_id) WHERE holding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engine_shadow_diffs_token_id
  ON engine_shadow_differences (token_id) WHERE token_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engine_shadow_diffs_base_token_id
  ON engine_shadow_differences (base_token_id) WHERE base_token_id IS NOT NULL;
