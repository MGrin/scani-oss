# `mexc/`

MEXC spot accounts.

- **Upstream**: `https://api.mexc.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA256(queryString) → hex (Binance-style). Signature
  appended as `&signature=`. Header: `X-MEXC-APIKEY`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 10 req/s; namespace `mexc-private`.
- **Endpoints used**: `/api/v3/account`.
- **Notes**: extends `BaseHmacCexProvider`. `free + locked` per asset.
  Transactions stub.
