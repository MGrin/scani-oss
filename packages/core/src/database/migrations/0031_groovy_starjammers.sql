ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_type" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "linked_to_user_id" uuid;