-- 20261017072428 — delete the apy balance copies the engine excludes
--
-- SC-1634. Until APY stopped writing them, every payout also wrote the
-- holding's new balance as an observation: `sync-capture`, origin
-- `updateHoldingBalance`. The engine already ignores those copies (rule O3 in
-- `legacy-classification.ts`), but the gap queue, the rebuild ranges, the
-- lowest balance, a correction's date, the opening reconciler and earliest
-- evidence all still read every observation. Deleting the copies makes them
-- agree with the engine without a filter in each.
--
-- The predicate is the engine's, clause for clause: a balance copy with no
-- role; not an O2 file-import copy (the marker, or a statement write on the
-- same holding up to 120 s before it); and marked `apy-payout`, or written in
-- the same millisecond as an `apy-payout` ledger row on its holding. The
-- engine compares `Date`s, so both sides are truncated to milliseconds.
--
-- MEASURED read-only on production, 2026-10-17: 262 rows on 3 holdings of one
-- user, every one with a null role, and this predicate selects the same 262 as
-- the engine. Rehearsed on a branch of production with every reader captured
-- before and after: drift, PnL, returns, external flows, the reconciler and
-- earliest evidence moved nothing, and the gap queue stayed empty. What moves
-- is where a rebuild starts, one holding's lowest balance and where a future
-- correction is dated, which now come from the last real reading, as they
-- already do for every payout since the copies stopped.
--
-- ►► WHOSE ANSWERS THIS DROPS. 23 of the copies carry a person's gap answer
--    (22 `flow`, 1 `growth`). Answering wrote ledger rows, and those stay; the
--    interval each answer closed now runs to the next real reading and those
--    rows explain it, so no question comes back. The answers are archived
--    anyway: an answer someone gave is not discarded quietly.
--
-- ►► WHAT THE ARCHIVE IS FOR. `_sc1634_apy_balance_copies_20261017` keeps each
--    deleted row whole, as `to_jsonb`, so any one of them can be put back. It
--    goes with its holding and with its user.
CREATE TABLE IF NOT EXISTS "_sc1634_apy_balance_copies_20261017" (
  "id"          uuid PRIMARY KEY,
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "holding_id"  uuid NOT NULL REFERENCES "holdings"("id") ON DELETE CASCADE,
  "observation" jsonb NOT NULL,
  "archived_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TEMP TABLE "_sc1634_copies" ON COMMIT DROP AS
SELECT o."id"
  FROM "holding_balance_observations" o
 WHERE o."source" = 'sync-capture'
   AND o."source_metadata"->>'origin' = 'updateHoldingBalance'
   AND o."role" IS NULL
   AND coalesce(o."source_metadata"->>'legacyAnchor', '') <> 'file-import'
   AND NOT EXISTS (
     SELECT 1 FROM "holding_balance_observations" s
      WHERE s."holding_id" = o."holding_id"
        AND s."source" = 'statement-close'
        AND date_trunc('milliseconds', s."created_at")
            BETWEEN date_trunc('milliseconds', o."created_at") - interval '120 seconds'
                AND date_trunc('milliseconds', o."created_at"))
   AND NOT EXISTS (
     SELECT 1 FROM "holding_transactions" t
      WHERE t."holding_id" = o."holding_id"
        AND (t."source" = 'statement'
             OR starts_with(t."source", 'statement-')
             OR starts_with(t."source", 'budget-'))
        AND date_trunc('milliseconds', t."created_at")
            BETWEEN date_trunc('milliseconds', o."created_at") - interval '120 seconds'
                AND date_trunc('milliseconds', o."created_at"))
   AND (
     o."source_metadata"->>'legacyAnchor' = 'apy-payout'
     OR EXISTS (
       SELECT 1 FROM "holding_transactions" t
        WHERE t."holding_id" = o."holding_id"
          AND t."source" = 'apy-payout'
          AND date_trunc('milliseconds', t."created_at") = date_trunc('milliseconds', o."created_at")));

-- What the table held before, so each postcondition compares against a BEFORE
-- rather than against itself.
CREATE TEMP TABLE "_sc1634_before" ON COMMIT DROP AS
SELECT (SELECT count(*) FROM "holding_balance_observations") AS "observations",
       (SELECT count(*) FROM "_sc1634_copies") AS "copies",
       (SELECT count(*) FROM "holding_balance_observations" o
         WHERE o."gap_review" IS NOT NULL
           AND o."id" NOT IN (SELECT "id" FROM "_sc1634_copies")) AS "other_answers";

INSERT INTO "_sc1634_apy_balance_copies_20261017" ("id", "user_id", "holding_id", "observation")
SELECT o."id", o."user_id", o."holding_id", to_jsonb(o)
  FROM "holding_balance_observations" o
  JOIN "_sc1634_copies" c ON c."id" = o."id"
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "holding_balance_observations" o
 USING "_sc1634_copies" c
 WHERE o."id" = c."id";

DO $$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM "_sc1634_before";
  IF (SELECT count(*) FROM "holding_balance_observations") <> b."observations" - b."copies" THEN
    RAISE EXCEPTION 'SC-1634: the delete removed something other than the % copies', b."copies";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "_sc1634_copies" c
     WHERE NOT EXISTS (SELECT 1 FROM "_sc1634_apy_balance_copies_20261017" a WHERE a."id" = c."id")
  ) THEN
    RAISE EXCEPTION 'SC-1634: a deleted copy is missing from the archive';
  END IF;
  IF (SELECT count(*) FROM "holding_balance_observations" WHERE "gap_review" IS NOT NULL)
     <> b."other_answers" THEN
    RAISE EXCEPTION 'SC-1634: a gap answer on a row that is not a copy changed';
  END IF;
END $$;
