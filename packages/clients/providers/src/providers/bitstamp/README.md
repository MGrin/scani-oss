# `bitstamp/`

Bitstamp v2.

- **Upstream**: `https://www.bitstamp.net`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: long pre-sign string `BITSTAMP <key><method><host><path><qs><contentType><nonce><ts><version><body>`,
  HMAC-SHA256 → hex. Headers: `X-Auth: BITSTAMP <key>`, `X-Auth-Signature`,
  `X-Auth-Nonce` (UUID), `X-Auth-Timestamp` (ms), `X-Auth-Version: v2`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 5 req/s (8000/10min upstream); namespace `bitstamp-private`.
- **Endpoints used**:
  - POST `/api/v2/balance/` — current balances.
  - POST `/api/v2/user_transactions/` — unified ledger
    (`offset` + `limit` ≤ 1000, `sort=asc`); per-row shape varies by
    pair (`btc`, `usd`, `btc_usd`, `fee`, …) — see `pair-resolver.ts`.
    `type` enum: 0=deposit, 1=withdrawal, 2=market trade,
    14=sub-account transfer.
  - POST `/api/v2/crypto-transactions/` — explicit on-chain
    deposits/withdrawals; we walk it for `txid` enrichment of the
    user_transactions deposit/withdraw rows.
- **Notes**: extends `BaseHmacCexProvider`. Balance response is one big
  object with `{currency}_balance` keys; we extract via regex.
  user_transactions row shape is per-pair dynamic, so a sibling
  `pair-resolver.ts` walks numeric keys to detect the
  `<base>_<quote>` price field. No public sandbox — the live test
  block runs only when `SCANI_LIVE=1`.
