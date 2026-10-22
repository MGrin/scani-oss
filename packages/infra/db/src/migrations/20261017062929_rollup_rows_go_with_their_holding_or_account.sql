-- 20261017062929 — rollup rows go with their holding or account
--
-- Deleting a holding or an account left its `portfolio_value_daily` rows
-- behind (SC-1627). No total read them, because every summing reader joins
-- `holdings`, but nothing ever removed them either: measured on production
-- 2026-10-17, 48,616 holding-scope rows (11,144 non-zero) for deleted holdings
-- and 3,885 account-scope rows for a deleted account, the newest from 10-16.
--
-- Kept by the database rather than by each writer. Holdings are deleted from
-- `DeleteHoldingUseCase` and `TransferReviewService`, accounts from
-- `AccountService` and the budget-app import, and an account's holdings go by
-- `ON DELETE CASCADE`, which no application path sees. A row trigger fires on
-- the cascade too, and in the deleting transaction.
--
-- A `transit` row is keyed by the holding the money travels to, so it goes
-- with that holding. Institutions are never deleted, so they have none.
CREATE OR REPLACE FUNCTION portfolio_value_daily_follow_holding_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM portfolio_value_daily
  WHERE user_id = OLD.user_id
    AND scope_kind IN ('holding', 'transit')
    AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER holdings_delete_portfolio_value_daily
  AFTER DELETE ON holdings
  FOR EACH ROW EXECUTE FUNCTION portfolio_value_daily_follow_holding_delete();

CREATE OR REPLACE FUNCTION portfolio_value_daily_follow_account_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM portfolio_value_daily
  WHERE user_id = OLD.user_id
    AND scope_kind = 'account'
    AND scope_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER accounts_delete_portfolio_value_daily
  AFTER DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION portfolio_value_daily_follow_account_delete();

-- The rows already orphaned. Each reader that sums holding or transit rows
-- inner-joins `holdings`, and an account scope is resolved from `accounts`
-- before its rows are read, so no figure changes.
DELETE FROM portfolio_value_daily p
WHERE p.scope_kind IN ('holding', 'transit')
  AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.id = p.scope_id);

DELETE FROM portfolio_value_daily p
WHERE p.scope_kind = 'account'
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.scope_id);

-- And what a full rebuild now deletes on its own (SC-1627): rows in the user's
-- base currency dated before the day before their earliest ledger row or
-- reading. Each full rebuild used to start one day before the oldest stored
-- row, so none of these was ever rewritten. On production 2026-10-17: 13,102
-- rows across 6 users (2,295 user days), up to 478 days before the first
-- record. Every user row among them is 0, and every non-zero holding row is a
-- hidden, inactive or scam holding no total sums, so a chart loses only a run
-- of leading zeros and no figure changes.
DELETE FROM portfolio_value_daily p
USING users u,
  (
    SELECT user_id, min(day) AS first_day
    FROM (
      SELECT user_id, occurred_at::date AS day FROM holding_transactions
      UNION ALL
      SELECT user_id, observed_at::date FROM holding_balance_observations
    ) records
    GROUP BY user_id
  ) earliest
WHERE u.id = p.user_id
  AND earliest.user_id = p.user_id
  AND p.base_currency_id = u.base_currency_id
  AND p.snapshot_date < earliest.first_day - 1;
