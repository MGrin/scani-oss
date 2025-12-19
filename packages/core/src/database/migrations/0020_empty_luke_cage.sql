ALTER TABLE "holdings" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_holdings_is_active" ON "holdings" USING btree ("is_active");