-- `documents` becomes the record of EVERY uploaded file, not just
-- invoices. `purpose` names the upload flow the file came from.
--
-- The DEFAULT is what backfills history: every row that exists today was
-- written by the invoice ingestion path, so 'invoice' classifies all of
-- them correctly and no UPDATE is needed.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'invoice';

-- The `(user_id, content_hash)` unique becomes PARTIAL.
--
-- For invoices it stays exactly as it was: the dedup that stops the same
-- PDF being re-read (and re-billed to AI spend) by the same user. Left
-- covering every purpose it would do two harmful things instead:
--   1. A user re-uploading the same CSV after a failed import would hit a
--      constraint violation on INSERT and take the retry down with it —
--      the one case that must always work.
--   2. An invoice and a screenshot that share bytes are unrelated events
--      and would collide.
-- Screenshots and imports reuse an existing row by lookup instead (see
-- `UploadedFileService`), which returns rather than raises.
--
-- No `purpose` CHECK, same reasoning as 0024's `payment_status`: the
-- vocabulary is enforced by zod at the tRPC edge and by the
-- `DocumentPurpose` union in the schema, and a CHECK here would need a
-- migration every time a new upload flow ships.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_content_hash_unique;

CREATE UNIQUE INDEX IF NOT EXISTS documents_user_content_hash_unique
  ON documents (user_id, content_hash)
  WHERE purpose = 'invoice';

-- Keyset pagination for `documents.list` — newest first, `id` breaking
-- ties so a cursor can neither skip nor repeat a row. One index per
-- shape because the unfiltered list can't use a leading `purpose`.
CREATE INDEX IF NOT EXISTS idx_documents_user_created_at
  ON documents (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_documents_user_purpose_created_at
  ON documents (user_id, purpose, created_at DESC, id DESC);

-- Fully covered by the two composites above as a prefix.
DROP INDEX IF EXISTS idx_documents_user_id;
