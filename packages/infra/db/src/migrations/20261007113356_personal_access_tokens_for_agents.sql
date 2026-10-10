-- 20261007113356 — personal access tokens for agents
-- SC-1614: a user's own bearer token for the read-only MCP endpoint. Only the
-- SHA-256 of the token is stored. Purely additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  hashed_token TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['portfolio:read']::text[],
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personal_access_tokens_user_live_idx
  ON personal_access_tokens (user_id)
  WHERE revoked_at IS NULL;
