CREATE INDEX "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_institution_id" ON "accounts" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_id" ON "holdings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_account_id" ON "holdings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_token_id" ON "holdings" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "idx_institutions_name" ON "institutions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_token_prices_lookup" ON "token_prices" USING btree ("token_id","base_token_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_token_prices_timestamp" ON "token_prices" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_tokens_symbol" ON "tokens" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "idx_transactions_user_id" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_holding_id" ON "transactions" USING btree ("holding_id");--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_symbol_type_id_unique" UNIQUE("symbol","type_id");