ALTER TABLE "tokens"
ADD COLUMN "provider_metadata" text DEFAULT '{}' NOT NULL;

COMMENT ON COLUMN tokens.provider_metadata IS 'JSON object containing provider-specific metadata like {"coingecko": {"id": "bitcoin"}, "finnhub": {"symbol": "BTC"}}';