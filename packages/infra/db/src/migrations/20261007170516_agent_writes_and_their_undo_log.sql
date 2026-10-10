-- 20261007170516 — agent writes and their undo log
-- SC-1617: every change an AI agent makes through /mcp, with the before and
-- after image of each row it touched, so it can be listed and undone. Purely
-- additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agent_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  tool TEXT NOT NULL,
  input JSONB NOT NULL,
  result JSONB,
  status TEXT NOT NULL,
  change_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ,
  undone_by TEXT,
  CONSTRAINT agent_writes_status_check CHECK (status IN ('applied', 'failed', 'undone'))
);

CREATE INDEX IF NOT EXISTS agent_writes_user_created_idx
  ON agent_writes (user_id, created_at);

CREATE TABLE IF NOT EXISTS agent_write_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  write_id UUID NOT NULL REFERENCES agent_writes(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  before JSONB,
  after JSONB
);

CREATE INDEX IF NOT EXISTS agent_write_changes_write_idx
  ON agent_write_changes (write_id);

CREATE TABLE IF NOT EXISTS agent_write_snapshots (
  write_id UUID NOT NULL REFERENCES agent_writes(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  image JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_write_snapshots_write_table_idx
  ON agent_write_snapshots (write_id, table_name, row_key);

CREATE TABLE IF NOT EXISTS agent_write_locks (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
