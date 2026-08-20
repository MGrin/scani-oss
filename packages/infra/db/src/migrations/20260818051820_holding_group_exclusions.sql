-- SC-386. The third state a group's membership needs: explicitly OUT.
--
-- mgrin chose the standing-rule semantic on 2026-08-18 — "adding an ACCOUNT to
-- a group means that account is in the group permanently, its holdings and
-- everything it receives later" — which is the model SC-385 measured and took
-- the other side of. Both pure options failed on something real. A snapshot
-- keeps his Airwallex USD out of Liquid until he re-adds it, forever, once per
-- real position. A standing rule with nothing to oppose it drags every airdrop
-- landing in those six wallets into the group: 16 tokens already would, scam
-- dust among them.
--
-- So membership resolves as
--
--     (holding_groups  UNION  inherited from account_groups)  MINUS  this table
--
-- and this table is the only way to say the third thing. It is a table rather
-- than an `is_excluded` boolean on `holding_groups` for three reasons, all of
-- which are about what the OTHER readers do:
--
--   1. A boolean redefines a table six queries already read as "in". Each would
--      need `AND NOT excluded` bolted on, and the one that got missed would
--      return a wrong number rather than an error. A separate table is additive:
--      `holding_groups` keeps meaning exactly what it means today and only the
--      one resolution point subtracts.
--   2. `holding_groups` is UNIQUE (holding_id, group_id), so a boolean makes
--      "explicitly in" and "explicitly out" the SAME ROW — the two assertions
--      cannot coexist, and re-adding a holding could not clear a veto without
--      first knowing one was there.
--   3. Lifecycle. A veto only means anything while the holding's account is in
--      the group; when the account leaves, or is added again, every veto for
--      that account must go. Against a table that is one DELETE. Against a
--      boolean it is a per-row choice between DELETE and UPDATE depending on
--      whether that row also carries an explicit membership.
--
-- Deliberately NO data migration. The 8 of 22 `account_groups` rows that this
-- ticket found stale are not repaired here and are not deleted: under the
-- standing rule they are true again. Each was written by "add this account to
-- this group", which is now precisely what the row asserts. What changes is
-- that it stops being a cache with no invalidation. The ticket's own query
-- reports 0 missing rows, so there is nothing to backfill either.
CREATE TABLE IF NOT EXISTS "holding_group_exclusions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "holding_id" uuid NOT NULL REFERENCES "holdings"("id") ON DELETE CASCADE,
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "holding_group_exclusions_holding_id_group_id_unique" UNIQUE ("holding_id", "group_id")
);

-- Read two ways and only two: "is this pair vetoed" when resolving a page of
-- holdings, and "drop every veto in this group" when an account joins or leaves
-- it. The unique constraint's index serves the first; this serves the second.
CREATE INDEX IF NOT EXISTS "idx_holding_group_exclusions_group_id"
  ON "holding_group_exclusions" ("group_id");
