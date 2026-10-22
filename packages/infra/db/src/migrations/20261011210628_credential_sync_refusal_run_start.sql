-- 20261011210628 — credential sync refusal run start (SC-1733)
--
-- When the current run of sync refusals of one kind began. A Fio 500 may be a
-- dead token or an outage, so the sync records it as a suspect and confirms it
-- only when a second suspect answer comes at least an hour after the first.
-- Null when the last sync succeeded.
ALTER TABLE user_integration_credentials
  ADD COLUMN IF NOT EXISTS sync_refusal_since TIMESTAMPTZ;
