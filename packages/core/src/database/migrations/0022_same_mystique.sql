CREATE TABLE "account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_account_id_group_id_unique" UNIQUE("account_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"display_order" real DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "holding_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holding_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_groups_holding_id_group_id_unique" UNIQUE("holding_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_groups" ADD CONSTRAINT "holding_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_groups_account_id" ON "account_groups" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_account_groups_group_id" ON "account_groups" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_groups_user_id" ON "groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_groups_display_order" ON "groups" USING btree ("user_id","display_order");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_holding_id" ON "holding_groups" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "idx_holding_groups_group_id" ON "holding_groups" USING btree ("group_id");