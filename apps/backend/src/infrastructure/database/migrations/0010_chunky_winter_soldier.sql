ALTER TABLE "transaction_types" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "transaction_types" CASCADE;--> statement-breakpoint
DROP TABLE "transactions" CASCADE;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "is_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_holdings_is_hidden" ON "holdings" USING btree ("is_hidden");