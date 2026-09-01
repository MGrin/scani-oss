-- SC-870 — the operator alarm fires on ENTERING a condition, not on every probe
-- that observes it.
--
-- `stale-sync-probe` escalates every hour for as long as any integration is
-- broken, so one unresolved condition can account for the great majority of a
-- service's error volume — and the cost is not the noise. A repeating alarm
-- makes low-frequency signals unreadable: something that fails once a day is
-- outnumbered by something already known and stays unread for as long as the
-- loud condition lasts. A persistent condition manufactures a hiding place, and
-- resolving one instance of it does not stop the next one rebuilding another.
--
-- This table is the ledger that stops it. One row per condition currently OPEN;
-- the row's ABSENCE is how "it cleared" is expressed, which is what lets the
-- same fault alarm a second time if it happens a second time. That is deliberately
-- the same shape `alert_deliveries` already gives the USER-facing half of this
-- exact signal (SC-459) — the operator-facing half is the one that never got it.
--
-- ## Why Postgres and not Redis
--
-- Redis is available and would have been less work. It is also `redis-server`
-- embedded in the worker's own machine, so its lifetime is correlated with the
-- worker's — and a worker restart re-firing every open alarm is exactly the
-- failure this replaces, at a lower frequency. Postgres is a separate failure
-- domain and already holds `job_heartbeats` and `alert_deliveries`.
--
-- Losing this table anyway fails in the safe direction: every open condition is
-- re-stated once, then re-arms. A duplicate alarm, never a missing one.
CREATE TABLE IF NOT EXISTS operator_alarms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alarm         text NOT NULL,
  alarm_key     text NOT NULL,
  opened_at     timestamptz NOT NULL,
  last_fired_at timestamptz NOT NULL
);

-- Load-bearing, not a lookup index. The sweep opens conditions with a single
-- `INSERT … ON CONFLICT (alarm, alarm_key) DO UPDATE … WHERE`, so this index is
-- what makes "is it already open?" and "open it" one atomic statement rather
-- than a read the next probe could interleave with.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_alarms_identity
  ON operator_alarms (alarm, alarm_key);

COMMENT ON COLUMN operator_alarms.alarm IS
  'The named alarm, e.g. stale-sync. Part of the stored contract: renaming it re-opens every condition and re-escalates all of them.';
COMMENT ON COLUMN operator_alarms.alarm_key IS
  'What within that alarm the row is about — a credential id for stale-sync. Opaque to everything but the alarm that minted it.';
COMMENT ON COLUMN operator_alarms.opened_at IS
  'When the condition was first observed. Written at the transition in and never moved by a re-statement, so it reads as how long this has been true.';
COMMENT ON COLUMN operator_alarms.last_fired_at IS
  'When this condition was last escalated. The re-notify window runs from here, not from opened_at, so a re-statement restarts it instead of firing on every probe thereafter.';
