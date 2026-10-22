-- 20261013015243 — turn every alert inbox off
-- SC-1727 is removed. Its tables are dropped one deploy later, once no running
-- code names them. Until then the worker that is still serving polls the
-- mailbox while any inbox row exists, and with the flag gone it would drop
-- each forwarded mail as not allowed, which deletes it from the mailbox.
-- With no inbox row it reads nothing.

DELETE FROM alert_inboxes;
