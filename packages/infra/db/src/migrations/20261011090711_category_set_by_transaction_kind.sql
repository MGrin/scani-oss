-- 20261011090711 — a category may be set from the transaction's type (SC-1720).
-- A fee, interest, dividend or reward with no payee text is categorized by its
-- kind. Precedence lives in the writers: person > import > rule = ai = kind.
-- NOT VALID then VALIDATE, as in 20261010112737.
SET LOCAL lock_timeout = '5s';

ALTER TABLE holding_transactions DROP CONSTRAINT holding_tx_category_set_by_check;

ALTER TABLE holding_transactions
  ADD CONSTRAINT holding_tx_category_set_by_check CHECK (
    category_set_by IN ('person', 'import', 'rule', 'ai', 'kind')
    AND category_id IS NOT NULL
    OR category_set_by = 'cleared' AND category_id IS NULL
    OR category_set_by IS NULL AND category_id IS NULL
  ) NOT VALID;

ALTER TABLE holding_transactions VALIDATE CONSTRAINT holding_tx_category_set_by_check;
