-- SC-518. Backs `PostgresResourceLock`, which replaces `RedisResourceLock`.
--
-- Deliberately a table with an expiry column rather than `pg_advisory_lock`,
-- even though this repo already has that pattern in `worker/src/lib/cron-lock.ts`.
-- An advisory lock has no TTL: it is held until the session releases it or the
-- connection dies. The Redis lock this replaces is `SET key NX PX ttlMs`, which
-- expires on its own schedule whether or not the holder is alive.
--
-- That difference is the case the lock exists for. A worker that HANGS rather
-- than crashes keeps a healthy connection, so it would hold an advisory lock
-- forever — and since `holding-price-update` skips when the lock is taken, that
-- holding would silently never refresh again. The TTL is the safety property,
-- not an implementation detail, so it survives the port.
CREATE TABLE IF NOT EXISTS queue_resource_locks (
  resource_key text PRIMARY KEY,
  expires_at   timestamptz NOT NULL
);

-- Sweep support. Rows are deleted on release and overwritten on expiry, so this
-- table stays tiny in the normal case; the index is for the reaper that removes
-- keys whose holder died and which nothing ever asks for again.
CREATE INDEX IF NOT EXISTS queue_resource_locks_expires_at_idx
  ON queue_resource_locks (expires_at);
