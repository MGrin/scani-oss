# `bitget/`

Bitget V2 spot accounts.

- **Upstream**: `https://api.bitget.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: Base64(HMAC-SHA256(`timestamp + method + requestPath + body`,
  apiSecret)). Headers: `ACCESS-KEY`, `ACCESS-SIGN`, `ACCESS-TIMESTAMP`,
  `ACCESS-PASSPHRASE`.
- **Env**: per-user `apiKey` + `apiSecret` + `passphrase`.
- **Rate limit**: 10 req/s; namespace `bitget-private`.
- **Endpoints used**: `/api/v2/spot/account/assets`.
- **Notes**: extends `BaseHmacCexProvider`. `available + frozen + locked`
  summed. Transactions stub today.
