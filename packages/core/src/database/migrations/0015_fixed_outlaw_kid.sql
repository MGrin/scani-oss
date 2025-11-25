ALTER TABLE "tokens" ADD COLUMN "is_scam_probability" real DEFAULT 0 NOT NULL;
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_is_scam_probability_check" CHECK (is_scam_probability >= 0 AND is_scam_probability <= 1);
