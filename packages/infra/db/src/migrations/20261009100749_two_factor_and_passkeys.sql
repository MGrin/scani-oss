-- SC-1646: Better-Auth's twoFactor and passkey plugins.
ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE user_two_factors (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX user_two_factors_user_id_idx ON user_two_factors (user_id);
CREATE INDEX user_two_factors_secret_idx ON user_two_factors (secret);

CREATE TABLE user_passkeys (
  id text PRIMARY KEY,
  name text,
  public_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text,
  created_at timestamptz DEFAULT now(),
  aaguid text
);
CREATE INDEX user_passkeys_user_id_idx ON user_passkeys (user_id);
CREATE UNIQUE INDEX user_passkeys_credential_id_idx ON user_passkeys (credential_id);
