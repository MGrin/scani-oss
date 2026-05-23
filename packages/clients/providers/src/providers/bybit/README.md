# `bybit/`

Bybit V5 unified-account balances + creds-validate.

- **Upstream**: `https://api.bybit.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA256 over `timestamp + apiKey + recvWindow + queryString`.
  Headers: `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-SIGN`,
  `X-BAPI-RECV-WINDOW`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 10 req/s; namespace `bybit-private`.
- **Endpoints used**: `/v5/account/wallet-balance?accountType=UNIFIED`.
- **Notes**: extends `BaseHmacCexProvider`. `walletBalance` is the
  spot+derivatives total in coin units (UTA mode).
  Transactions stub today.
