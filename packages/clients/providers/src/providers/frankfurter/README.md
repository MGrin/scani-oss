# `frankfurter/`

Frankfurter forex rates (ECB-sourced).

- **Upstream**: `https://api.frankfurter.app`.
- **Capabilities**: `current-price`, `historical-price`.
- **Env**: none (free, no key required).
- **Rate limit**: namespace `frankfurter` (10 req/s default).
- **Notes**: fiat currency pairs only — daily rates published by the
  ECB. Best for EUR-quoted fiat conversions; falls back to CoinGecko
  for crypto-vs-fiat.
