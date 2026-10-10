-- 20261009091400 — user backups
-- SC-1649. One row per stored backup, so deleting the account deletes the
-- object: the deletion manifest echoes `storage_key`, as it does `documents.r2_key`.
-- The foreign key on users takes a lock on users, so the wait is bounded.

SET LOCAL lock_timeout = '5s';

CREATE TABLE user_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  format_version integer NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  record_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_backups_user_created ON user_backups (user_id, created_at DESC);
