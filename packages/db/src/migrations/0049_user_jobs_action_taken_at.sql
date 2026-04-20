-- Track one-shot action consumption on jobs whose result requires a
-- follow-up user action (review + confirm extracted holdings from a
-- screenshot / PDF / CSV). Nullable: informative-only jobs (wallet
-- import, exchange import, price refresh, account deletion) never
-- populate it. Set on the first successful save and never cleared,
-- which lets the UI render subsequent visits as read-only so the same
-- extracted holdings can't be re-imported.

ALTER TABLE user_jobs
  ADD COLUMN action_taken_at timestamptz;
