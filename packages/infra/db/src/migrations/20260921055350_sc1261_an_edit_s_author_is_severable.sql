
ALTER TABLE "token_price_edit_history" ALTER COLUMN "edited_by_user_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "token_price_edit_history"
  DROP CONSTRAINT IF EXISTS "token_price_edit_history_edited_by_user_id_users_id_fk";
--> statement-breakpoint

ALTER TABLE "token_price_edit_history"
  ADD CONSTRAINT "token_price_edit_history_edited_by_user_id_users_id_fk"
  FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;
