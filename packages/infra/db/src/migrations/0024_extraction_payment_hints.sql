-- Hints the invoice extractor reads off the document so an accepted
-- extraction can become a recurring payment without a second AI call.
-- Both are NULLABLE on purpose and carry no CHECK constraint: the model
-- must be free to say "I can't tell" (NULL) on an unreadable invoice
-- rather than guess, and a guessed 'paid' would silently mark a bill as
-- settled that never was.
ALTER TABLE document_extractions
  ADD COLUMN IF NOT EXISTS payment_status text;

ALTER TABLE document_extractions
  ADD COLUMN IF NOT EXISTS billing_period text;
