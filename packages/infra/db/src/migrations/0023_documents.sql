CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  content_hash text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL,
  original_filename text NOT NULL,
  source_kind text NOT NULL,
  classification text,
  classification_confidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_user_content_hash_unique UNIQUE (user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents (user_id);

-- One row per invoice FOUND IN a document — a single PDF can hold
-- several. `vendor_id` is nullable and ON DELETE SET NULL: extraction
-- history must survive a vendor merge/delete even though the vendor
-- link is gone.
CREATE TABLE IF NOT EXISTS document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  vendor_name_raw text NOT NULL,
  vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL,
  invoice_number text,
  issue_date date,
  due_date date,
  total_amount text,
  currency_code text,
  line_items jsonb NOT NULL DEFAULT '[]',
  confidence text,
  prompt_version text,
  extractor_kind text,
  review_state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_extractions_document_ordinal_unique UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_document_extractions_document_id ON document_extractions (document_id);
CREATE INDEX IF NOT EXISTS idx_document_extractions_review_state ON document_extractions (review_state);

-- `payment_occurrences.matched_extraction_id` was added in 0022 without a
-- foreign key because document_extractions didn't exist yet. Backfill it
-- now that it does; ON DELETE SET NULL because losing the source
-- extraction shouldn't destroy a matched occurrence's own history.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard re-runs with
-- a catalog check instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payment_occurrences_matched_extraction_id_fkey'
  ) THEN
    ALTER TABLE payment_occurrences
      ADD CONSTRAINT payment_occurrences_matched_extraction_id_fkey
      FOREIGN KEY (matched_extraction_id) REFERENCES document_extractions(id) ON DELETE SET NULL;
  END IF;
END $$;
