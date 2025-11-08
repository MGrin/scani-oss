CREATE TABLE "telegram_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" text NOT NULL,
	"telegram_username" text,
	"user_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_users_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_users" ADD CONSTRAINT "telegram_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_telegram_users_telegram_id" ON "telegram_users" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX "idx_telegram_users_user_id" ON "telegram_users" USING btree ("user_id");