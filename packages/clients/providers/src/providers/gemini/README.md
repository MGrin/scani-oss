# `gemini/`

Gemini exchange.

- **Upstream**: `https://api.gemini.com` (sandbox: `https://api.sandbox.gemini.com`).
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA384. Payload `{ ...params, request, nonce }` JSON →
  base64 → HMAC → hex. Headers: `X-GEMINI-APIKEY`, `X-GEMINI-PAYLOAD`,
  `X-GEMINI-SIGNATURE`. Per-endpoint params (e.g. `symbol`,
  `limit_trades`, `continuation_token`) ride in `payloadExtras` on the
  signed request and are merged into the JSON payload before base64.
- **Env**: per-user `apiKey` + `apiSecret`. Boot reads
  `SCANI_TESTNET_GEMINI_BASE_URL` for sandbox overrides.
- **Rate limit**: 5 req/s; namespace `gemini-private`.
- **Endpoints used**:
  - POST `/v1/balances` — current balances; also drives the trade-symbol
    discovery sweep (held assets × `usd`/`usdt`/`btc` quotes).
  - POST `/v1/mytrades` — past trades. Paginated by `timestamp` cursor
    (oldest row's `timestampms - 1`); `limit_trades` capped at 500.
  - POST `/v2/transfers` — multichain-aware deposits/withdrawals (the
    legacy `/v1/transfers` is being retired). Paginated via the
    `continuation_token` HTTP response header.
- **Notes**: extends `BaseHmacCexProvider`. Trade `type='Buy'` → `buy`,
  `'Sell'` → `sell`; transfer `type='Deposit'` → `deposit`,
  `'Withdrawal'` → `withdraw`. Counter-leg quantity inferred as
  `amount × price` and signed via `inferCounterSign`.
