ALTER TABLE "institutions" DROP CONSTRAINT "institutions_name_unique";--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_website_unique" UNIQUE("website");