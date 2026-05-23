# `kucoin/`

KuCoin API Key V2.

- **Upstream**: `https://api.kucoin.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth quirk**: passphrase is itself HMAC-SHA256-signed before being
  sent (V2 requirement, protects passphrase from header logs). Request
  signature: Base64(HMAC-SHA256(`timestamp + method + endpoint + body`,
  secret)). Headers: `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`,
  `KC-API-PASSPHRASE` (signed), `KC-API-KEY-VERSION: 2`.
- **Env**: per-user `apiKey` + `apiSecret` + `passphrase`.
- **Rate limit**: 10 req/s; namespace `kucoin-private`.
- **Endpoints used**: `/api/v1/accounts`.
- **Notes**: extends `BaseHmacCexProvider`. Sums across account types
  (main + trade + margin) per currency. Transactions stub.
