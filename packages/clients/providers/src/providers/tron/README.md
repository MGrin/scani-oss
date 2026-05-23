# `tron/`

TRON balance + TRC-20 holdings + transactions via TronGrid.

- **Upstream**: `https://api.trongrid.io` (override via `TRON_API_URL`).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: optional `TRON-PRO-API-KEY` header (env `TRON_PRO_API_KEY`)
  for rate-limit relief.
- **Env**: none required.
- **Rate limit**: namespace `tron` (10 req/s; free tier is ~15).
- **Endpoints used**:
  - `/v1/accounts/{address}` (TRX balance + activity probe)
  - `/v1/accounts/{address}/tokens` (TRC-20 balances)
  - `/v1/accounts/{address}/transactions` (native TRX history; native
    `owner_address` / `to_address` are HEX, so the wallet is converted
    to its 21-byte hex form once for in/out comparison)
  - `/v1/accounts/{address}/transactions/trc20` (TRC-20 transfer
    history; `from` / `to` are base58, compared as-is)
- **Pagination**: both transaction endpoints use `meta.fingerprint`
  as the cursor; limit capped at 200.
- **Notes**: address-validator covers base58check (`T...`, 34 chars).
  `address.ts` ships a base58 decoder + `tronBase58ToHex` helper used
  internally — no external bs58 dependency.
