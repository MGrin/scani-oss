ALTER TABLE "accounts" DROP CONSTRAINT "accounts_institution_id_name_unique";--> statement-breakpoint
ALTER TABLE "holdings" DROP CONSTRAINT "holdings_account_id_token_id_unique";--> statement-breakpoint
ALTER TABLE "institutions" DROP CONSTRAINT "institutions_user_id_name_unique";--> statement-breakpoint
ALTER TABLE "institutions" DROP CONSTRAINT "institutions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_institution_id_name_unique" UNIQUE("user_id","institution_id","name");--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_user_id_account_id_token_id_unique" UNIQUE("user_id","account_id","token_id");--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_name_unique" UNIQUE("name");