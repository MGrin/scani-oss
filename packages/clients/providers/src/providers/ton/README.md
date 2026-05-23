# `ton/`

TON balance + transactions via Toncenter API.

- **Upstream**: `https://toncenter.com/api/v2` (mainnet) or
  `https://testnet.toncenter.com/api/v2` (override via `TON_API_URL`).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: optional `X-API-Key` (`TON_API_KEY`). Without a key Toncenter
  caps anonymous traffic at ~1 req/s; with a key the free tier allows
  ~10 req/s.
- **Env**: `TON_API_URL` (optional override), `TON_API_KEY` (optional).
- **Rate limit**: namespace `ton` (1 req/s anonymous, 10 req/s keyed).
- **Endpoints used**: `/getAddressBalance`, `/getAddressInformation`,
  `/getTransactions`.
- **Notes**:
  - Address validator covers EQ/UQ (mainnet bounceable / non-bounceable),
    kQ/0Q (testnet equivalents), and raw `0:<hex>` form.
  - Transactions are native-only. Jettons are out of scope for this cut —
    they appear as 0-value `in_msg` / `out_msgs` plus a payload body and
    need Toncenter v3 to decode cleanly. Smart-contract calls
    (every-message-zero) are skipped.
  - Pagination cursor is `(lt, hash)` of the last row; the loop stops
    when a page returns fewer than `limit` rows.
