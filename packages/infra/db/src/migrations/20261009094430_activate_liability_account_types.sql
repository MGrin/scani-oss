-- 20261009094430 — activate liability account types
-- SC-1640. The four liability types were seeded inactive until the amount
-- owed could be entered as debt. It can now: manual entry and the edit sheet
-- take it positive and store it negative, and only fiat on a liability
-- account may sit below zero. The pickers offer them from here on.

SET LOCAL lock_timeout = '5s';

UPDATE account_types
SET is_active = true, updated_at = now()
WHERE code IN ('loan', 'mortgage', 'credit_card', 'other_liability')
  AND class = 'liability';
