ALTER TABLE "schedules" ALTER COLUMN "repetitive_cron_pattern" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "interval" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "interval_start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_executed" timestamp with time zone;