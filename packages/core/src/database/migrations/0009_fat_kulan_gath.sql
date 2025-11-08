CREATE INDEX "idx_accounts_user_institution" ON "accounts" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_account_token" ON "holdings" USING btree ("user_id","account_id","token_id");--> statement-breakpoint
CREATE INDEX "idx_holdings_user_token" ON "holdings" USING btree ("user_id","token_id");--> statement-breakpoint
CREATE INDEX "idx_tokens_type_id" ON "tokens" USING btree ("type_id");