-- holding_transactions.{price_native_token_id, counter_token_id,
-- counter_price_native_token_id, fee_token_id} all reference tokens.id
-- with ON DELETE NO ACTION (the schema 0000 default). NO ACTION is
-- effectively RESTRICT for the delete: any future token-merge / dedup
-- migration that drops a token row gets stuck behind these FKs, and
-- so does the `users.deleteAccount` flow if it ever has to remove a
-- referenced token along the way.
--
-- These columns are *informational* references — the holding's primary
-- `token_id` already has ON DELETE RESTRICT (load-bearing). When a
-- price-source token disappears, leaving the historical fee/counter
-- rows pointing at it adds nothing; nulling those references is the
-- right thing.
--
-- We drop and recreate each constraint so the new ON DELETE clause
-- takes effect; the column data is unchanged.
ALTER TABLE "holding_transactions"
  DROP CONSTRAINT IF EXISTS "holding_transactions_price_native_token_id_tokens_id_fk";
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_price_native_token_id_tokens_id_fk"
  FOREIGN KEY ("price_native_token_id") REFERENCES "public"."tokens"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "holding_transactions"
  DROP CONSTRAINT IF EXISTS "holding_transactions_counter_token_id_tokens_id_fk";
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_counter_token_id_tokens_id_fk"
  FOREIGN KEY ("counter_token_id") REFERENCES "public"."tokens"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "holding_transactions"
  DROP CONSTRAINT IF EXISTS "holding_transactions_counter_price_native_token_id_tokens_id_fk";
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_counter_price_native_token_id_tokens_id_fk"
  FOREIGN KEY ("counter_price_native_token_id") REFERENCES "public"."tokens"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "holding_transactions"
  DROP CONSTRAINT IF EXISTS "holding_transactions_fee_token_id_tokens_id_fk";
ALTER TABLE "holding_transactions"
  ADD CONSTRAINT "holding_transactions_fee_token_id_tokens_id_fk"
  FOREIGN KEY ("fee_token_id") REFERENCES "public"."tokens"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
