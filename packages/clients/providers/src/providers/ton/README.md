# `ton/`

TON balance + transactions via the Toncenter indexed API v3
(docs.ton.org/ecosystem/api/toncenter/v3/overview).

- **Upstream**: `https://toncenter.com/api/v3` (mainnet) or
  `https://testnet.toncenter.com/api/v3` (override via `TON_API_URL`, which
  must name a v3 base: a v2 URL answers 404 on every path used here).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: optional `X-API-Key` (`TON_API_KEY`). Without a key Toncenter
  caps anonymous traffic at ~1 req/s; with a key the free tier allows
  ~10 req/s.
- **Env**: `TON_API_URL` (optional override), `TON_API_KEY` (optional).
- **Rate limit**: namespace `ton` (1 req/s anonymous, 10 req/s keyed).
- **Endpoints used**: `/accountStates` (balance and activity),
  `/transactions`.
- **Notes**:
  - Address validator covers EQ/UQ (mainnet bounceable / non-bounceable),
    kQ/0Q (testnet equivalents), and raw `0:<hex>` form.
  - Transactions are native-only; jettons are out of scope. Smart-contract
    calls (every-message-zero) are skipped.
  - v3 names addresses in raw form (`0:<HEX>`), so the wallet is matched by
    account, never by string. `lt` and `hash` are the same values v2 gave,
    so externalIds (`<lt>-<hash>-<leg>`) did not change in the move.
  - Pages go newest first (`sort=desc`); the next page is `end_lt` = the
    last row's `lt` − 1. The loop stops when a page returns fewer than
    `limit` rows.
