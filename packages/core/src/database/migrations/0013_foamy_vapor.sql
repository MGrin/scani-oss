CREATE TABLE "user_integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"encrypted_credentials" jsonb NOT NULL,
	"credentials_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_integration_credentials_user_id_institution_id_unique" UNIQUE("user_id","institution_id")
);
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_address" text NOT NULL,
	"institution_ids" jsonb DEFAULT '[]' NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_wallets_user_id_wallet_address_unique" UNIQUE("user_id","wallet_address")
);
--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_credentials" ADD CONSTRAINT "user_integration_credentials_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_id" ON "user_integration_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_institution_id" ON "user_integration_credentials" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_integration_credentials_user_institution" ON "user_integration_credentials" USING btree ("user_id","institution_id");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_user_id" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_wallets_wallet_address" ON "user_wallets" USING btree ("wallet_address");