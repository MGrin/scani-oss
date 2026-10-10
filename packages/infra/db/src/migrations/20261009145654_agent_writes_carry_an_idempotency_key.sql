-- 20261009145654 — agent writes carry an idempotency key
-- SC-1648. A REST client retries a write whose answer it lost. The key it
-- sent is claimed on the journal row when the write starts, so the retry
-- finds that row and writes nothing. Scoped to the token (`actor`): two
-- clients of one user may pick the same key.
-- ADD COLUMN and CREATE INDEX both lock agent_writes, so the wait is bounded.

SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_writes ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX agent_writes_idempotency_key_idx
  ON agent_writes (user_id, actor, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
