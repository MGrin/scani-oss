-- 20261010143757 — feed input windows name their statement document
--
-- WHICH STORED FILE A STATEMENT WINDOW WAS READ FROM (SC-1656).
--
-- The statement vault lists an account's statements and the months they
-- cover. The window already holds the account (through its input) and the
-- period; this is the file. The link is the window's and not the document's:
-- a document is per user and content hash, so one file uploaded to two
-- accounts is one document and two windows (feeds, #24514). `upload_ref`
-- cannot stand in for it: it is the temp/ key, and retention rewrites the
-- document's r2_key.
--
-- NULL for every window written before this, and for windows that are not
-- statement uploads. Deleting the file keeps the window: the period was read.
ALTER TABLE feed_input_windows
  ADD COLUMN document_id uuid REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX idx_feed_input_windows_document_id
  ON feed_input_windows (document_id)
  WHERE document_id IS NOT NULL;
