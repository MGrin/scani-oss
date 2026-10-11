-- 20261010112737 — a category may be set by a rule or by AI, and a person's
-- clear is remembered (SC-1695).
-- Precedence lives in the writers: person > import > rule = ai. 'cleared' is a
-- person's "none": it carries no category, and no automatic step or import
-- writes over it, so rejecting a guess sticks.
-- NOT VALID then VALIDATE, so the check is re-proved without holding the
-- table under its strongest lock for the scan.
SET LOCAL lock_timeout = '5s';

ALTER TABLE holding_transactions DROP CONSTRAINT holding_tx_category_set_by_check;

ALTER TABLE holding_transactions
  ADD CONSTRAINT holding_tx_category_set_by_check CHECK (
    category_set_by IN ('person', 'import', 'rule', 'ai')
    AND category_id IS NOT NULL
    OR category_set_by = 'cleared' AND category_id IS NULL
    OR category_set_by IS NULL AND category_id IS NULL
  ) NOT VALID;

ALTER TABLE holding_transactions VALIDATE CONSTRAINT holding_tx_category_set_by_check;

-- A row whose category is deleted was set by nobody any more; a row the
-- person cleared keeps saying so.
CREATE OR REPLACE FUNCTION holding_tx_category_set_by_follows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NULL AND NEW.category_set_by IS DISTINCT FROM 'cleared' THEN
    NEW.category_set_by := NULL;
  END IF;
  RETURN NEW;
END $$;
