-- 20261010152345 — user backups count the documents left out
--
-- SC-1662: a backup carries uploaded documents with their files, unless the
-- files together would take it past what a restore accepts. Then it is built
-- without them, and the Backup card says how many were left out.

ALTER TABLE user_backups ADD COLUMN files_left_out integer NOT NULL DEFAULT 0;
