# `finnhub/`

Finnhub stock + forex pricing.

- **Upstream**: `https://finnhub.io/api/v1`.
- **Capabilities**: `current-price`, `historical-price`, `token-identity`.
- **Env**: `FINNHUB_API_KEY` (required).
- **Rate limit**: 60 req/min on free tier; namespace `finnhub`.
- **Notes**: equities only — `canPrice(token)` filters on token type
  before crossing the network. `symbol.ts` carries the
  exchange-suffix normalization (`AAPL` vs `AAPL.US`). Used by the
  Google Sheets pricing fallback for symbol → exchange/currency
  enrichment. Historical OHLC walks `/stock/candle` in 1-year windows
  (free-tier per-call cap), pulling daily closes; for single-point
  lookups we fetch a ±1 day window and pick the bar closest to `at`.
