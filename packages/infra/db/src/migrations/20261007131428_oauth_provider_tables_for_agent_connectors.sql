-- 20261007131428 — oauth provider tables for agent connectors
-- SC-1615: the tables `@better-auth/oauth-provider` needs to make Scani an
-- OAuth 2.1 authorization server for AI clients connecting to /mcp. Tokens and
-- client secrets are stored hashed by the plugin. Purely additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS oauth_client (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  client_discovery_id TEXT,
  disabled BOOLEAN DEFAULT false,
  skip_consent BOOLEAN,
  enable_end_session BOOLEAN,
  subject_type TEXT,
  scopes TEXT[],
  client_credentials_scopes TEXT[] DEFAULT '{}'::text[],
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT[],
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  redirect_uris TEXT[] NOT NULL,
  post_logout_redirect_uris TEXT[],
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required BOOLEAN,
  token_endpoint_auth_method TEXT,
  application_type TEXT,
  jwks TEXT,
  jwks_uri TEXT,
  grant_types TEXT[],
  response_types TEXT[],
  require_pkce BOOLEAN,
  dpop_bound_access_tokens BOOLEAN DEFAULT false,
  reference_id TEXT,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_oauth_client_user_id ON oauth_client (user_id);

CREATE TABLE IF NOT EXISTS oauth_resource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  access_token_ttl INTEGER,
  refresh_token_ttl INTEGER,
  signing_algorithm TEXT,
  signing_key_id TEXT,
  allowed_scopes TEXT[],
  custom_claims JSONB,
  dpop_bound_access_tokens_required BOOLEAN DEFAULT false,
  disabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  policy_version INTEGER DEFAULT 1,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS oauth_client_resource (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES oauth_resource(identifier) ON DELETE CASCADE,
  metadata JSONB,
  created_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_client_resource_client_resource
  ON oauth_client_resource (client_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_oauth_client_resource_resource_id
  ON oauth_client_resource (resource_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES user_sessions(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT[],
  requested_user_info_claims TEXT[],
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ,
  rotation_replay_response TEXT,
  rotation_replay_expires_at TIMESTAMPTZ,
  auth_time TIMESTAMPTZ,
  confirmation JSONB,
  scopes TEXT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_client_id ON oauth_refresh_token (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_user_id ON oauth_refresh_token (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_session_id ON oauth_refresh_token (session_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_authorization_code_id
  ON oauth_refresh_token (authorization_code_id);

CREATE TABLE IF NOT EXISTS oauth_access_token (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES user_sessions(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  authorization_code_id TEXT,
  resources TEXT[],
  requested_user_info_claims TEXT[],
  refresh_id TEXT REFERENCES oauth_refresh_token(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked TIMESTAMPTZ,
  confirmation JSONB,
  scopes TEXT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_client_id ON oauth_access_token (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_user_id ON oauth_access_token (user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_session_id ON oauth_access_token (session_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_authorization_code_id
  ON oauth_access_token (authorization_code_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_token_refresh_id ON oauth_access_token (refresh_id);

CREATE TABLE IF NOT EXISTS oauth_consent (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  reference_id TEXT,
  resources TEXT[],
  requested_user_info_claims TEXT[],
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_client_id ON oauth_consent (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_user_id ON oauth_consent (user_id);

CREATE TABLE IF NOT EXISTS oauth_client_assertion (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
