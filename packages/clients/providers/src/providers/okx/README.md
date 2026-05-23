# `okx/`

OKX V5 unified balances + creds-validate.

- **Upstream**: `https://www.okx.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: Base64(HMAC-SHA256(`timestamp + method + requestPath + body`,
  apiSecret)). Headers: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`,
  `OK-ACCESS-TIMESTAMP` (ISO-8601), `OK-ACCESS-PASSPHRASE`.
- **Env**: per-user `apiKey` + `apiSecret` + `passphrase` (third
  credential set during OKX UI key creation).
- **Rate limit**: 10 req/s; namespace `okx-private`.
- **Endpoints used**: `/api/v5/account/balance`.
- **Notes**: extends `BaseHmacCexProvider`. Returns one snapshot in
  `data[0].details[]`. Transactions stub today.
