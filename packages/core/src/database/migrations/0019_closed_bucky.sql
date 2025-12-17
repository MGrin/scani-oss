CREATE TABLE "institution_plaid_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"plaid_institution_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "institution_plaid_mappings_institution_id_unique" UNIQUE("institution_id"),
	CONSTRAINT "institution_plaid_mappings_plaid_institution_id_unique" UNIQUE("plaid_institution_id")
);
--> statement-breakpoint
CREATE TABLE "plaid_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plaid_item_id" uuid NOT NULL,
	"scani_account_id" uuid NOT NULL,
	"plaid_account_id" text NOT NULL,
	"mask" text,
	"official_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plaid_account_mappings_scani_account_id_unique" UNIQUE("scani_account_id"),
	CONSTRAINT "plaid_account_mappings_plaid_account_id_unique" UNIQUE("plaid_account_id")
);
--> statement-breakpoint
CREATE TABLE "plaid_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"institution_id" uuid NOT NULL,
	"plaid_item_id" text NOT NULL,
	"plaid_access_token" text NOT NULL,
	"plaid_institution_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"consent_expiration_time" timestamp with time zone,
	"error" jsonb,
	"last_successful_sync" timestamp with time zone,
	"last_balance_sync" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plaid_items_plaid_item_id_unique" UNIQUE("plaid_item_id"),
	CONSTRAINT "plaid_items_user_id_institution_id_unique" UNIQUE("user_id","institution_id")
);
--> statement-breakpoint
ALTER TABLE "institution_plaid_mappings" ADD CONSTRAINT "institution_plaid_mappings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_account_mappings" ADD CONSTRAINT "plaid_account_mappings_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_account_mappings" ADD CONSTRAINT "plaid_account_mappings_scani_account_id_accounts_id_fk" FOREIGN KEY ("scani_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_institution_plaid_mappings_institution_id" ON "institution_plaid_mappings" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_institution_plaid_mappings_plaid_institution_id" ON "institution_plaid_mappings" USING btree ("plaid_institution_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_account_mappings_plaid_item_id" ON "plaid_account_mappings" USING btree ("plaid_item_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_account_mappings_scani_account_id" ON "plaid_account_mappings" USING btree ("scani_account_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_account_mappings_plaid_account_id" ON "plaid_account_mappings" USING btree ("plaid_account_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_items_user_id" ON "plaid_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_items_institution_id" ON "plaid_items" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_items_plaid_item_id" ON "plaid_items" USING btree ("plaid_item_id");