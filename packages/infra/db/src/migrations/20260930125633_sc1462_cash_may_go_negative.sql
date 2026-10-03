-- 20260930125633 — sc1462 cash may go negative
-- SC-1462. A broker cash balance can be negative (margin debt), and it
-- subtracts from net worth as the broker shows it (mgrin, 2026-09-30). The
-- CHECK cannot see the token type, so the rule moves to the writers: the
-- integration sync accepts a negative only for a fiat holding, and every
-- user-entered path still refuses one. No row is read or changed.
ALTER TABLE holdings DROP CONSTRAINT IF EXISTS holdings_balance_nonneg_chk;
