CREATE TABLE "holding_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"balance" text NOT NULL,
	"source" text NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "holding_history" ADD CONSTRAINT "holding_history_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_history" ADD CONSTRAINT "holding_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_history" ADD CONSTRAINT "holding_history_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_history" ADD CONSTRAINT "holding_history_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_holding_history_holding_timestamp" ON "holding_history" USING btree ("holding_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_history_user_timestamp" ON "holding_history" USING btree ("user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_holding_history_timestamp" ON "holding_history" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint

-- Create function to track holding changes
CREATE OR REPLACE FUNCTION track_holding_changes()
RETURNS TRIGGER AS $$
BEGIN
  -- On INSERT or when balance changes on UPDATE, record the new state
  -- Use numeric comparison for balance to avoid string comparison issues
  IF (TG_OP = 'INSERT') OR (TG_OP = 'UPDATE' AND OLD.balance::numeric != NEW.balance::numeric) THEN
    INSERT INTO holding_history (
      holding_id,
      user_id,
      account_id,
      token_id,
      balance,
      source,
      timestamp
    ) VALUES (
      NEW.id,
      NEW.user_id,
      NEW.account_id,
      NEW.token_id,
      NEW.balance,
      NEW.source,
      NEW.last_updated
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Create trigger to automatically track holding changes
CREATE TRIGGER holdings_history_trigger
  AFTER INSERT OR UPDATE ON holdings
  FOR EACH ROW
  EXECUTE FUNCTION track_holding_changes();