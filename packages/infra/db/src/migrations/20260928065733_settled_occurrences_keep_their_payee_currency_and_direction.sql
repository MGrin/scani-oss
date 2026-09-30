-- 20260928065733 — settled occurrences keep their payee currency and direction
--
-- An occurrence stores its amounts but not who it was paid to, in what
-- currency, or in which direction. Those were read off the bill, so editing a
-- bill's payee, currency or direction rewrote every payment already settled
-- under it: vendor history moved to the new payee and settled amounts were
-- relabelled in the new currency (SC-1401). mgrin chose, 2026-09-28, to keep
-- the bill editable and give settled history its own values.
--
-- Recorded by a trigger rather than by each writer, because an occurrence is
-- settled through at least four paths (settle, reconcile, extraction import,
-- pause-skip) and one of them is a bulk UPDATE. Returning to `scheduled` clears
-- them, so a reopened occurrence follows its bill again until it settles.
--
-- Additive only: three nullable columns, a function, a trigger, and a backfill
-- that fills rows it has not filled before, so it is safe to run twice.
-- Measured 2026-09-28 on production, read-only: 44 settled occurrences across
-- 23 bills, all one user's.

-- DEFERRABLE INITIALLY DEFERRED: a vendor that settled history names still
-- cannot be deleted, but the check runs at commit. Deleting a whole user
-- cascades to its vendors directly and to its occurrences two levels down
-- (users -> payments -> occurrences), so an immediate check (RESTRICT, or NO
-- ACTION) fired before the occurrences were gone and refused account deletion
-- whenever an edited bill kept history under its old payee. Measured.
ALTER TABLE payment_occurrences
  ADD COLUMN settled_vendor_id uuid
    REFERENCES vendors(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN settled_currency_token_id uuid
    REFERENCES tokens(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN settled_direction text;

CREATE OR REPLACE FUNCTION payment_occurrence_keep_settled_terms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'scheduled' THEN
    NEW.settled_vendor_id := NULL;
    NEW.settled_currency_token_id := NULL;
    NEW.settled_direction := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.status = 'scheduled' OR NEW.settled_vendor_id IS NULL THEN
    SELECT p.vendor_id, p.currency_token_id, p.direction
      INTO NEW.settled_vendor_id, NEW.settled_currency_token_id, NEW.settled_direction
      FROM payments p
      WHERE p.id = NEW.payment_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_occurrences_keep_settled_terms
BEFORE INSERT OR UPDATE OF status ON payment_occurrences
FOR EACH ROW EXECUTE FUNCTION payment_occurrence_keep_settled_terms();

UPDATE payment_occurrences o
SET settled_vendor_id = p.vendor_id,
    settled_currency_token_id = p.currency_token_id,
    settled_direction = p.direction
FROM payments p
WHERE p.id = o.payment_id
  AND o.status <> 'scheduled'
  AND o.settled_vendor_id IS NULL;
