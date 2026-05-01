# `huobi/`

Huobi/HTX spot accounts.

- **Upstream**: `https://api.huobi.pro`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth quirk**: query-string HMAC. Build canonical
  `method\nhost\npath\nsorted-query`, HMAC-SHA256 → base64, append as
  `Signature=` along with `AccessKeyId`, `SignatureMethod`,
  `SignatureVersion=2`, `Timestamp` (ISO without ms).
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 10 req/s; namespace `huobi-private`.
- **Endpoints used**: `/v1/account/accounts`,
  `/v1/account/accounts/{id}/balance`, `/v1/order/matchresults`,
  `/v1/query/deposit-withdraw`.
- **Notes**: extends `BaseHmacCexProvider`. Resolves spot account id(s)
  first, then fetches per-account balances and sums across types.
  Transactions: discovers candidate `${base}${quote}` symbols from the
  cross-product of non-zero balance currencies × `[usdt, usdc, husd,
  btc, usd]` (capped at 30); paginates `matchresults` per symbol via
  `from-id`+`direct=next`; paginates `deposit-withdraw` per non-zero
  balance currency for `type=deposit` and `type=withdraw`.
  `/v1/account/history` is available as a future safety-net for
  transfers / lending interest that the two primary feeds miss.
