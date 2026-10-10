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
- **Endpoints used**: `/api/v1/accounts` (balances, credential check),
  `/api/v1/accounts/ledgers` (transactions), `/api/v1/deposits` and
  `/api/v1/withdrawals` (chain txids only).
- **Notes**: extends `BaseHmacCexProvider`. Sums across account types
  (main + trade + margin) per currency. Deposits and withdrawals are ledger
  rows: the ledger's `amount` is the balance change with any fee included,
  which `/api/v1/withdrawals` cannot give, because KuCoin takes a withdrawal
  fee from the amount or on top of it and the record does not say which.
  `/api/v1/hist-deposits` and `/api/v1/hist-withdrawals` are deprecated and
  hold only pre-2019-02-18 records; they are not read (SC-1575). A deposit or
  withdrawal ledger row carries its record's `walletTxId` (any `@suffix`
  stripped) as `raw_payload.hash`, joined one-to-one by currency, side,
  time within a minute, and amount with the fee inside or on top. Anything
  ambiguous gets no txid, and a failed record lookup keeps every ledger row
  (SC-1584).
