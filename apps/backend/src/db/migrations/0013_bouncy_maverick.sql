ALTER TABLE "transactions" DROP CONSTRAINT "transactions_price_token_id_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "holdings" ALTER COLUMN "balance" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "token_prices" ALTER COLUMN "price" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "amount" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "fee" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "fee" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "price";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "price_token_id";