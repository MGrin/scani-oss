-- 20261007180613 — agent calls log
-- SC-1618: one row per tool call an AI agent makes through /mcp, refused and
-- failed calls included, shown to the user in Settings. Purely additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agent_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  agent_write_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_calls_outcome_check CHECK (outcome IN ('ok', 'error', 'refused'))
);

CREATE INDEX IF NOT EXISTS agent_calls_user_created_idx
  ON agent_calls (user_id, created_at);
