ALTER TABLE holding_balance_observations
  ADD COLUMN previous_observed_at TIMESTAMPTZ,
  ADD COLUMN previous_balance TEXT;

UPDATE holding_balance_observations target
SET previous_observed_at = linked.previous_observed_at,
    previous_balance = linked.previous_balance
FROM (
  SELECT
    id,
    LAG(observed_at) OVER w AS previous_observed_at,
    LAG(balance) OVER w AS previous_balance
  FROM holding_balance_observations
  WINDOW w AS (PARTITION BY holding_id ORDER BY observed_at, id)
) AS linked
WHERE target.id = linked.id
  AND linked.previous_observed_at IS NOT NULL;

-- Kept correct by the database rather than by each writer. The repository's
-- append paths, the demo seeder, a repair script and every test fixture insert
-- observations, and a predecessor one of them forgot is a gap that silently
-- never reaches the queue. A row inserted into the past also changes the
-- predecessor of the row after it, which no single-row writer can see.
--
-- Relinks each touched holding from the earliest touched instant onwards. The
-- advisory lock serialises two transactions appending to the same holding, so
-- neither links to a predecessor the other is about to displace.
CREATE OR REPLACE FUNCTION relink_balance_observations(holding_ids uuid[], froms timestamptz[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('holding_balance_observations:' || h::text, 0))
  FROM (SELECT DISTINCT unnest(holding_ids) AS h ORDER BY 1) AS locks;

  WITH touched AS (
    SELECT unnest(holding_ids) AS holding_id, unnest(froms) AS from_at
  ),
  starts AS (
    SELECT touched.holding_id, min(touched.from_at) AS from_at
    FROM touched
    GROUP BY touched.holding_id
  ),
  bounds AS (
    SELECT
      starts.holding_id,
      starts.from_at,
      coalesce(
        (SELECT max(p.observed_at)
         FROM holding_balance_observations p
         WHERE p.holding_id = starts.holding_id AND p.observed_at < starts.from_at),
        starts.from_at
      ) AS window_from
    FROM starts
  ),
  linked AS (
    SELECT
      o.id,
      o.observed_at,
      bounds.from_at,
      LAG(o.observed_at) OVER w AS previous_observed_at,
      LAG(o.balance) OVER w AS previous_balance
    FROM bounds
    JOIN holding_balance_observations o
      ON o.holding_id = bounds.holding_id AND o.observed_at >= bounds.window_from
    WINDOW w AS (PARTITION BY o.holding_id ORDER BY o.observed_at, o.id)
  )
  UPDATE holding_balance_observations target
  SET previous_observed_at = linked.previous_observed_at,
      previous_balance = linked.previous_balance
  FROM linked
  WHERE target.id = linked.id
    AND linked.observed_at >= linked.from_at
    AND (target.previous_observed_at IS DISTINCT FROM linked.previous_observed_at
         OR target.previous_balance IS DISTINCT FROM linked.previous_balance);
END;
$$;

CREATE OR REPLACE FUNCTION relink_balance_observations_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM relink_balance_observations(
    (SELECT array_agg(holding_id) FROM inserted),
    (SELECT array_agg(observed_at) FROM inserted)
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION relink_balance_observations_after_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM relink_balance_observations(
    (SELECT array_agg(holding_id) FROM removed),
    (SELECT array_agg(observed_at) FROM removed)
  );
  RETURN NULL;
END;
$$;

-- Nothing moves an observation today; this keeps a future repair that does
-- from breaking the chain on both the holding it left and the one it joined.
--
-- Postgres refuses a column list beside transition tables, so this fires on
-- every UPDATE, including a gap review and the relink's own write. Only rows
-- whose holding, instant or balance changed are relinked; for everything else
-- it returns without writing, which is also what stops it re-firing itself.
CREATE OR REPLACE FUNCTION relink_balance_observations_after_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  moved_holdings uuid[];
  moved_froms timestamptz[];
BEGIN
  SELECT array_agg(moved.holding_id), array_agg(moved.observed_at)
  INTO moved_holdings, moved_froms
  FROM (
    SELECT removed.holding_id, removed.observed_at
    FROM removed
    JOIN inserted ON inserted.id = removed.id
    WHERE (removed.holding_id, removed.observed_at, removed.balance)
      IS DISTINCT FROM (inserted.holding_id, inserted.observed_at, inserted.balance)
    UNION ALL
    SELECT inserted.holding_id, inserted.observed_at
    FROM removed
    JOIN inserted ON inserted.id = removed.id
    WHERE (removed.holding_id, removed.observed_at, removed.balance)
      IS DISTINCT FROM (inserted.holding_id, inserted.observed_at, inserted.balance)
  ) AS moved;

  IF moved_holdings IS NOT NULL THEN
    PERFORM relink_balance_observations(moved_holdings, moved_froms);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER holding_balance_observations_relink_insert
AFTER INSERT ON holding_balance_observations
REFERENCING NEW TABLE AS inserted
FOR EACH STATEMENT EXECUTE FUNCTION relink_balance_observations_after_insert();

CREATE TRIGGER holding_balance_observations_relink_delete
AFTER DELETE ON holding_balance_observations
REFERENCING OLD TABLE AS removed
FOR EACH STATEMENT EXECUTE FUNCTION relink_balance_observations_after_delete();

CREATE TRIGGER holding_balance_observations_relink_update
AFTER UPDATE ON holding_balance_observations
REFERENCING OLD TABLE AS removed NEW TABLE AS inserted
FOR EACH STATEMENT EXECUTE FUNCTION relink_balance_observations_after_update();

ALTER TABLE holding_balance_observations
  ADD COLUMN balance_moved BOOLEAN GENERATED ALWAYS AS (
    previous_balance IS NOT NULL AND balance::numeric <> previous_balance::numeric
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_holding_obs_balance_moved
  ON holding_balance_observations (user_id)
  WHERE balance_moved;
