-- 20261010092944 — sc1689 api procedure minutes
--
-- WHICH PROCEDURES RAN IN THE MINUTE A MACHINE'S MEMORY SPIKED.
--
-- On SC-1671 an api machine reached 753 MB in the minute ending 00:45Z and
-- nothing retained said what ran then: the platform log buffer holds ~19
-- minutes, the api sends no traces, and `api_procedure_calls` (SC-742) keeps
-- one row per procedure with no history. Fly's Prometheus already keeps memory
-- per machine for ~11 days; this table is the other half of that join.
--
-- One row per (minute, machine, procedure), written by the api recorder's
-- existing buffered flush, so there is no write per request. Two flushes into
-- one minute add their calls and keep the greatest of each figure.
--
-- The shape is the privacy guarantee, as for SC-742: no column can hold a user
-- id, an IP, a payload or a request id. Rows older than 14 days are deleted on
-- the same flush, which outlasts Prometheus's retention.
CREATE TABLE api_procedure_minutes (
  minute              timestamptz NOT NULL,
  -- FLY_MACHINE_ID: the `instance` label on Fly's metrics.
  machine             text NOT NULL,
  procedure           text NOT NULL,
  calls               integer NOT NULL,
  max_duration_ms     integer NOT NULL,
  max_loop_blocked_ms integer NOT NULL,
  -- Resident memory of the whole process when the call finished.
  max_rss_mb          integer NOT NULL,
  -- Leading with `minute` serves both the attribution read and the prune.
  PRIMARY KEY (minute, machine, procedure)
);
