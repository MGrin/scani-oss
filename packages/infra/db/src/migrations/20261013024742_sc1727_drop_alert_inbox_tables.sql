-- 20261013024742 — drop the alert inbox tables
-- SC-1727 was removed one deploy earlier (#2428): no deployed code names these
-- tables any more, and that deploy emptied alert_inboxes.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS alert_inbox_kept_statements;
DROP TABLE IF EXISTS alert_inbox_retired_rows;
DROP TABLE IF EXISTS alert_inbox_messages;
DROP TABLE IF EXISTS alert_inbox_senders;
DROP TABLE IF EXISTS alert_inboxes;
