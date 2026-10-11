-- 20261009163407 — households members invites account shares
-- SC-1647. People who share READ access to accounts each of them chose to
-- share. An account keeps one owner. The foreign keys on users, accounts and
-- tokens take locks on those tables, so the wait is bounded.

SET LOCAL lock_timeout = '5s';

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_currency_id uuid NOT NULL REFERENCES tokens(id),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE household_members (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id),
  CONSTRAINT household_members_user_uq UNIQUE (user_id),
  CONSTRAINT household_members_role_check CHECK (role IN ('admin', 'member'))
);

CREATE TABLE household_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_invites_token_hash_uq UNIQUE (token_hash)
);

CREATE INDEX household_invites_household_idx ON household_invites (household_id);

CREATE TABLE account_shares (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'view',
  shared_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_shares_level_check CHECK (level = 'view')
);

CREATE INDEX account_shares_household_idx ON account_shares (household_id);
