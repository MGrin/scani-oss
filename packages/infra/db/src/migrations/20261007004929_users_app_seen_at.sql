-- 20261007004929 — users app seen at
-- SC-1602. When this user last had the app open and visible: stamped on open
-- and every 15 minutes while the tab is in front. The quarter-hour crypto
-- pricing run reads it to price only what someone is looking at. NULL means
-- never seen since this column existed.
ALTER TABLE users ADD COLUMN app_seen_at timestamptz;
