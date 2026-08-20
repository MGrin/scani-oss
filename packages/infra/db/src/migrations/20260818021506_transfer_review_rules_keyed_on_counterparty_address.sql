-- SC-375. Standing sentences about a counterparty address, evaluated when the
-- review queue is read.
--
-- mgrin asked for "a rule about all the transfers to that address". SC-345
-- measured what such a rule would have been right about: authored from the
-- first row on an address and applied to every later one, it agrees with the
-- recorded answer on 111 of 116 rows at the level that moves money — and all
-- five disagreements assert `left_control` on money that had actually stayed.
-- The error only ever runs toward a gain nobody made.
--
-- So a rule in this table cannot make that error, because it cannot make that
-- claim. `verdict` has two values and neither is a `transfer_review`:
--
--   `not_a_disposal` — the row leaves the pending queue. Nothing is written to
--                      it, and an outflow with no review realizes nothing
--                      (`isConfirmedDisposal` is `left_control` alone), so
--                      this changes whether a question is asked and no number.
--   `ask_me`         — the row stays in the queue wearing the note, so the
--                      reader is asked the same question about an address they
--                      can now recognise. Nothing is written by the rule.
--
-- There is deliberately no `suggested_decision` column. SC-345 leaves it out of
-- the first slice, and nothing in this one could write it: a column no writer
-- fills is a column a later reader trusts.
--
-- That is what makes the evaluation safe to run unattended and retroactively
-- at the same time, and it is why undo needs no migration and no repair job:
-- setting `revoked_at` restores every row the rule was hiding, because the
-- rows were never modified.
--
-- `match_address` is stored lowercased and trimmed. It is compared by exact
-- full-string equality against the address the queue itself reads — the
***REMOVED***
***REMOVED***
--
-- The column is also a field an ATTACKER can write to: address poisoning
-- sprays zero-value transfers on real token contracts to plant a lookalike
-- address in a victim's history, which is what the 113 zero-quantity rows the
-- queue already excludes are. Containment is that nothing here can assert a
-- disposal, so the worst an adversary buys is a suppressed question — visible
-- in the hidden list and reversed by revoking one row.
--
-- The unique index is partial on `revoked_at IS NULL`: one active rule per
-- address per user, and revoking one leaves the address free to be ruled on
-- again without deleting what the old rule did.
CREATE TABLE IF NOT EXISTS "transfer_review_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "match_address" text NOT NULL,
  "verdict" text NOT NULL,
  "note" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "transfer_review_rules_active_address_uq"
  ON "transfer_review_rules" ("user_id", "match_address")
  WHERE "revoked_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_transfer_review_rules_user_active"
  ON "transfer_review_rules" ("user_id")
  WHERE "revoked_at" IS NULL;
