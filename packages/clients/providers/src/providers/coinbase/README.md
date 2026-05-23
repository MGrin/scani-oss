# `coinbase/`

Coinbase Retail API (v2).

- **Upstream**: `https://api.coinbase.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA256 over `timestamp + method + requestPath + body` →
  hex. Headers: `CB-ACCESS-KEY`, `CB-ACCESS-SIGN`, `CB-ACCESS-TIMESTAMP`,
  `CB-VERSION: 2024-01-01`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 5 req/s; namespace `coinbase-private`.
- **Endpoints used**: `/v2/accounts?limit=100` (paginated via
  `pagination.next_uri`).
- **Notes**: extends `BaseHmacCexProvider`. One account per currency in
  Coinbase's model; multiple wallets of the same currency are summed.
  Pagination capped at 50 pages. Transactions stub
  (`/v2/accounts/{id}/transactions` is the follow-up). OAuth-bearer
  variant is a follow-up too (today only API-key path supported).
