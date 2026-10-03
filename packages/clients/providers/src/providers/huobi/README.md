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
  cross-product of non-zero balance currencies and every currency
  `deposit-withdraw` names × `[usdt, usdc, husd, btc, usd]` (capped at
  30; a truncated list retracts the complete-history claim); paginates
  `matchresults` per symbol in 48h windows back to its 120-day reach
  (the declared horizon), via `from-id`+`direct=next` within each; paginates
  `deposit-withdraw` across all currencies for `type=deposit` and
  `type=withdraw`. A non-`ok` page other than `base-symbol-error`
  retracts the complete-history claim.
  `/v1/account/history` is available as a future safety-net for
  transfers / lending interest that the two primary feeds miss.
