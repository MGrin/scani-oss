CREATE TABLE "user_portfolio_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"event_type" text NOT NULL,
	"holding_id" uuid,
	"account_id" uuid NOT NULL,
	"institution_id" uuid,
	"token_id" uuid NOT NULL,
	"token_symbol" text NOT NULL,
	"token_name" text NOT NULL,
	"balance" text NOT NULL,
	"price" text NOT NULL,
	"value" text NOT NULL,
	"base_currency_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_portfolio_events" ADD CONSTRAINT "user_portfolio_events_base_currency_id_tokens_id_fk" FOREIGN KEY ("base_currency_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_user_timestamp" ON "user_portfolio_events" USING btree ("user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_holding" ON "user_portfolio_events" USING btree ("user_id","holding_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_account" ON "user_portfolio_events" USING btree ("user_id","account_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_institution" ON "user_portfolio_events" USING btree ("user_id","institution_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_type" ON "user_portfolio_events" USING btree ("user_id","event_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_portfolio_events_token" ON "user_portfolio_events" USING btree ("user_id","token_id","timestamp" DESC NULLS LAST);