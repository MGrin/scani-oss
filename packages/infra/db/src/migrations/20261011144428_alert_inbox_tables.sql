-- 20261011144428 — alert inbox tables
-- SC-1727: a person's forwarding address for bank alert mail, who may write to
-- it, the mail that arrived, and the alert rows a complete feed window
-- replaced. Purely additive.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS alert_inboxes (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  last_received_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_inbox_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signing_domain TEXT,
  address TEXT,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_inbox_senders_one_kind CHECK ((signing_domain IS NULL) <> (address IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_inbox_senders_user_domain_uq
  ON alert_inbox_senders (user_id, signing_domain);
CREATE UNIQUE INDEX IF NOT EXISTS alert_inbox_senders_user_address_uq
  ON alert_inbox_senders (user_id, address);

CREATE TABLE IF NOT EXISTS alert_inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id_hash TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  signing_domain TEXT,
  from_domain TEXT,
  trust TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  raw_key TEXT,
  recorded JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_inbox_messages_user_message_uq
  ON alert_inbox_messages (user_id, message_id_hash);
CREATE INDEX IF NOT EXISTS idx_alert_inbox_messages_user_status
  ON alert_inbox_messages (user_id, status);

CREATE TABLE IF NOT EXISTS alert_inbox_retired_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holding_id UUID REFERENCES holdings(id) ON DELETE SET NULL,
  row JSONB NOT NULL,
  reason TEXT NOT NULL,
  retired_by_input_id UUID REFERENCES feed_inputs(id) ON DELETE SET NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_inbox_retired_rows_user
  ON alert_inbox_retired_rows (user_id);

CREATE TABLE IF NOT EXISTS alert_inbox_kept_statements (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_ref TEXT NOT NULL,
  kept_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, upload_ref)
);
